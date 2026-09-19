// External workbench plugin `credentials-github-app`: the GitHub App credential
// BACKEND, MOVED OUT OF THE CORE (operator rule 2026-09-19: "the core must be
// minimal" - the core keeps at most the credentials INTERFACE plus the generic
// "a resolved value becomes git auth" step, never a backend implementation).
//
// Why a plugin: minting a GitHub App installation token is a BACKEND-specific
// flow (RS256 JWT + the GitHub REST installation-token endpoint + a token
// cache). It is not config loading, source discovery, plugin install or
// `${cred:...}` resolution, so it does not belong to the kernel.
//
//   Provider  ->  Definition  <-  Consumer
//
// It CONSUMES the credentials service of the host (`ctx.credentials`): it
// registers a GIT AUTH STRATEGY for `auth.type: github-app` through
// `credentials.registerGitAuth(...)`, exactly like a transport provider
// registers its capability. The core therefore holds no JWT, no installation
// token call and no github-app branch: when it turns a resolved source
// credential into `git -c ...` arguments it asks the credentials service for a
// handler of that type and dispatches.
//
// Placement note: it deliberately declares NO capability provider id. It
// implements no `credentials@1` provider (`resolve`/`explain`/`list`): the
// VALUE of the App private key is resolved by the ordinary providers
// (`plugins/credentials-basic`: env / file / ...), and this plugin only turns
// that value into a short-lived token. A credential-dependent source therefore
// still needs a credentials provider plugin loaded, which is what the core's
// deferral gate checks - the github-app strategy is an ADD-ON, not a provider.
//
// Secret hygiene: the App private key arrives in MEMORY only (the resolved
// credential value), is never written, never logged and never returned. The
// minted installation token lives in an in-memory cache with a safety skew and
// appears only in the arguments of ONE git invocation; errors name the
// credential REFERENCE and the HTTP status, never a value.
import { createSign } from 'node:crypto'
import type { CredentialsLike, GitAuthHandler, GitAuthRequest } from '../../definitions/credentials.ts'

export const name = 'credentials-github-app'

/** Default GitHub REST API base (GitHub Enterprise overrides `apiBase`). */
export const DEFAULT_API_BASE = 'https://api.github.com'
/** Installation tokens live ~1h; refresh this long before the reported expiry. */
export const TOKEN_SKEW_MS = 5 * 60 * 1000
/** Default username of the basic auth header (GitHub wants any non-empty name). */
export const DEFAULT_USERNAME = 'x-access-token'

/** The plugin config: defaults only; the source `auth` block wins over both. */
export interface Config {
  /** GitHub REST API base (default {@link DEFAULT_API_BASE}). */
  apiBase?: string
  /** Basic-auth username (default {@link DEFAULT_USERNAME}). */
  username?: string
}

/** The slice of the hosting context this plugin needs (structural, no cordis). */
export interface CredentialsContext {
  credentials: CredentialsLike
  effect(callback: () => () => void): void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string): string {
  const body = text.replace(/\s+/g, ' ').trim()
  return body.length > 300 ? `${body.slice(0, 300)}...` : body
}

/** Strips any `"token": "..."` value out of an echoed API body. */
function redactToken(text: string): string {
  return text.replace(/("token"\s*:\s*")[^"]*(")/g, '$1<redacted>$2')
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** A string field of the source `auth` block, or undefined when absent/blank. */
function field(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** Validates a numeric GitHub id (a string would be injectable into the URL path). */
function numericId(value: unknown, fieldName: string): string {
  const text = field(value) ?? ''
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(
      `github-app: '${fieldName}' must be a numeric id (name it in the source 'auth' block); got ${JSON.stringify(value)}`,
    )
  }
  return text
}

/**
 * Builds the App JWT: RS256 over `base64url(header).base64url(claims)` with the
 * App private key. `iat` is backdated 60s (clock skew) and `exp` is +9 minutes,
 * inside GitHub's 10 minute maximum - the documented app-authentication flow.
 */
export function githubAppJwt(options: { appId: string; privateKey: string; now?: number }): string {
  const appId = numericId(options.appId, 'appId')
  const seconds = Math.floor((options.now ?? Date.now()) / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  signer.end()
  const signature = signer.sign(options.privateKey).toString('base64url')
  return `${header}.${claims}.${signature}`
}

/** In-memory installation token cache, keyed by `appId:installationId`. */
const installationTokens = new Map<string, { token: string; expiresAt: number }>()

/** Drops cached installation tokens (tests; a serve never needs it). */
export function clearInstallationTokenCache(): void {
  installationTokens.clear()
}

export interface GitHubAppTokenOptions {
  appId: string
  installationId: string
  /** The App private key (PEM) - the credential VALUE; never logged. */
  privateKey: string
  apiBase?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Mints (or reuses a cached) GitHub App installation access token:
 * RS256 JWT -> `POST /app/installations/{installation_id}/access_tokens`
 * (Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28),
 * which answers `{ "token": "ghs_...", "expires_at": "<ISO>" }`.
 */
export async function githubAppInstallationToken(
  options: GitHubAppTokenOptions,
): Promise<{ token: string; expiresAt: number }> {
  const appId = numericId(options.appId, 'appId')
  const installationId = numericId(options.installationId, 'installationId')
  const now = (options.now ?? Date.now)()
  const key = `${appId}:${installationId}`
  const cached = installationTokens.get(key)
  if (cached !== undefined && cached.expiresAt - TOKEN_SKEW_MS > now) return cached

  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const jwt = githubAppJwt({ appId, privateKey: options.privateKey, now })
  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'workbench-plugins',
      },
      body: '{}',
    })
  } catch (error) {
    throw new Error(`github-app: cannot reach ${apiBase} to mint an installation token (${message(error)})`)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `github-app: minting an installation token for app ${appId} / installation ${installationId} failed (HTTP ${response.status}): ` +
        `${truncate(redactToken(text)) || '(no body)'}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`github-app: unexpected non-JSON response from ${apiBase}: ${truncate(redactToken(text))}`)
  }
  const body = parsed as { token?: unknown; expires_at?: unknown }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error(`github-app: ${apiBase} returned no installation token (app ${appId} / installation ${installationId})`)
  }
  const parsedExpiry = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
  const entry = {
    token: body.token,
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + 50 * 60 * 1000,
  }
  installationTokens.set(key, entry)
  return entry
}

/**
 * The TRANSIENT git auth arguments: an `http.extraheader` (passed to a single
 * git invocation, never written to `.git/config`) plus an empty
 * `credential.helper`, which disables any helper git might otherwise use to
 * store or replay a credential. The token appears in the process arguments of
 * that one command only, and never in an error message (the core redacts it
 * when it reports a failing git command).
 */
export function gitAuthArgs(token: string, username: string = DEFAULT_USERNAME): string[] {
  const basic = Buffer.from(`${username}:${token}`, 'utf8').toString('base64')
  return ['-c', 'credential.helper=', '-c', `http.extraheader=Authorization: Basic ${basic}`]
}

/** The credential reference, by NAME only (never a value). */
function refLabel(request: GitAuthRequest): string {
  const scope = request.ref?.scope
  const credName = request.ref?.name ?? '(unnamed)'
  return scope === undefined ? credName : `${scope}/${credName}`
}

/**
 * Builds the `auth.type: github-app` git auth strategy: the resolved credential
 * value is the App PRIVATE KEY (PEM), the other fields come from the source
 * `auth` block (the plugin config only supplies defaults).
 */
export function createGitAuthHandler(config: Config = {}): GitAuthHandler {
  return {
    type: 'github-app',
    async args(request: GitAuthRequest): Promise<string[]> {
      const auth = (request.auth ?? {}) as Record<string, unknown>
      const label = refLabel(request)
      const appId = field(auth.appId)
      const installationId = field(auth.installationId)
      if (appId === undefined || installationId === undefined) {
        throw new Error(
          `github-app: credential '${label}' needs both 'appId' and 'installationId' in the source 'auth' block ` +
            `(got appId=${JSON.stringify(auth.appId)}, installationId=${JSON.stringify(auth.installationId)})`,
        )
      }
      const minted = await githubAppInstallationToken({
        appId,
        installationId,
        privateKey: request.value,
        apiBase: field(auth.apiBase) ?? config.apiBase ?? DEFAULT_API_BASE,
      })
      return gitAuthArgs(minted.token, field(auth.username) ?? config.username ?? DEFAULT_USERNAME)
    },
  }
}

/**
 * Registers the `github-app` git auth strategy on the host's credentials
 * service. Without the host offering `registerGitAuth` the plugin reports a
 * loud, structured error instead of silently doing nothing.
 */
export function apply(ctx: CredentialsContext, config: Config = {}): void {
  if (typeof ctx.credentials?.registerGitAuth !== 'function') {
    throw new Error(
      "credentials-github-app: the host's credentials service does not offer registerGitAuth(); a source with " +
        "'auth.type: github-app' cannot be served by this core version",
    )
  }
  ctx.effect(() => ctx.credentials.registerGitAuth!(createGitAuthHandler(config)))
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin
