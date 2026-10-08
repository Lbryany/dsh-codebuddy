import assert from 'node:assert/strict'
import test from 'node:test'
import { createPreferences } from '../src/settings.ts'

test('settings normalize the site and verify persistence rather than reporting a no-op save', async () => {
  let value = 'global'
  const settings = createPreferences({ read: () => value, writable: () => true, write: async next => { value = next } })
  assert.equal((await settings.update({ defaultSite: 'cn' })).defaultSite, 'https://copilot.tencent.com')
  assert.equal(createPreferences({ read: () => value }).status().defaultSite, 'https://copilot.tencent.com')
  const noOp = createPreferences({ read: () => value, writable: () => true, write: async () => {} })
  await assert.rejects(noOp.update({ defaultSite: 'global' }), /保存/)
})

test('read-only settings reject changes and URLs cannot carry credentials', async () => {
  const settings = createPreferences({ read: () => 'global' })
  assert.equal(settings.status().writable, false)
  await assert.rejects(settings.update({ defaultSite: 'cn' }), /只读/)
  const writable = createPreferences({ read: () => 'global', writable: () => true, write: async () => {} })
  await assert.rejects(writable.update({ defaultSite: 'https://user:password@example.test' }), /无凭据/)
})
