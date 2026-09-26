// core/browser-use-playwright/config.ts - the `plugins: browser-use-playwright:`
// row of the deployment config, resolved ONCE, plus the CHEAP LOCAL checks that
// make this provider honest about the browser it can actually drive.
//
// The provider is a plugin, so everything a deployment may want to change is
// config here and nothing is a hidden default: which chromium binary (or the
// playwright cache), the launch argv, the session defaults (viewport, locale,
// timezone, user agent, proxy), where storage-state files and screenshots live,
// and the bounds this provider applies ON TOP of the seam bounds (which always
// win: the host clamps every value it hands over).
//
// LOCATION-AGNOSTIC (operator rule): this provider does NOT know what transport
// types the `general-service@1` seam supports (local / container / ssh / http
// are the GENERAL SERVICE's concern, never this plugin's). The config row names
// the `browserService.generalService` instance (`type` + `params`) and this
// plugin passes it through UNCHANGED: if the general service starts supporting
// a new transport type, this plugin needs NO change. `wsEndpoint` /
// `browserService.endpoint` name the CDP endpoint this provider ATTACHES to; a
// browser service that does not answer yet is started/probed through the seam
// instance the config names. The provider never hard-wires docker, ssh or http.
//
// The two local checks exist because a missing browser must be a TYPED failure
// (`browser-use.no-browser`) with the exact install requirement, never a slow
// launch attempt that ends in an opaque timeout:
//   * playwrightCoreAvailable(): is the `playwright-core` module resolvable?
//   * browserBinary(): which binary would be launched, and does it exist?
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  DEFAULT_SCREENSHOT_DIR,
  DEFAULT_STORAGE_DIR,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_MAX_SNAPSHOT_NODES,
  type BrowserUseCallOptions,
} from '../../definitions/browser-use.ts'
import { ServiceError } from '../../definitions/support.ts'

/** The `plugins: browser-use-playwright:` row, exactly as an operator writes it. */
export interface BrowserUsePlaywrightConfig {
  /** Run headless (default true). */
  headless?: boolean
  /** The default viewport of a session. */
  viewport?: { width: number; height: number }
  userAgent?: string
  locale?: string
  timezoneId?: string
  /** The default proxy of a session (`credential` is a NAME, never a value). */
  proxy?: { server: string; username?: string; credential?: string }
  /** A chromium/chrome binary; absent: playwright resolves its own cache. */
  executablePath?: string
  /**
   * A REMOTE browser to ATTACH to instead of launching a local chromium: a
   * CDP/websocket endpoint (`ws://browser:3000/`, `http://browser:9222`). When
   * this is set the provider connects over CDP and NEVER launches a local
   * process; when the endpoint does not answer, the call fails with the typed
   * `browser-use.endpoint-unreachable` naming the endpoint - no silent local
   * launch, no silent HTTP fetch. `cdpEndpoint` is accepted as an alias.
   *
   * This is the "thin browser service" deployment: ONE browser container shared
   * by every workbench session (`mcr.microsoft.com/playwright` running a
   * playwright server, or any chromium started with `--remote-debugging-port`).
   */
  wsEndpoint?: string
  /** Alias of `wsEndpoint`, for a caller that thinks in CDP terms. */
  cdpEndpoint?: string
  /**
   * The SEPARATE browser image/service this provider ATTACHES to.
   *
   * The browser is NEVER part of the workbench image (operator 2026-09-20: "the
   * browser image is a separate image, not the workbench image"): a deployment
   * runs ONE browser container/service (`mcr.microsoft.com/playwright:vX-noble`
   * or any image shipping chromium) and points this provider at it. `endpoint`
   * is where it answers (`http://127.0.0.1:9222`, or a `ws://` CDP URL);
   * `generalService` is the `general-service@1` instance (`type` + `params`)
   * used to START that service when the endpoint does not answer yet. The
   * instance is passed through UNCHANGED: what types the general service
   * supports is ITS concern, never this plugin's, so a new transport type
   * needs no change here. The browser image is named here, never built into
   * the workbench image.
   *
   * When the endpoint never answers, the call fails with the typed
   * `browser-use.no-browser` naming the endpoint, the image and the instance -
   * this provider never launches a local browser and never falls back to an HTTP
   * fetch while a browser service is configured.
   */
  browserService?: BrowserServiceConfig
  /** Extra chromium argv shared by every session. */
  browserArgs?: string[]
  /** Where storage-state files live (default `<tmp>/workbench-browser-use/state`). */
  storageStateDir?: string
  /**
   * Where a screenshot without an explicit `path` is written. The provider OWNS
   * this file, so this value WINS over the seam bound the host passes in; when
   * neither names one, `DEFAULT_SCREENSHOT_DIR` (`<tmp>/workbench-browser-use`)
   * applies. A relative value is resolved against the CWD once, here.
   */
  screenshotDir?: string
  /** Where downloads are saved (default `<storageStateDir>/downloads`). */
  downloadDir?: string
  /** Launch budget of the shared browser (default 30000 ms). */
  launchTimeoutMs?: number
  /** The session id a call uses when it names none (default `default`). */
  defaultSession?: string
  /** How many requests/downloads the observer keeps per session (default 200). */
  observeLimit?: number
  /** Idle seconds after which a session's browser context is closed (0 = never). */
  sessionTtlSeconds?: number
}

/** The `browserService` block, exactly as an operator writes it. */
export interface BrowserServiceConfig {
  /** Where the browser service answers: `http://host:port` or a `ws(s)://` CDP URL. */
  endpoint?: string
  /** The image the service runs (named in the answers/errors), e.g. `mcr.microsoft.com/playwright:v1.63.0-noble`. */
  image?: string
  /**
   * The `general-service@1` instance (`type` + `params`) that STARTS/reaches the
   * service. Passed through UNCHANGED: this plugin does not know - and must not
   * know - what transport types the general service supports.
   */
  generalService?: { type?: string; params?: Record<string, unknown> }
  /** The command run THROUGH the instance when the endpoint does not answer (start it). */
  start?: string
  /** A command run through the instance as a liveness/diagnostic proof (reported when the start fails). */
  probe?: string
  /** How long to wait for the endpoint after `start` (default 20000 ms). */
  startTimeoutMs?: number
}

/** The `browserService` block as this provider uses it (endpoint resolved). */
export interface ResolvedBrowserService {
  endpoint: string
  image?: string
  generalService?: { type: string; params: Record<string, unknown> }
  start?: string
  probe?: string
  startTimeoutMs: number
}

/**
 * Resolves the `browserService` block (the ATTACH surface of a remote browser).
 * A block that is PRESENT must be usable: silently ignoring a broken
 * browser-service config would leave an operator with a provider that launches
 * a local browser they never asked for, so a missing or non-URL `endpoint` is a
 * LOUD `invalid-config` naming the field.
 *
 * The `general-service@1` instance is passed through UNCHANGED: this plugin
 * never builds one, never names a transport type and never knows what types the
 * general service supports - the seam decides. When the block names no
 * instance, no start/probe is attempted (the endpoint IS the browser).
 */
export function resolveBrowserService(
  raw: BrowserServiceConfig | undefined,
  explicitEndpoint?: string,
): ResolvedBrowserService | undefined {
  if (raw !== undefined && !plainRecord(raw)) {
    throw new ServiceError('invalid-config', "browser-use-playwright: 'browserService' must be an object with an 'endpoint'", {
      stage: 'config',
      details: { field: 'browserService' },
    })
  }
  const endpoint = raw === undefined ? explicitEndpoint : textOf(raw.endpoint)
  if (endpoint === undefined || !/^(https?|wss?):\/\//.test(endpoint)) {
    if (raw === undefined) {
      if (explicitEndpoint === undefined) return undefined
      throw new ServiceError(
        'invalid-config',
        "browser-use-playwright: 'wsEndpoint'/'cdpEndpoint' must be an http(s):// or ws(s):// URL, e.g. 'http://127.0.0.1:9222'",
        { stage: 'config', details: { field: 'wsEndpoint', got: explicitEndpoint } },
      )
    }
    throw new ServiceError(
      'invalid-config',
      "browser-use-playwright: 'browserService.endpoint' must be an http(s):// or ws(s):// URL, e.g. 'http://127.0.0.1:9222'",
      { stage: 'config', details: { field: 'browserService.endpoint', got: endpoint ?? null } },
    )
  }
  if (raw === undefined) {
    // ATTACH without a named service: the endpoint IS the browser (plain CDP
    // attach), and there is no seam instance to start/probe anything.
    return { endpoint, startTimeoutMs: 20_000 }
  }
  const general = raw.generalService
  const type = plainRecord(general) ? textOf(general.type) : undefined
  if (plainRecord(general) && type === undefined) {
    throw new ServiceError(
      'invalid-config',
      "browser-use-playwright: 'browserService.generalService' needs a 'type' (the general-service@1 instance that starts/probes the service)",
      { stage: 'config', details: { field: 'browserService.generalService' } },
    )
  }
  const image = textOf(raw.image)
  const start = textOf(raw.start)
  const probe = textOf(raw.probe)
  return {
    endpoint,
    ...(image === undefined ? {} : { image }),
    ...(type === undefined
      ? {}
      : { generalService: { type, params: (plainRecord(general) && plainRecord(general.params) ? general.params : {}) as Record<string, unknown> } }),
    ...(start === undefined ? {} : { start }),
    ...(probe === undefined ? {} : { probe }),
    startTimeoutMs: boundInt(raw.startTimeoutMs, 20_000, 300_000),
  }
}

/** A plain JSON object (never an array, never null). */
function plainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The config as the provider uses it (every field resolved, nothing optional). */
export interface ResolvedProviderConfig {
  headless: boolean
  viewport: { width: number; height: number }
  userAgent?: string
  locale?: string
  timezoneId?: string
  proxy?: { server: string; username?: string; credential?: string }
  executablePath?: string
  /** The remote CDP/websocket endpoint this provider ATTACHES to (no local launch). */
  wsEndpoint?: string
  /** The SEPARATE browser service (its own image) this provider attaches to. */
  browserService?: ResolvedBrowserService
  browserArgs: string[]
  storageStateDir: string
  /** Absent when neither this config nor the seam bound named a directory. */
  screenshotDir?: string
  downloadDir: string
  launchTimeoutMs: number
  defaultSession: string
  observeLimit: number
  sessionTtlSeconds: number
}

/** A bounded positive integer (a bad config value falls back, never throws). */
export function boundInt(value: unknown, fallback: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0 || number > max) return fallback
  return number
}

/** A non-negative integer (0 is meaningful: "no limit"). */
export function boundZeroInt(value: unknown, fallback: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || number > max) return fallback
  return number
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Resolves the plugin config (the seam bounds are applied by the host). */
export function resolveProviderConfig(
  config: BrowserUsePlaywrightConfig = {},
  bounds?: Partial<BrowserUseCallOptions>,
): ResolvedProviderConfig {
  const viewportConfig = config.viewport
  const viewport =
    viewportConfig !== undefined && boundInt(viewportConfig.width, 0, 20_000) > 0 && boundInt(viewportConfig.height, 0, 20_000) > 0
      ? { width: boundInt(viewportConfig.width, 1280, 20_000), height: boundInt(viewportConfig.height, 720, 20_000) }
      : { width: 1280, height: 720 }
  const storageStateDir = path.resolve(textOf(config.storageStateDir) ?? bounds?.storageStateDir ?? DEFAULT_STORAGE_DIR)
  // The provider config WINS over the seam bound (this plugin owns the file the
  // screenshot is written to; `core/browser-use-impl` only forwards a default).
  // Both are resolved to an ABSOLUTE path here, so the path the caller reads
  // back never depends on the CWD the core was started in (defect D1, thread 2577).
  const configuredScreenshotDir = textOf(config.screenshotDir)
  const screenshotDir =
    configuredScreenshotDir !== undefined
      ? path.resolve(configuredScreenshotDir)
      : bounds?.screenshotDir === undefined || typeof bounds.screenshotDir !== 'string'
        ? undefined
        : path.resolve(bounds.screenshotDir)
  const proxyServer = textOf(config.proxy?.server)
  const proxyUser = textOf(config.proxy?.username)
  const proxyCredential = textOf(config.proxy?.credential)
  const executablePath = textOf(config.executablePath)
  // WHERE the browser runs is a CONFIG decision: `wsEndpoint` /
  // `browserService.endpoint` name the CDP endpoint this provider ATTACHES to,
  // and the seam instance that starts/probes a browser service is passed
  // through UNCHANGED (the transport types are the general service's concern).
  // `wsEndpoint` and its `cdpEndpoint` alias name the same thing: a remote
  // browser this provider ATTACHES to. The `browserService.endpoint` (the
  // SEPARATE browser image) is the same ATTACH mode, only the service is then
  // named/started through the `general-service@1` seam. Resolved once here, so
  // every downstream check sees ONE endpoint.
  const explicitEndpoint = textOf(config.wsEndpoint) ?? textOf(config.cdpEndpoint)
  const browserService = resolveBrowserService(config.browserService, explicitEndpoint)
  const wsEndpoint = explicitEndpoint ?? browserService?.endpoint
  const userAgent = textOf(config.userAgent)
  const locale = textOf(config.locale)
  const timezoneId = textOf(config.timezoneId)
  return {
    headless: config.headless !== false,
    viewport,
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
    ...(proxyServer === undefined
      ? {}
      : { proxy: { server: proxyServer, ...(proxyUser === undefined ? {} : { username: proxyUser }), ...(proxyCredential === undefined ? {} : { credential: proxyCredential }) } }),
    ...(executablePath === undefined ? {} : { executablePath }),
    ...(wsEndpoint === undefined ? {} : { wsEndpoint }),
    ...(browserService === undefined ? {} : { browserService }),
    browserArgs: Array.isArray(config.browserArgs)
      ? config.browserArgs.map((arg) => textOf(arg)).filter((arg): arg is string => arg !== undefined)
      : [],
    storageStateDir,
    ...(screenshotDir === undefined ? {} : { screenshotDir }),
    downloadDir: textOf(config.downloadDir) ?? path.join(storageStateDir, 'downloads'),
    launchTimeoutMs: boundInt(config.launchTimeoutMs, 30_000, 300_000),
    defaultSession: textOf(config.defaultSession) ?? 'default',
    observeLimit: boundInt(config.observeLimit, 200, 5_000),
    sessionTtlSeconds: boundZeroInt(config.sessionTtlSeconds, 0, 86_400),
  }
}

/** The storage-state file of a session (the SAME convention `web-session` uses). */
export function sessionStateFile(dir: string, session: string): string {
  return path.join(dir, `${safeSessionId(session)}.json`)
}

/** A session id that is safe as a file name (never a path traversal). */
export function safeSessionId(session: string): string {
  const slug = session
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64)
  return slug.length === 0 ? 'default' : slug
}

/** True when the `playwright-core` module can be resolved (a cheap local check). */
export function playwrightCoreAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('playwright-core')
    return true
  } catch {
    return false
  }
}

/** Where a chromium binary would come from, and whether it exists. */
export interface BrowserBinary {
  /** The binary path, when one was found. */
  path?: string
  /** How it was found: `config`, `PLAYWRIGHT_BROWSERS_PATH`, the cache or the system. */
  source: string
  /** True when a binary was found (or when the check cannot decide: see `certain`). */
  found: boolean
  /** False when the check is a heuristic and playwright may still resolve one. */
  certain: boolean
}

/** The layout of a playwright chromium build inside a browser cache directory. */
const CHROMIUM_CANDIDATES = [
  'chrome-linux/chrome',
  'chrome-linux64/chrome',
  'chrome-linux/headless_shell',
  'chrome-linux64/headless_shell',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-win/chrome.exe',
]

/** The system chromium/chrome binaries tried when no cache is visible. */
const SYSTEM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
]

function chromiumIn(cacheDir: string): string | undefined {
  let entries: string[]
  try {
    entries = fs.readdirSync(cacheDir)
  } catch {
    return undefined
  }
  for (const entry of entries.sort().reverse()) {
    if (!entry.startsWith('chromium')) continue
    for (const candidate of CHROMIUM_CANDIDATES) {
      const full = path.join(cacheDir, entry, candidate)
      if (fs.existsSync(full)) return full
    }
  }
  return undefined
}

/**
 * Which chromium the provider would launch. The order is playwright's own:
 * an explicit `executablePath`, then the browser cache (`PLAYWRIGHT_BROWSERS_PATH`
 * or `~/.cache/ms-playwright`), then a system chromium. `certain: false` means
 * playwright may still resolve a browser this heuristic cannot see, so the
 * provider never claims "no browser" from a heuristic alone - it only REFUSES
 * early when nothing at all was found (and the requirement names both ways out).
 */
export function browserBinary(config: ResolvedProviderConfig): BrowserBinary {
  if (config.wsEndpoint !== undefined) {
    // ATTACH mode: no local binary is used at all, and this is not a missing
    // browser - the endpoint IS the browser. `path` stays absent on purpose.
    return { source: `the CDP endpoint ${config.wsEndpoint}`, found: true, certain: false }
  }
  if (config.executablePath !== undefined) {
    const exists = fs.existsSync(config.executablePath)
    return {
      ...(exists ? { path: config.executablePath } : {}),
      source: 'config executablePath',
      found: exists,
      certain: true,
    }
  }
  const envPath = textOf(process.env.PLAYWRIGHT_BROWSERS_PATH)
  if (envPath !== undefined) {
    const found = chromiumIn(envPath)
    if (found !== undefined) return { path: found, source: 'PLAYWRIGHT_BROWSERS_PATH', found: true, certain: true }
  }
  const cacheDir = path.join(os.homedir(), '.cache', 'ms-playwright')
  const cached = chromiumIn(cacheDir)
  if (cached !== undefined) return { path: cached, source: 'the playwright browser cache', found: true, certain: true }
  for (const candidate of SYSTEM_CANDIDATES) {
    if (fs.existsSync(candidate)) return { path: candidate, source: 'a system chromium', found: true, certain: true }
  }
  return { source: 'nothing found', found: false, certain: false }
}

/** The exact install/launch requirement of this provider (requirement 3). */
export function browserRequirement(config: ResolvedProviderConfig): string {
  if (!playwrightCoreAvailable()) {
    return "the 'playwright-core' module is not installed in this deployment: run 'npm ci' in the workbench-plugins source (it is a dependency of the plugin repository)"
  }
  if (config.wsEndpoint !== undefined) return endpointRequirement(config)
  return (
    'no chromium binary is visible in the workbench process. WHERE the browser runs is a CONFIG decision: ' +
    '`plugins.browser-use-playwright.browserService.generalService` names the `general-service@1` instance (type + params) that starts/probes ' +
    'the browser service when its endpoint does not answer yet - the transport types (container / ssh / http / ...) are the GENERAL SERVICE\'s ' +
    'concern, not this plugin\'s, and this plugin passes the instance through unchanged. The RECOMMENDED deployment runs the browser from its OWN image: ' +
    'start a browser service (`mcr.microsoft.com/playwright:v1.63.0-noble`, or any chromium image), then set ' +
    '`plugins.browser-use-playwright.browserService = { endpoint: "http://127.0.0.1:9222", image: "mcr.microsoft.com/playwright:v1.63.0-noble", ' +
    'generalService: { type: "container", params: { container: "workbench-browser" } }, start: "<start chromium with --remote-debugging-port>" }` ' +
    '- the browser image is NEVER part of the workbench image, and the service is started through the general-service@1 seam, so the transport is config. ' +
    'A bare `plugins.browser-use-playwright.wsEndpoint` works too. ' +
    'LOCAL alternatives (not the default): set `executablePath` to a chrome/chromium binary, or install the playwright browser cache ' +
    '(`npx playwright-core install chromium`). This provider NEVER falls back to an HTTP fetch that pretends to be a browser'
  )
}

/** The exact requirement when this provider is configured to ATTACH to a remote browser. */
export function endpointRequirement(config: ResolvedProviderConfig): string {
  const service = config.browserService
  if (service === undefined) {
    return (
      `no browser answers at the configured CDP endpoint '${config.wsEndpoint ?? ''}': start the browser service it names ` +
      '(e.g. a `mcr.microsoft.com/playwright` container running chromium with `--remote-debugging-port`, reachable from this ' +
      'process) or fix `plugins.browser-use-playwright.wsEndpoint`. This provider NEVER falls back to a local launch or to an ' +
      'HTTP fetch when `wsEndpoint` is set'
    )
  }
  return (
    `no browser answers at '${service.endpoint}', the endpoint of the browser SERVICE configured in ` +
    `'plugins.browser-use-playwright.browserService'` +
    (service.image === undefined ? '' : ` (image '${service.image}')`) +
    (service.generalService === undefined
      ? ''
      : `, reached through the general-service@1 instance ${JSON.stringify(service.generalService)}`) +
    (service.start === undefined ? '' : `, start command '${service.start}'`) +
    ': start that service (or fix the endpoint/instance) and make sure the endpoint is reachable FROM THIS PROCESS ' +
    '(a container that publishes the debugging port on the loopback of the workbench process, e.g. `network_mode: host` ' +
    'or a shared docker network). The browser runs from its OWN image and is NEVER part of the workbench image; this ' +
    'provider NEVER falls back to a local launch or to an HTTP fetch'
  )
}

/** True when a session's idle TTL has passed (0 = never idle out). */
export function sessionExpired(lastUsedAt: number, now: number, ttlSeconds: number): boolean {
  if (ttlSeconds <= 0) return false
  return now - lastUsedAt > ttlSeconds * 1_000
}

/** The default session cap of a provider instance (never below 1). */
export function sessionCap(bounds: Partial<BrowserUseCallOptions> | undefined, config: ResolvedProviderConfig): number {
  const fromBounds = bounds?.maxSessions
  if (typeof fromBounds === 'number' && Number.isInteger(fromBounds) && fromBounds > 0) return fromBounds
  return DEFAULT_MAX_SESSIONS
}

/** The default snapshot node cap of a provider instance. */
export function snapshotCap(bounds: Partial<BrowserUseCallOptions> | undefined): number {
  const fromBounds = bounds?.maxSnapshotNodes
  if (typeof fromBounds === 'number' && Number.isInteger(fromBounds) && fromBounds > 0) return fromBounds
  return DEFAULT_MAX_SNAPSHOT_NODES
}