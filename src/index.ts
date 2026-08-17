import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createModels } from '@earendil-works/pi-ai'
import { createCodeBuddyProvider, DEFAULT_SITE_ROOT } from './codebuddy.ts'
import { CodeBuddyAdapter } from './adapter.ts'
import { DshCredentialStore } from './credential-store.ts'
import { authorizationUrlText, CodeBuddyLoginManager } from './login.ts'

export const name = 'llm-codebuddy'
export const inject = ['llm', 'commands', 'credentials']
export const PROVIDER = 'codebuddy'
export const CREDENTIAL_REF = credentialRef('CODEBUDDY_OAUTH')

function normalizeSite(raw: string): string {
  const site = raw.trim().toLowerCase()
  if (site === '' || site === 'global' || site === 'intl') return DEFAULT_SITE_ROOT
  if (site === 'cn' || site === 'china') return 'https://copilot.tencent.com'
  const url = new URL(raw.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('site must be cn, global, or an http(s) URL')
  return url.origin
}

export function apply(ctx: Context): void {
  const store = new DshCredentialStore(ctx.credentials, CREDENTIAL_REF)
  const models = createModels({ credentials: store })
  models.setProvider(createCodeBuddyProvider())
  const registration = ctx.llm.registerAdapter([PROVIDER], new CodeBuddyAdapter(models))
  const loginManager = new CodeBuddyLoginManager(models, registration, ctx.logger, PROVIDER)

  ctx.commands.register({
    name: 'codebuddy-login',
    description: '登录 CodeBuddy 并加载可用模型',
    input: { hint: '[cn|global|site URL]' },
    handler: async ({ rawInput, signal }: CommandInvocation) => {
      const site = normalizeSite(rawInput)
      const login = await loginManager.start(site, signal)
      return {
        kind: 'success',
        text: authorizationUrlText(login.authorizationUrl, login.reused),
      }
    },
  })

  ctx.commands.register({
    name: 'codebuddy-status',
    description: '查看 CodeBuddy 登录状态和模型列表',
    handler: async ({ signal }: CommandInvocation) => {
      const pending = loginManager.pending()
      if (pending !== undefined) {
        const detail = pending.authorizationUrl === undefined
          ? 'CodeBuddy 正在生成授权链接，请稍后再次查看。'
          : authorizationUrlText(pending.authorizationUrl, true)
        return { kind: 'success', text: detail }
      }
      const credential = await store.read(PROVIDER)
      if (credential === undefined) return { kind: 'success', text: 'CodeBuddy 未登录。运行 /codebuddy-login cn 或 /codebuddy-login global。' }
      const result = await models.refresh({ allowNetwork: true, signal })
      const error = result.errors.get(PROVIDER)
      if (error !== undefined) return { kind: 'error', text: error.message }
      const available = models.getModels(PROVIDER)
      return { kind: 'success', text: `CodeBuddy 已登录，${available.length} 个模型可用：\n${available.map(model => `- ${model.name} (${model.id})`).join('\n')}` }
    },
  })

  ctx.commands.register({
    name: 'codebuddy-logout',
    description: '退出 CodeBuddy 并移除本地凭据',
    handler: async () => {
      await loginManager.cancel()
      await models.logout(PROVIDER)
      registration.replace([PROVIDER])
      return { kind: 'success', text: 'CodeBuddy 已退出。' }
    },
  })
}
