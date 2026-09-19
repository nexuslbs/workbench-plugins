/**
 * config-watch - notice an EXTERNAL edit of the ACTIVE workbench config file and
 * apply it to the RUNNING process (reloadConfig + reconcile), with no restart
 * and no HTTP lifecycle action.
 *
 * WHY A PLUGIN: the core is the kernel/loader/registry only. It loads the config
 * file, discovers the sources, installs the plugins through cordis and resolves
 * `${cred:...}` fields; EVERYTHING else - the watcher included - is a plugin.
 * This matches the reference implementation (dsh), where the watcher is the HMR
 * plugin and not the kernel: `packages/boot/hmr/src/index.ts` imports
 * `reconcileProfilePatches` and calls it on a hand edit of the config.
 *
 * WHAT IT DOES NOT DO: it does NOT diff, load, unload or reload anything itself.
 * It NOTICES the edit and TRIGGERS the host operation that already exists:
 * `ctx.workbench.host().reconcile()` (the sibling core task). That call re-reads
 * the config file itself (`host.reloadConfig()` inside `reconcile()`), so the
 * watcher never needs - and never gets - a separate reload surface.
 *
 * Trigger semantics (see README.md for the full story):
 *   - WATCHES THE PARENT DIRECTORY of the active config file, not the file
 *     alone: the core writes the config atomically (`writeFileSync(tmp)` +
 *     `renameSync(tmp, file)`, src/configfile.ts), and an editor or `sed -i`
 *     does the same, so the inode under a file watch would be replaced and the
 *     watch would go deaf. A directory watch sees both an in-place write and a
 *     replace-over-target.
 *   - DEBOUNCES every event (default 300 ms) and re-arms after each apply.
 *   - TOLERATES the intermediate empty/partial file of an atomic write: the read
 *     is retried (ENOENT/EBUSY window) before it is reported as an error.
 *   - SUPPRESSES self-writes: the workbench itself writes this file (settings
 *     patch, enable/disable, install/uninstall). An event whose content hash
 *     equals the last observed content does ZERO host work, applies are
 *     re-entrancy guarded and rate limited, and `reconcile()` is idempotent and
 *     never writes the file - so a self-write costs at most ONE no-op apply and
 *     a reconcile storm is impossible BY CONSTRUCTION (`counters.noopApplies` /
 *     `counters.suppressedIdentical` make that observable).
 *   - STRUCTURED STATE at GET /api/config-watch/state: last event, last apply
 *     (the reconcile report counts), last success, last error, the settings, and
 *     an event ring buffer. POST /api/config-watch/apply forces a read+reconcile.
 *   - CLEAN LIFECYCLE: every handle (fs watcher, timers) is registered as a
 *     cordis effect and disposed on unload/shutdown, and the watcher is
 *     unref'd so it can never keep the process alive.
 *
 * A failing or unavailable watcher NEVER takes down the web server or the plugin
 * load: the setup is wrapped, every failure lands in the state as `lastError`.
 * An inline config (no file) leaves the watcher inactive with a reason.
 *
 * External plugin rule: the core package is never imported - the surfaces below
 * describe `ctx.workbench` / `ctx.web` structurally.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const name = 'config-watch'
export const API_BASE = '/api/config-watch'
export const CONTRACT = 'config-watch@1'

export const DEFAULT_DEBOUNCE_MS = 300
export const DEFAULT_MIN_INTERVAL_MS = 1000
export const DEFAULT_RETRY_DELAY_MS = 40
export const DEFAULT_READ_RETRIES = 4
export const DEFAULT_RECENT_LIMIT = 24

/** The atomic-write temp name of the core is `<file>.tmp-<pid>`: never ours. */
const TMP_SUFFIX = /\.tmp-\d+$/

// ------------------------------------------------------------------ seams

interface WebRequest {
  method: string
  path: string
  query: URLSearchParams
  readText(): Promise<string>
  readJson<T = unknown>(): Promise<T>
}

interface WebResponse {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

interface WebRouteSpec {
  method: string
  path: string
  handler: (request: WebRequest) => WebResponse | void | Promise<WebResponse | void>
  description?: string
}

interface WebService {
  route(spec: WebRouteSpec): () => void
  info?(): unknown
}

/** One row of the host's reconcile report (the desired-vs-live delta). */
interface ReconcileChange {
  name: string
  desired: boolean
  loaded: boolean
  action: string
  reason: string
  error?: string
}

/** The host's reconcile report - the watcher only SUMMARISES it. */
export interface ReconcileReport {
  ok: boolean
  action: string
  target: string
  message: string
  changes?: ReconcileChange[]
  deferred?: string[]
  errors?: string[]
  loaded?: number
  persisted?: boolean
}

interface HostApi {
  /** The config file the host boots from and edits (absolute), undefined for an inline config. */
  configFilePath(): string | undefined
  /** Applies the DESIRED `plugins:` roster of the config file to the LIVE tree. */
  reconcile(): Promise<ReconcileReport>
}

interface WorkbenchService {
  host(): HostApi
  log(message: string): void
}

interface PluginContext {
  workbench: WorkbenchService
  effect(setup: () => void | (() => void)): void
  /** Cordis deferred injection: the callback runs once `web` exists. */
  inject?(deps: string[], callback: (ctx: PluginContext) => void): void
  web?: WebService
}

// ------------------------------------------------------------------ config

export interface Config {
  /** Coalescing window for filesystem events, ms. */
  debounceMs?: number
  /** Minimum delay between two applies, ms (rate limit / churn guard). */
  minIntervalMs?: number
  /** Optional polling fallback in ms (0 = off) for filesystems without inotify. */
  pollMs?: number
  /** Delay between the read retries of an atomic write window, ms. */
  retryDelayMs?: number
  /** How many times a read is retried before it is reported as an error. */
  readRetries?: number
  /** Size of the event ring buffer exposed in the state. */
  recentLimit?: number
  /** Watch a DIFFERENT file (default: the config file the host actually loaded). */
  file?: string
}

interface Settings {
  debounceMs: number
  minIntervalMs: number
  pollMs: number
  retryDelayMs: number
  readRetries: number
  recentLimit: number
  file?: string
}

/** A positive integer config value, falling back to the default. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

export function resolveSettings(config: Config = {}): Settings {
  return {
    debounceMs: positiveInt(config.debounceMs, DEFAULT_DEBOUNCE_MS),
    minIntervalMs: positiveInt(config.minIntervalMs, DEFAULT_MIN_INTERVAL_MS),
    pollMs: positiveInt(config.pollMs, 0),
    retryDelayMs: positiveInt(config.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    readRetries: positiveInt(config.readRetries, DEFAULT_READ_RETRIES),
    recentLimit: Math.max(1, positiveInt(config.recentLimit, DEFAULT_RECENT_LIMIT)),
    ...(typeof config.file === 'string' && config.file.length > 0 ? { file: config.file } : {}),
  }
}

// ------------------------------------------------------------------ helpers

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// NOTE: this short retry/settle sleep is deliberately REF'D. It is bounded
// (readRetries * retryDelayMs) and only ever pending while an apply waits for
// the atomic-write window; unref'ing it would let the event loop drain while an
// apply (and a test awaiting it) is still pending. The long-lived handles - the
// FSWatcher and the optional poll interval - ARE unref'd, so the watcher can
// never keep the process alive on its own.
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

/** Summarises the host reconcile report; the counts the state exposes. */
export function summariseReport(report: ReconcileReport): Record<string, number> {
  const changes = report.changes ?? []
  const actions = (kind: string): number => changes.filter((change) => change.action === kind).length
  return {
    changes: changes.length,
    changed: changes.filter((change) => change.action !== 'unchanged').length,
    loadedRows: actions('load'),
    unloadedRows: actions('unload'),
    reloadedRows: actions('reload'),
    parkedRows: actions('park'),
    unchangedRows: actions('unchanged'),
    deferredRows: (report.deferred ?? []).length,
    errorRows: (report.errors ?? []).length,
  }
}

// ------------------------------------------------------------------ watcher

export interface EventRecord {
  at: string
  kind: 'fs' | 'poll' | 'apply' | 'suppressed' | 'error' | 'rate-limited' | 'coalesced' | 'disposed'
  detail: string
}

/**
 * The watcher itself. It is deliberately independent from cordis so a unit test
 * can drive it against a REAL config file (the fake context only has to provide
 * `workbench.host()` and a `web` seam).
 */
export class ConfigWatcher {
  private readonly ctx: PluginContext
  private readonly settings: Settings
  private watcher: fs.FSWatcher | undefined
  private debounceTimer: NodeJS.Timeout | undefined
  private rateTimer: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private disposed = false
  private applying = false
  private pending = false
  private file: string | undefined
  private watchDir: string | undefined
  private inactiveReason: string | undefined
  private lastObservedHash: string | undefined
  private lastAppliedHash: string | undefined
  private lastApplyAt = 0
  private recent: EventRecord[] = []
  private lastEvent: { path: string; type: string; at: string } | undefined
  private lastApply: Record<string, unknown> | undefined
  private lastSuccess: Record<string, unknown> | undefined
  private lastError: Record<string, unknown> | undefined
  private lastSuppressed: Record<string, unknown> | undefined
  private counters = {
    events: 0,
    coalesced: 0,
    ignored: 0,
    applies: 0,
    appliesWithChanges: 0,
    noopApplies: 0,
    suppressedIdentical: 0,
    rateLimited: 0,
    readRetries: 0,
    failures: 0,
  }

  constructor(ctx: PluginContext, settings: Settings) {
    this.ctx = ctx
    this.settings = settings
  }

  /**
   * Resolves the active config file, opens the watch and returns the disposer
   * (registered as a cordis effect by {@link apply}).
   */
  start(): () => void {
    try {
      const file = this.resolveFile()
      if (file === undefined) {
        this.inactiveReason = 'the host runs on an inline config: there is no config file to watch'
        this.record('disposed', `inactive: ${this.inactiveReason}`)
        return () => {}
      }
      this.file = file
      this.watchDir = path.dirname(file)
      this.openWatch()
      this.openPoll()
      this.log(`watching ${file} (dir ${this.watchDir})`)
    } catch (error) {
      // A watcher that cannot start must never take the plugin (or the server) down.
      this.inactiveReason = `the watch could not be armed: ${failureMessage(error)}`
      this.recordError('watch-failed', this.inactiveReason)
    }
    return () => this.dispose()
  }

  /** The config file the host ACTUALLY loaded (`--config` / `CONFIG_FILE` / default). */
  private resolveFile(): string | undefined {
    if (this.settings.file !== undefined) return path.resolve(this.settings.file)
    const file = this.ctx.workbench.host().configFilePath()
    if (file === undefined || file.length === 0) return undefined
    if (file.startsWith('(')) return undefined
    return path.resolve(file)
  }

  private openWatch(): void {
    const dir = this.watchDir
    const base = this.file === undefined ? undefined : path.basename(this.file)
    if (dir === undefined || base === undefined) return
    const watcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      // `filename` is null on some platforms; a null name still means "something
      // happened in the directory", so it is accepted and re-checked by hash.
      const changed = filename === null || filename === undefined ? base : String(filename)
      if (changed !== base) {
        // The atomic-write temp file (and every unrelated sibling) is not the
        // config: ignored, never even counted as an event.
        if (TMP_SUFFIX.test(changed)) return
        this.counters.ignored += 1
        return
      }
      this.onEvent(eventType, path.join(dir, changed))
    })
    watcher.on('error', (error) => {
      this.recordError('watch-failed', `watcher error on ${dir}: ${failureMessage(error)}`)
    })
    // The watcher must never keep the process alive on its own.
    watcher.unref?.()
    this.watcher = watcher
  }

  /** Optional polling fallback (off by default): a filesystem without inotify. */
  private openPoll(): void {
    const file = this.file
    if (file === undefined || this.settings.pollMs <= 0) return
    const timer = setInterval(() => {
      if (this.disposed || this.applying) return
      let stat: fs.Stats
      try {
        stat = fs.statSync(file)
      } catch {
        return
      }
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (stamp === this.pollStamp) return
      this.pollStamp = stamp
      this.onEvent('poll', file)
    }, this.settings.pollMs)
    timer.unref?.()
    this.pollTimer = timer
  }

  private pollStamp: string | undefined

  /** One filesystem event: debounced, coalesced, then applied. */
  onEvent(eventType: string, eventPath: string): void {
    if (this.disposed) return
    this.counters.events += 1
    this.lastEvent = { path: eventPath, type: eventType, at: nowIso() }
    this.record('fs', `${eventType} ${eventPath}`)
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.counters.coalesced += 1
    }
    const timer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.consider(`fs ${eventType}`)
    }, this.settings.debounceMs)
    // REF'D on purpose: a coalesced burst must still be applied (and a test
    // awaiting it must not see the loop drain). It is bounded by debounceMs.
    this.debounceTimer = timer
  }

  /**
   * The single entry point of an apply: enforces the re-entrancy guard and the
   * rate limit, then reads the file and triggers the host reconcile.
   */
  async consider(reason: string, force = false): Promise<void> {
    if (this.disposed) return
    if (this.applying) {
      this.pending = true
      this.counters.coalesced += 1
      this.record('coalesced', `event during an apply (${reason})`)
      return
    }
    const wait = this.settings.minIntervalMs - (Date.now() - this.lastApplyAt)
    if (!force && this.lastApplyAt > 0 && wait > 0) {
      this.counters.rateLimited += 1
      this.record('rate-limited', `deferring by ${wait} ms (${reason})`)
      if (this.rateTimer === undefined) {
        const timer = setTimeout(() => {
          this.rateTimer = undefined
          void this.consider(reason)
        }, wait)
        // REF'D on purpose, bounded by minIntervalMs (an apply is pending).
        this.rateTimer = timer
      }
      return
    }
    await this.apply(reason, force)
  }

  private async apply(reason: string, force: boolean): Promise<void> {
    this.applying = true
    this.counters.applies += 1
    this.lastApplyAt = Date.now()
    const startedAt = Date.now()
    try {
      const read = await this.readTolerant()
      if (read === undefined) return
      // SUPPRESSION 1 - identical content: a self-write that rewrote the same
      // bytes, a `touch`, or the rename half of an atomic write produce ZERO
      // host work (exactly the rule the reference settings-file watcher uses).
      if (!force && read.hash === this.lastObservedHash) {
        this.counters.suppressedIdentical += 1
        this.lastSuppressed = { at: nowIso(), hash: read.hash, reason, file: this.file ?? null }
        this.record('suppressed', `identical content (${reason})`)
        return
      }
      this.lastObservedHash = read.hash
      const host = this.ctx.workbench.host()
      let report: ReconcileReport
      try {
        // ONE host call: reconcile() re-reads the file itself (reloadConfig) and
        // applies only the delta. It never writes the file, so this can never
        // feed itself - the no-loop property holds by construction.
        report = await host.reconcile()
      } catch (error) {
        this.counters.failures += 1
        this.lastError = { at: nowIso(), kind: 'reconcile-failed', message: failureMessage(error), file: this.file ?? null, hash: read.hash }
        this.recordError('reconcile-failed', failureMessage(error))
        return
      }
      const summary = summariseReport(report)
      this.lastApply = {
        at: nowIso(),
        reason,
        ok: report.ok,
        hash: read.hash,
        durationMs: Date.now() - startedAt,
        message: report.message,
        ...summary,
      }
      if (report.ok) {
        if (summary.changed === 0) this.counters.noopApplies += 1
        else this.counters.appliesWithChanges += 1
        this.lastAppliedHash = read.hash
        this.lastSuccess = { at: this.lastApply.at, hash: read.hash, reason, ...summary }
        // Recovery: the running configuration converged again.
        this.lastError = undefined
      } else {
        // INVALID EDIT (parse error / failing row): the host kept the currently
        // running configuration (reconcile catches and reports, nothing is
        // partially applied), we keep it too and recover on the next valid write.
        this.counters.failures += 1
        this.lastError = {
          at: nowIso(),
          kind: summary.errorRows > 0 ? 'reconcile-error' : 'invalid-config',
          message: report.message,
          file: this.file ?? null,
          hash: read.hash,
        }
      }
      this.record('apply', `ok=${report.ok} changed=${summary.changed} unchanged=${summary.unchangedRows} deferred=${summary.deferredRows} errors=${summary.errorRows} (${reason})`)
    } finally {
      this.applying = false
      if (this.pending && !this.disposed) {
        // Re-entrancy guard: everything that arrived DURING the apply is
        // coalesced into exactly ONE follow-up read (which the hash check may
        // then drop entirely).
        this.pending = false
        this.record('coalesced', 're-reading after the apply')
        void this.consider('coalesced')
      }
    }
  }

  /** Reads the config, tolerating the window of an atomic write. */
  private async readTolerant(): Promise<{ content: string; hash: string } | undefined> {
    const file = this.file
    if (file === undefined) return undefined
    for (let attempt = 0; ; attempt += 1) {
      try {
        const content = fs.readFileSync(file, 'utf8')
        return { content, hash: sha256(content) }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (attempt >= this.settings.readRetries) {
          this.counters.failures += 1
          this.lastError = {
            at: nowIso(),
            kind: code === 'ENOENT' ? 'file-missing' : 'read-failed',
            message: failureMessage(error),
            file,
          }
          this.recordError(code === 'ENOENT' ? 'file-missing' : 'read-failed', `${failureMessage(error)} (${file})`)
          return undefined
        }
        this.counters.readRetries += 1
        await delay(this.settings.retryDelayMs)
      }
    }
  }

  /** Manual trigger (`POST /api/config-watch/apply`): a forced read + reconcile. */
  async trigger(force = true): Promise<Record<string, unknown>> {
    await this.consider('manual', force)
    return this.state()
  }

  state(): Record<string, unknown> {
    return {
      contract: CONTRACT,
      plugin: name,
      active: this.watcher !== undefined,
      watching: this.watcher !== undefined,
      file: this.file ?? null,
      watchDir: this.watchDir ?? null,
      reason: this.inactiveReason ?? null,
      settings: { ...this.settings },
      applying: this.applying,
      pending: this.pending,
      disposed: this.disposed,
      lastEvent: this.lastEvent ?? null,
      lastApply: this.lastApply ?? null,
      lastSuccess: this.lastSuccess ?? null,
      lastError: this.lastError ?? null,
      lastSuppressed: this.lastSuppressed ?? null,
      counters: { ...this.counters },
      recent: [...this.recent],
    }
  }

  /** Closes every handle; idempotent and refuses new events afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimers()
    try {
      this.watcher?.close()
    } catch {
      // closing an already-closed watcher is not an error for us
    }
    this.watcher = undefined
    this.record('disposed', 'watch handles released')
    this.log('watch handles released')
  }

  private clearTimers(): void {
    for (const timer of [this.debounceTimer, this.rateTimer, this.pollTimer]) {
      if (timer !== undefined) clearTimeout(timer)
    }
    this.debounceTimer = undefined
    this.rateTimer = undefined
    this.pollTimer = undefined
  }

  private record(kind: EventRecord['kind'], detail: string): void {
    this.recent.push({ at: nowIso(), kind, detail })
    if (this.recent.length > this.settings.recentLimit) this.recent.splice(0, this.recent.length - this.settings.recentLimit)
  }

  private recordError(kind: string, message: string): void {
    this.lastError = { at: nowIso(), kind, message, file: this.file ?? null }
    this.record('error', `${kind}: ${message}`)
    this.log(`${kind}: ${message}`)
  }

  private log(message: string): void {
    try {
      this.ctx.workbench.log(`${name}: ${message}`)
    } catch {
      // logging must never be the reason a watcher dies
    }
  }
}

// ------------------------------------------------------------------ plugin

function registerWebSeams(ctx: PluginContext, watcher: ConfigWatcher): void {
  const registerOn = (web: WebService): void => {
    ctx.effect(() =>
      web.route({
        method: 'GET',
        path: `${API_BASE}/state`,
        description: 'the config watcher state (file, last event, last apply, last error, counters)',
        handler: () => json(watcher.state()),
      }),
    )
    ctx.effect(() =>
      web.route({
        method: 'POST',
        path: `${API_BASE}/apply`,
        description: 'force a read + reconcile of the active config file now',
        handler: async (request) => {
          let force = true
          try {
            const body = await request.readJson<{ force?: boolean }>()
            if (body !== null && typeof body === 'object' && typeof body.force === 'boolean') force = body.force
          } catch {
            // an empty body is the normal case: apply with the default
          }
          const state = await watcher.trigger(force)
          const lastApply = state.lastApply as { ok?: boolean } | null | undefined
          return json({ ...state, triggered: true }, lastApply?.ok === false ? 409 : 200)
        },
      }),
    )
  }
  // Deferred dependency declaration: a web@1 provider plugin may load LATER, and
  // cordis refuses a bare `ctx.web` access that is not declared in `inject`.
  // The WATCH itself never waits for the web seam: it is armed in `apply`.
  if (ctx.inject) {
    ctx.inject(['web'], (injected) => {
      if (!injected.web) return
      registerOn(injected.web)
    })
  } else if (ctx.web) {
    // A bare context (unit test): the seam is handed in directly.
    registerOn(ctx.web)
  }
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const settings = resolveSettings(config)
  const watcher = new ConfigWatcher(ctx, settings)
  ctx.effect(() => watcher.start())
  registerWebSeams(ctx, watcher)
  ctx.workbench.log(
    `${name}: watching the active config file and reconciling on external edits (debounce ${settings.debounceMs} ms, rate limit ${settings.minIntervalMs} ms, state ${API_BASE}/state)`,
  )
}

export default { name, inject: ['workbench'], apply }
