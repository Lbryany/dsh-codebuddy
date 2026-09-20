import {
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  ToolCallId,
  attributionHeaders,
  type ContentBlock,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type {
  AssistantMessage,
  Api,
  Context as PiContext,
  Credential,
  Model,
  Models,
  ThinkingLevel,
  Tool,
} from '@earendil-works/pi-ai'

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
type Level = (typeof LEVELS)[number]

const EFFORTS = LEVELS.map(level => ({
  id: ReasoningEffortId(level),
  name: level === 'off' ? 'Off' : level[0]!.toUpperCase() + level.slice(1),
}))

function modelInfo(provider: string, model: Model<Api>): LlmModelInfo {
  return {
    provider,
    id: model.id,
    name: model.name,
    // dsh image blocks are durable attachment references. Until this adapter
    // resolves them through ctx.attachment, advertise the capability it can
    // faithfully serialize instead of silently dropping images.
    inputModalities: ['text'],
  }
}

function textFrom(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => {
    if (block.type === 'text' || block.type === 'reasoning') return [block.text]
    if (block.type === 'tool-result') return [textFrom(block.content)]
    return []
  }).join('\n')
}

function toPiContext(options: GenerateOptions): PiContext {
  const messages: PiContext['messages'] = []
  const toolNames = new Map<string, string>()
  for (const message of options.messages) {
    if (message.role === 'user') {
      for (const block of message.content) {
        if (block.type === 'tool-result') {
          messages.push({
            role: 'toolResult',
            toolCallId: String(block.toolCallId),
            toolName: toolNames.get(String(block.toolCallId)) ?? '',
            content: [{ type: 'text', text: textFrom(block.content) }],
            isError: block.isError ?? false,
            timestamp: Date.now(),
          })
        }
      }
      const text = message.content
        .filter(block => block.type !== 'tool-result')
        .flatMap(block => block.type === 'text' || block.type === 'reasoning' ? [block.text] : [])
        .join('\n')
      if (text.length > 0) messages.push({ role: 'user', content: text, timestamp: Date.now() })
      continue
    }
    if (message.role === 'assistant') {
      const content: AssistantMessage['content'] = []
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text })
        if (block.type === 'reasoning') content.push({ type: 'thinking', thinking: block.text })
        if (block.type === 'tool-call') {
          let args: Record<string, unknown> = {}
          try { args = JSON.parse(block.arguments) as Record<string, unknown> } catch {}
          content.push({ type: 'toolCall', id: String(block.id), name: block.name, arguments: args })
          toolNames.set(String(block.id), block.name)
        }
      }
      messages.push({
        role: 'assistant', content, api: 'openai-completions', provider: 'codebuddy',
        model: options.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: Date.now(),
      })
    }
  }
  const tools = options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  })) as Tool[] | undefined
  return { systemPrompt: options.system, messages, tools }
}

function finishReason(reason: 'stop' | 'length' | 'toolUse'): StreamChunk & { type: 'finish' } {
  if (reason === 'length') return { type: 'finish', reason: { kind: 'max-tokens' } }
  if (reason === 'toolUse') return { type: 'finish', reason: { kind: 'tool-calls' } }
  return { type: 'finish', reason: { kind: 'stop' } }
}

export class CodeBuddyAdapter extends LlmAdapter {
  private readonly models: Models

  constructor(models: Models) {
    super()
    this.models = models
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'CodeBuddy' }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    await this.models.refresh({ allowNetwork: true })
    return this.models.getModels('codebuddy').map(model => modelInfo(provider, model))
  }

  override async resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.models.refresh({ allowNetwork: true, signal })
    const model = this.models.getModel('codebuddy', id)
    if (model === undefined) return { provider, id, name: id, inputModalities: ['text'] }
    return {
      ...modelInfo(provider, model),
      context: { contextWindow: model.contextWindow },
      defaultMaxTokens: model.maxTokens,
      ...(model.reasoning ? { reasoning: { efforts: EFFORTS, defaultEffort: ReasoningEffortId('high') } } : {}),
    }
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop?.length) throw new LlmError('CodeBuddy adapter does not support stop sequences', 'UNSUPPORTED')
    await this.models.refresh({ allowNetwork: true, signal: options.signal })
    const model = this.models.getModel('codebuddy', options.model)
    if (model === undefined) throw new LlmError(`CodeBuddy model "${options.model}" is not available`, 'MODEL_NOT_FOUND')

    const open = new Map<number, { kind: 'text' | 'reasoning' | 'tool-call'; text: string; id?: string; name?: string }>()
    const stream = this.models.streamSimple(model, toPiContext(options), {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      reasoning: options.reasoningEffort as ThinkingLevel | undefined,
      signal: options.signal,
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      headers: {
        // Preserve CodeBuddy's required CLI identity while satisfying dsh's
        // mandatory public product attribution on the same wire request.
        'User-Agent': `CLI/2.125.0 CodeBuddy/2.125.0 ${attributionHeaders()['user-agent']}`,
      },
    })
    for await (const event of stream) {
      if (event.type === 'text_start') {
        open.set(event.contentIndex, { kind: 'text', text: '' })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'text' }
      } else if (event.type === 'text_delta') {
        const state = open.get(event.contentIndex); if (state) state.text += event.delta
        yield { type: 'text-delta', index: event.contentIndex, text: event.delta }
      } else if (event.type === 'thinking_start') {
        open.set(event.contentIndex, { kind: 'reasoning', text: '' })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }
      } else if (event.type === 'thinking_delta') {
        const state = open.get(event.contentIndex); if (state) state.text += event.delta
        yield { type: 'reasoning-delta', index: event.contentIndex, text: event.delta }
      } else if (event.type === 'toolcall_start') {
        open.set(event.contentIndex, { kind: 'tool-call', text: '' })
        yield { type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }
      } else if (event.type === 'toolcall_delta') {
        const state = open.get(event.contentIndex); if (state) state.text += event.delta
        const partial = event.partial.content[event.contentIndex]
        const id = partial?.type === 'toolCall' ? partial.id : ''
        const name = partial?.type === 'toolCall' ? partial.name : undefined
        yield { type: 'tool-call-delta', index: event.contentIndex, id: ToolCallId(id), name, argumentsDelta: event.delta }
      } else if (event.type === 'text_end') {
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'text', text: event.content } }
      } else if (event.type === 'thinking_end') {
        yield { type: 'block-end', index: event.contentIndex, block: { type: 'reasoning', text: event.content } }
      } else if (event.type === 'toolcall_end') {
        yield { type: 'block-end', index: event.contentIndex, block: {
          type: 'tool-call', id: ToolCallId(event.toolCall.id), name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        } }
      } else if (event.type === 'done') {
        if (event.reason === 'deferred') {
          throw new LlmError('CodeBuddy returned a deferred tool response, which DSH cannot consume', 'UNSUPPORTED')
        }
        yield { type: 'usage', usage: {
          inputTokens: event.message.usage.input,
          outputTokens: event.message.usage.output,
          cacheReadTokens: event.message.usage.cacheRead,
          cacheWriteTokens: event.message.usage.cacheWrite,
          ...(event.message.usage.reasoning === undefined ? {} : { reasoningTokens: event.message.usage.reasoning }),
        } }
        yield finishReason(event.reason)
      } else if (event.type === 'error') {
        throw new LlmError(event.error.errorMessage ?? 'CodeBuddy request failed', event.reason === 'aborted' ? 'ABORTED' : 'PROVIDER_ERROR')
      }
    }
  }
}
