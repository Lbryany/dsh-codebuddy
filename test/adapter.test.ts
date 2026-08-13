import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type Models,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

import { CodeBuddyAdapter } from '../src/adapter.ts'

const model: Model<'openai-completions'> = {
  id: 'reasoner',
  name: 'Reasoner',
  api: 'openai-completions',
  provider: 'codebuddy',
  baseUrl: 'https://example.test/v2',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 123_000,
  maxTokens: 24_000,
}

function successfulMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    api: 'openai-completions',
    provider: 'codebuddy',
    model: model.id,
    usage: {
      input: 10,
      output: 2,
      cacheRead: 3,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
}

function fakeModels(): Models {
  return {
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getModels: () => [model],
    getModel: (_provider: string, id: string) => id === model.id ? model : undefined,
    streamSimple: (
      _model: Model<'openai-completions'>,
      _context: Context,
      options?: SimpleStreamOptions,
    ) => {
      assert.equal(options?.reasoning, 'medium')
      const stream = createAssistantMessageEventStream()
      const message = successfulMessage()
      queueMicrotask(() => {
        stream.push({ type: 'start', partial: message })
        stream.push({ type: 'text_start', contentIndex: 0, partial: message })
        stream.push({ type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message })
        stream.push({ type: 'text_end', contentIndex: 0, content: 'ok', partial: message })
        stream.push({ type: 'done', reason: 'stop', message })
        stream.end(message)
      })
      return stream
    },
  } as unknown as Models
}

test('adapter exposes CodeBuddy grouping, dynamic models, and reasoning levels', async () => {
  const adapter = new CodeBuddyAdapter(fakeModels())
  assert.deepEqual(adapter.providerInfo('codebuddy'), { id: 'codebuddy', name: 'CodeBuddy' })
  assert.deepEqual(await adapter.listModels('codebuddy'), [{
    provider: 'codebuddy', id: 'reasoner', name: 'Reasoner', inputModalities: ['text'],
  }])

  const resolved = await adapter.resolveModel('codebuddy', 'reasoner')
  assert.equal(resolved.context?.contextWindow, 123_000)
  assert.equal(resolved.defaultMaxTokens, 24_000)
  assert.deepEqual(resolved.reasoning?.efforts.map(({ id }) => id),
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(resolved.reasoning?.defaultEffort, 'high')
})

test('adapter translates pi streaming events and emits usage before finish', async () => {
  const adapter = new CodeBuddyAdapter(fakeModels())
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'codebuddy',
    model: 'reasoner',
    reasoningEffort: ReasoningEffortId('medium'),
    messages: [],
  })) chunks.push(chunk)

  assert.deepEqual(chunks.map(({ type }) => type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.deepEqual(chunks.at(-2), {
    type: 'usage',
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 1 },
  })
  assert.deepEqual(chunks.at(-1), { type: 'finish', reason: { kind: 'stop' } })
})
