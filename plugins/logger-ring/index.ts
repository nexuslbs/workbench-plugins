// plugins/logger-ring - the `logger@1` sink `ring`: a bounded in-memory ring of
// the last `size` Messages, readable through the web seam.
//
// ONE sink = ONE plugin, and the sink is not a file and not a stream: it keeps
// the recent history IN THE PROCESS so a UI (the inventory / settings pages) can
// show what the deployment just logged without reading a log file. It is the
// third sink shape the task asks for (a `logger-http` SSE route would be the
// other one): the ring is chosen because it also works with NO web provider
// loaded - the history is kept regardless and only the READ surface is
// conditional.
//
// It consumes the service the core hosts and, when the `web@1` seam is present,
// registers three routes:
//   GET  <path>            -> { size, dropped, messages }
//   GET  <path>/tail?count -> the last <count> Messages (oldest first)
//   POST <path>/clear      -> drop the history
//
// It also PUBLISHES the reader as the `logs` service, so a plugin can read the
// history through the seam instead of scraping the routes.
import {
  DEFAULT_LEVEL,
  LOGGER_CONTRACT,
  exporterLevels,
  loggerOf,
  mountExporter,
  type LogExporter,
  type LogLevelOption,
  type LogMessage,
  type LogsReader,
} from '../../definitions/logger.ts'
import { messageOf, provideService, serviceOf, type ServiceContext } from '../../definitions/support.ts'

export const name = 'logger-ring'
/** Provider id registered with the `logger` capability (the manifest must match). */
export const providerId = 'ring'
export const contract = LOGGER_CONTRACT

/** Default route base path of the read surface. */
export const DEFAULT_PATH = '/api/logs'

/** The `plugins.logger-ring:` row of the roster. */
export interface Config {
  /** Threshold: `error|warn|info|debug` (name or ordinal). Default `info`. */
  level?: LogLevelOption
  /** Per-logger-name thresholds. */
  names?: Record<string, LogLevelOption>
  /** Messages kept (default 500). */
  size?: number
  /** Route base path (default `/api/logs`). */
  path?: string
  /** Set false to keep the history without registering the read routes. */
  routes?: boolean
}

interface PluginContext extends ServiceContext {
  effect(callback: () => (() => void) | void): () => void
}

interface WebRouteSpec {
  method: string
  path: string
  handler: (request: { method: string; path: string; query: URLSearchParams; readText(): Promise<string> }) =>
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

/** The bounded history plus what it had to drop, and the routes that read it. */
export function apply(ctx: PluginContext, config: Config = {}): void {
  const logger = loggerOf(ctx, name)
  const size = Math.max(1, Math.trunc(config.size ?? 500))
  const basePath = config.path ?? DEFAULT_PATH
  const messages: LogMessage[] = []
  let dropped = 0

  const reader: LogsReader = {
    tail(count?: number): { messages: LogMessage[]; dropped: number; size: number } {
      const wanted = count === undefined ? messages.length : Math.max(0, Math.trunc(count))
      return { messages: messages.slice(Math.max(0, messages.length - wanted)), dropped, size: messages.length }
    },
    all(): LogMessage[] {
      return messages.slice()
    },
    size(): number {
      return messages.length
    },
    clear(): void {
      messages.length = 0
      dropped = 0
    },
  }

  const exporter: LogExporter = {
    levels: exporterLevels(config.level, config.names) ?? { default: DEFAULT_LEVEL },
    export(message: LogMessage): void {
      messages.push(message)
      const overflow = messages.length - size
      if (overflow === 1) {
        messages.shift()
        dropped += 1
      } else if (overflow > 1) {
        messages.splice(0, overflow)
        dropped += overflow
      }
    },
  }

  // Announced BEFORE the sink mounts: the ring must not capture its own notice
  // (the history it keeps is the deployment's events, nothing about itself).
  logger.info(
    `ring sink mounting (level=${config.level ?? DEFAULT_LEVEL}, size=${size}, ` +
      `routes=${config.routes === false ? 'off' : basePath})`,
  )
  mountExporter(ctx, exporter, name)

  // The READ side, through the seam: a plugin reads the `logs` service, a human
  // reads the routes. Both disappear with this plugin's fiber.
  provideService(ctx, 'logs', reader)
  const web = serviceOf<WebService>(ctx, 'web')
  if (web !== undefined && config.routes !== false) {
    ctx.effect(() => {
      const disposers = [
        web.route({
          method: 'GET',
          path: basePath,
          description: 'the bounded in-memory log ring (the logger-ring sink)',
          handler: (request) => {
            const count = request.query.get('count')
            const wanted = count === null ? undefined : Number(count)
            return json({ plugin: name, contract, path: basePath, ...reader.tail(wanted) })
          },
        }),
        web.route({
          method: 'GET',
          path: `${basePath}/tail`,
          description: 'the last <count> log Messages (oldest first)',
          handler: (request) => {
            const count = request.query.get('count')
            const wanted = count === null ? 50 : Number(count)
            return json({ plugin: name, ...reader.tail(wanted) })
          },
        }),
        web.route({
          method: 'POST',
          path: `${basePath}/clear`,
          description: 'drop the log ring history',
          handler: () => {
            reader.clear()
            return json({ plugin: name, cleared: true, size: reader.size() })
          },
        }),
      ]
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch (error) {
            logger.debug(`route disposer failed: ${messageOf(error)}`)
          }
        }
      }
    })
  }
}
