// events-subscriber-b - the subscriber that OWNS EXTERNAL RESOURCES, released
// through the `effect()` API when the plugin is unloaded (or the process shuts
// down):
//
//   1. a TCP server bound to a real port (the sockets of the plugins),
//   2. a spawned subprocess (the playground/child processes of the plugins),
//   3. a repeating timer writing a heartbeat file (the polling loops).
//
// Every acquisition is ONE `events.effect()`: the callback returns the disposer
// that releases it, and the scope guarantees the disposer runs EXACTLY ONCE,
// LIFO, isolated (a throwing disposer is logged and the others still run) and
// AWAITED (the async socket close is awaited before the unload finishes).
//
// See `docs/EVENTS.md` for the copy-pasteable form of this file.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createEvents } from '../../lib/events.ts'
import type { EventsHostContext } from '../../definitions/events.ts'

export const name = 'events-subscriber-b'

interface WebRequest {
  method: string
  path: string
  query: URLSearchParams
}

interface WebResponse {
  status?: number
  contentType?: string
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
}

interface PluginContext extends EventsHostContext {
  web: WebService
  /** The host log sink (a minimal host may not expose one). */
  workbench?: { log?: (message: string) => void }
}

export interface Config {
  /** Port of the TCP server this plugin binds (its external resource). */
  port?: number
  /** File the heartbeat interval appends to. */
  heartbeatFile?: string
  /** Base path of this plugin's state route. */
  path?: string
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

/** stdout: the raw evidence the live replay greps for. */
const consoleLog = (message: string): void => {
  console.log(`events-subscriber-b: ${message}`)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  // The recommended pattern: a release is reported on the host log sink AND on
  // stdout, so the operator and the test harness both see the effect disposer run.
  const sink = ctx.workbench?.log
  const log = (message: string): void => {
    consoleLog(message)
    sink?.(`events-subscriber-b: ${message}`)
  }
  const port = config.port ?? 12398
  const heartbeatFile = config.heartbeatFile ?? path.join(os.tmpdir(), 'events-subscriber-b.heartbeat')
  const basePath = config.path ?? '/api/events/subscriber-b'
  const events = createEvents(ctx, { namespace: name })

  const state = {
    ticks: 0,
    onceTicks: 0,
    socketConnections: 0,
    heartbeats: 0,
    childPid: 0,
    parallelRuns: 0,
    bailRuns: 0,
    waterfallRuns: 0,
    /** What has been RELEASED so far (evidence for the unload/shutdown proof). */
    released: [] as string[],
  }

  // ---- the external resources, each one an effect --------------------------

  // 1. a real TCP server bound to a port; the disposer closes it (async).
  events.effect(() => {
    const server = net.createServer((socket) => {
      state.socketConnections += 1
      socket.end(`events-subscriber-b: alive (connection ${state.socketConnections})\n`)
    })
    server.on('error', (error: unknown) => log(`TCP server error (not fatal): ${String(error)}`))
    server.listen(port, '0.0.0.0', () => log(`TCP server listening on 0.0.0.0:${port}`))
    return async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      state.released.push('socket')
      log(`RELEASED the TCP server on 0.0.0.0:${port} (connections served: ${state.socketConnections})`)
    }
  }, { label: 'subscriber-b:tcp-server' })

  // 2. a spawned subprocess killed by the disposer.
  events.effect(() => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    state.childPid = child.pid ?? 0
    log(`spawned the child process pid=${state.childPid}`)
    return () => {
      try {
        child.kill('SIGKILL')
      } catch (error) {
        log(`the child was already gone: ${String(error)}`)
      }
      state.released.push('child')
      log(`RELEASED the child process pid=${state.childPid}`)
    }
  }, { label: 'subscriber-b:child-process' })

  // 3. a repeating timer, stopped by the disposer.
  events.effect(() => {
    fs.appendFileSync(heartbeatFile, `start ${Date.now()}\n`)
    const timer = setInterval(() => {
      state.heartbeats += 1
      fs.appendFileSync(heartbeatFile, `heartbeat ${state.heartbeats} ${Date.now()}\n`)
    }, 200)
    log(`heartbeat interval every 200ms -> ${heartbeatFile}`)
    return () => {
      clearInterval(timer)
      state.released.push('interval')
      log(`RELEASED the heartbeat interval after ${state.heartbeats} beat(s)`)
    }
  }, { label: 'subscriber-b:heartbeat-interval' })

  // ---- the subscriptions ---------------------------------------------------

  events.on('events-demo/tick', () => {
    state.ticks += 1
  })
  events.once('events-demo/tick', () => {
    state.onceTicks += 1
  })
  events.on('events-demo/parallel-work', async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    state.parallelRuns += 1
  })
  // `bail`: this one ANSWERS, so it is the last listener called.
  events.on('events-demo/bail-work', () => {
    state.bailRuns += 1
    return 'b-bail'
  })
  events.on('events-demo/waterfall-work', (value: unknown, next: (value?: unknown) => unknown) => {
    state.waterfallRuns += 1
    return next(`${String(value)}+b`)
  })

  events.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: basePath,
      description: 'the external resources of events-subscriber-b and what it received',
      handler: () =>
        json({
          plugin: name,
          contract: events.contract,
          namespace: events.namespace,
          port,
          heartbeatFile,
          state: { ...state },
        }),
    }),
  )

  log(`loaded: namespace=${events.namespace} port=${port} heartbeat=${heartbeatFile} state=${basePath}`)
}

export default { name, inject: ['web'], apply }
