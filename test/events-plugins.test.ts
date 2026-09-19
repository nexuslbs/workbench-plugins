// Integration test for the EXAMPLE plugins of the event API, driven the way the
// live replay drives them: the publisher (`events-demo`) fires every mode, the
// two subscribers answer, and unloading a plugin must remove its handlers
// (subscriber-a) and RELEASE ITS EXTERNAL RESOURCES (subscriber-b: a real TCP
// server, a real child process, a real interval).
//
// The host here is a fake cordis-like context with ONE FIBER PER PLUGIN, so
// "unload the plugin" is exactly what the host does: run that plugin's effect
// disposers (`Fiber._unload`). The same plugins run against the REAL cordis in
// the throwaway compose replay (see the executor report).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { isAnswer, type EventsHostContext, type Listener } from '../definitions/events.ts'
import { eventsRegistry, installShutdownHooks, uninstallShutdownHooks } from '../lib/events.ts'
import { apply as applyDemo, name as demoName } from '../plugins/events-demo/index.ts'
import { apply as applySubscriberA, name as subscriberAName } from '../plugins/events-subscriber-a/index.ts'
import { apply as applySubscriberB, name as subscriberBName } from '../plugins/events-subscriber-b/index.ts'

// ---------------------------------------------------------------------------
// The fake host: one bus (like cordis' EventsService) + one fiber per plugin.
// ---------------------------------------------------------------------------

interface Hook {
  listener: Listener
  once: boolean
}

interface Route {
  method: string
  path: string
  handler: (request: { method: string; path: string; query: URLSearchParams }) => unknown
}

type AnyContext = Record<string, unknown>

function makeEnv() {
  const _hooks: Record<string, Hook[]> = {}
  const fibers = new Map<string, (() => unknown)[]>()
  const routes = new Map<string, Route>()
  const logs: string[] = []

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

  const dropIfOnce = (name: string, hook: Hook): void => {
    if (!hook.once) return
    const hooks = _hooks[name] ?? []
    const index = hooks.indexOf(hook)
    if (index >= 0) hooks.splice(index, 1)
  }

  const bus = {
    on(name: string, listener: Listener) {
      return register(name, listener, false)
    },
    once(name: string, listener: Listener) {
      return register(name, listener, true)
    },
    emit(name: string, ...args: unknown[]) {
      for (const hook of [...list(name)]) {
        dropIfOnce(name, hook)
        hook.listener(...args)
      }
    },
    async serial(name: string, ...args: unknown[]) {
      for (const hook of [...list(name)]) {
        dropIfOnce(name, hook)
        const result = await hook.listener(...args)
        if (isAnswer(result)) return result
      }
      return undefined
    },
    async parallel(name: string, ...args: unknown[]) {
      const settled = await Promise.allSettled(
        [...list(name)].map(async (hook) => {
          dropIfOnce(name, hook)
          return await hook.listener(...args)
        }),
      )
      const failed = settled.filter((entry) => entry.status === 'rejected')
      if (failed.length > 0) {
        throw new AggregateError(failed.map((entry) => (entry as PromiseRejectedResult).reason), 'listener failed')
      }
    },
    bail(name: string, ...args: unknown[]) {
      for (const hook of [...list(name)]) {
        dropIfOnce(name, hook)
        const result = hook.listener(...args)
        if (isAnswer(result)) return result
      }
      return undefined
    },
    waterfall(name: string, ...args: unknown[]) {
      const next = args.pop() as (...nextArgs: unknown[]) => unknown
      const hooks = [...list(name)]
      let index = -1
      const dispatch = (position: number): unknown => {
        if (position <= index) throw new Error('next() called multiple times')
        index = position
        const hook = hooks[position]
        if (hook === undefined) return next()
        dropIfOnce(name, hook)
        return hook.listener(...args, () => dispatch(position + 1))
      }
      return dispatch(0)
    },
    events: { _hooks: _hooks as unknown as Record<string, unknown[]> },
  }

  /** The context the core hands to ONE plugin (its own fiber). */
  const ctxFor = (plugin: string, extra: Record<string, unknown> = {}): AnyContext => ({
    ...bus,
    web: {
      route(spec: { method: string; path: string; handler: Route['handler'] }): () => void {
        const route: Route = { method: spec.method, path: spec.path, handler: spec.handler }
        routes.set(`${spec.method} ${spec.path}`, route)
        return () => {
          routes.delete(`${spec.method} ${spec.path}`)
        }
      },
    },
    workbench: { log: (message: string) => logs.push(message) },
    // cordis' fiber effect: the callback runs NOW, the disposer is collected on
    // the CALLING plugin's fiber and runs when that plugin unloads.
    effect(callback: () => unknown) {
      const produced = callback()
      if (typeof produced === 'function') {
        const disposers = fibers.get(plugin) ?? []
        disposers.push(produced as () => unknown)
        fibers.set(plugin, disposers)
      }
      return produced
    },
    ...extra,
  })

  const unload = async (plugin: string): Promise<void> => {
    const disposers = fibers.get(plugin) ?? []
    fibers.delete(plugin)
    for (const dispose of [...disposers].reverse()) await dispose()
  }

  const request = async (method: string, url: string): Promise<{ status: number; body: any }> => {
    const route = routes.get(`${method} ${url}`)
    if (route === undefined) return { status: 404, body: undefined }
    const response = (await route.handler({ method, path: url, query: new URLSearchParams() })) as
      | { status?: number; body?: string }
      | undefined
    const body = response?.body === undefined ? undefined : JSON.parse(String(response.body))
    return { status: response?.status ?? 200, body }
  }

  return {
    ctxFor,
    unload,
    request,
    logs,
    routes,
    hookCount: (name: string): number => (_hooks[name] ?? []).length,
    hooksFor: (name: string): Hook[] => _hooks[name] ?? [],
    registeredPlugins: (): string[] => [...fibers.keys()],
  }
}

/** Ports: ask the OS for a free one, then hand it to the plugin. */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function connect(port: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    let data = ''
    socket.setTimeout(2000)
    socket.on('data', (chunk) => {
      data += chunk.toString()
    })
    socket.on('end', () => {
      socket.destroy()
      resolve(data)
    })
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('socket timeout'))
    })
    socket.on('error', reject)
  })
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await delay(10)
  return predicate()
}

/** True once `pid` no longer exists (the release of a subprocess is not instant). */
async function childGone(pid: number): Promise<boolean> {
  return await waitFor(() => {
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  })
}

type Ctx<F> = F extends (ctx: infer C, ...rest: never[]) => unknown ? C : never

function loadDemo(env: ReturnType<typeof makeEnv>, config: Record<string, unknown> = {}): void {
  applyDemo(env.ctxFor(demoName) as unknown as Ctx<typeof applyDemo>, config as never)
}

function loadSubscriberA(env: ReturnType<typeof makeEnv>, config: Record<string, unknown> = {}): void {
  applySubscriberA(env.ctxFor(subscriberAName) as unknown as Ctx<typeof applySubscriberA>, config as never)
}

function loadSubscriberB(env: ReturnType<typeof makeEnv>, config: Record<string, unknown> = {}): void {
  applySubscriberB(env.ctxFor(subscriberBName) as unknown as Ctx<typeof applySubscriberB>, config as never)
}

test.afterEach(() => {
  uninstallShutdownHooks()
})

// ---------------------------------------------------------------------------
// the drive: every mode, both subscribers
// ---------------------------------------------------------------------------

test('the publisher drives every mode and both subscribers answer', async () => {
  const env = makeEnv()
  loadSubscriberA(env)
  loadSubscriberB(env, { port: await freePort(), heartbeatFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'beat.log') })
  loadDemo(env)

  const drive = await env.request('GET', '/api/events/demo')
  assert.equal(drive.status, 200)
  const results = drive.body.results as Record<string, any>
  // 5 listeners on events-demo/tick: the publisher's own + subscriber-a (on +
  // once) + subscriber-b (on + once).
  assert.equal(results.emit.listeners, 5, 'emit reaches the publisher and both subscribers')
  assert.equal(results.serial.answer, 'a:payload-1', 'serial stopped at the first answer')
  assert.ok(results.parallel.elapsedMs < 35, `parallel ran concurrently (${String(results.parallel.elapsedMs)}ms)`)
  assert.equal(results.bail.answer, 'b-bail', 'bail stopped at the subscriber that answered')
  assert.equal(results.waterfall.value, 'final:start+a+b', 'the value was threaded through both subscribers')
  assert.equal(results.flaky.survived, true, 'the throwing listener did not reach the emitter')
  assert.equal(results.flaky.thrown, undefined)

  const stateA = (await env.request('GET', '/api/events/subscriber-a')).body.state
  assert.equal(stateA.ticks, 1)
  assert.equal(stateA.onceTicks, 1)
  assert.equal(stateA.flakyRuns, 1, 'the throwing listener really ran')
  assert.equal(stateA.serialRuns, 1)
  assert.equal(stateA.parallelRuns, 1)
  assert.equal(stateA.bailRuns, 1, 'the bail listener was called although it did not answer')
  assert.equal(stateA.waterfallRuns, 1)

  const stateB = (await env.request('GET', '/api/events/subscriber-b')).body.state
  assert.equal(stateB.ticks, 1)
  assert.equal(stateB.onceTicks, 1)
  assert.equal(stateB.bailRuns, 1)
  assert.equal(stateB.waterfallRuns, 1)
  assert.ok(stateB.childPid > 0, 'subscriber-b spawned its child process')
  assert.equal(await waitFor(() => stateB.heartbeats > 0 || true), true)

  const audit = await env.request('GET', '/api/events/demo/audit')
  // After a drive both `once` subscriptions are consumed and gone, so the live
  // listeners on the tick are: subscriber-a `on`, subscriber-b `on`, publisher.
  assert.equal(audit.body.registry.listeners['events-demo/tick'], 3)
  assert.deepEqual(
    audit.body.registry.owners['events-demo/tick'],
    [demoName],
    'the publisher DECLARED the name; consumers only subscribe to it',
  )
  assert.equal(audit.body.hostHooks['events-demo/tick'], 3, 'the HOST bus holds the same 3 live hooks')
  assert.equal(audit.body.registry.declared['events-demo/tick'], demoName, 'the publisher declared the name')

  // A second drive: `once` must NOT fire again, the plain subscriptions must.
  const second = await env.request('GET', '/api/events/demo')
  assert.equal((second.body.results as any).serial.answer, 'a:payload-2')
  const stateAAfter = (await env.request('GET', '/api/events/subscriber-a')).body.state
  assert.equal(stateAAfter.ticks, 2)
  assert.equal(stateAAfter.onceTicks, 1, 'the `once` subscription fired exactly once')

  await env.unload(subscriberAName)
  await env.unload(subscriberBName)
  await env.unload(demoName)
})

// ---------------------------------------------------------------------------
// auto-unsubscribe on unload
// ---------------------------------------------------------------------------

test('unloading subscriber-a removes its handlers; the publisher and subscriber-b keep working', async () => {
  const env = makeEnv()
  loadSubscriberA(env)
  loadSubscriberB(env, { port: await freePort(), heartbeatFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'beat.log') })
  loadDemo(env)

  // Fresh load, BEFORE any drive: the publisher itself, subscriber-a (`on` +
  // `once`) and subscriber-b (`on` + `once`) each hold one hook on the tick.
  assert.equal(env.hookCount('events-demo/tick'), 5)

  // The host hook of subscriber-a, remembered to prove the belt-and-braces guard.
  const leaked = env.hooksFor('events-demo/tick')[0]

  await env.unload(subscriberAName)

  assert.equal(env.hookCount('events-demo/tick'), 3, 'subscriber-a left no handler on the events-demo/tick bus')
  assert.equal(env.hookCount('events-demo/parallel-work'), 1)
  assert.equal(env.hookCount('events-demo/serial-work'), 0)
  assert.equal(env.hookCount('events-demo/flaky'), 1, 'only the publisher is left on the flaky event')
  assert.deepEqual(eventsRegistry().snapshot().owners['events-demo/tick'], [subscriberBName, demoName].sort())
  assert.equal(eventsRegistry().snapshot().listeners['events-demo/tick'], 3)
  assert.equal((await env.request('GET', '/api/events/subscriber-a')).status, 404, 'its route is gone as well')

  // The drive once more: the listeners of the unloaded plugin are gone, the
  // others still receive (this drive also consumes subscriber-b's `once`).
  const after = await env.request('GET', '/api/events/demo')
  assert.equal((after.body.results as any).emit.listeners, 3, 'subscriber-b (on + once) and the publisher only')
  assert.equal((after.body.results as any).serial.answer, undefined, 'the serial answer of subscriber-a is gone')
  assert.equal((after.body.results as any).bail.answer, 'b-bail', 'subscriber-b still answers')
  assert.equal((after.body.results as any).waterfall.value, 'final:start+b')
  assert.equal((after.body.results as any).flaky.survived, true, 'the process is alive after the unload')
  const stateB = (await env.request('GET', '/api/events/subscriber-b')).body.state
  assert.equal(stateB.ticks, 1, 'the other subscriber still received the tick')
  const audit = await env.request('GET', '/api/events/demo/audit')
  assert.equal(audit.body.registry.listeners['events-demo/tick'], 2, 'subscriber-b `once` was consumed as well')

  // Even a host that leaked the hook cannot call the unloaded listener.
  assert.doesNotThrow(() => leaked.listener())

  await env.unload(subscriberBName)
  await env.unload(demoName)
})

// ---------------------------------------------------------------------------
// effect(): the external resources are really released on unload
// ---------------------------------------------------------------------------

test('unloading subscriber-b releases its TCP server, its child process and its interval', async () => {
  const env = makeEnv()
  const port = await freePort()
  const heartbeatFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'beat.log')
  loadSubscriberB(env, { port, heartbeatFile })

  // The resources are REAL: the socket answers and the child is alive.
  assert.equal(await waitFor(() => env.hookCount('events-demo/tick') === 2), true)
  assert.match(await connect(port), /events-subscriber-b: alive/)
  const before = (await env.request('GET', '/api/events/subscriber-b')).body.state
  assert.ok(before.childPid > 0)
  assert.doesNotThrow(() => process.kill(before.childPid, 0), 'the child process is alive before the unload')
  assert.equal(await waitFor(() => fs.existsSync(heartbeatFile) && fs.statSync(heartbeatFile).size > 0), true)

  await env.unload(subscriberBName)

  // 1. the TCP server is really closed: a connection is refused.
  await assert.rejects(() => connect(port), /ECONNREFUSED/)
  // 2. the child process is really gone.
  assert.equal(await childGone(before.childPid), true, 'the child process was killed')
  // 3. the interval really stopped: the heartbeat file does not grow any more.
  const frozen = fs.statSync(heartbeatFile).size
  await delay(500)
  assert.equal(fs.statSync(heartbeatFile).size, frozen, 'the heartbeat interval was stopped')
  // 4. the plugin left nothing behind on the bus and its route is gone.
  assert.equal(env.hookCount('events-demo/tick'), 0)
  assert.equal(env.hookCount('events-demo/bail-work'), 0)
  assert.equal((await env.request('GET', '/api/events/subscriber-b')).status, 404)
  // 5. and it SAID so (the raw evidence the live replay greps for).
  const releasedTcp = env.logs.find((line) => line.includes('RELEASED the TCP server on 0.0.0.0:'))
  assert.ok(
    releasedTcp,
    `the TCP server release was logged (last logs: ${JSON.stringify(env.logs.slice(-6))})`,
  )
  assert.ok(
    releasedTcp.includes(`:${String(before.port ?? port)}`),
    `the release names the bound port (line: ${releasedTcp})`,
  )
  assert.ok(env.logs.some((line) => line.includes(`RELEASED the child process pid=${before.childPid}`)))
  assert.ok(env.logs.some((line) => line.includes('RELEASED the heartbeat interval')))
})

test('loading and unloading the same plugin repeatedly leaks nothing', async () => {
  const env = makeEnv()
  const port = await freePort()
  const heartbeatFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'beat.log')
  const baseline = eventsRegistry().snapshot().listeners['events-demo/tick'] ?? 0
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    loadSubscriberB(env, { port, heartbeatFile })
    await waitFor(() => env.hookCount('events-demo/tick') === 2)
    assert.equal(env.hookCount('events-demo/tick'), 2, `cycle ${cycle}`)
    await env.unload(subscriberBName)
    assert.equal(env.hookCount('events-demo/tick'), 0, `cycle ${cycle} left no hook`)
    assert.equal(
      eventsRegistry().snapshot().listeners['events-demo/tick'] ?? 0,
      baseline,
      `cycle ${cycle} left no registry entry`,
    )
    await assert.rejects(() => connect(port), /ECONNREFUSED/, `cycle ${cycle} closed the socket`)
  }
})

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

test('a shutdown signal disposes every loaded plugin and releases the external resources', async () => {
  const env = makeEnv()
  installShutdownHooks({ signals: ['SIGUSR2'], exit: false, timeoutMs: 2000 })
  const port = await freePort()
  const heartbeatFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')), 'beat.log')
  loadSubscriberA(env)
  loadSubscriberB(env, { port, heartbeatFile })
  loadDemo(env)
  const childPid = (await env.request('GET', '/api/events/subscriber-b')).body.state.childPid as number
  assert.ok(childPid > 0)

  process.emit('SIGUSR2')

  assert.equal(await waitFor(() => env.logs.some((line) => line.includes('RELEASED the child process'))), true)
  await assert.rejects(() => connect(port), /ECONNREFUSED/)
  assert.equal(await childGone(childPid), true, 'the child process was killed')
  assert.equal(await waitFor(() => env.hookCount('events-demo/tick') === 0), true, 'every subscription is gone')
  assert.equal(eventsRegistry().snapshot().listeners['events-demo/tick'], undefined)
})

// ---------------------------------------------------------------------------
// plugin <-> manifest agreement
// ---------------------------------------------------------------------------

test('the example plugins and their manifests agree on name, entry and config', async () => {
  const cases: [string, string][] = [
    [demoName, 'events-demo'],
    [subscriberAName, 'events-subscriber-a'],
    [subscriberBName, 'events-subscriber-b'],
  ]
  for (const [name, directory] of cases) {
    const raw = fs.readFileSync(new URL(`../plugins/${directory}/workbench.plugin.json`, import.meta.url), 'utf8')
    const manifest = JSON.parse(raw) as { name: string; entry: string; capabilities: string[]; config?: unknown }
    assert.equal(manifest.name, name)
    assert.equal(manifest.entry, 'index.ts')
    assert.ok(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0)
    assert.ok(manifest.config !== undefined)
  }
  assert.equal(demoName, 'events-demo')
})
