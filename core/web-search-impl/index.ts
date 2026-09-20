// core/web-search-impl - the `web-search@1` SERVICE HOST (provider `registry`).
//
// It owns the SEAM of the web SEARCH capability and nothing engine-specific:
//
//   Provider (THIS plugin)  ->  Definition  <-  Consumer
//   registry/host              definitions/web-search.ts   plugins/web-search-tools
//        ^
//        | registers itself (ctx['web-search'].register)
//   ENGINE plugins: core/web-search-stub, core/web-search-tavily, ...
//
// What lives here (and nowhere else, so every engine plugin stays tiny):
//   * the ENGINE REGISTRY: one entry per registered engine, duplicate ids rejected;
//   * the SELECTION policy (DSH `packages/web/web` model, MIT): an explicit
//     `engine` wins; else the configured default, then the ordered fallback
//     chain; with NOTHING configured exactly one USABLE engine is taken and
//     several usable ones are an `ambiguous` error - selection is decided at
//     CALL time, never at load time, so it cannot depend on plugin order;
//   * the RESULT BOUND: the seam, not the engine, caps the count and the inline
//     characters, RANKS the normalized hits and hands the overflow to `spill@1`
//     (never a silently dropped tail: the answer says `truncated` and carries
//     the durable path when it really wrote one);
//   * the CONFIG-GAP vocabulary: a missing/broken engine is a typed
//     `web-search.*` error naming the config row to add. An EMPTY result list
//     stays a legitimate answer of a working engine - the two are never
//     conflated.
//
// No engine module is imported: an engine plugin only has to export the object
// `definitions/web-search.ts` describes, and `npm run check:seam` enforces that
// direction. No host execution happens here (HTTP is the engine's business), so
// the manifest declares `"execution": "none"`.

import { isRecord, messageOf, positiveInt, provideService, str, type CredentialsLike, type ServiceContext } from '../../definitions/support.ts'
import { spillOf, type SpillService } from '../../definitions/spill.ts'
import {
  DEFAULT_SEARCH_COUNT,
  DEFAULT_SEARCH_MAX_CHARS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_COUNT,
  SEARCH_CONFIG_ROW,
  WEB_SEARCH,
  WebSearchError,
  capResults,
  ignoredFiltersOf,
  normalizeQuery,
  normalizeResults,
  resolveCount,
  searchSpillPayload,
} from '../../definitions/web-search.ts'
import type {
  WebSearchAnswer,
  WebSearchConfig,
  WebSearchProvider,
  WebSearchProviderInfo,
  WebSearchRequest,
  WebSearchSelection,
  WebSearchService,
} from '../../definitions/web-search.ts'

export const name = 'web-search-impl'

/** Provider id of this service host (the manifest declares it). */
export const providerId = 'registry'

/**
 * The host context of the service: the seams the host reaches LAZILY at call
 * time, so this plugin loads on its own and a call without `spill@1` still
 * answers (capped, with an explicit note) instead of failing to load.
 */
export interface WebSearchHost {
  /** The `spill@1` service, when the deployment has one. */
  spill?(): SpillService | undefined
  /** The `credentials@1` service (engines resolve their key by NAME). */
  credentials?(): CredentialsLike | undefined
  /** Clock, injectable for tests. */
  now?(): number
}

/** The normalized config of the service host. */
export interface NormalizedWebSearchConfig {
  provider?: string
  fallback: string[]
  count: number
  maxCount: number
  maxChars: number
  spill: boolean
  timeoutMs: number
}

/** Reads + bounds the config (a bad value falls back, it never throws at load). */
export function validateWebSearchConfig(config: WebSearchConfig = {}): NormalizedWebSearchConfig {
  const maxCount = positiveInt(config.maxCount, MAX_SEARCH_COUNT, 1000)
  // The caller-supplied count is capped by `maxCount`; the CONFIG default is
  // capped the same way so a config typo cannot publish more than the ceiling.
  const count = resolveCount(config.count, DEFAULT_SEARCH_COUNT, maxCount)
  const fallback = Array.isArray(config.fallback)
    ? config.fallback.map((entry) => str(entry)).filter((entry): entry is string => entry !== undefined)
    : []
  const provider = str(config.provider)
  return {
    ...(provider === undefined ? {} : { provider }),
    fallback,
    count,
    maxCount,
    maxChars: positiveInt(config.maxChars, DEFAULT_SEARCH_MAX_CHARS),
    spill: config.spill !== false,
    timeoutMs: positiveInt(config.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS),
  }
}

/** The one sentence a caller needs when nothing usable is configured. */
function gapHint(configured: string[], registered: WebSearchProviderInfo[]): string {
  const registeredText = registered.length === 0 ? 'none' : registered.map((info) => info.id).join(', ')
  return (
    `no usable search engine: configured ${configured.length === 0 ? '(none)' : configured.join(', ')}; ` +
    `registered engines ${registeredText}. Add a row to the plugins roster: ${SEARCH_CONFIG_ROW}` +
    (registered.some((info) => !info.available)
      ? ` - unavailable: ${registered
          .filter((info) => !info.available)
          .map((info) => `${info.id} (${info.reason ?? 'no reason reported'})`)
          .join('; ')}`
      : '')
  )
}

/**
 * Builds the `web-search@1` service. Everything is dependency-injected through
 * {@link WebSearchHost}, so the registry/selection/cap/spill logic is unit-tested
 * with no cordis, no network and (when asked) no spill provider at all.
 */
export function createWebSearchService(config: WebSearchConfig = {}, host: WebSearchHost = {}): WebSearchService {
  const normalized = validateWebSearchConfig(config)
  const now = host.now ?? ((): number => Date.now())
  const engines = new Map<string, WebSearchProvider>()

  const selection = (): WebSearchSelection => ({
    ...(normalized.provider === undefined ? {} : { provider: normalized.provider }),
    fallback: [...normalized.fallback],
    count: normalized.count,
    maxCount: normalized.maxCount,
    maxChars: normalized.maxChars,
    spill: normalized.spill,
    timeoutMs: normalized.timeoutMs,
  })

  const isConfigured = (id: string): boolean => id === normalized.provider || normalized.fallback.includes(id)

  const infoOf = async (provider: WebSearchProvider): Promise<WebSearchProviderInfo> => {
    let available = false
    let reason: string | undefined
    try {
      available = (await provider.available()) === true
      if (!available) reason = str(provider.unavailableReason?.())
    } catch (error) {
      available = false
      reason = `the availability check itself failed: ${messageOf(error)}`
    }
    return {
      id: provider.id,
      engine: provider.engine ?? provider.id,
      stub: provider.stub === true,
      filters: [...(provider.filters ?? [])],
      configured: isConfigured(provider.id),
      available,
      ...(reason === undefined ? {} : { reason }),
    }
  }

  const infos = async (): Promise<WebSearchProviderInfo[]> => {
    const list: WebSearchProviderInfo[] = []
    for (const provider of engines.values()) list.push(await infoOf(provider))
    list.sort((a, b) => a.id.localeCompare(b.id))
    return list
  }

  /** The engine of one call, or a typed error naming what to configure. */
  const select = async (request: WebSearchRequest): Promise<WebSearchProvider> => {
    const requested = str(request.engine)
    if (requested !== undefined) {
      const provider = engines.get(requested)
      if (provider === undefined) {
        throw new WebSearchError(
          'web-search.provider-unknown',
          `the requested engine '${requested}' is not registered (registered: ${[...engines.keys()].join(', ') || 'none'}). ${SEARCH_CONFIG_ROW}`,
          { stage: 'web-search.select', details: { engine: requested, registered: [...engines.keys()] } },
        )
      }
      const info = await infoOf(provider)
      if (!info.available) {
        throw new WebSearchError(
          'web-search.provider-unavailable',
          `the requested engine '${requested}' cannot run: ${info.reason ?? 'no reason reported'}. ${SEARCH_CONFIG_ROW}`,
          { stage: 'web-search.select', details: { engine: requested, reason: info.reason ?? null } },
        )
      }
      return provider
    }

    const configured = [normalized.provider, ...normalized.fallback].filter((id): id is string => str(id) !== undefined)
    const unavailable: string[] = []
    for (const id of configured) {
      const provider = engines.get(id)
      if (provider === undefined) {
        unavailable.push(`${id} (not registered)`)
        continue
      }
      const info = await infoOf(provider)
      if (info.available) return provider
      unavailable.push(`${id} (${info.reason ?? 'not available'})`)
    }
    if (configured.length > 0) {
      const registered = await infos()
      if (registered.some((info) => info.available)) {
        // The configured chain is dead but SOMETHING usable is registered: still
        // an explicit error, because silently switching engine would hide a
        // deliberate configuration (and report results with the wrong engine).
        throw new WebSearchError(
          'web-search.provider-unavailable',
          `the configured engine chain cannot run: ${unavailable.join('; ')}. A usable engine IS registered (${registered
            .filter((info) => info.available)
            .map((info) => info.id)
            .join(', ')}) but is not configured; pick it explicitly. ${SEARCH_CONFIG_ROW}`,
          { stage: 'web-search.select', details: { configured, unavailable } },
        )
      }
      throw new WebSearchError('web-search.not-configured', `${gapHint(configured, registered)} - the configured chain is unusable: ${unavailable.join('; ')}`, {
        stage: 'web-search.select',
        details: { configured, unavailable },
      })
    }

    const registered = await infos()
    const usable = registered.filter((info) => info.available)
    if (usable.length === 1) return engines.get(usable[0].id)!
    if (usable.length === 0) {
      throw new WebSearchError('web-search.not-configured', gapHint(configured, registered), {
        stage: 'web-search.select',
        details: { configured, registered: registered.map((info) => info.id) },
      })
    }
    throw new WebSearchError(
      'web-search.ambiguous',
      `several engines are usable (${usable.map((info) => info.id).join(', ')}) and none is configured as the default. ${SEARCH_CONFIG_ROW}`,
      { stage: 'web-search.select', details: { usable: usable.map((info) => info.id) } },
    )
  }

  /** The durable half of a capped answer: the FULL result set, or a clear note. */
  const persistOverflow = async (
    query: string,
    provider: WebSearchProvider,
    engine: string,
    tookMs: number,
    all: Awaited<ReturnType<typeof normalizeResults>>['results'],
  ): Promise<{ spillPath?: string; spillSha256?: string; spillBytes?: number; note: string }> => {
    const payload = searchSpillPayload({ query, provider: provider.id, engine, tookMs }, all)
    const spill = host.spill?.()
    if (spill === undefined) {
      return {
        note:
          'the result set was capped and spill@1 is NOT loaded, so the rest was dropped: ' +
          'enable a provider row (core/spill-local) to keep it, or raise web-search-impl.maxChars',
      }
    }
    try {
      const ref = await spill.write({ content: payload, label: 'web-search-results', extension: 'json', source: 'web-search-impl' })
      return { spillPath: ref.path, spillSha256: ref.sha256, spillBytes: ref.bytes, note: `the full result set was written to ${ref.path} (read it back in ranges with 'spill read')` }
    } catch (error) {
      return { note: `spill@1 refused the overflow (${messageOf(error)}): the rest of the result set was dropped` }
    }
  }

  const search = async (request: WebSearchRequest): Promise<WebSearchAnswer> => {
    const input = isRecord(request) ? request : ({ query: undefined } as unknown as WebSearchRequest)
    const query = normalizeQuery(input.query)
    const provider = await select(input)
    const engine = provider.engine ?? provider.id
    const count = resolveCount(input.count, normalized.count, normalized.maxCount)
    const ignored = ignoredFiltersOf(input, provider)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), normalized.timeoutMs)
    const started = now()
    let raws: readonly unknown[]
    try {
      raws = await provider.search({ ...input, query }, { count, timeoutMs: normalized.timeoutMs, signal: controller.signal })
    } catch (error) {
      if (error instanceof WebSearchError) throw error
      if (controller.signal.aborted) {
        throw new WebSearchError('web-search.timeout', `the engine '${provider.id}' did not answer within ${normalized.timeoutMs} ms`, {
          stage: 'web-search.search',
          code: 'timeout',
          details: { engine: provider.id, timeoutMs: normalized.timeoutMs },
        })
      }
      throw new WebSearchError('web-search.provider-error', `the engine '${provider.id}' failed: ${messageOf(error)}`, {
        stage: 'web-search.search',
        details: { engine: provider.id },
      })
    } finally {
      clearTimeout(timer)
    }
    const tookMs = Math.max(0, Math.round(now() - started))
    if (!Array.isArray(raws)) {
      throw new WebSearchError('web-search.bad-response', `the engine '${provider.id}' did not return a result array`, {
        stage: 'web-search.search',
        details: { engine: provider.id, received: typeof raws },
      })
    }

    // The seam owns the bound: normalize + rank, then cap the count and the
    // inline characters. Nothing is dropped without being counted and spilled.
    const normalizedHits = normalizeResults(raws, engine, normalized.maxCount)
    const window = capResults(normalizedHits.results, normalized.maxChars)
    const dropped = normalizedHits.dropped + normalizedHits.skipped + (normalizedHits.results.length - window.results.length)

    const notes: string[] = []
    if (provider.stub === true) {
      notes.push(`engine '${provider.id}' is a STUB: these are deterministic fixtures, not live web content`)
    }
    if (normalizedHits.skipped > 0) notes.push(`${normalizedHits.skipped} engine entr${normalizedHits.skipped === 1 ? 'y' : 'ies'} had no usable url/title and were skipped`)
    let spillPath: string | undefined
    let spillSha256: string | undefined
    let spillBytes: number | undefined
    if (window.truncated) {
      const persisted = await persistOverflow(query, provider, engine, tookMs, normalizedHits.results)
      spillPath = persisted.spillPath
      spillSha256 = persisted.spillSha256
      spillBytes = persisted.spillBytes
      notes.push(persisted.note)
    }
    if (ignored.length > 0) notes.push(`engine '${provider.id}' does not honour: ${ignored.join(', ')}`)
    if (notes.length === 0 && window.results.length === 0) {
      notes.push(`engine '${provider.id}' answered with 0 results for this query (a legitimate empty answer, not a configuration gap)`)
    }

    return {
      query,
      provider: provider.id,
      engine,
      stub: provider.stub === true,
      count: window.results.length,
      tookMs,
      results: window.results,
      truncated: window.truncated,
      maxChars: normalized.maxChars,
      ignoredFilters: ignored,
      dropped,
      ...(spillPath === undefined ? {} : { spillPath }),
      ...(spillSha256 === undefined ? {} : { spillSha256 }),
      ...(spillBytes === undefined ? {} : { spillBytes }),
      ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
    }
  }

  const register = (provider: WebSearchProvider): (() => void) => {
    const id = str(provider?.id)
    if (id === undefined) {
      throw new WebSearchError('web-search.invalid-input', 'a search engine provider must declare a non-empty id', { stage: 'web-search.register' })
    }
    if (typeof provider.search !== 'function' || typeof provider.available !== 'function') {
      throw new WebSearchError('web-search.invalid-input', `the provider '${id}' must implement available() and search()`, {
        stage: 'web-search.register',
        details: { provider: id },
      })
    }
    if (engines.has(id)) {
      throw new WebSearchError('web-search.duplicate-provider', `an engine with the id '${id}' is already registered; pick a unique id`, {
        stage: 'web-search.register',
        details: { provider: id },
      })
    }
    engines.set(id, provider)
    return () => {
      if (engines.get(id) === provider) engines.delete(id)
    }
  }

  return { search, providers: infos, register, selection }
}

/**
 * Registers the `web-search@1` service. The spill and credentials seams are
 * resolved LAZILY (at call time) so a deployment without `spill@1` still serves
 * capped answers and a deployment without `credentials@1` still serves engines
 * that need no key.
 */
export function apply(ctx: ServiceContext, config: WebSearchConfig = {}): void {
  provideService(
    ctx,
    WEB_SEARCH,
    createWebSearchService(config, {
      spill: () => spillOf(ctx),
      credentials: () => {
        try {
          return ctx.credentials
        } catch {
          return undefined
        }
      },
    }),
  )
}

export default { name, inject: [], apply }
