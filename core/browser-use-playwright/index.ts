// core/browser-use-playwright - the PLAYWRIGHT PROVIDER of the `browser-use@1`
// seam.
//
// It is the REAL half of the capability: the host (`core/browser-use-impl`)
// owns the registry/selection/bounds, this plugin owns a chromium and the
// sessions a caller drives. It registers itself on `ctx['browser-use']` through
// the ordinary provider contract, so a deployment swaps it by editing one config
// row (`plugins.browser-use-impl: { provider: playwright }`).
//
// REUSE (no second browser stack): the chromium process comes from the SHARED
// launcher of the repository (`shared/browser.ts`, refcounted), so
// `web-page`, `web-session` and this provider never launch competing browsers -
// the module has no manifest and is a SHARED internal module, which is why a
// provider may import it (scripts/check-seam.ts rule 4: a provider imports its
// own directory, the definitions and the SHARED modules, never a consumer
// plugin). Storage state uses the SAME convention as `web-session`
// (`<stateDir>/<session>.json`, reuse on open, persist on close), so a session
// established through one of them can be continued through the other.
//
// WHAT IT ADDS OVER `web-session`: a session is a live BROWSER CONTEXT with
// tabs, a compact SNAPSHOT with STABLE refs (`e12`) a caller acts on in a later
// call, the full interaction vocabulary (click/type/fill/select/hover/scroll/
// press/upload/check/focus/waitFor/back/forward/reload), `evaluate`, readable
// `extract` (text/markdown/html/table/attributes/links/json), FILE screenshots,
// tab management, storage-state read/write and a network/download observer.
//
// HONESTY (requirement 3): every answer carries the PROVIDER and the ENGINE that
// produced it; a deployment WITHOUT a chromium fails `open` with the typed
// `browser-use.no-browser` error naming the exact prerequisite (the config
// `executablePath` or the playwright browser cache) - never a silent fallback to
// an HTTP fetch that pretends to be a browser.
//
// TEARDOWN (requirement 7 of the task): every browser context, listener and
// timer is released through the cordis `effect()` disposer at unload, so a
// reconcile/unload leaves no chromium process and no profile directory behind.
import fs from 'node:fs'
import path from 'node:path'
import type { Browser, BrowserContext, Download, Page, Locator, Response } from 'playwright-core'
import {
  BROWSER_USE,
  BROWSER_USE_VERSION,
  BrowserUseError,
  ACT_KINDS,
  EXTRACT_MODES,
  SCROLL_DIRECTIONS,
  TAB_ACTIONS,
  WAIT_STATES,
  WAIT_UNTIL,
  browserUseOf,
  isBrowserUseError,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireRef,
  requireText,
  slugOf,
  type BrowserActAnswer,
  type BrowserActRequest,
  type BrowserEngineInfo,
  type BrowserEvaluateAnswer,
  type BrowserEvaluateRequest,
  type BrowserExtractAnswer,
  type BrowserExtractRequest,
  type BrowserNavigateAnswer,
  type BrowserNavigateRequest,
  type BrowserObserveAnswer,
  type BrowserObserveRequest,
  type BrowserProviderCapabilities,
  type BrowserScreenshotAnswer,
  type BrowserScreenshotRequest,
  type BrowserSessionInfo,
  type BrowserSessionSpec,
  type BrowserSnapshot,
  type BrowserSnapshotNode,
  type BrowserSnapshotRequest,
  type BrowserStateAnswer,
  type BrowserStateRequest,
  type BrowserTabAnswer,
  type BrowserTabRequest,
  type BrowserUseCallOptions,
  type BrowserUseProvider,
  type BrowserWaitAnswer,
  type BrowserWaitRequest,
} from '../../definitions/browser-use.ts'
import { assertPolicyDeclared, credentialsOf, isRecord, messageOf, str, type ServiceContext } from '../../definitions/support.ts'
import { acquireSharedBrowser, releaseSharedBrowser, sharedBrowserVersion } from '../../shared/browser.ts'
import {
  boundInt,
  browserBinary,
  browserRequirement,
  playwrightCoreAvailable,
  resolveProviderConfig,
  safeSessionId,
  sessionStateFile,
  type BrowserUsePlaywrightConfig,
  type ResolvedProviderConfig,
} from './config.ts'
import { DEFAULT_ATTRIBUTES, extractInPage, snapshotInPage, type ExtractPayload } from './extract.ts'

export const name = 'browser-use-playwright'
/** The provider id this plugin registers on the seam. */
export const providerId = 'playwright'
/** The attribute a snapshot stamps on every node it reports (the ref carrier). */
export const REF_ATTRIBUTE = 'data-wb-ref'
/** The engine family this provider drives (reported by `engine()`). */
export const ENGINE = 'chromium'

/** One observed network request (bounded; never a body, never a header). */
interface RequestRecord {
  method: string
  url: string
  status?: number
  resourceType?: string
  contentType?: string
}

/** One observed download (the PATH is what a caller uses). */
interface DownloadRecord {
  url: string
  suggestedFilename: string
  path?: string
  bytes?: number
  state?: string
}

/** One live browser session (a context + its tabs). */
interface LiveSession {
  id: string
  context: BrowserContext
  /** The index of the tab every action uses, in `context.pages()` order. */
  active: number
  stateFile: string
  stateReused: boolean
  downloadDir: string
  requests: RequestRecord[]
  downloads: DownloadRecord[]
  /** ref -> the snapshot id it was minted in. */
  refs: Map<string, string>
  /** page -> the snapshot id of its LAST snapshot (older refs are stale). */
  snapshots: Map<Page, string>
  /** The last title read (the `sessions()` report is synchronous). */
  lastTitle: string
  openedAt: number
  lastUsedAt: number
  /** Listener removals, run when the session closes. */
  disposers: (() => void)[]
}

/** The plugin context a provider needs (structural: no `cordis` import here). */
interface PluginContext extends Omit<ServiceContext, 'logger'> {
  effect?: (fn: () => (() => void) | void) => unknown
  logger?: { warn?: (message: string, ...args: unknown[]) => void }
  inject?: (deps: string[], callback: (injected: ServiceContext) => void) => unknown
}

/** The first line of a message (a provider must not paste a whole stack trace). */
function firstLine(message: string): string {
  const line = message.split('\n')[0] ?? message
  return line.length > 300 ? `${line.slice(0, 300)}...` : line
}

/** A PLAYWRIGHT failure mapped onto the typed taxonomy of the seam. */
function mapError(error: unknown, stage: string, fallback: BrowserUseError['reason'], details: Record<string, unknown> = {}): BrowserUseError {
  if (isBrowserUseError(error)) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/Timeout \d+ms exceeded|timeout .*exceeded|Target closed/i.test(message)) {
    return new BrowserUseError('browser-use.timeout', `${stage}: ${firstLine(message)}`, { stage, details })
  }
  if (/net::ERR|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_SSL|ERR_ABORTED|NS_ERROR/i.test(message)) {
    return new BrowserUseError('browser-use.navigation-failed', `${stage}: ${firstLine(message)}`, { stage, details })
  }
  if (/Execution context was destroyed|Target page, context or browser has been closed/i.test(message)) {
    return new BrowserUseError('browser-use.stale-ref', `${stage}: ${firstLine(message)}`, { stage, details })
  }
  return new BrowserUseError(fallback, `${stage}: ${firstLine(message)}`, { stage, details })
}

/** True when the message reads like a launch failure of a missing/broken binary. */
function looksLikeMissingBrowser(message: string): boolean {
  return /Executable doesn't exist|Failed to launch|browserType\.launch|No such file or directory|cannot find|ENOENT/i.test(message)
}

/**
 * The `act` kinds that NEED a target. `press`, `scroll` and `waitFor` accept one
 * OPTIONALLY (a key to the focused element, a scroll of the page itself), which
 * is why they are not in this list.
 */
const TARGETED_ACT_KINDS: readonly string[] = ['click', 'type', 'fill', 'select', 'hover', 'upload', 'check', 'focus']
export class PlaywrightProvider implements BrowserUseProvider {
  readonly id = providerId
  private readonly config: ResolvedProviderConfig
  private readonly credentials?: { resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> }
  private readonly sessionsById = new Map<string, LiveSession>()
  private browser?: Browser
  private launching?: Promise<Browser>
  private holdsBrowser = false
  private snapshotCounter = 0
  private disposed = false

  constructor(config: BrowserUsePlaywrightConfig = {}, credentials?: { resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> }) {
    const bounds = { screenshotDir: undefined, storageStateDir: undefined }
    this.config = resolveProviderConfig(config, bounds)
    this.credentials = credentials
  }

  // -------------------------------------------------------------------------
  // The honesty surface: availability, engine, capabilities.
  // -------------------------------------------------------------------------

  /**
   * Can this provider drive a browser RIGHT NOW? Two halves:
   *   * `playwright-core` must be resolvable (else the provider itself cannot
   *     run: `unavailableReason()` names the install step);
   *   * a chromium binary must be visible (else `open` fails with the typed
   *     `browser-use.no-browser`, and `engine()` reports `available: false`).
   * The FIRST half decides availability, the second is enforced at `open`: a
   * provider whose browser is missing still SELECTS (so the caller gets the
   * precise `no-browser` error + the requirement, not a generic "no provider").
   */
  available(): boolean {
    return !this.disposed && playwrightCoreAvailable()
  }

  unavailableReason(): string | undefined {
    if (this.disposed) return 'the plugin was unloaded (no provider is registered any more)'
    if (!playwrightCoreAvailable()) return browserRequirement(this.config)
    const binary = browserBinary(this.config)
    if (!binary.found) return browserRequirement(this.config)
    return undefined
  }

  engine(): BrowserEngineInfo {
    const binary = browserBinary(this.config)
    // The version is READ from the running browser when there is one: a browser
    // that was never launched must not carry a version nobody observed.
    const version = sharedBrowserVersion()
    return {
      engine: ENGINE,
      ...(version === undefined ? {} : { version }),
      ...(binary.path === undefined ? {} : { executablePath: binary.path }),
      headless: this.config.headless,
      source: `playwright-core + ${binary.source}`,
      available: binary.found && playwrightCoreAvailable(),
      ...(binary.found && playwrightCoreAvailable() ? {} : { requirement: browserRequirement(this.config) }),
    }
  }

  capabilities(): BrowserProviderCapabilities {
    return {
      provider: providerId,
      engine: this.engine(),
      actKinds: [...ACT_KINDS],
      extractModes: [...EXTRACT_MODES],
      evaluate: true,
      screenshot: true,
      tabs: true,
      observe: true,
      storageState: true,
      // The seam never serves these: a caller sees the gap instead of assuming it.
      unsupported: ['pdf-export', 'proxy-rotation', 'captcha-solving', 'ai-vision-loop'],
    }
  }

  sessions(): BrowserSessionInfo[] {
    return [...this.sessionsById.values()].map((session) => this.infoOf(session))
  }

  /** Releases every browser context and the shared browser (plugin unload). */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const session of [...this.sessionsById.values()]) {
      await this.persistState(session).catch(() => undefined)
      await session.context.close().catch(() => undefined)
    }
    this.sessionsById.clear()
    if (this.holdsBrowser) {
      this.holdsBrowser = false
      await releaseSharedBrowser().catch(() => undefined)
    }
    this.browser = undefined
    this.launching = undefined
  }

  // -------------------------------------------------------------------------
  // Session lifecycle.
  // -------------------------------------------------------------------------

  async openSession(spec: BrowserSessionSpec, options: BrowserUseCallOptions): Promise<BrowserSessionInfo> {
    this.assertUsable()
    const id = safeSessionId(str(spec.session) ?? this.config.defaultSession)
    const existing = this.sessionsById.get(id)
    if (existing !== undefined) {
      existing.lastUsedAt = Date.now()
      return this.infoOf(existing)
    }
    if (this.sessionsById.size >= options.maxSessions) {
      throw new BrowserUseError(
        'browser-use.session-limit',
        `the provider already holds ${this.sessionsById.size} session(s) (the cap of this deployment); close one first`,
        { stage: 'open', details: { maxSessions: options.maxSessions, live: [...this.sessionsById.keys()] } },
      )
    }
    if (spec.headless !== undefined && spec.headless !== this.config.headless) {
      // Honest refusal: chromium is SHARED with web-page/web-session, so a
      // per-session window mode cannot be honoured without a second process.
      throw new BrowserUseError(
        'browser-use.not-implemented',
        'headless is a LAUNCH-time setting of the shared chromium process: set plugins.browser-use-playwright.headless (the provider shares its browser with web-page/web-session)',
        { stage: 'open', details: { requested: spec.headless, effective: this.config.headless } },
      )
    }
    const browser = await this.ensureBrowser()
    const stateFile = str(spec.storageStateFile) ?? sessionStateFile(this.config.storageStateDir, id)
    const stateMode = str(spec.stateMode) ?? 'reuse'
    const { storageState, stateReused } = await this.resolveStorageState(stateMode, spec.storageState, stateFile)
    const downloadDir = str(spec.downloadDir) ?? path.join(this.config.downloadDir, id)
    await fs.promises.mkdir(downloadDir, { recursive: true }).catch(() => undefined)
    const proxy = await this.resolveProxy(spec.proxy)
    type ContextOptions = NonNullable<Parameters<Browser['newContext']>[0]>
    const contextOptions: ContextOptions = {
      acceptDownloads: true,
      viewport: spec.viewport ?? this.config.viewport,
      ...(spec.userAgent ?? this.config.userAgent) === undefined ? {} : { userAgent: (spec.userAgent ?? this.config.userAgent) as string },
    }
    const locale = spec.locale ?? this.config.locale
    if (locale !== undefined) contextOptions.locale = locale
    const timezone = spec.timezoneId ?? this.config.timezoneId
    if (timezone !== undefined) contextOptions.timezoneId = timezone
    if (proxy !== undefined) contextOptions.proxy = proxy
    if (storageState !== undefined) contextOptions.storageState = storageState as ContextOptions['storageState']
    const context = await browser.newContext(contextOptions).catch((error: unknown) => {
      throw this.mapLaunchError(error, 'open')
    })
    context.setDefaultTimeout(options.actionTimeoutMs)
    context.setDefaultNavigationTimeout(options.navigationTimeoutMs)
    const session: LiveSession = {
      id,
      context,
      active: 0,
      stateFile,
      stateReused,
      downloadDir,
      requests: [],
      downloads: [],
      refs: new Map(),
      snapshots: new Map(),
      lastTitle: '',
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
      disposers: [],
    }
    this.observeSession(session)
    const page = context.pages()[0] ?? (await context.newPage())
    session.active = Math.max(0, context.pages().indexOf(page))
    this.sessionsById.set(id, session)
    await this.touch(session)
    return this.infoOf(session)
  }

  async closeSession(session: string, options: BrowserUseCallOptions): Promise<BrowserSessionInfo> {
    const live = this.requireSession(session)
    const info = this.infoOf(live, false)
    await this.persistState(live)
    for (const remove of live.disposers) {
      try {
        remove()
      } catch {
        // A listener that refuses to detach must not block the teardown.
      }
    }
    live.disposers = []
    await live.context.close().catch(() => undefined)
    this.sessionsById.delete(live.id)
    return info
  }

  async navigate(session: string, request: BrowserNavigateRequest, options: BrowserUseCallOptions): Promise<BrowserNavigateAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const waitUntil = request.waitUntil ?? 'load'
    const timeout = request.timeoutMs ?? options.navigationTimeoutMs
    const started = Date.now()
    // Refs of the page we are leaving are stale from here on (honest, not a guess).
    this.invalidateRefs(live, page)
    let response: Awaited<ReturnType<Page['goto']>>
    try {
      response = await page.goto(request.url, { waitUntil, timeout })
    } catch (error) {
      throw mapError(error, `navigate ${request.url}`, 'browser-use.navigation-failed', { url: request.url, waitUntil })
    }
    const status = response?.status()
    if (status !== undefined && status >= 400 && request.allowHttpError !== true) {
      throw new BrowserUseError('browser-use.http-status', `the page answered HTTP ${status} (pass allowHttpError: true to accept it)`, {
        stage: 'navigate',
        details: { url: page.url(), httpStatus: status, allowHttpError: false },
      })
    }
    live.lastTitle = await page.title().catch(() => '')
    await this.touch(live)
    return {
      action: 'navigate',
      url: page.url(),
      title: live.lastTitle,
      ...(status === undefined ? {} : { httpStatus: status }),
      durationMs: Date.now() - started,
    }
  }

  async snapshot(session: string, request: BrowserSnapshotRequest, options: BrowserUseCallOptions): Promise<BrowserSnapshot> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const maxNodes = Math.min(request.maxNodes ?? options.maxSnapshotNodes, options.maxSnapshotNodes)
    const includeText = request.includeText !== false
    const selector = str(request.selector)
    let result: { nodes: BrowserSnapshotNode[]; totalNodes: number }
    try {
      result = await page.evaluate(snapshotInPage, {
        includeText,
        maxNodes,
        refAttribute: REF_ATTRIBUTE,
        ...(selector === undefined ? {} : { selector }),
      })
    } catch (error) {
      throw mapError(error, 'snapshot', 'browser-use.provider-failed', { selector: selector ?? null })
    }
    const all = Array.isArray(result.nodes) ? result.nodes : []
    const nodes = all.slice(0, maxNodes)
    const snapshotId = this.mintSnapshotId(live)
    this.registerRefs(live, page, snapshotId, nodes)
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    return {
      action: 'snapshot',
      session: live.id,
      snapshotId,
      url: page.url(),
      title: live.lastTitle,
      nodes,
      totalNodes: all.length,
      truncated: all.length > nodes.length,
      maxNodes,
      chars: JSON.stringify(nodes).length,
    }
  }

  // -------------------------------------------------------------------------
  // Private plumbing: sessions, refs, storage state, teardown.
  // -------------------------------------------------------------------------

  /**
   * A call on a deployment that cannot drive a browser is a TYPED failure with
   * the exact requirement (requirement 3): never a fallback to an HTTP fetch
   * that pretends to be a browser.
   */
  private assertUsable(): void {
    if (this.disposed) {
      throw new BrowserUseError(
        'browser-use.no-provider',
        'the playwright provider was unloaded: re-load the plugin row before it can drive a browser again',
        { stage: 'open', details: { provider: providerId } },
      )
    }
    if (!playwrightCoreAvailable()) {
      throw new BrowserUseError('browser-use.no-browser', browserRequirement(this.config), {
        stage: 'open',
        details: { provider: providerId, missing: 'playwright-core' },
      })
    }
    const binary = browserBinary(this.config)
    if (!binary.found) {
      throw new BrowserUseError('browser-use.no-browser', browserRequirement(this.config), {
        stage: 'open',
        details: { provider: providerId, executablePath: this.config.executablePath ?? null, checked: binary.source },
      })
    }
  }

  /**
   * The chromium of this deployment: the SHARED launcher of the repository, so
   * `web-page`, `web-session` and this provider never launch competing browsers
   * (the launcher is refcounted; the last holder closes the process).
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser !== undefined) return this.browser
    if (this.launching !== undefined) return await this.launching
    this.launching = (async () => {
      const proxy = await this.resolveProxy(undefined)
      const browser = await acquireSharedBrowser({
        ...(this.config.executablePath === undefined ? {} : { executablePath: this.config.executablePath }),
        args: this.config.browserArgs,
        timeoutMs: this.config.launchTimeoutMs,
        headless: this.config.headless,
        ...(proxy === undefined ? {} : { proxy }),
      }).catch((error: unknown) => {
        throw this.mapLaunchError(error, 'launch')
      })
      this.browser = browser
      this.holdsBrowser = true
      return browser
    })()
    try {
      return await this.launching
    } finally {
      this.launching = undefined
    }
  }

  /** A launch failure is `no-browser` when it reads like a missing binary. */
  private mapLaunchError(error: unknown, stage: string): BrowserUseError {
    if (isBrowserUseError(error)) return error
    const message = error instanceof Error ? error.message : String(error)
    if (looksLikeMissingBrowser(message)) {
      return new BrowserUseError('browser-use.no-browser', `${stage}: ${firstLine(message)} - ${browserRequirement(this.config)}`, {
        stage,
        details: { provider: providerId, requirement: browserRequirement(this.config) },
      })
    }
    return new BrowserUseError('browser-use.provider-failed', `${stage}: ${firstLine(message)}`, {
      stage,
      details: { provider: providerId },
    })
  }

  /**
   * The proxy a session launches with. A `credential` NAME is resolved through
   * `ctx.credentials` HERE, at launch time, and the VALUE never leaves this
   * method (no log line, no answer, no state file).
   */
  private async resolveProxy(
    override: BrowserSessionSpec['proxy'],
  ): Promise<{ server: string; username?: string; password?: string } | undefined> {
    const spec = override ?? this.config.proxy
    if (spec === undefined || typeof spec.server !== 'string' || spec.server.trim().length === 0) return undefined
    const resolved: { server: string; username?: string; password?: string } = { server: spec.server.trim() }
    if (typeof spec.username === 'string' && spec.username.trim().length > 0) resolved.username = spec.username.trim()
    const credential = typeof spec.credential === 'string' ? spec.credential.trim() : ''
    if (credential.length > 0) {
      const resolvedValue = await this.resolveCredential(credential)
      if (resolvedValue === undefined) {
        throw new BrowserUseError('browser-use.invalid-input', `the proxy credential '${credential}' is not resolvable in this deployment`, {
          stage: 'open',
          details: { field: 'proxy.credential' },
        })
      }
      resolved.password = resolvedValue
    }
    return resolved
  }

  /** One credential VALUE, or undefined (never logged, never answered). */
  private async resolveCredential(name: string): Promise<string | undefined> {
    if (this.credentials === undefined || typeof this.credentials.resolve !== 'function') return undefined
    try {
      const answer = await this.credentials.resolve({ name })
      const value = (answer as { value?: unknown } | undefined)?.value
      return typeof value === 'string' && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Seeds a session's storage state: `reuse` (the session's state file when it
   * exists, the `web-session` convention), `fresh` (nothing) or `inline` (the
   * caller's object). A corrupt file is IGNORED with a warning, never a failure:
   * a session that cannot reuse its cookies is still a usable session.
   */
  private async resolveStorageState(
    mode: string,
    inline: unknown,
    stateFile: string,
  ): Promise<{ storageState?: unknown; stateReused: boolean }> {
    if (mode === 'inline') return { storageState: inline, stateReused: false }
    if (mode === 'fresh') return { stateReused: false }
    let raw: string
    try {
      raw = await fs.promises.readFile(stateFile, 'utf8')
    } catch {
      return { stateReused: false }
    }
    try {
      return { storageState: JSON.parse(raw) as unknown, stateReused: true }
    } catch {
      return { stateReused: false }
    }
  }

  /** Persists the session's storage state to its file (cookies + localStorage). */
  private async persistState(session: LiveSession): Promise<void> {
    if (session.stateFile.length === 0) return
    await fs.promises.mkdir(path.dirname(session.stateFile), { recursive: true }).catch(() => undefined)
    await session.context.storageState({ path: session.stateFile }).catch(() => undefined)
  }

  /** The live session behind an id, or the typed failure that names the state. */
  private requireSession(session: string): LiveSession {
    const id = safeSessionId(session)
    const live = this.sessionsById.get(id)
    if (live === undefined) {
      const known = [...this.sessionsById.keys()]
      throw new BrowserUseError(
        known.length === 0 ? 'browser-use.no-session' : 'browser-use.unknown-session',
        known.length === 0
          ? `no browser session is open (provider '${providerId}'): call 'open' first`
          : `no session '${id}' in provider '${providerId}' (open: ${known.join(', ')})`,
        { stage: 'session', details: { session: id, open: known } },
      )
    }
    return live
  }

  /** The tab every action of a session uses (never a stale index). */
  private activePage(session: LiveSession): Page {
    const pages = session.context.pages()
    if (pages.length === 0) {
      throw new BrowserUseError('browser-use.no-session', `session '${session.id}' has no open page any more`, {
        stage: 'session',
        details: { session: session.id },
      })
    }
    session.active = Math.min(Math.max(0, session.active), pages.length - 1)
    return pages[session.active] as Page
  }

  /** What a caller learns about a session (never a cookie VALUE, never a secret). */
  private infoOf(session: LiveSession, live = true): BrowserSessionInfo {
    let url = 'about:blank'
    let tabs = 0
    try {
      tabs = session.context.pages().length
      url = session.context.pages()[session.active]?.url() ?? url
    } catch {
      // A closed context is still describable: the caller sees `live: false`.
    }
    return {
      id: session.id,
      provider: providerId,
      url,
      title: session.lastTitle,
      engine: this.engine(),
      live: live && !session.context.isClosed(),
      stateReused: session.stateReused,
      stateFile: session.stateFile,
      tabs,
      requests: session.requests.length,
      downloads: session.downloads.length,
      openedAt: session.openedAt,
      lastUsedAt: session.lastUsedAt,
    }
  }

  /** Stamps the use of a session (the idle TTL of the deployment reads this). */
  private async touch(session: LiveSession): Promise<void> {
    session.lastUsedAt = Date.now()
  }

  /** Drops the refs of a page: they belong to a document that is gone. */
  private invalidateRefs(session: LiveSession, page: Page): void {
    const previous = session.snapshots.get(page)
    session.snapshots.delete(page)
    if (previous === undefined) return
    for (const [ref, snapshotId] of session.refs) {
      if (snapshotId === previous) session.refs.delete(ref)
    }
  }

  /** Mints the id of the next snapshot (`s1`, `s2`, ...). */
  private mintSnapshotId(session: LiveSession): string {
    this.snapshotCounter += 1
    return `s${String(this.snapshotCounter)}`
  }

  /**
   * Records which snapshot minted each ref. A ref of an OLDER snapshot of the
   * same page is `stale-ref`: the page changed under the caller's feet, and a
   * silent click at the old position is exactly what this provider refuses.
   */
  private registerRefs(session: LiveSession, page: Page, snapshotId: string, nodes: BrowserSnapshotNode[]): void {
    this.invalidateRefs(session, page)
    session.snapshots.set(page, snapshotId)
    for (const node of nodes) session.refs.set(node.ref, snapshotId)
  }

  /**
   * The element an interaction targets: a REF from the current snapshot (the
   * round-tripping half of requirement 4) or the caller's own selector. Both
   * paths end in a `locator`, and neither ever guesses: an empty match is a
   * typed `selector-not-found` / `stale-ref`.
   */
  private async resolveTarget(
    session: LiveSession,
    page: Page,
    request: { ref?: string; selector?: string },
    what: string,
  ): Promise<{ locator: Locator; ref?: string; selector?: string; resolved: boolean }> {
    const ref = request.ref === undefined ? undefined : requireRef(request.ref)
    if (ref !== undefined) {
      const snapshotId = session.refs.get(ref)
      const current = session.snapshots.get(page)
      if (snapshotId === undefined || snapshotId !== current) {
        throw new BrowserUseError(
          'browser-use.stale-ref',
          `the ref '${ref}' belongs to ${snapshotId === undefined ? 'no snapshot of this page' : `snapshot '${snapshotId}'`}; the page is on '${current ?? 'none'}' - take a fresh \`snapshot\` and act on its refs`,
          { stage: what, details: { ref, snapshot: current ?? null, mintedIn: snapshotId ?? null } },
        )
      }
      const locator = page.locator(`[${REF_ATTRIBUTE}="${ref}"]`)
      const count = await locator.count().catch(() => 0)
      if (count === 0) {
        throw new BrowserUseError('browser-use.stale-ref', `the element behind '${ref}' is gone from the page (take a fresh \`snapshot\`)`, {
          stage: what,
          details: { ref },
        })
      }
      return { locator: locator.first(), ref, selector: `[${REF_ATTRIBUTE}="${ref}"]`, resolved: true }
    }
    if (request.selector === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `${what} needs a 'ref' (from a \`snapshot\`) or a 'selector'`, {
        stage: what,
        details: { field: 'ref' },
      })
    }
    const selector = requireText(request.selector, 'selector', 4_096)
    const locator = page.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      throw new BrowserUseError('browser-use.selector-not-found', `${what}: '${selector}' matched no element`, {
        stage: what,
        details: { selector },
      })
    }
    return { locator: locator.first(), selector, resolved: false }
  }

  /**
   * Lets in-flight work settle after an interaction (a navigation started by a
   * click, a fetch that fills a panel). It is BOUNDED and never fails the call:
   * the caller asked for an interaction, not for a page that quiesces.
   */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 2_000 }).catch(() => undefined)
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // Interaction: `act` (the closed vocabulary), `evaluate`, `extract`.
  // -------------------------------------------------------------------------

  /**
   * ONE interaction. A REF comes from the CURRENT snapshot of the active page and
   * is resolved through the ref table the provider minted (never a caller-built
   * selector); a ref that no longer resolves is the typed `stale-ref`, so a
   * caller never clicks whatever moved into that position.
   */
  async act(session: string, request: BrowserActRequest, options: BrowserUseCallOptions): Promise<BrowserActAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const kind = requireEnum(request.kind, ACT_KINDS, 'kind')
    const timeout = request.timeoutMs ?? options.actionTimeoutMs
    const started = Date.now()
    let resolved = false
    let appliedRef: string | undefined
    let appliedSelector: string | undefined
    try {
      const targeted = TARGETED_ACT_KINDS.includes(kind)
      if (targeted || (kind === 'press' && (request.ref !== undefined || request.selector !== undefined))) {
        const target = await this.resolveTarget(live, page, request, `act: ${kind}`)
        appliedRef = target.ref
        appliedSelector = target.selector
        resolved = target.resolved
        const locator = target.locator
        switch (kind) {
          case 'click':
            await locator.click({ timeout })
            break
          case 'type': {
            // `type` writes KEYSTROKE BY KEYSTROKE (an autocomplete sees every
            // key); `fill` replaces the value atomically. Both are honest.
            const value = requireText(request.value, 'value', 100_000)
            await locator.click({ timeout })
            await locator.fill('', { timeout })
            await locator.pressSequentially(value, { timeout })
            break
          }
          case 'fill':
            await locator.fill(requireText(request.value, 'value', 100_000), { timeout })
            break
          case 'select': {
            const value = requireText(request.value, 'value', 10_000)
            await locator.selectOption(request.byLabel === true ? { label: value } : { value }, { timeout })
            break
          }
          case 'hover':
            await locator.hover({ timeout })
            break
          case 'press':
            await locator.press(requireText(request.key, 'key', 64), { timeout })
            break
          case 'upload': {
            if (!Array.isArray(request.files) || request.files.length === 0) {
              throw new BrowserUseError('browser-use.invalid-input', "'act: upload' needs 'files' (one or more paths)", {
                stage: 'act',
                details: { field: 'files', kind },
              })
            }
            const files = request.files.map((file) => requireText(file, 'files[]', 4_096))
            await locator.setInputFiles(files, { timeout })
            break
          }
          case 'check':
            await locator.setChecked(request.checked !== false, { timeout })
            break
          case 'focus':
            await locator.focus()
            break
          case 'scroll':
            await locator.scrollIntoViewIfNeeded({ timeout })
            break
          case 'waitFor':
            await locator.waitFor({ state: request.state ?? 'visible', timeout })
            break
          default:
            throw new BrowserUseError('browser-use.not-implemented', `act: ${kind} is not served by this provider`, {
              stage: 'act',
              details: { kind },
            })
        }
      } else {
        switch (kind) {
          case 'scroll': {
            const direction = requireEnum(request.direction, SCROLL_DIRECTIONS, 'direction', 'down')
            const amount = request.amount === undefined ? undefined : requirePositiveInt(request.amount, 'amount', 100_000)
            const size = page.viewportSize()
            const horizontal = direction === 'left' || direction === 'right'
            const step = amount ?? (horizontal ? (size?.width ?? 1280) : (size?.height ?? 720))
            const dx = direction === 'left' ? -1 : direction === 'right' ? 1 : 0
            const dy = direction === 'up' ? -1 : direction === 'down' ? 1 : 0
            await page.evaluate(
              ({ x, y, pixels }: { x: number; y: number; pixels: number }) => {
                window.scrollBy(x * pixels, y * pixels)
              },
              { x: dx, y: dy, pixels: step },
            )
            break
          }
          case 'press':
            // No target: the chord goes to whatever the page has focused (a
            // modal, a global handler) - a documented behaviour, not an accident.
            await page.keyboard.press(requireText(request.key, 'key', 64))
            break
          case 'back':
            this.invalidateRefs(live, page)
            await page.goBack({ waitUntil: 'load', timeout })
            break
          case 'forward':
            this.invalidateRefs(live, page)
            await page.goForward({ waitUntil: 'load', timeout })
            break
          case 'reload':
            this.invalidateRefs(live, page)
            await page.reload({ waitUntil: 'load', timeout })
            break
          case 'waitFor':
            await page.waitForLoadState('networkidle', { timeout }).catch(() => undefined)
            break
          default:
            throw new BrowserUseError(
              'browser-use.invalid-input',
              `'act: ${kind}' needs a 'ref' (from a \u0060snapshot\u0060) or a 'selector'`,
              { stage: 'act', details: { kind, field: 'ref' } },
            )
        }
      }
      if (request.settle !== false) await this.settle(page)
      live.lastTitle = await page.title().catch(() => live.lastTitle)
      await this.touch(live)
      const answer: BrowserActAnswer = {
        action: 'act',
        kind,
        session: live.id,
        url: page.url(),
        title: live.lastTitle,
        resolved,
        durationMs: Date.now() - started,
      }
      if (appliedRef !== undefined) answer.ref = appliedRef
      if (appliedSelector !== undefined) answer.selector = appliedSelector
      if (request.snapshot === true) answer.snapshot = await this.snapshot(live.id, {}, options)
      return answer
    } catch (error) {
      throw mapError(error, `act: ${kind}`, 'browser-use.provider-failed', { kind, ref: appliedRef ?? null })
    }
  }

  /** Runs ONE javascript expression in the page and answers a JSON-safe value. */
  async evaluate(
    session: string,
    request: BrowserEvaluateRequest,
    options: BrowserUseCallOptions,
  ): Promise<BrowserEvaluateAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const expression = requireText(request.expression, 'expression', 100_000)
    const values = Array.isArray(request.args) ? request.args : []
    const maxChars = Math.min(request.maxChars ?? options.maxTextChars, options.maxTextChars)
    let result: unknown
    try {
      result = await page.evaluate(
        async ({ source, args }: { source: string; args: unknown[] }) => {
          // The caller writes an EXPRESSION, never a module: it is wrapped and
          // called with the arguments it was handed (JSON only).
          const evaluator = new Function(...args.map((_value, index) => `a${String(index)}`), `return (${source})`) as (
            ...rest: unknown[]
          ) => unknown
          return await Promise.resolve(evaluator(...args))
        },
        { source: expression, args: values },
      )
    } catch (error) {
      throw mapError(error, 'evaluate', 'browser-use.evaluation-failed', { expression: firstLine(expression) })
    }
    let serialized: string
    try {
      serialized = JSON.stringify(result ?? null) ?? 'null'
    } catch {
      serialized = String(result)
      result = serialized
    }
    const truncated = serialized.length > maxChars
    const value = truncated ? serialized.slice(0, maxChars) : result
    const resultType = result === null ? 'null' : Array.isArray(result) ? 'array' : typeof result
    await this.touch(live)
    return {
      action: 'evaluate',
      session: live.id,
      url: page.url(),
      value,
      resultType,
      truncated,
      chars: Math.min(serialized.length, maxChars),
    }
  }

  /**
   * Reads the page (or a scope of it) in a caller-chosen shape. The extraction
   * runs INSIDE the page in one round trip; a `web-recipe` scope is handed in by
   * the HOST as the request `selector` (it owns the store lookup, requirement 5),
   * so this provider never imports the recipe plugin.
   */
  async extract(
    session: string,
    request: BrowserExtractRequest,
    options: BrowserUseCallOptions,
  ): Promise<BrowserExtractAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const mode = request.mode === undefined ? 'text' : requireEnum(request.mode, EXTRACT_MODES, 'mode', 'text')
    const maxChars = Math.min(request.maxChars ?? options.maxTextChars, options.maxTextChars)
    let scope: string | undefined
    if (request.ref !== undefined) {
      const target = await this.resolveTarget(live, page, { ref: request.ref }, 'extract')
      scope = target.selector
    } else if (request.selector !== undefined) {
      scope = requireText(request.selector, 'selector', 4_096)
    }
    const payload: ExtractPayload = { mode, maxChars }
    if (scope !== undefined) payload.selector = scope
    if (mode === 'attributes') {
      payload.attributes = Array.isArray(request.attributes)
        ? request.attributes.map((name) => requireText(name, 'attributes[]', 128))
        : DEFAULT_ATTRIBUTES
    }
    if (mode === 'table') payload.index = request.index === undefined ? 0 : requireNonNegativeInt(request.index, 'index', 1_000)
    if (mode === 'json' && request.expression !== undefined) payload.expression = requireText(request.expression, 'expression', 100_000)
    let result: Awaited<ReturnType<typeof extractInPage>>
    try {
      result = await page.evaluate(extractInPage, payload)
    } catch (error) {
      throw mapError(error, 'extract', 'browser-use.provider-failed', { mode, selector: scope ?? null })
    }
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    const answer: BrowserExtractAnswer = {
      action: 'extract',
      session: live.id,
      url: page.url(),
      title: live.lastTitle,
      mode,
      chars: Math.min(typeof result.chars === 'number' ? result.chars : 0, maxChars),
      truncated: result.truncated === true,
    }
    if (typeof result.note === 'string') answer.note = result.note
    if (typeof result.text === 'string') answer.text = result.text.slice(0, maxChars)
    if (Array.isArray(result.rows)) answer.rows = result.rows
    if (Array.isArray(result.elements)) answer.elements = result.elements
    if (Array.isArray(result.links)) answer.links = result.links
    if (mode === 'json') {
      const json = typeof result.text === 'string' ? result.text : JSON.stringify(result.value ?? null)
      answer.text = json.slice(0, maxChars)
      answer.chars = answer.text.length
    }
    return answer
  }

  // -------------------------------------------------------------------------
  // Output + observation: `screenshot`, `tabs`, `wait`, `observe`, `state`.
  // -------------------------------------------------------------------------

  /**
   * Captures the page (or one element) into a FILE and answers its path, never
   * unbounded base64: a screenshot travels as a path a caller can read, and the
   * byte cap of the seam is enforced HERE (an oversized image is deleted and
   * reported as the typed `oversized`, so no caller ever receives a huge blob).
   */
  async screenshot(
    session: string,
    request: BrowserScreenshotRequest,
    options: BrowserUseCallOptions,
  ): Promise<BrowserScreenshotAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const format = request.format === undefined ? 'png' : requireEnum(request.format, SCREENSHOT_FORMATS, 'format', 'png')
    const maxBytes = Math.min(request.maxBytes ?? options.maxImageBytes, options.maxImageBytes)
    const explicit = str(request.path)
    const dir = explicit === undefined ? options.screenshotDir : path.dirname(explicit)
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => undefined)
    const label = slugOf(`${str(request.label) ?? live.lastTitle ?? 'page'}`)
    const extension = format === 'jpeg' ? 'jpg' : 'png'
    const file = explicit ?? path.join(dir, `${label}-${String(Date.now())}.${extension}`)
    const shot: ShotOptions = { path: file, type: format, fullPage: request.fullPage === true && request.ref === undefined && request.selector === undefined }
    if (format === 'jpeg' && request.quality !== undefined) shot.quality = requirePositiveInt(request.quality, 'quality', 100)
    let size: { width: number; height: number } | undefined
    try {
      if (request.ref !== undefined || request.selector !== undefined) {
        const target = await this.resolveTarget(live, page, request, 'screenshot')
        const box = await target.locator.boundingBox()
        if (box !== null) size = { width: Math.round(box.width), height: Math.round(box.height) }
        await target.locator.screenshot(shot)
      } else {
        size = await page.evaluate(() => ({
          width: Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth),
          height: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight),
        }))
        await page.screenshot(shot)
      }
    } catch (error) {
      throw mapError(error, 'screenshot', 'browser-use.provider-failed', { path: file })
    }
    const stat = await fs.promises.stat(file).catch(() => undefined)
    const bytes = stat === undefined ? 0 : stat.size
    if (bytes > maxBytes) {
      await fs.promises.rm(file, { force: true }).catch(() => undefined)
      throw new BrowserUseError(
        'browser-use.oversized',
        `the screenshot is ${String(bytes)} bytes, above the cap of ${String(maxBytes)}; lower the viewport, capture one element or raise plugins.browser-use-impl.maxImageBytes`,
        { stage: 'screenshot', details: { bytes, maxBytes } },
      )
    }
    live.lastTitle = await page.title().catch(() => live.lastTitle)
    await this.touch(live)
    return {
      action: 'screenshot',
      session: live.id,
      url: page.url(),
      path: file,
      format,
      mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
      bytes,
      fullPage: shot.fullPage === true,
      ...(size === undefined ? {} : { width: size.width, height: size.height }),
    }
  }

  /** Lists / opens / switches / closes the tabs of one session. */
  async tabs(session: string, request: BrowserTabRequest, options: BrowserUseCallOptions): Promise<BrowserTabAnswer> {
    const live = this.requireSession(session)
    const action = request.action === undefined ? 'list' : requireEnum(request.action, TAB_ACTIONS, 'tabAction', 'list')
    const timeout = request.timeoutMs ?? options.navigationTimeoutMs
    let opened: number | undefined
    let closed: number | undefined
    if (action === 'new') {
      const created = await live.context.newPage()
      live.active = Math.max(0, live.context.pages().indexOf(created))
      live.snapshots.delete(created)
      opened = live.active
      const url = str(request.url)
      if (url !== undefined) {
        try {
          await created.goto(url, { waitUntil: request.navigate === false ? 'commit' : 'load', timeout })
        } catch (error) {
          throw mapError(error, `tabs new ${url}`, 'browser-use.navigation-failed', { url })
        }
      }
    } else if (action === 'switch' || action === 'close') {
      const pages = live.context.pages()
      const index = requireNonNegativeInt(request.index, 'index', 10_000)
      const page = pages[index]
      if (page === undefined) {
        throw new BrowserUseError('browser-use.invalid-input', `'tabAction: ${action}' names tab ${String(index)} but the session has ${String(pages.length)} tab(s)`, {
          stage: 'tabs',
          details: { index, tabs: pages.length },
        })
      }
      if (action === 'switch') {
        live.active = index
      } else {
        await page.close().catch(() => undefined)
        closed = index
        if (pages.length <= 1) {
          throw new BrowserUseError('browser-use.invalid-input', 'closing the LAST tab would leave the session without a page; close the session instead', {
            stage: 'tabs',
            details: { index },
          })
        }
        live.active = Math.min(live.active, live.context.pages().length - 1)
      }
    }
    await this.touch(live)
    const pages = live.context.pages()
    const tabs = await Promise.all(
      pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: index === live.active,
      })),
    )
    return { action: 'tabs', session: live.id, tabs, activeIndex: live.active, ...(closed === undefined ? {} : { closed }), ...(opened === undefined ? {} : { opened }) }
  }

  /** A bounded sleep and/or a bounded condition (never an unbounded poll loop). */
  async wait(session: string, request: BrowserWaitRequest, options: BrowserUseCallOptions): Promise<BrowserWaitAnswer> {
    const live = this.requireSession(session)
    const page = this.activePage(live)
    const started = Date.now()
    const budget = request.timeoutMs ?? options.actionTimeoutMs
    const satisfied: string[] = []
    if (request.ms !== undefined) {
      await sleep(Math.min(requireNonNegativeInt(request.ms, 'ms', 600_000), budget))
      satisfied.push(`slept ${String(request.ms)}ms`)
    }
    if (request.ref !== undefined || request.selector !== undefined) {
      const state = request.state ?? 'visible'
      const target = await this.resolveTarget(live, page, request, 'wait')
      try {
        await target.locator.waitFor({ state, timeout: budget })
      } catch (error) {
        throw mapError(error, `wait for ${state}`, 'browser-use.timeout', { state })
      }
      satisfied.push(`element ${state}`)
    }
    if (request.urlContains !== undefined) {
      const fragment = requireText(request.urlContains, 'urlContains', 4_096)
      try {
        await page.waitForURL((url) => url.toString().includes(fragment), { timeout: budget })
      } catch (error) {
        throw mapError(error, `wait for url~${fragment}`, 'browser-use.timeout', { urlContains: fragment })
      }
      satisfied.push('urlContains')
    }
    if (request.text !== undefined) {
      const text = requireText(request.text, 'text', 100_000)
      try {
        await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: budget })
      } catch (error) {
        throw mapError(error, 'wait for text', 'browser-use.timeout', { text: firstLine(text) })
      }
      satisfied.push('text')
    }
    if (request.networkIdle === true) {
      try {
        await page.waitForLoadState('networkidle', { timeout: budget })
      } catch (error) {
        throw mapError(error, 'wait for networkIdle', 'browser-use.timeout', { networkIdle: true })
      }
      satisfied.push('networkIdle')
    }
    await this.touch(live)
    return { action: 'wait', session: live.id, url: page.url(), waitedMs: Date.now() - started, satisfied }
  }

  /** What the session SAW: the bounded network + download view (no polling loop). */
  async observe(session: string, request: BrowserObserveRequest, options: BrowserUseCallOptions): Promise<BrowserObserveAnswer> {
    const live = this.requireSession(session)
    const limit = Math.min(request.limit === undefined ? this.config.observeLimit : requirePositiveInt(request.limit, 'limit', 5_000), this.config.observeLimit)
    const filter = str(request.filter)
    const requests = (filter === undefined ? live.requests : live.requests.filter((record) => record.url.includes(filter))).slice(-limit)
    const downloads = live.downloads.slice(-limit)
    await this.touch(live)
    return {
      action: 'observe',
      session: live.id,
      requests: requests.map((record) => ({
        method: record.method,
        url: record.url,
        ...(record.status === undefined ? {} : { status: record.status }),
        ...(record.resourceType === undefined ? {} : { resourceType: record.resourceType }),
        ...(record.contentType === undefined ? {} : { contentType: record.contentType }),
      })),
      downloads: downloads.map((record) => ({
        url: record.url,
        suggestedFilename: record.suggestedFilename,
        ...(record.path === undefined ? {} : { path: record.path }),
        ...(record.bytes === undefined ? {} : { bytes: record.bytes }),
        ...(record.state === undefined ? {} : { state: record.state }),
      })),
      totalRequests: live.requests.length,
      totalDownloads: live.downloads.length,
    }
  }

  /**
   * The storage state of a session (the SAME file `web-session` uses). The answer
   * reports COUNTS and hosts, never a cookie value: a state file is a secret of
   * the session, and the seam never echoes secrets.
   */
  async state(session: string, request: BrowserStateRequest, options: BrowserUseCallOptions): Promise<BrowserStateAnswer> {
    const live = this.requireSession(session)
    const action = request.action === undefined ? 'save' : requireEnum(request.action, STATE_ACTIONS, 'stateAction', 'save')
    const file = str(request.path) ?? live.stateFile
    if (action === 'clear') {
      await fs.promises.rm(file, { force: true }).catch(() => undefined)
      return { action: 'state', session: live.id, stateAction: 'clear', stateFile: file }
    }
    if (action === 'read') {
      const raw = await fs.promises.readFile(file, 'utf8').catch(() => undefined)
      if (raw === undefined) {
        throw new BrowserUseError('browser-use.no-session', `session '${live.id}' has no storage state at '${file}' yet`, {
          stage: 'state',
          details: { stateFile: file },
        })
      }
      const parsed = parseState(raw)
      return {
        action: 'state',
        session: live.id,
        stateAction: 'read',
        stateFile: file,
        bytes: Buffer.byteLength(raw, 'utf8'),
        ...(parsed === undefined ? {} : { cookies: parsed.cookies, origins: parsed.origins }),
      }
    }
    await fs.promises.mkdir(path.dirname(file), { recursive: true }).catch(() => undefined)
    try {
      await live.context.storageState({ path: file })
    } catch (error) {
      throw mapError(error, 'state: save', 'browser-use.provider-failed', { stateFile: file })
    }
    live.stateFile = file
    const raw = await fs.promises.readFile(file, 'utf8').catch(() => undefined)
    const parsed = raw === undefined ? undefined : parseState(raw)
    await this.touch(live)
    return {
      action: 'state',
      session: live.id,
      stateAction: 'save',
      stateFile: file,
      ...(raw === undefined ? {} : { bytes: Buffer.byteLength(raw, 'utf8') }),
      ...(parsed === undefined ? {} : { cookies: parsed.cookies, origins: parsed.origins }),
    }
  }

  /**
   * Attaches the network + download observers of a session. They are bounded
   * ring buffers of the provider config and their detach functions are pushed
   * into the session disposers, so unloading the plugin removes them with the
   * context (requirement 7: no leaked listener, no leaked browser).
   */
  private observeSession(session: LiveSession): void {
    const limit = this.config.observeLimit
    const push = <T>(list: T[], item: T): void => {
      list.push(item)
      if (list.length > limit) list.splice(0, list.length - limit)
    }
    const context = session.context
    const onResponse = (response: Response): void => {
      try {
        const request = response.request()
        const contentType = response.headers()['content-type']
        const record: RequestRecord = { method: request.method(), url: request.url(), status: response.status() }
        const resourceType = request.resourceType()
        if (typeof resourceType === 'string') record.resourceType = resourceType
        if (typeof contentType === 'string') record.contentType = contentType.split(';')[0]?.trim() ?? contentType
        push(session.requests, record)
      } catch {
        // A closed context is not an observation failure.
      }
    }
    const onDownload = (download: Download): void => {
      const record: DownloadRecord = { url: download.url(), suggestedFilename: download.suggestedFilename(), state: 'started' }
      push(session.downloads, record)
      void download
        .path()
        .then((location) => {
          if (typeof location === 'string') record.path = location
          record.state = 'finished'
        })
        .catch(() => {
          record.state = 'failed'
        })
    }
    context.on('response', onResponse)
    context.on('download', onDownload)
    session.disposers.push(() => {
      context.off('response', onResponse)
      context.off('download', onDownload)
    })
  }

}

// ---------------------------------------------------------------------------
// Module helpers + the plugin entrypoint.
// ---------------------------------------------------------------------------

/** A bounded sleep (the `wait` action). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** The `screenshot` formats this provider writes. */
const SCREENSHOT_FORMATS = ['png', 'jpeg'] as const

/** The subset of playwright's screenshot options this provider sets. */
interface ShotOptions {
  path: string
  type: 'png' | 'jpeg'
  fullPage: boolean
  quality?: number
}

/** The `state` actions of the contract. */
const STATE_ACTIONS: readonly string[] = ['save', 'read', 'clear']

/** The credentials service as THIS provider uses it (structural: no import). */
interface CredentialsLike {
  resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined>
}

/** The cookie count and the localStorage ORIGINS of a state file (never a value). */
function parseState(raw: string): { cookies: number; origins: string[] } | undefined {
  try {
    const parsed = JSON.parse(raw) as { cookies?: unknown; origins?: unknown }
    const cookies = Array.isArray(parsed.cookies) ? parsed.cookies.length : 0
    const origins = Array.isArray(parsed.origins)
      ? parsed.origins
          .map((origin) => (isRecord(origin) && typeof origin.origin === 'string' ? origin.origin : undefined))
          .filter((origin): origin is string => origin !== undefined)
      : []
    return { cookies, origins }
  } catch {
    return undefined
  }
}

/** Builds the provider from a config row (the tests and `apply` use this). */
export function createPlaywrightProvider(
  config: BrowserUsePlaywrightConfig = {},
  credentials?: CredentialsLike,
): PlaywrightProvider {
  return new PlaywrightProvider(config, credentials)
}

/**
 * Registers the playwright provider with the `browser-use@1` service host.
 *
 * The dependency is declared with `ctx.inject`, so this plugin may be applied
 * BEFORE the host (cordis applies it as soon as the service appears) and is
 * INERT in a deployment without one (no host: nothing to register on).
 */
export function apply(ctx: PluginContext, config: BrowserUsePlaywrightConfig = {}): void {
  // The provider spawns a browser process: the execution policy must be declared.
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [BROWSER_USE] })
  const attach = (target: ServiceContext): void => {
    const service = browserUseOf(target)
    if (service === undefined) return
    const credentials = credentialsOf(target) as unknown as CredentialsLike | undefined
    const provider = createPlaywrightProvider(config, credentials)
    const unregister = service.register(provider)
    ctx.effect?.(() => () => {
      unregister()
      void provider.dispose()
    })
    // Report the REAL state of the deployment once, at load time: the provider
    // stays registered (so a caller gets the typed `no-browser` error and the
    // exact requirement) and never pretends a browser exists.
    const resolved = resolveProviderConfig(config)
    const binary = browserBinary(resolved)
    if (!binary.found || !playwrightCoreAvailable()) {
      ctx.logger?.warn?.(
        `browser-use-playwright: no browser is usable yet (${browserRequirement(resolved)}); every 'browser open' will fail with the typed browser-use.no-browser error until it is installed (config row: plugins.browser-use-playwright)`,
        'browser-use-playwright',
      )
    }
  }
  if (typeof ctx.inject === 'function') ctx.inject([BROWSER_USE], (injected) => attach(injected))
}

export default { name, inject: [], apply }

