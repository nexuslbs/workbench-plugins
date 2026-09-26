// plugins/subprocess-tools - the CONSUMER of the local process capability
// (`subprocess@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/subprocess.ts) - the contract, `ctx.subprocess`
//   Provider                               - a backend (`core/subprocess-local`)
//   Consumer                               - THIS plugin: it exposes the
//                                            capability as a named TOOL and
//                                            never learns how a process is
//                                            actually started.
//
// It imports the DEFINITION (never a provider), so a deployment can swap the
// local provider for another `subprocess@1` implementation (an ssh/container
// runner built on the same contract) with a config edit only, and
// `npm run check:seam` enforces that direction.
//
// ONE TOOL PER OPERATION, following the `fs@1` sibling seam (plugins/fs-tools):
// `run` and `policy` have different parameter shapes, and the tool seam
// publishes a JSON Schema per tool, so an action-enum tool would force a union
// schema that no caller could validate against. (`web-session` uses an
// action-enum because ALL its actions take the same handle.)
//
// The answer is the STRUCTURED result of the definition - exit code, both
// streams, byte counts, the timeout/kill flags and the SPILL reference for bytes
// beyond the cap. Nothing is reformatted into prose, so a caller can branch on
// the exit code and page the spilled output deterministically.

import { subprocessOf, SubprocessError } from '../../definitions/subprocess.ts'
import type { SubprocessService } from '../../definitions/subprocess.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'
import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'subprocess-tools'

/** One declared tool parameter (the author form of `definitions/tools.ts`). */
type ToolParameter = ParameterSchemaSpec[string]

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
}

/** The config of this consumer (the built-ins the `run` tool defaults to). */
export interface Config {
  /** Default deadline of a tool call in ms (the provider's own policy still caps it). */
  timeoutMs?: number
  /** Default inline byte cap of a tool call. */
  maxOutputBytes?: number
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SubprocessError('subprocess.invalid-input', `the '${key}' parameter must be a string`, {
      stage: 'subprocess-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read a required string parameter. */
function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined || value.length === 0) {
    throw new SubprocessError('subprocess.invalid-input', `the '${key}' parameter is required and must be a non-empty string`, {
      stage: 'subprocess-tools',
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
    throw new SubprocessError('subprocess.invalid-input', `the '${key}' parameter must be a boolean`, {
      stage: 'subprocess-tools',
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
    throw new SubprocessError('subprocess.invalid-input', `the '${key}' parameter must be an integer`, {
      stage: 'subprocess-tools',
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
    throw new SubprocessError('subprocess.invalid-input', `the '${key}' parameter must be an array of strings`, {
      stage: 'subprocess-tools',
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
    throw new SubprocessError('subprocess.invalid-input', `the '${key}' parameter must be an object of string values`, {
      stage: 'subprocess-tools',
      details: { parameter: key },
    })
  }
  const entries = Object.entries(value as Record<string, unknown>)
  for (const [entryKey, entryValue] of entries) {
    if (typeof entryValue !== 'string') {
      throw new SubprocessError('subprocess.invalid-input', `the '${key}.${entryKey}' parameter must be a string`, {
        stage: 'subprocess-tools',
        details: { parameter: `${key}.${entryKey}` },
      })
    }
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/** The shared command shape of every tool of this plugin. */
const COMMAND_PARAMETERS: ToolParameters = {
  argv: {
    type: 'array',
    items: { type: 'string' },
    description: 'the command as an ARGV ARRAY (preferred): started DIRECTLY, no shell, no splitting; e.g. ["git","status","--short"]',
  },
  command: {
    type: 'string',
    description: 'the command as ONE STRING; only accepted together with shell: true, because the host never splits a string into an argv',
  },
  shell: { type: 'boolean', description: 'explicit shell escape hatch: run <shell> -c <command> (default false)' },
  shellBinary: { type: 'string', description: 'shell binary used when shell: true (default /bin/sh)' },
  cwd: { type: 'string', description: 'working directory of the child (must exist; default: the provider cwd)' },
  env: { type: 'json', description: 'LITERAL environment overrides for the child (never logged)' },
  envRefs: {
    type: 'json',
    description:
      'environment entries resolved at call time: "${cred:NAME}" through the credentials capability, "${env:NAME}" from the process environment; anything else is literal, and a resolved VALUE never appears in the answer or a log',
  },
  stdin: { type: 'string', description: 'text written to the child stdin (then closed)' },
  timeoutMs: { type: 'integer', description: 'deadline in ms; on expiry the WHOLE PROCESS GROUP is signalled (SIGTERM, then SIGKILL)' },
  maxOutputBytes: { type: 'integer', description: 'inline byte cap of stdout and stderr separately; the bytes beyond it go to a SPILL file' },
  spill: { type: 'boolean', description: 'hand output beyond the cap to spill@1 (default true); false keeps the truncated inline answer' },
  label: { type: 'string', description: 'label of the spill file name for capped output (default subprocess-stdout)' },
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  // `ctx.subprocess` is the SEAM: resolved lazily at call time through the
  // definition, so this plugin loads on its own and fails only when a call
  // cannot be served (the core loads the roster in declaration order).
  const subprocess = (): SubprocessService => {
    const service = subprocessOf(ctx as never)
    if (service === undefined) {
      throw new SubprocessError(
        'subprocess.invalid-input',
        'no subprocess@1 provider is loaded: enable a provider plugin (core/subprocess-local) in the roster',
        { stage: 'subprocess-tools' },
      )
    }
    return service
  }

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'subprocess run',
      description:
        'Runs a bounded LOCAL command on the workbench host: argv-based (no shell unless shell:true), with cwd, env/envRefs, stdin, a deadline that kills the whole process group and an inline output cap whose overflow is written to a spill file; exit code, stdout, stderr, byte counts, duration and the spill reference come back as a STRUCTURED result, and a NON-ZERO exit is a normal result, not an error',
      parameters: COMMAND_PARAMETERS,
      execute: async (params) => {
        const input = {
          ...(optionalStringArray(params, 'argv') !== undefined ? { argv: optionalStringArray(params, 'argv')! } : {}),
          ...(optionalString(params, 'command') !== undefined ? { command: optionalString(params, 'command')! } : {}),
          ...(optionalBoolean(params, 'shell') !== undefined ? { shell: optionalBoolean(params, 'shell')! } : {}),
          ...(optionalString(params, 'shellBinary') !== undefined ? { shellBinary: optionalString(params, 'shellBinary')! } : {}),
          ...(optionalString(params, 'cwd') !== undefined ? { cwd: optionalString(params, 'cwd')! } : {}),
          ...(optionalStringRecord(params, 'env') !== undefined ? { env: optionalStringRecord(params, 'env')! } : {}),
          ...(optionalStringRecord(params, 'envRefs') !== undefined ? { envRefs: optionalStringRecord(params, 'envRefs')! } : {}),
          ...(optionalString(params, 'stdin') !== undefined ? { stdin: optionalString(params, 'stdin')! } : {}),
          ...((optionalInteger(params, 'timeoutMs') ?? config.timeoutMs) !== undefined
            ? { timeoutMs: optionalInteger(params, 'timeoutMs') ?? config.timeoutMs }
            : {}),
          ...((optionalInteger(params, 'maxOutputBytes') ?? config.maxOutputBytes) !== undefined
            ? { maxOutputBytes: optionalInteger(params, 'maxOutputBytes') ?? config.maxOutputBytes }
            : {}),
          ...(optionalBoolean(params, 'spill') !== undefined ? { spill: optionalBoolean(params, 'spill')! } : {}),
          ...(optionalString(params, 'label') !== undefined ? { label: optionalString(params, 'label')! } : {}),
        }
        return subprocess().run(input)
      },
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'subprocess policy',
      description:
        'Reports the policy of the loaded subprocess@1 provider (default and maximum deadline, default inline cap, overflow bytes, kill grace, whether shell execution is allowed, default cwd) - never a secret',
      parameters: {},
      execute: () => subprocess().policy(),
      output: { schema: {}, render: renderValue },
    })),

  )
}

export default { name, inject: ['subprocess', 'tools'], apply }

/** The declared tool parameters, exported so a test can assert the contract. */
export { COMMAND_PARAMETERS }
