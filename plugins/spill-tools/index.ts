// plugins/spill-tools - the CONSUMER of the spill capability (`spill@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/spill.ts) - the contract, `ctx.spill`
//   Provider                          - a backend (`core/spill-local` today)
//   Consumer                          - THIS plugin: the `spill ...` tools, plus
//                                       the OTHER consumers that hand their
//                                       overflow here (`core/subprocess-local`,
//                                       `core/jobs-local`).
//
// It imports the DEFINITION only, so the write/read policy can be swapped (a
// provider that compresses, or writes to object storage) with a config edit, and
// `npm run check:seam` enforces that direction.
//
// ONE TOOL PER OPERATION, the `fs@1` sibling convention: `write`, `read`, `info`,
// `list` and `purge` have different parameter shapes and the tools seam publishes
// a JSON Schema per tool.
//
// The `read` tool is a RANGE read (offset/limit, line-aligned by default): a
// spilled payload is never pulled whole through a tool answer, it is paged with
// the `nextOffset` the previous answer returned.

import { spillOf, SpillError } from '../../definitions/spill.ts'
import type { SpillService } from '../../definitions/spill.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'

export const name = 'spill-tools'

/** One declared tool parameter (the author form of `definitions/tools.ts`). */
type ToolParameter = ParameterSchemaSpec[string]

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

interface ToolsLike {
  registerTool(def: {
    name: string
    description?: string
    parameters?: ToolParameters
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  }): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
}

/** The config of this consumer (the read window `read` defaults to). */
export interface Config {
  /** Default byte window of one `spill read` (the provider's own cap still applies). */
  pageBytes?: number
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SpillError('spill.invalid-input', `the '${key}' parameter must be a string`, {
      stage: 'spill-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read a required string parameter. */
function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined || value.length === 0) {
    throw new SpillError('spill.invalid-input', `the '${key}' parameter is required and must be a non-empty string`, {
      stage: 'spill-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional boolean parameter. */
function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new SpillError('spill.invalid-input', `the '${key}' parameter must be a boolean`, {
      stage: 'spill-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional non-negative integer parameter. */
function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SpillError('spill.invalid-input', `the '${key}' parameter must be a non-negative integer`, {
      stage: 'spill-tools',
      details: { parameter: key },
    })
  }
  return value
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  // `ctx.spill` is the SEAM: resolved lazily at call time through the definition,
  // so this plugin loads on its own and fails only when a call cannot be served.
  const spill = (): SpillService => {
    const service = spillOf(ctx as never)
    if (service === undefined) {
      throw new SpillError('spill.invalid-input', 'no spill@1 provider is loaded: enable a provider plugin (core/spill-local) in the roster', {
        stage: 'spill-tools',
      })
    }
    return service
  }

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'spill write',
      description:
        'Writes an oversized payload to a SPILL file and returns { path, bytes, sha256, preview }: the durable half of a capped answer, so nothing an inline cap cut is lost; the file is content-addressed and read back in RANGES with `spill read`',
      parameters: {
        content: { type: 'string', required: true, description: 'the FULL payload to write (a payload beyond the provider cap fails with spill.too-large)' },
        label: { type: 'string', description: 'short label used in the file name, e.g. subprocess-stdout (sanitised)' },
        extension: { type: 'string', description: 'file extension of the spill file (default txt, no dot needed)' },
        source: { type: 'string', description: 'what wrote it, recorded in `spill info` (e.g. the plugin or job id)' },
      },
      handler: async (params) =>
        spill().write({
          content: requiredString(params, 'content'),
          ...(optionalString(params, 'label') !== undefined ? { label: optionalString(params, 'label')! } : {}),
          ...(optionalString(params, 'extension') !== undefined ? { extension: optionalString(params, 'extension')! } : {}),
          ...(optionalString(params, 'source') !== undefined ? { source: optionalString(params, 'source')! } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'spill read',
      description:
        'Reads a bounded RANGE of a spill file: pass `offset` and the `nextOffset` of the previous answer to page through it; the window is LINE-ALIGNED by default and the answer carries total bytes, the returned window, nextOffset, eof and the SHA-256 of the WHOLE file',
      parameters: {
        path: { type: 'string', required: true, description: 'the spill file path returned by `spill write` (or by a subprocess/jobs answer)' },
        offset: { type: 'integer', description: 'byte offset of the first returned byte (0-based, default 0)' },
        limit: { type: 'integer', description: 'maximum bytes returned (provider default/cap applies)' },
        align: { type: 'string', enum: ['line', 'byte'], description: "line (default) starts at the beginning of the line containing offset; byte returns exactly [offset, offset+limit)" },
      },
      handler: async (params) =>
        spill().read({
          path: requiredString(params, 'path'),
          ...(optionalInteger(params, 'offset') !== undefined ? { offset: optionalInteger(params, 'offset')! } : {}),
          ...((optionalInteger(params, 'limit') ?? config.pageBytes) !== undefined
            ? { limit: optionalInteger(params, 'limit') ?? config.pageBytes }
            : {}),
          ...(optionalString(params, 'align') !== undefined ? { align: optionalString(params, 'align') as 'line' | 'byte' } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'spill info',
      description: 'Reports ONE spill file: size, SHA-256, modification time, age in seconds and whether the retention policy considers it expired',
      parameters: {
        path: { type: 'string', required: true, description: 'the spill file path' },
      },
      handler: (params) => spill().info(requiredString(params, 'path')),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'spill list',
      description: 'Lists the spill files of this provider, newest first, with size, hash, age and the expired flag',
      parameters: {
        limit: { type: 'integer', description: 'maximum entries returned (provider default applies)' },
      },
      handler: (params) => spill().list(optionalInteger(params, 'limit')),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'spill purge',
      description:
        'Applies the retention policy: removes files older than maxAgeSeconds and/or trims the directory to maxTotalBytes (oldest first); `dryRun` reports what would go without deleting anything',
      parameters: {
        maxAgeSeconds: { type: 'integer', description: 'remove every file older than this (default: the provider policy)' },
        maxTotalBytes: { type: 'integer', description: 'trim the directory to this many bytes, oldest file first (default: the provider policy)' },
        dryRun: { type: 'boolean', description: 'report what WOULD be removed without removing anything' },
      },
      handler: async (params) =>
        spill().purge({
          ...(optionalInteger(params, 'maxAgeSeconds') !== undefined ? { maxAgeSeconds: optionalInteger(params, 'maxAgeSeconds')! } : {}),
          ...(optionalInteger(params, 'maxTotalBytes') !== undefined ? { maxTotalBytes: optionalInteger(params, 'maxTotalBytes')! } : {}),
          ...(optionalBoolean(params, 'dryRun') !== undefined ? { dryRun: optionalBoolean(params, 'dryRun')! } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'spill policy',
      description:
        'Reports the policy of the loaded spill@1 provider: directory, per-payload ceiling, directory ceiling, retention age, preview bytes',
      parameters: {},
      handler: () => spill().policy(),
    }),
  )
}

export default { name, inject: ['spill', 'tools'], apply }
