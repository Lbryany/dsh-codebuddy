import assert from 'node:assert/strict'
import test from 'node:test'
import { createClientState } from '../src/client-state.ts'

test('connection reset discards old account results and disposal aborts page requests', async () => {
  const pending: Array<(value: { ok: true; value: unknown }) => void> = []
  const signals: AbortSignal[] = []
  const controller = createClientState({ call: async (_channel, _endpoint, _payload, signal) => {
    signals.push(signal!)
    return new Promise(resolve => pending.push(resolve))
  } })
  const first = controller.load()
  controller.reset(false)
  for (const resolve of pending) resolve({ ok: true, value: { account: { hasCredential: true } } })
  await first
  assert.equal(controller.getSnapshot().status, undefined)
  assert.equal(signals.every(signal => signal.aborted), true)
  controller.dispose()
})

test('failed mutation remains visible after the following status read succeeds', async () => {
  const controller = createClientState({ call: async (_channel, endpoint) => endpoint.endsWith('/logout')
    ? { ok: false, error: { message: 'Unable to remove credential' } }
    : { ok: true, value: endpoint.endsWith('/status') && endpoint === 'codebuddy/status'
      ? { account: { hasCredential: true }, login: { phase: 'idle' }, catalog: { status: 'idle', models: [] } } : {} } })
  await controller.action('logout')
  assert.equal(controller.getSnapshot().error, 'Unable to remove credential')
  assert.equal(controller.getSnapshot().status?.account.hasCredential, true)
  controller.dispose()
})
