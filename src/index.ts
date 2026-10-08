import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createModels } from '@earendil-works/pi-ai'
import { createCodeBuddyProvider } from './codebuddy.ts'
import { CodeBuddyAdapter } from './adapter.ts'
import { DshCredentialStore } from './credential-store.ts'
import { authorizationUrlText } from './login.ts'
import { CodeBuddyService } from './service.ts'
import { DEFAULT_SITE, PROVIDER } from './contract.ts'

export { PROVIDER } from './contract.ts'
export const name = 'llm-codebuddy'
export const inject = ['llm', 'commands', 'credentials']
export const CREDENTIAL_REF = credentialRef('CODEBUDDY_OAUTH')

export function apply(ctx: Context): void {
  const store = new DshCredentialStore(ctx.credentials, CREDENTIAL_REF)
  const models = createModels({ credentials: store })
  const installProvider = () => {
    const revision = service.revision
    models.setProvider(createCodeBuddyProvider({
      onCatalogSource: source => service.observeCatalogSource(source, revision),
    }))
  }
  const service = new CodeBuddyService({ models, store, logger: ctx.logger,
    registration: { replace: providers => registration.replace(providers) }, resetProvider: installProvider })
  installProvider()
  const registration = ctx.llm.registerAdapter([PROVIDER], new CodeBuddyAdapter(models, service.accountSignal))
  ctx.effect(() => () => service.dispose())

  ctx.commands.register({
    name: 'codebuddy-login', description: '登录 CodeBuddy 并加载可用模型', input: { hint: '[cn|global|site URL]' },
    handler: async ({ rawInput, signal }: CommandInvocation) => {
      const login = await service.start(rawInput || DEFAULT_SITE, signal)
      return { kind: 'success', text: authorizationUrlText(login.authorizationUrl, login.reused) }
    },
  })
  ctx.commands.register({
    name: 'codebuddy-status', description: '查看 CodeBuddy 登录状态和模型列表',
    handler: async () => {
      const status = await service.status()
      const pending = service.login.pending()
      if (pending) return { kind: 'success', text: pending.authorizationUrl
        ? authorizationUrlText(pending.authorizationUrl, true) : '正在生成授权链接…' }
      if (status.login.phase === 'failed') return { kind: 'error', text: 'CodeBuddy 登录失败，请重试。' }
      if (!status.account.hasCredential) return { kind: 'success', text: 'CodeBuddy 未登录。运行 /codebuddy-login cn 或 /codebuddy-login global。' }
      return { kind: 'success', text: `CodeBuddy 已保存登录状态（${status.account.site ?? '未知站点'}）。\n模型目录：${status.catalog.status}；${status.catalog.models.length} 个模型。${status.catalog.error ? '\n模型刷新失败，登录凭据已保留。' : ''}` }
    },
  })
  ctx.commands.register({
    name: 'codebuddy-logout', description: '退出 CodeBuddy 并移除本地凭据',
    handler: async () => { await service.logout(); return { kind: 'success', text: 'CodeBuddy 已退出。' } },
  })
}
