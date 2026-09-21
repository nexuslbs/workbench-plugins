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
import { validateArgs } from '../definitions/tools.ts'

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
      // The RAW observation contract: a navigate answer carries the transport,
      // the document, the frame tree and the navigations of the load it produced.
      const load = {
        transport: {
          requestedUrl: request.url,
          finalUrl: request.url,
          httpStatus: 200,
          statusText: 'OK',
          responseHeaders: {},
          redirects: [],
        },
        document: {
          title: 'Fixture page',
          bodyTextExcerpt: 'Fixture page',
          htmlLength: 64,
          formCount: 0,
          textLength: 12,
        },
        resources: { total: 1, failed: [] },
        cookiesSet: [],
        timing: { startedAt: '1970-01-01T00:00:00.000Z', endedAt: '1970-01-01T00:00:00.001Z', durationMs: 1 },
        browserInitiatedNavigations: [],
        frames: [],
      }
      return {
        action: 'navigate',
        session,
        url: request.url,
        title: 'Fixture page',
        httpStatus: 200,
        durationMs: 1,
        load,
        navigations: [],
        browserInitiatedNavigations: [],
        actions: [],
        startedAt: '1970-01-01T00:00:00.000Z',
        endedAt: '1970-01-01T00:00:00.001Z',
      }
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
    const requirement = capabilities.engine.requirement ?? 'unknown requirement'
    // A suite that is green only because the browser tests SKIP cannot gate a
    // browser-PROVISIONING deployment: `BROWSER_USE_REQUIRE_BROWSER=1` (the
    // `npm run test:browser` script and CI) turns the skip into a FAILURE.
    if (process.env.BROWSER_USE_REQUIRE_BROWSER === '1') {
      assert.fail(`no browser available and BROWSER_USE_REQUIRE_BROWSER=1: ${requirement}`)
    }
    t.skip(`no browser available (set BROWSER_USE_CHROMIUM=<chrome binary> to run this): ${requirement}`)
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

// ---------------------------------------------------------------------------
// SEAM ERGONOMICS (thread 2592): the contract is INTROSPECTABLE, the parameter
// names an agent really guesses are ALIASES, a stale ref heals ONCE, and an
// unreachable remote browser is a TYPED error naming the endpoint.
// ---------------------------------------------------------------------------

test('schema: the tool publishes the FULL per-action contract (names, types, required, aliases, units)', async () => {
  const { service } = serviceWithFake()
  const { ctx, tools, unload } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  const body = (await tool?.handler({ action: 'schema' })) as {
    ok?: boolean
    durationUnits?: string
    aliasPolicy?: string
    actions?: Array<{ action: string; parameters: Record<string, { type?: string; required?: boolean }>; required: string[]; aliases: Record<string, string> }>
  }
  assert.equal(body.ok, true)
  assert.match(String(body.durationUnits), /MILLISECONDS/)
  assert.match(String(body.aliasPolicy), /canonical name wins/)
  const actions = body.actions ?? []
  assert.ok(actions.length >= 10, `every action is published, got ${actions.length}`)
  const byAction = new Map(actions.map((entry) => [entry.action, entry]))
  const act = byAction.get('act')
  assert.ok(act !== undefined)
  assert.equal(act?.parameters.value?.type, 'string')
  assert.deepEqual([...(act?.required ?? [])].sort(), ['kind', 'session'])
  assert.equal(act?.aliases.text, 'value')
  assert.equal(act?.aliases.timeout, 'timeoutMs')
  assert.equal(byAction.get('wait')?.aliases.milliseconds, 'ms')
  assert.equal(byAction.get('open')?.aliases.storageStateFile, 'stateFile')
  assert.equal(byAction.get('open')?.aliases.storageState, 'stateFile')
  // The schema cannot drift from the parameters the tools provider publishes.
  assert.equal((tool?.parameters?.value as { type?: string } | undefined)?.type, 'string')
  // ALIASES ARE PUBLISHED TOO, and that is LOAD-BEARING (measured live, task 2592):
  // the tools surface REJECTS a key that is not in the parameter map
  // (`invalid-params`, naming it) BEFORE the handler runs, so an alias missing
  // from the map can never reach the rewrite. `action: schema` documents the
  // rewrite under `aliases`; the map is what makes it reachable.
  assert.equal((tool?.parameters?.storageStateFile as { type?: string } | undefined)?.type, 'string')
  for (const entry of actions) {
    for (const alias of Object.keys(entry.aliases)) {
      assert.ok(
        tool?.parameters?.[alias] !== undefined,
        `alias '${alias}' of '${entry.action}' is declared in the published parameter map`,
      )
    }
  }
  const one = (await tool?.handler({ action: 'schema', schemaFor: 'wait' })) as { actions?: Array<{ action: string }> }
  assert.deepEqual(one.actions?.map((entry) => entry.action), ['wait'])
  assert.equal(toolReason(await tool?.handler({ action: 'schema', schemaFor: 'nope' })), 'browser-use.not-implemented')
  unload()
})

test('aliases: the tools SURFACE accepts every alias (an undeclared key is rejected before the handler runs)', async () => {
  const { ctx, tools, unload } = harness({})
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  const spec = tool?.parameters as never
  assert.deepEqual(validateArgs(spec, { action: 'wait', session: 's1', milliseconds: 150 }), [], '`milliseconds` passes the surface')
  assert.deepEqual(validateArgs(spec, { action: 'act', session: 's1', kind: 'fill', text: 'x' }), [], '`text` passes the surface')
  assert.deepEqual(validateArgs(spec, { action: 'open', session: 's1', storageStateFile: '/tmp/x.json' }), [], '`storageStateFile` passes the surface')
  assert.deepEqual(validateArgs(spec, { action: 'open', session: 's1', storageState: '/tmp/x.json' }), [], '`storageState` passes the surface')
  assert.deepEqual(validateArgs(spec, { action: 'navigate', session: 's1', url: 'https://x.test/', timeout: 1000 }), [], '`timeout` passes the surface')
  const typos = validateArgs(spec, { action: 'act', session: 's1', kind: 'click', textt: 'typo' })
    assert.equal(typos.length, 1, 'a genuine typo is still rejected BY THE SURFACE')
    assert.ok(typos[0]?.startsWith('textt: unknown parameter'), typos[0])
    // The accepted keys travel WITH the violation: no second roundtrip to learn them.
    assert.ok(typos[0]?.includes('accepted here:') && typos[0]?.includes('value') && typos[0]?.includes('ref'), typos[0])
  unload()
})

/** Records what the TOOL hands the SEAM, so an alias is provable end to end. */
function spyService(): {
  service: Record<string, unknown>
  acts: BrowserActRequest[]
  waits: BrowserWaitRequest[]
  opens: BrowserSessionSpec[]
} {
  const acts: BrowserActRequest[] = []
  const waits: BrowserWaitRequest[] = []
  const opens: BrowserSessionSpec[] = []
  const info = (id: string): BrowserSessionInfo => ({
    id,
    provider: 'spy',
    url: 'about:blank',
    title: '',
    engine: { engine: 'chromium', available: true } as never as BrowserEngineInfo,
    live: true,
    stateReused: false,
    tabs: 1,
    requests: 0,
    downloads: 0,
    openedAt: 1,
    lastUsedAt: 1,
  })
  const service: Record<string, unknown> = {
    selection: () => ({ provider: 'spy', selected: 'spy' }),
    providers: () => [],
    async open(spec: BrowserSessionSpec): Promise<BrowserSessionInfo> {
      opens.push(spec)
      return info(spec.session ?? 'default')
    },
    async act(session: string, request: BrowserActRequest): Promise<BrowserActAnswer> {
      acts.push(request)
      return { action: 'act', kind: request.kind, session, url: 'about:blank', title: '', resolved: true, durationMs: 1 }
    },
    async wait(session: string, request: BrowserWaitRequest): Promise<BrowserWaitAnswer> {
      waits.push(request)
      return { action: 'wait', session, url: 'about:blank', waitedMs: request.ms ?? 0, satisfied: [] }
    },
  }
  return { service, acts, waits, opens }
}

test('aliases: `text` on act reaches the seam as `value`, `milliseconds` on wait as `ms`, `storageStateFile` on open as `stateFile`', async () => {
  const { service, acts, waits, opens } = spyService()
  const { ctx, tools, unload } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  await tool?.handler({ action: 'open', session: 's1', storageStateFile: '/tmp/alias-state.json' })
  assert.equal(opens[0]?.storageStateFile, '/tmp/alias-state.json', '`storageStateFile` is the `stateFile` of the open spec')
  await tool?.handler({ action: 'act', session: 's1', kind: 'type', ref: 'e1', text: 'Ada' })
  assert.equal(acts[0]?.value, 'Ada', '`text` is the `value` of act')
  await tool?.handler({ action: 'act', session: 's1', kind: 'type', ref: 'e1', value: 'canonical', text: 'ignored' })
  assert.equal(acts[1]?.value, 'canonical', 'the canonical name WINS when both are given')
  await tool?.handler({ action: 'wait', session: 's1', milliseconds: 250 })
  assert.equal(waits[0]?.ms, 250, '`milliseconds` is the wait duration')
  await tool?.handler({ action: 'wait', session: 's1', ms: 99, milliseconds: 250 })
  assert.equal(waits[1]?.ms, 99, 'the canonical name WINS when both are given')
  await tool?.handler({ action: 'act', session: 's1', kind: 'click', ref: 'e1', timeout: 1500 })
  assert.equal(acts[2]?.timeoutMs, 1500, '`timeout` is the ms budget of act')
  unload()
})

test('aliases: a genuinely unknown parameter is a typed answer that LISTS the accepted keys and the aliases', async () => {
  const { service } = spyService()
  const { ctx, tools, unload } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  const body = await tool?.handler({ action: 'act', session: 's1', kind: 'click', textt: 'typo' })
  assert.equal(toolReason(body), 'browser-use.not-implemented')
  const message = String((body as { error?: { message?: string } }).error?.message)
  assert.match(message, /unknown parameter\(s\) for 'action: act': textt/)
  assert.match(message, /accepted: .*value/)
  assert.match(message, /aliases: .*text/)
  const details = (body as { error?: { details?: { accepted?: string[]; aliases?: Record<string, string> } } }).error?.details
  assert.ok((details?.accepted ?? []).includes('value'), 'the accepted keys are in the details an agent reads')
  assert.equal(details?.aliases?.text, 'value')
  unload()
})

test('wsEndpoint: the provider ATTACHES to a remote CDP browser, and an unreachable endpoint is a TYPED error naming it (never a local launch)', async () => {
  const endpoint = 'ws://127.0.0.1:9/devtools/browser/does-not-exist'
  const resolved = resolveProviderConfig({ wsEndpoint: endpoint, launchTimeoutMs: 1500 })
  assert.equal(resolved.wsEndpoint, endpoint)
  assert.equal(
    resolveProviderConfig({ cdpEndpoint: endpoint }).wsEndpoint,
    endpoint,
    '`cdpEndpoint` is the documented alias of `wsEndpoint`',
  )
  const provider = createPlaywrightProvider({ wsEndpoint: endpoint, launchTimeoutMs: 1500 })
  const engine = provider.engine()
  assert.equal(engine.available, true, 'a configured endpoint IS the browser: no local binary is required')
  assert.match(String(engine.source), /127\.0\.0\.1:9/, 'the engine report names the endpoint it attaches to')
  const service = createBrowserUseService({} as never, { provider: 'playwright' })
  service.register(provider)
  let caught: unknown
  try {
    await service.open({ session: 'remote' })
  } catch (error) {
    caught = error
  }
  await provider.dispose()
  assert.ok(isBrowserUseError(caught), `expected a typed browser-use error, got ${String(caught)}`)
  assert.equal((caught as BrowserUseError).reason, 'browser-use.endpoint-unreachable')
  assert.match((caught as BrowserUseError).message, /127\.0\.0\.1:9/)
})
// ---------------------------------------------------------------------------
// The SEPARATE browser image (operator correction, telegram thread 2593): the
// workbench process holds NO browser, the browser service runs from its OWN
// image and is reached - and, when needed, STARTED - through the
// `general-service@1` seam. These tests pin that contract.
// ---------------------------------------------------------------------------

test('browserService: the block resolves ONE attach endpoint and a broken block is a LOUD invalid-config', () => {
  const resolved = resolveProviderConfig({
    browserService: {
      endpoint: 'http://127.0.0.1:9222',
      image: 'mcr.microsoft.com/playwright:v1.63.0-noble',
      generalService: { type: 'container', params: { container: 'workbench-browser' } },
      start: 'chromium --headless --remote-debugging-port=9222 about:blank',
    },
  })
  assert.equal(
    resolved.wsEndpoint,
    'http://127.0.0.1:9222',
    'the browserService endpoint IS the attach endpoint: one value downstream',
  )
  assert.equal(resolved.browserService?.image, 'mcr.microsoft.com/playwright:v1.63.0-noble')
  assert.equal(resolved.browserService?.generalService?.params.container, 'workbench-browser')
  assert.equal(resolved.browserService?.startTimeoutMs, 20_000, 'a start budget has a sane default')
  // The workbench process is NOT given a local binary by this config.
  assert.equal(resolved.executablePath, undefined)
  let caught: unknown
  try {
    resolveProviderConfig({ browserService: { image: 'x' } })
  } catch (error) {
    caught = error
  }
  assert.ok(caught !== undefined, 'a browserService block without a usable endpoint must not be ignored silently')
  assert.match(String((caught as Error).message), /browserService\.endpoint/)
})

test('browserService: an unreachable service is a TYPED error naming the endpoint, the image and the instance', async () => {
  const provider = createPlaywrightProvider(
    {
      browserService: {
        endpoint: 'http://127.0.0.1:9/',
        image: 'mcr.microsoft.com/playwright:v1.63.0-noble',
        generalService: { type: 'container', params: { container: 'workbench-browser' } },
      },
      launchTimeoutMs: 1_000,
    },
    undefined,
    undefined,
  )
  const engine = provider.engine()
  assert.equal(engine.available, true, 'a configured browser service IS the browser: no local binary is required')
  assert.match(String(engine.source), /127\.0\.0\.1:9/, 'the engine report names the endpoint')
  assert.match(String(engine.source), /mcr\.microsoft\.com\/playwright/, 'the engine report names the browser IMAGE')
  const service = createBrowserUseService({} as never, { provider: 'playwright' })
  service.register(provider)
  let caught: unknown
  try {
    await service.open({ session: 'remote-service' })
  } catch (error) {
    caught = error
  }
  await provider.dispose()
  assert.ok(isBrowserUseError(caught), `expected a typed browser-use error, got ${String(caught)}`)
  assert.equal((caught as BrowserUseError).reason, 'browser-use.endpoint-unreachable')
  const message = (caught as BrowserUseError).message
  assert.match(message, /127\.0\.0\.1:9/, 'the error names the endpoint')
  assert.match(message, /mcr\.microsoft\.com\/playwright/, 'the error names the browser image')
  assert.match(message, /general-service@1/, 'the error names the seam that would start it')
  assert.match(message, /NEVER part of the workbench image/, 'the error states the deployment model')
  assert.equal((caught as BrowserUseError).details.fallback, 'none', 'no silent local launch, no silent fetch')
})

test('browserService: the provider STARTS the service through general-service@1 and reports what it ran', async () => {
  const calls: Array<{ type: string; params: Record<string, unknown>; command: string }> = []
  const generalService = {
    create(config: { type: string; params: Record<string, unknown> }) {
      return {
        async call(command: string) {
          calls.push({ type: config.type, params: config.params, command })
          return { output: 'chrome: no such file or directory', code: 127 }
        },
      }
    },
  }
  const provider = createPlaywrightProvider(
    {
      browserService: {
        endpoint: 'http://127.0.0.1:19222',
        image: 'mcr.microsoft.com/playwright:v1.63.0-noble',
        generalService: { type: 'container', params: { container: 'workbench-browser' } },
        start: 'chromium --headless --remote-debugging-port=19222 about:blank',
      },
      launchTimeoutMs: 1_000,
    },
    undefined,
    generalService,
  )
  const service = createBrowserUseService({} as never, { provider: 'playwright' })
  service.register(provider)
  let caught: unknown
  try {
    await service.open({ session: 'start-me' })
  } catch (error) {
    caught = error
  }
  await provider.dispose()
  assert.equal(calls.length, 1, 'the start command ran exactly once, through the seam')
  assert.equal(calls[0]?.type, 'container', 'the transport is the CONFIG type, never hard-wired by the provider')
  assert.equal(calls[0]?.params.container, 'workbench-browser')
  assert.equal(calls[0]?.command, 'chromium --headless --remote-debugging-port=19222 about:blank')
  const details = (caught as BrowserUseError).details as {
    browserServiceStart?: { attempted?: boolean; code?: number; type?: string; output?: string }
  }
  assert.equal(details.browserServiceStart?.attempted, true, 'the call result PROVES the start path was taken')
  assert.equal(details.browserServiceStart?.code, 127)
  assert.equal(details.browserServiceStart?.type, 'container')
  assert.match(String(details.browserServiceStart?.output), /no such file/)
  assert.match((caught as BrowserUseError).message, /browser service start/)
})

test('browserService: a start that succeeds but never listens reports the wait, and still never falls back', async () => {
  const provider = createPlaywrightProvider(
    {
      browserService: {
        endpoint: 'http://127.0.0.1:9/',
        generalService: { type: 'shell', params: {} },
        start: 'true',
        startTimeoutMs: 1,
      },
      launchTimeoutMs: 500,
    },
    undefined,
    { create: () => ({ async call() { return { output: '', code: 0 } } }) },
  )
  const service = createBrowserUseService({} as never, { provider: 'playwright' })
  service.register(provider)
  let caught: unknown
  try {
    await service.open({ session: 'start-wait' })
  } catch (error) {
    caught = error
  }
  await provider.dispose()
  assert.equal((caught as BrowserUseError).reason, 'browser-use.endpoint-unreachable')
  const details = (caught as BrowserUseError).details as {
    browserServiceStart?: { attempted?: boolean; code?: number; connected?: boolean; waitedMs?: number }
  }
  assert.equal(details.browserServiceStart?.attempted, true)
  assert.equal(details.browserServiceStart?.code, 0, 'the start DID succeed')
  assert.equal(details.browserServiceStart?.connected, false, 'yet the endpoint never answered: the attach failed')
  assert.equal(details.browserServiceStart?.waitedMs, 1)
  assert.match((caught as BrowserUseError).message, /waited 1 ms for the endpoint/)
})


// ---------------------------------------------------------------------------
// The SEAM end-to-end (real browser): a stale ref HEALS itself once, and a
// timeout on a control the call DID resolve NAMES the element and the reason.
// ---------------------------------------------------------------------------

const RETRY_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Retry page</title></head>
<body>
  <h1>Retry page</h1>
  <div id="host"><button id="send" type="button">Send</button></div>
  <output id="out"></output>
  <script>
    // Every render STAMPS the generation of the node it creates, so the click
    // handler can say WHICH node was clicked: 'clicked-gen2' can only come from
    // the RE-RENDERED button (the pre-render node would answer 'clicked-gen1').
    let generation = 0
    function render() {
      generation += 1
      const gen = generation
      const host = document.getElementById('host')
      host.innerHTML = '<button id="send" type="button">Send</button>'
      document.getElementById('send').addEventListener('click', function () {
        document.getElementById('out').textContent = 'clicked-gen' + gen
      })
    }
    window.rerender = render
    render()
  </script>
</body></html>`

const DROP_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Drop page</title></head>
<body>
  <h1>Drop page</h1>
  <div id="host"><button id="send" type="button">Send</button></div>
  <script>
    window.drop = function () {
      document.getElementById('host').innerHTML = '<p>The button is gone</p>'
    }
  </script>
</body></html>`

const COVERED_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Covered page</title></head>
<body>
  <h1>Covered page</h1>
  <div id="host"><button id="send" type="button">Send</button></div>
  <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.01);z-index:5"></div>
</body></html>`

test('e2e seam: a stale ref is re-snapshotted and retried ONCE; an unrecoverable one fails WITH the fresh refs; a covered control times out NAMING itself', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-recovery-'))
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
    const requirement = capabilities.engine.requirement ?? 'unknown requirement'
    if (process.env.BROWSER_USE_REQUIRE_BROWSER === '1') {
      assert.fail(`no browser available and BROWSER_USE_REQUIRE_BROWSER=1: ${requirement}`)
    }
    t.skip(`no browser available (set BROWSER_USE_CHROMIUM=<chrome binary> to run this): ${requirement}`)
    return
  }
  const server = http.createServer((request, response) => {
    const url = request.url ?? '/'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(url.startsWith('/drop') ? DROP_PAGE : url.startsWith('/covered') ? COVERED_PAGE : RETRY_PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  const service = createBrowserUseService({} as never, {
    provider: 'playwright',
    storageStateDir: path.join(dir, 'state'),
    screenshotDir: path.join(dir, 'shots'),
  })
  const unregister = service.register(provider)
  try {
    await service.open({ session: 'seam', viewport: { width: 900, height: 600 } })

    // (1) RECOVERY: the page re-renders the button, the old ref is stale, and
    // the seam re-snapshots + re-resolves it by role+name ONCE and clicks the
    // RE-RENDERED node (proved by the effect of the click, not by the status).
    await service.navigate('seam', { url: `${base}/` })
    const first = await service.snapshot('seam', {})
    const button = first.nodes.find((node) => node.tag === 'button')
    assert.ok(button !== undefined, `the retry fixture exposes a button: ${JSON.stringify(first.nodes)}`)
    await service.evaluate('seam', { expression: 'window.rerender()' })
    const healed = await service.act('seam', { kind: 'click', ref: button.ref })
    assert.equal(healed.resolved, true)
    assert.equal(healed.refRetry?.attempted, true, `the recovery must be REPORTED: ${JSON.stringify(healed)}`)
    assert.equal(healed.refRetry?.recovered, true, `the recovery must have SUCCEEDED: ${JSON.stringify(healed)}`)
    // The FRESHNESS proof is the SNAPSHOT, not the ref LABEL: refs are minted
    // deterministically per DOM traversal (`e1`, `e2`, ...), so the re-rendered
    // button legitimately gets the SAME label again (`refRetry.to === button.ref`
    // is the CORRECT outcome for stable refs). What must be fresh is the
    // snapshot the retry worked from, and what proves the action ran against
    // the RE-RENDERED node is the node's own generation stamp below.
    assert.notEqual(
      healed.refRetry?.snapshotId,
      first.snapshotId,
      `the retry must work from a FRESH snapshot, not the one that minted the stale ref: ${JSON.stringify(healed)}`,
    )
    assert.match(String(healed.refRetry?.snapshotId), /^s[0-9]+$/)
    const effect = await service.evaluate('seam', { expression: "document.getElementById('out').textContent" })
    assert.equal(effect.value, 'clicked-gen2', 'the click really landed on the re-rendered node (generation 2), not on the pre-render one')

    // (2) UNRECOVERABLE: the element truly left the page. The typed stale-ref
    // carries the FRESH snapshot refs in details.nodes, so the caller can pick
    // one without a second call.
    await service.navigate('seam', { url: `${base}/drop` })
    const doomed = await service.snapshot('seam', {})
    const gone = doomed.nodes.find((node) => node.tag === 'button')
    assert.ok(gone !== undefined, `the drop fixture exposes a button: ${JSON.stringify(doomed.nodes)}`)
    await service.evaluate('seam', { expression: 'window.drop()' })
    let caught: unknown
    try {
      await service.act('seam', { kind: 'click', ref: gone.ref })
    } catch (error) {
      caught = error
    }
    assert.ok(isBrowserUseError(caught), `expected a typed browser-use error, got ${String(caught)}`)
    assert.equal((caught as BrowserUseError).reason, 'browser-use.stale-ref')
    const details = (caught as BrowserUseError).details as { retried?: boolean; snapshotId?: string; nodes?: unknown[] } | undefined
    assert.equal(details?.retried, true, 'the failure reports that the automatic retry ALREADY ran')
    assert.ok(Array.isArray(details?.nodes) && (details?.nodes?.length ?? 0) > 0, `the FRESH refs ride along: ${JSON.stringify(details)}`)
    assert.match((caught as BrowserUseError).message, /details\.nodes/)

    // (3) TIMEOUT WITH EVIDENCE: the control is resolved but an overlay swallows
    // the pointer. The caller gets the ELEMENT and the REASON, not a bare
    // "Timeout exceeded".
    await service.navigate('seam', { url: `${base}/covered` })
    const covered = await service.snapshot('seam', {})
    const blocked = covered.nodes.find((node) => node.tag === 'button')
    assert.ok(blocked !== undefined, `the covered fixture exposes a button: ${JSON.stringify(covered.nodes)}`)
    let timedOut: unknown
    try {
      await service.act('seam', { kind: 'click', ref: blocked.ref, timeoutMs: 900 })
    } catch (error) {
      timedOut = error
    }
    assert.ok(isBrowserUseError(timedOut), `expected a typed browser-use error, got ${String(timedOut)}`)
    assert.equal((timedOut as BrowserUseError).reason, 'browser-use.timeout')
    assert.match((timedOut as BrowserUseError).message, /COVERED/)
    assert.match((timedOut as BrowserUseError).message, new RegExp(blocked.ref))
    const diagnosis = ((timedOut as BrowserUseError).details as { diagnosis?: string[] } | undefined)?.diagnosis ?? []
    assert.ok(diagnosis.some((entry) => /COVERED/.test(entry)), `the diagnosis names the reason: ${JSON.stringify(diagnosis)}`)

    await service.close('seam')
  } finally {
    unregister()
    await provider.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// FRAMES / MOUSE (task 2617, corrected 2026-09-21): a real page often hides
// its interesting half in a CROSS-ORIGIN frame the page's own DOM does not even
// admit exists, so the BROWSER's frame tree is the only honest source and the
// REAL mouse is the only way in. Both are purely structural: nothing here
// classifies a page, matches a keyword or names a vendor.
// ---------------------------------------------------------------------------

test('tool: frames/mouse/challenge are published (required params, aliases) and their parameters reach the surface', async () => {
  const { service } = serviceWithFake()
  const { ctx, tools, unload } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  const body = (await tool?.handler({ action: 'schema' })) as {
    ok?: boolean
    actions?: Array<{ action: string; parameters: Record<string, unknown>; required: string[]; aliases: Record<string, string> }>
  }
  assert.equal(body.ok, true)
  const byAction = new Map((body.actions ?? []).map((entry) => [entry.action, entry]))
  for (const action of ['frames', 'mouse']) {
    const entry = byAction.get(action)
    assert.ok(entry !== undefined, `'${action}' is published, got ${[...byAction.keys()].join(', ')}`)
    assert.deepEqual([...(entry?.required ?? [])].sort(), ['session'], `'${action}' needs a session: ${JSON.stringify(entry)}`)
  }
  assert.equal(byAction.get('frames')?.aliases.url, 'frameUrl')
  assert.equal(byAction.get('frames')?.aliases.index, 'frameIndex')
  assert.equal(byAction.get('frames')?.aliases.name, 'frameName')
  assert.equal(byAction.get('mouse')?.aliases.timeout, 'timeoutMs')
  assert.ok(!byAction.has('challenge'), 'the removed classifier action is NOT published')
  assert.ok(byAction.get('mouse')?.parameters.x !== undefined, 'the mouse action publishes its coordinates')
  assert.ok(byAction.get('mouse')?.parameters.steps !== undefined)
  assert.ok(byAction.get('frames')?.parameters.frameId !== undefined)
  // The published tool surface accepts the canonical AND the aliased spellings.
  const spec = tool?.parameters as never
  assert.deepEqual(validateArgs(spec, { action: 'frames', session: 's1' }), [], '`frames` needs only a session')
  assert.deepEqual(
    validateArgs(spec, { action: 'frames', session: 's1', frameAction: 'select', frameUrl: 'https://widget.test/x' }),
    [],
    '`frameAction: select` + `frameUrl`',
  )
  assert.deepEqual(
    validateArgs(spec, { action: 'frames', session: 's1', frameAction: 'select', url: 'https://widget.test/x', index: 0, name: 'w' }),
    [],
    'the frames aliases (`url`/`index`/`name`) pass the surface',
  )
  assert.deepEqual(validateArgs(spec, { action: 'mouse', session: 's1', mouseAction: 'click', x: 100, y: 220 }), [], 'coordinate mouse')
  assert.ok(validateArgs(spec, { action: 'mouse', session: 's1', x: 1 }).length > 0 === false, 'x without y stays a runtime check')
  unload()
})

test('tool: a `frames` select WITHOUT a target is invalid-input, WITH an alias target it reaches the provider (typed not-implemented on a provider without frames)', async () => {
  const { service } = serviceWithFake()
  const { ctx, tools, unload } = harness({ 'browser-use': service })
  browserTools.apply(ctx)
  const tool = tools.get(BROWSER_USE_TOOL_NAME)
  await service.open({ session: 'tf' })
  assert.equal(
    toolReason(await tool?.handler({ action: 'frames', session: 'tf', frameAction: 'select' })),
    'browser-use.invalid-input',
    'a select with no frame target is refused, never silently the main frame',
  )
  assert.equal(
    toolReason(await tool?.handler({ action: 'frames', session: 'tf', frameAction: 'select', url: 'https://widget.test/x' })),
    'browser-use.not-implemented',
    'the `url` alias RESOLVED into a frame target and the call was forwarded (the fake provider has no frames)',
  )
  assert.equal(
    toolReason(await tool?.handler({ action: 'mouse', session: 'tf', x: 10, y: 20 })),
    'browser-use.not-implemented',
    'the coordinate mouse is forwarded too',
  )
  unload()
})

test('host: frames/mouse FORWARD to a provider that implements them (session + validated request round-trip)', async () => {
  const { provider } = fakeProvider()
  const seen: { method: string; session: string; request: Record<string, unknown> }[] = []
  const patched = provider as unknown as Record<string, unknown>
  patched.frames = async (session: string, request: Record<string, unknown>) => {
    seen.push({ method: 'frames', session, request })
    return {
      action: 'frames',
      session,
      url: 'https://demo.test/',
      title: 'demo',
      mainFrameId: 'M',
      frames: [{ frameId: 'M', frameIdSource: 'cdp', url: 'https://demo.test/', depth: 0, isMainFrame: true, crossOrigin: false }],
      totalFrames: 1,
      selectedFrameId: 'M',
      durationMs: 1,
    }
  }
  patched.mouse = async (session: string, request: Record<string, unknown>) => {
    return {
      action: 'mouse',
      session,
      mouseAction: (request.mouseAction as string) ?? 'click',
      x: Number(request.x),
      y: Number(request.y),
      relativeTo: 'page',
      button: 'left',
      url: 'https://demo.test/',
      title: 'demo',
      durationMs: 1,
    }
  }
  const service = createBrowserUseService({} as never, { provider: 'fake' })
  service.register(provider)
  await service.open({ session: 'fw' })
  const frames = await service.frames('fw', { frameAction: 'list' })
  assert.equal(frames.action, 'frames')
  assert.equal(frames.mainFrameId, 'M')
  const mouse = await service.mouse('fw', { x: 12, y: 34 })
  assert.equal(mouse.x, 12)
  assert.equal(mouse.y, 34)
  assert.deepEqual(seen.map((entry) => entry.method), ['frames', 'mouse'])
  assert.equal(seen[0]?.session, 'fw', 'the session is forwarded')
  assert.deepEqual(seen[0]?.request, { frameAction: 'list' }, `the validated request is forwarded verbatim: ${JSON.stringify(seen[0])}`)
  assert.equal(seen[1]?.request.mouseAction, 'click', `the mouse action defaults are applied before forwarding: ${JSON.stringify(seen[1])}`)
  assert.equal(seen[1]?.request.x, 12)
  await service.close('fw')
})
