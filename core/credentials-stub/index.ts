// External workbench plugin: a credentials SERVICE PROVIDER implemented
// entirely OUTSIDE the core repository (no core change is involved in adding
// it, and no module of the core package is imported here).
//
// The core injects its `credentials` service on the context (`ctx.credentials`);
// this plugin only registers a provider that honours the published contract:
//
//   { id, version, resolve(ref) -> value | undefined, list?(), describe?() }
//
// Contract version 1 (`credentials@1`) and the shapes above are published in the
// core's `docs/CREDENTIALS.md` and `docs/PLUGIN-CONTRACT.md`. Because the
// manifest declares the capability
//
//   "capabilities": [{ "id": "credentials", "version": 1, "provider": "stub-vault" }]
//
// the core accepts the registration: the manifest declaration is what makes a
// provider resolvable. Without it `ctx.credentials.register(...)` throws.
//
// The backend is a Vault-style HTTP endpoint (KV v2 answer shape
// `{ data: { data: { value } } }`; `{ data: { value } }` and `{ value }` are
// accepted too). A 404 means "not found" (undefined); any other failure is an
// error naming the endpoint and the reference - never the value.

export const name = 'credentials-stub'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'stub-vault'

/** Contract version implemented (the core speaks `credentials@1`). */
export const CONTRACT_VERSION = 1

export interface Config {
  /** Base URL of the Vault-style endpoint, e.g. `http://127.0.0.1:8200`. */
  url: string
  /** KV mount point (default `secret`). */
  mount?: string
  /** Token sent as the `X-Vault-Token` header. Never logged, never echoed. */
  token?: string
  /** Request timeout in milliseconds (default 5000). */
  timeoutMs?: number
}

interface CredentialRef {
  name: string
  scope?: string
}

interface CredentialsLike {
  register(provider: {
    id: string
    version: number
    describe?: () => string
    resolve: (ref: CredentialRef) => Promise<string | undefined>
  }): () => void
}

/** The slice of the core service this plugin uses (log only, no core import). */
interface WorkbenchLike {
  log(message: string): void
}

interface PluginContext {
  credentials: CredentialsLike
  workbench: WorkbenchLike
  effect(callback: () => () => void): void
}

/** Validates a CONFIGURED plugin config; the URL is the only required value. */
export function resolveConfig(raw: Partial<Config> = {}): Config {
  if (typeof raw.url !== 'string' || raw.url.length === 0) {
    throw new Error(`credentials-stub: 'url' must be a non-empty string (got ${JSON.stringify(raw.url)})`)
  }
  const config: Config = { url: raw.url }
  if (raw.mount !== undefined) config.mount = raw.mount
  if (raw.token !== undefined) config.token = raw.token
  if (raw.timeoutMs !== undefined) config.timeoutMs = raw.timeoutMs
  return config
}

/**
 * Reads the plugin config WITHOUT requiring it. `undefined` means the plugin is
 * present but NOT CONFIGURED (no `url` at all), which is a normal state and NOT
 * an error: the loader applies every DISCOVERED plugin with `{}` when the
 * config has no `plugins.<name>` row (docs/PLUGIN-CONTRACT.md, `apply()` rule 5),
 * so a plugin may never fail the load over missing optional config. A `url` that
 * IS present but invalid (not a non-empty string) stays a loud config error.
 */
export function readConfig(raw: Partial<Config> = {}): Config | undefined {
  const url = (raw as Record<string, unknown>).url
  if (url === undefined || url === null || url === '') return undefined
  return resolveConfig(raw)
}

/** Reads the value out of a Vault KV v2 answer, then the simpler shapes. */
function valueOf(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const root = payload as Record<string, unknown>
  const data = root.data
  if (typeof data === 'object' && data !== null) {
    const inner = (data as Record<string, unknown>).data
    if (typeof inner === 'object' && inner !== null) {
      const value = (inner as Record<string, unknown>).value
      if (typeof value === 'string' && value.length > 0) return value
    }
    const direct = (data as Record<string, unknown>).value
    if (typeof direct === 'string' && direct.length > 0) return direct
  }
  return typeof root.value === 'string' && root.value.length > 0 ? root.value : undefined
}

/** Builds the Vault-style provider; exported so the unit test can drive it. */
export function createProvider(config: Config) {
  const base = config.url.replace(/\/+$/, '')
  const mount = config.mount ?? 'secret'
  const timeoutMs = config.timeoutMs ?? 5000
  return {
    id: providerId,
    version: CONTRACT_VERSION,
    describe: () => `Vault-style endpoint ${base} (mount ${mount})`,
    resolve: async (ref: CredentialRef): Promise<string | undefined> => {
      const secretPath = ref.scope ? `${mount}/data/${ref.scope}/${ref.name}` : `${mount}/data/${ref.name}`
      const headers: Record<string, string> = { accept: 'application/json' }
      if (config.token !== undefined && config.token.length > 0) headers['x-vault-token'] = config.token
      const url = `${base}/v1/${secretPath}`
      let response: Response
      try {
        response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        throw new Error(
          `${providerId}: cannot reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (response.status === 404) return undefined
      if (!response.ok) throw new Error(`${providerId}: ${url} answered HTTP ${response.status}`)
      const payload: unknown = await response.json().catch(() => undefined)
      const value = valueOf(payload)
      if (value === undefined) {
        throw new Error(`${providerId}: ${url} holds no string value for '${secretPath}'`)
      }
      return value
    },
  }
}

/**
 * Applies the plugin. WITHOUT a `url` the plugin is NOT CONFIGURED - a normal
 * state, never a load failure: no provider is registered (so `stub-vault` stays
 * DECLARED by the manifest but shows `registered: false` in the credentials
 * `providers()` view) and the state is announced once through the core log.
 * With a `url` the provider is registered and answers `resolve()` as before.
 */
export function apply(ctx: PluginContext, raw: Partial<Config> = {}): void {
  const config = readConfig(raw)
  if (config === undefined) {
    ctx.workbench.log(
      "credentials-stub: not configured (no 'url' in plugins.credentials-stub) - provider 'stub-vault' is declared but not registered; set plugins.credentials-stub.url to enable it",
    )
    return
  }
  const provider = createProvider(config)
  ctx.effect(() => ctx.credentials.register(provider))
}

export default { name, inject: ['credentials', 'workbench'], apply }
