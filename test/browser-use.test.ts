// The `browser-use@1` seam: the contract, the SERVICE HOST (registry,
// selection, bounds, typed errors), the CONSUMER tool (ONE action-enum tool
// whose snapshot refs round-trip across calls) and ONE real end-to-end path
// against a LOCAL fixture page.
//
// The unit tests drive the seam with a FAKE provider, so they prove the
// contract without a browser. The last test drives the REAL playwright
// provider; when no browser is installed it SKIPS loudly with the exact
// prerequisite instead of faking a browser that is not there (requirement 3).
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  ACT_KINDS,
  BROWSER_USE_CONTRACT,
  BROWSER_USE_TOOL_NAME,
  DEFAULT_SCREENSHOT_DIR,
  EXTRACT_MODES,
  BrowserUseError,
  isBrowserUseError,
} from '../definitions/browser-use.ts'
import type {
  BrowserActAnswer,
  BrowserActRequest,
  BrowserCapabilityReport,
  BrowserEngineInfo,
  BrowserEvaluateAnswer,
  BrowserExtractAnswer,
  BrowserExtractRequest,
  BrowserNavigateAnswer,
  BrowserNavigateRequest,
  BrowserObserveAnswer,
  BrowserObserveRequest,
  BrowserProviderCapabilities,
  BrowserProviderInfo,
  BrowserScreenshotAnswer,
  BrowserScreenshotRequest,
  BrowserSelection,
  BrowserSessionInfo,
  BrowserSessionSpec,
  BrowserSnapshot,
  BrowserSnapshotRequest,
  BrowserStateAnswer,
  BrowserStateRequest,
  BrowserTabAnswer,
  BrowserTabRequest,
  BrowserUseCallOptions,
  BrowserUseProvider,
  BrowserUseService,
  BrowserWaitAnswer,
  BrowserWaitRequest,
} from '../definitions/browser-use.ts'
import { createBrowserUseService, validateBrowserUseConfig } from '../core/browser-use-impl/index.ts'
import { createPlaywrightProvider } from '../core/browser-use-playwright/index.ts'
import { resolveProviderConfig } from '../core/browser-use-playwright/config.ts'
import * as browserTools from '../plugins/browser-use-tools/index.ts'

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
  ctx: never
  tools: Map<string, ToolDef>
  unload: () => void
} {
  const tools = new Map<string, ToolDef>()
  const disposers: Array<() => void> = []
  const ctx: Record<string, unknown> = {
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
  return { ctx: ctx as never, tools, unload: () => disposers.splice(0).forEach((dispose) => dispose()) }
}

/** The typed reason of a thrown call, or a loud failure when it is not typed. */
async function reasonOf(call: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await call()
  } catch (error) {
    assert.ok(isBrowserUseError(error), `expected a typed browser-use error, got ${String(error)}`)
    return (error as BrowserUseError).reason
  }
  assert.fail('the call was expected to fail, but it answered')
}

/** The typed `error.reason` a tool body carries (never a generic failure). */
function toolReason(body: unknown): string {
  const record = body as { ok?: boolean; error?: { reason?: string } }
  assert.equal(record.ok, false, `expected a failure body, got ${JSON.stringify(body)}`)
  assert.ok(typeof record.error?.reason === 'string', `expected a typed reason, got ${JSON.stringify(body)}`)
  return record.error.reason as string
}

// ---------------------------------------------------------------------------
// A FAKE provider: it owns a ref table exactly like the real one, so the
// round-trip (snapshot -> act) and the stale-ref rule are provable with no
// browser at all.
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** The provider id (default `fake`). */
  id?: string
  /** The cheap local availability probe (default true). */
  available?: boolean
  /** Why it is unavailable. */
  reason?: string
  /** Fail `openSession` with this typed reason (the no-browser control). */
  openReason?: string
  /** Fail `openSession` with this message (the exact prerequisite). */
  openMessage?: string
  /** The byte size of a fake screenshot (default 128). */
  screenshotBytes?: number
}

function fakeProvider(options: FakeOptions = {}): {
  provider: BrowserUseProvider
  calls: string[]
  clicks: string[]
  optionsSeen: BrowserUseCallOptions[]
} {
  const calls: string[] = []
  const clicks: string[] = []
  const optionsSeen: BrowserUseCallOptions[] = []
  const refTable = new Map<string, string>()
  let snapshotCounter = 0
  let live: BrowserSessionInfo | undefined

  const engine: BrowserEngineInfo = {
    engine: 'chromium',
    version: '1.2.3',
    executablePath: '/fake/chromium',
    headless: true,
    source: 'fake provider (test)',
    available: options.available !== false,
    ...(options.reason === undefined ? {} : { requirement: options.reason }),
  }

  const capabilities: BrowserProviderCapabilities = {
    provider: 'fake',
    engine,
    actKinds: [...ACT_KINDS],
    extractModes: [...EXTRACT_MODES],
    evaluate: true,
    screenshot: true,
    tabs: true,
    observe: true,
    storageState: true,
    unsupported: [],
  }

  const requireLive = (session: string): BrowserSessionInfo => {
    if (live === undefined || live.id !== session) {
      throw new BrowserUseError('browser-use.unknown-session', `no live session '${session}'`, { stage: 'session' })
    }
    return live
  }

  const provider: BrowserUseProvider = {
    id: options.id ?? 'fake',
    available: () => options.available !== false,
    ...(options.reason === undefined ? {} : { unavailableReason: () => options.reason }),
    engine: () => engine,
    capabilities: () => capabilities,
    async openSession(spec: BrowserSessionSpec): Promise<BrowserSessionInfo> {
      const id = spec.session ?? 'default'
      calls.push(`open:${id}`)
      if (options.openReason !== undefined) {
        throw new BrowserUseError(options.openReason as never, options.openMessage ?? 'the fake provider was told to fail', {
          stage: 'launch',
          details: { requirement: options.openMessage },
        })
      }
      live = {
        id,
        provider: 'fake',
        url: 'about:blank',
        title: '',
        engine,
        live: true,
        stateReused: false,
        tabs: 1,
        requests: 0,
        downloads: 0,
        openedAt: 1,
        lastUsedAt: 1,
      }
      return live
    },
    async closeSession(session: string): Promise<BrowserSessionInfo> {
      const info = requireLive(session)
      calls.push(`close:${session}`)
      live = undefined
      refTable.clear()
      return { ...info, live: false, tabs: 0 }
    },
    async navigate(session: string, request: BrowserNavigateRequest): Promise<BrowserNavigateAnswer> {
      const info = requireLive(session)
      calls.push(`navigate:${request.url}`)
      live = { ...info, url: request.url, title: 'Fixture page' }
      return { action: 'navigate', url: request.url, title: 'Fixture page', httpStatus: 200, durationMs: 1 }
    },
    async snapshot(session: string, request: BrowserSnapshotRequest): Promise<BrowserSnapshot> {
      const info = requireLive(session)
      snapshotCounter += 1
      for (const [ref, snapshotId] of refTable) if (snapshotId !== `s${snapshotCounter}`) refTable.delete(ref)
      const nodes = [
        { ref: 'e1', tag: 'h1', name: 'Fixture page', text: 'Fixture page' },
        { ref: 'e2', tag: 'input', name: 'Name', inputType: 'text' },
        { ref: 'e3', tag: 'button', name: 'Send', text: 'Send' },
      ]
      for (const node of nodes) refTable.set(node.ref, `s${snapshotCounter}`)
      calls.push(`snapshot:s${snapshotCounter}`)
      return {
        action: 'snapshot',
        session,
        snapshotId: `s${snapshotCounter}`,
        url: info.url,
        title: info.title,
        nodes,
        totalNodes: nodes.length,
        truncated: false,
        maxNodes: request.maxNodes ?? 120,
        chars: 64,
      }
    },
    async act(session: string, request: BrowserActRequest): Promise<BrowserActAnswer> {
      const info = requireLive(session)
      if (request.ref !== undefined) {
        if (refTable.get(request.ref) === undefined) {
          throw new BrowserUseError(
            'browser-use.stale-ref',
            `the ref '${request.ref}' belongs to no snapshot of this page - take a fresh snapshot`,
            { stage: 'act', details: { ref: request.ref, snapshot: null } },
          )
        }
        if (request.kind === 'click') clicks.push(request.ref)
      }
      calls.push(`act:${request.kind}${request.ref === undefined ? '' : `:${request.ref}`}`)
      return {
        action: 'act',
        kind: request.kind,
        session,
        ...(request.ref === undefined ? {} : { ref: request.ref }),
        url: info.url,
        title: info.title,
        resolved: request.ref !== undefined,
        durationMs: 1,
      }
    },
    async evaluate(session: string, request: { expression: string }): Promise<BrowserEvaluateAnswer> {
      const info = requireLive(session)
      return {
        action: 'evaluate',
        session,
        url: info.url,
        value: request.expression,
        resultType: 'string',
        truncated: false,
        chars: request.expression.length,
      }
    },
    async extract(session: string, request: BrowserExtractRequest): Promise<BrowserExtractAnswer> {
      const info = requireLive(session)
      return {
        action: 'extract',
        session,
        url: info.url,
        title: info.title,
        mode: request.mode ?? 'text',
        text: 'Fixture page',
        chars: 12,
        truncated: false,
      }
    },
    async screenshot(session: string, request: BrowserScreenshotRequest, bounds: BrowserUseCallOptions): Promise<BrowserScreenshotAnswer> {
      const info = requireLive(session)
      optionsSeen.push(bounds)
      const bytes = options.screenshotBytes ?? 128
      const cap = Math.min(request.maxBytes ?? Number.MAX_SAFE_INTEGER, bounds.maxImageBytes)
      if (bytes > cap) {
        throw new BrowserUseError('browser-use.oversized', `the screenshot is ${bytes} bytes, over the cap of ${cap}`, {
          stage: 'screenshot',
          details: { bytes, maxBytes: cap },
        })
      }
      calls.push(`screenshot:${bytes}`)
      return {
        action: 'screenshot',
        session,
        url: info.url,
        path: '/tmp/fake.png',
        format: request.format ?? 'png',
        mime: 'image/png',
        bytes,
        fullPage: request.fullPage === true,
      }
    },
    async tabs(session: string, request: BrowserTabRequest): Promise<BrowserTabAnswer> {
      const info = requireLive(session)
      return {
        action: 'tabs',
        session,
        tabs: [{ index: 0, url: info.url, title: info.title, active: true }],
        activeIndex: 0,
        ...(request.action === 'new' ? { opened: 0 } : {}),
      }
    },
    async wait(session: string, request: BrowserWaitRequest): Promise<BrowserWaitAnswer> {
      const info = requireLive(session)
      return { action: 'wait', session, url: info.url, waitedMs: request.ms ?? 0, satisfied: ['ms'] }
    },
    async observe(session: string, _request: BrowserObserveRequest): Promise<BrowserObserveAnswer> {
      requireLive(session)
      return { action: 'observe', session, requests: [], downloads: [], totalRequests: 0, totalDownloads: 0 }
    },
    async state(session: string, request: BrowserStateRequest): Promise<BrowserStateAnswer> {
      requireLive(session)
      return { action: 'state', session, stateAction: request.action ?? 'save' }
    },
    sessions: () => (live === undefined ? [] : [live]),
  }
  return { provider, calls, clicks, optionsSeen }
}

/** A service host with the fake provider already registered. */
function serviceWithFake(options: FakeOptions = {}): {
  service: BrowserUseService
  calls: string[]
  clicks: string[]
  optionsSeen: BrowserUseCallOptions[]
} {
  const { provider, calls, clicks, optionsSeen } = fakeProvider(options)
  const service = createBrowserUseService({} as never, { provider: 'fake' })
  service.register(provider)
  return { service, calls, clicks, optionsSeen }
}

// ---------------------------------------------------------------------------
// The contract and the host.
// ---------------------------------------------------------------------------

test('contract: the seam is browser-use@1 and the tool is registered under its seam name', async () => {
  assert.equal(BROWSER_USE_CONTRACT, 'browser-use@1')
  assert.equal(BROWSER_USE_TOOL_NAME, 'browser')
  const { service } = serviceWithFake()
  const { ctx, tools, unload } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  assert.ok(tool !== undefined, 'the tool is registered under the seam name')
  assert.match(String(tool?.description), /browser-use\.no-browser/)
  assert.match(String(tool?.description), /stale/)
  const body = await tool?.handler({ action: 'not-an-action' })
  assert.equal(toolReason(body), 'browser-use.not-implemented')
  unload()
})

test('host: a bad config value falls back instead of throwing at load', () => {
  const config = validateBrowserUseConfig({ maxSessions: -3, maxImageBytes: 'nonsense' as never })
  assert.ok(Number.isInteger(config.maxSessions))
  assert.ok(config.maxSessions > 0)
  assert.ok(config.maxImageBytes > 0)
})

test('host: a named provider that is not registered is the typed unknown-provider error', async () => {
  const { service } = serviceWithFake()
  assert.equal(await reasonOf(() => service.open({}, 'ghost')), 'browser-use.unknown-provider')
  assert.equal(await reasonOf(() => service.snapshot('default', {}, 'ghost')), 'browser-use.unknown-provider')
})

test('host: an unavailable provider is reported, never selected, and names the prerequisite', async () => {
  const service = createBrowserUseService({} as never, { provider: 'broken' })
  const { provider } = fakeProvider({
    id: 'broken',
    available: false,
    reason: 'chromium is not installed: set plugins.browser-use-playwright.executablePath',
  })
  service.register(provider)
  const providers: BrowserProviderInfo[] = service.providers()
  assert.equal(providers.length, 1)
  assert.equal(providers[0]?.available, false)
  assert.match(String(providers[0]?.reason), /chromium is not installed/)
  const selection: BrowserSelection = service.selection()
  assert.equal(selection.selected, undefined)
  assert.match(String(selection.reason), /available/)
  assert.equal(await reasonOf(() => service.open({})), 'browser-use.provider-unavailable')
})

test('engine honesty: the capability report carries the real engine, its binary and availability', async () => {
  const { service } = serviceWithFake()
  const report: BrowserCapabilityReport = await service.capabilities()
  assert.equal(report.provider, 'fake')
  assert.equal(report.engine.engine, 'chromium')
  assert.equal(report.engine.available, true)
  assert.equal(report.engine.executablePath, '/fake/chromium')
  assert.equal(report.capabilities.evaluate, true)
  assert.deepEqual(report.capabilities.unsupported, [])
  assert.match(report.configRow, /browser-use-impl/)
})

// ---------------------------------------------------------------------------
// The snapshot/ref round-trip, the stale-ref rule and the typed failures.
// ---------------------------------------------------------------------------

test('refs round-trip: the ref of a snapshot is what `act` accepts on the next call', async () => {
  const { service, calls, clicks } = serviceWithFake()
  const info = await service.open({ session: 's1' })
  assert.equal(info.id, 's1')
  const snapshot = await service.snapshot('s1', {})
  const button = snapshot.nodes.find((node) => node.tag === 'button')
  assert.ok(button !== undefined)
  assert.match(button.ref, /^e[0-9]{1,6}$/)
  const answer: BrowserActAnswer = await service.act('s1', { kind: 'click', ref: button.ref })
  assert.equal(answer.resolved, true)
  assert.equal(answer.ref, button.ref)
  assert.deepEqual(clicks, [button.ref])
  assert.ok(calls.includes(`act:click:${button.ref}`))
})

test('stale ref: a ref that belongs to no snapshot is a typed stale-ref and nothing is clicked', async () => {
  const { service, clicks } = serviceWithFake()
  await service.open({ session: 's1' })
  await service.snapshot('s1', {})
  assert.equal(await reasonOf(() => service.act('s1', { kind: 'click', ref: 'e9999' })), 'browser-use.stale-ref')
  assert.deepEqual(clicks, [], 'a stale ref must never be turned into a click')
})

test('no browser: the typed no-browser error reaches the caller AND the tool body with the requirement', async () => {
  const requirement = 'no chromium binary: install one or set plugins.browser-use-playwright.executablePath'
  const { service } = serviceWithFake({ openReason: 'browser-use.no-browser', openMessage: requirement })
  const error = await service.open({}).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(isBrowserUseError(error))
  assert.equal((error as BrowserUseError).reason, 'browser-use.no-browser')
  assert.match((error as BrowserUseError).message, /executablePath/)

  const { ctx, tools } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const body = await tools.get(BROWSER_USE_TOOL_NAME)?.handler({ action: 'open', session: 's1' })
  assert.equal(toolReason(body), 'browser-use.no-browser')
})

test('tool: a missing session, an unknown action and an unknown parameter are typed answers', async () => {
  const { service } = serviceWithFake()
  const { ctx, tools } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  assert.equal(toolReason(await tool?.handler({ action: 'snapshot' })), 'browser-use.not-implemented')
  assert.equal(toolReason(await tool?.handler({ action: 'open', nonsense: 1 })), 'browser-use.not-implemented')
  assert.equal(toolReason(await tool?.handler({})), 'browser-use.not-implemented')
})

test('tool: the whole session lifecycle answers through one action-enum tool', async () => {
  const { service } = serviceWithFake()
  const { ctx, tools } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  const opened = (await tool?.handler({ action: 'open', session: 's1', url: 'http://127.0.0.1:1/' })) as Record<string, unknown>
  assert.equal(opened.ok, true)
  assert.equal(opened.id, 's1')
  // F2: the top-level url/title of `open { url }` are the POST-navigation values,
  // never the about:blank snapshot of the freshly opened session.
  assert.equal(opened.url, 'http://127.0.0.1:1/')
  assert.equal(opened.title, 'Fixture page')
  assert.equal((opened.navigated as Record<string, unknown> | undefined)?.httpStatus, 200)
  const snapshot = (await tool?.handler({ action: 'snapshot', session: 's1' })) as { ok: boolean; nodes: { ref: string; tag: string }[] }
  assert.equal(snapshot.ok, true)
  assert.ok(snapshot.nodes.length > 0)
  const acted = (await tool?.handler({ action: 'act', session: 's1', kind: 'click', ref: snapshot.nodes[2]?.ref })) as Record<string, unknown>
  assert.equal(acted.ok, true)
  assert.equal(acted.ref, snapshot.nodes[2]?.ref)
  const extracted = (await tool?.handler({ action: 'extract', session: 's1', mode: 'text' })) as Record<string, unknown>
  assert.equal(extracted.ok, true)
  assert.equal(extracted.text, 'Fixture page')
  const sessions = (await tool?.handler({ action: 'sessions' })) as { ok: boolean; sessions: unknown[] }
  assert.equal(sessions.ok, true)
  assert.equal(sessions.sessions.length, 1)
  const closed = (await tool?.handler({ action: 'close', session: 's1' })) as Record<string, unknown>
  assert.equal(closed.ok, true)
  assert.equal(closed.live, false)
})

// ---------------------------------------------------------------------------
// Screenshot cap, disposer, and the recipe non-dependency.
// ---------------------------------------------------------------------------

test('screenshot location: the seam default is ABSOLUTE and the provider config wins over the host bound', () => {
  assert.equal(path.isAbsolute(DEFAULT_SCREENSHOT_DIR), true, `the seam default must be absolute: ${DEFAULT_SCREENSHOT_DIR}`)
  const fromConfig = resolveProviderConfig({ screenshotDir: 'relative-shots' })
  assert.equal(fromConfig.screenshotDir, path.resolve('relative-shots'), 'a relative config value is resolved once, against the CWD')
  const fromBound = resolveProviderConfig({}, { screenshotDir: '/tmp/host-shots' })
  assert.equal(fromBound.screenshotDir, path.resolve('/tmp/host-shots'), 'a deployment that only sets the seam bound is honoured')
  const both = resolveProviderConfig({ screenshotDir: '/tmp/provider-shots' }, { screenshotDir: '/tmp/host-shots' })
  assert.equal(both.screenshotDir, path.resolve('/tmp/provider-shots'), 'the provider owns the file it writes: its own config wins')
  const none = resolveProviderConfig({})
  assert.equal(none.screenshotDir, undefined, 'neither side named a directory: the call site falls back to the absolute seam default')
  assert.equal(path.isAbsolute(none.storageStateDir), true)
  assert.equal(resolveProviderConfig({ storageStateDir: 'relative-state' }).storageStateDir, path.resolve('relative-state'))
})

test('screenshot: a path (never base64) is answered and the byte cap of the seam is enforced', async () => {
  const { service, optionsSeen } = serviceWithFake()
  await service.open({ session: 's1' })
  const shot: BrowserScreenshotAnswer = await service.screenshot('s1', { fullPage: true })
  assert.equal(shot.action, 'screenshot')
  assert.match(shot.path, /\.png$/)
  assert.ok(shot.bytes > 0)
  assert.equal(shot.fullPage, true)
  assert.equal(optionsSeen.length, 1)
  assert.ok((optionsSeen[0]?.maxImageBytes ?? 0) > 0, 'the host hands the byte cap to the provider')
  assert.match(String(optionsSeen[0]?.screenshotDir), /browser-use/)
})

test('screenshot: an image over the caller cap is the typed oversized error, not a truncation', async () => {
  const { service } = serviceWithFake({ screenshotBytes: 2048 })
  await service.open({ session: 's1' })
  assert.equal(await reasonOf(() => service.screenshot('s1', { maxBytes: 512 })), 'browser-use.oversized')
})

test('extract: a deployment WITHOUT a web-recipe service still extracts (a missing recipe never fails)', async () => {
  const { service } = serviceWithFake()
  await service.open({ session: 's1' })
  const answer: BrowserExtractAnswer = await service.extract('s1', { mode: 'text', useRecipe: true })
  assert.equal(answer.text, 'Fixture page')
  assert.notEqual(answer.recipe?.used, true)
})

test('unload: the real provider releases what it owns and disposing twice is safe', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-unit-'))
  const provider = createPlaywrightProvider({ headless: true, storageStateDir: dir, screenshotDir: dir })
  assert.deepEqual(provider.sessions(), [])
  await provider.dispose()
  await provider.dispose()
  assert.deepEqual(provider.sessions(), [])
  const capabilities = provider.capabilities()
  assert.equal(capabilities.provider, 'playwright')
  assert.equal(capabilities.engine.engine, 'chromium')
  assert.equal(typeof capabilities.engine.available, 'boolean')
  if (!capabilities.engine.available) {
    assert.match(String(capabilities.engine.requirement), /chromium|executablePath|playwright/i)
  }
  await fs.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The ONE real end-to-end path: a real browser against a LOCAL fixture page.
// ---------------------------------------------------------------------------

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture page</title></head>
<body>
  <h1>Fixture page</h1>
  <label for="name">Name</label>
  <input id="name" name="name" type="text" aria-label="Name">
  <button id="send" type="button">Send</button>
  <p><a id="next" href="/second.html">Second page</a></p>
  <output id="out"></output>
  <script>
    document.getElementById('send').addEventListener('click', () => {
      document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value
    })
  </script>
</body></html>`

const SECOND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Second page</title></head>
<body><h1>Second page</h1></body></html>`

test('e2e: a REAL browser drives a LOCAL fixture page (open -> snapshot -> act -> extract -> screenshot -> stale-ref -> close)', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-e2e-'))
  // A REAL browser binary: an explicit env var lets a host that HAS a chromium
  // run this end-to-end path instead of skipping. Absent -> the provider probes
  // the playwright cache and the test skips naming the exact prerequisite.
  const executablePath = process.env.BROWSER_USE_CHROMIUM
  const provider = createPlaywrightProvider({
    headless: true,
    storageStateDir: path.join(dir, 'state'),
    screenshotDir: path.join(dir, 'shots'),
    ...(executablePath === undefined || executablePath.length === 0 ? {} : { executablePath }),
  })
  const capabilities = provider.capabilities()
  if (!capabilities.engine.available) {
    await fs.rm(dir, { recursive: true, force: true })
    t.skip(`no browser available (set BROWSER_USE_CHROMIUM=<chrome binary> to run this): ${capabilities.engine.requirement ?? 'unknown requirement'}`)
    return
  }

  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end((request.url ?? '/').startsWith('/second') ? SECOND : FIXTURE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}/`

  // The HOST bound points somewhere else ON PURPOSE: the provider's own
  // `screenshotDir` config must win, and the path it answers must be absolute
  // (defect D1 of thread 2577).
  const hostShots = path.join(dir, 'host-shots')
  const service = createBrowserUseService({} as never, { provider: 'playwright', storageStateDir: path.join(dir, 'state'), screenshotDir: hostShots })
  const unregister = service.register(provider)
  try {
    const session = await service.open({ session: 'e2e', viewport: { width: 900, height: 600 } })
    assert.equal(session.id, 'e2e')
    assert.equal(session.engine.available, true)
    assert.match(String(session.engine.version ?? session.engine.engine), /[0-9]/)

    const navigation = await service.navigate('e2e', { url: base })
    assert.equal(navigation.httpStatus, 200)
    assert.equal(navigation.title, 'Fixture page')

    const first = await service.snapshot('e2e', {})
    assert.ok(first.snapshotId.length > 0)
    const input = first.nodes.find((node) => node.tag === 'input')
    const button = first.nodes.find((node) => node.tag === 'button')
    assert.ok(input !== undefined && button !== undefined, `the fixture exposes an input and a button: ${JSON.stringify(first.nodes)}`)

    const typed = await service.act('e2e', { kind: 'type', ref: input.ref, value: 'Ada' })
    assert.equal(typed.resolved, true)
    const clicked = await service.act('e2e', { kind: 'click', ref: button.ref })
    assert.equal(clicked.resolved, true)

    const extracted = await service.extract('e2e', { mode: 'text' })
    assert.match(String(extracted.text), /Hello Ada/)

    const shot = await service.screenshot('e2e', { fullPage: true })
    const stat = await fs.stat(shot.path)
    assert.ok(stat.size > 0, 'the screenshot file exists and is not empty')
    assert.equal(stat.size, shot.bytes)
    // D1 REGRESSION: an absolute path, in the PROVIDER's configured dir - not the
    // host bound and not relative to whatever CWD the core happens to run in.
    assert.equal(path.isAbsolute(shot.path), true, `the screenshot path must be absolute: ${shot.path}`)
    assert.equal(path.dirname(shot.path), path.join(dir, 'shots'), `the provider config dir must win over the host bound: ${shot.path}`)
    assert.equal(await fs.stat(hostShots).then(() => true, () => false), false, 'nothing is written into the host bound')

    // An EXPLICIT path is honoured too, and still answered as an absolute path.
    const explicitShot = await service.screenshot('e2e', { path: path.join(dir, 'explicit-shot.png') })
    assert.equal(explicitShot.path, path.join(dir, 'explicit-shot.png'))
    assert.equal(await fs.stat(explicitShot.path).then(() => true, () => false), true)

    const evaluation = await service.evaluate('e2e', { expression: 'document.title' })
    assert.equal(evaluation.value, 'Fixture page')

    // STALE REF: a ref that belongs to no snapshot of the current page is a
    // typed stale-ref, and the page is untouched.
    const before = await service.snapshot('e2e', {})
    const staleReason = await reasonOf(() => service.act('e2e', { kind: 'click', ref: 'e9999' }))
    assert.equal(staleReason, 'browser-use.stale-ref')
    const after = await service.snapshot('e2e', {})
    assert.equal(after.url, before.url)

    const closed = await service.close('e2e')
    assert.equal(closed.live, false)
    assert.deepEqual(provider.sessions(), [])
  } finally {
    unregister()
    await provider.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
})
