// JS-aware rendering: a POOLED chromium (playwright-core) that is launched
// lazily on the first call and reused, and disposed when the plugin unloads.
//
// Dependency choice: `playwright-core` and NOT `playwright`. The full package
// bundles a browser downloader and a toolchain we do not need: this plugin only
// drives a browser, and the browser itself is provided BY THE DEPLOYMENT (a
// workbench image with chromium, or the standard playwright browser cache). That
// keeps the plugin source small, keeps `npm ci` out of the plugin source
// directory, and makes the browser an explicit deployment input instead of a
// hidden side effect of installing the package. `executablePath` (config) or
// `PLAYWRIGHT_BROWSERS_PATH` (environment) point at the browser; when neither is
// set, playwright's own default cache is used.
//
// `playwright-core` is imported DYNAMICALLY, inside the rendering path: a plugin
// whose browser dependency is missing must still LOAD (and answer schema-valid
// errors) instead of taking the whole workbench process down with an import
// failure. The type-only import below is erased at run time.
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { ResolvedConfig } from './config.ts'
import { PageError, browserFailure, messageOf, redactText } from './errors.ts'

// The settle probe below runs INSIDE the page, where `document` exists - but this
// project's tsconfig carries no DOM lib (the plugin never touches a DOM in the
// host process). The field it reads is declared structurally here.
declare const document: { body: { innerText: string } | null }

export interface RenderRequest {
  url: string
  /** Scope the render to a region (only affects extraction, not navigation). */
  selectors?: string[]
  /** Per-call navigation budget, when a caller asks for less than the config. */
  timeoutMs?: number
}

export interface RenderResult {
  html: string
  finalUrl: string
  status: number
  title: string
  etag: string | undefined
  lastModified: string | undefined
  attempts: number
  elapsedMs: number
}

export interface RenderStats {
  launches: number
  renders: number
  contextReuses: number
  contextsOpen: number
}

export interface Renderer {
  render(request: RenderRequest): Promise<RenderResult>
  dispose(): Promise<void>
  stats(): RenderStats
}

/** Resolves a credential NAME to its value (the value is never logged). */
export type CredentialResolver = (name: string) => Promise<string | undefined>

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * One lazily launched browser, up to `maxContexts` reusable contexts, one fresh
 * page per render. A context that failed is thrown away (never reused after an
 * error); a healthy one is pooled.
 */
export class BrowserPoolRenderer implements Renderer {
  private readonly config: ResolvedConfig
  private readonly resolveCredential: CredentialResolver
  private modulePromise: Promise<typeof import('playwright-core')> | undefined
  private browser: Browser | undefined
  private launchPromise: Promise<Browser> | undefined
  private readonly idle: BrowserContext[] = []
  private readonly waiters: (() => void)[] = []
  private live = 0
  private closed = false
  private launchCount = 0
  private renderCount = 0
  private reuseCount = 0
  /** Resolved credential VALUES: scrubbed from every diagnostic, never logged. */
  private readonly secrets: string[] = []

  constructor(config: ResolvedConfig, resolveCredential: CredentialResolver) {
    this.config = config
    this.resolveCredential = resolveCredential
  }

  stats(): RenderStats {
    return { launches: this.launchCount, renders: this.renderCount, contextReuses: this.reuseCount, contextsOpen: this.live }
  }

  /** The strings scrubbed from diagnostics: the config patterns plus any secret. */
  private redaction(): string[] {
    return [...this.config.redact, ...this.secrets]
  }

  /** Redact a diagnostic text (browser/launch error text) before it is surfaced. */
  private scrub(text: string): string {
    return redactText(text, this.redaction())
  }

  /** The page read of this plugin: render, wait, return the settled DOM. */
  async render(request: RenderRequest): Promise<RenderResult> {
    if (this.closed) throw new PageError('internal', 'the renderer was disposed (the plugin was unloaded)')
    const started = Date.now()
    const timeoutMs = request.timeoutMs ?? this.config.navigationTimeoutMs
    this.renderCount += 1
    let attempts = 0
    let lastError: unknown
    while (attempts <= this.config.retries) {
      attempts += 1
      const context = await this.acquire()
      let healthy = false
      let page: Page | undefined
      try {
        page = await context.newPage()
        const response = await page.goto(request.url, { waitUntil: this.config.waitUntil, timeout: timeoutMs })
        const status = response === null ? 0 : response.status()
        if (status >= 400) {
          throw new PageError('http_status', `the page answered HTTP ${String(status)}`, {
            url: request.url,
            retryable: status >= 500,
            hint: status === 404 ? 'check the path (or use page map on the site root)' : undefined,
          })
        }
        await this.settle(page)
        const html = await page.content()
        const finalUrl = page.url()
        const title = await page.title().catch(() => '')
        const headers = response === null ? {} : response.headers()
        healthy = true
        return {
          html,
          finalUrl,
          status,
          title,
          etag: headers['etag'],
          lastModified: headers['last-modified'],
          attempts,
          elapsedMs: Date.now() - started,
        }
      } catch (error) {
        lastError = error
        if (error instanceof PageError && !error.retryable) throw error
        if (attempts > this.config.retries) break
        await delay(200 * attempts)
      } finally {
        if (page !== undefined) await page.close().catch(() => undefined)
        if (healthy) this.release(context)
        else await this.destroy(context)
      }
    }
    throw lastError instanceof PageError ? lastError : browserFailure(lastError, request.url, timeoutMs, this.redaction())
  }

  /** Close every pooled context and the browser (registered on the cordis effect). */
  async dispose(): Promise<void> {
    this.closed = true
    for (const context of this.idle.splice(0)) await context.close().catch(() => undefined)
    const browser = this.browser
    this.browser = undefined
    this.launchPromise = undefined
    if (browser !== undefined) await browser.close().catch(() => undefined)
    this.live = 0
  }

  // -- browser / context pool ------------------------------------------------

  private async loadModule(): Promise<typeof import('playwright-core')> {
    if (this.modulePromise === undefined) {
      this.modulePromise = import('playwright-core').catch((error: unknown) => {
        this.modulePromise = undefined
        throw new PageError('browser_unavailable', 'the playwright-core module could not be loaded', {
          detail: this.scrub(messageOf(error)),
          hint: 'install the plugin dependencies (npm install) or run the plugin in an image that carries playwright-core',
        })
      })
    }
    return this.modulePromise
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser !== undefined && this.browser.isConnected()) return this.browser
    if (this.launchPromise === undefined) {
      this.launchPromise = this.launch().catch((error: unknown) => {
        this.launchPromise = undefined
        throw error
      })
    }
    const browser = await this.launchPromise
    this.browser = browser
    return browser
  }

  private async launch(): Promise<Browser> {
    const playwright = await this.loadModule()
    const proxy = await this.proxyOptions()
    const options: Parameters<typeof playwright.chromium.launch>[0] = {
      headless: true,
      args: this.config.browserArgs,
      timeout: this.config.navigationTimeoutMs,
    }
    if (this.config.executablePath !== undefined) options.executablePath = this.config.executablePath
    if (proxy !== undefined) options.proxy = proxy
    try {
      const browser = await playwright.chromium.launch(options)
      this.launchCount += 1
      return browser
    } catch (error) {
      const text = this.scrub(messageOf(error))
      throw new PageError('browser_unavailable', 'chromium could not be launched', {
        detail: text,
        hint: 'provide a chromium through executablePath or PLAYWRIGHT_BROWSERS_PATH (npx playwright-core install chromium)',
      })
    }
  }

  /** The proxy of the browser, with the credential resolved by NAME at launch. */
  private async proxyOptions(): Promise<{ server: string; username?: string; password?: string } | undefined> {
    const proxy = this.config.proxy
    if (proxy === undefined) return undefined
    const out: { server: string; username?: string; password?: string } = { server: proxy.server }
    if (proxy.username !== undefined) out.username = proxy.username
    if (proxy.credential !== undefined) {
      const value = await this.resolveCredential(proxy.credential)
      if (value === undefined) {
        throw new PageError('invalid_input', `the proxy credential '${proxy.credential}' is not configured`, {
          hint: 'add the credential to the configured credentials provider (the config carries a NAME only)',
        })
      }
      out.password = value
      if (!this.secrets.includes(value)) this.secrets.push(value)
    }
    return out
  }

  private async newContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext({ userAgent: this.config.userAgent })
    context.setDefaultTimeout(this.config.actionTimeoutMs)
    context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs)
    const blocked = this.config.blockResourceTypes
    if (blocked.length > 0) {
      await context.route('**/*', (route) => {
        const type = route.request().resourceType()
        if (blocked.includes(type)) return route.abort()
        return route.continue()
      })
    }
    return context
  }

  private async acquire(): Promise<BrowserContext> {
    while (true) {
      const pooled = this.idle.pop()
      if (pooled !== undefined) {
        this.reuseCount += 1
        return pooled
      }
      if (this.live < this.config.maxContexts) {
        const browser = await this.ensureBrowser()
        this.live += 1
        try {
          return await this.newContext(browser)
        } catch (error) {
          this.live -= 1
          throw new PageError('browser_unavailable', 'a browser context could not be created', { detail: this.scrub(messageOf(error)) })
        }
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
      })
    }
  }

  private release(context: BrowserContext): void {
    if (this.closed) {
      void context.close().catch(() => undefined)
      return
    }
    this.idle.push(context)
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter()
  }

  private async destroy(context: BrowserContext): Promise<void> {
    this.live = Math.max(0, this.live - 1)
    await context.close().catch(() => undefined)
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter()
  }

  /**
   * Bounded settle after `goto`: a best-effort network-idle (the action timeout
   * caps it) plus a content-quiet loop, which is what a client-rendered page
   * needs before its DOM stops changing. Both are bounded, so a hung page can
   * never stall a caller.
   */
  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('networkidle', { timeout: this.config.actionTimeoutMs }).catch(() => undefined)
    const deadline = Date.now() + this.config.actionTimeoutMs
    let lastLength = -1
    let stable = 0
    while (Date.now() < deadline && stable < 2) {
      const length = await page
        .evaluate(() => (document.body === null ? 0 : document.body.innerText.trim().length))
        .catch(() => 0)
      if (length === lastLength && length > 0) stable += 1
      else stable = 0
      lastLength = length
      await page.waitForTimeout(120).catch(() => undefined)
    }
  }
}
