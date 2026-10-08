import assert from 'node:assert/strict'
import test from 'node:test'
import { createDefaultModel } from '../src/default-model.ts'
import type { StatusView } from '../src/contract.ts'

function fixture(noop = false) {
  let selected = { provider: 'other', model: 'old', reasoningEffort: 'low' }
  const view: StatusView = { account: { hasCredential: true }, login: { phase: 'idle' }, catalog: {
    status: 'ready', cached: false, models: [{ id: 'reasoner', name: 'Reasoner', reasoning: true, contextWindow: 1000 },
      { id: 'plain', name: 'Plain', reasoning: false, contextWindow: 1000 }],
  } }
  const service = createDefaultModel({ host: () => ({ currentSelection: () => selected,
    async saveSelection(next) { if (!noop) selected = { ...next, reasoningEffort: next.reasoningEffort! } },
  }), account: { status: async () => view, revision: 0, accountSignal: () => new AbortController().signal } })
  return { service, view }
}
test('default selection changes only on explicit save and preserves reasoning for the same model', async () => {
  const { service } = fixture()
  assert.equal(service.status().provider, 'other')
  assert.equal((await service.select({ model: 'reasoner' })).reasoningEffort, 'high')
  await service.select({ model: 'reasoner', reasoningEffort: 'max' })
  assert.equal((await service.select({ model: 'reasoner' })).reasoningEffort, 'max')
  assert.equal((await service.select({ model: 'plain' })).reasoningEffort, 'off')
  await assert.rejects(service.select({ model: 'plain', reasoningEffort: 'high' }), /推理等级/)
})
test('cached catalogs and host no-op writes cannot report a saved default', async () => {
  const { service, view } = fixture()
  view.catalog.cached = true
  await assert.rejects(service.select({ model: 'reasoner' }), /刷新模型/)
  assert.equal(service.status().provider, 'other')
  await assert.rejects(fixture(true).service.select({ model: 'reasoner' }), /未能保存/)
})
