/**
 * THE REAL-BROWSER GATE (task `browser-use`, redispatch 2026-09-21).
 *
 * WHAT IT MEASURES. A browser SERVICE that is meant to be a browser must (a) be
 * launched as a real browser (no headless flag, a real display, plugins, a WebGL
 * renderer), (b) hand back the RAW facts of a load (status, headers verbatim,
 * document, frame tree from the ENGINE, cookies by NAME only) instead of a
 * verdict, and (c) accept REAL pointer input inside a cross-origin control the
 * page offers, waiting for the navigation the PAGE performs itself.
 *
 * It carries NO vocabulary of any verification vendor: the product has no
 * keyword table, no vendor flag and no classification layer, and A12 below
 * fails the build if one ever appears in the product source.
 *
 * HOW TO RUN
 *
 *   BROWSER_USE_CDP_ENDPOINT=http://<browser host>:9222 \
 *     npm test -- browser-real-page
 *
 * Without the endpoint the deployment tests SKIP, naming the prerequisite,
 * because the DEPLOYED browser service is what they measure;
 * `BROWSER_USE_REQUIRE_CDP=1` turns that skip into a FAILURE (the documented
 * one-command gate sets it).
 *
 * THE TWO LAYERS
 *
 *  * DETERMINISTIC: every origin used here is served BY THIS TEST on loopback -
 *    a refusal (429 + `retry-after`), a page that offers a cross-origin control
 *    in a place its own DOM cannot see (a closed shadow root), and a landing
 *    page the CONTROL navigates the top frame to, triggered by a real pointer
 *    click. Zero third-party traffic, zero throttle risk, 100% reproducible.
 *  * OBSERVATIONAL: point BROWSER_USE_REAL_TARGETS at public URLs and the last
 *    test reports their raw observations into
 *    `artifacts/browser-real-page/<ts>.json`. It never fails on what a third
 *    party answers today - only a STRUCTURAL regression fails.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { connectTarget, createPlaywrightProvider } from '../core/browser-use-playwright/index.ts'
import { createBrowserUseService } from '../core/browser-use-impl/index.ts'
import { resolveBrowserUseBounds } from '../definitions/browser-use.ts'
import type { BrowserNavigateAnswer, BrowserMouseAnswer } from '../definitions/browser-use.ts'

const ENDPOINT = process.env.BROWSER_USE_CDP_ENDPOINT ?? ''

/**
 * The per-call bounds the HOST would resolve. The provider methods take them as
 * their last argument; this file calls the provider DIRECTLY in the two places
 * where it must read the page (A8, the DOM-vs-frame-tree comparison), so it
 * hands the provider the same bounds a host call carries.
 */
const CALL_OPTIONS = resolveBrowserUseBounds({})
const REQUIRE_CDP = process.env.BROWSER_USE_REQUIRE_CDP === '1'

/**
 * The address the BROWSER must use to reach the fixture origins served here.
 *
 * The gate measures a DEPLOYED browser service, which normally runs in its own
 * container: a fixture bound to loopback would be unreachable for it (the
 * browser's own loopback is a different one). Every fixture therefore binds
 * 0.0.0.0 and the URLs advertise this process's first non-loopback IPv4 - the
 * address a peer on the same network can reach. The two servers sit on two
 * different ports, and the port is part of an origin, which is what makes the
 * control frame CROSS-ORIGIN. `BROWSER_USE_FIXTURE_HOST` overrides the address
 * when the caller knows better.
 */
function fixtureHost(): string {
  const declared = (process.env.BROWSER_USE_FIXTURE_HOST ?? '').trim()
  if (declared.length > 0) return declared
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return '127.0.0.1'
}

const FIXTURE_HOST = fixtureHost()

/** The UA the fixture origins see, recorded per path (A6). */
const seenUserAgents: string[] = []

const LANDING = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Real page</title></head>
<body><h1>Real page</h1><p id="marker">landed</p>
<img src="/pixel.png" alt="" width="2" height="2">
</body></html>`

/**
 * A refusal page that OFFERS a control: the control lives in a closed shadow
 * root, so the page's own document reports ZERO `iframe` elements while a real
 * cross-origin frame is on screen (that difference is the point of A8 - the
 * frame tree must come from the ENGINE, never from the page DOM or its text).
 */
function offeredPage(widgetUrl: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Please wait</title></head>
<body><h1>Verify you are human</h1>
<div id="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  frame.src = ${JSON.stringify(widgetUrl)};
  frame.setAttribute('style', 'position:absolute;left:40px;top:120px;width:300px;height:65px;border:0');
  root.appendChild(frame);
</script>
</body></html>`
}

/** The off-origin control: a REAL pointer click on it navigates the TOP frame. */
const WIDGET = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Control</title></head>
<body style="margin:0"><button id="go" style="width:300px;height:65px;margin:0">Verify</button>
<script>
  document.getElementById('go').addEventListener('click', () => {
    const target = new URLSearchParams(location.search).get('target');
    try { window.top.location.href = target } catch (error) { window.top.location.replace(target) }
  });
</script>
</body></html>`

/** Start a fixture origin reachable by the BROWSER (see FIXTURE_HOST). */
function listen(handler: (request: http.IncomingMessage, response: http.ServerResponse) => void): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '0.0.0.0', () => resolve(server))
  })
}

function portOf(server: http.Server): number {
  return (server.address() as AddressInfo).port
}

/** Everything both fixture origins need, started once per process. */
let fixtures: Promise<{ gated: string; landing: string; widget: string; stop: () => Promise<void> }> | undefined

function fixtureOrigins(): Promise<{ gated: string; landing: string; widget: string; stop: () => Promise<void> }> {
  fixtures ??= (async () => {
    // Origin 2 (the control): the SAME reachable host on a DIFFERENT PORT - the
    // port is part of an origin, so the control is cross-origin without any
    // network of its own.
    let widgetBase = ''
    const widget = await listen((request, response) => {
      seenUserAgents.push(String(request.headers['user-agent'] ?? ''))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(WIDGET)
    })
    widgetBase = `http://${FIXTURE_HOST}:${portOf(widget)}/control.html`

    const page = await listen((request, response) => {
      const url = request.url ?? '/'
      seenUserAgents.push(String(request.headers['user-agent'] ?? ''))
      if (url.startsWith('/pixel.png')) {
        response.writeHead(200, { 'content-type': 'image/png' })
        response.end('')
        return
      }
      if (url === '/') {
        response.writeHead(429, {
          'content-type': 'text/html; charset=utf-8',
          'retry-after': '30',
          'set-cookie': 'wb_fixture=1; Path=/; HttpOnly; SameSite=Lax',
        })
        response.end(offeredPage(`${widgetBase}?target=${encodeURIComponent(`http://${FIXTURE_HOST}:${portOf(page)}/ok`)}`))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(LANDING)
    })

    return {
      gated: `http://${FIXTURE_HOST}:${portOf(page)}/`,
      landing: `http://${FIXTURE_HOST}:${portOf(page)}/ok`,
      widget: widgetBase,
      /**
       * Stops both fixture origins AND drops the memo, so a test that runs after
       * this one starts FRESH servers instead of reusing closed sockets (the
       * fixtures are otherwise started once per process).
       */
      stop: async () => {
        fixtures = undefined
        await new Promise<void>((resolve) => page.close(() => resolve()))
        await new Promise<void>((resolve) => widget.close(() => resolve()))
      },
    }
  })()
  return fixtures
}

/**
 * The deployment under test: the browser service the caller points at. Absent
 * endpoint -> SKIP (or FAIL under BROWSER_USE_REQUIRE_CDP=1): the DEPLOYED
 * browser is what this file measures, a locally launched one is not it.
 */
function skipOrFail(t: { skip: (reason: string) => void }, why: string): boolean {
  if (REQUIRE_CDP) assert.fail(why)
  t.skip(why)
  return true
}

async function connect(): Promise<Browser> {
  // The configured endpoint usually names the browser SERVICE by its DNS name,
  // but the engine's DevTools server rejects any request whose Host header is
  // neither an IP nor `localhost` (its DNS-rebinding guard), so dialling the name
  // raw answers `Unexpected status 500`. The provider resolves the name to its
  // ADDRESS before dialling (connectTarget); this gate drives the deployment the
  // same way, and an endpoint that is already an address is returned unchanged.
  return chromium.connectOverCDP(await connectTarget(ENDPOINT))
}

async function probePage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  // NO viewport override here: an emulated viewport also REPLACES the engine's
  // screen metrics (screen.width becomes the viewport width, 1280), which would
  // hide the real display this test exists to measure - outerWidth then reports
  // the emulated window plus its borders (1288) and the comparison below would
  // be about emulation, not about the deployment. A4 reads the DEPLOYED window
  // against the DEPLOYED display, so the probe page keeps the real geometry.
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  await page.goto('about:blank')
  return { context, page }
}

// ---------------------------------------------------------------------------
// A1-A6: the deployed browser IS a browser.
// ---------------------------------------------------------------------------

test('A1-A6: the deployed launch is a real browser (no headless flag, a display, plugins, WebGL)', async (t) => {
  if (ENDPOINT.length === 0) {
    if (skipOrFail(t, 'BROWSER_USE_CDP_ENDPOINT is not set: this test measures the DEPLOYED browser service')) return
  }
  const browser = await connect()
  const cdp = await browser.newBrowserCDPSession()
  const { context, page } = await probePage(browser)
  try {
    // A1: the command line the process really runs with (SystemInfo is readable
    // without --enable-automation, which A2 then proves is NOT set).
    const info = (await cdp.send('SystemInfo.getProcessInfo')) as {
      processInfo: { type: string; commandLine?: string[] }[]
    }
    const main = info.processInfo.find((entry) => entry.type === 'browser')
    assert.ok(main !== undefined, `the browser process must be listed: ${JSON.stringify(info.processInfo.map((e) => e.type))}`)
    const commandLine = (main.commandLine ?? []).join(' ')
    assert.doesNotMatch(commandLine, /--headless/, `the deployed launch must not be headless: ${commandLine}`)

    // A2: `Browser.getBrowserCommandLine` is gated on --enable-automation, so the
    // PROTOCOL ERROR IS THE EVIDENCE that the browser was not started in the
    // automated mode. (This replaces the impossible assertion that used to sit in
    // the vendor-named gate file: it could never pass on a real launch.)
    let protocolError = ''
    try {
      await cdp.send('Browser.getBrowserCommandLine')
    } catch (error) {
      protocolError = error instanceof Error ? error.message : String(error)
    }
    assert.match(protocolError, /enable-automation/i, `expected the --enable-automation protocol error, got: ${protocolError}`)

    const facts = await page.evaluate(() => {
      const renderer = (): string | null => {
        try {
          const canvas = document.createElement('canvas')
          const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
          if (gl === null) return null
          const debug = gl.getExtension('WEBGL_debug_renderer_info')
          const value = debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
          return value === null || value === undefined ? null : String(value)
        } catch (error) {
          return null
        }
      }
      return {
        webdriver: navigator.webdriver,
        plugins: navigator.plugins.length,
        chromeObject: typeof (window as unknown as { chrome?: unknown }).chrome !== 'undefined',
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        dpr: window.devicePixelRatio,
        userAgent: navigator.userAgent,
        webglRenderer: renderer(),
      }
    })

    // A3: the ordinary-browser plan.
    assert.equal(facts.webdriver, false, 'navigator.webdriver must be false')
    assert.ok(facts.plugins > 0, `a real browser exposes plugins, got ${facts.plugins}`)
    assert.equal(facts.chromeObject, true, 'window.chrome must exist')

    // A4: real screen metrics behind a real X display.
    assert.ok(facts.screenWidth > 0 && facts.screenHeight > 0, `a real display has non-zero metrics: ${facts.screenWidth}x${facts.screenHeight}`)
    assert.ok(facts.outerWidth > 0 && facts.outerWidth <= facts.screenWidth, `outerWidth ${facts.outerWidth} <= screen.width ${facts.screenWidth}`)
    assert.ok(facts.dpr >= 1, `devicePixelRatio ${facts.dpr} >= 1`)

    // A5: a real WebGL renderer (fails when the launch disables the GPU stack).
    assert.ok(
      facts.webglRenderer !== null && facts.webglRenderer.length > 0,
      'the deployed browser must expose a WebGL renderer (a launch flag that disables the GPU stack leaves this null)',
    )

    // A6: the browser sends the origin its OWN user agent.
    assert.doesNotMatch(facts.userAgent, /HeadlessChrome/, `the UA must not be a headless UA: ${facts.userAgent}`)
    const origins = await fixtureOrigins()
    await page.goto(origins.landing)
    assert.equal(
      seenUserAgents.at(-1),
      facts.userAgent,
      'the origin must see exactly the user agent the page reports',
    )
  } finally {
    await context.close()
    await cdp.detach().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
})

// ---------------------------------------------------------------------------
// A7 / A8 / A11: the RAW observation of a refusal.
// ---------------------------------------------------------------------------

test('A7/A8/A11: a refusal answers the complete raw set, with the frame tree from the ENGINE', async (t) => {
  if (ENDPOINT.length === 0) {
    if (skipOrFail(t, 'BROWSER_USE_CDP_ENDPOINT is not set: this test measures the DEPLOYED browser service')) return
  }
  const origins = await fixtureOrigins()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-real-page-'))
  const provider = createPlaywrightProvider({ wsEndpoint: ENDPOINT, storageStateDir: dir, screenshotDir: dir })
  const capabilities = provider.capabilities()
  assert.equal(capabilities.engine.available, true, `the endpoint must be usable: ${String(capabilities.engine.requirement ?? '')}`)
  const service = createBrowserUseService({} as never, { provider: 'playwright', storageStateDir: dir, screenshotDir: dir })
  const unregister = service.register(provider)
  try {
    await service.open({ session: 'raw', viewport: { width: 1280, height: 900 } })
    const answer: BrowserNavigateAnswer = await service.navigate('raw', { url: origins.gated, allowHttpError: true })

    // A7: the transport, VERBATIM - the status the origin answered, every header
    // as sent (the refusal's own `retry-after` included), and the URL.
    assert.equal(answer.httpStatus, 429, `the document status is reported verbatim: ${JSON.stringify(answer.load.transport)}`)
    assert.equal(answer.load.transport.httpStatus, 429)
    assert.equal(answer.load.transport.finalUrl, origins.gated)
    assert.equal(answer.load.transport.responseHeaders['retry-after'], '30')
    assert.equal(answer.load.transport.responseHeaders['content-type'], 'text/html; charset=utf-8')
    assert.equal(answer.load.document.title, 'Please wait')

    // Cookies are reported by NAME and attributes, never by value.
    const cookie = answer.load.cookiesSet.find((entry) => entry.name === 'wb_fixture')
    assert.ok(cookie !== undefined, `the stored cookie is reported by name: ${JSON.stringify(answer.load.cookiesSet)}`)
    assert.equal(typeof (cookie as unknown as { value?: unknown }).value, 'undefined', 'a cookie VALUE must never be reported')

    // A8: the ENGINE's frame tree carries the off-origin control the page's own
    // DOM refuses to show.
    const engineFrames = answer.load.frames
    assert.ok(engineFrames.length >= 2, `the frame tree must include the off-origin control: ${JSON.stringify(engineFrames)}`)
    const control = engineFrames.find((frame) => !frame.isMainFrame && frame.crossOrigin)
    assert.ok(control !== undefined, `the control must be reported as a cross-origin frame: ${JSON.stringify(engineFrames)}`)
    assert.equal(control.sameOriginAsTop, false)
    assert.ok(control.visible, `the control occupies an on-screen box: ${JSON.stringify(control)}`)
    assert.ok(control.box !== undefined && control.box.width > 0 && control.box.height > 0, `the control has real geometry: ${JSON.stringify(control.box)}`)

    const dom = await provider.evaluate(
      'raw',
      { expression: "({ iframes: document.querySelectorAll('iframe').length, text: document.body.innerText.slice(0, 200) })" },
      CALL_OPTIONS,
    )
    assert.deepEqual(
      (dom as { value?: unknown }).value,
      { iframes: 0, text: 'Verify you are human' },
      `the page DOM must NOT be what the frame tree is read from: ${JSON.stringify(dom)}`,
    )

    // A11: every part of the raw set is present even when the answer is a refusal.
    assert.ok(Array.isArray(answer.load.resources.failed), 'resourceSummary.failed is always an array')
    assert.equal(typeof answer.load.resources.total, 'number')
    assert.equal(typeof answer.load.document.htmlLength, 'number')
    assert.equal(typeof answer.load.document.textLength, 'number')
    assert.equal(typeof answer.load.timing.durationMs, 'number')
    assert.ok(Array.isArray(answer.navigations), 'every navigation seen while the call ran is reported')
    assert.ok(Array.isArray(answer.actions), 'every action this side drove is reported')
  } finally {
    await service.close('raw').catch(() => undefined)
    unregister()
    await provider.dispose().catch(() => undefined)
    await fs.rm(dir, { recursive: true, force: true })
    await origins.stop()
  }
})

// ---------------------------------------------------------------------------
// A9 / A10: one real pointer click inside the offered control, then WAIT for the
// navigation the PAGE performs - and report BOTH loads.
// ---------------------------------------------------------------------------

test('A9/A10: a real pointer click inside the off-origin control navigates the browser itself', async (t) => {
  if (ENDPOINT.length === 0) {
    if (skipOrFail(t, 'BROWSER_USE_CDP_ENDPOINT is not set: this test measures the DEPLOYED browser service')) return
  }
  const origins = await fixtureOrigins()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-real-page-'))
  const provider = createPlaywrightProvider({ wsEndpoint: ENDPOINT, storageStateDir: dir, screenshotDir: dir })
  assert.equal(provider.capabilities().engine.available, true)
  const service = createBrowserUseService({} as never, { provider: 'playwright', storageStateDir: dir, screenshotDir: dir })
  const unregister = service.register(provider)
  try {
    await service.open({ session: 'click', viewport: { width: 1280, height: 900 } })
    const before: BrowserNavigateAnswer = await service.navigate('click', { url: origins.gated, allowHttpError: true })
    assert.equal(before.httpStatus, 429)
    const control = before.load.frames.find((frame) => !frame.isMainFrame && frame.crossOrigin)
    assert.ok(control !== undefined && control.box !== undefined)

    // The point is INSIDE the control's own reported box (never a constant
    // offset, never element.click(), never a selector): the input is a real
    // pointer event the browser delivers.
    const point = { x: Math.round(control.box.width / 2), y: Math.round(control.box.height / 2) }
    const clicked: BrowserMouseAnswer = await service.mouse('click', {
      mouseAction: 'click',
      relativeTo: 'frame',
      frame: { frameId: control.frameId },
      x: point.x,
      y: point.y,
    })

    // A9: the PAGE navigated, and the answer says so - the wait is the browser's.
    assert.ok(clicked.navigationsAdded >= 1, `the click must produce a navigation: ${JSON.stringify(clicked)}`)
    assert.ok(clicked.resultingLoad !== undefined, `the landing load must be reported: ${JSON.stringify(clicked)}`)

    // A10: BOTH loads are reported - the refusal the caller asked for and the
    // load the browser performed on its own.
    assert.equal(before.load.transport.httpStatus, 429, 'the first load stays reported')
    assert.equal(clicked.resultingLoad?.transport.httpStatus, 200, `the landing load: ${JSON.stringify(clicked.resultingLoad?.transport)}`)
    assert.equal(clicked.resultingLoad?.transport.finalUrl, origins.landing)
    assert.equal(clicked.resultingLoad?.document.title, 'Real page')
    assert.ok(
      (clicked.resultingLoad?.browserInitiatedNavigations ?? []).length >= 1,
      'the navigation is reported as BROWSER-initiated (the caller never re-navigated)',
    )
    assert.equal(clicked.url, origins.landing, 'the answer reports the URL the session now sits on')
  } finally {
    await service.close('click').catch(() => undefined)
    unregister()
    await provider.dispose().catch(() => undefined)
    await fs.rm(dir, { recursive: true, force: true })
    await origins.stop()
  }
})

// ---------------------------------------------------------------------------
// OBSERVATIONAL: real public origins. Never fails on what a third party answers.
// ---------------------------------------------------------------------------

test('observational: public origins report their raw observation and never fail the gate', async (t) => {
  const targets = (process.env.BROWSER_USE_REAL_TARGETS ?? '').split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
  if (ENDPOINT.length === 0 || targets.length === 0) {
    t.skip('set BROWSER_USE_CDP_ENDPOINT and BROWSER_USE_REAL_TARGETS=<url[,url]> to record public observations')
    return
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-real-page-public-'))
  const artifacts = path.join(process.cwd(), 'artifacts', 'browser-real-page')
  await fs.mkdir(artifacts, { recursive: true })
  const provider = createPlaywrightProvider({ wsEndpoint: ENDPOINT, storageStateDir: dir, screenshotDir: dir })
  const service = createBrowserUseService({} as never, { provider: 'playwright', storageStateDir: dir, screenshotDir: dir })
  const unregister = service.register(provider)
  const observations: Record<string, unknown>[] = []
  try {
    await service.open({ session: 'public', viewport: { width: 1280, height: 900 } })
    for (const url of targets) {
      // One load, no retry, no cooldown machinery: a refusal is DATA here.
      const answer = await service.navigate('public', { url, allowHttpError: true }).catch((error: unknown) => ({
        url,
        error: error instanceof Error ? error.message.split('\n')[0] : String(error),
      }))
      observations.push({ requested: url, answer } as Record<string, unknown>)
      // The structural rule: whatever the origin answered, the raw set is complete.
      const load = (answer as BrowserNavigateAnswer).load
      if (load !== undefined) {
        assert.equal(typeof load.transport.finalUrl, 'string', 'the transport is always reported')
        assert.ok(Array.isArray(load.frames), 'the frame tree is always reported')
        assert.ok(Array.isArray(load.cookiesSet), 'the cookies are always reported')
      }
    }
    const file = path.join(artifacts, `${Date.now()}.json`)
    await fs.writeFile(file, `${JSON.stringify(observations, null, 2)}\n`, 'utf8')
    assert.ok((await fs.stat(file)).size > 0, 'the observations are written next to the screenshots')
  } finally {
    await service.close('public').catch(() => undefined)
    unregister()
    await provider.dispose().catch(() => undefined)
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// A12: the product carries no vendor vocabulary.
// ---------------------------------------------------------------------------

test('A12: no vendor identifier appears anywhere in the product surface', async () => {
  const product = ['definitions', 'core', 'plugins', 'browser']
  const vendor =
    /cloudflare|turnstile|cf_clearance|cf-chl|cf-mitigated|hcaptcha|recaptcha|datadome|perimeterx|akamai|incapsula|sucuri|kasada|px-captcha|shield ?square/i
  const files: string[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.workbench', 'artifacts'].includes(entry.name)) continue
        await walk(full)
        continue
      }
      if (/\.(ts|js|mjs|cjs|json|yml|yaml|sh)$/.test(entry.name) || entry.name === 'Dockerfile') files.push(full)
    }
  }
  for (const dir of product) await walk(path.join(process.cwd(), dir)).catch(() => undefined)
  await walk(path.join(process.cwd(), 'config.yml')).catch(() => undefined)
  const root = path.join(process.cwd(), 'config.yml')
  if (!files.includes(root) && (await fs.stat(root).catch(() => undefined)) !== undefined) files.push(root)

  assert.ok(files.length > 50, `the lint must scan the product, not a handful of files: ${files.length}`)
  const offenders: string[] = []
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8')
    text.split('\n').forEach((line, index) => {
      if (vendor.test(line)) offenders.push(`${path.relative(process.cwd(), file)}:${index + 1}: ${line.trim().slice(0, 120)}`)
    })
  }
  assert.deepEqual(offenders, [], `the product must not name a verification vendor:\n${offenders.join('\n')}`)
})
