// plugins/sandbox-consumer - a MINIMAL consumer of the `sandbox@1` seam, kept in
// the repository as the interop proof of the contract.
//
// Why it exists: the enforcing providers of this repository are useless unless a
// consumer really ASKS for a decision and HONORS a DENY. The sibling
// capabilities already do it through their structural hooks
// (`definitions/fs.ts` -> `policyFor`, `definitions/subprocess.ts` /
// `core/jobs-local` -> `sandboxOf(ctx).checkCommand`), and this plugin is the
// explicit, inspectable path: `sandbox guarded run` decides a command, then runs
// it through the REAL `subprocess@1` seam ONLY when the decision allowed it.
//
// The rule this plugin demonstrates (requirement R1/R2 of the task): the
// provider DECIDES, the consumer APPLIES. A consumer that cannot enforce a
// constraint must not silently ignore a deny - it either refuses, or it reports
// the gap it ran with. Both branches are visible below.
//
// It imports the DEFINITION only (no cordis import, no provider import), so the
// policy can be swapped with a config edit.

import { SandboxError, describeDecision, sandboxOf } from '../../definitions/sandbox.ts'
import type { SandboxAllow, SandboxConstraints, SandboxDeny, SandboxDecision, SandboxRequest } from '../../definitions/sandbox.ts'
import { subprocessOf } from '../../definitions/subprocess.ts'
import type { SubprocessResult, SubprocessService } from '../../definitions/subprocess.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'

export const name = 'sandbox-consumer'

/** One declared tool parameter (the author form of `definitions/tools.ts`). */
type ToolParameter = ParameterSchemaSpec[string]

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

/** The structural half of the sandbox service a consumer needs (nothing more). */
export interface SandboxPlannerLike {
  check(request: SandboxRequest, options?: { approvalGranted?: boolean }): SandboxDecision | Promise<SandboxDecision>
}

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

/**
 * The outcome of a guarded call. The `honored` field is the point: `deny` means
 * the runner was NOT called, and `no-policy` means the seam was absent and the
 * outcome carries the GAP instead of pretending it was confined.
 */
export type GuardOutcome =
  | { honored: 'allow'; ran: true; policy: 'sandbox@1'; decision: SandboxAllow; description: string; result: unknown }
  | { honored: 'deny'; ran: false; policy: 'sandbox@1'; decision: SandboxDeny; description: string; reason: string }
  | { honored: 'no-policy'; ran: boolean; policy: 'none'; gap: string; result?: unknown }

/** Options of a guarded call. */
export interface GuardOptions {
  /** An approval the caller already holds (passed into the decision). */
  approvalGranted?: boolean
  /**
   * What to do when NO `sandbox@1` provider is loaded: refuse (fail-closed, the
   * default) or run anyway and REPORT the gap. A consumer must never do the
   * second one silently.
   */
  allowWithoutPolicy?: boolean
}

/**
 * Decides `request` and runs `run` ONLY when the decision allowed it.
 *
 * Fails closed twice:
 *   * no provider loaded and `allowWithoutPolicy` is not set -> the runner is
 *     never called and the outcome says the seam was absent;
 *   * a DENY -> the runner is never called, the raw decision is returned.
 */
export async function guardRequest(
  request: SandboxRequest,
  sandbox: SandboxPlannerLike | undefined,
  run: (constraints: SandboxConstraints | undefined) => Promise<unknown>,
  options: GuardOptions = {},
): Promise<GuardOutcome> {
  if (sandbox === undefined) {
    if (options.allowWithoutPolicy !== true) {
      return {
        honored: 'no-policy',
        ran: false,
        policy: 'none',
        gap: 'no sandbox@1 provider is loaded: the call was REFUSED (fail-closed). Mount core/sandbox-policy (declarative) or core/sandbox-enforce (enforcing), or set allowWithoutPolicy to run and report the gap.',
      }
    }
    return {
      honored: 'no-policy',
      ran: true,
      policy: 'none',
      gap: 'no sandbox@1 provider is loaded: the call ran UNCONFINED (reported, never silent).',
      result: await run(undefined),
    }
  }

  const decision = await sandbox.check(request, options.approvalGranted === undefined ? {} : { approvalGranted: options.approvalGranted })
  if (!decision.allowed) {
    return {
      honored: 'deny',
      ran: false,
      policy: 'sandbox@1',
      decision,
      description: describeDecision(decision),
      reason: decision.reason,
    }
  }
  return {
    honored: 'allow',
    ran: true,
    policy: 'sandbox@1',
    decision,
    description: describeDecision(decision),
    result: await run(decision.constraints),
  }
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be a string`, {
      stage: 'sandbox-consumer',
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
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be a boolean`, {
      stage: 'sandbox-consumer',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional integer parameter (a float is an error, never a truncation). */
function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be an integer`, {
      stage: 'sandbox-consumer',
      details: { parameter: key },
    })
  }
  return value
}

/** Read a required array-of-strings parameter. */
/** Read the network intent: false/absent = none, true = egress, an object = a target. */
function optionalNetwork(params: Record<string, unknown>): SandboxRequest['network'] {
  const value = params.network
  if (value === undefined || value === false) return undefined
  if (value === true) return true
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as SandboxRequest['network']
  throw new SandboxError('sandbox.invalid-request', "the 'network' parameter must be a boolean or an object", {
    stage: 'sandbox-consumer',
    details: { parameter: 'network' },
  })
}

/** Read an optional array of strings (environment NAMES only, never values). */
function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be an array of strings`, {
      stage: 'sandbox-consumer',
      details: { parameter: key },
    })
  }
  return value as string[]
}
function requiredArgv(params: Record<string, unknown>): string[] {
  const value = params.argv
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== 'string')) {
    throw new SandboxError('sandbox.invalid-request', "the 'argv' parameter is required and must be a non-empty array of strings", {
      stage: 'sandbox-consumer',
      details: { parameter: 'argv' },
    })
  }
  return value as string[]
}

/** The subprocess seam, or a structured error naming the missing provider. */
function requireLocalRun(ctx: PluginContext): SubprocessService {
  const service = subprocessOf(ctx as never)
  if (service === undefined) {
    throw new SandboxError('sandbox.missing-service', 'no subprocess@1 provider is loaded: enable core/subprocess-local in the roster', {
      stage: 'sandbox-consumer',
      code: 'missing-service',
      details: { service: 'subprocess' },
    })
  }
  return service
}

export function apply(ctx: PluginContext): void {
  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'sandbox guarded run',
      description:
        'A GUARDED command: it asks the loaded sandbox@1 provider for a decision and runs the argv through the subprocess@1 seam ONLY when the decision allowed it. A DENY runs NOTHING and returns the raw decision with its machine-readable reason; without a provider loaded the call is refused (fail-closed) and the answer reports the missing seam',
      parameters: {
        argv: { type: 'array', items: { type: 'string' }, required: true, description: 'the command as an ARGV ARRAY (never a shell string)' },
        cwd: { type: 'string', description: 'working directory of the child' },
        resource: { type: 'string', description: 'which resource the command belongs to (default subprocess)' },
        network: { type: 'json', description: 'network intent of the command: false/absent = none, true = egress, or an object { host, port, protocol, url } (checked against the policy allow-list)' },
        envNames: { type: 'array', items: { type: 'string' }, description: 'environment NAMES the command needs (checked against the allow-list; names only, never values)' },
        timeoutMs: { type: 'integer', description: 'deadline the caller wants (the policy cap still wins)' },
        maxOutputBytes: { type: 'integer', description: 'inline byte cap the caller wants (the policy cap still wins)' },
        approvalGranted: { type: 'boolean', description: 'true when the caller already holds an approval for this call' },
        allowWithoutPolicy: { type: 'boolean', description: 'run anyway when NO sandbox@1 provider is loaded (the answer then reports the gap; default false = refuse)' },
      },
      handler: async (params) => {
        const argv = requiredArgv(params)
        const request: SandboxRequest = { resource: optionalString(params, 'resource') ?? 'subprocess', operation: 'spawn', argv }
        const cwd = optionalString(params, 'cwd')
        if (cwd !== undefined) request.cwd = cwd
        const network = optionalNetwork(params)
        if (network !== undefined) request.network = network
        const envNames = optionalStringArray(params, 'envNames')
        if (envNames !== undefined) request.envNames = envNames
        const outcome = await guardRequest(
          request,
          sandboxOf(ctx as never) as SandboxPlannerLike | undefined,
          async (constraints) => (await requireLocalRun(ctx).run({
            argv,
            ...(cwd !== undefined ? { cwd } : {}),
            ...(capOf(optionalInteger(params, 'timeoutMs'), constraints?.limits.wallTimeMs) !== undefined
              ? { timeoutMs: capOf(optionalInteger(params, 'timeoutMs'), constraints?.limits.wallTimeMs)! }
              : {}),
            ...(capOf(optionalInteger(params, 'maxOutputBytes'), constraints?.limits.maxOutputBytes) !== undefined
              ? { maxOutputBytes: capOf(optionalInteger(params, 'maxOutputBytes'), constraints?.limits.maxOutputBytes)! }
              : {}),
          })) as SubprocessResult,
          {
            ...(optionalBoolean(params, 'approvalGranted') !== undefined ? { approvalGranted: optionalBoolean(params, 'approvalGranted')! } : {}),
            ...(optionalBoolean(params, 'allowWithoutPolicy') !== undefined ? { allowWithoutPolicy: optionalBoolean(params, 'allowWithoutPolicy')! } : {}),
          },
        )
        if (outcome.honored === 'allow') {
          const result = outcome.result as SubprocessResult
          return { ...outcome, result: { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, note: result.note } }
        }
        return outcome
      },
    }),
  )
}

/** The smaller of what the caller asked and what the policy grants. */
function capOf(requested: number | undefined, granted: number | undefined): number | undefined {
  if (requested === undefined) return granted
  if (granted === undefined) return requested
  return Math.min(requested, granted)
}

export default { name, inject: ['sandbox', 'tools', 'subprocess'], apply }
