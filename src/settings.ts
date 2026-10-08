import { DEFAULT_SITE, normalizeSite, PublicError, type PreferencesView } from './contract.ts'

interface PreferencesBackend {
  read(): string
  writable?(): boolean
  write?(site: string): Promise<void>
}

export function createPreferences(backend: PreferencesBackend) {
  const status = (): PreferencesView => ({
    defaultSite: normalizeSite(backend.read() || DEFAULT_SITE),
    writable: Boolean(backend.write && backend.writable?.()),
  })
  return {
    status,
    async update(patch: { defaultSite: string }): Promise<PreferencesView> {
      if (!status().writable) throw new PublicError('read-only', '此 DSH 配置为只读。')
      const site = normalizeSite(patch.defaultSite)
      await backend.write!(site)
      if (status().defaultSite !== site) throw new PublicError('not-saved', '配置未能保存，请检查 DSH 配置权限。')
      return status()
    },
  }
}

export type Preferences = ReturnType<typeof createPreferences>
