// core/web-search-searxng - provider `searxng` of the `web-search@1` contract: a
// REAL search engine over HTTP that needs NO credential by default (a SearXNG
// instance answers the JSON API at GET <baseUrl>/search?format=json), with an
// OPTIONAL credential for an instance that wants a token.
//
// WHY THIS ENGINE (task thread 2560): the deployment holds NO search-engine key
// (the credential store has GITHUB_APP_KEY / HOSTINGER_EMAIL_PASSWORD /
// WBSESSION_* only, and the process environment has no *_API_KEY for a search
// vendor), so the keyed engines (Tavily, Exa, Brave, Serper) stay shipped but
// UNUSABLE until an operator adds a NAME. SearXNG is the one engine from the
// task's list that answers without a key, so the REAL path is demonstrable:
// `provider: searxng` plus a JSON-ENABLED instance as `baseUrl`. MEASURED
// 2026-09-20: every PUBLIC instance probed refuses that API (searx.be answers
// HTML, the others 429/403), so the working deployment shape is a SELF-HOSTED
// instance with the JSON API enabled. The shipped config therefore keeps
// `provider: stub` (offline, deterministic, marked `stub: true`) as the default a
// keyless deployment answers with, and `web search providers` names the row to
// flip for a real engine. This engine's own HTTP path - normalization, a filter
// reaching the query string, a status mapping to a typed error - is covered by
// the mocked-fetch tests in test/web-search.test.ts, never by a live call here.
//
// Reference: deepseek-harness `packages/web/web` (MIT) for the provider seam
// shape (cheap LOCAL availability, the seam owns the bound, a typed error per
// failure class); the cordis wiring is this repository's.
//
// It performs no host execution, so the manifest declares execution none.

import { assertPolicyDeclared, credentialsOf, isRecord, messageOf, positiveInt, serviceOf, str } from '../../definitions/support.ts'
import { WEB_SEARCH, WebSearchError, freshnessToDays } from '../../definitions/web-search.ts'
import type { CredentialsLike, ServiceContext } from '../../definitions/support.ts'
import type { SearchFilter, WebSearchCallOptions, WebSearchProvider, WebSearchRequest, WebSearchService } from '../../definitions/web-search.ts'

export const name = 'web-search-searxng'

/** The id this engine is configured and requested by. */
export const providerId = 'searxng'

/** The instance the engine queries when the config names none. */
export const DEFAULT_SEARXNG_BASE_URL = 'https://searx.be'

/**
 * The OPTIONAL credential NAME (never a value). Most SearXNG instances are
 * key-free; a protected one takes a bearer token the instance issued.
 */
export const DEFAULT_SEARXNG_CREDENTIAL = 'SEARXNG_TOKEN'

/** What this engine really honours (mapped to the instance's parameters). */
export const SEARXNG_FILTERS: readonly SearchFilter[] = ['language', 'freshness', 'safe', 'site']

/** Config of the engine (all optional). */
export interface SearxngConfig {
  /** Instance base url, e.g. `https://searx.be` (default {@link DEFAULT_SEARXNG_BASE_URL}). */
  baseUrl?: string
  /**
   * OPTIONAL credential NAME resolved through `credentials@1` and sent as a
   * bearer token. When it is set the instance is treated as protected and a
   * missing/unresolvable value makes the engine unavailable.
   */
  credential?: string
  /** Bounded deadline of one call in ms (default 15000). */
  timeoutMs?: number
  /** Hard ceiling of the `count` this engine is asked for (default 20). */
  maxResults?: number
  /** The instance's safesearch level the `safe` hint maps to (default 1 when safe=true, 0 otherwise). */
  safesearch?: number
  /** Optional SearXNG category filter, e.g. `general` (passed through verbatim). */
  categories?: string
  /** Optional comma-separated engine allow-list of the instance, e.g. `duckduckgo,brave`. */
  engines?: string
}

export interface NormalizedSearxngConfig {
  baseUrl: string
  credential?: string
  timeoutMs: number
  maxResults: number
  safesearch?: number
  categories?: string
  engines?: string
}

/** Reads the config, rejecting a base url this engine cannot call. */
export function validateSearxngConfig(config: SearxngConfig = {}): NormalizedSearxngConfig {
  const raw = str(config.baseUrl) ?? DEFAULT_SEARXNG_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new WebSearchError('web-search.invalid-input', `searxng baseUrl is not a valid url: '${raw}'`, {
      stage: 'web-search-searxng',
      code: 'invalid-input',
      details: { engine: providerId },
    })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebSearchError('web-search.invalid-input', `searxng baseUrl must be http(s): '${raw}'`, {
      stage: 'web-search-searxng',
      code: 'invalid-input',
      details: { engine: providerId },
    })
  }
  const credential = str(config.credential)
  const safesearch = config.safesearch === undefined ? undefined : positiveInt(config.safesearch, 1, 2)
  const categories = str(config.categories)
  const engines = str(config.engines)
  return {
    // The instance may be mounted under a path, so keep it minus the trailing slash.
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    ...(credential === undefined ? {} : { credential }),
    timeoutMs: positiveInt(config.timeoutMs, 15_000),
    maxResults: positiveInt(config.maxResults, 20),
    ...(safesearch === undefined ? {} : { safesearch }),
    ...(categories === undefined ? {} : { categories }),
    ...(engines === undefined ? {} : { engines }),
  }
}

/** The dependencies of the engine: injection points for tests. */
export interface SearxngDeps {
  /** The fetch to use (default `globalThis.fetch`). */
  fetchImpl?: typeof fetch
  /** The credentials service, resolved LAZILY at call time. */
  credentials?: () => CredentialsLike | undefined
}

/** Removes a resolved secret from any text this engine reports. */
export function redact(text: string, secret: string | undefined): string {
  if (secret === undefined || secret.length === 0) return text
  return text.split(secret).join('[redacted]')
}

/** The config row a deployment must edit to make this engine usable. */
function configHint(name: string): string {
  return `add the credential '${name}' to the deployment credential store (workbench-secrets/credentials.yml via credentials-basic, or the process environment), or drop 'credential' from the web-search-searxng row for a key-free instance`
}

/** SearXNG `time_range` value of a freshness window in days. */
function timeRangeOf(days: number | undefined): string | undefined {
  if (days === undefined) return undefined
  if (days <= 1) return 'day'
  if (days <= 7) return 'week'
  if (days <= 31) return 'month'
  return 'year'
}

/** JSON of a body that may not be JSON: undefined instead of a throw. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

/** The context an engine plugin needs: a cordis ctx plus the seam helpers. */
interface PluginContext extends ServiceContext {
  effect?(callback: () => () => void): unknown
}

/**
 * Builds the SearXNG engine (a plain object: the contract is structural).
 *
 * AVAILABILITY IS LOCAL: without a configured credential it is `true` (a
 * key-free instance needs no lookup) and WITH one it is a credential-store read
 * - never a network call, so `web search providers` cannot hang on an
 * unreachable instance. Network problems belong to the CALL
 * (`web-search.network` / `web-search.rate-limited`).
 */
export function createSearxngProvider(config: SearxngConfig = {}, deps: SearxngDeps = {}): WebSearchProvider {
  const normalized = validateSearxngConfig(config)
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined)
  let lastReason: string | undefined

  const resolveToken = async (): Promise<string | undefined> => {
    if (normalized.credential === undefined) {
      lastReason = undefined
      return undefined
    }
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
    engine: 'searxng',
    filters: SEARXNG_FILTERS,
    available: async (): Promise<boolean> => (normalized.credential === undefined ? true : (await resolveToken()) !== undefined),
    unavailableReason: () => lastReason,
    search: async (request: WebSearchRequest, options: WebSearchCallOptions): Promise<readonly unknown[]> => {
      const token = await resolveToken()
      if (normalized.credential !== undefined && token === undefined) {
        throw new WebSearchError('web-search.provider-unavailable', lastReason ?? `the credential '${normalized.credential}' is not available`, {
          stage: 'web-search-searxng',
          code: 'not-configured',
          details: { engine: providerId, credential: normalized.credential },
        })
      }
      if (fetchImpl === undefined) {
        throw new WebSearchError('web-search.provider-error', 'this runtime provides no fetch', {
          stage: 'web-search-searxng',
          code: 'unsupported',
          details: { engine: providerId },
        })
      }
      const query = str(request.query) ?? ''
      const site = str(request.site)
      const url = new URL(`${normalized.baseUrl}/search`)
      url.searchParams.set('q', site === undefined ? query : `${query} site:${site}`)
      url.searchParams.set('format', 'json')
      url.searchParams.set('count', String(Math.min(Math.max(positiveInt(options?.count, 1), 1), normalized.maxResults)))
      const language = str(request.language)
      if (language !== undefined) url.searchParams.set('language', language)
      const categories = normalized.categories
      if (categories !== undefined) url.searchParams.set('categories', categories)
      const engines = normalized.engines
      if (engines !== undefined) url.searchParams.set('engines', engines)
      const timeRange = timeRangeOf(freshnessToDays(request.freshness))
      if (timeRange !== undefined) url.searchParams.set('time_range', timeRange)
      const safe = typeof request.safe === 'boolean' ? request.safe : undefined
      const safesearch = normalized.safesearch ?? (safe === undefined ? undefined : safe ? 1 : 0)
      if (safesearch !== undefined) url.searchParams.set('safesearch', String(safesearch))

      const headers: Record<string, string> = {
        accept: 'application/json',
        'user-agent': 'workbench-web-search/0.1 (+searxng)',
      }
      if (token !== undefined) headers.authorization = `Bearer ${token}`

      const controller = new AbortController()
      const deadline = positiveInt(options?.timeoutMs, normalized.timeoutMs)
      const timer = setTimeout(() => controller.abort(), deadline)
      // The caller's signal (the seam deadline) still cancels this request too.
      const onAbort = (): void => controller.abort()
      options?.signal?.addEventListener('abort', onAbort)

      let response: Response
      try {
        response = await fetchImpl(url.toString(), { method: 'GET', headers, signal: controller.signal })
      } catch (error) {
        if (controller.signal.aborted) {
          throw new WebSearchError('web-search.timeout', `the searxng request exceeded ${deadline} ms`, {
            stage: 'web-search-searxng',
            code: 'timeout',
            details: { engine: providerId },
          })
        }
        throw new WebSearchError('web-search.network', `cannot reach ${normalized.baseUrl}: ${redact(messageOf(error), token)}`, {
          stage: 'web-search-searxng',
          code: 'unreachable',
          details: { engine: providerId, baseUrl: normalized.baseUrl },
        })
      } finally {
        clearTimeout(timer)
        options?.signal?.removeEventListener('abort', onAbort)
      }

      const body = await response.text().catch(() => '')
      if (!response.ok) {
        const reason =
          response.status === 429
            ? 'web-search.rate-limited'
            : response.status === 401 || response.status === 403
              ? 'web-search.auth-failed'
              : 'web-search.provider-error'
        const code = response.status === 429 ? 'unreachable' : response.status === 401 || response.status === 403 ? 'invalid-config' : 'malformed-output'
        throw new WebSearchError(
          reason,
          `the searxng instance ${normalized.baseUrl} answered HTTP ${response.status}: ` +
            `${redact(body.slice(0, 200), token)}${response.status === 403 ? ' (many instances disable the JSON API or rate-limit shared clients: point baseUrl at your own instance)' : ''}`,
          { stage: 'web-search-searxng', code, details: { engine: providerId, baseUrl: normalized.baseUrl, status: response.status } },
        )
      }
      const payload = safeJson(body)
      if (!isRecord(payload) || !Array.isArray(payload.results)) {
        throw new WebSearchError('web-search.bad-response', `the searxng instance ${normalized.baseUrl} did not answer the JSON search shape (an instance with the JSON API disabled answers HTML)`, {
          stage: 'web-search-searxng',
          code: 'malformed-output',
          details: { engine: providerId, baseUrl: normalized.baseUrl },
        })
      }
      if (payload.results.length === 0 && Array.isArray(payload.unresponsive_engines) && payload.unresponsive_engines.length > 0) {
        const dead = payload.unresponsive_engines
          .map((entry) => (Array.isArray(entry) ? `${String(entry[0])} (${String(entry[1])})` : String(entry)))
          .join('; ')
        throw new WebSearchError('web-search.provider-error', `the searxng instance ${normalized.baseUrl} returned no result because its upstream engines did not answer: ${dead}`, {
          stage: 'web-search-searxng',
          code: 'non-zero-exit',
          details: { engine: providerId, baseUrl: normalized.baseUrl, unresponsive_engines: payload.unresponsive_engines },
        })
      }
      // The hits are returned as the vendor shaped them: the SEAM normalizes
      // (title/url/snippet/published) and ranks, so engine quirks stay here.
      return payload.results
    },
  }
}

/**
 * Registers the SearXNG engine with the `web-search@1` service, deferring until
 * the service host is loaded (`ctx.inject`) so plugin order in the roster never
 * matters. The credentials seam is resolved lazily at call time.
 */
export function apply(ctx: PluginContext, config: SearxngConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'none', capabilities: [] })
  // The credentials seam is captured through a DEFERRED injection (the pattern
  // plugins/web-page uses): the engine loads in a deployment with NO credentials
  // provider at all - it then reports itself unavailable with the row to fix -
  // and picks the service up the moment it appears. A plain `ctx.credentials`
  // property access is NOT available to a plugin that did not declare
  // `credentials` in its own `inject` list (definitions/support.ts,
  // `credentialsOf`).
  let credentials: CredentialsLike | undefined
  const provider = createSearxngProvider(config, { credentials: () => credentials })
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
