// events-demo - the PUBLISHER + drive + audit surface of the plugin event API.
//
// It exists so the whole surface can be exercised ONCE, from outside, with raw
// output: `GET <path>` drives every dispatch mode (emit / serial / parallel /
// bail / waterfall) plus a listener that throws on purpose, and
// `GET <path>/audit` reports what the process-wide registry knows (declared
// names, live listener counts, per-event owners) plus the HOST's own hook count
// for its events. The subscribers that answer are `events-subscriber-a` and
// `events-subscriber-b`.
//
// See `definitions/events.ts` (the contract) and `docs/EVENTS.md` (the guide).
import {
  createEvents,
  eventsRegistry,
  hostListenerCount,
  type EventLogger,
} from '../../lib/events.ts'
import type { EventsHostContext } from '../../definitions/events.ts'

export const name = 'events-demo'

/** The events this plugin PUBLISHES (its namespace is its plugin name). */
export const PUBLISHED = ['tick', 'serial-work', 'parallel-work', 'bail-work', 'waterfall-work', 'flaky'] as const

// ---------------------------------------------------------------------------
// The `web@1` / `workbench` surfaces this plugin consumes, described
// STRUCTURALLY (an external plugin never imports the core package).
// ---------------------------------------------------------------------------

interface WebRequest {
  method: string
  path: string
  query: URLSearchParams
  readText(): Promise<string>
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
}

interface WorkbenchLike {
  log(message: string): void
}

interface PluginContext extends EventsHostContext {
  web: WebService
  workbench?: WorkbenchLike
}

export interface Config {
  /** Base path of the drive route; the audit route is `<path>/audit`. */
  path?: string
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

const log = (message: string): void => {
  console.log(`events-demo: ${message}`)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const basePath = config.path ?? '/api/events/demo'
  // One scope for this plugin: every subscription and every effect below dies
  // with it when the plugin is unloaded (see docs/EVENTS.md).
  const events = createEvents(ctx, { namespace: name })
  const logger: EventLogger = (level, message, meta) => {
    console.log(`events-demo[${level}]: ${message}${meta === undefined ? '' : ` ${JSON.stringify(meta)}`}`)
  }

  const state = {
    /** Ticks THIS publisher received on its own event. */
    ticks: 0,
    drives: 0,
    /** Runs of the publisher's own `flaky` listener (it does NOT throw; the subscriber does). */
    flakyRuns: 0,
  }

  // Publish the names this plugin owns (the collision check uses this).
  events.declare([...PUBLISHED])

  // A publisher is an ordinary listener too: it hears its own event.
  events.on('tick', () => {
    state.ticks += 1
  })
  events.on('flaky', () => {
    state.flakyRuns += 1
  })

  // The drive: every mode, in one call, with the results the caller can see.
  events.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: basePath,
      description: 'drives every plugin event mode (emit/serial/parallel/bail/waterfall + a throwing listener)',
      handler: async () => {
        state.drives += 1
        const before = eventsRegistry().snapshot()
        const results: Record<string, unknown> = {}

        // 1. emit: fire and forget, every subscriber runs.
        events.emit('tick', { drive: state.drives, at: Date.now() })
        results.emit = {
          listeners: before.listeners[`${name}/tick`] ?? 0,
          note: 'synchronous broadcast; a throwing listener is logged and cannot stop the others',
        }

        // 2. serial: awaited in order, stops at the first ANSWER.
        results.serial = { answer: await events.serial('serial-work', `payload-${state.drives}`) }

        // 3. parallel: awaited concurrently (the elapsed time shows it).
        const started = Date.now()
        await events.parallel('parallel-work', `payload-${state.drives}`)
        results.parallel = { elapsedMs: Date.now() - started }

        // 4. bail: synchronous, first ANSWER wins, the rest is not called.
        results.bail = { answer: events.bail('bail-work', `payload-${state.drives}`) }

        // 5. waterfall: the value is threaded through the listeners (`+a`, `+b`).
        results.waterfall = {
          value: events.waterfall('waterfall-work', 'start', (value?: unknown) => `final:${String(value)}`),
        }

        // 6. isolation: one subscriber throws, the process and the other
        //    listeners survive (the throw is logged by the layer).
        let survived = false
        let thrown: string | undefined
        try {
          events.emit('flaky', `payload-${state.drives}`)
          survived = true
        } catch (error) {
          thrown = error instanceof Error ? error.message : String(error)
        }
        results.flaky = { survived, thrown }

        return json({
          contract: events.contract,
          plugin: name,
          namespace: events.namespace,
          results,
          state: { ...state },
          registry: eventsRegistry().snapshot(),
        })
      },
    }),
  )

  // The audit: what the registry knows + the HOST's own hook count.
  events.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: `${basePath}/audit`,
      description: 'the process-wide event registry + the host hook count of this plugin events',
      handler: () => {
        const snapshot = eventsRegistry().snapshot()
        return json({
          contract: events.contract,
          plugin: name,
          namespace: events.namespace,
          declaredByThisPlugin: PUBLISHED.map((event) => `${name}/${event}`),
          registry: snapshot,
          // Independent of the layer's bookkeeping: the HOST bus itself.
          hostHooks: Object.fromEntries(
            PUBLISHED.map((event) => [`${name}/${event}`, hostListenerCount(ctx, `${name}/${event}`)]),
          ),
          state: { ...state },
        })
      },
    }),
  )

  log(`loaded: namespace=${events.namespace} contract=${events.contract} drive=${basePath}`)
  log(`publishing ${PUBLISHED.map((event) => `${name}/${event}`).join(', ')}`)
}

export default { name, inject: ['web'], apply }
