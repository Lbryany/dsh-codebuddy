import assert from 'node:assert/strict'
import test from 'node:test'

import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { OAuthCredential } from '@earendil-works/pi-ai'

import { DshCredentialStore } from '../src/credential-store.ts'

class FakeCredentials {
  value?: string
  async resolve() { return this.value === undefined ? undefined : { value: this.value, source: 'test' } }
  async set(_ref: string, value: string) { this.value = value }
  async unset() { this.value = undefined }
}

test('dsh credential store persists and removes a CodeBuddy OAuth credential', async () => {
  const credentials = new FakeCredentials()
  const store = new DshCredentialStore(
    credentials as unknown as CredentialProvider,
    credentialRef('CODEBUDDY_OAUTH'),
  )
  const oauth: OAuthCredential = { type: 'oauth', access: 'a', refresh: 'r', expires: 123 }

  await store.modify('codebuddy', async () => oauth)
  assert.deepEqual(await store.read('codebuddy'), oauth)
  assert.deepEqual(await store.list(), [{ providerId: 'codebuddy', type: 'oauth' }])
  await store.delete('codebuddy')
  assert.equal(await store.read('codebuddy'), undefined)
})

test('dsh credential store rejects malformed stored JSON without echoing it', async () => {
  const credentials = new FakeCredentials()
  credentials.value = 'not-secret-json'
  const store = new DshCredentialStore(
    credentials as unknown as CredentialProvider,
    credentialRef('CODEBUDDY_OAUTH'),
  )
  await assert.rejects(store.read('codebuddy'), /invalid JSON/)
})
