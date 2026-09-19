// core/logger-console - the `logger@1` SINK `console`: the human-readable
// exporter of the logger service.
//
// ONE sink = ONE plugin (operator rule, 2026-09-19): this directory owns the
// CONSOLE output of the deployment and nothing else. Roster it
// (`plugins: { logger-console: { level: info } }`) and log lines appear on
// stdout/stderr; leave it out and the process stays silent even though every
// plugin still LOGS through the service - that is the model, not a bug (see
// docs/LOGGING.md).
//
// It declares `logger` as its capability (`capabilities[].provider` = `console`)
// and CONSUMES the service the core hosts, exactly like every other sink of
// this repository: no cordis import, no core import.
import {
  DEFAULT_LEVEL,
  LOGGER_CONTRACT,
  LOG_LEVEL_NAMES,
  exporterLevels,
  formatText,
  loggerOf,
  mountExporter,
  type LogExporter,
  type LogLevelOption,
  type LogMessage,
} from '../../definitions/logger.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'logger-console'
/** Provider id registered with the `logger` capability (the manifest must match). */
export const providerId = 'console'
export const contract = LOGGER_CONTRACT

/** The `plugins.logger-console:` row of the roster. */
export interface Config {
  /** Threshold: `error|warn|info|debug` (name or ordinal). Default `info`. */
  level?: LogLevelOption
  /** Per-logger-name thresholds, e.g. `{ "web-session": "debug" }`. */
  names?: Record<string, LogLevelOption>
  /** ANSI colours (default false: a container log file has no terminal). */
  colors?: boolean
  /** Characters kept per rendered line (default 10240). */
  maxLength?: number
}

interface PluginContext extends ServiceContext {
  effect(callback: () => (() => void) | void): () => void
}

/** `ts` as `YYYY-MM-DDTHH:MM:SS.mmmZ` (stable, sortable, locale free). */
function stamp(ts: number): string {
  return new Date(ts).toISOString()
}

function levelLabel(level: LogLevelOption | undefined): string {
  return level === undefined ? LOG_LEVEL_NAMES[DEFAULT_LEVEL] : String(level)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const logger = loggerOf(ctx, name)
  const maxLength = config.maxLength ?? 10_240
  const levels = exporterLevels(config.level, config.names) ?? { default: DEFAULT_LEVEL }
  const exporter: LogExporter = {
    colors: config.colors === true ? 1 : 0,
    maxLength,
    levels,
    export(message: LogMessage): void {
      const text =
        `${stamp(message.ts)} ${message.type.toUpperCase().padEnd(5)} ${message.name}: ` +
        `${formatText(message, maxLength)}\n`
      // error/warn are diagnostics -> stderr; info/debug are progress -> stdout.
      // The split is the sink's own decision: the service knows no streams.
      if (message.level <= 1) process.stderr.write(text)
      else process.stdout.write(text)
    },
  }
  const mounted = mountExporter(ctx, exporter, name)
  logger.info(
    `console sink ${mounted.mounted ? 'mounted' : 'NOT mounted'} (level=${levelLabel(config.level)}, ` +
      `colors=${config.colors === true}, maxLength=${maxLength})`,
  )
}
