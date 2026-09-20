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

/** The config as the provider uses it (every field resolved, nothing optional). */
export interface ResolvedProviderConfig {
  headless: boolean
  viewport: { width: number; height: number }
  userAgent?: string
  locale?: string
  timezoneId?: string
  proxy?: { server: string; username?: string; credential?: string }
  executablePath?: string
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
  return (
    'no chromium binary is visible: either set `plugins.browser-use-playwright.executablePath` to a chrome/chromium binary, ' +
    'or install the playwright browser cache (`npx playwright-core install chromium`) and leave `PLAYWRIGHT_BROWSERS_PATH` ' +
    'at its default (`~/.cache/ms-playwright`) or point it at the cache directory'
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
