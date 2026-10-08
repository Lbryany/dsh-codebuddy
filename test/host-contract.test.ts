import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createAssistantMessageEventStream, type Context as PiContext, type Models } from '@earendil-works/pi-ai'
import { CodeBuddyAdapter } from '../src/adapter.ts'

test('DSH 0.2 adapter registration supports route replacement and disposal', async () => {
  const ctx = new Context()
  const llm = new LlmRuntime(ctx)
  const models = {
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getModels: () => [],
  } as unknown as Models
  const handle = llm.registerAdapter(['codebuddy'], new CodeBuddyAdapter(models))
  handle.replace(['codebuddy'])
  handle.replace([])
  handle.replace(['codebuddy'])
  handle()
  await ctx.fiber.dispose()
})

test('prepared requests cannot use a different account after model resolution', async () => {
  let account = new AbortController()
  let requests = 0
  const models = {
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getModel: () => undefined,
    streamSimple: () => { requests += 1; throw Error('must not dispatch') },
  } as unknown as Models
  const adapter = new CodeBuddyAdapter(models, () => account.signal)
  const prepared = await adapter.prepareCall('codebuddy', 'example')
  account.abort(new Error('Account changed'))
  account = new AbortController()
  await assert.rejects(async () => {
    for await (const _ of prepared.stream({ provider: 'codebuddy', model: 'example', messages: [] })) {}
  }, /Account changed/)
  assert.equal(requests, 0)
})

test('DSH 0.2 tool-role results retain call identity and failure state on the wire', async () => {
  let sent: PiContext | undefined
  const models = {
    refresh: async () => ({ aborted: false, errors: new Map() }),
    getModel: () => ({ id: 'example' }),
    streamSimple: (_model: unknown, context: PiContext) => {
      sent = context
      const stream = createAssistantMessageEventStream()
      stream.end()
      return stream
    },
  } as unknown as Models
  const adapter = new CodeBuddyAdapter(models)
  const callId = ToolCallId('call-1')
  for await (const _ of adapter.stream({ provider: 'codebuddy', model: 'example', messages: [
    createMessage({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'Preserve the session instructions' }] }),
    createMessage({ role: 'assistant', source: { kind: 'model', provider: 'codebuddy', model: 'example' },
      content: [{ type: 'tool-call', id: callId, name: 'read_file', arguments: '{"path":"a.txt"}' }] }),
    createMessage({ role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: true,
      content: [{ type: 'text', text: 'Not found' }] }),
  ] })) {}
  const result = sent?.messages[1]
  assert.equal(sent?.systemPrompt, 'Preserve the session instructions')
  assert.equal(result?.role, 'toolResult')
  if (result?.role !== 'toolResult') throw Error('Missing tool result')
  assert.equal(result.toolCallId, 'call-1')
  assert.equal(result.toolName, 'read_file')
  assert.equal(result.isError, true)
  assert.deepEqual(result.content, [{ type: 'text', text: 'Not found' }])
})
