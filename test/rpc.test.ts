import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcHandler } from '../src/rpc.ts'
import { createPreferences } from '../src/settings.ts'
import type { CodeBuddyService } from '../src/service.ts'

test('management rejects extra fields and never reflects provider exceptions', async () => {
  const service = { status: async () => { throw Error('Bearer token-do-not-leak') } } as unknown as CodeBuddyService
  const rpc = createRpcHandler({ service, preferences: createPreferences({ read: () => 'global' }) })
  const signal = new AbortController().signal
  const bad = await rpc('status', { token: 'x' }, signal)
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.error.code, 'bad-request')
  const failed = await rpc('status', {}, signal)
  assert.equal(failed.ok, false)
  assert.doesNotMatch(JSON.stringify(failed), /token-do-not-leak/)
  const unknown = await rpc('shell/run', {}, signal)
  if (!unknown.ok) assert.equal(unknown.error.code, 'not-found')
})
