import assert from 'node:assert/strict'
import test from 'node:test'
import type { Credential, CredentialStore, Models } from '@earendil-works/pi-ai'
import { CodeBuddyService } from '../src/service.ts'
import { CodeBuddyAdapter } from '../src/adapter.ts'

function fixture() {
  let credential: Credential | undefined = { type: 'oauth', access: 'private-access', refresh: 'private-refresh', expires: 1234, baseUrl: 'https://copilot.tencent.com' }
  let refreshes = 0
  let fail = false
  const store: CredentialStore = {
    read: async () => credential, list: async () => [],
    modify: async (_id, fn) => { credential = await fn(credential); return credential },
    delete: async () => { credential = undefined },
  }
  const models = {
    getModels: () => [{ id: 'm', name: 'Model', reasoning: true, contextWindow: 1000 }],
    refresh: async () => { refreshes++; return { aborted: false, errors: fail ? new Map([['codebuddy', Error('secret')]]) : new Map() } },
    logout: async () => store.delete('codebuddy'),
  } as unknown as Models
  const service = new CodeBuddyService({ models, store, registration: { replace() {} }, logger: { info() {}, error() {} } })
  return { service, refreshes: () => refreshes, fail: () => { fail = true } }
}

test('status is local-only, sanitized, and model errors do not turn a stored account into signed-out', async () => {
  const f = fixture()
  const before = await f.service.status()
  assert.equal(f.refreshes(), 0)
  assert.equal(before.account.site, 'https://copilot.tencent.com')
  assert.doesNotMatch(JSON.stringify(before), /private-/)
  await f.service.refresh()
  f.fail()
  await f.service.refresh()
  const after = await f.service.status()
  assert.equal(after.account.hasCredential, true)
  assert.equal(after.catalog.status, 'error')
  assert.equal(after.catalog.cached, true)
  assert.equal(after.catalog.models[0]?.id, 'm')
  assert.doesNotMatch(JSON.stringify(after), /secret/)
})

test('logout invalidates prepared requests, clears credentials and catalog', async () => {
  const { service } = fixture()
  await service.refresh()
  const old = service.accountSignal()
  await service.logout()
  assert.equal(old.aborted, true)
  const status = await service.status()
  assert.equal(status.account.hasCredential, false)
  assert.deepEqual(status.catalog.models, [])
  assert.equal(status.login.phase, 'idle')
  await service.dispose()
  assert.equal(service.accountSignal().aborted, true)
})

test('adapter listing and settings refresh share one underlying provider refresh', async () => {
  const { service } = fixture()
  let finish!: () => void
  const gate = new Promise<void>(resolve => { finish = resolve })
  let calls = 0
  service.models.refresh = async () => { calls++; await gate; return { aborted: false, errors: new Map() } }
  const adapter = new CodeBuddyAdapter(service.models, service.accountSignal, service.refreshModels)
  const listing = adapter.listModels('codebuddy')
  const refresh = service.refresh()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  finish()
  await Promise.all([listing, refresh])
  assert.equal((await service.status()).catalog.status, 'ready')
})

test('cancellation interrupts auth/state before its URL arrives', async () => {
  const { service } = fixture()
  service.models.login = async (_provider, _auth, interaction) => new Promise((_resolve, reject) => {
    interaction.signal!.addEventListener('abort', () => reject(interaction.signal!.reason), { once: true })
  })
  const started = service.start('cn', new AbortController().signal)
  const rejected = assert.rejects(started, /取消|失败|failed/i)
  await new Promise(resolve => setImmediate(resolve))
  const adapter = new CodeBuddyAdapter(service.models, service.accountSignal, service.refreshModels)
  await assert.rejects(adapter.listModels('codebuddy'), /账号状态已变化/)
  await service.cancel()
  await rejected
  assert.equal((await service.status()).login.phase, 'cancelled')
})

test('aborting a reused login caller does not reopen model access while the original login is pending', async () => {
  const { service } = fixture()
  service.models.login = async (_provider, _auth, interaction) => new Promise((_resolve, reject) => {
    interaction.signal!.addEventListener('abort', () => reject(interaction.signal!.reason), { once: true })
  })
  const original = service.start('cn', new AbortController().signal)
  const originalRejected = assert.rejects(original)
  await new Promise(resolve => setImmediate(resolve))
  const caller = new AbortController()
  const duplicate = service.start('cn', caller.signal)
  const duplicateRejected = assert.rejects(duplicate)
  await new Promise(resolve => setImmediate(resolve))
  caller.abort()
  await duplicateRejected
  assert.ok(service.login.pending())
  assert.equal(service.accountSignal().aborted, true)
  await service.cancel()
  await originalRejected
})
