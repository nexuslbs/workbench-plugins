// plugins/sandbox-tools - the CONSUMER of the sandbox capability (`sandbox@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/sandbox.ts) - the contract, `ctx.sandbox`
//   Provider                            - the policy/enforcement backend
//                                         (`core/sandbox-policy` declarative,
//                                         `core/sandbox-enforce` enforcing)
//   Consumer                            - THIS plugin: the `sandbox ...` tools
//
// It imports the DEFINITION only, so the provider can be swapped with a config
// edit and `npm run check:seam` enforces that direction.
//
// The point of these tools is INSPECTABILITY: the confinement decision of the
// deployment is answerable without writing code, so an operator can see both
// the raw decision and the ACTIVE policy (including, for an enforcing provider,
// the MEASURED mechanism matrix and the gaps).
//
//   `sandbox check`   - decide ONE request (allow-with-constraints | deny)
//   `sandbox policy`  - the active policy + the enforcement matrix of the provider
//   `sandbox run`     - run a command THROUGH an enforcing provider (only when
//                       the loaded provider implements `exec`)
//
// `sandbox check` is a DECISION tool: it never touches the host. It is the tool
// the other capabilities (fs, subprocess, jobs, computer-use, browser-use) use
// as their reference for what a verdict looks like.

import { SandboxError, describeDecision, requireSandbox, sandboxOf } from '../../definitions/sandbox.ts'
import type { SandboxRequest, SandboxService } from '../../definitions/sandbox.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'

export const name = 'sandbox-tools'

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

/** The config of this consumer. */
export interface Config {
  /** Include the active policy in every `sandbox check` answer (default true). */
  reportPolicy?: boolean
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be a string`, {
      stage: 'sandbox-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read a required string parameter. */
function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined || value.length === 0) {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter is required and must be a non-empty string`, {
      stage: 'sandbox-tools',
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
      stage: 'sandbox-tools',
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
      stage: 'sandbox-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional array of strings (a non-string entry is an error). */
function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be an array of strings`, {
      stage: 'sandbox-tools',
      details: { parameter: key },
    })
  }
  return value as string[]
}

/** Read an optional plain object parameter. */
function optionalRecord(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SandboxError('sandbox.invalid-request', `the '${key}' parameter must be an object`, {
      stage: 'sandbox-tools',
      details: { parameter: key },
    })
  }
  return value as Record<string, unknown>
}

/** Read the network intent: `false`/absent = none, `true` = egress, an object = target. */
function optionalNetwork(params: Record<string, unknown>): SandboxRequest['network'] {
  const value = params.network
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as SandboxRequest['network']
  throw new SandboxError('sandbox.invalid-request', "the 'network' parameter must be a boolean or an object", {
    stage: 'sandbox-tools',
    details: { parameter: 'network' },
  })
}

/** Builds the typed request of a `sandbox check` call from its raw parameters. */
export function requestFromParams(params: Record<string, unknown>): SandboxRequest {
  const argv = optionalStringArray(params, 'argv')
  const network = optionalNetwork(params)
  const request: SandboxRequest = { resource: requiredString(params, 'resource') }
  const operation = optionalString(params, 'operation')
  if (operation !== undefined) request.operation = operation
  const target = optionalString(params, 'path')
  if (target !== undefined) request.path = target
  if (argv !== undefined) request.argv = argv
  const shell = optionalBoolean(params, 'shell')
  if (shell !== undefined) request.shell = shell
  const cwd = optionalString(params, 'cwd')
  if (cwd !== undefined) request.cwd = cwd
  const envNames = optionalStringArray(params, 'envNames')
  if (envNames !== undefined) request.envNames = envNames
  if (network !== undefined) request.network = network
  const bytes = optionalInteger(params, 'bytes')
  if (bytes !== undefined) request.bytes = bytes
  const wallTimeMs = optionalInteger(params, 'wallTimeMs')
  if (wallTimeMs !== undefined) request.wallTimeMs = wallTimeMs
  const metadata = optionalRecord(params, 'metadata')
  if (metadata !== undefined) request.metadata = metadata
  return request
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const service = (): SandboxService => requireSandbox(ctx as never, 'enable core/sandbox-policy or core/sandbox-enforce in the roster')
  const reportPolicy = config.reportPolicy !== false

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'sandbox check',
      description:
        'Decides ONE sandbox request and returns the RAW decision (allow-with-constraints or deny with a machine-readable reason) plus the active policy: `resource` is fs | subprocess | jobs | computer-use | browser-use or a custom name, and the request names what the call wants (path, argv, cwd, envNames, network, bytes, wallTimeMs). It never touches the host: it is the decision tool other capabilities call',
      parameters: {
        resource: { type: 'string', required: true, description: 'which capability/domain asks: fs | subprocess | jobs | computer-use | browser-use | <custom>' },
        operation: { type: 'string', description: 'the verb within the resource (read | write | spawn | start | connect | open | act | ...); an fs request without one counts as a WRITE' },
        path: { type: 'string', description: 'filesystem target: the path to read, to write, or the working directory' },
        argv: { type: 'array', items: { type: 'string' }, description: 'the command as an ARGV ARRAY (never a shell string)' },
        shell: { type: 'boolean', description: 'true when the caller intends to run the argv through a shell' },
        cwd: { type: 'string', description: 'working directory of the child' },
        envNames: { type: 'array', items: { type: 'string' }, description: 'environment NAMES the caller wants to pass (names only, never values)' },
        network: { type: 'json', description: 'network intent: false/absent = none, true = egress somewhere, or an object { host, port, protocol, url }' },
        bytes: { type: 'integer', description: 'bytes the call wants to produce/keep (checked against the policy output cap)' },
        wallTimeMs: { type: 'integer', description: 'wall time the call wants (checked against the policy deadline)' },
        approvalGranted: { type: 'boolean', description: 'true when the caller already holds an approval for this call' },
        metadata: { type: 'object', description: 'free-form context, echoed back in the decision' },
      },
      handler: async (params) => {
        const request = requestFromParams(params)
        const approvalGranted = optionalBoolean(params, 'approvalGranted')
        const decision = await service().check(request, approvalGranted === undefined ? {} : { approvalGranted })
        return {
          contract: service().contract,
          provider: service().provider,
          request,
          decision,
          description: describeDecision(decision),
          ...(reportPolicy ? { policy: service().activePolicy() } : {}),
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'sandbox policy',
      description:
        'Reports the ACTIVE sandbox policy of the loaded sandbox@1 provider: the source, the fail-open/closed default, one constraint view per configured resource (mode, read/write roots, env allow-list, network, limits, approval) and - for an enforcing provider - the MEASURED mechanism matrix with the gaps it cannot enforce',
      parameters: {},
      handler: () => {
        const active = service().activePolicy()
        return { contract: service().contract, provider: service().provider, policy: active }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'sandbox run',
      description:
        'Runs a command THROUGH an enforcing sandbox@1 provider: it decides the request first (a deny runs NOTHING and returns the decision) and then starts the command under the mechanisms the provider really has (filesystem/network namespaces where available, rlimits, a filtered env, a pinned cwd, a deadline that kills the process group, an output cap). Only an enforcing provider implements `exec`: a declarative policy provider answers with sandbox.exec-unavailable',
      parameters: {
        argv: { type: 'array', items: { type: 'string' }, required: true, description: 'the command as an ARGV ARRAY (never a shell string)' },
        cwd: { type: 'string', description: 'working directory of the child (default: the policy)' },
        resource: { type: 'string', description: 'which resource the run belongs to (default subprocess)' },
        env: { type: 'object', description: 'LITERAL environment entries for the child; every NAME is checked against the policy allow-list' },
        envNames: { type: 'array', items: { type: 'string' }, description: 'extra environment NAMES resolved from the provider environment (checked against the allow-list)' },
        stdin: { type: 'string', description: 'text written to the child stdin, then closed' },
        timeoutMs: { type: 'integer', description: 'deadline the caller wants (the policy cap still wins)' },
        maxOutputBytes: { type: 'integer', description: 'inline byte cap the caller wants (the policy cap still wins)' },
        approvalGranted: { type: 'boolean', description: 'true when the caller already holds an approval for this call' },
      },
      handler: async (params) => {
        const active = service()
        if (typeof active.exec !== 'function') {
          throw new SandboxError(
            'sandbox.exec-unavailable',
            `the loaded sandbox@1 provider '${active.provider}' decides policy but does not enforce it: enable core/sandbox-enforce to run a command through the sandbox`,
            { stage: 'sandbox-tools', details: { provider: active.provider } },
          )
        }
        return await active.exec({
          argv: optionalStringArray(params, 'argv') ?? [],
          ...(optionalString(params, 'cwd') !== undefined ? { cwd: optionalString(params, 'cwd')! } : {}),
          ...(optionalString(params, 'resource') !== undefined ? { resource: optionalString(params, 'resource')! } : {}),
          ...(optionalRecord(params, 'env') !== undefined ? { env: optionalRecord(params, 'env')! as Record<string, string> } : {}),
          ...(optionalStringArray(params, 'envNames') !== undefined ? { envNames: optionalStringArray(params, 'envNames')! } : {}),
          ...(optionalString(params, 'stdin') !== undefined ? { stdin: optionalString(params, 'stdin')! } : {}),
          ...(optionalInteger(params, 'timeoutMs') !== undefined ? { timeoutMs: optionalInteger(params, 'timeoutMs')! } : {}),
          ...(optionalInteger(params, 'maxOutputBytes') !== undefined ? { maxOutputBytes: optionalInteger(params, 'maxOutputBytes')! } : {}),
          ...(optionalBoolean(params, 'approvalGranted') !== undefined ? { approvalGranted: optionalBoolean(params, 'approvalGranted')! } : {}),
        })
      },
    }),
  )
}

/** True when a `sandbox@1` provider is reachable (used by the interop test). */
export function sandboxAvailable(ctx: unknown): boolean {
  return sandboxOf(ctx as never) !== undefined
}

export default { name, inject: ['sandbox', 'tools'], apply }
