// Unit tests for the `web-search@1` seam: the PURE normalization/cap helpers and
// the three plugin families of the capability
//   * definitions/web-search.ts   - the contract (errors, helpers)
//   * core/web-search-impl        - the service host (registry + selection + cap + spill)
//   * core/web-search-stub        - the deterministic offline engine
//   * core/web-search-tavily      - the real HTTP engine (mocked fetch, NO network)
//   * core/web-search-searxng     - the key-free real engine (mocked fetch, NO network)
//   * plugins/web-search-tools    - the consumer tools against a fake `tools` service
//
// NOTHING here opens a socket: the real engine is exercised through an injected
// `fetchImpl`, the stub engine has no network path at all, and the spill overflow
// is a fake `spill@1` service that records what it was handed.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SEARCH_COUNT,
  MAX_SEARCH_COUNT,
  SEARCH_CONFIG_ROW,
  WEB_SEARCH,
  WEB_SEARCH_CONTRACT,
  WebSearchError,
  capResults,
  freshnessToDays,
  ignoredFiltersOf,
  isWebSearchError,
  normalizeResults,
  resolveCount,
  searchSpillPayload,
} from '../definitions/web-search.ts'
import type { WebSearchProvider, WebSearchResult } from '../definitions/web-search.ts'
import { createWebSearchService, validateWebSearchConfig } from '../core/web-search-impl/index.ts'
import { STUB_FILTERS, createStubProvider, slugOf, stubHits } from '../core/web-search-stub/index.ts'
import { DEFAULT_TAVILY_CREDENTIAL, createTavilyProvider } from '../core/web-search-tavily/index.ts'
import {
  DEFAULT_SEARXNG_BASE_URL,
  DEFAULT_SEARXNG_CREDENTIAL,
  SEARXNG_FILTERS,
  createSearxngProvider,
  validateSearxngConfig,
} from '../core/web-search-searxng/index.ts'
import * as webSearchTools from '../plugins/web-search-tools/index.ts'

// ---------------------------------------------------------------------------
// Harness: a fake `tools` service plus a structural cordis context.
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  handler: (params: Record<string, unknown>) => unknown
}

function harness(services: Record<string, unknown> = {}): {
  ctx: unknown
  tools: Map<string, ToolDef>
  unload: () => void
} {
  const tools = new Map<string, ToolDef>()
  const disposers: Array<() => void> = []
  const ctx: Record<string, unknown> = {
    // `serviceOf` resolves the capability by name at call time: the property is
    // what a bare test context exposes, `get` what the host context answers.
    ...services,
    get: (name: string) => services[name],
    tools: {
      registerTool: (def: ToolDef): (() => void) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    effect: (callback: () => () => void): void => {
      disposers.push(callback())
    },
  }
  return { ctx, tools, unload: () => disposers.splice(0).forEach((dispose) => dispose()) }
}

/** A fake `spill@1` provider that records every payload it is handed. */
function fakeSpill(writes: string[]): { write: (input: { content: string; label?: string }) => Promise<unknown> } {
  return {
    write: async (input) => {
      writes.push(input.content)
      return { path: `/tmp/spill/${writes.length}-web-search-results.json`, bytes: input.content.length, sha256: 'a'.repeat(64), preview: input.content.slice(0, 40) }
    },
  }
}

/** A stub engine whose availability the test controls, to force the fallback path. */
function deadEngine(id: string, reason = 'no credential'): WebSearchProvider {
  return {
    id,
    available: () => false,
    unavailableReason: () => reason,
    search: async () => [],
  }
}

const raws = [
  { title: 'First', url: 'https://first.example/a', content: 'one', published_date: '2026-01-02T00:00:00Z' },
  { title: 'Second', link: 'http://second.example/b', snippet: 'two' },
  { title: 'Third', href: 'https://third.example/c', description: 'three' },
  // rejected: no usable http(s) url
  { title: 'bad-url', url: 'javascript:alert(1)', snippet: 'x' },
  // rejected: no title
  { url: 'https://untitled.example/d', snippet: 'x' },
]

// ---------------------------------------------------------------------------
// The contract + the pure helpers
// ---------------------------------------------------------------------------

test('web-search: the contract ids and the defaults of the definition', () => {
  assert.equal(WEB_SEARCH, 'web-search')
  assert.equal(WEB_SEARCH_CONTRACT, 'web-search@1')
  assert.equal(DEFAULT_SEARCH_COUNT, 5)
  assert.equal(MAX_SEARCH_COUNT, 20)
  assert.ok(SEARCH_CONFIG_ROW.includes('plugins.web-search-impl'), SEARCH_CONFIG_ROW)
  assert.ok(SEARCH_CONFIG_ROW.includes('provider'), SEARCH_CONFIG_ROW)
})

test('web-search: normalizeResults ranks engine hits, keeps the engine and counts the rejects', () => {
  const normalized = normalizeResults(raws, 'unit', 10)
  assert.equal(normalized.results.length, 3)
  assert.equal(normalized.skipped, 2)
  assert.deepEqual(
    normalized.results.map((result) => [result.rank, result.title, result.engine]),
    [
      [1, 'First', 'unit'],
      [2, 'Second', 'unit'],
      [3, 'Third', 'unit'],
    ],
  )
  // every accepted alias is normalized, the engine is never dropped
  assert.equal(normalized.results[0]?.snippet, 'one')
  assert.equal(normalized.results[0]?.published, '2026-01-02T00:00:00Z')
  assert.equal(normalized.results[1]?.url, 'http://second.example/b')
  assert.equal(normalized.results[2]?.snippet, 'three')
  assert.equal(normalized.results[2]?.published, undefined)
})

test('web-search: normalizeResults honours the limit and reports what the limit dropped', () => {
  // The limit stops the scan: hits PAST it are `dropped` (never inspected), so
  // `skipped` counts only the rejects seen before the limit was reached.
  const normalized = normalizeResults(raws, 'unit', 2)
  assert.equal(normalized.results.length, 2)
  assert.equal(normalized.dropped, 3)
  assert.equal(normalized.skipped, 0)
})

test('web-search: capResults returns the window that fits and says it is not the whole list', () => {
  const all: WebSearchResult[] = Array.from({ length: 6 }, (_, index) => ({
    rank: index + 1,
    title: `result ${index + 1} with a padded title`,
    url: `https://r${index + 1}.example/page`,
    snippet: 'a snippet of a length that costs characters',
    engine: 'unit',
  }))
  const whole = capResults(all, 1_000_000)
  assert.equal(whole.truncated, false)
  assert.equal(whole.results.length, 6)

  const capped = capResults(all, 200)
  assert.equal(capped.truncated, true)
  assert.ok(capped.results.length >= 1 && capped.results.length < 6, `kept ${capped.results.length}`)
  // a cap smaller than ONE result still answers one result (a tiny cap must not
  // produce an empty list, which would be indistinguishable from "no results")
  const tiny = capResults(all, 5)
  assert.equal(tiny.results.length, 1)
  assert.equal(tiny.truncated, true)
})

test('web-search: searchSpillPayload is the WHOLE result set as readable JSON', () => {
  const all = normalizeResults(raws, 'unit', 10).results
  const payload = searchSpillPayload({ query: 'a query', provider: 'stub', engine: 'stub', tookMs: 3 }, all)
  const parsed = JSON.parse(payload) as { query: string; provider: string; engine: string; count: number; results: WebSearchResult[] }
  assert.equal(parsed.query, 'a query')
  assert.equal(parsed.provider, 'stub')
  assert.equal(parsed.engine, 'stub')
  assert.equal(parsed.count, 3)
  assert.equal(parsed.results.length, 3)
  assert.ok(payload.endsWith('\n'))
})

test('web-search: freshnessToDays and resolveCount are the bounds of a request', () => {
  assert.equal(freshnessToDays('day'), 1)
  assert.equal(freshnessToDays('week'), 7)
  assert.equal(freshnessToDays('month'), 30)
  assert.equal(freshnessToDays('year'), 365)
  assert.equal(freshnessToDays('7d'), 7)
  assert.equal(freshnessToDays(3), 3)
  assert.equal(freshnessToDays('whenever'), undefined)
  assert.equal(freshnessToDays(undefined), undefined)

  assert.equal(resolveCount(undefined, 5, 20), 5)
  assert.equal(resolveCount(3, 5, 20), 3)
  assert.equal(resolveCount(9999, 5, 20), 20)
  assert.equal(resolveCount(0, 5, 20), 5)
})

test('web-search: ignoredFiltersOf names the filters an engine cannot honour', () => {
  const stub = createStubProvider()
  assert.deepEqual(ignoredFiltersOf({ query: 'q', site: 'a.example' }, stub), [])
  assert.deepEqual(ignoredFiltersOf({ query: 'q', language: 'de', freshness: 'week', safe: true }, stub), ['language', 'freshness', 'safe'])
  assert.deepEqual([...STUB_FILTERS], ['site'])
})

// ---------------------------------------------------------------------------
// The service host: registry, selection, fallback, cap + spill
// ---------------------------------------------------------------------------

test('web-search: validateWebSearchConfig applies the documented defaults', () => {
  const config = validateWebSearchConfig({})
  assert.equal(config.count, DEFAULT_SEARCH_COUNT)
  assert.equal(config.maxCount, MAX_SEARCH_COUNT)
  assert.deepEqual(config.fallback, [])
  assert.equal(config.spill, true)
  const bounded = validateWebSearchConfig({ count: 999, maxCount: 4 })
  assert.equal(bounded.count, 4)
  assert.equal(bounded.maxCount, 4)
})

test('web-search: the stub engine is deterministic, offline and marked as a stub', async () => {
  const provider = createStubProvider({ results: 4 })
  assert.equal(provider.id, 'stub')
  assert.equal(provider.stub, true)
  assert.equal(await provider.available(), true)

  const options = { count: 4, timeoutMs: 500 }
  const first = await provider.search({ query: 'cordis plugin contract' }, options)
  const second = await provider.search({ query: 'cordis plugin contract' }, options)
  assert.deepEqual(first, second)
  assert.equal(first.length, 4)
  for (const hit of first as Array<Record<string, unknown>>) {
    assert.match(String(hit.url), /\.invalid\//, `stub url ${String(hit.url)} must be on a reserved TLD`)
  }
  // a different query is a different fixture, and the site filter narrows it
  const other = await provider.search({ query: 'another query' }, options)
  assert.notDeepEqual(other, first)
  assert.equal(slugOf('cordis plugin contract'), 'cordis-plugin-contract')
  assert.equal(stubHits('q', 2).length, 2)

  const site = (await provider.search({ query: 'cordis plugin contract', site: 'docs.example.com' }, options)) as Array<Record<string, unknown>>
  assert.ok(site.every((hit) => String(hit.url).includes('docs.example.com')), JSON.stringify(site))
})

test('web-search: search through the stub engine answers normalized results with the engine identity', async () => {
  const service = createWebSearchService({ provider: 'stub', count: 3 })
  const dispose = service.register(createStubProvider({ results: 3 }))
  const answer = await service.search({ query: 'workbench web search' })
  assert.equal(answer.provider, 'stub')
  assert.equal(answer.engine, 'stub')
  assert.equal(answer.stub, true)
  assert.equal(answer.count, 3)
  assert.equal(answer.results.length, 3)
  assert.equal(answer.truncated, false)
  assert.equal(answer.spillPath, undefined)
  assert.equal(answer.results[0]?.rank, 1)
  assert.ok(['title', 'url', 'snippet', 'engine'].every((key) => key in (answer.results[0] as object)), JSON.stringify(answer.results[0]))
  assert.equal(typeof answer.tookMs, 'number')

  const infos = await service.providers()
  assert.equal(infos.length, 1)
  assert.deepEqual(infos[0] && { id: infos[0].id, stub: infos[0].stub, configured: infos[0].configured, available: infos[0].available }, { id: 'stub', stub: true, configured: true, available: true })

  dispose()
  assert.equal((await service.providers()).length, 0)
})

test('web-search: a registered engine id cannot be reused (duplicate registration is rejected)', async () => {
  const service = createWebSearchService({ provider: 'stub' })
  service.register(createStubProvider())
  assert.throws(() => service.register(createStubProvider()), (error: unknown) => {
    assert.ok(isWebSearchError(error))
    assert.equal((error as WebSearchError).reason, 'web-search.duplicate-provider')
    return true
  })
})

test('web-search: the fallback chain answers when the configured engine cannot run', async () => {
  const service = createWebSearchService({ provider: 'weak', fallback: ['stub'], count: 2 })
  service.register(deadEngine('weak', 'the credential WEAK_API_KEY is not set'))
  service.register(createStubProvider({ results: 2 }))
  const answer = await service.search({ query: 'fallback please' })
  assert.equal(answer.provider, 'stub')
  assert.equal(answer.stub, true)
  assert.equal(answer.results.length, 2)
  const selection = service.selection()
  assert.equal(selection.provider, 'weak')
  assert.deepEqual(selection.fallback, ['stub'])
})

test('web-search: a FORCED engine ignores the chain and an unknown one is a typed error', async () => {
  const service = createWebSearchService({ provider: 'stub', fallback: [] })
  service.register(createStubProvider({ results: 1 }))
  service.register(deadEngine('weak'))

  // FORCED: the named engine is used, and when it cannot run the chain is NOT
  // consulted - the reason travels to the caller instead of a silent substitute
  await assert.rejects(service.search({ query: 'q', engine: 'weak' }), (error: unknown) => {
    const typed = error as WebSearchError
    assert.equal(typed.reason, 'web-search.provider-unavailable')
    assert.match(typed.message, /no credential/)
    return true
  })

  await assert.rejects(service.search({ query: 'q', engine: 'ghost' }), (error: unknown) => {
    assert.ok(isWebSearchError(error), String(error))
    const typed = error as WebSearchError
    assert.equal(typed.reason, 'web-search.provider-unknown')
    assert.ok(typed.message.includes('ghost'), typed.message)
    assert.ok(typed.message.includes(SEARCH_CONFIG_ROW), typed.message)
    assert.deepEqual(typed.toJSON().details.registered, ['stub', 'weak'])
    return true
  })
})

test('web-search: NO usable engine is the typed configuration gap, never an empty list', async () => {
  const empty = createWebSearchService({})
  await assert.rejects(empty.search({ query: 'anything' }), (error: unknown) => {
    assert.ok(isWebSearchError(error), String(error))
    const typed = error as WebSearchError
    assert.equal(typed.reason, 'web-search.not-configured')
    assert.ok(typed.message.includes(SEARCH_CONFIG_ROW), typed.message)
    assert.ok(typed.message.includes('registered engines none'), typed.message)
    return true
  })

  const unusable = createWebSearchService({ provider: 'tavily', fallback: [] })
  unusable.register(createTavilyProvider({}, { credentials: () => ({ resolve: async () => undefined }) }))
  await assert.rejects(unusable.search({ query: 'anything' }), (error: unknown) => {
    const typed = error as WebSearchError
    assert.equal(typed.reason, 'web-search.not-configured')
    // the message names BOTH the missing row and the credential that keeps the
    // engine unusable, so an operator can fix it without reading the code
    assert.ok(typed.message.includes(DEFAULT_TAVILY_CREDENTIAL), typed.message)
    assert.ok(typed.message.includes(SEARCH_CONFIG_ROW), typed.message)
    return true
  })
})

test('web-search: an engine that IS usable but FAILS does not silently fall through', async () => {
  const failing: WebSearchProvider = {
    id: 'failing',
    available: () => true,
    search: async () => {
      throw new WebSearchError('web-search.auth-failed', 'the engine rejected the credential', { stage: 'test', details: { engine: 'failing' } })
    },
  }
  const service = createWebSearchService({ provider: 'failing', fallback: ['stub'] })
  service.register(failing)
  service.register(createStubProvider({ results: 1 }))
  await assert.rejects(service.search({ query: 'q' }), (error: unknown) => {
    const typed = error as WebSearchError
    assert.equal(typed.reason, 'web-search.auth-failed')
    assert.equal(typed.toJSON().code, 'credential-unsupported')
    return true
  })
})

test('web-search: a capped answer spills the WHOLE result set when spill@1 is loaded', async () => {
  const writes: string[] = []
  const service = createWebSearchService({ provider: 'stub', count: 10, maxChars: 400, spill: true }, { spill: () => fakeSpill(writes) as never })
  service.register(createStubProvider({ results: 10 }))

  const answer = await service.search({ query: 'a query that needs more room than the cap allows' })
  assert.equal(answer.truncated, true)
  assert.ok(answer.results.length >= 1 && answer.results.length < 10, `inline ${answer.results.length}`)
  assert.equal(answer.dropped > 0, true)
  assert.equal(answer.spillPath, '/tmp/spill/1-web-search-results.json')
  assert.equal(answer.spillBytes, writes[0]?.length)
  assert.equal(answer.spillSha256, 'a'.repeat(64))
  assert.match(answer.note ?? '', /spill read/)

  const spilled = JSON.parse(String(writes[0])) as { count: number; results: WebSearchResult[]; provider: string; query: string }
  assert.equal(spilled.count, 10)
  assert.equal(spilled.results.length, 10)
  assert.equal(spilled.provider, 'stub')
  assert.equal(spilled.query, 'a query that needs more room than the cap allows')
  // the spill is addressed by a REAL path only, and only the inline window is
  // returned to the caller
  assert.ok(!JSON.stringify(answer).includes('spillPath": "https'), JSON.stringify(answer))
})

test('web-search: a capped answer with NO spill provider says so instead of faking a path', async () => {
  const service = createWebSearchService({ provider: 'stub', count: 10, maxChars: 400 })
  service.register(createStubProvider({ results: 10 }))
  const answer = await service.search({ query: 'a query that needs more room than the cap allows' })
  assert.equal(answer.truncated, true)
  assert.equal(answer.spillPath, undefined)
  assert.equal(answer.spillSha256, undefined)
  assert.match(answer.note ?? '', /spill@1 is NOT loaded/)
})

test('web-search: an empty result set is a real answer, the identity of the engine is kept', async () => {
  const service = createWebSearchService({ provider: 'stub' })
  service.register({ id: 'stub', stub: true, available: () => true, search: async () => [] })
  const answer = await service.search({ query: 'nothing matches this' })
  assert.equal(answer.count, 0)
  assert.deepEqual(answer.results, [])
  assert.equal(answer.provider, 'stub')
  assert.equal(answer.engine, 'stub')
  assert.equal(answer.stub, true)
  assert.equal(answer.truncated, false)
})

// ---------------------------------------------------------------------------
// The REAL engine (mocked fetch: no socket is opened)
// ---------------------------------------------------------------------------

/** A `fetch` double answering one canned response, recording every request. */
function fakeFetch(response: Response, seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
    })
    return response
  }) as unknown as typeof fetch
}

const TAVILY_KEY = 'tvly-unit-test-key-never-logged'
const TAVILY_PAYLOAD = {
  query: 'cordis plugin',
  response_time: 0.42,
  results: [
    { title: 'Cordis docs', url: 'https://cordis.example/guide', content: 'the plugin contract', published_date: '2026-02-02T00:00:00Z', score: 0.91 },
    { title: 'Workbench plugins', url: 'https://github.example/nexuslbs/workbench-plugins', content: 'the repository' },
  ],
}

test('web-search: the tavily engine normalizes a mocked vendor response and never leaks the key', async () => {
  const seen: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = []
  const provider = createTavilyProvider(
    { credential: 'TAVILY_API_KEY', baseUrl: 'https://api.tavily.test' },
    { credentials: () => ({ resolve: async (ref: { name: string }) => ({ value: ref.name === 'TAVILY_API_KEY' ? TAVILY_KEY : undefined }) }), fetchImpl: fakeFetch(Response.json(TAVILY_PAYLOAD), seen) },
  )
  assert.equal(provider.id, 'tavily')
  assert.equal(await provider.available(), true)

  const service = createWebSearchService({ provider: 'tavily' })
  service.register(provider)
  const answer = await service.search({ query: 'cordis plugin', count: 2, freshness: 'week', site: 'cordis.example' })

  assert.equal(answer.provider, 'tavily')
  assert.equal(answer.engine, 'tavily')
  assert.equal(answer.stub, false)
  assert.equal(answer.results.length, 2)
  assert.deepEqual(
    answer.results.map((result) => [result.rank, result.title, result.url, result.snippet]),
    [
      [1, 'Cordis docs', 'https://cordis.example/guide', 'the plugin contract'],
      [2, 'Workbench plugins', 'https://github.example/nexuslbs/workbench-plugins', 'the repository'],
    ],
  )
  assert.equal(answer.results[0]?.published, '2026-02-02T00:00:00Z')
  assert.deepEqual(answer.ignoredFilters, [])

  // the request really carried the query, the count, the freshness window and the
  // site restriction (the vendor vocabulary, mapped in ONE place)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.url, 'https://api.tavily.test/search')
  assert.equal(seen[0]?.body.query, 'cordis plugin')
  assert.equal(seen[0]?.body.days, 7)
  assert.deepEqual(seen[0]?.body.include_domains, ['cordis.example'])
  assert.equal(seen[0]?.headers.authorization, `Bearer ${TAVILY_KEY}`)
  assert.equal(seen[0]?.body.api_key, undefined)

  // honesty: the answer never carries the credential value
  assert.ok(!JSON.stringify(answer).includes(TAVILY_KEY), 'the answer leaked the credential')
})

test('web-search: the tavily engine maps an auth failure and a rate limit to typed reasons', async () => {
  const credentials = () => ({ resolve: async () => ({ value: TAVILY_KEY }) })

  const unauthorized = createTavilyProvider({}, { credentials, fetchImpl: fakeFetch(new Response('{"detail":"unauthorized"}', { status: 401 }), []) })
  await assert.rejects(unauthorized.search({ query: 'q' }, { count: 1, timeoutMs: 500 }), (error: unknown) => {
    const typed = error as WebSearchError
    assert.equal(typed.reason, 'web-search.auth-failed')
    assert.ok(!typed.message.includes(TAVILY_KEY), typed.message)
    return true
  })

  const limited = createTavilyProvider({}, { credentials, fetchImpl: fakeFetch(new Response('{}', { status: 429, headers: { 'retry-after': '3' } }), []) })
  await assert.rejects(limited.search({ query: 'q' }, { count: 1, timeoutMs: 500 }), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.rate-limited')
    return true
  })

  const broken = createTavilyProvider({}, { credentials, fetchImpl: fakeFetch(new Response('<html>not json</html>', { status: 200, headers: { 'content-type': 'text/html' } }), []) })
  await assert.rejects(broken.search({ query: 'q' }, { count: 1, timeoutMs: 500 }), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.bad-response')
    return true
  })
})

test('web-search: the tavily engine is unavailable WITHOUT a credential and says which name to add', async () => {
  const noStore = createTavilyProvider({}, {})
  assert.equal(await noStore.available(), false)
  assert.match(noStore.unavailableReason?.() ?? '', /credentials@1 capability is not loaded/)

  const empty = createTavilyProvider({}, { credentials: () => ({ resolve: async () => undefined }) })
  assert.equal(await empty.available(), false)
  assert.match(empty.unavailableReason?.() ?? '', new RegExp(DEFAULT_TAVILY_CREDENTIAL))

  // the availability check is LOCAL: it resolved no url and opened no socket
  assert.equal(await empty.available(), false)
})

// ---------------------------------------------------------------------------
// The consumer tools
// ---------------------------------------------------------------------------

test('web-search-tools: registers both tools and releases them on unload', () => {
  const { ctx, tools, unload } = harness({ [WEB_SEARCH]: createWebSearchService({ provider: 'stub' }) })
  webSearchTools.apply(ctx as never)
  assert.deepEqual([...tools.keys()].sort(), ['web search', 'web search providers'])
  assert.deepEqual((webSearchTools as { default: { inject?: string[] } }).default.inject, ['tools'])
  unload()
  assert.equal(tools.size, 0)
})

test('web-search-tools: `web search` answers the normalized results of the stub engine', async () => {
  const service = createWebSearchService({ provider: 'stub', count: 2 })
  service.register(createStubProvider({ results: 2 }))
  const { ctx, tools } = harness({ [WEB_SEARCH]: service })
  webSearchTools.apply(ctx as never)

  const answer = (await tools.get('web search')?.handler({ query: 'web search seam', count: 2 })) as Record<string, unknown>
  assert.equal(answer.ok, true)
  assert.equal(answer.engine, 'stub')
  assert.equal(answer.provider, 'stub')
  assert.equal(answer.stub, true)
  assert.equal(answer.count, 2)
  assert.equal(typeof answer.took_ms, 'number')
  assert.equal(answer.truncated, false)
  assert.deepEqual(answer.ignored_filters, [])
  assert.equal(answer.spill_path, undefined)
  assert.equal((answer.results as unknown[]).length, 2)
})

test('web-search-tools: `web search` returns the TYPED failure, never an empty list', async () => {
  const withService = harness({ [WEB_SEARCH]: createWebSearchService({ provider: 'stub' }) })
  webSearchTools.apply(withService.ctx as never)
  const unknownEngine = (await withService.tools.get('web search')?.handler({ query: 'q', engine: 'ghost' })) as Record<string, unknown>
  assert.equal(unknownEngine.ok, false)
  const typed = unknownEngine.error as Record<string, unknown>
  assert.equal(typed.reason, 'web-search.provider-unknown')
  assert.equal(typed.code, 'invalid-input')
  assert.ok(String(typed.hint).includes(SEARCH_CONFIG_ROW))

  // the parameter guard of the tool itself
  const badCount = (await withService.tools.get('web search')?.handler({ query: 'q', count: -3 })) as Record<string, unknown>
  assert.equal((badCount.error as Record<string, unknown>).reason, 'web-search.invalid-input')
  assert.equal(((badCount.error as Record<string, unknown>).details as Record<string, unknown>).parameter, 'count')

  // no capability loaded at all: the answer names the missing row
  const bare = harness({})
  webSearchTools.apply(bare.ctx as never)
  const missing = (await bare.tools.get('web search')?.handler({ query: 'q' })) as Record<string, unknown>
  assert.equal(missing.ok, false)
  const gap = missing.error as Record<string, unknown>
  assert.equal(gap.reason, 'web-search.missing-service')
  assert.equal(gap.code, 'missing-service')
  assert.match(String(gap.error), /web-search-impl/)
})

test('web-search-tools: `web search providers` tells a configuration gap from a zero-result query', async () => {
  const service = createWebSearchService({ provider: 'tavily', fallback: ['stub'] })
  service.register(createTavilyProvider({}, { credentials: () => ({ resolve: async () => undefined }) }))
  service.register(createStubProvider({ results: 2 }))
  const { ctx, tools } = harness({ [WEB_SEARCH]: service })
  webSearchTools.apply(ctx as never)

  const answer = (await tools.get('web search providers')?.handler({})) as Record<string, unknown>
  assert.equal(answer.ok, true)
  assert.deepEqual(answer.usable, ['stub'])
  // `providers` (and therefore `configured`) is id-SORTED, never registration or
  // chain order: introspection is deterministic for a given engine set.
  assert.deepEqual(answer.configured, ['stub', 'tavily'])
  assert.equal(answer.config_row, SEARCH_CONFIG_ROW)
  const providers = answer.providers as Array<Record<string, unknown>>
  const tavily = providers.find((info) => info.id === 'tavily')
  assert.equal(tavily?.available, false)
  assert.equal(tavily?.stub, false)
  assert.match(String(tavily?.reason), new RegExp(DEFAULT_TAVILY_CREDENTIAL))
  const selection = answer.selection as Record<string, unknown>
  assert.equal(selection.provider, 'tavily')
  assert.deepEqual(selection.fallback, ['stub'])
  assert.equal(selection.count, DEFAULT_SEARCH_COUNT)
})

// ---------------------------------------------------------------------------
// The key-free REAL engine (searxng)
// ---------------------------------------------------------------------------

/** A REPEATABLE canned fetch: it answers one body per call and records the urls. */
function cannedFetch(
  text: string,
  status = 200,
  contentType = 'application/json',
): { fetchImpl: typeof fetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = []
  const headers: Array<Record<string, string>> = []
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    urls.push(String(input))
    headers.push((init?.headers ?? {}) as Record<string, string>)
    return new Response(text, { status, headers: { 'content-type': contentType } })
  }) as typeof fetch
  return { fetchImpl, urls, headers }
}

test('web-search-searxng: an instance answer is normalized by the seam and the filters reach the query string', async () => {
  const payload = {
    results: [
      { title: 'Cordis docs', url: 'https://docs.example/cordis', content: 'the plugin runtime', publishedDate: '2026-02-03T00:00:00Z', engine: 'duckduckgo' },
      { title: 'Workbench', url: 'https://example.com/workbench', content: 'the plugin host' },
    ],
  }
  const canned = cannedFetch(JSON.stringify(payload))
  const provider = createSearxngProvider({ baseUrl: 'https://searx.example' }, { fetchImpl: canned.fetchImpl })
  assert.equal(provider.id, 'searxng')
  assert.equal(provider.engine, 'searxng')
  assert.deepEqual(provider.filters, SEARXNG_FILTERS)

  const raws = await provider.search(
    { query: 'cordis plugin', count: 2, language: 'en', freshness: 'week', safe: true, site: 'example.com' },
    { count: 2, timeoutMs: 500 },
  )
  assert.equal(raws.length, 2)
  const url = new URL(canned.urls[0]!)
  assert.equal(url.origin, 'https://searx.example')
  assert.equal(url.pathname, '/search')
  assert.equal(url.searchParams.get('format'), 'json')
  assert.equal(url.searchParams.get('q'), 'cordis plugin site:example.com')
  assert.equal(url.searchParams.get('count'), '2')
  assert.equal(url.searchParams.get('language'), 'en')
  assert.equal(url.searchParams.get('time_range'), 'week')
  assert.equal(url.searchParams.get('safesearch'), '1')
  // key-free instance: NO authorization header is sent
  assert.equal(canned.headers[0]!.authorization, undefined)

  // through the SEAM: the engine is named and the vendor fields are normalized
  const service = createWebSearchService({ provider: 'searxng' })
  service.register(provider)
  const answer = await service.search({ query: 'cordis plugin' })
  assert.equal(answer.engine, 'searxng')
  assert.equal(answer.provider, 'searxng')
  assert.equal(answer.stub, false)
  assert.equal(answer.results.length, 2)
  assert.equal(answer.results[0]!.engine, 'searxng')
  assert.equal(answer.results[0]!.snippet, 'the plugin runtime')
  assert.equal(answer.results[0]!.published, '2026-02-03T00:00:00Z')
})

test('web-search-searxng: every HTTP failure is a TYPED reason, never an empty list', async () => {
  const call = { query: 'q' }
  const options = { count: 1, timeoutMs: 500 }

  const limited = createSearxngProvider({ baseUrl: 'https://searx.example' }, { fetchImpl: cannedFetch('too many requests', 429, 'text/plain').fetchImpl })
  await assert.rejects(limited.search(call, options), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.rate-limited')
    return true
  })

  const forbidden = createSearxngProvider({ baseUrl: 'https://searx.example' }, { fetchImpl: cannedFetch('<html>json api disabled</html>', 403, 'text/html').fetchImpl })
  await assert.rejects(forbidden.search(call, options), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.auth-failed')
    assert.match((error as Error).message, /own instance/)
    return true
  })

  const html = createSearxngProvider({ baseUrl: 'https://searx.example' }, { fetchImpl: cannedFetch('<html>nope</html>', 200, 'text/html').fetchImpl })
  await assert.rejects(html.search(call, options), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.bad-response')
    return true
  })

  // 0 results whose upstream engines are ALL dead is NOT a legitimately empty answer
  const dead = createSearxngProvider(
    { baseUrl: 'https://searx.example' },
    { fetchImpl: cannedFetch(JSON.stringify({ results: [], unresponsive_engines: [['duckduckgo', 'timeout']] })).fetchImpl },
  )
  await assert.rejects(dead.search(call, options), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.provider-error')
    assert.match((error as Error).message, /duckduckgo \(timeout\)/)
    return true
  })

  // ...whereas an EMPTY result list with no dead upstream engine IS legitimate
  const empty = createSearxngProvider({ baseUrl: 'https://searx.example' }, { fetchImpl: cannedFetch(JSON.stringify({ results: [] })).fetchImpl })
  assert.deepEqual(await empty.search(call, options), [])

  // an unreachable instance is web-search.network
  const unreachable = createSearxngProvider(
    { baseUrl: 'https://searx.example' },
    { fetchImpl: (async () => { throw new Error('getaddrinfo ENOTFOUND searx.example') }) as typeof fetch },
  )
  await assert.rejects(unreachable.search(call, options), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.network')
    return true
  })
})

test('web-search-searxng: the config keeps the instance default and availability stays LOCAL', async () => {
  assert.ok(DEFAULT_SEARXNG_BASE_URL.startsWith('https://'))
  assert.equal(validateSearxngConfig({}).baseUrl, DEFAULT_SEARXNG_BASE_URL)
  assert.equal(validateSearxngConfig({ baseUrl: 'https://searx.example/' }).baseUrl, 'https://searx.example')
  assert.throws(() => validateSearxngConfig({ baseUrl: 'ftp://searx.example' }), /must be http/)

  // KEY-FREE: usable with no credential store at all, and no socket is opened
  const free = createSearxngProvider({}, {})
  assert.equal(await free.available(), true)
  assert.equal(await free.available(), true)

  // A PROTECTED instance: the NAME must resolve and the reason names it
  const protectedRow = createSearxngProvider({ credential: DEFAULT_SEARXNG_CREDENTIAL }, {})
  assert.equal(await protectedRow.available(), false)
  assert.match(protectedRow.unavailableReason?.() ?? '', /credentials@1 capability is not loaded/)
  assert.match(protectedRow.unavailableReason?.() ?? '', new RegExp(DEFAULT_SEARXNG_CREDENTIAL))
  await assert.rejects(protectedRow.search({ query: 'q' }, { count: 1, timeoutMs: 500 }), (error: unknown) => {
    assert.equal((error as WebSearchError).reason, 'web-search.provider-unavailable')
    return true
  })

  // WITH a store: usable, and the token rides in the header, never in the url
  const seenUrls: string[] = []
  const withToken = createSearxngProvider(
    { credential: DEFAULT_SEARXNG_CREDENTIAL },
    {
      credentials: () => ({ resolve: async () => ({ value: 'tok-123' }) }),
      fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seenUrls.push(String(input))
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer tok-123')
        return new Response(JSON.stringify({ results: [{ title: 't', url: 'https://t.example/a', content: 'c' }] }), { status: 200 })
      }) as typeof fetch,
    },
  )
  assert.equal(await withToken.available(), true)
  const hits = await withToken.search({ query: 'q' }, { count: 1, timeoutMs: 500 })
  assert.equal(hits.length, 1)
  assert.equal(seenUrls[0]!.includes('tok-123'), false)
})
