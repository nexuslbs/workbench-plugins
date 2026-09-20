// core/web-search-stub - the OFFLINE `web-search@1` engine (provider id `stub`).
//
// WHY IT EXISTS: the seam must be provable with NO network and NO credential,
// and a deployment must be able to boot a working `web search` tool before an
// operator has decided on (and paid for) a real engine. This engine answers
// DETERMINISTIC fixtures: the same query produces the same titles, urls and
// snippets, byte for byte, on any host and at any time - that is what makes the
// integration tests hermetic.
//
// HONESTY (non-negotiable): every answer carries `stub: true` and the service
// host adds "these are deterministic fixtures, not live web content" to the
// note. The urls use the RFC 6761 `.invalid` TLD, which can never resolve, so a
// stub result can never be mistaken for a fetched page. Filters the stub does
// not implement are reported as ignored by the seam, never pretended.
//
// It reaches no network and no host, so the manifest declares execution none.

import { positiveInt, str, assertPolicyDeclared, serviceOf, type ServiceContext } from '../../definitions/support.ts'
import { WebSearchError } from '../../definitions/web-search.ts'
import { WEB_SEARCH } from '../../definitions/web-search.ts'
import type { SearchFilter, WebSearchCallOptions, WebSearchProvider, WebSearchRequest, WebSearchService } from '../../definitions/web-search.ts'

export const name = 'web-search-stub'

/** The id this engine is configured and requested by. */
export const providerId = 'stub'

/** The TLD a stub url uses: RFC 6761 reserves `.invalid` - it can never resolve. */
export const STUB_TLD = 'invalid'

/** The filters this engine actually honours (`site` shapes the fixture url). */
export const STUB_FILTERS: readonly SearchFilter[] = ['site']

/** The fixed publication date every fixture carries (determinism). */
export const STUB_PUBLISHED = '2026-01-01T00:00:00.000Z'

/** The config of the stub engine. */
export interface StubConfig {
  /** Fixtures returned when the caller names no count (default 3). */
  results?: number
  /** Artificial delay of a call in ms (default 0: fast tests). */
  latencyMs?: number
  /** Take the engine offline: `available()` says so and a call fails typed. */
  unavailable?: boolean
  /** Why it is offline (shown by `web search providers`). */
  unavailableReason?: string
  /** Make a call FAIL with this `web-search.*` reason (a negative-control switch). */
  failWith?: string
}

/** The bounds of the stub config. */
export interface NormalizedStubConfig {
  results: number
  latencyMs: number
  unavailable: boolean
  unavailableReason: string
  failWith?: string
}

/** Reads + bounds the config (a bad value falls back, it never throws at load). */
export function validateStubConfig(config: StubConfig = {}): NormalizedStubConfig {
  const failWith = str(config.failWith)
  return {
    results: positiveInt(config.results, 3, 50),
    latencyMs: positiveInt(config.latencyMs, 0, 5000),
    unavailable: config.unavailable === true,
    unavailableReason: str(config.unavailableReason) ?? 'the stub engine is configured unavailable (web-search-stub: unavailable: true)',
    ...(failWith === undefined ? {} : { failWith }),
  }
}

/** A url-safe slug of the query, so the fixture url is stable for a query. */
export function slugOf(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug.length === 0 ? 'query' : slug
}

/** The deterministic fixtures of one query (the ONLY thing this engine returns). */
export function stubHits(query: string, count: number, site?: string): Array<Record<string, unknown>> {
  const host = site ?? `stub.${STUB_TLD}`
  const slug = slugOf(query)
  const hits: Array<Record<string, unknown>> = []
  for (let index = 1; index <= count; index += 1) {
    hits.push({
      title: `Stub result ${index} for "${query}"`,
      url: `https://${host}/fixtures/${slug}/result-${index}`,
      snippet:
        `Deterministic offline fixture #${index}: the workbench stub search engine answered "${query}" ` +
        'without touching the network. Set web-search-impl.provider to a real engine to get live results.',
      published: STUB_PUBLISHED,
    })
  }
  return hits
}

/** Builds the stub engine (a plain object: the contract is structural). */
export function createStubProvider(config: StubConfig = {}): WebSearchProvider {
  const normalized = validateStubConfig(config)
  return {
    id: providerId,
    engine: 'stub',
    stub: true,
    filters: STUB_FILTERS,
    available: () => !normalized.unavailable,
    unavailableReason: () => normalized.unavailableReason,
    search: async (request: WebSearchRequest, options: WebSearchCallOptions): Promise<readonly unknown[]> => {
      if (normalized.unavailable) {
        throw new WebSearchError('web-search.provider-unavailable', normalized.unavailableReason, {
          stage: 'web-search-stub',
          details: { engine: providerId },
        })
      }
      if (normalized.failWith !== undefined) {
        throw new WebSearchError(normalized.failWith as never, `the stub engine was configured to fail with '${normalized.failWith}'`, {
          stage: 'web-search-stub',
          details: { engine: providerId, configuredFailure: normalized.failWith },
        })
      }
      if (normalized.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, normalized.latencyMs))
      const count = positiveInt(options?.count, normalized.results, 50)
      return stubHits(String(request.query), count, str(request.site))
    },
  }
}

/** The context an engine plugin needs: a cordis ctx plus the definition helpers. */
interface PluginContext extends ServiceContext {
  effect?(callback: () => () => void): unknown
}

/**
 * Registers the stub engine with the `web-search@1` service. The dependency is
 * declared with `ctx.inject`, so the engine may be applied BEFORE the service
 * host and still register as soon as the service appears (and an engine applied
 * in a deployment without the host is simply inert).
 */
export function apply(ctx: PluginContext, config: StubConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'none', capabilities: [] })
  const provider = createStubProvider(config)
  const attach = (target: ServiceContext): void => {
    const service = serviceOf<WebSearchService>(target, WEB_SEARCH)
    if (service === undefined) return
    ctx.effect?.(() => service.register(provider))
  }
  if (typeof ctx.inject === 'function') ctx.inject([WEB_SEARCH], (injected) => attach(injected))
  else attach(ctx)
}

export default { name, inject: [], apply }
