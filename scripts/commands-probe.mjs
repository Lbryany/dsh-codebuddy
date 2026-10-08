import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

export const inject = ['commands', 'agents', 'llm']
export function apply(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(() => { void run(ctx).catch(error => { console.error(error); process.exit(1) }) }, 100)
    return () => clearTimeout(timer)
  })
}
async function run(ctx) {
  assert.equal(ctx.get('connection'), undefined, 'This profile must have no Web Connection service')
  const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: process.cwd() } })
  const mounted = Date.now() + 20000
  while (!ctx.commands.list(handle.agent).some(command => command.name === 'codebuddy-status') && Date.now() < mounted) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.ok(ctx.commands.list(handle.agent).some(command => command.name === 'codebuddy-status'), 'CodeBuddy commands did not register')
  const command = async line => {
    const execution = await ctx.commands.execute(handle.agent, line, [], new AbortController().signal)
    assert.equal(execution?.result.kind, 'success', JSON.stringify(execution?.result))
    return execution.result.text
  }
  await command('/codebuddy-logout')
  assert.match(await command('/codebuddy-status'), /未登录/)
  const text = await command(`/codebuddy-login ${process.env.CODEBUDDY_MOCK_SITE}`)
  const url = text.match(/http:\/\/[^\s]+/)[0]
  await fetch(url)
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if ((await command('/codebuddy-status')).includes('已保存')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.match(await command('/codebuddy-status'), /已保存/)
  const models = await ctx.llm.listModels('codebuddy')
  assert.ok(models.length > 0)
  const chunks = []
  for await (const chunk of ctx.llm.stream({ provider: 'codebuddy', model: models[0].id, system: 'mock system prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Say hello' }] }] })) chunks.push(chunk)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text.includes('mock hello')))
  assert.ok(chunks.some(chunk => chunk.type === 'finish'))
  await command('/codebuddy-logout')
  assert.match(await command('/codebuddy-status'), /未登录/)
  await handle.dispose()
  console.log('CODEBUDDY_COMMANDS_PASS')
}
