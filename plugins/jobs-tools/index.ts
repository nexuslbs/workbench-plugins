// plugins/jobs-tools - the CONSUMER of the background jobs capability (`jobs@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/jobs.ts) - the contract, `ctx.jobs`
//   Provider                         - a backend (`core/jobs-local` today)
//   Consumer                         - THIS plugin: the `jobs ...` named tools.
//
// It imports the DEFINITION only, so the registry can be swapped (a future
// remote/queue-backed `jobs@1` provider) with a config edit, and
// `npm run check:seam` enforces that direction.
//
// ONE TOOL PER OPERATION, the `fs@1` sibling convention: `start`, `logs` and
// `stop` have genuinely different parameter shapes and the tools seam publishes
// a JSON Schema per tool, so an action-enum tool would force a union schema that
// no caller could validate against. (`web-session` uses an action-enum because
// every one of its actions takes the same handle.)
//
// The tools are deliberately DUMB: every answer is the structured result of the
// definition (`JobInfo`, `JobLogPage`, `JobCleanupResult`), with no reformatting,
// so a caller can page with the returned cursor and never re-read a log.

import { jobsOf, JobsError } from '../../definitions/jobs.ts'
import type { JobsService } from '../../definitions/jobs.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'

export const name = 'jobs-tools'

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

/** The config of this consumer (the built-ins the `logs` tool defaults to). */
export interface Config {
  /** Default byte window of one `logs` page (the provider's own cap still applies). */
  pageBytes?: number
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new JobsError('jobs.invalid-input', `the '${key}' parameter must be a string`, {
      stage: 'jobs-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read a required string parameter. */
function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined || value.length === 0) {
    throw new JobsError('jobs.invalid-input', `the '${key}' parameter is required and must be a non-empty string`, {
      stage: 'jobs-tools',
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
    throw new JobsError('jobs.invalid-input', `the '${key}' parameter must be a boolean`, {
      stage: 'jobs-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional integer parameter. */
function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new JobsError('jobs.invalid-input', `the '${key}' parameter must be an integer`, {
      stage: 'jobs-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional array of strings (the argv form; the ORDER is preserved). */
function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new JobsError('jobs.invalid-input', `the '${key}' parameter must be an array of strings`, {
      stage: 'jobs-tools',
      details: { parameter: key },
    })
  }
  return value as string[]
}

/** Read an optional `Record<string, string>` parameter (env / envRefs). */
function optionalStringRecord(params: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new JobsError('jobs.invalid-input', `the '${key}' parameter must be an object of string values`, {
      stage: 'jobs-tools',
      details: { parameter: key },
    })
  }
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [entryKey, entryValue] of entries) {
    if (typeof entryValue !== 'string') {
      throw new JobsError('jobs.invalid-input', `the '${key}.${entryKey}' parameter must be a string`, {
        stage: 'jobs-tools',
        details: { parameter: `${key}.${entryKey}` },
      })
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/** The command shape a job start accepts (the same as `subprocess run`). */
const START_PARAMETERS: ToolParameters = {
  argv: {
    type: 'array',
    items: { type: 'string' },
    description: 'the command as an ARGV ARRAY (preferred): started DIRECTLY, no shell, no splitting; e.g. ["npm","run","build"]',
  },
  command: {
    type: 'string',
    description: 'the command as ONE STRING; only accepted together with shell: true',
  },
  shell: { type: 'boolean', description: 'explicit shell escape hatch: run <shell> -c <command> (default false)' },
  cwd: { type: 'string', description: 'working directory of the job (must exist)' },
  env: { type: 'json', description: 'LITERAL environment overrides for the job (never logged)' },
  envRefs: {
    type: 'json',
    description: 'environment entries resolved at start time: "${cred:NAME}" via the credentials capability, "${env:NAME}" from the process environment',
  },
  label: { type: 'string', description: 'short human label used in `jobs list` (not an identifier)' },
  timeoutMs: { type: 'integer', description: 'optional deadline in ms (0/absent = no deadline; the job runs until stopped)' },
  maxLogBytes: { type: 'integer', description: 'byte ceiling of THIS job log; reaching it STOPS the job (default: provider policy)' },
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  // `ctx.jobs` is the SEAM: resolved lazily at call time through the definition,
  // so this plugin loads on its own and fails only when a call cannot be served.
  const jobs = (): JobsService => {
    const service = jobsOf(ctx as never)
    if (service === undefined) {
      throw new JobsError('jobs.invalid-input', 'no jobs@1 provider is loaded: enable a provider plugin (core/jobs-local) in the roster', {
        stage: 'jobs-tools',
      })
    }
    return service
  }

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs start',
      description:
        'Starts a background job on the workbench host and returns its STABLE job id plus the durable log path: argv-based (no shell unless shell:true), with cwd/env/envRefs, an optional deadline and an optional log ceiling; the job keeps running while the caller does something else, and its output lives in a file on disk, so a client disconnect does not lose it',
      parameters: START_PARAMETERS,
      handler: async (params) =>
        jobs().start({
          ...(optionalStringArray(params, 'argv') !== undefined ? { argv: optionalStringArray(params, 'argv')! } : {}),
          ...(optionalString(params, 'command') !== undefined ? { command: optionalString(params, 'command')! } : {}),
          ...(optionalBoolean(params, 'shell') !== undefined ? { shell: optionalBoolean(params, 'shell')! } : {}),
          ...(optionalString(params, 'cwd') !== undefined ? { cwd: optionalString(params, 'cwd')! } : {}),
          ...(optionalStringRecord(params, 'env') !== undefined ? { env: optionalStringRecord(params, 'env')! } : {}),
          ...(optionalStringRecord(params, 'envRefs') !== undefined ? { envRefs: optionalStringRecord(params, 'envRefs')! } : {}),
          ...(optionalString(params, 'label') !== undefined ? { label: optionalString(params, 'label')! } : {}),
          ...(optionalInteger(params, 'timeoutMs') !== undefined ? { timeoutMs: optionalInteger(params, 'timeoutMs')! } : {}),
          ...(optionalInteger(params, 'maxLogBytes') !== undefined ? { maxLogBytes: optionalInteger(params, 'maxLogBytes')! } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs list',
      description:
        'Lists every job the provider owns, newest first: id, label, state (running/exited/failed/killed), pid, exit code, duration, log path and log size',
      parameters: {},
      handler: () => jobs().list(),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs status',
      description: 'Reports ONE job by id: state, exit code/signal, duration, log path and log size',
      parameters: {
        id: { type: 'string', required: true, description: 'the job id returned by `jobs start`' },
      },
      handler: (params) => jobs().status(requiredString(params, 'id')),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs logs',
      description:
        'Reads ONE page of a job log by BYTE CURSOR: pass the `nextCursor` of the previous answer to get only the NEW lines, so a poller never re-reads the whole log; the answer carries `state`, `nextCursor`, `bytes`, complete `lines` and `eof`',
      parameters: {
        id: { type: 'string', required: true, description: 'the job id returned by `jobs start`' },
        cursor: { type: 'integer', description: 'byte cursor from the previous answer (default 0 = from the beginning)' },
        limit: { type: 'integer', description: 'maximum bytes returned in this page (provider default/cap applies)' },
        fromStart: { type: 'boolean', description: 'return the whole log from the start, ignoring the cursor' },
      },
      handler: async (params) =>
        jobs().logs({
          id: requiredString(params, 'id'),
          ...(optionalInteger(params, 'cursor') !== undefined ? { cursor: optionalInteger(params, 'cursor')! } : {}),
          ...((optionalInteger(params, 'limit') ?? config.pageBytes) !== undefined
            ? { limit: optionalInteger(params, 'limit') ?? config.pageBytes }
            : {}),
          ...(optionalBoolean(params, 'fromStart') !== undefined ? { fromStart: optionalBoolean(params, 'fromStart')! } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs stop',
      description:
        'Stops a job (SIGTERM to the WHOLE PROCESS GROUP, then SIGKILL after the grace) and returns its terminal state; stopping an already finished job is a normal answer, not an error',
      parameters: {
        id: { type: 'string', required: true, description: 'the job id returned by `jobs start`' },
        signal: { type: 'string', description: 'signal sent first (default SIGTERM); SIGKILL skips the grace' },
        graceMs: { type: 'integer', description: 'grace in ms between the first signal and SIGKILL (default 500)' },
      },
      handler: async (params) =>
        jobs().stop({
          id: requiredString(params, 'id'),
          ...(optionalString(params, 'signal') !== undefined ? { signal: optionalString(params, 'signal') as NodeJS.Signals } : {}),
          ...(optionalInteger(params, 'graceMs') !== undefined ? { graceMs: optionalInteger(params, 'graceMs')! } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs cleanup',
      description:
        'Removes finished jobs from the registry and (by default) their log files; `dryRun` reports what would go, `all` also stops and removes jobs that are still running',
      parameters: {
        all: { type: 'boolean', description: 'also remove jobs that are still RUNNING (they are stopped first)' },
        olderThanSeconds: { type: 'integer', description: 'remove only jobs that ended more than this many seconds ago' },
        dryRun: { type: 'boolean', description: 'report what would be removed without removing anything' },
        removeLogs: { type: 'boolean', description: 'also delete the log files (default true)' },
      },
      handler: async (params) =>
        jobs().cleanup({
          ...(optionalBoolean(params, 'all') !== undefined ? { all: optionalBoolean(params, 'all')! } : {}),
          ...(optionalInteger(params, 'olderThanSeconds') !== undefined
            ? { olderThanSeconds: optionalInteger(params, 'olderThanSeconds')! }
            : {}),
          ...(optionalBoolean(params, 'dryRun') !== undefined ? { dryRun: optionalBoolean(params, 'dryRun')! } : {}),
          ...(optionalBoolean(params, 'removeLogs') !== undefined ? { removeLogs: optionalBoolean(params, 'removeLogs')! } : {}),
        }),
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'jobs policy',
      description:
        'Reports the policy of the loaded jobs@1 provider: log directory, maximum job count, default log ceiling, default deadline, kill grace, whether a shell is allowed, default page size',
      parameters: {},
      handler: () => jobs().policy(),
    }),
  )
}

export default { name, inject: ['jobs', 'tools'], apply }

/** The declared start parameters, exported so a test can assert the contract. */
export { START_PARAMETERS }
