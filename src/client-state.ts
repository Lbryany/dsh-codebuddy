import type { DefaultModelView, PreferencesView, StatusView } from './contract.ts'

export interface Transport {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<
    { ok: true; value: unknown } | { ok: false; error: { message: string } }>
}
export interface ClientState {
  status?: StatusView
  preferences?: PreferencesView
  defaultModel?: DefaultModelView
  busy: boolean
  pendingAction?: string
  error?: string
}

/** One mounted settings page owns requests and polling; a connection change discards all old replies. */
export function createClientState(transport: Transport) {
  let state: ClientState = { busy: false }
  let lifetime = new AbortController()
  let version = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ClientState) => { state = next; for (const fn of listeners) fn() }
  const call = async (endpoint: string, payload: unknown, signal: AbortSignal) => {
    const response = await transport.call('/api', `codebuddy/${endpoint}`, payload, signal)
    if (!response.ok) throw new Error(response.error.message)
    return response.value
  }
  const schedule = () => {
    clearTimeout(timer)
    const status = state.status
    if (!disposed && (['starting', 'waiting_browser'].includes(status?.login.phase ?? '') || status?.catalog.status === 'refreshing')) {
      timer = setTimeout(() => { void load() }, 1500)
    }
  }
  async function load() {
    if (disposed || state.busy) return
    const revision = version
    const signal = lifetime.signal
    try {
      const [status, preferences, defaultModel] = await Promise.all([
        call('status', {}, signal), call('preferences/status', {}, signal), call('default-model/status', {}, signal),
      ])
      if (disposed || revision !== version || signal.aborted) return
      publish({ status: status as StatusView, preferences: preferences as PreferencesView,
        defaultModel: defaultModel as DefaultModelView, busy: false })
      schedule()
    } catch (error) {
      if (disposed || revision !== version || signal.aborted) return
      publish({ ...state, error: error instanceof Error ? error.message : '无法读取 CodeBuddy 状态。' })
      // Keep a pending login observable after a temporary transport failure.
      schedule()
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn) } },
    load,
    async action(endpoint: string, payload: unknown = {}) {
      if (disposed || state.busy) return
      clearTimeout(timer)
      const revision = ++version
      const signal = lifetime.signal
      publish({ ...state, busy: true, pendingAction: endpoint, error: undefined })
      let failure: string | undefined
      try { await call(endpoint, payload, signal) }
      catch (error) { failure = error instanceof Error ? error.message : 'CodeBuddy 操作失败。' }
      if (disposed || revision !== version || signal.aborted) return
      publish({ ...state, busy: false, pendingAction: undefined })
      await load()
      if (failure && !disposed && revision === version) publish({ ...state, error: failure })
    },
    reset(connected = true) {
      lifetime.abort(); lifetime = new AbortController(); version++; clearTimeout(timer)
      publish({ busy: false, error: connected ? undefined : 'DSH 连接已断开，正在等待重连。' })
      if (connected) void load()
    },
    dispose() { disposed = true; version++; lifetime.abort(); clearTimeout(timer); listeners.clear() },
  }
}
export type ClientController = ReturnType<typeof createClientState>
