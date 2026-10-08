import { PROVIDER, PublicError, REASONING_LEVELS, type DefaultModelView, type StatusView } from './contract.ts'

interface Selection { provider: string; model: string; reasoningEffort?: string }
interface DefaultModelHost {
  currentSelection(): Selection
  saveSelection(selection: Selection): Promise<void>
}
export function createDefaultModel(options: {
  host(): DefaultModelHost | undefined
  account: { status(): Promise<StatusView>; readonly revision: number; accountSignal(): AbortSignal; withAccount<T>(action: () => Promise<T>): Promise<T> }
}) {
  let saves: Promise<unknown> = Promise.resolve()
  const status = (): DefaultModelView => {
    const host = options.host()
    return host ? { available: true, ...host.currentSelection() } : { available: false }
  }
  return {
    status,
    select(input: { model: string; reasoningEffort?: string }): Promise<DefaultModelView> {
      const revision = options.account.revision
      const save = saves.then(() => options.account.withAccount(async () => {
        const host = options.host()
        if (!host) throw new PublicError('unavailable', 'DSH 默认模型服务不可用。')
        const current = await options.account.status()
        if (options.account.revision !== revision || options.account.accountSignal().aborted) throw new PublicError('account-changed', '账号已变化，请刷新模型后重试。')
        if (!current.account.hasCredential || current.catalog.status !== 'ready' || current.catalog.cached) {
          throw new PublicError('catalog-unavailable', '请先登录并成功刷新模型目录。')
        }
        const model = current.catalog.models.find(model => model.id === input.model)
        if (!model) throw new PublicError('unknown-model', '此模型不在当前账号目录中。')
        const previous = host.currentSelection()
        const effort = input.reasoningEffort ?? (previous.provider === PROVIDER && previous.model === model.id
          ? previous.reasoningEffort : undefined) ?? (model.reasoning ? 'high' : 'off')
        if (!(REASONING_LEVELS as readonly string[]).includes(effort) || (!model.reasoning && effort !== 'off')) {
          throw new PublicError('invalid-reasoning', '所选模型不支持此推理等级。')
        }
        const next = { provider: PROVIDER, model: model.id, reasoningEffort: effort }
        await host.saveSelection(next)
        const saved = host.currentSelection()
        if (saved.provider !== next.provider || saved.model !== next.model || saved.reasoningEffort !== next.reasoningEffort) {
          throw new PublicError('not-saved', 'DSH 默认模型未能保存，请检查配置权限。')
        }
        return status()
      }))
      saves = save.catch(() => {})
      return save
    },
  }
}
