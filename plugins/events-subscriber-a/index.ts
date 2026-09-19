// events-subscriber-a - a plain subscriber of another plugin's events.
//
// It exercises the READ side of the plugin event API: `on`, `once`, `serial`
// (it answers, so the chain stops there), `parallel` (it is slow on purpose, so
// the emitter's elapsed time proves concurrency), `bail` (it deliberately does
// NOT answer) and `waterfall` (it threads the value) - plus a listener that
// THROWS, to prove the isolation contract: the emitter, the other listeners and
// the process all survive it.
//
// The plugin holds NO external resource: that is `events-subscriber-b`.
import { loggerOf } from '../../definitions/logger.ts'
import { createEvents } from '../../lib/events.ts'
import type { EventsHostContext } from '../../definitions/events.ts'

export const name = 'events-subscriber-a'

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
}

export interface Config {
  /** Base path of this plugin's state route. */
  path?: string
  /** Delay (ms) of the parallel listener; it must stay visible in the drive result. */
  parallelDelayMs?: number
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  // The logger SERVICE handle of this plugin (docs/LOGGING.md): name + level per
  // call and NO console anywhere - the process prints nothing until a deployment
  // mounts an exporter plugin.
  const log = (message: string): void => {
    loggerOf(ctx, name).info(message)
  }
  const basePath = config.path ?? '/api/events/subscriber-a'
  const parallelDelayMs = config.parallelDelayMs ?? 20
  const events = createEvents(ctx, { namespace: name })

  const state = {
    ticks: 0,
    /** Fired by the `once` subscription: it must stay at 1 whatever the load. */
    onceTicks: 0,
    flakyRuns: 0,
    serialRuns: 0,
    parallelRuns: 0,
    /** Runs of the bail listener: it is called but never answers. */
    bailRuns: 0,
    waterfallRuns: 0,
    lastPayload: null as unknown,
  }

  // `on`: every tick of the publisher (a full `namespace/event` name: a plugin
  // may SUBSCRIBE to another plugin's declared event).
  events.on('events-demo/tick', (payload: unknown) => {
    state.ticks += 1
    state.lastPayload = payload
  })

  // `once`: the first tick only, then it is gone (also from the host bus).
  events.once('events-demo/tick', () => {
    state.onceTicks += 1
  })

  // The THROWING listener: it must never reach the emitter.
  events.on('events-demo/flaky', () => {
    state.flakyRuns += 1
    throw new Error('intentional listener failure (events-subscriber-a)')
  })

  // `serial`: an ANSWER stops the chain (subscriber-b never sees it).
  events.on('events-demo/serial-work', async (input: unknown) => {
    await delay(5)
    state.serialRuns += 1
    return `a:${String(input)}`
  })

  // `parallel`: slow on purpose.
  events.on('events-demo/parallel-work', async () => {
    await delay(parallelDelayMs)
    state.parallelRuns += 1
  })

  // `bail`: called, but it answers `undefined` (= no answer), so the chain
  // continues to the next listener.
  events.on('events-demo/bail-work', () => {
    state.bailRuns += 1
    return undefined
  })

  // `waterfall`: thread the value and continue.
  events.on('events-demo/waterfall-work', (value: unknown, next: (value?: unknown) => unknown) => {
    state.waterfallRuns += 1
    return next(`${String(value)}+a`)
  })

  // This plugin's observable state, so the test/replay can see what it received
  // (and can see that the route is GONE once the plugin is unloaded).
  events.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: basePath,
      description: 'what events-subscriber-a received from the publisher',
      handler: () =>
        json({
          plugin: name,
          contract: events.contract,
          namespace: events.namespace,
          state: { ...state },
        }),
    }),
  )

  log(`loaded: namespace=${events.namespace} state=${basePath}`)
}

export default { name, inject: ['web'], apply }
