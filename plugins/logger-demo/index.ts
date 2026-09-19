// plugins/logger-demo - the PRODUCER + drive surface of the logger service.
//
// It is a CONSUMER, not a sink: it exists so the logging model can be exercised
// from outside with raw evidence (see docs/LOGGING.md and the task gates). It
// emits one Message per level at apply time and again on every HTTP call to its
// drive route, each message carrying the caller-supplied marker so the sinks can
// be compared line by line.
//
//   GET <path>?count=N&name=<logger>&level=<level>
//        -> emits N Messages (default 1) and answers what it emitted
//   GET <path>/audit
//        -> what the logger service looks like from inside a plugin
//
// Nothing here writes to a stream: the plugin only CALLS the service, so with no
// sink plugin rostered the calls produce no output at all.
import { LOG_LEVEL_NAMES, loggerOf, type LogLevelName } from '../../definitions/logger.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'logger-demo'

/** The levels this plugin drives, lowest first. */
export const LEVELS = LOG_LEVEL_NAMES

/** The `plugins.logger-demo:` row of the roster. */
export interface Config {
  /** Base path of the drive route (default `/api/logger/demo`). */
  path?: string
  /** Logger name used when the caller passes none (default: the plugin name). */
  loggerName?: string
  /** Emit one Message per level at apply time (default true). */
  onLoad?: boolean
}

interface PluginContext extends ServiceContext {
  effect(callback: () => (() => void) | void): () => void
}

interface WebRouteSpec {
  method: string
  path: string
  handler: (request: { method: string; path: string; query: URLSearchParams }) =>
    | { status?: number; contentType?: string; body?: string }
    | void
    | Promise<{ status?: number; contentType?: string; body?: string } | void>
  description?: string
}

interface WebService {
  route(spec: WebRouteSpec): () => void
}

function json(body: unknown, status = 200): { status: number; contentType: string; body: string } {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

function isLevel(value: string | null): value is LogLevelName {
  return value !== null && (LOG_LEVEL_NAMES as readonly string[]).includes(value)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const basePath = config.path ?? '/api/logger/demo'
  const defaultName = config.loggerName ?? name
  const logger = loggerOf(ctx, defaultName)
  const emits = { total: 0 }

  /** Emits one Message of `level` on `loggerName`; returns the emitted record. */
  const emit = (level: LogLevelName, loggerName: string, marker: string): Record<string, unknown> => {
    const handle = loggerOf(ctx, loggerName)
    const text = `logger-demo ${level} ${marker}`
    handle[level](text)
    emits.total += 1
    return { level, logger: loggerName, message: text }
  }

  // At load: one Message per level, so a boot with a sink rostered proves the
  // level filter immediately and a boot without one proves the silence.
  if (config.onLoad !== false) {
    for (const level of LEVELS) emit(level, defaultName, `on-load@${new Date().toISOString()}`)
  }

  const web = ctx.get?.('web', false) as WebService | undefined
  if (web !== undefined && typeof web.route === 'function') {
    ctx.effect(() => {
      const disposers = [
        web.route({
          method: 'GET',
          path: basePath,
          description: 'emit N log Messages through the logger service (the logging drive surface)',
          handler: (request) => {
            const count = Math.max(1, Math.min(1000, Math.trunc(Number(request.query.get('count') ?? 1)) || 1))
            const requestedName = request.query.get('name') ?? defaultName
            const requestedLevel = request.query.get('level')
            const marker = request.query.get('marker') ?? `${Date.now()}`
            const levels: LogLevelName[] = isLevel(requestedLevel) ? [requestedLevel] : [...LEVELS]
            const emitted: Record<string, unknown>[] = []
            for (let index = 0; index < count; index++) {
              for (const level of levels) {
                emitted.push(emit(level, requestedName, `${marker}#${index}`))
              }
            }
            return json({ plugin: name, basePath, emitted: emitted.length, total: emits.total, messages: emitted })
          },
        }),
        web.route({
          method: 'GET',
          path: `${basePath}/audit`,
          description: 'what a plugin sees of the logger service (the service, its exporters and the buffer)',
          handler: () => {
            const service = ctx.logger
            const exporters = service?.exporters
            return json({
              plugin: name,
              contract: 'logger@1',
              servicePresent: service !== undefined && typeof service === 'function',
              exporterMethod: typeof service?.exporter,
              mountedExporters: exporters === undefined ? null : exporters.size,
              buffered: service?.buffer?.length ?? null,
              totalEmitted: emits.total,
              levels: LEVELS,
            })
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  }

  logger.info(`logger-demo ready (levels=${LEVELS.join(',')}, drive=${basePath}, web=${web === undefined ? 'absent' : 'present'})`)
}
