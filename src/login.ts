import type { AuthInteraction, Credential, Models } from '@earendil-works/pi-ai'
import { randomUUID } from 'node:crypto'
import { PublicError, type LoginView } from './contract.ts'

export interface LoginRegistration {
  replace(providers: string[]): void
}

export interface LoginLogger {
  error(format: unknown, ...params: unknown[]): void
  info(format: unknown, ...params: unknown[]): void
}

export interface LoginStart {
  authorizationUrl: string
  completion: Promise<void>
  reused: boolean
}

export interface PendingLogin {
  authorizationUrl?: string
  site: string
}

interface ActiveLogin extends PendingLogin {
  loginId: string
  authorizationUrlPromise: Promise<string>
  completion: Promise<void>
  controller: AbortController
  rejectAuthorizationUrl(error: unknown): void
  resolveAuthorizationUrl(url: string): void
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new Error('CodeBuddy 登录已取消')
}

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal))

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export class CodeBuddyLoginManager {
  private active?: ActiveLogin
  private view: LoginView = { phase: 'idle' }
  private readonly logger: LoginLogger
  private readonly models: Pick<Models, 'getModels' | 'login' | 'refresh'>
  private readonly provider: string
  private readonly registration: LoginRegistration

  constructor(
    models: Pick<Models, 'getModels' | 'login' | 'refresh'>,
    registration: LoginRegistration,
    logger: LoginLogger,
    provider: string,
  ) {
    this.models = models
    this.registration = registration
    this.logger = logger
    this.provider = provider
  }

  pending(): PendingLogin | undefined {
    if (this.active === undefined) return undefined
    return {
      authorizationUrl: this.active.authorizationUrl,
      site: this.active.site,
    }
  }

  snapshot(id?: string): LoginView {
    if (id !== undefined && id !== this.view.loginId) throw new PublicError('not-found', '登录任务已失效。')
    return { ...this.view }
  }

  async start(site: string, signal: AbortSignal): Promise<LoginStart> {
    signal.throwIfAborted()
    if (this.active && this.active.site !== site) await this.cancel()
    const reused = this.active !== undefined
    const active = this.active ?? this.create(site)

    try {
      const authorizationUrl = active.authorizationUrl
        ?? await waitWithSignal(active.authorizationUrlPromise, signal)
      return { authorizationUrl, completion: active.completion, reused }
    } catch (error) {
      if (!reused && signal.aborted) await this.cancel()
      throw error
    }
  }

  async cancel(id?: string): Promise<void> {
    if (id !== undefined) this.snapshot(id)
    const active = this.active
    if (active === undefined) return
    active.controller.abort(new Error('CodeBuddy 登录已取消'))
    await active.completion
  }

  reset(): void { this.view = { phase: 'idle' } }

  private create(site: string): ActiveLogin {
    const controller = new AbortController()
    let resolveAuthorizationUrl!: (url: string) => void
    let rejectAuthorizationUrl!: (error: unknown) => void
    const authorizationUrlPromise = new Promise<string>((resolve, reject) => {
      resolveAuthorizationUrl = resolve
      rejectAuthorizationUrl = reject
    })
    // A cancelled command can stop awaiting the URL before the login task
    // rejects. Keep the deferred promise observed so that rejection is never
    // reported as an unhandled process error.
    void authorizationUrlPromise.catch(() => {})

    const active: ActiveLogin = {
      loginId: randomUUID(),
      authorizationUrlPromise,
      completion: Promise.resolve(),
      controller,
      rejectAuthorizationUrl,
      resolveAuthorizationUrl,
      site,
    }
    this.active = active
    this.view = { phase: 'starting', loginId: active.loginId, site, startedAt: Date.now() }

    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: async () => site,
      notify: (event) => {
        if (event.type !== 'auth_url' || active.authorizationUrl !== undefined) return
        const url = new URL(event.url)
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid authorization URL')
        active.authorizationUrl = event.url
        this.view = { ...this.view, phase: 'waiting_browser', authorizationUrl: event.url }
        active.resolveAuthorizationUrl(event.url)
        this.logger.info('CodeBuddy waiting for browser authorization')
      },
    }

    active.completion = this.complete(active, interaction)
    return active
  }

  private async complete(active: ActiveLogin, interaction: AuthInteraction): Promise<void> {
    try {
      const credential: Credential = await this.models.login(this.provider, 'oauth', interaction)
      active.controller.signal.throwIfAborted()
      if (active.authorizationUrl === undefined) {
        throw new Error('CodeBuddy 登录未返回授权 URL')
      }

      this.view = { ...this.view, phase: 'authenticated', authorizationUrl: undefined }
      try {
        const refresh = await this.models.refresh({ allowNetwork: true, force: true, signal: active.controller.signal })
        if (refresh.errors.has(this.provider)) this.view.warning = 'models-unavailable'
      } catch {
        this.view.warning = 'models-unavailable'
      }
      active.controller.signal.throwIfAborted()

      this.registration.replace([this.provider])
      const available = this.models.getModels(this.provider)
      const baseUrl = credential.type === 'oauth' ? credential.baseUrl ?? active.site : active.site
      this.logger.info(
        'CodeBuddy login succeeded (%s); loaded %d models',
        String(baseUrl),
        available.length,
      )
    } catch (error) {
      if (active.authorizationUrl === undefined) active.rejectAuthorizationUrl(new PublicError('login-failed', 'CodeBuddy 登录失败，请重试。'))
      if (active.controller.signal.aborted) {
        this.view = { ...this.view, phase: 'cancelled', authorizationUrl: undefined }
        this.logger.info('CodeBuddy login cancelled')
      } else {
        this.view = { ...this.view, phase: 'failed', authorizationUrl: undefined, error: 'login-failed' }
        this.logger.error('CodeBuddy login failed')
      }
    } finally {
      if (this.active === active) this.active = undefined
    }
  }
}

export function authorizationUrlText(url: string, reused: boolean): string {
  const heading = reused ? 'CodeBuddy 正在等待授权。' : '请点击下面的链接完成 CodeBuddy 授权：'
  return `${heading}\n${url}\n\n授权完成后会自动保存登录状态；可运行 /codebuddy-status 查看结果。`
}
