import assert from 'node:assert/strict'
import test from 'node:test'

import type { AuthInteraction, Credential, Models } from '@earendil-works/pi-ai'
import { authorizationUrlText, CodeBuddyLoginManager } from '../src/login.ts'

const credential: Credential = {
  type: 'oauth',
  access: 'access',
  refresh: 'refresh',
  expires: 123,
  baseUrl: 'https://www.codebuddy.ai',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('login returns a clickable authorization URL while OAuth continues in the background', async () => {
  const completedLogin = deferred<Credential>()
  const calls: string[] = []
  let interaction: AuthInteraction | undefined
  const models = {
    async login(_provider: string, _type: string, value: AuthInteraction) {
      interaction = value
      value.notify({ type: 'auth_url', url: 'https://auth.example/authorize?id=1' })
      return completedLogin.promise
    },
    async refresh() {
      calls.push('refresh')
      return { aborted: false, errors: new Map() }
    },
    getModels() {
      return [{ name: 'Model One' }]
    },
  } as unknown as Pick<Models, 'getModels' | 'login' | 'refresh'>
  const registration = { replace: (providers: string[]) => calls.push(`replace:${providers.join(',')}`) }
  const logs: string[] = []
  const logger = {
    error: (format: unknown) => logs.push(`error:${String(format)}`),
    info: (format: unknown) => logs.push(`info:${String(format)}`),
  }
  const manager = new CodeBuddyLoginManager(models, registration, logger, 'codebuddy')

  const started = await manager.start('https://www.codebuddy.ai', new AbortController().signal)

  assert.equal(started.authorizationUrl, 'https://auth.example/authorize?id=1')
  assert.equal(started.reused, false)
  assert.equal(interaction?.signal?.aborted, false)
  assert.deepEqual(manager.pending(), {
    authorizationUrl: 'https://auth.example/authorize?id=1',
    site: 'https://www.codebuddy.ai',
  })
  assert.deepEqual(calls, [])

  completedLogin.resolve(credential)
  await started.completion

  assert.deepEqual(calls, ['refresh', 'replace:codebuddy'])
  assert.equal(manager.pending(), undefined)
  assert.equal(logs.some(line => line.startsWith('error:')), false)
})

test('a repeated login command reuses the active authorization URL', async () => {
  const completedLogin = deferred<Credential>()
  let loginCalls = 0
  const models = {
    async login(_provider: string, _type: string, interaction: AuthInteraction) {
      loginCalls += 1
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/reused' })
      return completedLogin.promise
    },
    async refresh() {
      return { aborted: false, errors: new Map() }
    },
    getModels() {
      return []
    },
  } as unknown as Pick<Models, 'getModels' | 'login' | 'refresh'>
  const manager = new CodeBuddyLoginManager(
    models,
    { replace() {} },
    { error() {}, info() {} },
    'codebuddy',
  )

  const first = await manager.start('https://www.codebuddy.ai', new AbortController().signal)
  const second = await manager.start('https://www.codebuddy.ai', new AbortController().signal)

  assert.equal(second.authorizationUrl, first.authorizationUrl)
  assert.equal(second.reused, true)
  assert.equal(loginCalls, 1)

  completedLogin.resolve(credential)
  await first.completion
})

test('cancelling a pending login aborts OAuth before logout removes credentials', async () => {
  let aborted = false
  const models = {
    async login(_provider: string, _type: string, interaction: AuthInteraction) {
      interaction.notify({ type: 'auth_url', url: 'https://auth.example/cancel' })
      await new Promise<void>((_resolve, reject) => {
        interaction.signal?.addEventListener('abort', () => {
          aborted = true
          reject(interaction.signal?.reason)
        }, { once: true })
      })
      return credential
    },
    async refresh() {
      return { aborted: false, errors: new Map() }
    },
    getModels() {
      return []
    },
  } as unknown as Pick<Models, 'getModels' | 'login' | 'refresh'>
  const manager = new CodeBuddyLoginManager(
    models,
    { replace() {} },
    { error() {}, info() {} },
    'codebuddy',
  )

  await manager.start('https://www.codebuddy.ai', new AbortController().signal)
  await manager.cancel()

  assert.equal(aborted, true)
  assert.equal(manager.pending(), undefined)
})

test('authorization result tells headless users to open the URL themselves', () => {
  const text = authorizationUrlText('https://auth.example/click-me', false)
  assert.match(text, /点击下面的链接/)
  assert.match(text, /https:\/\/auth\.example\/click-me/)
  assert.match(text, /codebuddy-status/)
})
