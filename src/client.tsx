import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en, zh } from './client-locales.ts'
const Translation = createContext<(key: string) => string>(key => key)
import { createClientState, type ClientController } from './client-state.ts'
import { DEFAULT_SITE, REASONING_LEVELS } from './contract.ts'

export const inject = ['slots', 'connection', 'locale']

const styles = `.codebuddy-settings{display:grid;gap:18px;max-width:760px;color:inherit;padding:8px 4px}
.codebuddy-settings h2,.codebuddy-settings h3,.codebuddy-settings p{margin:0}
.codebuddy-settings .cb-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;padding:18px;display:grid;gap:12px}
.codebuddy-settings .cb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.codebuddy-settings select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:8px 12px}
.codebuddy-settings select option{color:CanvasText;background:Canvas}
.codebuddy-settings button{cursor:pointer}.codebuddy-settings button:disabled{opacity:.45;cursor:default}
.codebuddy-settings button[aria-pressed=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
.codebuddy-settings input{min-width:240px;flex:1}.codebuddy-settings .cb-muted{opacity:.7;font-size:13px}
.codebuddy-settings [role=alert]{border-left:3px solid #d58b36;padding-left:12px}
.codebuddy-settings a{color:inherit;text-decoration:underline;overflow-wrap:anywhere}
.codebuddy-settings :focus-visible{outline:2px solid currentColor;outline-offset:3px}`

export function CodeBuddySection({ connection, locale }: { connection: ConnectionHandle; locale: LocaleRuntime }) {
  useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot())
  const t = locale.bind('codebuddy')
  const [controller] = useState(() => createClientState(connection.rpc))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [tab, setTab] = useState<'account' | 'models'>('account')
  useEffect(() => {
    void controller.load()
    const unsubscribe = connection.generation.subscribe(() => controller.reset(Boolean(connection.generation.getSnapshot())))
    return () => { unsubscribe(); controller.dispose() }
  }, [connection, controller])
  return <Translation.Provider value={t}><section className="codebuddy-settings" aria-label={t('CodeBuddy 设置')}>
    <h2>CodeBuddy</h2><p className="cb-muted">{t('连接账号，并为 DSH 设置默认模型。')}</p>
    <nav className="cb-row" aria-label={t('CodeBuddy 设置分页')}>
      <Button variant="outline" aria-pressed={tab === 'account'} onClick={() => setTab('account')}>{t('账号与连接')}</Button>
      <Button variant="outline" aria-pressed={tab === 'models'} onClick={() => setTab('models')}>{t('模型与运行')}</Button>
    </nav>
    {state.error && <p role="alert">{state.error}</p>}
    {!state.status ? <p role="status">{t('正在读取状态…')} <Button variant="outline" onClick={() => void controller.load()}>{t('重试')}</Button></p>
      : tab === 'account' ? <AccountPanel controller={controller} /> : <ModelsPanel controller={controller} />}
  </section></Translation.Provider>
}

function AccountPanel({ controller }: { controller: ClientController }) {
  const t = useContext(Translation)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const { status, preferences, busy } = state
  const [site, setSite] = useState(preferences?.defaultSite ?? DEFAULT_SITE)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  useEffect(() => { if (preferences) setSite(preferences.defaultSite) }, [preferences?.defaultSite])
  if (!status) return null
  const pending = ['starting', 'waiting_browser'].includes(status.login.phase)
  const known = [DEFAULT_SITE, 'https://copilot.tencent.com']
  return <>
    <div className="cb-card"><h3>{t('连接站点')}</h3>
      <label>{t('站点')} <select value={known.includes(site) ? site : 'custom'} disabled={busy || pending}
        onChange={event => setSite(event.target.value === 'custom' ? '' : event.target.value)}>
        <option value={DEFAULT_SITE}>{t('国际站')}</option><option value="https://copilot.tencent.com">{t('中国站')}</option><option value="custom">{t('自定义站点')}</option>
      </select></label>
      {!known.includes(site) && <label>{t('站点 URL')} <Input aria-label={t('站点 URL')} value={site} placeholder="https://your-site.example"
        disabled={busy || pending} onChange={event => setSite(event.target.value)} /></label>}
      <div className="cb-row"><Button variant="outline" disabled={busy || !preferences?.writable || !site}
        onClick={() => void controller.action('preferences/update', { defaultSite: site })}>{t('保存默认站点')}</Button>
        {!preferences?.writable && <span className="cb-muted">{t('当前 DSH 配置只读')}</span>}
      </div>
      <p className="cb-muted">{t('默认站点用于下次登录；保存不会切换当前账号。')}</p>
    </div>
    <div className="cb-card"><h3>{t('账号状态')}</h3>
      <p>{status.account.hasCredential ? t('已保存登录凭据') : t('尚未登录')}</p>
      {status.account.site && <p className="cb-muted">{t('当前账号站点：')}{status.account.site}</p>}
      {status.account.expiresAt && <p className="cb-muted">{t('访问凭据到期时间：')}{new Date(status.account.expiresAt).toLocaleString()}{t('（使用时自动刷新）')}</p>}
      <p role="status">{{ idle: '', starting: t('正在生成授权链接…'), waiting_browser: t('等待浏览器授权'), authenticated: t('登录成功'), failed: t('登录失败，请重试。'), cancelled: t('登录已取消') }[status.login.phase]}</p>
      {status.login.warning && <p role="alert">{t('登录凭据已保存，但模型刷新失败。请到“模型与运行”重试。')}</p>}
      {pending && status.login.authorizationUrl && <div className="cb-row">
        <a href={status.login.authorizationUrl} target="_blank" rel="noopener noreferrer">{t('打开授权页面')}</a>
        <Button variant="outline" onClick={() => { void navigator.clipboard.writeText(status.login.authorizationUrl!).then(() => { setCopied(true); setCopyError(false) }, () => setCopyError(true)) }}>{copied ? t('已复制') : t('复制授权链接')}</Button>
        {copyError && <span role="alert">{t('复制失败，请使用“打开授权页面”。')}</span>}
      </div>}
      <div className="cb-row">
        {state.pendingAction === 'login/start' && <Button variant="outline" onClick={() => controller.reset()}>{t('取消登录')}</Button>}
        <Button variant="outline" disabled={busy || pending || !site} onClick={() => void controller.action('login/start', { site })}>{status.account.hasCredential ? t('重新登录') : t('登录 CodeBuddy')}</Button>
        {pending && <Button variant="outline" disabled={busy} onClick={() => void controller.action('login/cancel', { loginId: status.login.loginId })}>{t('取消登录')}</Button>}
        <Button variant="outline" disabled={busy || (!status.account.hasCredential && !pending)} onClick={() => void controller.action('logout')}>{t('退出登录')}</Button>
      </div>
    </div>
  </>
}

function ModelsPanel({ controller }: { controller: ClientController }) {
  const t = useContext(Translation)
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const catalog = state.status!.catalog
  const saved = state.defaultModel
  const [selected, setSelected] = useState(saved?.provider === 'codebuddy' ? saved.model ?? '' : '')
  const [effort, setEffort] = useState(saved?.provider === 'codebuddy' ? saved.reasoningEffort ?? 'high' : 'high')
  useEffect(() => {
    setSelected(saved?.provider === 'codebuddy' ? saved.model ?? '' : '')
    setEffort(saved?.provider === 'codebuddy' ? saved.reasoningEffort ?? 'high' : 'high')
  }, [saved?.provider, saved?.model, saved?.reasoningEffort])
  const model = catalog.models.find(model => model.id === selected)
  const canSave = state.status!.account.hasCredential && catalog.status === 'ready' && !catalog.cached && saved?.available && model
  return <><div className="cb-card"><h3>{t('模型目录')}</h3>
    <Button variant="outline" disabled={state.busy || !state.status?.account.hasCredential} onClick={() => void controller.action('models/refresh')}>{t('刷新模型')}</Button>
    <p>{catalog.models.length} {t('个模型')} · {{ idle: t('尚未刷新'), refreshing: t('刷新中'), ready: t('可用'), error: t('刷新失败') }[catalog.status]}</p>
    {!state.status?.account.hasCredential && <p className="cb-muted">{t('请先在“账号与连接”登录。')}</p>}
    {catalog.source && <p className="cb-muted">{t('目录来源：')}{catalog.source}</p>}
    {catalog.updatedAt && <p className="cb-muted">{t('上次成功刷新：')}{new Date(catalog.updatedAt).toLocaleString()}</p>}
    {catalog.error && <p role="alert">{t('模型刷新失败')}{catalog.cached ? t('，正在显示上次成功的目录') : ''}。</p>}
  </div><div className="cb-card"><h3>{t('默认模型与推理等级')}</h3>
    {saved?.available ? <p className="cb-muted">{t('DSH 当前默认：')}{saved.provider} / {saved.model}{saved.reasoningEffort ? ` · ${saved.reasoningEffort}` : ''}</p>
      : <p role="alert">{t('当前宿主未提供默认模型设置服务。')}</p>}
    <label>{t('模型')} <select aria-label={t('默认模型')} value={selected} disabled={state.busy || catalog.status !== 'ready' || catalog.cached}
      onChange={event => { setSelected(event.target.value); setEffort(catalog.models.find(model => model.id === event.target.value)?.reasoning ? 'high' : 'off') }}>
      <option value="">{t('请选择模型')}</option>
      {selected && !model && <option value={selected}>{selected}{t('（不在当前目录）')}</option>}
      {catalog.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
    </select></label>
    {model?.reasoning && <label>{t('推理等级')} <select aria-label={t('推理等级')} value={model?.reasoning ? effort : 'off'} disabled={state.busy || !model?.reasoning}
      onChange={event => setEffort(event.target.value)}>
      {(model?.reasoning ? REASONING_LEVELS : ['off']).map(level => <option key={level} value={level}>{level}</option>)}
    </select></label>}
    {model && <p className="cb-muted">{t('上下文窗口：')}{model.contextWindow.toLocaleString()} tokens。{model.reasoning ? t('推理等级由适配器统一映射，实际效果取决于模型。') : t('此模型不启用推理。')}</p>}
    <Button variant="outline" disabled={state.busy || !canSave} onClick={() => void controller.action('default-model/select', { model: selected, reasoningEffort: model?.reasoning ? effort : 'off' })}>{t('保存为 DSH 默认模型')}</Button>
    <p className="cb-muted">{t('用于后续采用默认模型的新会话；已有会话保持自己的模型选择。')}</p>
  </div></>
}

export function apply(ctx: Context) {
  ctx.effect(() => ctx.locale.register('codebuddy', 'zh', zh))
  ctx.effect(() => ctx.locale.register('codebuddy', 'en', en))
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => style.remove()
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'codebuddy', order: 16, label: () => 'CodeBuddy',
    inject: () => ({ connection: ctx.get('connection') as unknown as ConnectionHandle, locale: ctx.locale }),
  }, CodeBuddySection))
}
