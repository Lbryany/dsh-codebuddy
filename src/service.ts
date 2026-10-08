import type { CredentialStore, Models, ModelsRefreshOptions, ModelsRefreshResult } from '@earendil-works/pi-ai'
import { CodeBuddyLoginManager, type LoginLogger, type LoginRegistration } from './login.ts'
import { normalizeSite, PROVIDER, PublicError, type CatalogView, type StatusView } from './contract.ts'

interface ServiceOptions {
  models: Models
  store: CredentialStore & { invalidate?(): void }
  registration: LoginRegistration
  logger: LoginLogger
  resetProvider?(): void
}

export class CodeBuddyService {
  readonly login: CodeBuddyLoginManager
  readonly models: Models
  private readonly options: ServiceOptions
  private account = new AbortController()
  private epoch = 0
  private disposed = false
  private operations: Promise<unknown> = Promise.resolve()
  private catalog: CatalogView = { status: 'idle', models: [], cached: false }
  private source?: string
  private refreshTask?: { epoch: number; promise: Promise<ModelsRefreshResult> }

  constructor(options: ServiceOptions) {
    this.options = options
    this.models = options.models
    this.login = new CodeBuddyLoginManager({
      login: (...args) => this.models.login(...args),
      getModels: (...args) => this.models.getModels(...args),
      refresh: input => this.refreshModels(input),
    }, options.registration, options.logger, PROVIDER)
  }

  get revision(): number { return this.epoch }
  accountSignal = (): AbortSignal => this.account.signal

  withAccount<T>(action: () => Promise<T>): Promise<T> {
    const epoch = this.epoch
    return this.serialize(async () => {
      this.assertActive()
      if (epoch !== this.epoch) throw new PublicError('account-changed', 'CodeBuddy 账号状态已变化，请重试。')
      this.account.signal.throwIfAborted()
      return action()
    })
  }

  observeCatalogSource(source: string, epoch: number): void {
    if (epoch !== this.epoch || this.disposed) return
    this.source = source
  }

  async status(): Promise<StatusView> {
    const epoch = this.epoch
    const credential = await this.options.store.read(PROVIDER)
    if (epoch !== this.epoch) return this.status()
    return {
      account: credential?.type === 'oauth' ? {
        hasCredential: true,
        site: typeof credential.baseUrl === 'string' ? normalizeSite(credential.baseUrl) : undefined,
        expiresAt: typeof credential.expires === 'number' ? credential.expires : undefined,
      } : { hasCredential: false },
      login: this.login.snapshot(), catalog: structuredClone(this.catalog),
    }
  }

  async start(site: string, signal: AbortSignal) {
    const { pending, epoch } = await this.serialize(async () => {
      this.assertActive()
      const normalized = normalizeSite(site)
      if (this.login.pending()?.site !== normalized) {
        await this.login.cancel()
        this.assertActive()
        signal.throwIfAborted()
        this.invalidate()
      }
      const pending = this.login.start(normalized, signal)
      void pending.catch(() => {})
      return { pending, epoch: this.epoch }
    })
    try {
      const started = await pending
      void started.completion.then(() => {
        if (!this.disposed && this.epoch === epoch) {
          this.account = new AbortController()
          this.options.registration.replace([PROVIDER])
        }
      })
      return started
    } catch (error) {
      if (!this.disposed && this.epoch === epoch && !this.login.pending()) this.account = new AbortController()
      throw error
    }
  }

  cancel(id?: string): Promise<void> {
    return this.serialize(async () => { this.assertActive(); await this.login.cancel(id) })
  }

  logout(): Promise<void> {
    return this.serialize(async () => {
      this.assertActive()
      this.invalidate()
      await this.login.cancel()
      await this.models.logout(PROVIDER)
      this.login.reset()
      this.account = new AbortController()
      this.options.registration.replace([PROVIDER])
    })
  }

  async refresh(signal?: AbortSignal): Promise<CatalogView> {
    this.assertActive()
    if (!(await this.options.store.read(PROVIDER))) {
      this.catalog = { status: 'idle', models: [], cached: false }
      return structuredClone(this.catalog)
    }
    const combined = signal ? AbortSignal.any([signal, this.account.signal]) : this.account.signal
    combined.throwIfAborted()
    await this.refreshModels({ allowNetwork: true, force: true, signal: combined })
    return structuredClone(this.catalog)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.invalidate()
    await this.login.cancel()
    await this.operations.catch(() => {})
  }

  private invalidate(): void {
    this.epoch++
    this.account.abort(new PublicError('account-changed', 'CodeBuddy 账号状态已变化，请重试。'))
    this.options.store.invalidate?.()
    this.catalog = { status: 'idle', models: [], cached: false }
    this.source = undefined
    this.refreshTask = undefined
    if (!this.disposed) this.options.resetProvider?.()
  }

  private assertActive(): void {
    if (this.disposed) throw new PublicError('unavailable', 'CodeBuddy 插件已停止。')
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(action)
    this.operations = next.catch(() => {})
    return next
  }

  refreshModels = (input: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> => {
    if (this.refreshTask?.epoch === this.epoch) return this.refreshTask.promise
    const epoch = this.epoch
    this.catalog = { ...this.catalog, status: 'refreshing', error: undefined }
    const task = { epoch, promise: Promise.resolve().then(async () => {
      let result: ModelsRefreshResult
      try { result = await this.models.refresh(input) }
      catch { result = { aborted: input.signal?.aborted ?? false, errors: new Map([[PROVIDER, Error('Models unavailable')]]) } }
      if (epoch !== this.epoch || this.disposed) return result
      if (result.aborted || input.signal?.aborted || result.errors.has(PROVIDER)) {
        this.catalog = { ...this.catalog, status: 'error', cached: this.catalog.models.length > 0, error: 'models-unavailable' }
      } else {
        const models = this.models.getModels(PROVIDER).map(model => ({
            id: model.id, name: model.name, reasoning: model.reasoning, contextWindow: model.contextWindow,
          }))
        const changed = JSON.stringify(models) !== JSON.stringify(this.catalog.models)
        this.catalog = { status: 'ready', cached: false, source: this.source, updatedAt: Date.now(), models }
        if (changed) this.options.registration.replace([PROVIDER])
      }
      return result
    }).finally(() => { if (this.refreshTask === task) this.refreshTask = undefined }) }
    this.refreshTask = task
    return task.promise
  }
}
