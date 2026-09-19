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
}

/** Optional collaborators, so the pipeline can be tested without a browser. */
export interface WebPageDeps {
  renderer?: Renderer
}

type CacheState = CacheDecision | 'revalidated'

/**
 * The plugin entry. `deps` is a test seam (the core calls `apply(ctx, config)`);
 * without it the plugin builds its own pooled chromium renderer, lazily.
 */
export function apply(ctx: PluginContext, config: WebPageConfig = {}, deps: WebPageDeps = {}): void {
  const resolved = resolveConfig(config)
  const cache = new PageCache(resolved.cacheDir, resolved.cacheTtlSeconds)
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

  async function readPage(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = requireUrl(params.url, 'url')
    const selectors = selectorList(params.selectors)
    const query = str(params.query)
    const maxChars = clampChars(params.max_chars, resolved.maxChars, resolved.hardMaxChars)
    const freshness = freshnessOf(params.freshness)
    const key = cacheKey(url, selectors)
    const cached = await cache.read(key)
    const decision = cache.decide(cached, freshness)

    // 1) Fresh cache entry, no slice asked for: the ~20 token answer.
    if (decision === 'hit' && cached !== undefined && query === undefined) {
      return unchangedAnswer(cached, 'hit', ageSeconds(cached))
    }

    // 2) Conditional revalidation first (a plain HTTP request, no browser): a
    //    304 proves the page did not change, so the browser is never launched.
    let state: CacheState = decision === 'hit' ? 'hit' : decision === 'revalidate' ? 'revalidated' : 'render'
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
    const rendered = await renderer.render({ url, selectors })
    const extraction = extractMain(rendered.html, { url: rendered.finalUrl, selectors })
    if (extraction.markdown.trim().length === 0) {
      throw new PageError('extract_empty', 'the rendered page produced no readable text', {
        url,
        hint: 'the page may require a login or render only media (a session-carrying read is the web-session task)',
      })
    }
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
    return { ...answer, render: { attempts: rendered.attempts, elapsedMs: rendered.elapsedMs } }
  }

  async function mapPage(params: Record<string, unknown>): Promise<Record<string, unknown>> {
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
