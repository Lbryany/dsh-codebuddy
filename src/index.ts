import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createModels, type AuthInteraction } from '@earendil-works/pi-ai'
import { execFile } from 'node:child_process'
import { createCodeBuddyProvider, DEFAULT_SITE_ROOT } from './codebuddy.ts'
import { CodeBuddyAdapter } from './adapter.ts'
import { DshCredentialStore } from './credential-store.ts'

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

function openExternal(url: string): void {
  const target = process.platform === 'win32'
    ? { file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] }
    : process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : { file: 'xdg-open', args: [url] }
  const child = execFile(target.file, target.args, { windowsHide: true }, () => {})
  child.unref()
}

export function apply(ctx: Context): void {
  const store = new DshCredentialStore(ctx.credentials, CREDENTIAL_REF)
  const models = createModels({ credentials: store })
  models.setProvider(createCodeBuddyProvider())
  const registration = ctx.llm.registerAdapter([PROVIDER], new CodeBuddyAdapter(models))

  ctx.commands.register({
    name: 'codebuddy-login',
    description: '登录 CodeBuddy 并加载可用模型',
    input: { hint: '[cn|global|site URL]' },
    handler: async ({ rawInput, signal }: CommandInvocation) => {
      const site = normalizeSite(rawInput)
      const interaction: AuthInteraction = {
        signal,
        prompt: async () => site,
        notify: (event) => {
          if (event.type === 'auth_url') {
            ctx.logger.info('CodeBuddy authorization URL: %s', event.url)
            openExternal(event.url)
          }
        },
      }
      const login = models.login(PROVIDER, 'oauth', interaction)
      // dsh only renders a command after it settles, so open the authorization
      // URL immediately and also log it for headless hosts.
      const credential = await login
      const refresh = await models.refresh({ allowNetwork: true, force: true, signal })
      const error = refresh.errors.get(PROVIDER)
      if (error !== undefined) throw error
      registration.replace([PROVIDER])
      const available = models.getModels(PROVIDER)
      return {
        kind: 'success',
        text: `CodeBuddy 登录成功（${String(credential.type === 'oauth' ? credential.baseUrl ?? site : site)}）\n已加载 ${available.length} 个模型：\n${available.map(model => `- ${model.name}`).join('\n')}`,
      }
    },
  })

  ctx.commands.register({
    name: 'codebuddy-status',
    description: '查看 CodeBuddy 登录状态和模型列表',
    handler: async ({ signal }: CommandInvocation) => {
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
      await models.logout(PROVIDER)
      registration.replace([PROVIDER])
      return { kind: 'success', text: 'CodeBuddy 已退出。' }
    },
  })
}
