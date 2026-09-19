// lib/events.ts - the runtime of the plugin EVENT surface (see
// `definitions/events.ts` for the contract and `docs/EVENTS.md` for the human
// documentation).
//
// What this module does, in one line: it binds a plugin's event scope to the
// HOST's cordis event bus (every dispatch is delegated to the host, nothing of
// the dsh/cordis dispatch semantics is re-implemented) and adds the four things
// a plugin cannot get from the host directly:
//
//   1. ERROR ISOLATION - a listener registered through this layer is wrapped, so
//      a THROWING listener (or a listener returning a rejected promise) is
//      logged and cannot kill the emitter, the other listeners, or the process.
//      A middleware of a `waterfall` that throws does not break the chain
//      either: the chain continues with the value it had.
//   2. `off` + bookkeeping - the host offers `on`/`once` (and the disposer they
//      return) but no `off`; the scope knows every listener it registered, so
//      `off`, `listenerCount`, `listeners` and the process-wide registry work.
//   3. `effect()` - an ordering/exactly-once/isolated disposer scope bound to
//      the plugin's fiber (ONE host effect disposes the whole scope), which is
//      what makes "release the sockets/pools/timers/subprocesses/browser
//      contexts of this plugin when it unloads" a guarantee instead of a hope.
//   4. the process SHUTDOWN coordinator - SIGTERM/SIGINT dispose every live
//      scope, bounded and logged (opt-in `exit` for hosts that do not exit by
//      themselves).
//
// AUTO-UNSUBSCRIBE: the guarantee is the HOST's. cordis' `ctx.on` registers the
// hook inside an effect of the CALLING plugin's fiber, so unloading that plugin
// runs the disposer even if the plugin never calls ours. This layer does not
// depend on that alone: every wrapper also carries an `active` flag, so a host
// that forgot to remove the hook still never calls a listener of an unloaded
// plugin.
import {
  EVENTS_CONTRACT,
  EventsError,
  LIFECYCLE,
  RESERVED_NAMESPACES,
  qualify,
  type EventOptions,
  type EventRegistryLike,
  type EventRegistrySnapshot,
  type EventScope,
  type EventsHostContext,
  type Listener,
  type EffectCallback,
  type EffectOptions,
  type Disposer,
  type DisposeReport,
  type Unsubscribe,
} from '../definitions/events.ts'

/** Where the layer writes what it caught. Never a credential value, never a payload. */
export type EventLogger = (level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) => void

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

// ---------------------------------------------------------------------------
// The process-wide registry: who DECLARED which public name (collision
// detection) and how many listeners are live per name (audit evidence, and the
// number a test asserts after an unload).
// ---------------------------------------------------------------------------

class EventRegistry implements EventRegistryLike {
  private readonly declaredNames = new Map<string, string>()
  private readonly counts = new Map<string, number>()
  private readonly owners = new Map<string, Set<string>>()

  declare(owner: string, names: readonly string[]): void {
    for (const name of names) {
      const existing = this.declaredNames.get(name)
      if (existing !== undefined && existing !== owner) {
        throw new EventsError(
          'collision',
          `the event '${name}' is already declared by plugin '${existing}'; ` +
            `plugin '${owner}' must use its own namespace so two plugins cannot share one event by accident`,
          { event: name, owner, declaredBy: existing },
        )
      }
      this.declaredNames.set(name, owner)
    }
  }

  track(owner: string, name: string): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1)
    const owners = this.owners.get(name) ?? new Set<string>()
    owners.add(owner)
    this.owners.set(name, owners)
  }

  untrack(owner: string, name: string): void {
    const next = (this.counts.get(name) ?? 0) - 1
    if (next <= 0) this.counts.delete(name)
    else this.counts.set(name, next)
    const owners = this.owners.get(name)
    if (owners === undefined) return
    owners.delete(owner)
    if (owners.size === 0) this.owners.delete(name)
  }

  snapshot(): EventRegistrySnapshot {
    return {
      declared: Object.fromEntries(this.declaredNames),
      listeners: Object.fromEntries(this.counts),
      owners: Object.fromEntries([...this.owners].map(([name, set]) => [name, [...set].sort()])),
    }
  }
}

const REGISTRY = new EventRegistry()

// Active `waterfall` dispatches, keyed by EVENT NAME. Module-level on purpose:
// the listeners of one waterfall normally belong to OTHER plugins, each with its
// own scope, so a per-scope state could never thread a value across plugins.
const WATERFALLS = new Map<string, { value: unknown }[]>()

function waterfallStateFor(name: string): { value: unknown } | undefined {
  const stack = WATERFALLS.get(name)
  return stack === undefined || stack.length === 0 ? undefined : stack[stack.length - 1]
}

/** The process-wide event registry (collision check + live listener counts). */
export function eventsRegistry(): EventRegistryLike {
  return REGISTRY
}

/**
 * How many listeners the HOST itself holds for `name`. cordis keeps them in
 * `ctx.events._hooks[name]`; the field is read STRUCTURALLY (no core change, no
 * `cordis` import) and `undefined` is returned when the host does not expose it.
 * It is the independent check of "the handler is really gone from the bus and
 * not only from this layer's bookkeeping".
 */
export function hostListenerCount(ctx: EventsHostContext, name: string): number | undefined {
  const hooks = ctx.events?._hooks
  if (hooks === undefined || hooks === null || typeof hooks !== 'object') return undefined
  const list = (hooks as Record<string, unknown>)[name]
  return Array.isArray(list) ? list.length : 0
}

// ---------------------------------------------------------------------------
// The shutdown coordinator.
// ---------------------------------------------------------------------------

export interface ShutdownOptions {
  /** Signals that trigger the shutdown dispose (default SIGTERM + SIGINT). */
  signals?: NodeJS.Signals[]
  /**
   * Exit the process with code 0 once every scope is disposed. DEFAULT false:
   * the host (the workbench core) already disposes the kernel on a signal and
   * exits by itself, and a plugin must not take that decision away from it.
   */
  exit?: boolean
  /** Bound for the whole shutdown dispose in ms (default 5000). */
  timeoutMs?: number
  logger?: EventLogger
}

let shutdownInstalled = false
let shutdownOptions: Required<Pick<ShutdownOptions, 'signals' | 'exit' | 'timeoutMs'>> = {
  signals: ['SIGTERM', 'SIGINT'],
  exit: false,
  timeoutMs: 5000,
}
let shutdownLogger: EventLogger | undefined
let shuttingDown = false
const SHUTDOWN_HANDLERS = new Map<NodeJS.Signals, () => void>()

/**
 * Disposes EVERY live plugin scope: the shutdown coordinator's core, and also
 * the host's own way out when the host manages shutdown itself (the workbench
 * core disposes the kernel and its fibers and never needs the signal hooks).
 * Effects run LIFO and exactly once, a throwing or timing-out disposer is logged
 * and the others still run, and the whole dispose is bounded by `timeoutMs`.
 * Returns the number of scopes disposed; an already disposed scope is a no-op.
 */
export async function disposeAllScopes(timeoutMs: number = shutdownOptions.timeoutMs): Promise<number> {
  const scopes = [...SCOPES]
  if (scopes.length === 0) return 0
  let timer: ReturnType<typeof setTimeout> | undefined
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      shutdownLogger?.('warn', `shutdown dispose exceeded ${timeoutMs}ms; remaining disposers are abandoned`)
    }, timeoutMs)
    timer.unref?.()
  }
  try {
    await Promise.allSettled(scopes.map(async (scope) => scope.dispose()))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  return scopes.length
}

function signalHandler(signal: NodeJS.Signals): void {
  void (async () => {
    if (shuttingDown) {
      shutdownLogger?.('info', `${signal} received again while shutting down: the dispose is already running`)
      return
    }
    shuttingDown = true
    shutdownLogger?.('info', `${signal} received: disposing ${SCOPES.size} plugin event scope(s)`)
    const count = await disposeAllScopes()
    shutdownLogger?.('info', `shutdown dispose finished (${count} scope(s), exit=${shutdownOptions.exit})`)
    if (shutdownOptions.exit) process.exit(0)
  })()
}

/**
 * Installs the process shutdown coordinator: SIGTERM/SIGINT dispose every live
 * scope (LIFO effects, exactly once, a throwing disposer logged and the others
 * still run). Idempotent: the second call only updates the options.
 */
export function installShutdownHooks(options: ShutdownOptions = {}): Unsubscribe {
  shutdownOptions = {
    signals: options.signals ?? shutdownOptions.signals,
    exit: options.exit ?? shutdownOptions.exit,
    timeoutMs: options.timeoutMs ?? shutdownOptions.timeoutMs,
  }
  shutdownLogger = options.logger ?? shutdownLogger
  // Signals are (re)conciled, not only installed once: a later call that ADDS a
  // signal (tests and hosts do that) must really install its handler even when
  // the coordinator is already running.
  const wanted = new Set(shutdownOptions.signals)
  for (const [signal, handler] of [...SHUTDOWN_HANDLERS]) {
    if (wanted.has(signal)) continue
    process.off(signal, handler)
    SHUTDOWN_HANDLERS.delete(signal)
  }
  for (const signal of wanted) {
    if (SHUTDOWN_HANDLERS.has(signal)) continue
    const handler = () => signalHandler(signal)
    SHUTDOWN_HANDLERS.set(signal, handler)
    process.on(signal, handler)
  }
  shutdownInstalled = true
  return () => uninstallShutdownHooks()
}

/** Removes the shutdown handlers (tests and hosts that dispose their own way). */
export function uninstallShutdownHooks(): void {
  if (!shutdownInstalled) return
  for (const [signal, handler] of SHUTDOWN_HANDLERS) process.off(signal, handler)
  SHUTDOWN_HANDLERS.clear()
  shutdownInstalled = false
  shuttingDown = false
}

// ---------------------------------------------------------------------------
// The scope.
// ---------------------------------------------------------------------------

interface Registration {
  /** The full, resolved event name. */
  name: string
  original: Listener
  wrapped: Listener
  active: boolean
  /** The disposer the HOST returned (cordis: a fiber-effect disposer). */
  hostDispose?: () => unknown
}

interface EffectEntry {
  label: string
  timeoutMs: number
  /** Resolves once the disposers the callback produced are known. */
  collected: Promise<Disposer[]>
  ran: boolean
}

export interface CreateEventsOptions {
  /** The plugin's namespace, normally its plugin name (`demo`, `events-demo`). */
  namespace: string
  /** Where caught listener/disposer errors are written (default: host logger, else console). */
  logger?: EventLogger
  /** Bound applied to a disposer that does not declare its own (default 5000 ms). */
  disposeTimeoutMs?: number
  /** The scope may only EMIT inside its own namespace (default false). */
  strictNamespaces?: boolean
  /** Also register the scope with the process shutdown coordinator (default true). */
  shutdown?: boolean
}

const SCOPES = new Set<PluginEvents>()

export class PluginEvents implements EventScope {
  readonly contract = EVENTS_CONTRACT
  readonly namespace: string
  private readonly ctx: EventsHostContext
  private readonly log: EventLogger
  private readonly disposeTimeoutMs: number
  private readonly strictNamespaces: boolean
  private readonly registrations: Registration[] = []
  private readonly effects: EffectEntry[] = []
  private isDisposed = false

  constructor(ctx: EventsHostContext, options: CreateEventsOptions) {
    if (typeof options?.namespace !== 'string' || options.namespace.length === 0) {
      throw new EventsError('invalid-name', 'createEvents() needs a plugin namespace (normally the plugin name)', {
        namespace: options?.namespace,
      })
    }
    this.ctx = ctx
    this.namespace = options.namespace
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? 5000
    this.strictNamespaces = options.strictNamespaces ?? false
    this.log = options.logger ?? defaultLogger(ctx, this.namespace)
    if (typeof ctx?.on !== 'function' || typeof ctx?.emit !== 'function') {
      throw new EventsError(
        'host-unsupported',
        `the host context does not expose the event surface (ctx.on/ctx.emit); plugin '${this.namespace}' cannot use the events API`,
        { plugin: this.namespace },
      )
    }
    SCOPES.add(this)
    if (options.shutdown !== false) installShutdownHooks({ logger: this.log })
    // ONE host effect for the whole scope: unloading this plugin (or the process
    // shutting the kernel down) runs every disposer and removes every listener.
    // The effect disposer returns the scope's dispose() promise, so cordis
    // AWAITS it - that is what keeps unload deterministic.
    const hostEffect = ctx.effect
    if (typeof hostEffect === 'function') {
      try {
        hostEffect(() => () => this.dispose())
      } catch (error) {
        this.log('warn', `the host refused the scope effect (${errorText(error)}); call scope.dispose() yourself`, {
          plugin: this.namespace,
        })
      }
    } else {
      this.log('warn', 'the host exposes no effect scope: the scope must be disposed explicitly by the plugin', {
        plugin: this.namespace,
      })
    }
    this.broadcast(LIFECYCLE.pluginLoaded, { plugin: this.namespace, namespace: this.namespace })
  }

  get disposed(): boolean {
    return this.isDisposed
  }

  // -- names -----------------------------------------------------------------

  /** Resolves a short name against the namespace (a full name is kept verbatim). */
  private resolve(name: string): string {
    if (typeof name !== 'string' || name.length === 0) {
      throw new EventsError('invalid-name', 'an event name must be a non-empty string', { plugin: this.namespace, name })
    }
    const full = name.includes('/') ? name : `${this.namespace}/${name}`
    if (full.includes('//') || /\s/.test(full)) {
      throw new EventsError('invalid-name', `'${name}' is not a '<namespace>/<event>' name`, {
        plugin: this.namespace,
        name,
        full,
      })
    }
    return full
  }

  declare(names: readonly string[]): void {
    REGISTRY.declare(
      this.namespace,
      names.map((name) => qualify(this.namespace, name)),
    )
  }

  // -- subscriptions ---------------------------------------------------------

  on(name: string, listener: Listener, options: EventOptions = {}): Unsubscribe {
    return this.register(name, listener, options, false)
  }

  once(name: string, listener: Listener, options: EventOptions = {}): Unsubscribe {
    return this.register(name, listener, options, true)
  }

  private register(name: string, listener: Listener, options: EventOptions, once: boolean): Unsubscribe {
    if (typeof listener !== 'function') {
      throw new EventsError('invalid-name', `the listener of '${name}' must be a function`, { plugin: this.namespace, name })
    }
    this.assertUsable('on')
    const full = this.resolve(name)
    if (options.declare === true) this.declare([full])
    const registration: Registration = {
      name: full,
      original: listener,
      wrapped: () => undefined,
      active: true,
    }
    const hostOptions: EventOptions = options.prepend === true ? { prepend: true } : {}
    registration.wrapped = this.wrap(registration, once)
    const hostDispose = this.ctx.on?.(full, registration.wrapped, hostOptions)
    if (typeof hostDispose === 'function') registration.hostDispose = hostDispose as () => unknown
    this.registrations.push(registration)
    REGISTRY.track(this.namespace, full)
    return () => {
      void this.remove(registration)
    }
  }

  /**
   * The isolation core: every listener the plugin registers is called through
   * this wrapper, which is also the "no call after unload" guard.
   */
  private wrap(registration: Registration, once: boolean): Listener {
    const scope = this
    const wrapped = function wrappedListener(this: unknown, ...args: unknown[]): unknown {
      if (!registration.active || scope.disposed) return undefined
      if (once) {
        registration.active = false
        void scope.remove(registration)
      }
      const state = waterfallStateFor(registration.name)
      const last = args.length > 0 ? args[args.length - 1] : undefined
      const inWaterfall = state !== undefined && typeof last === 'function'
      let nextCalled = false
      const invoke = (): unknown => {
        if (!inWaterfall) return registration.original.apply(this, args)
        // waterfall: hand the THREADED value to the listener and wrap `next` so
        // `next(newValue)` really changes what the following listeners receive.
        // The host shares ONE argument list and its own `next()` ignores its
        // arguments, so the value threading is ADDED here (the plugin layer's
        // documented difference from the bare host `ctx.waterfall`).
        const hostNext = last as (...nextArgs: unknown[]) => unknown
        const forward = (...nextArgs: unknown[]): unknown => {
          nextCalled = true
          if (nextArgs.length > 0) state.value = nextArgs[0]
          return hostNext()
        }
        const result = registration.original.apply(this, [state.value, forward])
        if (nextCalled) return result
        // A listener that never called `next` is TRANSPARENT: its return value is
        // ignored and the chain continues, so plain observers can be mixed with
        // middlewares without cutting the flow short.
        if (isThenable(result)) {
          return Promise.resolve(result).then(
            () => (nextCalled ? undefined : hostNext()),
            (error: unknown) => {
              scope.reportListenerError(registration, error)
              return nextCalled ? undefined : hostNext()
            },
          )
        }
        return hostNext()
      }
      try {
        const result = invoke()
        if (isThenable(result)) {
          return Promise.resolve(result).then(undefined, (error: unknown) => {
            scope.reportListenerError(registration, error)
            return undefined
          })
        }
        return result
      } catch (error) {
        scope.reportListenerError(registration, error)
        // A waterfall listener that threw must not break the chain.
        if (inWaterfall && !nextCalled) {
          try {
            return (last as (...nextArgs: unknown[]) => unknown)()
          } catch {
            return undefined
          }
        }
        return undefined
      }
    }
    return wrapped
  }

  private reportListenerError(registration: Registration, error: unknown): void {
    this.log('error', `listener of '${registration.name}' threw (isolated): ${errorText(error)}`, {
      plugin: this.namespace,
      event: registration.name,
      error: errorText(error),
    })
  }

  private remove(registration: Registration): boolean {
    const wasActive = registration.active
    registration.active = false
    const index = this.registrations.indexOf(registration)
    if (index >= 0) this.registrations.splice(index, 1)
    let removed = wasActive || index >= 0
    if (registration.hostDispose !== undefined) {
      const dispose = registration.hostDispose
      registration.hostDispose = undefined
      try {
        const result = dispose()
        if (isThenable(result)) void Promise.resolve(result).then(undefined, () => undefined)
      } catch (error) {
        this.log('warn', `the host disposer of '${registration.name}' threw (ignored): ${errorText(error)}`, {
          plugin: this.namespace,
          event: registration.name,
        })
      }
      removed = true
    }
    if (removed) REGISTRY.untrack(this.namespace, registration.name)
    return removed
  }

  off(name: string, listener?: Listener): number {
    const full = this.resolve(name)
    const matches = this.registrations.filter(
      (registration) => registration.name === full && (listener === undefined || registration.original === listener),
    )
    let removed = 0
    for (const registration of matches) if (this.remove(registration)) removed += 1
    return removed
  }

  listenerCount(name: string): number {
    const full = this.resolve(name)
    return this.registrations.filter((registration) => registration.name === full).length
  }

  listeners(name: string): Listener[] {
    const full = this.resolve(name)
    return this.registrations.filter((registration) => registration.name === full).map((r) => r.original)
  }

  // -- dispatch (delegated to the host, never re-implemented) ----------------

  private broadcast(name: string, ...args: unknown[]): void {
    try {
      this.ctx.emit?.(name, ...args)
    } catch (error) {
      this.log('warn', `emitting '${name}' failed (ignored): ${errorText(error)}`, { plugin: this.namespace, event: name })
    }
  }

  private assertEmittable(full: string): void {
    const owner = full.slice(0, full.indexOf('/'))
    // The reserved namespaces are the LAYER's own (lifecycle + internal): a
    // plugin may LISTEN to them, it may never emit or declare them.
    if (RESERVED_NAMESPACES.includes(owner)) {
      throw new EventsError(
        'reserved-namespace',
        `'${owner}/' is reserved (${RESERVED_NAMESPACES.join(', ')}): plugin '${this.namespace}' may listen to '${full}' but never emit it`,
        { plugin: this.namespace, event: full, reserved: RESERVED_NAMESPACES },
      )
    }
    if (!this.strictNamespaces) return
    if (owner !== this.namespace) {
      throw new EventsError(
        'invalid-name',
        `plugin '${this.namespace}' may only emit inside its own namespace ('${this.namespace}/...'), not '${full}'`,
        { plugin: this.namespace, event: full },
      )
    }
  }

  emit(name: string, ...args: unknown[]): void {
    this.assertUsable('emit')
    const full = this.resolve(name)
    this.assertEmittable(full)
    this.ctx.emit!(full, ...args)
  }

  serial(name: string, ...args: unknown[]): Promise<unknown> {
    this.assertUsable('serial')
    const full = this.resolve(name)
    this.assertEmittable(full)
    if (typeof this.ctx.serial === 'function') return Promise.resolve(this.ctx.serial(full, ...args))
    this.ctx.emit!(full, ...args)
    return Promise.resolve(undefined)
  }

  async parallel(name: string, ...args: unknown[]): Promise<void> {
    this.assertUsable('parallel')
    const full = this.resolve(name)
    this.assertEmittable(full)
    if (typeof this.ctx.parallel === 'function') {
      try {
        await this.ctx.parallel(full, ...args)
      } catch (error) {
        // A listener registered OUTSIDE this layer rejected: the host reports it
        // as an AggregateError. Log it instead of rejecting the emitter, because
        // "a throwing listener must not kill the emitter" is the contract.
        this.log('error', `parallel '${full}' reported a listener failure (isolated): ${errorText(error)}`, {
          plugin: this.namespace,
          event: full,
        })
      }
      return
    }
    this.ctx.emit!(full, ...args)
  }

  bail(name: string, ...args: unknown[]): unknown {
    this.assertUsable('bail')
    const full = this.resolve(name)
    this.assertEmittable(full)
    if (typeof this.ctx.bail === 'function') return this.ctx.bail(full, ...args)
    this.ctx.emit!(full, ...args)
    return undefined
  }

  waterfall(name: string, value: unknown, next?: (value?: unknown) => unknown): unknown {
    this.assertUsable('waterfall')
    const full = this.resolve(name)
    this.assertEmittable(full)
    const state = { value }
    const stack = WATERFALLS.get(full) ?? []
    stack.push(state)
    WATERFALLS.set(full, stack)
    // The state stays pushed until the dispatch SETTLES, so an async middleware
    // that calls `next(newValue)` after an await still threads its value.
    const pop = (): void => {
      const index = stack.lastIndexOf(state)
      if (index >= 0) stack.splice(index, 1)
      if (stack.length === 0) WATERFALLS.delete(full)
    }
    try {
      if (typeof this.ctx.waterfall === 'function') {
        const result = this.ctx.waterfall(full, value, () => (typeof next === 'function' ? next(state.value) : state.value))
        if (isThenable(result)) return Promise.resolve(result).then(
          (final) => {
            pop()
            return final
          },
          (error: unknown) => {
            pop()
            throw error
          },
        )
        pop()
        return result
      }
      this.ctx.emit!(full, value)
      pop()
      return typeof next === 'function' ? next(value) : value
    } catch (error) {
      pop()
      throw error
    }
  }

  // -- effects ---------------------------------------------------------------

  private assertUsable(action: string): void {
    if (this.disposed) {
      throw new EventsError(
        'inactive',
        `plugin '${this.namespace}' is unloaded: ${action}() is not allowed any more (a registration after dispose would leak)`,
        { plugin: this.namespace },
      )
    }
  }

  effect(callback: EffectCallback, options: EffectOptions = {}): Unsubscribe {
    if (typeof callback !== 'function') {
      throw new TypeError('effect() needs a callback returning a disposer')
    }
    this.assertUsable('effect')
    const label = options.label ?? `${this.namespace}:effect`
    const timeoutMs = options.timeoutMs ?? this.disposeTimeoutMs
    // ACQUIRE NOW, synchronously, exactly like the host's own `ctx.effect()`: a
    // plugin opens its socket / registers its route INSIDE the callback, so the
    // resource must exist by the time apply() returns. A throwing acquisition
    // (or one that returns no disposer at all) fails the plugin load instead of
    // being reported at unload, when it is too late to matter.
    const produced = callback()
    if (!isDisposerShape(produced)) {
      throw new TypeError(`effect '${label}' must return a disposer, got ${typeof produced}`)
    }
    const entry: EffectEntry = {
      label,
      timeoutMs,
      // Only the RETURNED value may still be async (a promise of disposers).
      collected: toDisposers(produced, label),
      ran: false,
    }
    this.effects.push(entry)
    if (options.shutdown !== false) installShutdownHooks({ logger: this.log })
    return () => {
      void this.runEffect(entry, [])
    }
  }

  private async runEffect(entry: EffectEntry, errors: string[]): Promise<boolean> {
    if (entry.ran) return false
    entry.ran = true
    let disposers: Disposer[]
    try {
      disposers = await entry.collected
    } catch (error) {
      errors.push(`${entry.label}: ${errorText(error)}`)
      this.log('error', `effect '${entry.label}' could not be collected: ${errorText(error)}`, { plugin: this.namespace })
      return false
    }
    for (const disposer of disposers) {
      await bounded(
        () => Promise.resolve(disposer()),
        entry.timeoutMs,
        (message) => {
          errors.push(`${entry.label}: ${message}`)
          this.log('error', `effect '${entry.label}' failed (isolated): ${message}`, { plugin: this.namespace })
        },
      )
    }
    return true
  }

  // -- disposal --------------------------------------------------------------

  async dispose(): Promise<DisposeReport> {
    const report: DisposeReport = {
      plugin: this.namespace,
      namespace: this.namespace,
      effects: 0,
      listeners: 0,
      errors: [],
      first: false,
    }
    if (this.disposed) return report
    this.isDisposed = true
    report.first = true
    // 1. announce BEFORE tearing down, so another plugin can still observe it.
    this.broadcast(LIFECYCLE.pluginUnloaded, { plugin: this.namespace, namespace: this.namespace })
    // 2. effects, LIFO (the last acquired is released first), each isolated.
    for (const entry of [...this.effects].reverse()) {
      if (await this.runEffect(entry, report.errors)) report.effects += 1
    }
    this.effects.length = 0
    // 3. subscriptions, LIFO, each idempotent.
    for (const registration of [...this.registrations].reverse()) if (this.remove(registration)) report.listeners += 1
    this.registrations.length = 0
    SCOPES.delete(this)
    return report
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Runs `start()` under a bound; a throw/rejection/timeout is REPORTED, never rethrown. */
async function bounded(start: () => Promise<unknown>, timeoutMs: number, onFailure: (message: string) => void): Promise<void> {
  let task: Promise<'ok' | string>
  try {
    task = Promise.resolve(start()).then(
      () => 'ok' as const,
      (error: unknown) => `error:${errorText(error)}` as const,
    )
  } catch (error) {
    // A disposer that throws SYNCHRONOUSLY is isolated like a rejecting one:
    // report it, then let the remaining disposers run (never abort the unload).
    onFailure(errorText(error))
    return
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    const outcome = await task
    if (outcome !== 'ok') onFailure(outcome.slice('error:'.length))
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    // NOT unref'd on purpose: a bound must keep the event loop alive until it
    // fires, or a hanging disposer silently drops the whole shutdown.
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const outcome = await Promise.race([task, timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (outcome === 'timeout') onFailure(`did not finish within ${timeoutMs}ms`)
  else if (outcome !== 'ok') onFailure(outcome.slice('error:'.length))
}

/**
 * True when `value` is something {@link toDisposers} accepts: a disposer, an
 * array or iterable of disposers, a promise of those, or nothing at all.
 * Validated at ACQUISITION time so a wrong `effect()` callback fails the plugin
 * load instead of being reported at unload, when it is too late to matter.
 */
function isDisposerShape(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'function') return true
  if (typeof value !== 'object') return false
  return isThenable(value) || Array.isArray(value) || Symbol.iterator in value || Symbol.asyncIterator in value
}

/** Normalizes what an effect callback returned into a list of disposers. */
async function toDisposers(produced: unknown, label: string): Promise<Disposer[]> {
  const value = isThenable(produced) ? await produced : produced
  if (value === null || value === undefined) return []
  if (typeof value === 'function') return [value as Disposer]
  if (Array.isArray(value)) {
    const out: Disposer[] = []
    for (const item of value) out.push(...(await toDisposers(item, label)))
    return out
  }
  if (typeof value === 'object' && Symbol.asyncIterator in (value as object)) {
    const out: Disposer[] = []
    for await (const item of value as AsyncIterable<unknown>) out.push(...(await toDisposers(item, label)))
    return out
  }
  if (typeof value === 'object' && Symbol.iterator in (value as object)) {
    const out: Disposer[] = []
    for (const item of value as Iterable<unknown>) out.push(...(await toDisposers(item, label)))
    return out
  }
  throw new TypeError(`effect '${label}' must return a disposer (or an array/promise of disposers), got ${typeof value}`)
}

function defaultLogger(ctx: EventsHostContext, namespace: string): EventLogger {
  return (level, message, meta) => {
    const line = `[events:${namespace}] ${message}`
    const host = ctx.logger
    const method = level === 'debug' ? host?.debug : level === 'info' ? host?.info : level === 'warn' ? host?.warn : host?.error
    if (typeof method === 'function') {
      method.call(host, line, meta ?? {})
      return
    }
    if (level === 'debug') return
    const sink = level === 'error' || level === 'warn' ? console.error : console.log
    sink(line, meta ?? {})
  }
}

/**
 * Creates the event scope of ONE plugin. Call it from `apply()`: it binds the
 * scope to the plugin's fiber (unload disposes everything) and returns the
 * typed surface. See `docs/EVENTS.md` for the copy-pasteable example.
 */
export function createEvents(ctx: EventsHostContext, options: CreateEventsOptions): PluginEvents {
  return new PluginEvents(ctx, options)
}
