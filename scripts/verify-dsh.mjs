import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'

// The fixture is deliberately local: it never reads a user's DSH profile or CodeBuddy credentials.
const args = process.argv.slice(2)
const option = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback
const version = option('--version', '0.2.0-rc.2')
const mode = option('--mode', 'web')
assert.equal(version, '0.2.0-rc.2', 'Only the pinned, inspected SDK is supported by this fixture')
assert.ok(['web', 'commands'].includes(mode))
assert.ok(args.includes('--mock-provider'), 'Use --mock-provider: this script never performs a real account login')
const root = resolve(import.meta.dirname, '..')
const runtime = join(root, '.tmp/host-020')
const home = join(root, mode === 'web' ? '.tmp/verification-home' : '.tmp/verification-commands-home')
const cli = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
assert.equal(JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'))).version, version)
await mkdir(join(root, '.tmp/verification-artifacts'), { recursive: true })
const artifacts = join(root, '.tmp/verification-artifacts')
const env = { ...process.env, DSH_HOME: home }
delete env.PI_CODEBUDDY_DEBUG
delete env.PI_CODEBUDDY_DEBUG_FILE
let authorized = false
let failCatalog = false
let mockSite
const requests = []
let completionBody
const mock = createServer(async (req, res) => {
  const url = new URL(req.url, mockSite)
  requests.push(url.pathname)
  res.setHeader('content-type', 'application/json')
  const reply = data => res.end(JSON.stringify({ error: { code: 0 }, data }))
  if (url.pathname === '/authorize') { authorized = true; return reply({ ok: true }) }
  if (url.pathname === '/v2/plugin/auth/state') { authorized = false; return reply({ state: 'local-test-state', authUrl: `${mockSite}/authorize` }) }
  if (url.pathname === '/v2/plugin/auth/token') return authorized
    ? reply({ accessToken: 'mock-access-token', refreshToken: 'mock-refresh-token', expiresIn: 3600, domain: 'www.codebuddy.ai' })
    : res.end(JSON.stringify({ code: 11217, msg: 'Awaiting mock browser authorization' }))
  if (url.pathname === '/v2/plugin/login/account') return reply({ uid: 'mock-user', type: 'personal' })
  if (url.pathname === '/v3/config') {
    if (failCatalog) { res.statusCode = 503; return res.end('{}') }
    return res.end('{}')
  }
  if (url.pathname === '/v2/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk
    completionBody = JSON.parse(body)
    res.setHeader('content-type', 'text/event-stream')
    res.write(`data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'default-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'mock hello' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'default-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`)
    return res.end('data: [DONE]\n\n')
  }
  res.statusCode = 404; res.end('{}')
})
mock.listen(0, '127.0.0.1'); await once(mock, 'listening')
mockSite = `http://127.0.0.1:${mock.address().port}`
let child
let browser
let output = ''
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(200) }
  throw Error(message)
}
async function start() {
  output = ''
  child = spawn(process.execPath, [cli, '--profile', 'verify', '--port', '0', '--no-open'], { cwd: root, env, windowsHide: true })
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return until(() => {
    if (child.exitCode !== null) throw Error(`Host exited: ${output.replace(/token=[^\s]+/g, 'token=<redacted>')}`)
    return output.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
  }, 'Host did not announce an authenticated URL', 60000)
}
async function stop() {
  if (child && child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), delay(5000)]) }
}
async function runCli(args) {
  const task = spawn(process.execPath, [cli, ...args], { cwd: root, env, windowsHide: true })
  let log = ''
  task.stdout.on('data', chunk => { log += chunk }); task.stderr.on('data', chunk => { log += chunk })
  const [code] = await once(task, 'exit')
  return { code, log }
}
async function ensureProfile(name) {
  const dir = join(home, 'profiles', name)
  const exists = await access(join(dir, 'package.json')).then(() => true, () => false)
  const initialized = await runCli(['--profile', name, ...exists ? [] : ['--from-default-profile', 'web'], '--dump-config'])
  assert.equal(initialized.code, 0, initialized.log)
  const local = await readFile(join(root, 'lib/index.mjs'), 'utf8')
  const installed = await readFile(join(dir, 'node_modules/@lbryany/dsh-codebuddy/lib/index.mjs'), 'utf8').catch(() => '')
  const localClient = await readFile(join(root, 'lib/client.js'), 'utf8')
  const installedClient = await readFile(join(dir, 'node_modules/@lbryany/dsh-codebuddy/lib/client.js'), 'utf8').catch(() => '')
  if (local !== installed || localClient !== installedClient) {
    const workspace = join(dir, 'pnpm-workspace.yaml')
    await writeFile(workspace, 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  "@google/genai": false\n  protobufjs: false\n')
    await runCli(['plugin', '--profile', name, 'remove', '@lbryany/dsh-codebuddy'])
    const packageVersion = JSON.parse(await readFile(join(root, 'package.json'))).version
    const result = await runCli(['plugin', '--profile', name, 'add', join(root, `.tmp/lbryany-dsh-codebuddy-${packageVersion}.tgz`)])
    assert.equal(result.code, 0, result.log)
    assert.equal(await readFile(join(dir, 'node_modules/@lbryany/dsh-codebuddy/lib/index.mjs'), 'utf8'), local, 'Rebuild and npm pack before verification')
  }
  return dir
}
try {
  if (mode === 'commands') {
    const dir = await ensureProfile('verify-commands')
    const pkg = JSON.parse(await readFile(join(dir, 'package.json')))
    pkg.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@lbryany/dsh-codebuddy']
    await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    await writeFile(join(dir, 'cordis.patch.yml'), `- insert:\n    - id: codebuddy-command-probe\n      name: ${JSON.stringify(pathToFileURL(join(root, 'scripts/commands-probe.mjs')).href)}\n`)
    child = spawn(process.execPath, [cli, '--profile', 'verify-commands'], { cwd: root, env: { ...env, CODEBUDDY_MOCK_SITE: mockSite }, windowsHide: true })
    child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    await until(() => { if (child.exitCode !== null) throw Error(output); return output.includes('CODEBUDDY_COMMANDS_PASS') }, 'Commands probe failed: see commands-host.log', 60000)
    assert.ok(completionBody, 'No streaming request reached the local provider')
    assert.match(JSON.stringify(completionBody), /mock system prompt/)
    console.log(`PASS DSH ${version}: command-only profile, mock login, catalog, streaming completion, logout.`)
  } else {
  await ensureProfile('verify')
  const loginUrl = await start()
  const origin = new URL(loginUrl).origin
  const denied = await fetch(`${origin}/api/codebuddy/status`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'codebuddy/status', payload: {} }) })
  assert.equal(denied.status, 401, 'Unauthenticated CodeBuddy management must be rejected')
  const { chromium } = await import(pathToFileURL(join(runtime, 'node_modules/playwright/index.mjs')).href)
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1400, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(loginUrl)
  await page.waitForTimeout(3000)
  await writeFile(join(artifacts, 'initial-page.txt'), await page.locator('body').innerText())
  await page.screenshot({ path: join(artifacts, 'initial-page.png'), fullPage: true })
  const rpc = async (endpoint, payload = {}) => {
    const result = await page.evaluate(async ({ endpoint, payload }) => {
      const response = await fetch(`/api/codebuddy/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `verify-${Date.now()}`, method: `codebuddy/${endpoint}`, payload }) })
      if (!response.ok) throw Error(`HTTP ${response.status}`)
      return (await response.json()).result
    }, { endpoint, payload })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.doesNotMatch(JSON.stringify(result), /mock-access-token|mock-refresh-token/)
    return result.value
  }
  const initial = await rpc('status')
  const foreignOrigin = await page.request.post(`${origin}/api/codebuddy/status`, { headers: { origin: 'https://untrusted.example' },
    data: { type: 'client-request', rpcId: 'foreign-origin', method: 'codebuddy/status', payload: {} } })
  assert.equal(foreignOrigin.status(), 403, 'An authenticated cookie must not bypass the origin fence')
  if (initial.account.hasCredential) await rpc('logout')
  const continueButton = page.getByRole('button', { name: '继续', exact: true })
  if (await continueButton.count()) await continueButton.click()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'CodeBuddy', exact: true }).click()
  await page.getByRole('heading', { name: '连接站点' }).waitFor()
  await page.screenshot({ path: join(artifacts, 'account-settings.png'), fullPage: true })
  await page.getByRole('combobox').first().selectOption('custom')
  await page.getByRole('textbox', { name: '站点 URL', exact: true }).fill(mockSite)
  await page.getByRole('button', { name: '保存默认站点', exact: true }).click()
  await until(async () => (await rpc('preferences/status')).defaultSite === mockSite, 'Native site setting did not save')
  await page.getByRole('button', { name: '登录 CodeBuddy', exact: true }).click()
  await page.getByRole('link', { name: '打开授权页面', exact: true }).waitFor()
  const login = (await rpc('status')).login
  assert.equal(login.phase, 'waiting_browser')
  await fetch(login.authorizationUrl)
  await until(async () => (await rpc('status')).catalog.status === 'ready', 'Mock login did not load its catalog')
  await page.getByText('已保存登录凭据', { exact: true }).waitFor()
  const current = await rpc('status')
  assert.equal(current.account.hasCredential, true)
  assert.ok(current.catalog.models.length > 0)
  const reasoning = current.catalog.models.find(model => model.reasoning)
  assert.ok(reasoning)
  await rpc('default-model/select', { model: reasoning.id, reasoningEffort: 'high' })
  await page.getByRole('button', { name: '模型与运行', exact: true }).click()
  await page.getByRole('button', { name: '刷新模型', exact: true }).click()
  await page.getByRole('combobox', { name: '默认模型', exact: true }).selectOption(reasoning.id)
  await page.getByRole('combobox', { name: '推理等级', exact: true }).selectOption('max')
  await page.getByRole('button', { name: '保存为 DSH 默认模型', exact: true }).click()
  await until(async () => (await rpc('default-model/status')).reasoningEffort === 'max', 'Native model settings did not save')
  await until(async () => (await rpc('status')).catalog.status === 'ready', 'Catalog did not settle')
  await page.waitForTimeout(1600)
  await page.screenshot({ path: join(artifacts, 'model-settings.png'), fullPage: true })
  failCatalog = true
  const failed = await rpc('models/refresh')
  assert.equal(failed.status, 'error')
  assert.equal(failed.cached, true)
  assert.equal((await rpc('status')).account.hasCredential, true)
  failCatalog = false
  await rpc('models/refresh')
  await stop()
  await page.goto(await start())
  assert.equal((await rpc('preferences/status')).defaultSite, mockSite, 'Site must survive host restart')
  const restoredDefault = await rpc('default-model/status')
  assert.equal(restoredDefault.provider, 'codebuddy')
  assert.equal(restoredDefault.reasoningEffort, 'max')
  assert.equal((await rpc('status')).account.hasCredential, true, 'Credentials must survive host restart')
  const cancelled = await rpc('login/start')
  await rpc('login/cancel', { loginId: cancelled.loginId })
  assert.equal((await rpc('status')).login.phase, 'cancelled')
  await writeFile(join(artifacts, 'page-errors.json'), JSON.stringify(errors, null, 2))
  await writeFile(join(artifacts, 'after-login-page.txt'), await page.locator('body').innerText())
  assert.deepEqual(errors, [], 'Browser module must load without script errors')
  await rpc('logout')
  assert.equal((await rpc('status')).account.hasCredential, false)
  const english = await browser.newPage({ locale: 'en-US', viewport: { width: 1200, height: 900 } })
  await english.goto(output.match(/dsh web: (http:\/\/[^\s]+)/)[1])
  await english.waitForTimeout(2500)
  await writeFile(join(artifacts, 'english-initial.txt'), await english.locator('body').innerText())
  const continueEnglish = english.getByRole('button', { name: 'Continue', exact: true })
  if (await continueEnglish.count()) await continueEnglish.click()
  await english.getByRole('button', { name: 'Settings', exact: true }).click()
  await english.getByRole('button', { name: 'CodeBuddy', exact: true }).click()
  await english.getByRole('heading', { name: 'Connection site', exact: true }).waitFor()
  await english.screenshot({ path: join(artifacts, 'account-settings-en.png'), fullPage: true })
  await english.close()
  console.log(`PASS DSH ${version}: authentication/origin fence, native settings, mock OAuth/cancel, catalog cache, default model/reasoning, restart persistence, logout. ${requests.length} mock requests.`)
  }
} finally {
  await browser?.close()
  await stop()
  mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve))
  await writeFile(join(artifacts, `${mode}-host.log`), output.replace(/token=[^\s]+/g, 'token=<redacted>'))
}
