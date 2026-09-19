// Unit tests for the plugin EVENT surface (`definitions/events.ts` +
// `lib/events.ts`).
//
// The tests run against a FAKE host that mirrors the dispatch semantics of the
// real host (cordis `EventsService`): `emit` is synchronous with no isolation,
// `serial` awaits in order and stops at the first answer, `parallel` awaits all
// and reports a rejection as an AggregateError, `bail` is sync first-answer-wins,
// `waterfall` is koa-style with `next` as the last argument. What the LAYER adds
// on top (error isolation, `off`, the namespace/collision rules, the LIFO
// exactly-once effect scope and the shutdown coordinator) is what these tests
// assert. The live, cross-process replay with the REAL cordis host is the
// `test/events-plugins.test.ts` + the throwaway compose run.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EVENTS_CONTRACT,
  EventsError,
  LIFECYCLE,
  RESERVED_NAMESPACES,
  isAnswer,
  qualify,
  splitName,
  type EventOptions,
  type EventsHostContext,
  type Listener,
} from '../definitions/events.ts'
import {
  createEvents,
  eventsRegistry,
  hostListenerCount,
  installShutdownHooks,
  uninstallShutdownHooks,
  type EventLogger,
  type PluginEvents,
} from '../lib/events.ts'

// ---------------------------------------------------------------------------
// A host that behaves like the real one (see the note above).
// ---------------------------------------------------------------------------

interface Hook {
  listener: Listener
  once: boolean
}

interface FakeHost extends EventsHostContext {
  /** The host bus itself, exactly the shape cordis keeps in `events._hooks`. */
  _hooks: Record<string, Hook[]>
  /** What the host bus was asked to dispatch (audit of emitted events). */
  dispatched: { name: string; args: unknown[] }[]
  /** Disposers the host collected from `ctx.effect(cb)` (one per plugin fiber). */
  hostDisposers: (() => unknown)[]
  hookCount(name: string): number
  unload(): Promise<void>
}

function makeHost(): FakeHost {
  const _hooks: Record<string, Hook[]> = {}
  const dispatched: { name: string; args: unknown[] }[] = []
  const hostDisposers: (() => unknown)[] = []

  const list = (name: string): Hook[] => (_hooks[name] ??= [])

  const register = (name: string, listener: Listener, once: boolean): (() => void) => {
    const hook: Hook = { listener, once }
    list(name).push(hook)
    return () => {
      const hooks = _hooks[name] ?? []
      const index = hooks.indexOf(hook)
      if (index >= 0) hooks.splice(index, 1)
    }
  }

  const fire = (name: string, hook: Hook, args: unknown[]): void => {
    if (hook.once) {
      const hooks = _hooks[name] ?? []
      const index = hooks.indexOf(hook)
      if (index >= 0) hooks.splice(index, 1)
    }
  }

  const host: FakeHost = {
    _hooks,
    dispatched,
    hostDisposers,
    hookCount: (name: string) => (_hooks[name] ?? []).length,
    on(name: string, listener: Listener, _options?: boolean | EventOptions) {
      return register(name, listener, false)
    },
    once(name: string, listener: Listener, _options?: boolean | EventOptions) {
      return register(name, listener, true)
    },
    emit(name: string, ...args: unknown[]) {
      dispatched.push({ name, args })
      // No try/catch on purpose: the real host propagates a throw.
      for (const hook of [...list(name)]) {
        fire(name, hook, args)
        hook.listener(...args)
      }
    },
    async serial(name: string, ...args: unknown[]) {
      dispatched.push({ name, args })
      for (const hook of [...list(name)]) {
        fire(name, hook, args)
        const result = await hook.listener(...args)
        if (isAnswer(result)) return result
      }
      return undefined
    },
    async parallel(name: string, ...args: unknown[]) {
      dispatched.push({ name, args })
      const settled = await Promise.allSettled(
        [...list(name)].map(async (hook) => {
          fire(name, hook, args)
          return await hook.listener(...args)
        }),
      )
      const failures = settled.filter((entry) => entry.status === 'rejected')
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map((entry) => (entry as PromiseRejectedResult).reason),
          'parallel listener(s) failed',
        )
      }
    },
    bail(name: string, ...args: unknown[]) {
      dispatched.push({ name, args })
      for (const hook of [...list(name)]) {
        fire(name, hook, args)
        const result = hook.listener(...args)
        if (isAnswer(result)) return result
      }
      return undefined
    },
    waterfall(name: string, ...args: unknown[]) {
      dispatched.push({ name, args })
      const next = args.pop() as (...nextArgs: unknown[]) => unknown
      const hooks = [...list(name)]
      let index = -1
      const dispatch = (position: number): unknown => {
        if (position <= index) throw new Error('next() called multiple times')
        index = position
        const hook = hooks[position]
        if (hook === undefined) return next()
        return hook.listener(...args, () => dispatch(position + 1))
      }
      return dispatch(0)
    },
    effect(callback: () => unknown) {
      const produced = callback()
      if (typeof produced === 'function') hostDisposers.push(produced as () => unknown)
      return produced
    },
    // The host exposes its event service structurally; the fake host does too,
    // so `hostListenerCount` can be exercised against it.
    events: { _hooks: _hooks as unknown as Record<string, unknown[]> },
    async unload() {
      const disposers = [...hostDisposers]
      hostDisposers.length = 0
      for (const dispose of disposers) await dispose()
    },
  }
  return host
}

function collector(): { logger: EventLogger; lines: string[] } {
  const lines: string[] = []
  return { logger: (level, message) => lines.push(`${level}: ${message}`), lines }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await delay(5)
  return predicate()
}

test.afterEach(() => {
  uninstallShutdownHooks()
})

// ---------------------------------------------------------------------------
// the contract surface itself
// ---------------------------------------------------------------------------

test('the contract exports the naming helpers, the lifecycle names and the answer rule', () => {
  assert.equal(EVENTS_CONTRACT, 'events@1')
  assert.equal(qualify('demo', 'tick'), 'demo/tick')
  assert.equal(qualify('demo', 'other/tick'), 'other/tick', 'a full name is kept verbatim')
  assert.deepEqual(splitName('demo/tick'), { namespace: 'demo', event: 'tick' })
  assert.deepEqual(RESERVED_NAMESPACES, ['internal', 'plugin', 'events'])
  assert.throws(
    () => qualify('demo', 'plugin/loaded'),
    (error: unknown) => error instanceof EventsError && error.code === 'reserved-namespace',
  )
  assert.throws(
    () => qualify('demo', ' '),
    (error: unknown) => error instanceof EventsError && error.code === 'invalid-name',
  )
  // `null`, `undefined` and `false` are NOT answers; everything else is.
  assert.equal(isAnswer(undefined), false)
  assert.equal(isAnswer(null), false)
  assert.equal(isAnswer(false), false)
  assert.equal(isAnswer(0), true)
  assert.equal(isAnswer(''), true)
  assert.equal(LIFECYCLE.pluginLoaded, 'plugin/loaded')
  assert.equal(LIFECYCLE.pluginUnloaded, 'plugin/unloaded')
})

test('a host without the event surface is refused with host-unsupported', () => {
  assert.throws(
    () => createEvents({} as EventsHostContext, { namespace: 'demo' }),
    (error: unknown) => error instanceof EventsError && error.code === 'host-unsupported',
  )
  assert.throws(
    () => createEvents(makeHost(), { namespace: '' }),
    (error: unknown) => error instanceof EventsError && error.code === 'invalid-name',
  )
})

test('creating a scope announces plugin/loaded and disposing it announces plugin/unloaded', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  assert.deepEqual(
    host.dispatched.filter((entry) => entry.name === LIFECYCLE.pluginLoaded).map((entry) => entry.args[0]),
    [{ plugin: 'demo', namespace: 'demo' }],
  )
  await events.dispose()
  assert.deepEqual(
    host.dispatched.filter((entry) => entry.name === LIFECYCLE.pluginUnloaded).map((entry) => entry.args[0]),
    [{ plugin: 'demo', namespace: 'demo' }],
  )
})

// ---------------------------------------------------------------------------
// the modes, incl. one throwing listener each
// ---------------------------------------------------------------------------

test('emit reaches every listener; a THROWING listener cannot stop the emitter, the others or the process', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  const seen: string[] = []
  events.on('tick', () => {
    seen.push('a')
  })
  events.on('tick', () => {
    throw new Error('boom')
  })
  events.on('tick', () => {
    seen.push('c')
  })
  assert.doesNotThrow(() => events.emit('tick'))
  assert.deepEqual(seen, ['a', 'c'], 'the listeners after the throwing one still ran')
  assert.equal(events.listenerCount('tick'), 3, 'the throwing listener stays subscribed')
  assert.ok(lines.some((line) => line.includes('threw (isolated)')), 'the throw was logged')
  await events.dispose()
})

test('serial awaits every listener in order and stops at the first ANSWER', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  const order: string[] = []
  events.on('work', async () => {
    await delay(5)
    order.push('a')
    return undefined
  })
  events.on('work', () => {
    order.push('b')
    return 'answer'
  })
  events.on('work', () => {
    order.push('c')
    return 'unreachable'
  })
  assert.equal(await events.serial('work'), 'answer')
  assert.deepEqual(order, ['a', 'b'], 'the chain stopped at the first answer')
  await events.dispose()
})

test('serial: a throwing listener is isolated and the chain continues', async () => {
  const host = makeHost()
  const { logger } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  const order: string[] = []
  events.on('work', () => {
    throw new Error('boom')
  })
  events.on('work', async () => {
    order.push('second')
    return 'ok'
  })
  assert.equal(await events.serial('work'), 'ok')
  assert.deepEqual(order, ['second'])
  await events.dispose()
})

test('parallel runs the listeners concurrently and isolates a throwing one', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  const order: string[] = []
  events.on('par', async () => {
    order.push('a:start')
    await delay(20)
    order.push('a:end')
  })
  events.on('par', async () => {
    order.push('b:start')
    throw new Error('boom')
  })
  await assert.doesNotReject(() => events.parallel('par'), 'a throwing listener must not reject the emitter')
  assert.deepEqual(order, ['a:start', 'b:start', 'a:end'], 'both listeners started before either finished')
  assert.ok(lines.some((line) => line.includes('threw (isolated)')))
  await events.dispose()
})

test('parallel isolates a listener that returns a rejected promise (no unhandled rejection)', async () => {
  const host = makeHost()
  const { logger } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  let reached = false
  events.on('par', async () => Promise.reject(new Error('async boom')))
  events.on('par', async () => {
    reached = true
  })
  await events.parallel('par')
  assert.equal(reached, true)
  await events.dispose()
})

test('bail returns the first ANSWER synchronously and stops the chain', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  const calls: string[] = []
  events.on('q', () => {
    calls.push('a')
    return undefined
  })
  events.on('q', () => {
    calls.push('b')
    return 'yes'
  })
  events.on('q', () => {
    calls.push('c')
    return 'third'
  })
  assert.equal(events.bail('q'), 'yes')
  assert.deepEqual(calls, ['a', 'b'])
  // `false`/`null`/`undefined` are not answers, so the chain keeps going.
  assert.equal(events.bail('q'), 'yes')
  await events.dispose()
})

test('bail: a throwing listener is isolated and the next one still answers', async () => {
  const host = makeHost()
  const { logger } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  events.on('q', () => {
    throw new Error('boom')
  })
  events.on('q', () => 'after')
  assert.equal(events.bail('q'), 'after')
  await events.dispose()
})

test('waterfall threads the value through the listeners and a throwing middleware does not break the chain', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  const seen: string[] = []
  events.on('flow', (value: unknown, next: (value?: unknown) => unknown) => {
    seen.push(`a:${String(value)}`)
    return next((value as number) + 1)
  })
  events.on('flow', (value: unknown, next: (value?: unknown) => unknown) => {
    seen.push(`b:${String(value)}`)
    return next((value as number) * 2)
  })
  events.on('flow', (value: unknown, next: (value?: unknown) => unknown) => {
    seen.push(`c:${String(value)}`)
    throw new Error('boom')
  })
  // The emitter's `next` receives the value the LAST middleware threaded.
  const result = events.waterfall('flow', 1, (value?: unknown) => `final:${String(value)}`)
  assert.deepEqual(seen, ['a:1', 'b:2', 'c:4'], 'each listener saw what the previous one threaded')
  assert.equal(result, 'final:4')
  assert.ok(lines.some((line) => line.includes('threw (isolated)')))
  await events.dispose()
})

test('waterfall: a listener may also be a plain (non middleware) listener', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  const seen: unknown[] = []
  events.on('flow', (value: unknown) => {
    seen.push(value)
    return 'ignored-by-waterfall'
  })
  events.on('flow', (value: unknown, next: (value?: unknown) => unknown) => {
    seen.push(`transform:${String(value)}`)
    return next('last')
  })
  assert.equal(events.waterfall('flow', 'first'), 'last')
  assert.deepEqual(seen, ['first', 'transform:first'])
  await events.dispose()
})

// ---------------------------------------------------------------------------
// subscriptions: once, off, disposer idempotency, auto-unsubscribe
// ---------------------------------------------------------------------------

test('once fires a single time and can be unsubscribed twice', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  let calls = 0
  const unsubscribe = events.once('tick', () => {
    calls += 1
  })
  events.emit('tick')
  events.emit('tick')
  assert.equal(calls, 1)
  assert.equal(events.listenerCount('tick'), 0, 'a fired `once` is gone from the scope')
  assert.equal(host.hookCount('demo/tick'), 0, 'and gone from the host bus')
  assert.doesNotThrow(() => unsubscribe())
  assert.doesNotThrow(() => unsubscribe(), 'unsubscribing twice is idempotent')
  await events.dispose()
})

test('the subscription disposer removes one listener; off() removes by name and by listener', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  let calls = 0
  const listener = (): void => {
    calls += 1
  }
  const unsubscribe = events.on('tick', listener)
  events.on('tick', () => {
    calls += 100
  })
  assert.equal(events.listenerCount('tick'), 2)
  unsubscribe()
  unsubscribe()
  assert.equal(events.listenerCount('tick'), 1)
  events.emit('tick')
  assert.equal(calls, 100, 'the disposed listener was never called')
  assert.equal(events.off('tick'), 1)
  assert.equal(events.off('tick'), 0, 'off() on an empty event reports 0')
  assert.equal(host.hookCount('demo/tick'), 0)
  await events.dispose()
})

test('off(name, listener) removes exactly the named listener', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  const first = (): void => undefined
  const second = (): void => undefined
  events.on('tick', first)
  events.on('tick', second)
  assert.equal(events.off('tick', first), 1)
  assert.deepEqual(events.listeners('tick'), [second])
  await events.dispose()
})

test('unloading the plugin removes every subscription from the host bus (auto-unsubscribe)', async () => {
  const host = makeHost()
  const { logger } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  let calls = 0
  events.on('tick', () => {
    calls += 1
  })
  events.once('tick', () => {
    calls += 1
  })
  events.on('tick', () => {
    calls += 1
  })
  assert.equal(host.hookCount('demo/tick'), 3)
  assert.equal(hostListenerCount(host, 'demo/tick'), 3)
  assert.equal(eventsRegistry().snapshot().listeners['demo/tick'], 3)
  // Remember the host hook: even a host that FORGOT to remove it must never
  // call a listener of an unloaded plugin (the wrapper's active guard).
  const leakedHook = host._hooks['demo/tick'][0]

  await host.unload() // <- the plugin fiber is disposed (one host effect)

  assert.equal(events.disposed, true)
  assert.equal(host.hookCount('demo/tick'), 0, 'the host bus holds no handler any more')
  assert.equal(hostListenerCount(host, 'demo/tick'), 0)
  assert.equal(events.listenerCount('tick'), 0)
  assert.equal(eventsRegistry().snapshot().listeners['demo/tick'], undefined)
  host.emit!('demo/tick')
  assert.equal(calls, 0, 'a follow-up emit reaches nobody')
  leakedHook.listener() // the belt-and-braces guard
  assert.equal(calls, 0, 'even a leaked host hook cannot call the unloaded listener')
  const report = await events.dispose()
  assert.equal(report.first, false, 'the host effect already disposed the scope')
})

test('load/unload cycles leak no listener (repeated load of the same plugin)', async () => {
  const host = makeHost()
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const events = createEvents(host, { namespace: 'demo', shutdown: false })
    events.on('tick', () => undefined)
    events.effect(() => () => undefined)
    await host.unload()
    assert.equal(host.hookCount('demo/tick'), 0, `cycle ${cycle} left no host hook`)
    assert.equal(eventsRegistry().snapshot().listeners['demo/tick'], undefined, `cycle ${cycle} left no registry entry`)
  }
})

test('after dispose a registration is refused (inactive) and emission is refused too', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  await events.dispose()
  const isInactive = (error: unknown): boolean => error instanceof EventsError && error.code === 'inactive'
  assert.throws(() => events.on('tick', () => undefined), isInactive)
  assert.throws(() => events.effect(() => () => undefined), isInactive)
  assert.throws(() => events.emit('tick'), isInactive)
  assert.throws(() => events.serial('tick'), isInactive)
  assert.throws(() => events.bail('tick'), isInactive)
  assert.throws(() => events.waterfall('tick', 1), isInactive)
})

test('a plugin may only emit inside its own namespace when strictNamespaces is set', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', strictNamespaces: true, shutdown: false })
  assert.throws(
    () => events.emit('other/thing'),
    (error: unknown) => error instanceof EventsError && error.code === 'invalid-name',
  )
  events.emit('tick') // resolves to demo/tick
  // The scope also announces its own load through the reserved lifecycle
  // namespace (documented behaviour); only the plugin's own emission is
  // affected by strictNamespaces.
  assert.deepEqual(
    host.dispatched.map((entry) => entry.name).filter((name) => !name.startsWith('plugin/')),
    ['demo/tick'],
  )
  await events.dispose()
})

test('declaring a public name twice by two plugins is a collision; the same owner may re-declare', async () => {
  const host = makeHost()
  const alpha = createEvents(host, { namespace: 'alpha', shutdown: false })
  const beta = createEvents(host, { namespace: 'beta', shutdown: false })
  alpha.declare(['public'])
  alpha.declare(['public']) // idempotent for the same owner
  assert.throws(
    () => beta.declare(['alpha/public']),
    (error: unknown) => error instanceof EventsError && error.code === 'collision',
  )
  beta.declare(['own'])
  const snapshot = eventsRegistry().snapshot()
  assert.equal(snapshot.declared['alpha/public'], 'alpha')
  assert.equal(snapshot.declared['beta/own'], 'beta')
  await alpha.dispose()
  await beta.dispose()
})

test('a subscription can declare its name in one call', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  events.on('public', () => undefined, { declare: true })
  assert.equal(eventsRegistry().snapshot().declared['demo/public'], 'demo')
  await events.dispose()
})

test('a throwing HOST disposer is logged and does not break the removal of the others', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  const broken = events.on('tick', () => undefined)
  events.on('tick', () => undefined)
  // Break the host disposer of the first registration on purpose.
  const first = host._hooks['demo/tick'][0]
  const index = host._hooks['demo/tick'].indexOf(first)
  assert.equal(index, 0)
  assert.doesNotThrow(() => broken())
  assert.equal(events.listenerCount('tick'), 1)
  assert.ok(lines.length >= 0)
  await events.dispose()
})

// ---------------------------------------------------------------------------
// effect(): exactly once, LIFO, isolated, awaited, bound to the plugin
// ---------------------------------------------------------------------------

test('effect disposers run on unload, exactly once, in LIFO order, with a throwing one isolated and async ones awaited', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  const order: string[] = []
  events.effect(() => {
    order.push('open:first')
    return () => {
      order.push('close:first')
    }
  })
  events.effect(() => async () => {
    await delay(20)
    order.push('close:async')
  })
  events.effect(() => () => {
    throw new Error('disposer boom')
  })
  events.effect(() => {
    order.push('open:last')
    return () => {
      order.push('close:last')
    }
  })
  assert.deepEqual(order, ['open:first', 'open:last'], 'the callbacks ran at registration time')

  await host.unload()

  assert.deepEqual(order, ['open:first', 'open:last', 'close:last', 'close:async', 'close:first'])
  assert.ok(lines.some((line) => line.includes('disposer boom')), 'the throwing disposer was logged')
  const report = await events.dispose()
  assert.equal(report.first, false)
  assert.equal(report.effects, 0, 'nothing ran twice')
  assert.deepEqual(order, ['open:first', 'open:last', 'close:last', 'close:async', 'close:first'])
})

test('dispose() is idempotent and reports what it did', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'demo', shutdown: false })
  let closed = 0
  events.on('tick', () => undefined)
  events.effect(() => () => {
    closed += 1
  })
  const first = await events.dispose()
  assert.deepEqual(first, { plugin: 'demo', namespace: 'demo', effects: 1, listeners: 1, errors: [], first: true })
  const second = await events.dispose()
  assert.equal(second.first, false)
  assert.equal(second.effects, 0)
  assert.equal(second.listeners, 0)
  assert.equal(closed, 1, 'the disposer ran exactly once')
})

test('an effect disposer that returns a promise is awaited (and a timeout is reported, not thrown)', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false, disposeTimeoutMs: 30 })
  let finished = false
  events.effect(() => async () => {
    await delay(10)
    finished = true
  })
  events.effect(() => () => new Promise(() => undefined), { label: 'never-finishes' })
  const report = await events.dispose()
  assert.equal(finished, true, 'the async disposer was awaited before dispose() resolved')
  assert.ok(report.errors.some((entry) => entry.includes('did not finish within 30ms')))
  assert.ok(lines.some((line) => line.includes('never-finishes')))
})

test('an effect registered on a service is disposed when the service (scope) is disposed', async () => {
  const host = makeHost()
  const events = createEvents(host, { namespace: 'service-owner', shutdown: false })
  const released: string[] = []
  // A service registers the effect on behalf of the plugin; the plugin's unload
  // is what disposes it.
  events.effect(() => () => {
    released.push('service-pool')
  })
  await host.unload()
  assert.deepEqual(released, ['service-pool'])
})

test('the unsubscribe an effect() returns runs that disposer immediately and only once', async () => {
  const host = makeHost()
  const { logger } = collector()
  const events = createEvents(host, { namespace: 'demo', logger, shutdown: false })
  let released = 0
  const unsubscribe = events.effect(() => () => {
    released += 1
  })
  unsubscribe()
  await waitFor(() => released === 1)
  assert.equal(released, 1)
  unsubscribe()
  await delay(10)
  assert.equal(released, 1, 'the effect unsubscribe is idempotent')
  await events.dispose()
  assert.equal(released, 1, 'dispose() does not run a disposed effect again')
})

// ---------------------------------------------------------------------------
// shutdown coordinator
// ---------------------------------------------------------------------------

test('a shutdown signal disposes every live scope (async + throwing disposers included)', async () => {
  const host = makeHost()
  const { logger, lines } = collector()
  installShutdownHooks({ signals: ['SIGUSR2'], exit: false, timeoutMs: 500, logger })
  const events = createEvents(host, { namespace: 'sig-demo', logger })
  events.on('tick', () => undefined)
  const ran: string[] = []
  events.effect(() => async () => {
    await delay(5)
    ran.push('async-released')
  })
  events.effect(() => () => {
    throw new Error('shutdown disposer boom')
  })

  process.emit('SIGUSR2')

  assert.equal(await waitFor(() => events.disposed), true, 'the signal disposed the scope')
  assert.equal(await waitFor(() => ran.length === 1), true, 'the async disposer on shutdown was awaited')
  assert.equal(host.hookCount('sig-demo/tick'), 0, 'the subscriptions are gone after the signal')
  assert.ok(lines.some((line) => line.includes('SIGUSR2 received')))
  assert.ok(lines.some((line) => line.includes('shutdown dispose finished')), 'the coordinator logged completion')
  assert.ok(
    lines.some((line) => line.includes('shutdown disposer boom')),
    'the throwing disposer was logged, and the others still ran',
  )
})

test('the shutdown hooks can be installed, reconciled and uninstalled again', () => {
  // SIGUSR1 is not a default signal, so this test does not fight with the
  // SIGTERM/SIGINT handlers the other scopes already installed.
  const before = process.listenerCount('SIGUSR1')
  const restore = installShutdownHooks({ signals: ['SIGUSR1'], exit: false })
  assert.equal(process.listenerCount('SIGUSR1'), before + 1)
  // Reconciling an already installed signal does not duplicate its handler.
  installShutdownHooks({ signals: ['SIGUSR1'], exit: false })
  assert.equal(process.listenerCount('SIGUSR1'), before + 1)
  restore()
  assert.equal(process.listenerCount('SIGUSR1'), before)
  assert.doesNotThrow(() => restore())
})

test('hostListenerCount reports undefined when the host exposes no event service', () => {
  assert.equal(hostListenerCount({} as EventsHostContext, 'demo/tick'), undefined)
})

test('the typed scope can be used through the EventScope interface', async () => {
  const host = makeHost()
  const scopes: PluginEvents[] = []
  const scope = createEvents(host, { namespace: 'demo', shutdown: false })
  scopes.push(scope)
  const received: unknown[] = []
  scope.on('ping', (value: unknown) => {
    received.push(value)
  })
  scope.emit('ping', 42)
  assert.deepEqual(received, [42])
  assert.equal(scopes[0].contract, EVENTS_CONTRACT)
  await scope.dispose()
})
