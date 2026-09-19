// core/logger-jsonl - the `logger@1` SINK `jsonl`: one JSON object per line
// in a file (structure, not prose), with bounded rotation.
//
// ONE sink = ONE plugin. The line is `{sn,ts,name,type,level,args}` - the
// `Message` projected by `messageToJson` (definitions/logger.ts), so a consumer
// of the file can `jq` the level, the logger name and the timestamp instead of
// parsing a rendered string. Errors keep name/message/stack; a cycle becomes
// `[circular]`; the depth is bounded.
//
// SECRETS: a log line must never carry a credential VALUE. The serializer can
// only make values JSON-safe, it cannot know which string is a secret - the
// rule is the caller's (log the credential NAME, never its value, see
// docs/CREDENTIALS.md) and this sink never writes a plugin's resolved config.
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_LEVEL,
  LOGGER_CONTRACT,
  levelName,
  exporterLevels,
  loggerOf,
  messageToJson,
  mountExporter,
  reportOnce,
  type LogExporter,
  type LogLevelOption,
  type LogMessage,
} from '../../definitions/logger.ts'
import { messageOf, type ServiceContext } from '../../definitions/support.ts'

export const name = 'logger-jsonl'
/** Provider id registered with the `logger` capability (the manifest must match). */
export const providerId = 'jsonl'
export const contract = LOGGER_CONTRACT

/** Default file, relative to the process working directory. */
export const DEFAULT_PATH = '.workbench/logs/workbench.jsonl'

/** The `plugins.logger-jsonl:` row of the roster. */
export interface Config {
  /** Threshold: `error|warn|info|debug` (name or ordinal). Default `info`. */
  level?: LogLevelOption
  /** Per-logger-name thresholds. */
  names?: Record<string, LogLevelOption>
  /** The file that receives the lines (default {@link DEFAULT_PATH}). */
  path?: string
  /** Rotate before a line would push the file over this size (0 = never, default 0). */
  maxBytes?: number
  /** Rotated files kept as `<path>.1`, `<path>.2`, ... (default 3; 0 truncates). */
  maxFiles?: number
}

interface PluginContext extends ServiceContext {
  effect(callback: () => (() => void) | void): () => void
}

/** What this sink reports about itself (also the gate evidence). */
export interface JsonlSink {
  file: string
  written: number
  rotations: number
  failures: number
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const logger = loggerOf(ctx, name)
  const file = path.resolve(config.path ?? DEFAULT_PATH)
  const maxBytes = Math.max(0, config.maxBytes ?? 0)
  const maxFiles = Math.max(0, config.maxFiles ?? 3)
  const state: JsonlSink = { file, written: 0, rotations: 0, failures: 0 }
  let fd: number | undefined
  let bytes = 0

  const open = (): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fd = fs.openSync(file, 'a')
    bytes = fs.statSync(file).size
  }

  /** `file` -> `file.1` -> `file.2` ... , dropping the oldest beyond `maxFiles`. */
  const rotate = (): void => {
    if (fd !== undefined) {
      fs.closeSync(fd)
      fd = undefined
    }
    if (maxFiles === 0) {
      if (fs.existsSync(file)) fs.rmSync(file)
    } else {
      for (let index = maxFiles - 1; index >= 1; index--) {
        const from = index === 1 ? file : `${file}.${index - 1}`
        const to = `${file}.${index}`
        if (fs.existsSync(to)) fs.rmSync(to)
        if (fs.existsSync(from)) fs.renameSync(from, to)
      }
    }
    state.rotations += 1
    open()
  }

  const write = (message: LogMessage): void => {
    const line = `${JSON.stringify(messageToJson(message))}\n`
    const size = Buffer.byteLength(line)
    try {
      if (fd === undefined) open()
      if (maxBytes > 0 && bytes > 0 && bytes + size > maxBytes) rotate()
      if (fd === undefined) throw new Error('the sink file could not be opened')
      fs.writeSync(fd, line)
      bytes += size
      state.written += 1
    } catch (error) {
      state.failures += 1
      reportOnce(`jsonl:${file}`, `the JSONL sink could not write to ${file}: ${messageOf(error)}`)
    }
  }

  const exporter: LogExporter = {
    levels: exporterLevels(config.level, config.names) ?? { default: DEFAULT_LEVEL },
    export: write,
  }

  // The file handle and the exporter share ONE effect: unloading the plugin (or
  // a failed mount) closes the handle and removes the sink together, so a
  // remount never leaves a duplicate registration or an open fd behind.
  // The announcement goes out BEFORE the sink mounts: a file sink must never
  // capture its own mount line. The file starts with the deployment's first
  // EVENT, and the line about the file is seen by the OTHER sinks (console).
  logger.info(
    `jsonl sink mounting -> ${file} (level=${levelName(exporterLevels(config.level)?.default ?? DEFAULT_LEVEL)}, ` +
      `maxBytes=${maxBytes}, maxFiles=${maxFiles})`,
  )

  ctx.effect(() => {
    open()
    const handle = mountExporter(ctx, exporter, name)
    return () => {
      handle.dispose()
      if (fd !== undefined) {
        fs.closeSync(fd)
        fd = undefined
      }
    }
  })
}
