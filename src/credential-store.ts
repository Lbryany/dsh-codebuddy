import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'

export class DshCredentialStore implements CredentialStore {
  private generation = 0
  private chain: Promise<unknown> = Promise.resolve()
  private readonly credentials: CredentialProvider
  private readonly ref: CredentialRef

  constructor(credentials: CredentialProvider, ref: CredentialRef) {
    this.credentials = credentials
    this.ref = ref
  }

  async read(providerId: string): Promise<Credential | undefined> {
    if (providerId !== 'codebuddy') return undefined
    const found = await this.credentials.resolve(this.ref)
    if (found === undefined) return undefined
    try {
      return JSON.parse(found.value) as Credential
    } catch (cause) {
      throw new Error(`CodeBuddy credential stored at ${this.ref} is invalid JSON; run /codebuddy-logout and log in again`, { cause })
    }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const credential = await this.read('codebuddy')
    return credential === undefined ? [] : [{ providerId: 'codebuddy', type: credential.type }]
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    if (providerId !== 'codebuddy') return Promise.resolve(undefined)
    const generation = this.generation
    const operation = this.chain.then(async () => {
      if (generation !== this.generation) throw new Error('CodeBuddy account changed')
      const next = await fn(await this.read(providerId))
      if (generation !== this.generation) throw new Error('CodeBuddy account changed')
      if (next !== undefined) await this.credentials.set(this.ref, JSON.stringify(next))
      return next
    })
    this.chain = operation.catch(() => undefined)
    return operation
  }

  async delete(providerId: string): Promise<void> {
    if (providerId !== 'codebuddy') return
    this.invalidate()
    const operation = this.chain.then(() => this.credentials.unset(this.ref))
    this.chain = operation.catch(() => undefined)
    await operation
  }

  invalidate(): void { this.generation++ }
}
