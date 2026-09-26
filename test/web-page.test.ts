// Unit tests for the `web-page` plugin: the extractor (fixture HTML -> markdown,
// deterministic), the cache/hash decision, the cap/spill path, the error mapping
// and the two registered tools driven through a FAKE renderer.
//
// No network and no browser: rendering is injected, extraction is pure, and the
// fixture below stands in for a client-rendered page.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PageCache, ageSeconds, cacheKey, contentHash, unchangedAnswer } from '../plugins/web-page/cache.ts'
import type { CacheEntry } from '../plugins/web-page/cache.ts'
import { browserFailure, codeForBrowserFailure, PageError, redactText } from '../plugins/web-page/errors.ts'
import { extractMain, outlineOf, renderOutline, sliceByQuery } from '../plugins/web-page/extract.ts'
import { apply } from '../plugins/web-page/index.ts'
import type { RenderRequest, RenderResult, RenderStats, Renderer } from '../plugins/web-page/render.ts'
import { capText, readSpill } from '../plugins/web-page/spill.ts'
import type { ToolDefinition } from '../definitions/tools.ts'

const URL_UNDER_TEST = 'https://example.test/docs/install'

/** A fixture "React page": nav, cookie banner, article, footer, live script. */
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Widget Docs - Install</title>
    <script>window.__DATA__ = { hydrated: true }</script>
    <style>.cookie { color: red }</style>
  </head>
  <body>
    <nav class="top"><a href="/">Home</a><a href="/docs">Docs</a><a href="/pricing">Pricing</a></nav>
    <div class="cookie-banner">We use cookies. Accept all cookies to continue.</div>
    <main>
      <h1>Installing Widget</h1>
      <p>Widget installs with a single command. Run npm install widget to get started.</p>
      <h2>Requirements</h2>
      <p>Node 22 or newer is required. The installer checks your version before it starts.</p>
      <p>Follow the <a href="/docs/upgrade">upgrade guide</a> when you move off an old release.</p>
      <ul><li>Run the installer</li><li>Set the workspace token</li></ul>
    </main>
    <footer>Copyright 2026 Example Inc. Privacy Policy</footer>
  </body>
</html>`

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'web-page-test-'))
}

function entryFor(overrides: Partial<CacheEntry> = {}): CacheEntry {
  const markdown = '# Installing Widget\n\nRun npm install widget.'
  return {
    key: cacheKey(URL_UNDER_TEST),
    url: URL_UNDER_TEST,
    finalUrl: URL_UNDER_TEST,
    title: 'Widget Docs - Install',
    markdown,
    hash: contentHash(markdown),
    chars: markdown.length,
    outline: outlineOf(markdown, 'Widget Docs - Install'),
    status: 200,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Extractor (fixtures only)
// ---------------------------------------------------------------------------

test('extract: main content becomes compact markdown, chrome and boilerplate are dropped', () => {
  const extraction = extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST })
  assert.match(extraction.markdown, /# Installing Widget/)
  assert.match(extraction.markdown, /npm install widget/)
  assert.match(extraction.markdown, /## Requirements/)
  assert.doesNotMatch(extraction.markdown, /We use cookies/)
  assert.doesNotMatch(extraction.markdown, /Copyright 2026/)
  assert.doesNotMatch(extraction.markdown, /<nav|<script|window\.__DATA__/)
  assert.equal(extraction.markdown.length, extraction.chars)
  assert.equal(extraction.title, 'Widget Docs - Install')
})

test('extract: deterministic (same HTML in, byte-identical markdown out)', () => {
  const first = extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST })
  const second = extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST })
  assert.equal(first.markdown, second.markdown)
  assert.equal(first.outline.chars, second.outline.chars)
})

test('extract: selectors scope the read and a selector that matches nothing fails with extract_empty', () => {
  const scoped = extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST, selectors: ['main'] })
  assert.match(scoped.markdown, /Installing Widget/)
  assert.doesNotMatch(scoped.markdown, /We use cookies/)
  const error = capture(() => extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST, selectors: ['.does-not-exist'] }))
  assert.ok(error instanceof PageError)
  assert.equal(error.code, 'extract_empty')
  const bad = capture(() => extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST, selectors: [':not(a-selector)'] }))
  assert.ok(bad instanceof PageError)
  assert.equal(bad.code, 'invalid_input')
})

test('outline: headings, sections, links and no body', () => {
  const extraction = extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST })
  const outline = extraction.outline
  assert.ok(outline.headings.some((heading) => heading.text === 'Installing Widget' && heading.level === 1))
  assert.ok(outline.headings.some((heading) => heading.text === 'Requirements' && heading.level === 2))
  assert.ok(outline.sections.length >= 2)
  assert.ok(outline.links.some((link) => link.href.includes('/docs')))
  assert.ok(outline.links.every((link) => !link.href.startsWith('/')))
  const rendered = renderOutline(outline)
  assert.match(rendered, /- h1 Installing Widget/)
  assert.doesNotMatch(rendered, /installs with a single command/)
  const rebuilt = outlineOf(extraction.markdown, extraction.title)
  assert.equal(rebuilt.headings.length, outline.headings.length)
})

test('query slicing: only matching blocks (plus their heading) survive', () => {
  const extraction = extractMain(FIXTURE_HTML, { url: URL_UNDER_TEST })
  const slice = sliceByQuery(extraction.markdown, 'requirements version', 4000)
  assert.deepEqual(slice.terms, ['requirements', 'version'])
  assert.ok(slice.matched >= 1)
  assert.match(slice.markdown, /Node 22 or newer/)
  assert.doesNotMatch(slice.markdown, /npm install widget/)
  const empty = sliceByQuery(extraction.markdown, 'zzz-not-there', 4000)
  assert.equal(empty.matched, 0)
  assert.equal(empty.markdown, '')
})

// A page whose LAYOUT wrapper carries a utility class naming the sidebars (the
// react.dev shape: `lg:grid-cols-sidebar-content`) must still yield its article.
test('extractor: a layout wrapper with a sidebar-named utility class is not chrome', () => {
  const html = `<html><body><div id="__next">
  <nav class="fixed"><h3>GET STARTED</h3><h3>LEARN REACT</h3></nav>
  <div class="grid grid-cols-only-content lg:grid-cols-sidebar-content 2xl:grid-cols-sidebar-content-toc">
    <main class="min-w-0 isolate"><article class="break-words text-primary">
      <h1>Quick Start</h1>
      <p>React lets you build user interfaces out of individual pieces called components, and it keeps the DOM in sync with your data automatically.</p>
      <h2>Installing React</h2>
      <p>Install React with the package manager of your choice, then import the pieces you need and render them into a container element.</p>
      <ul><li>Use a build tool</li><li>Try React online</li></ul>
    </article></main>
  </div>
</div></body></html>`
  const extraction = extractMain(html, { url: URL_UNDER_TEST })
  assert.ok(extraction.chars > 200)
  assert.match(extraction.markdown, /individual pieces called components/)
  assert.match(extraction.markdown, /Install React with the package manager/)
  assert.doesNotMatch(extraction.markdown, /GET STARTED|LEARN REACT/)
})

// ---------------------------------------------------------------------------
// Cache: key, content hash, TTL/freshness decision
// ---------------------------------------------------------------------------

test('cache key: URL plus selectors (order- and space-insensitive), and the content hash follows the TEXT', () => {
  assert.equal(cacheKey(URL_UNDER_TEST, ['main', '.body']), cacheKey(URL_UNDER_TEST, [' .body ', 'main']))
  assert.notEqual(cacheKey(URL_UNDER_TEST, ['main']), cacheKey(URL_UNDER_TEST))
  const hash = contentHash('# Title\n\nBody text   with   spaces')
  assert.equal(hash, contentHash('# Title\n\n\nBody text with spaces\n'))
  assert.notEqual(hash, contentHash('# Title\n\nBody text with other words'))
  assert.equal(hash.length, 16)
})

test('cache: a fresh entry is a hit, an expired one revalidates, force always renders', () => {
  const cache = new PageCache(tmpdir(), 900)
  const entry = entryFor()
  assert.equal(cache.decide(undefined, 'cache'), 'render')
  assert.equal(cache.decide(entry, 'cache'), 'hit')
  assert.equal(cache.decide(entry, 'force'), 'render')
  assert.equal(cache.decide(entry, 'revalidate'), 'revalidate')
  const stale = entryFor({ fetchedAt: new Date(Date.now() - 3_600_000).toISOString() })
  assert.equal(cache.decide(stale, 'cache'), 'revalidate')
  assert.ok(ageSeconds(stale) >= 3500)
  const noTtl = new PageCache(tmpdir(), 0)
  assert.equal(noTtl.decide(entry, 'cache'), 'revalidate')
  assert.equal(cache.canRevalidate(entry), false)
  assert.equal(cache.canRevalidate(entryFor({ etag: '"abc"' })), true)
  assert.equal(cache.canRevalidate(entryFor({ lastModified: 'Wed, 01 Jan 2026 00:00:00 GMT' })), true)
})

test('cache: write/read round trip, corrupt entry treated as absent, unchanged answer is short', async () => {
  const cache = new PageCache(tmpdir(), 900)
  const entry = entryFor({ etag: '"v1"' })
  await cache.write(entry)
  const read = await cache.read(entry.key)
  assert.ok(read !== undefined)
  assert.equal(read.hash, entry.hash)
  assert.equal(read.markdown, entry.markdown)
  assert.equal(read.etag, '"v1"')
  assert.ok(fs.existsSync(cache.fileFor(entry.key)))

  await fs.promises.writeFile(cache.fileFor(entry.key), '{not json')
  assert.equal(await cache.read(entry.key), undefined)

  const answer = unchangedAnswer(entry, 'hit', 12)
  assert.equal(answer.status, 'unchanged')
  assert.equal(answer.message, `unchanged since ${entry.hash}`)
  assert.ok(JSON.stringify(answer).length < 500)
})

// ---------------------------------------------------------------------------
// Cap + spill
// ---------------------------------------------------------------------------

test('cap: under the cap the text is verbatim; over it the full text is spilled and named', async () => {
  const dir = tmpdir()
  const short = await capText('a small body', 200, dir, 'example.test')
  assert.equal(short.capped, false)
  assert.equal(short.text, 'a small body')
  assert.equal(short.spillFile, undefined)
  assert.equal(short.estimatedTokens, Math.ceil('a small body'.length / 4))

  const body = Array.from({ length: 200 }, (_, index) => `line ${String(index)} of the body`).join('\n')
  const capped = await capText(body, 500, dir, 'example.test')
  assert.equal(capped.capped, true)
  assert.equal(capped.totalChars, body.length)
  assert.ok(capped.shownChars < body.length)
  assert.ok(capped.spillFile !== undefined)
  assert.ok(capped.text.includes(capped.spillFile))
  assert.equal(await readSpill(capped.spillFile), body)
  assert.ok(fs.statSync(capped.spillFile).size > 500)
  // stable per content: the same body spills to the same file
  const again = await capText(body, 500, dir, 'example.test')
  assert.equal(again.spillFile, capped.spillFile)
})

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

test('errors: the browser failure text maps to a NAMED code', () => {
  assert.equal(codeForBrowserFailure('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x'), 'dns')
  assert.equal(codeForBrowserFailure('net::ERR_CERT_AUTHORITY_INVALID'), 'tls')
  assert.equal(codeForBrowserFailure('page.goto: Timeout 20000ms exceeded.'), 'timeout')
  assert.equal(codeForBrowserFailure('net::ERR_CONNECTION_REFUSED'), 'connection')
  assert.equal(codeForBrowserFailure('something else entirely'), 'internal')

  const dns = browserFailure(new Error('net::ERR_NAME_NOT_RESOLVED'), URL_UNDER_TEST, 20000)
  assert.equal(dns.code, 'dns')
  assert.equal(dns.retryable, false)
  assert.match(dns.message, /^web-page: dns:/)
  assert.ok(dns.message.includes(URL_UNDER_TEST))

  const timeout = browserFailure(new Error('Timeout 20000ms exceeded'), URL_UNDER_TEST, 20000)
  assert.equal(timeout.code, 'timeout')
  assert.equal(timeout.retryable, true)
  assert.match(timeout.message, /within 20000ms/)

  const status = new PageError('http_status', 'the page answered HTTP 404', { url: URL_UNDER_TEST, hint: 'check the path' })
  assert.equal(status.code, 'http_status')
  assert.equal(status.toJSON().kind, undefined)
  assert.equal((status.toJSON() as { code: string }).code, 'http_status')
  assert.match(status.message, /^web-page: http_status: the page answered HTTP 404 \[/)
})

// ---------------------------------------------------------------------------
// The registered tools, through a fake renderer
// ---------------------------------------------------------------------------

interface ToolParameter {
  type: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
  items?: ToolParameter
}

type RegisteredTool = ToolDefinition

/** A renderer whose HTML can be swapped, so "the page changed" is observable. */
class FakeRenderer implements Renderer {
  html: string
  readonly calls: RenderRequest[] = []

  constructor(html: string) {
    this.html = html
  }

  render(request: RenderRequest): Promise<RenderResult> {
    this.calls.push(request)
    return Promise.resolve({
      html: this.html,
      finalUrl: request.url,
      status: 200,
      title: 'Widget Docs - Install',
      etag: undefined,
      lastModified: undefined,
      attempts: 1,
      elapsedMs: 7,
    })
  }

  dispose(): Promise<void> {
    return Promise.resolve()
  }

  stats(): RenderStats {
    return { launches: 0, renders: this.calls.length, contextReuses: 0, contextsOpen: 0 }
  }
}

interface FakeCtx {
  // The tools@1 service (Definition in definitions/tools.ts, provided by the
  // external `tools-impl` plugin): a consumer registers through `ctx.tools`.
  // `registered` is the tool list this test double records.
  tools: { register(def: RegisteredTool): () => void }
  effect(callback: () => () => void): void
  registered: RegisteredTool[]
}

function makeCtx(): FakeCtx {
  const registered: RegisteredTool[] = []
  return {
    tools: {
      register: (def) => {
        registered.push(def)
        return () => {
          const index = registered.indexOf(def)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    effect: (callback) => {
      callback()
    },
    registered,
  }
}

type ApplyContext = Parameters<typeof apply>[0]

function boot(renderer: Renderer, config: Record<string, unknown> = {}): { ctx: FakeCtx; tool: (name: string) => RegisteredTool } {
  const ctx = makeCtx()
  const dir = tmpdir()
  apply(ctx as unknown as ApplyContext, { cacheDir: dir, spillDir: path.join(dir, 'spill'), cacheTtlSeconds: 900, ...config }, { renderer })
  return {
    ctx,
    tool: (name: string) => {
      const found = ctx.registered.find((tool) => tool.name === name)
      assert.ok(found !== undefined, `tool '${name}' is registered`)
      return found
    },
  }
}

function capture(fn: () => unknown): unknown {
  try {
    const value = fn()
    if (value instanceof Promise) throw new Error('capture() got a promise: await the rejection instead')
    return undefined
  } catch (error) {
    return error
  }
}

async function rejection(value: unknown): Promise<unknown> {
  try {
    await Promise.resolve(value)
    return undefined
  } catch (error) {
    return error
  }
}

test('tools: both tools register with real schemas and the owning plugin name', () => {
  const { ctx, tool } = boot(new FakeRenderer(FIXTURE_HTML))
  assert.deepEqual(ctx.registered.map((entry) => entry.name), ['page read', 'page map'])
  const read = tool('page read')
  assert.equal(read.parameters?.required?.includes('url'), true)
  assert.equal(read.parameters?.properties?.url?.type, 'string')
  assert.equal(read.parameters?.properties?.selectors?.type, 'array')
  assert.equal(read.parameters?.properties?.selectors?.items?.type, 'string')
  assert.deepEqual(read.parameters?.properties?.freshness?.enum, ['cache', 'revalidate', 'force'])
  assert.equal(read.parameters?.properties?.max_chars?.type, 'integer')
  const map = tool('page map')
  assert.equal(map.parameters?.required?.includes('url'), true)
  assert.equal(map.parameters?.properties?.max_chars?.type, 'integer')
  assert.match(read.description ?? '', /JavaScript|chromium/)
})

test('page read: one call renders, extracts and returns markdown; the same call a second time answers "unchanged"', async () => {
  const renderer = new FakeRenderer(FIXTURE_HTML)
  const { tool } = boot(renderer)
  const first = (await tool('page read').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  assert.equal(first.status, 'rendered')
  assert.equal(renderer.calls.length, 1)
  assert.match(String(first.markdown), /# Installing Widget/)
  assert.equal(first.chars, String(first.markdown).length)
  assert.equal(first.estimatedTokens, Math.ceil(String(first.markdown).length / 4))
  assert.equal((first.cache as { state: string }).state, 'render')
  assert.equal(typeof first.hash, 'string')

  const second = (await tool('page read').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  assert.equal(second.status, 'unchanged')
  assert.equal(second.message, `unchanged since ${String(first.hash)}`)
  assert.equal(renderer.calls.length, 1, 'the second call is served from the cache')
  assert.ok(JSON.stringify(second).length < 400)

  // A page that changed on the origin is seen through `revalidate` (a live
  // check) even while the entry is still inside the TTL.
  renderer.html = FIXTURE_HTML.replace('Run npm install widget to get started.', 'Run npm install widget@2 to get started.')
  const third = (await tool('page read').execute({ url: URL_UNDER_TEST, freshness: 'revalidate' })) as Record<string, unknown>
  assert.equal(third.status, 'rendered')
  assert.equal(renderer.calls.length, 2)
  assert.notEqual(third.hash, first.hash)
  assert.match(String(third.markdown), /widget@2/)

  const fourth = (await tool('page read').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  assert.equal(fourth.status, 'unchanged')
  assert.equal(fourth.message, `unchanged since ${String(third.hash)}`)
})

test('page read: freshness force re-renders an unchanged page; selectors scope the read and the cache key', async () => {
  const renderer = new FakeRenderer(FIXTURE_HTML)
  const { tool } = boot(renderer)
  await tool('page read').execute({ url: URL_UNDER_TEST })
  await tool('page read').execute({ url: URL_UNDER_TEST })
  assert.equal(renderer.calls.length, 1)
  const forced = (await tool('page read').execute({ url: URL_UNDER_TEST, freshness: 'force' })) as Record<string, unknown>
  assert.equal(forced.status, 'rendered')
  assert.equal(renderer.calls.length, 2)

  const scoped = (await tool('page read').execute({ url: URL_UNDER_TEST, selectors: ['main'] })) as Record<string, unknown>
  assert.equal(scoped.status, 'rendered')
  assert.equal(renderer.calls.length, 3, 'a scoped read is NOT the whole-page cache entry')
  assert.doesNotMatch(String(scoped.markdown), /We use cookies/)
})

test('page read: query slices BEFORE the cap, and a small max_chars spills the full text to a file', async () => {
  const { tool } = boot(new FakeRenderer(FIXTURE_HTML))
  const sliced = (await tool('page read').execute({ url: URL_UNDER_TEST, query: 'requirements', freshness: 'force' })) as Record<string, unknown>
  const query = sliced.query as { terms: string[]; blocks: number; matchedChars: number }
  assert.deepEqual(query.terms, ['requirements'])
  assert.ok(query.blocks >= 1)
  assert.match(String(sliced.markdown), /Node 22 or newer/)
  assert.doesNotMatch(String(sliced.markdown), /npm install widget/)

  const capped = (await tool('page read').execute({ url: URL_UNDER_TEST, max_chars: 200, freshness: 'force' })) as Record<string, unknown>
  const truncation = capped.truncation as { capped: boolean; shownChars: number; totalChars: number; spillFile: string }
  assert.equal(truncation.capped, true)
  assert.ok(truncation.totalChars > 200)
  assert.ok(String(capped.markdown).includes(truncation.spillFile))
  const spilled = fs.readFileSync(truncation.spillFile, 'utf8')
  assert.match(spilled, /Installing Widget/)
  assert.ok(fs.statSync(truncation.spillFile).size > 200)
})

test('page map: the outline only, cache-shared with page read', async () => {
  const renderer = new FakeRenderer(FIXTURE_HTML)
  const { tool } = boot(renderer)
  await tool('page read').execute({ url: URL_UNDER_TEST })
  const map = (await tool('page map').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  const counts = map.counts as { headings: number; links: number; sections: number }
  assert.equal(map.status, 'map')
  assert.ok(counts.headings >= 2)
  assert.ok(counts.links >= 1)
  assert.match(String(map.markdown), /Installing Widget/)
  assert.doesNotMatch(String(map.markdown), /We use cookies|Copyright 2026/)
  assert.equal(renderer.calls.length, 1, 'page map reuses the page read entry')

  const capped = (await tool('page map').execute({ url: URL_UNDER_TEST, max_chars: 200 })) as Record<string, unknown>
  const truncation = capped.truncation as { capped: boolean; spillFile: string } | undefined
  assert.ok(truncation !== undefined && truncation.capped)
  assert.ok(fs.existsSync(truncation.spillFile))
})

test('failure envelope: a bad URL or a failed render names the failure and the TOOL KEEPS SERVING', async () => {
  const renderer = new FakeRenderer(FIXTURE_HTML)
  const { tool } = boot(renderer)

  await assert.rejects(async () => await tool('page read').execute({}), /url: missing required parameter/)

  const notHttp = await rejection(tool('page read').execute({ url: 'file:///etc/passwd' }))
  assert.ok(notHttp instanceof PageError)
  assert.equal(notHttp.code, 'invalid_input')

  await assert.rejects(async () => await tool('page read').execute({ url: URL_UNDER_TEST, selectors: 'main' }), /selectors: expected an array/)

  const failing: Renderer = {
    render: () => Promise.reject(new PageError('timeout', 'the page did not finish loading within 20000ms', { url: URL_UNDER_TEST, retryable: true })),
    dispose: () => Promise.resolve(),
    stats: () => ({ launches: 0, renders: 0, contextReuses: 0, contextsOpen: 0 }),
  }
  const broken = boot(failing)
  const timeout = await rejection(broken.tool('page read').execute({ url: URL_UNDER_TEST }))
  assert.ok(timeout instanceof PageError)
  assert.equal(timeout.code, 'timeout')
  assert.equal(timeout.retryable, true)

  const recovered = (await tool('page read').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  assert.equal(recovered.status, 'rendered', 'another tool call still works after a failure')

  const empty = boot(new FakeRenderer('<html><body><nav>only chrome</nav></body></html>'))
  const emptyError = await rejection(empty.tool('page read').execute({ url: URL_UNDER_TEST }))
  assert.ok(emptyError instanceof PageError)
  assert.equal(emptyError.code, 'extract_empty')
})

// ---------------------------------------------------------------------------
// Cache-hit reads (with a query) and the `redact` config
// ---------------------------------------------------------------------------

test('cache: a repeat `{url, query}` read is served from a FRESH entry - no browser, cache.state "hit"', async () => {
  const renderer = new FakeRenderer(FIXTURE_HTML)
  const { tool } = boot(renderer)

  // First call with a query: nothing cached yet, so exactly one render.
  const first = (await tool('page read').execute({ url: URL_UNDER_TEST, query: 'requirements', freshness: 'force' })) as Record<string, unknown>
  assert.equal(first.status, 'rendered')
  assert.equal(renderer.calls.length, 1)

  // Second call, same query, entry fresh: the slice comes OUT OF THE CACHE. A
  // `query` must not re-render a page the plugin already has (freshness decides
  // cache use), and the reported state must say so.
  const second = (await tool('page read').execute({ url: URL_UNDER_TEST, query: 'requirements' })) as Record<string, unknown>
  assert.equal(renderer.calls.length, 1, 'a fresh entry answers a query slice without launching a browser')
  assert.equal((second.cache as { state: string }).state, 'hit')
  assert.equal(second.hash, first.hash)
  assert.match(String(second.markdown), /Node 22 or newer/)
  assert.doesNotMatch(String(second.markdown), /npm install widget/)
  assert.deepEqual((second.query as { terms: string[] }).terms, ['requirements'])
  assert.equal(second.render, undefined, 'a cache-served answer carries no render stats')

  // ...and the plain re-read of the same entry is still the ~20 token answer.
  const third = (await tool('page read').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  assert.equal(third.status, 'unchanged')
  assert.equal((third.cache as { state: string }).state, 'hit')
  assert.equal(renderer.calls.length, 1)
})

test('redact: configured strings are scrubbed from message/url/detail of a failure, and the tool keeps serving', async () => {
  const secret = 'tok_live_TOP_SECRET'
  const failing: Renderer = {
    render: () =>
      Promise.reject(
        new PageError('connection', `the browser could not reach ${secret}`, {
          url: `https://example.test/${secret}/docs`,
          detail: `net::ERR_CONNECTION_REFUSED while sending ${secret}`,
          retryable: true,
        }),
      ),
    dispose: () => Promise.resolve(),
    stats: () => ({ launches: 0, renders: 0, contextReuses: 0, contextsOpen: 0 }),
  }

  const redacted = await rejection(boot(failing, { redact: [secret] }).tool('page read').execute({ url: URL_UNDER_TEST }))
  assert.ok(redacted instanceof PageError)
  assert.equal(redacted.code, 'connection')
  assert.ok(!redacted.message.includes(secret), 'the configured string is gone from the message')
  assert.ok(!String(redacted.url).includes(secret), 'the configured string is gone from the url')
  assert.ok(!String(redacted.detail).includes(secret), 'the configured string is gone from the detail')
  assert.match(redacted.message, /\[redacted\]/)

  // Without the `redact` row the very same failure is left untouched: the knob
  // is the ONLY difference.
  const plain = await rejection(boot(failing).tool('page read').execute({ url: URL_UNDER_TEST }))
  assert.ok(plain instanceof PageError)
  assert.ok(plain.message.includes(secret))

  // A redacted failure does not take the plugin down: another call still answers.
  const healthy = boot(new FakeRenderer(FIXTURE_HTML), { redact: [secret] })
  const answer = (await healthy.tool('page read').execute({ url: URL_UNDER_TEST })) as Record<string, unknown>
  assert.equal(answer.status, 'rendered')
})

test('redactText: plain text (never a regex), deterministic, blank patterns ignored; browserFailure scrubs first', () => {
  assert.equal(redactText('a SECRET b SECRET', ['SECRET']), 'a [redacted] b [redacted]')
  assert.equal(redactText('untouched', ['SECRET', '   ']), 'untouched')
  assert.equal(redactText('a.b', ['.']), 'a[redacted]b', 'the pattern is a literal, not a regex')

  const failure = browserFailure(new Error(`Timeout 5000ms exceeded for ${'tok_live_TOP_SECRET'}`), URL_UNDER_TEST, 5000, ['tok_live_TOP_SECRET'])
  assert.equal(failure.code, 'timeout')
  assert.ok(!failure.message.includes('tok_live_TOP_SECRET'))
  assert.match(failure.message, /\[redacted\]/)
})
