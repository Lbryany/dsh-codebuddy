export const PROVIDER = 'codebuddy'
export const DEFAULT_SITE = 'https://www.codebuddy.ai'
export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningLevel = typeof REASONING_LEVELS[number]

export interface LoginView {
  phase: 'idle' | 'starting' | 'waiting_browser' | 'authenticated' | 'failed' | 'cancelled'
  loginId?: string
  site?: string
  startedAt?: number
  authorizationUrl?: string
  error?: 'login-failed'
  warning?: 'models-unavailable'
}

export interface CatalogModel {
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
}

export interface CatalogView {
  status: 'idle' | 'refreshing' | 'ready' | 'error'
  models: CatalogModel[]
  source?: string
  updatedAt?: number
  cached: boolean
  error?: string
}

export interface AccountView {
  hasCredential: boolean
  site?: string
  expiresAt?: number
}

export interface StatusView {
  account: AccountView
  login: LoginView
  catalog: CatalogView
}

export interface PreferencesView { defaultSite: string; writable: boolean }
export interface DefaultModelView {
  available: boolean
  provider?: string
  model?: string
  reasoningEffort?: string
}

export class PublicError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

export function normalizeSite(raw: string): string {
  const input = raw.trim()
  if (!input || ['global', 'intl'].includes(input.toLowerCase())) return DEFAULT_SITE
  if (['cn', 'china'].includes(input.toLowerCase())) return 'https://copilot.tencent.com'
  let url: URL
  try { url = new URL(input) } catch { throw new PublicError('bad-request', '请输入 cn、global 或完整站点 URL。') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new PublicError('bad-request', '站点必须是无凭据、查询参数和片段的 HTTP(S) URL。')
  }
  return url.origin
}
