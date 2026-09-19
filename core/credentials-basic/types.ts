// The structural CREDENTIALS contract, as published by the core
// (`docs/CREDENTIALS.md`, contract `credentials@1`).
//
// This plugin imports NOTHING from the core package: a core injects its
// `credentials` service on the context and the shapes below are what a provider
// has to honour. A provider resolves a credential NAME against its backend at
// RUNTIME - no secret value is ever part of this repository.

/** Contract version implemented (the core speaks `credentials@1`). */
export const CREDENTIALS_VERSION = 1

/** A reference to a credential: a NAME (plus an optional scope), never a value. */
export interface CredentialRef {
  name: string
  scope?: string
}

/** Reference label used in messages: `name` or `scope/name`. Never a value. */
export function refLabel(ref: CredentialRef): string {
  return ref.scope ? `${ref.scope}/${ref.name}` : ref.name
}

/** What a provider must offer (backend agnostic). */
export interface CredentialProvider {
  id: string
  version: number
  resolve(ref: CredentialRef): string | undefined | Promise<string | undefined>
  list?(): string[] | Promise<string[]>
  describe?(): string
}

/** The slice of the core service a provider registers with. */
export interface CredentialsLike {
  register(provider: CredentialProvider): () => void
}

/**
 * The slice of the host (cordis) context a provider plugin of this repository
 * uses: the injected `credentials` service and `effect` for disposal. Structural
 * on purpose - this repository does not depend on `cordis`.
 */
export interface ProviderContext {
  credentials: CredentialsLike
  effect(callback: () => () => void): void
}
