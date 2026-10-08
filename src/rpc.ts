import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { CodeBuddyService } from './service.ts'
import type { Preferences } from './settings.ts'
import { PublicError, type DefaultModelView } from './contract.ts'

export const ENDPOINTS = ['status', 'login/start', 'login/status', 'login/cancel', 'logout', 'models/refresh',
  'preferences/status', 'preferences/update', 'default-model/status', 'default-model/select'] as const
export type Endpoint = typeof ENDPOINTS[number]
export type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: { issues: [] } } }
interface RpcDependencies {
  service: CodeBuddyService
  preferences: Preferences
  defaultModel?: { status(): DefaultModelView; select(input: { model: string; reasoningEffort?: string }): Promise<DefaultModelView> }
}

function fields(payload: unknown, required: string[] = [], optional: string[] = []): Record<string, string> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new PublicError('bad-request', '无效的管理请求。')
  const record = payload as Record<string, unknown>
  for (const [key, value] of Object.entries(record)) {
    if (![...required, ...optional].includes(key) || typeof value !== 'string' || value.length > 2048) {
      throw new PublicError('bad-request', '无效的管理请求字段。')
    }
  }
  for (const key of required) if (typeof record[key] !== 'string' || !record[key]) throw new PublicError('bad-request', '管理请求缺少必要字段。')
  return record as Record<string, string>
}

export function createRpcHandler({ service, preferences, defaultModel }: RpcDependencies) {
  return async (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult> => {
    try {
      signal.throwIfAborted()
      let value: unknown
      switch (endpoint) {
        case 'status': fields(payload); value = await service.status(); break
        case 'login/start': {
          const input = fields(payload, [], ['site'])
          await service.start(input.site || preferences.status().defaultSite, signal)
          value = service.login.snapshot()
          break
        }
        case 'login/status': value = service.login.snapshot(fields(payload, ['loginId']).loginId); break
        case 'login/cancel': await service.cancel(fields(payload, ['loginId']).loginId); value = await service.status(); break
        case 'logout': fields(payload); await service.logout(); value = await service.status(); break
        case 'models/refresh': fields(payload); value = await service.refresh(signal); break
        case 'preferences/status': fields(payload); value = preferences.status(); break
        case 'preferences/update': value = await preferences.update({ defaultSite: fields(payload, ['defaultSite']).defaultSite! }); break
        case 'default-model/status': fields(payload); value = defaultModel?.status() ?? { available: false }; break
        case 'default-model/select': {
          const input = fields(payload, ['model'], ['reasoningEffort'])
          if (!defaultModel) throw new PublicError('unavailable', 'DSH 默认模型服务不可用。')
          value = await defaultModel.select({ model: input.model!, reasoningEffort: input.reasoningEffort })
          break
        }
        default: throw new PublicError('not-found', '未知的 CodeBuddy 管理操作。')
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: {
        code: error instanceof PublicError ? error.code : signal.aborted ? 'aborted' : 'internal',
        message: error instanceof PublicError ? error.message : signal.aborted ? '操作已取消。' : 'CodeBuddy 操作失败，请重试。',
        details: { issues: [] },
      } }
    }
  }
}

export async function registerManagement(connection: HostConnectionHandle, handler: ReturnType<typeof createRpcHandler>) {
  const { clientRequestSchema } = await import('@deepseek-ai/dsh-client-connection')
  const disposers: Array<() => Promise<void>> = []
  try {
    for (const endpoint of ENDPOINTS) {
      const method = `codebuddy/${endpoint}`
      disposers.push(connection.fetch.register({ path: `/api/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return new Response('Expected JSON', { status: 415 })
          let body: unknown
          try { body = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
          const parsed = clientRequestSchema.safeParse(body)
          if (!parsed.success || parsed.data.method !== method) return new Response('Invalid RPC envelope', { status: 400 })
          return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId,
            result: await handler(endpoint, parsed.data.payload, request.signal) })
        },
      }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) await dispose()
    throw error
  }
  return async () => { for (const dispose of disposers.reverse()) await dispose() }
}
