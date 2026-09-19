// Unit tests of `web-session`. NO browser here: the dispatch, the deltas, the
// selector engine, the interception rules, the persistence and the error
// mapping are exercised against a FAKE driver, so the fast tests pin the
// behaviour of the plugin and the end-to-end gate (a real chromium against a
// local SPA fixture) proves the browser path.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveConfig, absoluteUrl, statePathFor } from '../plugins/web-session/config.ts'
import { diffSnapshots, measure, snapshotsEqual } from '../plugins/web-session/delta.ts'
import type { Snapshot } from '../plugins/web-session/delta.ts'
import type { DriverContext, DriverPage, DriverOpenOptions, SessionDriver } from '../plugins/web-session/driver.ts'
import { SessionError, envelopeOf } from '../plugins/web-session/errors.ts'
import { codeFor, SessionManager } from '../plugins/web-session/manager.ts'
import { EndpointRecorder, originAllowed, sanitizeUrl } from '../plugins/web-session/intercept.ts'
import type { ObservedRequest } from '../plugins/web-session/intercept.ts'
import { parseSelectorSpec } from '../plugins/web-session/selectors.ts'
import { isIdle, pickEvictions, readStateFile, sanitizeState, stateSummary, stateUsable, writeStateFile } from '../plugins/web-session/store.ts'
import type { ResolvedSite } from '../plugins/web-session/config.ts'

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-session-'))
}

// ---------------------------------------------------------------------------
// selector forms
// ---------------------------------------------------------------------------
test('selector engine: CSS, XPath and role+name are parsed, garbage is rejected', () => {
  assert.deepEqual(parseSelectorSpec('#total'), { raw: '#total', kind: 'css', css: '#total' })
  assert.deepEqual(parseSelectorSpec('css=main .card'), { raw: 'css=main .card', kind: 'css', css: 'main .card' })
  assert.deepEqual(parseSelectorSpec('//div[@id="total"]'), { raw: '//div[@id="total"]', kind: 'xpath', xpath: '//div[@id="total"]' })
  assert.deepEqual(parseSelectorSpec('xpath=(//li)[1]'), { raw: 'xpath=(//li)[1]', kind: 'xpath', xpath: '(//li)[1]' })
  assert.deepEqual(parseSelectorSpec('role=button[name="Load items"]'), {
    raw: 'role=button[name="Load items"]',
    kind: 'role',
    role: 'button',
    name: 'Load items',
  })
  assert.deepEqual(parseSelectorSpec('role=button[name=Load]'), { raw: 'role=button[name=Load]', kind: 'role', role: 'button', name: 'Load' })
  assert.deepEqual(parseSelectorSpec('role=heading'), { raw: 'role=heading', kind: 'role', role: 'heading' })
  assert.throws(() => parseSelectorSpec('   '), (error: unknown) => error instanceof SessionError && error.code === 'invalid_input')
  assert.throws(() => parseSelectorSpec('//div['), (error: unknown) => error instanceof SessionError && error.code === 'bad_selector')
  assert.throws(() => parseSelectorSpec('#a { color: red }'), (error: unknown) => error instanceof SessionError && error.code === 'bad_selector')
})

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------
test('config: sites resolve, a single site becomes the default, relative URLs resolve against the base', () => {
  const config = resolveConfig({
    stateDir: '/tmp/wb-state',
    sites: { docs: { baseUrl: 'https://docs.example.com/guide/', allowOrigins: ['https://api.example.com/x'] } },
  })
  const site = config.sites.get('docs')
  assert.ok(site)
  assert.equal(site.baseUrl, 'https://docs.example.com/guide/')
  assert.equal(config.defaultSite, 'docs')
  assert.equal(site.stateFile, statePathFor('/tmp/wb-state', 'docs'))
  assert.deepEqual(site.allowOrigins, ['https://api.example.com'])
  assert.equal(absoluteUrl(site.baseUrl, 'page/2'), 'https://docs.example.com/guide/page/2')
  assert.equal(absoluteUrl(site.baseUrl, 'https://other.example.com/x'), 'https://other.example.com/x')
})

test('config: a site without a baseUrl is skipped and bounds are applied', () => {
  const config = resolveConfig({
    maxChars: 10,
    hardMaxChars: 5,
    maxSessions: 99,
    sites: { broken: { baseUrl: '' }, good: { baseUrl: 'https://ok.example.com' } },
  })
  assert.deepEqual([...config.sites.keys()], ['good'])
  assert.equal(config.maxChars, 200, 'maxChars is bounded below')
  assert.ok(config.hardMaxChars >= config.maxChars, 'the hard cap is never below the per-call cap')
  assert.equal(config.maxSessions, 32, 'maxSessions is bounded')
  assert.equal(config.idleTtlSeconds, 900, 'the TTL keeps its configured default')
  const zero = resolveConfig({ sites: { a: { baseUrl: 'https://a.test' } }, maxSessions: 1, maxChars: 200000, hardMaxChars: 400000 })
  assert.equal(zero.maxSessions, 1)
  assert.equal(zero.maxChars, 200000)
  assert.equal(zero.hardMaxChars, 400000)
})

// ---------------------------------------------------------------------------
// store / persistence
// ---------------------------------------------------------------------------
test('store: state files round-trip, are 0600, and only the storage-state shape is kept', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state', 'demo.json')
  const raw = {
    cookies: [{ name: 'sid', value: 's3cr3t-cookie', domain: 'demo.test', path: '/' }],
    origins: [{ origin: 'https://demo.test', localStorage: [{ name: 'k', value: 'v' }] }],
    // Anything that is not a storage state must be dropped on write.
    password: 'must-never-be-persisted',
    headers: [{ name: 'authorization', value: 'Bearer nope' }],
  }
  const written = await writeStateFile(file, raw)
  assert.deepEqual(stateSummary(written), { cookies: 1, origins: 1, localStorage: 1 })
  assert.ok(stateUsable(written))
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(!text.includes('must-never-be-persisted'), 'a password must never reach the state file')
  assert.ok(!text.includes('Bearer nope'), 'a header must never reach the state file')
  const mode = fs.statSync(file).mode & 0o777
  assert.equal(mode, 0o600, 'the state file must only be readable by its owner')
  const read = await readStateFile(file)
  assert.deepEqual(read.state, written)
  assert.equal(read.exists, true)
  const missing = await readStateFile(path.join(dir, 'state', 'absent.json'))
  assert.equal(missing.exists, false)
  assert.equal(missing.state, undefined)
  assert.deepEqual(sanitizeState({ cookies: [{ name: 'x' }], origins: 'nope' }), { cookies: [], origins: [] })
})

test('store: TTL and eviction order are pure decisions', () => {
  const now = 1_000_000
  assert.equal(isIdle(now - 999_000, now, 900), true)
  assert.equal(isIdle(now - 1000, now, 900), false)
  assert.equal(isIdle(now - 999_000, now, 0), false, 'ttl 0 disables idle eviction')
  const live = [
    { label: 'old', lastUsedAt: now - 999_000 },
    { label: 'fresh', lastUsedAt: now - 1000 },
    { label: 'middle', lastUsedAt: now - 2000 },
  ]
  assert.deepEqual(pickEvictions(live, now, 900, 4), ['old'])
  assert.deepEqual(pickEvictions(live, now, 0, 1), ['middle', 'old'], 'the two least recently used go, alphabetically')
})

// ---------------------------------------------------------------------------
// delta computation
// ---------------------------------------------------------------------------
const snap = (nodes: { ref: string; tag: string; text: string }[], url = 'u', title = 't'): Snapshot => ({ url, title, nodes })

test('delta: a baseline reports counts only, then added/removed/changed nodes', () => {
  const budget = { maxNodes: 10, maxChars: 100000 }
  const baseline = diffSnapshots(undefined, snap([{ ref: '#a', tag: 'p', text: 'one' }]), budget)
  assert.equal(baseline.baseline, true)
  assert.deepEqual(baseline.added, [])
  assert.deepEqual(baseline.changed, [])
  assert.deepEqual(baseline.counts, { before: 0, after: 1, added: 1, removed: 0, changed: 0, reported: 0, truncated: false })
  const delta = diffSnapshots(
    snap([
      { ref: '#a', tag: 'p', text: 'one' },
      { ref: '#gone', tag: 'p', text: 'bye' },
    ]),
    snap([
      { ref: '#a', tag: 'p', text: 'two' },
      { ref: '#new', tag: 'li', text: '3 items' },
    ]),
    budget,
  )
  assert.deepEqual(delta.added, [{ ref: '#new', tag: 'li', text: '3 items' }])
  assert.deepEqual(delta.removed, [{ ref: '#gone', tag: 'p', text: 'bye' }])
  assert.deepEqual(delta.changed, [{ ref: '#a', tag: 'p', from: 'one', to: 'two' }])
  assert.equal((delta.counts as { changed: number }).changed, 1)
  assert.equal(delta.baseline, false)
})

test('delta: caps are enforced per list and the truncation is reported', () => {
  const before = snap(Array.from({ length: 40 }, (_v, index) => ({ ref: `#n${String(index)}`, tag: 'p', text: 'x' })))
  const after = snap(Array.from({ length: 40 }, (_v, index) => ({ ref: `#m${String(index)}`, tag: 'p', text: 'y' })))
  const delta = diffSnapshots(before, after, { maxNodes: 5, maxChars: 100000 })
  assert.equal((delta.added as unknown[]).length, 5)
  assert.equal((delta.counts as { added: number }).added, 40)
  assert.equal((delta.counts as { truncated: boolean }).truncated, true)
  const tiny = diffSnapshots(before, after, { maxNodes: 40, maxChars: 400 })
  assert.ok(measure(tiny).chars <= 400, 'the char budget trims the payload')
  assert.equal(tiny.baseline, false)
})

test('delta: snapshot equality ignores nothing that matters', () => {
  assert.equal(snapshotsEqual(snap([{ ref: '#a', tag: 'p', text: 'x' }]), snap([{ ref: '#a', tag: 'p', text: 'x' }])), true)
  assert.equal(snapshotsEqual(snap([{ ref: '#a', tag: 'p', text: 'x' }]), snap([{ ref: '#a', tag: 'p', text: 'y' }])), false)
  assert.equal(snapshotsEqual(undefined, snap([])), false)
})

// ---------------------------------------------------------------------------
// interception / API discovery
// ---------------------------------------------------------------------------
test('interception: same-origin (plus allow-list) only, and secret query values are redacted', () => {
  assert.equal(originAllowed('https://demo.test/api/x', 'https://demo.test', []), true)
  assert.equal(originAllowed('https://evil.test/api/x', 'https://demo.test', []), false)
  assert.equal(originAllowed('https://api.demo.test/x', 'https://demo.test', ['https://api.demo.test']), true)
  assert.equal(sanitizeUrl('https://demo.test/api/x?token=abc&page=2#frag'), 'https://demo.test/api/x?token=%5Bredacted%5D&page=2')
})

test('interception: the endpoint list deduplicates, bounds and never carries a credential', () => {
  const recorder = new EndpointRecorder({ origin: 'https://demo.test', allowOrigins: [], max: 2 })
  const obs = (url: string, extra: Partial<ObservedRequest> = {}): ObservedRequest => ({
    method: 'GET',
    url,
    resourceType: 'xhr',
    contentType: 'application/json',
    status: 200,
    ...extra,
  })
  recorder.observe(obs('https://demo.test/api/items?token=abc123'))
  recorder.observe(obs('https://demo.test/api/items'))
  recorder.observe(obs('https://demo.test/api/other'))
  recorder.observe(obs('https://demo.test/api/third'))
  recorder.observe(obs('https://evil.test/api/steal'))
  recorder.observe({ method: 'GET', url: 'https://demo.test/logo.png', resourceType: 'image', contentType: 'image/png' })
  const list = recorder.list()
  assert.equal(list.length, 2, 'bounded at maxEndpoints')
  assert.equal(list[0].hits, 2, 'the same method+path is one endpoint')
  assert.equal(list[0].id, 'E1')
  assert.equal(recorder.dropped, 1)
  assert.equal(recorder.blocked, 1)
  const text = JSON.stringify(list)
  assert.ok(!text.includes('abc123'), 'a secret-looking query value is never listed')
  assert.equal(recorder.resolve('E2')?.path, '/api/other')
  assert.equal(recorder.resolve('/api/items')?.id, 'E1')
  assert.equal(recorder.resolve('items')?.id, 'E1')
  assert.equal(recorder.resolve('/api/nope'), undefined)
  // A query the caller quotes WINS over the discovered sample: the sample is one
  // observation (`?page=1&size=60`), so asking for a different paging must ask
  // the site for it, not replay the sample.
  assert.equal(recorder.resolve('/api/items?page=2&size=5')?.url.split('?').pop(), 'page=2&size=5')
  assert.equal(recorder.resolve('https://demo.test/api/items?page=3')?.url.split('?').pop(), 'page=3')
  assert.deepEqual(recorder.since(1).map((endpoint) => endpoint.id), ['E2'])
})

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------
test('errors: transport texts map to codes and every envelope is structured', () => {
  assert.equal(codeFor('Timeout 10000ms exceeded', 'step_failed'), 'timeout')
  assert.equal(codeFor("Unexpected token '{' while parsing css selector", 'step_failed'), 'bad_selector')
  assert.equal(codeFor('Timeout 5000ms exceeded while waiting for locator("#x")', 'step_failed'), 'no_match')
  assert.equal(codeFor('net::ERR_NAME_NOT_RESOLVED at https://nope.test', 'connection'), 'dns')
  assert.equal(codeFor('page.goto: net::ERR_CONNECTION_REFUSED', 'connection'), 'connection')
  assert.equal(codeFor('something else', 'step_failed'), 'step_failed')
  const error = new SessionError('bad_selector', "the selector '#x' matched nothing", { site: 'demo', selector: '#x' })
  const envelope = envelopeOf(error)
  assert.equal(envelope.status, 'error')
  assert.equal((envelope.error as { code: string }).code, 'bad_selector')
  assert.ok((envelope.error as { message: string }).message.startsWith('web-session: bad_selector:'))
  const scrubbed = envelopeOf(error, ['#x'])
  assert.ok(!JSON.stringify(scrubbed).includes('#x'), 'a configured redact pattern is scrubbed')
  assert.equal((envelopeOf(new Error('boom')).error as { code: string }).code, 'internal')
})

// ---------------------------------------------------------------------------
// the manager: dispatch, deltas, login, persistence, API path (fake driver)
// ---------------------------------------------------------------------------
interface FakeElement {
  tag: string
  text: string
  html: string
  attrs: Record<string, string>
}

class FakePage implements DriverPage {
  urlValue = 'about:blank'
  titleValue = 'Demo'
  nodes: { ref: string; tag: string; text: string }[] = []
  matches = new Map<string, FakeElement[]>()
  counts = new Map<string, number>()
  hasTexts = new Set<string>()
  filled: { selector: string; value: string }[] = []
  clicks: string[] = []
  presses: string[] = []
  hooks = new Map<string, (page: FakePage) => void>()
  routes: { match: string; hook: (page: FakePage) => void }[] = []

  url(): string {
    return this.urlValue
  }
  async title(): Promise<string> {
    return this.titleValue
  }
  async goto(url: string): Promise<number> {
    this.urlValue = url
    for (const route of this.routes) if (url.includes(route.match)) route.hook(this)
    return 200
  }
  async settle(): Promise<void> {}
  async click(selector: { raw: string }): Promise<void> {
    this.clicks.push(selector.raw)
    if ((this.matches.get(selector.raw)?.length ?? this.counts.get(selector.raw) ?? 0) === 0) {
      throw new Error(`Timeout 5000ms exceeded while waiting for locator("${selector.raw}") to be visible`)
    }
    this.hooks.get(selector.raw)?.(this)
  }
  async fill(selector: { raw: string }, value: string): Promise<void> {
    this.filled.push({ selector: selector.raw, value })
  }
  async select(selector: { raw: string }, value: string): Promise<void> {
    this.clicks.push(`select ${selector.raw}=${value}`)
  }
  async press(selector: { raw: string } | undefined, key: string): Promise<void> {
    this.presses.push(`${selector?.raw ?? ''}:${key}`)
    this.hooks.get(key)?.(this)
  }
  async waitFor(selector: { raw: string } | undefined, state: string): Promise<void> {
    if (selector !== undefined && (this.counts.get(selector.raw) ?? 0) === 0 && state === 'visible') throw new Error(`Timeout 5000ms exceeded while waiting for locator("${selector.raw}")`)
  }
  async waitForTimeout(): Promise<void> {}
  async hasText(text: string): Promise<boolean> {
    return this.hasTexts.has(text)
  }
  async count(selector: { raw: string }): Promise<number> {
    const explicit = this.counts.get(selector.raw)
    if (explicit !== undefined) return explicit
    return this.matches.get(selector.raw)?.length ?? 0
  }
  async elements(selector: { raw: string }, limit: number): Promise<FakeElement[]> {
    return (this.matches.get(selector.raw) ?? []).slice(0, limit)
  }
  async outline(): Promise<{ headings: { level: number; text: string }[]; links: { text: string; href: string }[] }> {
    return { headings: [{ level: 1, text: 'Demo app' }], links: [{ text: 'Docs', href: 'https://demo.test/docs' }] }
  }
  async snapshot(): Promise<Snapshot> {
    return { url: this.urlValue, title: this.titleValue, nodes: this.nodes }
  }
  async close(): Promise<void> {}
}

class FakeContext implements DriverContext {
  page = new FakePage()
  handlers: ((observed: ObservedRequest) => void)[] = []
  state: unknown = { cookies: [{ name: 'sid', value: 's3cr3t-cookie', domain: 'demo.test', path: '/' }], origins: [] }
  status = 200
  body = '{"items":[1,2,3]}'
  requests: { url: string; method: string }[] = []
  closed = false

  onResponse(handler: (observed: ObservedRequest) => void): void {
    this.handlers.push(handler)
  }
  emit(observed: ObservedRequest): void {
    for (const handler of this.handlers) handler(observed)
  }
  async storageState(): Promise<unknown> {
    return this.state
  }
  async request(url: string, method: string): Promise<{ status: number; contentType: string; body: string }> {
    this.requests.push({ url, method })
    return { status: this.status, contentType: 'application/json', body: this.body }
  }
  async close(): Promise<void> {
    this.closed = true
  }
}

interface FakeDriver {
  driver: SessionDriver
  contexts: { site: ResolvedSite; options: DriverOpenOptions; context: FakeContext }[]
  last(): FakeContext
}

/**
 * A driver whose contexts are seeded with a PREPARED page: the site's routes and
 * hooks must exist before the manager navigates, so a caller builds the page
 * first and hands it over here (one seed per opened context).
 */
function fakeDriver(seeds: FakePage[] = []): FakeDriver {
  const contexts: { site: ResolvedSite; options: DriverOpenOptions; context: FakeContext }[] = []
  const queue = [...seeds]
  const driver: SessionDriver = {
    openContext: async (site, options) => {
      const context = new FakeContext()
      const seed = queue.shift()
      if (seed !== undefined) context.page = seed
      contexts.push({ site, options, context })
      return context
    },
  }
  return { driver, contexts, last: () => contexts[contexts.length - 1].context }
}

/** The tool's real exit point: the handler turns every throw into an envelope. */
async function call(manager: SessionManager, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    return await manager.execute(params)
  } catch (error) {
    return envelopeOf(error)
  }
}

const DEMO_LOGIN = {
  url: '/login',
  indicator: '#login-form',
  fields: [
    { name: 'user', selector: '#user', credential: 'DEMO_USER' },
    { name: 'pass', selector: '#pass', credential: 'DEMO_PASSWORD' },
  ],
  success: { selector: '#app' },
}

function demoConfig(stateDir: string, login: unknown = DEMO_LOGIN): ReturnType<typeof resolveConfig> {
  return resolveConfig({
    stateDir,
    sites: {
      demo: {
        baseUrl: 'https://demo.test/',
        login: login as never,
      },
    },
  })
}

test('manager: an unknown action and an unknown site are structured errors', async () => {
  const config = demoConfig(tempDir())
  const fd = fakeDriver()
  const manager = new SessionManager(config, async () => undefined, { driver: fd.driver })
  await assert.rejects(
    () => manager.execute({ action: 'fly' }),
    (error: unknown) => error instanceof SessionError && error.code === 'invalid_input',
  )
  await assert.rejects(
    () => manager.execute({ action: 'open', site: 'nope' }),
    (error: unknown) => error instanceof SessionError && error.code === 'unknown_site' && error.message.includes('demo'),
  )
})

test('manager: open -> act (delta) -> read (selector + api list + direct call) -> close', async () => {
  const dir = tempDir()
  const config = demoConfig(dir)
  // The fake site, configured BEFORE the driver opens its context: /login shows
  // the indicator, the login POST (Enter) lands on /app, which renders two text
  // nodes.
  const loginPage = new FakePage()
  loginPage.routes = [
    {
      match: '/login',
      hook: (page) => {
        page.counts.set('#login-form', 1)
      },
    },
    {
      match: '/app',
      hook: (page) => {
        page.counts.set('#login-form', 0)
        page.counts.set('#app', 1)
        page.nodes = [
          { ref: '#app', tag: 'div', text: 'Welcome alice' },
          { ref: '#total', tag: 'span', text: '0 items' },
        ]
      },
    },
  ]
  loginPage.hooks.set('Enter', (page) => {
    page.counts.set('#login-form', 0)
    page.counts.set('#app', 1)
    page.urlValue = 'https://demo.test/app'
    page.nodes = [
      { ref: '#app', tag: 'div', text: 'Welcome alice' },
      { ref: '#total', tag: 'span', text: '0 items' },
    ]
  })

  const fd = fakeDriver([loginPage])
  const manager = new SessionManager(config, async (name) => (name === 'DEMO_USER' ? 'alice' : 'sup3r-secret'), {
    driver: fd.driver,
    now: () => 1_000_000,
  })
  const opened = await manager.execute({ action: 'open', site: 'demo', url: '/app' })
  const context = fd.last()
  assert.equal(opened.status, 'ok')
  assert.equal(opened.action, 'open')
  assert.equal(opened.url, 'https://demo.test/app')
  assert.equal((opened.delta as { baseline: boolean }).baseline, true, 'open answers a baseline, not a dump')
  assert.ok((opened.login as { performed: boolean }).performed, 'the login flow ran (no stored state)')
  assert.equal((opened.login as { credentialMissing: string[] }).credentialMissing.length, 0)
  const stateFile = path.join(dir, 'state', 'demo.json')
  assert.ok(fs.existsSync(stateFile), 'the login persisted a state file')
  const persisted = fs.readFileSync(stateFile, 'utf8')
  assert.ok(persisted.includes('s3cr3t-cookie'), 'the state holds the cookies')
  assert.ok(!persisted.includes('sup3r-secret'), 'the password must never be persisted')
  assert.ok(!JSON.stringify(opened).includes('sup3r-secret'), 'the password must never be echoed')
  assert.equal(context.page.filled[0].value, 'alice')
  assert.equal(context.page.filled[1].value, 'sup3r-secret')

  // API discovery: the page calls a JSON endpoint while the session is live.
  context.emit({ method: 'GET', url: 'https://demo.test/api/items?token=abc123', resourceType: 'xhr', contentType: 'application/json', status: 200 })
  context.emit({ method: 'GET', url: 'https://evil.test/api/steal', resourceType: 'xhr', contentType: 'application/json', status: 200 })
  const list = await manager.execute({ action: 'read', site: 'demo', api: 'list' })
  assert.equal((list.endpoints as { count: number }).count, 1)
  assert.equal((list.endpoints as { blocked: number }).blocked, 1)
  assert.ok(!JSON.stringify(list).includes('abc123'), 'a secret-looking query value is never listed')

  const direct = await manager.execute({ action: 'read', site: 'demo', api: 'E1' })
  assert.equal(direct.via, 'api')
  assert.deepEqual(direct.data, { items: [1, 2, 3] })
  assert.deepEqual(context.requests, [{ url: 'https://demo.test/api/items?token=%5Bredacted%5D', method: 'GET' }])

  // A selector-scoped read of ONE node, then a delta after an act.
  context.page.matches.set('#total', [{ tag: 'span', text: '3 items', html: '<span id="total">3 items</span>', attrs: { id: 'total' } }])
  context.page.counts.set('#total', 1)
  const read = await manager.execute({ action: 'read', site: 'demo', selector: '#total' })
  assert.equal(read.via, 'selector')
  assert.equal(read.body, '3 items')
  assert.equal(read.matched, 1)

  context.page.clicks = []
  context.page.counts.set('#load', 1)
  context.page.hooks.set('#load', (page) => {
    page.nodes = [
      { ref: '#app', tag: 'div', text: 'Welcome alice' },
      { ref: '#total', tag: 'span', text: '3 items' },
      { ref: '#note', tag: 'p', text: 'loaded' },
    ]
  })
  const acted = await manager.execute({ action: 'act', site: 'demo', steps: [{ type: 'click', selector: '#load' }] })
  assert.equal(acted.status, 'ok')
  assert.equal((acted.steps as unknown[]).length, 1)
  const delta = acted.delta as { added: { ref: string }[]; changed: { ref: string; to: string }[]; baseline: boolean; chars: number }
  assert.equal(delta.baseline, false)
  assert.deepEqual(delta.added.map((node) => node.ref), ['#note'])
  assert.deepEqual(delta.changed.map((node) => node.ref), ['#total'])
  assert.ok(delta.chars > 0)

  const bad = await call(manager, { action: 'read', site: 'demo', selector: '#nope' })
  assert.equal((bad.error as { code: string }).code, 'no_match')

  const closed = await manager.execute({ action: 'close', site: 'demo' })
  assert.equal(closed.closed, true)
  assert.equal((closed.state as { cookies: number }).cookies, 1)
  assert.equal(context.closed, true)
  assert.deepEqual(manager.liveLabels(), [])
})

test('manager: a bad selector, a missing credential and a failed step answer structured errors', async () => {
  const dir = tempDir()
  const config = demoConfig(dir)
  const fd = fakeDriver()
  const manager = new SessionManager(config, async () => undefined, { driver: fd.driver })

  // No credential can be resolved: the login reports every missing NAME and no value.
  await assert.rejects(
    () => manager.execute({ action: 'open', site: 'demo' }),
    (error: unknown) => error instanceof SessionError && error.code === 'login_failed' && error.message.includes('DEMO_USER') && error.message.includes('DEMO_PASSWORD'),
    'a login without resolvable credentials names every missing credential',
  )

  // A plain site (no login flow) for the selector and step failures.
  const plain = resolveConfig({ stateDir: dir, sites: { plain: { baseUrl: 'https://demo.test/app' } } })
  const plainPage = new FakePage()
  plainPage.routes = [{ match: '/app', hook: (target) => { target.counts.set('#app', 1) } }]
  const plainManager = new SessionManager(plain, async () => 'value', { driver: fakeDriver([plainPage]).driver })

  const parsedBad = await call(plainManager, { action: 'read', site: 'plain', selector: '#a {' })
  assert.equal((parsedBad.error as { code: string }).code, 'bad_selector')

  const badStep = await call(plainManager, { action: 'act', site: 'plain', steps: [{ type: 'click', selector: '#missing' }] })
  assert.equal((badStep.error as { code: string }).code, 'no_match', 'a selector that never appears is no_match')
  const unknownType = await call(plainManager, { action: 'act', site: 'plain', steps: [{ type: 'teleport' }] })
  assert.equal((unknownType.error as { code: string }).code, 'invalid_input')
  const noSteps = await call(plainManager, { action: 'act', site: 'plain' })
  assert.equal((noSteps.error as { code: string }).code, 'invalid_input')

  // The compact step form the README documents: { click: '#total' }.
  plainPage.matches.set('#total', [{ tag: 'span', text: '42 items', html: '<span id="total">42 items</span>', attrs: { id: 'total' } }])
  const compact = await call(plainManager, { action: 'act', site: 'plain', steps: [{ click: '#total' }] })
  assert.equal(compact.status, 'ok', 'the compact step form ({ click: selector }) is accepted')
  assert.equal((compact.steps as { type: string }[])[0].type, 'click')
})

test('manager: a session survives a restart through the persisted state file', async () => {
  const dir = tempDir()
  const stateFile = path.join(dir, 'state', 'demo.json')
  await writeStateFile(stateFile, {
    cookies: [{ name: 'sid', value: 's3cr3t-cookie', domain: 'demo.test', path: '/' }],
    origins: [{ origin: 'https://demo.test', localStorage: [{ name: 'theme', value: 'dark' }] }],
  })
  const config = resolveConfig({ stateDir: dir, sites: { demo: { baseUrl: 'https://demo.test/app', login: DEMO_LOGIN as never } } })

  const page = new FakePage()
  page.routes = [
    {
      match: '/app',
      hook: (target) => {
        // Logged IN because the stored state was handed to the context.
        target.counts.set('#app', 1)
        target.counts.set('#login-form', 0)
        target.nodes = [{ ref: '#total', tag: 'span', text: '42 items' }]
      },
    },
  ]
  const fd = fakeDriver([page])
  const manager = new SessionManager(config, async () => 'value', { driver: fd.driver })
  const result = await call(manager, { action: 'read', site: 'demo' })
  assert.equal(fd.contexts[0].options.storageState !== undefined, true, 'the stored cookies were handed to the context')
  assert.equal(result.via, 'outline')
  assert.equal((result as { login?: unknown }).login, undefined, 'a stored state means no re-login runs')
  assert.equal((await call(manager, { action: 'close', site: 'demo' })).closed, true)
  const stored = await readStateFile(stateFile)
  assert.equal(stateSummary(stored.state!).cookies, 1, 'the state file is still there after close')
})

test('manager: an idle session is evicted (state persisted) before the next action', async () => {
  const dir = tempDir()
  const config = resolveConfig({ stateDir: dir, idleTtlSeconds: 10, sites: { demo: { baseUrl: 'https://demo.test/' } } })
  const fd = fakeDriver()
  let now = 1_000_000
  const manager = new SessionManager(config, async () => undefined, { driver: fd.driver, now: () => now })
  await manager.execute({ action: 'open', site: 'demo' })
  assert.deepEqual(manager.liveLabels(), ['demo'])
  now += 60_000
  await manager.execute({ action: 'read', site: 'demo' })
  assert.equal(fd.contexts.length, 2, 'the idle session was dropped and a fresh context opened')
  assert.equal(fd.contexts[0].context.closed, true)
})
