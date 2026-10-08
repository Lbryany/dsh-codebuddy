import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { createClientState, type ClientController } from './client-state.ts'
import { DEFAULT_SITE, REASONING_LEVELS } from './contract.ts'

export const inject = ['slots', 'connection']

const styles = `.codebuddy-settings{display:grid;gap:18px;max-width:760px;color:inherit;padding:8px 4px}
.codebuddy-settings h2,.codebuddy-settings h3,.codebuddy-settings p{margin:0}
.codebuddy-settings .cb-card{border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:12px;padding:18px;display:grid;gap:12px}
.codebuddy-settings .cb-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.codebuddy-settings button,.codebuddy-settings select,.codebuddy-settings input{font:inherit;color:inherit;background:transparent;border:1px solid color-mix(in srgb,currentColor 25%,transparent);border-radius:7px;padding:8px 12px}
.codebuddy-settings select option{color:CanvasText;background:Canvas}
.codebuddy-settings button{cursor:pointer}.codebuddy-settings button:disabled{opacity:.45;cursor:default}
.codebuddy-settings button[aria-pressed=true]{background:color-mix(in srgb,currentColor 12%,transparent)}
.codebuddy-settings input{min-width:240px;flex:1}.codebuddy-settings .cb-muted{opacity:.7;font-size:13px}
.codebuddy-settings [role=alert]{border-left:3px solid #d58b36;padding-left:12px}
.codebuddy-settings a{color:inherit;text-decoration:underline;overflow-wrap:anywhere}
.codebuddy-settings :focus-visible{outline:2px solid currentColor;outline-offset:3px}`

export function CodeBuddySection({ connection }: { connection: ConnectionHandle }) {
  const [controller] = useState(() => createClientState(connection.rpc))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const [tab, setTab] = useState<'account' | 'models'>('account')
  useEffect(() => {
    void controller.load()
    const unsubscribe = connection.generation.subscribe(() => controller.reset(Boolean(connection.generation.getSnapshot())))
    return () => { unsubscribe(); controller.dispose() }
  }, [connection, controller])
  return <section className="codebuddy-settings" aria-label="CodeBuddy 设置">
    <h2>CodeBuddy</h2><p className="cb-muted">连接账号，并为 DSH 设置默认模型。</p>
    <nav className="cb-row" aria-label="CodeBuddy 设置分页">
      <button aria-pressed={tab === 'account'} onClick={() => setTab('account')}>账号与连接</button>
      <button aria-pressed={tab === 'models'} onClick={() => setTab('models')}>模型与运行</button>
    </nav>
    {state.error && <p role="alert">{state.error}</p>}
    {!state.status ? <p role="status">正在读取状态… <button onClick={() => void controller.load()}>重试</button></p>
      : tab === 'account' ? <AccountPanel controller={controller} /> : <ModelsPanel controller={controller} />}
  </section>
}

function AccountPanel({ controller }: { controller: ClientController }) {
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
    <div className="cb-card"><h3>连接站点</h3>
      <label>站点 <select value={known.includes(site) ? site : 'custom'} disabled={busy || pending}
        onChange={event => setSite(event.target.value === 'custom' ? '' : event.target.value)}>
        <option value={DEFAULT_SITE}>国际站</option><option value="https://copilot.tencent.com">中国站</option><option value="custom">自定义站点</option>
      </select></label>
      {!known.includes(site) && <label>站点 URL <input aria-label="站点 URL" value={site} placeholder="https://your-site.example"
        disabled={busy || pending} onChange={event => setSite(event.target.value)} /></label>}
      <div className="cb-row"><button disabled={busy || !preferences?.writable || !site}
        onClick={() => void controller.action('preferences/update', { defaultSite: site })}>保存默认站点</button>
        {!preferences?.writable && <span className="cb-muted">当前 DSH 配置只读</span>}
      </div>
      <p className="cb-muted">默认站点用于下次登录；保存不会切换当前账号。</p>
    </div>
    <div className="cb-card"><h3>账号状态</h3>
      <p>{status.account.hasCredential ? '已保存登录凭据' : '尚未登录'}</p>
      {status.account.site && <p className="cb-muted">当前账号站点：{status.account.site}</p>}
      {status.account.expiresAt && <p className="cb-muted">访问凭据到期时间：{new Date(status.account.expiresAt).toLocaleString()}（使用时自动刷新）</p>}
      <p role="status">{{ idle: '', starting: '正在生成授权链接…', waiting_browser: '等待浏览器授权', authenticated: '登录成功', failed: '登录失败，请重试。', cancelled: '登录已取消' }[status.login.phase]}</p>
      {status.login.warning && <p role="alert">登录凭据已保存，但模型刷新失败。请到“模型与运行”重试。</p>}
      {pending && status.login.authorizationUrl && <div className="cb-row">
        <a href={status.login.authorizationUrl} target="_blank" rel="noopener noreferrer">打开授权页面</a>
        <button onClick={() => { void navigator.clipboard.writeText(status.login.authorizationUrl!).then(() => { setCopied(true); setCopyError(false) }, () => setCopyError(true)) }}>{copied ? '已复制' : '复制授权链接'}</button>
        {copyError && <span role="alert">复制失败，请使用“打开授权页面”。</span>}
      </div>}
      <div className="cb-row">
        <button disabled={busy || pending || !site} onClick={() => void controller.action('login/start', { site })}>{status.account.hasCredential ? '重新登录' : '登录 CodeBuddy'}</button>
        {pending && <button disabled={busy} onClick={() => void controller.action('login/cancel', { loginId: status.login.loginId })}>取消登录</button>}
        <button disabled={busy || (!status.account.hasCredential && !pending)} onClick={() => void controller.action('logout')}>退出登录</button>
      </div>
    </div>
  </>
}

function ModelsPanel({ controller }: { controller: ClientController }) {
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
  return <><div className="cb-card"><h3>模型目录</h3>
    <button disabled={state.busy || !state.status?.account.hasCredential} onClick={() => void controller.action('models/refresh')}>刷新模型</button>
    <p>{catalog.models.length} 个模型 · {{ idle: '尚未刷新', refreshing: '刷新中', ready: '可用', error: '刷新失败' }[catalog.status]}</p>
    {!state.status?.account.hasCredential && <p className="cb-muted">请先在“账号与连接”登录。</p>}
    {catalog.source && <p className="cb-muted">目录来源：{catalog.source}</p>}
    {catalog.updatedAt && <p className="cb-muted">上次成功刷新：{new Date(catalog.updatedAt).toLocaleString()}</p>}
    {catalog.error && <p role="alert">模型刷新失败{catalog.cached ? '，正在显示上次成功的目录' : ''}。</p>}
  </div><div className="cb-card"><h3>默认模型与推理等级</h3>
    {saved?.available ? <p className="cb-muted">DSH 当前默认：{saved.provider} / {saved.model}{saved.reasoningEffort ? ` · ${saved.reasoningEffort}` : ''}</p>
      : <p role="alert">当前宿主未提供默认模型设置服务。</p>}
    <label>模型 <select aria-label="默认模型" value={selected} disabled={state.busy || catalog.status !== 'ready' || catalog.cached}
      onChange={event => { setSelected(event.target.value); setEffort(catalog.models.find(model => model.id === event.target.value)?.reasoning ? 'high' : 'off') }}>
      <option value="">请选择模型</option>
      {selected && !model && <option value={selected}>{selected}（不在当前目录）</option>}
      {catalog.models.map(model => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}
    </select></label>
    <label>推理等级 <select aria-label="推理等级" value={model?.reasoning ? effort : 'off'} disabled={state.busy || !model?.reasoning}
      onChange={event => setEffort(event.target.value)}>
      {(model?.reasoning ? REASONING_LEVELS : ['off']).map(level => <option key={level} value={level}>{level}</option>)}
    </select></label>
    {model && <p className="cb-muted">上下文窗口：{model.contextWindow.toLocaleString()} tokens。{model.reasoning ? '推理等级由适配器统一映射，实际效果取决于模型。' : '此模型不启用推理。'}</p>}
    <button disabled={state.busy || !canSave} onClick={() => void controller.action('default-model/select', { model: selected, reasoningEffort: model?.reasoning ? effort : 'off' })}>保存为 DSH 默认模型</button>
    <p className="cb-muted">用于后续采用默认模型的新会话；已有会话保持自己的模型选择。</p>
  </div></>
}

export function apply(ctx: Context) {
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = styles; document.head.append(style)
    return () => style.remove()
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'codebuddy', order: 16, label: () => 'CodeBuddy',
    inject: () => ({ connection: ctx.get('connection') as unknown as ConnectionHandle }),
  }, CodeBuddySection))
}
