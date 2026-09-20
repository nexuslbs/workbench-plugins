// core/web-search-tavily - the REAL `web-search@1` engine (provider id `tavily`).
//
// It is the HTTP engine of the capability: ONE POST to the vendor's /search
// endpoint, the raw payload normalized into the seam's hits, every HTTP failure
// turned into the typed `web-search.*` reason a caller can branch on.
//
// THE KEY IS NEVER A VALUE HERE:
//   * the config carries the credential NAME (`credential: TAVILY_API_KEY` by
//     default), never the key itself - the config file, the logs, the manifests
//     and the answers only ever hold the NAME;
//   * the value is resolved at CALL time through `credentials@1`
//     (`ctx.credentials.resolve({name})`), so the engine plugin loads fine in a
//     deployment that has no key at all - it simply reports itself
//     `available: false` with the exact row to fix;
//   * any vendor text echoed into an error is scrubbed of the key before it
//     leaves this module.
//
// AVAILABILITY IS A LOCAL CHECK (DSH `packages/web/web`, MIT): resolving the
// credential from the store is a local read, so `web search providers` is fast
// and cannot hang on an unreachable engine. Network problems belong to the CALL
// (`web-search.network`), not to availability.
//
// It performs no host execution, so the manifest declares execution none.

import { assertPolicyDeclared, credentialsOf, isRecord, messageOf, positiveInt, serviceOf, str } from '../../definitions/support.ts'
import { WEB_SEARCH, WebSearchError, freshnessToDays } from '../../definitions/web-search.ts'
import type { CredentialsLike, ServiceContext } from '../../definitions/support.ts'
import type { SearchFilter, WebSearchCallOptions, WebSearchProvider, WebSearchRequest, WebSearchService } from '../../definitions/web-search.ts'

export const name = 'web-search-tavily'

/** The id this engine is configured and requested by. */
export const providerId = 'tavily'

/** The endpoint the engine POSTs to. */
export const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com'

/** The credential NAME this engine resolves (never a value). */
export const DEFAULT_TAVILY_CREDENTIAL = 'TAVILY_API_KEY'

/** The filters this engine really honours (mapped to the vendor's parameters). */
export const TAVILY_FILTERS: readonly SearchFilter[] = ['freshness', 'site']

/** The config of the engine (all optional: the defaults are the vendor's). */
export interface TavilyConfig {
  /** Credential NAME resolved through `credentials@1` (default TAVILY_API_KEY). */
  credential?: string
  /** API base url (a test points this at a local mock server). */
  baseUrl?: string
  /** Per-request deadline in ms (the seam's own deadline still applies). */
  timeoutMs?: number
  /** Vendor search depth (`basic` is the cheap default). */
  searchDepth?: string
  /** Results requested from the engine for a call that names none (max 20). */
  maxResults?: number
}

/** The bounds of the engine config. */
export interface NormalizedTavilyConfig {
  credential: string
  baseUrl: string
  timeoutMs: number
  searchDepth: string
  maxResults: number
}

/** Reads + bounds the config (a bad value falls back, it never throws at load). */
export function validateTavilyConfig(config: TavilyConfig = {}): NormalizedTavilyConfig {
  return {
    credential: str(config.credential) ?? DEFAULT_TAVILY_CREDENTIAL,
    baseUrl: (str(config.baseUrl) ?? DEFAULT_TAVILY_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: positiveInt(config.timeoutMs, 15_000),
    searchDepth: str(config.searchDepth) ?? 'basic',
    maxResults: positiveInt(config.maxResults, 5, 20),
  }
}

/** The seams the engine reaches at call time (both optional). */
export interface TavilyDeps {
  credentials?(): CredentialsLike | undefined
  /** Injectable for tests; defaults to the runtime `fetch`. */
  fetchImpl?: typeof fetch
}

/** Scrubs a resolved key out of anything on its way to a log or an answer. */
export function redact(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text
  return text.split(secret).join('***')
}

/** The row an operator edits to make this engine work. */
function configHint(credential: string): string {
  return `add the credential '${credential}' to the credentials file the credentials@1 provider reads (config.yml -> plugins.credentials-basic.file.path) and keep the row 'web-search-tavily: { credential: ${credential} }' in the roster`
}

/** The trimmed text of a vendor error field, scrubbed and bounded. */
function vendorMessage(payload: unknown, secret: string | undefined): string | undefined {
  if (!isRecord(payload)) return undefined
  const raw = str(payload.detail) ?? str(payload.error) ?? str(payload.message)
  return raw === undefined ? undefined : redact(raw.slice(0, 200), secret)
}

/** Builds the Tavily engine (a plain object: the contract is structural). */
export function createTavilyProvider(config: TavilyConfig = {}, deps: TavilyDeps = {}): WebSearchProvider {
  const normalized = validateTavilyConfig(config)
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
  let lastReason: string | undefined

  const resolveKey = async (): Promise<string | undefined> => {
    const credentials = deps.credentials?.()
    if (credentials === undefined || typeof credentials.resolve !== 'function') {
      lastReason =
        `the credentials@1 capability is not loaded, so '${normalized.credential}' cannot be resolved: ` +
        `add a credentials provider row (credentials-basic) and ${configHint(normalized.credential)}`
      return undefined
    }
    const resolved = await credentials.resolve({ name: normalized.credential })
    const value = str(resolved?.value)
    if (value === undefined) {
      lastReason = `the credential '${normalized.credential}' did not resolve (empty or absent): ${configHint(normalized.credential)}`
      return undefined
    }
    lastReason = undefined
    return value
  }

  return {
    id: providerId,
    engine: 'tavily',
    filters: TAVILY_FILTERS,
    available: async (): Promise<boolean> => (await resolveKey()) !== undefined,
    unavailableReason: () => lastReason,
    search: async (request: WebSearchRequest, options: WebSearchCallOptions): Promise<readonly unknown[]> => {
      const key = await resolveKey()
      if (key === undefined) {
        throw new WebSearchError('web-search.provider-unavailable', lastReason ?? `the credential '${normalized.credential}' is not available`, {
          stage: 'web-search-tavily',
          details: { engine: providerId, credential: normalized.credential },
        })
      }
      if (fetchImpl === undefined) {
        throw new WebSearchError('web-search.provider-error', 'this runtime has no fetch implementation', {
          stage: 'web-search-tavily',
          details: { engine: providerId },
        })
      }

      const count = positiveInt(options?.count, normalized.maxResults, 20)
      const body: Record<string, unknown> = {
        query: String(request.query),
        max_results: count,
        search_depth: normalized.searchDepth,
        include_answer: false,
        include_raw_content: false,
      }
      const days = freshnessToDays(request.freshness)
      if (days !== undefined) body.days = days
      const site = str(request.site)
      if (site !== undefined) body.include_domains = [site]

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), positiveInt(options?.timeoutMs, normalized.timeoutMs))
      // The caller's signal (the seam deadline) still cancels this request too.
      const onAbort = (): void => controller.abort()
      options?.signal?.addEventListener('abort', onAbort)

      let response: Response
      try {
        response = await fetchImpl(`${normalized.baseUrl}/search`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new WebSearchError('web-search.timeout', `the tavily request exceeded ${positiveInt(options?.timeoutMs, normalized.timeoutMs)} ms`, {
            stage: 'web-search-tavily',
            code: 'timeout',
            details: { engine: providerId },
          })
        }
        throw new WebSearchError('web-search.network', `cannot reach ${normalized.baseUrl}: ${redact(messageOf(error), key)}`, {
          stage: 'web-search-tavily',
          code: 'unreachable',
          details: { engine: providerId, baseUrl: normalized.baseUrl },
        })
      } finally {
        clearTimeout(timer)
        options?.signal?.removeEventListener('abort', onAbort)
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        const parsed = detail.length === 0 ? undefined : safeJson(detail)
        const message = vendorMessage(parsed, key) ?? redact(detail.slice(0, 200), key)
        const reason =
          response.status === 401 || response.status === 403
            ? 'web-search.auth-failed'
            : response.status === 429
              ? 'web-search.rate-limited'
              : 'web-search.provider-error'
        throw new WebSearchError(reason, `tavily answered HTTP ${response.status}${message.length === 0 ? '' : `: ${message}`}`, {
          stage: 'web-search-tavily',
          details: { engine: providerId, status: response.status },
        })
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch (error) {
        throw new WebSearchError('web-search.bad-response', `tavily answered a body that is not JSON: ${redact(messageOf(error), key)}`, {
          stage: 'web-search-tavily',
          details: { engine: providerId },
        })
      }
      if (!isRecord(payload) || !Array.isArray(payload.results)) {
        throw new WebSearchError('web-search.bad-response', 'tavily answered without a `results` array', {
          stage: 'web-search-tavily',
          details: { engine: providerId, keys: isRecord(payload) ? Object.keys(payload) : [] },
        })
      }
      // The vendor payload is handed over RAW: the seam owns normalization and
      // ranking, so an engine change never changes what a caller receives.
      return payload.results
    },
  }
}

/** JSON of a body that may not be JSON: undefined instead of a throw. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The context an engine plugin needs: a cordis ctx plus the seam helpers. */
interface PluginContext extends ServiceContext {
  effect?(callback: () => () => void): unknown
}

/**
 * Registers the Tavily engine with the `web-search@1` service, deferring until
 * the service host is loaded (`ctx.inject`) so plugin order in the roster never
 * matters. The credentials seam is resolved lazily at call time.
 */
export function apply(ctx: PluginContext, config: TavilyConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'none', capabilities: [] })
  // The credentials seam is captured through a DEFERRED injection (the pattern
  // plugins/web-page uses): the engine still loads in a deployment with no
  // credentials provider at all - it then reports itself unavailable with the
  // row to fix - and the service is picked up the moment it appears. A plain
  // `ctx.credentials` property access is NOT available to a plugin that did not
  // declare `credentials` in its own `inject` list (definitions/support.ts,
  // `credentialsOf`).
  let credentials: CredentialsLike | undefined
  const provider = createTavilyProvider(config, { credentials: () => credentials })
  if (typeof ctx.inject === 'function') {
    ctx.inject(['credentials'], (injected) => {
      credentials = credentialsOf(injected)
    })
  }
  const attach = (target: ServiceContext): void => {
    const service = serviceOf<WebSearchService>(target, WEB_SEARCH)
    if (service === undefined) return
    ctx.effect?.(() => service.register(provider))
  }
  if (typeof ctx.inject === 'function') ctx.inject([WEB_SEARCH], (injected) => attach(injected))
  else attach(ctx)
}

export default { name, inject: [], apply }
