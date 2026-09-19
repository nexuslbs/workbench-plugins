// `web-page`: the cheap single-shot READ path for a JavaScript-rendered page.
//
// ONE small tool surface, no browser driver: `page read` renders a URL in
// chromium, distils the page to compact markdown in CODE (never pasting HTML
// into a caller's context), caps the result and spills the rest to a file, and
// answers `unchanged since <hash>` on a repeat visit. `page map` returns just
// the outline (headings, sections, links) so a caller can pick a slice cheaply.
//
// It is a CONSUMER plugin: it imports nothing from the core and nothing from a
// provider, and touches only `ctx.workbench.registerTool` (tools seam) plus
// `ctx.credentials` (a credential NAME for a proxy is resolved at call time and
// never logged). Omniagent, the core, and any model are NOT in the loop: one
// call in, markdown out.
import { PageCache, ageSeconds, cacheKey, contentHash, unchangedAnswer } from './cache.ts'
import type { CacheDecision, CacheEntry, Freshness } from './cache.ts'
import { resolveConfig, str } from './config.ts'
import type { WebPageConfig } from './config.ts'
import { apiOf, cssSelectorsOf, readViaApi, recipeSelectorEntries, recipeServiceOf } from './recipe.ts'
import type { RecipeLike, RecipeServiceLike } from './recipe.ts'
import { PageError } from './errors.ts'
import { extractMain, parseSelector, renderOutline, sliceByQuery } from './extract.ts'
import { BrowserPoolRenderer } from './render.ts'
import type { Renderer } from './render.ts'
import { capText, estimateTokens } from './spill.ts'

export const name = 'web-page'

export type { WebPageConfig }

interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
  items?: ToolParameter
}

type ToolParameters = Record<string, ToolParameter>

interface WorkbenchLike {
  registerTool(def: {
    name: string
    description?: string
    parameters?: ToolParameters
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  }): () => void
}

interface CredentialsLike {
  resolve(ref: { name: string }): Promise<{ value: string } | undefined>
}

interface PluginContext {
  workbench: WorkbenchLike
  credentials?: CredentialsLike
  effect(callback: () => () => void): void
  /**
   * cordis deferred injection: the callback runs when the named service shows
   * up and NEVER when it does not - which is exactly the recipe seam (a
   * deployment without plugins/web-recipe keeps working unchanged).
   */
  inject?(deps: string[], callback: (ctx: unknown) => void): unknown
}

/** Optional collaborators, so the pipeline can be tested without a browser. */
export interface WebPageDeps {
  renderer?: Renderer
  /** Test seam: a fetch replacement for the recipe API reads. */
  fetchImpl?: typeof fetch
}

type CacheState = CacheDecision | 'revalidated'

/**
 * The plugin entry. `deps` is a test seam (the core calls `apply(ctx, config)`);
 * without it the plugin builds its own pooled chromium renderer, lazily.
 */
export function apply(ctx: PluginContext, config: WebPageConfig = {}, deps: WebPageDeps = {}): void {
  const resolved = resolveConfig(config)
  const cache = new PageCache(resolved.cacheDir, resolved.cacheTtlSeconds)
  const recipes = resolved.recipes
  // The recipe READ-THROUGH seam: plugins/web-recipe PROVIDES the service
  // `web-recipe`; this consumer looks it up by NAME through cordis' deferred
  // injection (never an import of that plugin, never a reach into its files).
  // The ROOT context is never probed for 'web-recipe': cordis refuses a
  // property access on a service the plugin did not declare in `inject`, and
  // declaring it would make web-page REQUIRE the store (a deployment without
  // plugins/web-recipe must keep working). `ctx.inject` is the deferred,
  // optional form: the callback runs when the service appears - whatever the
  // load order - and never when it does not.
  let recipeService: RecipeServiceLike | undefined
  ctx.inject?.(['web-recipe'], (injected) => {
    recipeService = recipeServiceOf(injected)
  })
  const renderer =
    deps.renderer ??
    new BrowserPoolRenderer(resolved, async (credentialName) => {
      const credentials = ctx.credentials
      if (credentials === undefined) return undefined
      const resolution = await credentials.resolve({ name: credentialName })
      return resolution === undefined ? undefined : resolution.value
    })

  // The browser is a resource: closing the plugin closes it. `BrowserPoolRenderer`
  // launches chromium LAZILY, so a plugin that is loaded but never called starts
  // no browser at all.
  ctx.effect(() => () => {
    void renderer.dispose()
  })

  /**
   * The recipe service of THIS deployment. Only the injected scope above can
   * resolve it (`recipeServiceOf(ctx)` on the root context would throw
   * 'without inject'); the holder is set by the deferred injection, so the
   * load order of web-recipe and web-page is irrelevant.
   */
  function recipeServiceNow(): RecipeServiceLike | undefined {
    return recipeService
  }

  /** The stored recipe of a URL's domain, when it exists and is usable. */
  async function lookupRecipe(url: string): Promise<{ domain: string; recipe: RecipeLike } | undefined> {
    const service = recipeServiceNow()
    if (service === undefined) return undefined
    try {
      const hit = await service.lookup(url)
      if (hit === undefined || !hit.usable) return undefined
      return { domain: hit.domain, recipe: hit.recipe }
    } catch {
      return undefined
    }
  }

  /** Tell the store how a recipe-driven read went (this drives freshness decay). */
  async function markRecipe(domain: string, ok: boolean, detail?: string): Promise<void> {
    const service = recipeServiceNow()
    if (service === undefined) return
    try {
      await service.markVerified(domain, ok, detail)
    } catch {
      // provenance bookkeeping never fails a read
    }
  }

  /** Write a discovered read path back to the store; OFF unless `recipes.record: true`. */
  async function recordDiscovery(url: string, selectors: string[] | undefined): Promise<string | undefined> {
    const service = recipeServiceNow()
    if (service === undefined) return undefined
    try {
      const entries = recipeSelectorEntries(selectors)
      const result = await service.record({
        url,
        readPath: selectors === undefined ? { kind: 'render', url } : { kind: 'render', url, selectors },
        ...(entries === undefined ? {} : { selectors: entries }),
        discoveredBy: 'web-page',
        ...(recipes.sourceThread === undefined ? {} : { sourceThread: recipes.sourceThread }),
      })
      return result.status
    } catch {
      return undefined
    }
  }

  async function readPageInner(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = requireUrl(params.url, 'url')
    const requested = selectorList(params.selectors)
    const query = str(params.query)
    const maxChars = clampChars(params.max_chars, resolved.maxChars, resolved.hardMaxChars)
    const freshness = freshnessOf(params.freshness)

    // The read-through comes FIRST: a usable recipe for the domain is used
    // instead of re-deriving extraction. An explicit caller parameter always
    // wins (`selectors` beats the stored ones, `recipe: "off"` disables the
    // lookup entirely).
    const stored = params.recipe !== 'off' && recipes.enabled && requested === undefined ? await lookupRecipe(url) : undefined
    const recipeSelectors = stored === undefined ? undefined : cssSelectorsOf(stored.recipe)
    let recipeNote: Record<string, unknown> | undefined
  // Set when the recipe's own path failed (API error, or recipe selectors that
  // matched nothing): the fallback must then be the PLAIN path, never the failed
  // recipe's own selectors, and the fallback must NOT re-verify the recipe.
  let recipePathFailed = false

    if (stored !== undefined) {
      const api = apiOf(stored.recipe)
      if (api !== undefined) {
        try {
          const credentialResolver =
            ctx.credentials === undefined
              ? undefined
              : async (name: string) => {
                  const resolution = await ctx.credentials?.resolve({ name })
                  return resolution === undefined ? undefined : resolution.value
                }
          const viaApi = await readViaApi(stored.recipe, {
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            timeoutMs: resolved.navigationTimeoutMs,
            ...(credentialResolver === undefined ? {} : { resolveCredential: credentialResolver }),
          })
          await markRecipe(stored.domain, true)
          const source = query === undefined ? viaApi.text : sliceByQuery(viaApi.text, query, maxChars).markdown
          const capped = await capText(source, maxChars, resolved.spillDir, `${hostOf(url)}-recipe`)
          return {
            status: 'recipe',
            url,
            domain: stored.domain,
            via: 'api',
            api: api.name,
            endpoint: viaApi.url,
            httpStatus: viaApi.status,
            chars: capped.shownChars,
            estimatedTokens: capped.estimatedTokens,
            markdown: capped.text,
            truncation: capped.capped ? { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } : undefined,
            ...(viaApi.data === undefined ? {} : { data: viaApi.data }),
            recipe: {
              domain: stored.domain,
              confidence: stored.recipe.provenance?.confidence ?? null,
              verified: true,
              // The recipe named a credential this deployment could not resolve:
              // the read went out unauthenticated (and answered).
              ...(viaApi.credentialMissing === undefined ? {} : { credentialMissing: viaApi.credentialMissing }),
            },
            // no `render` block on purpose: no browser ran for this read
          }
        } catch (error) {
          const scrubbed = scrubError(error)
          const detail = scrubbed instanceof Error ? scrubbed.message : String(scrubbed)
          await markRecipe(stored.domain, false, detail)
          // A stale recipe never poisons a read: fall back to the PLAIN render
          // path. The recipe's OWN selectors are dropped - they are part of the
          // path that just failed and must not be able to fail the read again.
          recipePathFailed = true
          recipeNote = { domain: stored.domain, via: 'api', status: 'failed', detail, fallback: 'render' }
        }
      }
    }

    let selectors = requested ?? (recipePathFailed ? undefined : recipeSelectors)
    const key = cacheKey(url, selectors)
    const cached = await cache.read(key)
    const decision = cache.decide(cached, freshness)

    // 1) Fresh cache entry: the ~20 token answer, or the requested SLICE of it.
    //    Both are served straight from the cache - a `query` is not a reason to
    //    launch a browser for a page the plugin already has (freshness decides
    //    cache use, and `revalidate` never takes this path).
    if (decision === 'hit' && cached !== undefined) {
      if (query === undefined) return unchangedAnswer(cached, 'hit', ageSeconds(cached))
      return await answerFrom(cached, { query, maxChars, state: 'hit', ageSeconds: ageSeconds(cached) })
    }

    // 2) Conditional revalidation first (a plain HTTP request, no browser): a
    //    304 proves the page did not change, so the browser is never launched.
    const state: CacheState = decision === 'revalidate' ? 'revalidated' : 'render'
    if (decision === 'revalidate' && cache.canRevalidate(cached) && cached !== undefined) {
      const revalidated = await revalidateHttp(url, cached)
      if (revalidated === 'not-modified') {
        const refreshed: CacheEntry = { ...cached, fetchedAt: new Date().toISOString() }
        await cache.write(refreshed)
        if (query === undefined) return unchangedAnswer(refreshed, 'revalidated', 0)
        return await answerFrom(refreshed, { query, maxChars, state, ageSeconds: 0 })
      }
      // 200/other -> cannot prove freshness, fall through to a render.
    }

    // 3) Render + extract, then either the new body or `unchanged since <hash>`.
    let rendered = await renderer.render({ url, selectors })
    let extraction = extractMain(rendered.html, { url: rendered.finalUrl, selectors })
    // A recipe-driven RENDER read that matches nothing must not poison the read
    // either: drop the recipe's selectors, render the plain page once, and tell
    // the store (which demotes the recipe, so it stops being offered).
    if (extraction.markdown.trim().length === 0 && selectors !== undefined && selectors === recipeSelectors && stored !== undefined) {
      await markRecipe(stored.domain, false, 'the recipe selectors matched nothing')
      recipePathFailed = true
      recipeNote = { domain: stored.domain, via: 'render', status: 'failed', detail: 'the recipe selectors matched nothing', fallback: 'render' }
      selectors = undefined
      rendered = await renderer.render({ url })
      extraction = extractMain(rendered.html, { url: rendered.finalUrl })
    }
    if (extraction.markdown.trim().length === 0) {
      throw new PageError('extract_empty', 'the rendered page produced no readable text', {
        url,
        hint: 'the page may require a login or render only media (a session-carrying read is the web-session task)',
      })
    }
    // Only a read that the RECIPE's own path produced may verify it: a fallback
    // after a failure (or a dropped recipe selector) must never flip the recipe
    // back to 'ok' - the store would then keep offering a path that just failed.
    if (stored !== undefined && recipeSelectors !== undefined && !recipePathFailed) await markRecipe(stored.domain, true)
    const hash = contentHash(extraction.markdown)
    const fetchedAt = new Date().toISOString()
    if (cached !== undefined && freshness !== 'force' && cached.hash === hash) {
      const refreshed: CacheEntry = {
        ...cached,
        fetchedAt,
        etag: rendered.etag ?? cached.etag,
        lastModified: rendered.lastModified ?? cached.lastModified,
        finalUrl: rendered.finalUrl,
      }
      await cache.write(refreshed)
      if (query === undefined) return unchangedAnswer(refreshed, state, 0)
      return await answerFrom(refreshed, { query, maxChars, state, ageSeconds: 0 })
    }
    const entry: CacheEntry = {
      key,
      url,
      finalUrl: rendered.finalUrl,
      title: extraction.title,
      markdown: extraction.markdown,
      hash,
      chars: extraction.chars,
      outline: extraction.outline,
      status: rendered.status,
      fetchedAt,
      ...(selectors === undefined ? {} : { selectors }),
      ...(rendered.etag === undefined ? {} : { etag: rendered.etag }),
      ...(rendered.lastModified === undefined ? {} : { lastModified: rendered.lastModified }),
    }
    await cache.write(entry)
    const answer = await answerFrom(entry, { query, maxChars, state, ageSeconds: 0 })
    // The record gate: a read that did NOT come from a recipe is a discovery,
    // and only `recipes.record: true` writes it back (default off).
    const recorded = stored === undefined && recipes.record ? await recordDiscovery(url, requested) : undefined
    return {
      ...answer,
      ...(recipeNote === undefined ? {} : { recipe: recipeNote }),
      ...(recorded === undefined ? {} : { discovered: { recipe: recorded } }),
      render: { attempts: rendered.attempts, elapsedMs: rendered.elapsedMs },
    }
  }

  async function mapPageInner(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = requireUrl(params.url, 'url')
    const maxChars = clampChars(params.max_chars, resolved.mapMaxChars, resolved.hardMaxChars)
    const key = cacheKey(url)
    const cached = await cache.read(key)
    if (cached !== undefined && cache.decide(cached, 'cache') === 'hit') {
      const capped = await capText(renderOutline(cached.outline), maxChars, resolved.spillDir, `${hostOf(url)}-map`)
      return {
        status: 'map',
        url,
        finalUrl: cached.finalUrl,
        title: cached.title,
        hash: cached.hash,
        chars: capped.shownChars,
        estimatedTokens: capped.estimatedTokens,
        markdown: capped.text,
        truncation: capped.capped ? { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } : undefined,
        counts: outlineCounts(cached.outline),
        cache: { state: 'hit', ageSeconds: ageSeconds(cached) },
      }
    }
    const rendered = await renderer.render({ url })
    const extraction = extractMain(rendered.html, { url: rendered.finalUrl })
    if (extraction.markdown.trim().length === 0) {
      throw new PageError('extract_empty', 'the rendered page produced no readable text', { url, hint: 'nothing to outline' })
    }
    const entry: CacheEntry = {
      key,
      url,
      finalUrl: rendered.finalUrl,
      title: extraction.title,
      markdown: extraction.markdown,
      hash: contentHash(extraction.markdown),
      chars: extraction.chars,
      outline: extraction.outline,
      status: rendered.status,
      fetchedAt: new Date().toISOString(),
      ...(rendered.etag === undefined ? {} : { etag: rendered.etag }),
      ...(rendered.lastModified === undefined ? {} : { lastModified: rendered.lastModified }),
    }
    await cache.write(entry)
    const capped = await capText(renderOutline(entry.outline), maxChars, resolved.spillDir, `${hostOf(url)}-map`)
    return {
      status: 'map',
      url,
      finalUrl: entry.finalUrl,
      title: entry.title,
      hash: entry.hash,
      chars: capped.shownChars,
      estimatedTokens: capped.estimatedTokens,
      markdown: capped.text,
      truncation: capped.capped ? { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } : undefined,
      counts: outlineCounts(entry.outline),
      cache: { state: 'miss', ageSeconds: 0 },
      render: { attempts: rendered.attempts, elapsedMs: rendered.elapsedMs },
    }
  }

  /** Body (optionally sliced by `query`) capped by `maxChars`, from a cache entry. */
  async function answerFrom(
    entry: CacheEntry,
    options: { query: string | undefined; maxChars: number; state: CacheState; ageSeconds: number },
  ): Promise<Record<string, unknown>> {
    const source = options.query === undefined ? entry.markdown : sliceByQuery(entry.markdown, options.query, options.maxChars).markdown
    const capped = await capText(source, options.maxChars, resolved.spillDir, hostOf(entry.url))
    const slice = options.query === undefined ? undefined : sliceByQuery(entry.markdown, options.query, options.maxChars)
    return {
      status: 'rendered',
      url: entry.url,
      finalUrl: entry.finalUrl,
      title: entry.title,
      hash: entry.hash,
      chars: capped.shownChars,
      estimatedTokens: capped.estimatedTokens,
      markdown: capped.text,
      truncation: capped.capped ? { capped: true, shownChars: capped.shownChars, totalChars: capped.totalChars, spillFile: capped.spillFile } : undefined,
      query: slice === undefined ? undefined : { terms: slice.terms, blocks: slice.matched, matchedChars: slice.chars },
      cache: { state: options.state, ageSeconds: options.ageSeconds },
    }
  }

  /**
   * A failure that leaves through a tool is a `PageError`: the `redact` strings
   * of the config are scrubbed from its message, url and detail before it is
   * rethrown, so a configured secret never reaches a caller.
   */
  function scrubError(error: unknown): unknown {
    return error instanceof PageError ? error.withRedaction(resolved.redact) : error
  }

  /** `page read`, with the `redact` config applied to any named failure. */
  async function readPage(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await readPageInner(params)
    } catch (error) {
      throw scrubError(error)
    }
  }

  /** `page map`, with the `redact` config applied to any named failure. */
  async function mapPage(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return await mapPageInner(params)
    } catch (error) {
      throw scrubError(error)
    }
  }

  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'page read',
      description:
        'reads ONE web page that needs JavaScript, in a single call: renders it in chromium, returns compact markdown of the main content (no HTML, no browser in the caller loop), capped with spill to a file, cached by URL with a content hash so an unchanged page answers "unchanged since <hash>" in a few tokens',
      parameters: {
        url: { type: 'string', description: 'absolute http(s) URL of the page to read', required: true },
        query: { type: 'string', description: 'return only the blocks matching these terms (deterministic slicing, keeps heading context)' },
        selectors: {
          type: 'array',
          items: { type: 'string', description: "a CSS scope: 'main', '.article-body', '#content'" },
          description: 'restrict extraction to these CSS scopes (they take part in the cache key)',
        },
        max_chars: {
          type: 'integer',
          description: `cap of the returned markdown (default ${String(resolved.maxChars)}, hard max ${String(resolved.hardMaxChars)}); a capped answer names the spilled full text`,
        },
        freshness: {
          type: 'string',
          enum: ['cache', 'revalidate', 'force'],
          description: 'cache policy: cache (default), revalidate (conditional request first), force (always re-render)',
        },
        recipe: {
          type: 'string',
          enum: ['auto', 'off'],
          description: 'use a stored web-recipe for this domain (default auto) or ignore it (off)',
        },
      },
      handler: readPage,
    }),
  )

  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'page map',
      description:
        'maps ONE web page without its body: renders it in chromium and returns the OUTLINE (title, headings, per-section char counts, links) so a caller can pick a slice cheaply, with the same cache and char cap as page read',
      parameters: {
        url: { type: 'string', description: 'absolute http(s) URL of the page to map', required: true },
        max_chars: {
          type: 'integer',
          description: `cap of the returned outline (default ${String(resolved.mapMaxChars)}, hard max ${String(resolved.hardMaxChars)})`,
        },
      },
      handler: mapPage,
    }),
  )
}

// ---------------------------------------------------------------------------
// Parameter validation and small helpers
// ---------------------------------------------------------------------------

/** A required absolute http(s) URL. */
export function requireUrl(value: unknown, field: string): string {
  const url = str(value)
  if (url === undefined) throw new PageError('invalid_input', `the '${field}' parameter must be a non-empty string`)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new PageError('invalid_input', `the '${field}' parameter is not an absolute URL: ${url}`, { url })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new PageError('invalid_input', `only http/https URLs are supported, got '${parsed.protocol}'`, { url })
  }
  return parsed.toString()
}

/** The optional selector list, validated through the extractor's parser. */
export function selectorList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new PageError('invalid_input', "the 'selectors' parameter must be an array of strings")
  const list: string[] = []
  for (const item of value) {
    const selector = str(item)
    if (selector === undefined) throw new PageError('invalid_input', "the 'selectors' parameter must not contain empty strings")
    for (const part of selector.split(',')) parseSelector(part)
    list.push(selector)
  }
  return list.length === 0 ? undefined : list
}

/** A `max_chars` request, bounded by the plugin defaults (`[200, hardMaxChars]`). */
export function clampChars(value: unknown, fallback: number, hardMax: number): number {
  const raw = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(raw)) return fallback
  return Math.min(hardMax, Math.max(200, Math.trunc(raw)))
}

function freshnessOf(value: unknown): Freshness {
  return value === 'force' || value === 'revalidate' ? value : 'cache'
}

function outlineCounts(outline: { headings: unknown[]; links: unknown[]; sections: unknown[] }): Record<string, number> {
  return { headings: outline.headings.length, links: outline.links.length, sections: outline.sections.length }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'page'
  } catch {
    return 'page'
  }
}

/**
 * Conditional revalidation of a cached entry through a PLAIN HTTP request (no
 * browser): only a 304 is trusted ("unchanged"); anything else falls back to a
 * full render, because a changed HTTP body does not prove the JS DOM changed.
 */
async function revalidateHttp(url: string, entry: CacheEntry): Promise<'not-modified' | 'changed'> {
  const headers: Record<string, string> = {}
  if (entry.etag !== undefined) headers['if-none-match'] = entry.etag
  if (entry.lastModified !== undefined) headers['if-modified-since'] = entry.lastModified
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, 8000)
  try {
    const response = await fetch(url, { method: 'GET', headers, redirect: 'follow', signal: controller.signal })
    await response.body?.cancel().catch(() => undefined)
    return response.status === 304 ? 'not-modified' : 'changed'
  } catch {
    return 'changed'
  } finally {
    clearTimeout(timer)
  }
}

export { estimateTokens }
export default { name, inject: ['credentials', 'workbench'], apply }
