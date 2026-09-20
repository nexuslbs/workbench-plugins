// core/sandbox-enforce - the `sandbox@1` provider `local-os`: the provider that
// does not only DECIDE, it also RUNS local work under the decision.
//
// The declarative sibling (`core/sandbox-policy`) can only constrain what a
// consumer honors. This one adds a real local runner: `exec()` starts the
// command with
//
//   * an OS-level filesystem/network confinement when the host offers one
//     (`bwrap` mount/pid/net namespaces, else a network namespace through
//     `unshare -n`),
//   * resource ceilings at the kernel (`prlimit` RLIMIT_CPU / RLIMIT_AS /
//     RLIMIT_NOFILE, else the `/bin/sh` `ulimit` prologue that `exec`s the real
//     argv unchanged),
//   * a privilege drop (`setpriv --reuid/--regid --no-new-privs`) when the
//     policy asks for one,
//   * a filtered environment (the policy's NAME allow-list only), a pinned `cwd`,
//   * a deadline that signals the whole process GROUP (SIGTERM, then SIGKILL),
//     and inline byte caps on both streams.
//
// WHICH mechanism is used is MEASURED at apply time (`probeMechanisms`) and
// reported per constraint (`enforcement()`): a constraint the host cannot
// enforce is reported as a GAP in plain language, never as isolation that is not
// there. That honesty is the point of this provider, so no gate may claim more.
//
// It reaches host processes, so its manifest declares `"execution": "host"` and
// the `sandbox@1` policy, and `apply` verifies that declaration.
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  SANDBOX,
  SANDBOX_CONTRACT,
  SandboxError,
  buildEnforcementPlan,
  constraintView,
  evaluateSandbox,
  filterSandboxEnv,
  normalizeSandboxPolicyConfig,
  policyViews,
  sandboxEnforcement,
} from '../../definitions/sandbox.ts'
import type {
  NormalizedSandboxPolicy,
  SandboxActivePolicy,
  SandboxAllow,
  SandboxCommandVerdict,
  SandboxConstraints,
  SandboxConstraintEnforcement,
  SandboxDecision,
  SandboxDecisionOptions,
  SandboxDeny,
  SandboxEnforcement,
  SandboxExecInput,
  SandboxExecResult,
  SandboxMechanism,
  SandboxMechanismAvailability,
  SandboxPolicyConfig,
  SandboxResource,
  SandboxService,
} from '../../definitions/sandbox.ts'
import { assertPolicyDeclared, messageOf, provideService } from '../../definitions/support.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'sandbox-enforce'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'local-os'

export const contract = SANDBOX_CONTRACT

/** Grace between SIGTERM and SIGKILL of a timed-out process group. */
const KILL_GRACE_MS = 500

/** The enforcing provider adds the same policy config, plus runner knobs. */
export interface SandboxEnforceConfig extends SandboxPolicyConfig {
  /** Shell used by the `ulimit` fallback and by the probe (default `/bin/sh`). */
  shell?: string
  /** Deadline used when neither the call nor the policy names one (default 30 s). */
  timeoutMs?: number
  /** Inline byte cap used when neither the call nor the policy names one. */
  maxOutputBytes?: number
  /** Run the mechanism probe at apply time (default true; tests inject one). */
  probe?: boolean
}

// ---------------------------------------------------------------------------
// The mechanism probe: what THIS host can really enforce, with evidence.
// ---------------------------------------------------------------------------

export interface ProbeReport {
  availability: SandboxMechanismAvailability
  /** One human line per probe, kept verbatim for the report. */
  evidence: Record<string, string>
  /** Raw stdout/stderr of the probe script (diagnostics). */
  output: string
}

/**
 * The probe script. Every line is `key=value`, so the parse stays trivial and
 * the RAW output can be reported as evidence: presence of a binary is checked
 * AND the mechanism is exercised on `/bin/true` (a tool that is installed but
 * cannot create a namespace is not available).
 */
export const PROBE_SCRIPT = [
  'for b in bwrap unshare prlimit setpriv timeout; do',
  '  p=$(command -v "$b" 2>/dev/null || true)',
  '  printf "bin.%s=%s\\n" "$b" "${p:-}"',
  'done',
  'if command -v unshare >/dev/null 2>&1 && unshare -n /bin/true >/dev/null 2>&1; then printf "probe.unshareNet=ok\\n"; else printf "probe.unshareNet=no\\n"; fi',
  'if command -v prlimit >/dev/null 2>&1 && prlimit --cpu=1 --as=268435456 --nofile=64 -- /bin/true >/dev/null 2>&1; then printf "probe.prlimit=ok\\n"; else printf "probe.prlimit=no\\n"; fi',
  'if /bin/sh -c \'ulimit -t 1 2>/dev/null; ulimit -v 262144 2>/dev/null; ulimit -n 64 2>/dev/null; exec /bin/true\' >/dev/null 2>&1; then printf "probe.shUlimit=ok\\n"; else printf "probe.shUlimit=no\\n"; fi',
  'if command -v setpriv >/dev/null 2>&1 && setpriv --no-new-privs /bin/true >/dev/null 2>&1; then printf "probe.setpriv=ok\\n"; else printf "probe.setpriv=no\\n"; fi',
  'if command -v bwrap >/dev/null 2>&1 && bwrap --dev-bind / / -- /bin/true >/dev/null 2>&1; then printf "probe.bwrap=ok\\n"; else printf "probe.bwrap=no\\n"; fi',
  'printf "probe.uid=%s\\n" "$(id -u)"',
].join('\n')

/** Parses `key=value` lines of the probe output. */
export function parseProbe(output: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of output.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (key.length > 0) values[key] = value
  }
  return values
}

/** Probes the host SYNCHRONOUSLY (one short shell run) and reports the raw bytes. */
export function probeMechanisms(shell = '/bin/sh'): ProbeReport {
  const result = spawnSync(shell, ['-c', PROBE_SCRIPT], { encoding: 'utf8', timeout: 20000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const values = parseProbe(result.stdout ?? '')
  const availability: SandboxMechanismAvailability = {
    bwrap: values['probe.bwrap'] === 'ok',
    unshareNet: values['probe.unshareNet'] === 'ok',
    prlimit: values['probe.prlimit'] === 'ok',
    shUlimit: values['probe.shUlimit'] === 'ok',
    setpriv: values['probe.setpriv'] === 'ok',
  }
  const evidence: Record<string, string> = {}
  for (const key of ['bwrap', 'unshare', 'prlimit', 'setpriv', 'timeout'] as const) {
    evidence[`bin.${key}`] = values[`bin.${key}`] === undefined || values[`bin.${key}`].length === 0 ? 'MISSING' : values[`bin.${key}`]
  }
  evidence['unshare -n /bin/true'] = values['probe.unshareNet'] === 'ok' ? 'exit 0' : 'unavailable or failing'
  evidence['prlimit --cpu=1 --as=268435456 --nofile=64 -- /bin/true'] = values['probe.prlimit'] === 'ok' ? 'exit 0' : 'unavailable or failing'
  evidence['sh -c "ulimit -t/-v/-n; exec"'] = values['probe.shUlimit'] === 'ok' ? 'exit 0' : 'unavailable or failing'
  evidence['setpriv --no-new-privs /bin/true'] = values['probe.setpriv'] === 'ok' ? 'exit 0' : 'unavailable or failing'
  evidence['bwrap --dev-bind / / -- /bin/true'] = values['probe.bwrap'] === 'ok' ? 'exit 0' : 'unavailable or failing'
  evidence['uid'] = values['probe.uid'] ?? 'unknown'
  return { availability, evidence, output: output.trim() }
}

/** The mechanisms this provider may use, each with its MEASURED availability. */
export function mechanismReport(report: ProbeReport, provider = providerId): SandboxMechanism[] {
  const a = report.availability
  const e = report.evidence
  return [
    {
      id: 'bwrap',
      kind: 'namespace',
      available: a.bwrap,
      evidence: e['bwrap --dev-bind / / -- /bin/true'] ?? 'not probed',
      note: 'mount/pid/net namespaces: read-only bind of / plus a writable bind of every granted write root',
    },
    {
      id: 'unshare-net',
      kind: 'network',
      available: a.unshareNet,
      evidence: e['unshare -n /bin/true'] ?? 'not probed',
      note: 'network namespace only: denies egress without confining the filesystem',
    },
    {
      id: 'prlimit',
      kind: 'rlimit',
      available: a.prlimit,
      evidence: e['prlimit --cpu=1 --as=268435456 --nofile=64 -- /bin/true'] ?? 'not probed',
      note: 'kernel RLIMIT_CPU / RLIMIT_AS / RLIMIT_NOFILE before the command starts',
    },
    {
      id: 'sh-ulimit',
      kind: 'rlimit',
      available: a.shUlimit,
      evidence: e['sh -c "ulimit -t/-v/-n; exec"'] ?? 'not probed',
      note: 'fallback rlimits: a shell sets ulimit and execs the real argv unchanged',
    },
    {
      id: 'setpriv',
      kind: 'process',
      available: a.setpriv,
      evidence: e['setpriv --no-new-privs /bin/true'] ?? 'not probed',
      note: 'privilege drop: only used when the policy names a user/group',
    },
    {
      id: 'timeout-pgroup',
      kind: 'limit',
      available: true,
      evidence: 'applied by this provider on every run (detached process group + SIGTERM, then SIGKILL)',
      note: 'wall-time ceiling; a child that ignores SIGTERM is SIGKILLed',
    },
    {
      id: 'output-cap',
      kind: 'limit',
      available: true,
      evidence: 'applied by this provider on every run (byte counters, the streams are truncated in place)',
      note: 'inline byte cap of stdout and stderr',
    },
    {
      id: 'env-allow-list',
      kind: 'env',
      available: true,
      evidence: 'applied by this provider on every run (only the NAME allow-list of the policy reaches the child)',
    },
    {
      id: 'cwd-pin',
      kind: 'fs',
      available: true,
      evidence: 'applied by this provider on every run (spawn cwd, plus --chdir under bwrap)',
    },
    {
      id: 'decision-gate',
      kind: 'approval',
      available: true,
      evidence: 'applied by this provider before every run (a deny or a missing approval runs nothing)',
    },
  ]
}

/** The MEASURED enforcement matrix of this host, one row per constraint. */
export function enforcementRows(report: ProbeReport): SandboxConstraintEnforcement[] {
  const a = report.availability
  return [
    {
      constraint: 'fs.read',
      mechanism: 'decision-gate',
      enforced: 'yes',
      note: 'a read outside the granted read roots is DENIED before anything is started (no kernel-level read trap exists here)',
    },
    {
      constraint: 'fs.write',
      mechanism: a.bwrap ? 'bwrap' : 'decision-gate',
      enforced: a.bwrap ? 'yes' : 'partial',
      note: a.bwrap
        ? 'mount namespace: only the granted write roots are bound writable, everything else is the read-only bind of /'
        : 'a path outside the granted write roots is DENIED before the run; a process that reaches the filesystem by another route is not trapped (no mount namespace here)',
    },
    {
      constraint: 'network',
      mechanism: a.bwrap && a.unshareNet ? 'bwrap' : a.unshareNet ? 'unshare-net' : null,
      enforced: a.bwrap || a.unshareNet ? 'yes' : 'no',
      note:
        a.bwrap || a.unshareNet
          ? 'a network namespace with no interface: egress is impossible. A host ALLOW-LIST cannot be expressed by a namespace, so `allow-list` is a decision-level rule only'
          : 'no network namespace mechanism is available: egress denial is DECISION-level only and is NOT enforced',
    },
    {
      constraint: 'env',
      mechanism: 'env-allow-list',
      enforced: 'yes',
      note: 'the child inherits only the NAME allow-list of the policy (plus the literal entries the call passes, filtered too)',
    },
    {
      constraint: 'cpu',
      mechanism: a.prlimit ? 'prlimit' : a.shUlimit ? 'sh-ulimit' : null,
      enforced: a.prlimit || a.shUlimit ? 'yes' : 'no',
      note: a.prlimit ? 'RLIMIT_CPU' : a.shUlimit ? 'ulimit -t in the shell prologue' : 'no rlimit mechanism is available',
    },
    {
      constraint: 'memory',
      mechanism: a.prlimit ? 'prlimit' : a.shUlimit ? 'sh-ulimit' : null,
      enforced: a.prlimit || a.shUlimit ? 'partial' : 'no',
      note: a.prlimit ? 'RLIMIT_AS (address space, not RSS)' : a.shUlimit ? 'ulimit -v (address space)' : 'no rlimit mechanism is available',
    },
    {
      constraint: 'nofile',
      mechanism: a.prlimit ? 'prlimit' : a.shUlimit ? 'sh-ulimit' : null,
      enforced: a.prlimit || a.shUlimit ? 'yes' : 'no',
      note: a.prlimit ? 'RLIMIT_NOFILE' : a.shUlimit ? 'ulimit -n' : 'no rlimit mechanism is available',
    },
    {
      constraint: 'processes',
      mechanism: a.prlimit ? 'prlimit' : a.shUlimit ? 'sh-ulimit' : null,
      enforced: a.prlimit || a.shUlimit ? 'yes' : 'no',
      note: a.prlimit ? 'RLIMIT_NPROC (when the policy names it)' : a.shUlimit ? 'ulimit -u' : 'no rlimit mechanism is available',
    },
    {
      constraint: 'wall-time',
      mechanism: 'timeout-pgroup',
      enforced: 'yes',
      note: 'the whole process group is signalled on expiry (SIGTERM, then SIGKILL after the grace)',
    },
    {
      constraint: 'output',
      mechanism: 'output-cap',
      enforced: 'yes',
      note: 'both streams are truncated at the inline cap and the byte counters are reported',
    },
    {
      constraint: 'privilege',
      mechanism: a.setpriv ? 'setpriv' : null,
      enforced: a.setpriv ? 'yes' : 'no',
      note: a.setpriv ? 'used only when the policy names a user/group (--reuid/--regid --no-new-privs)' : 'setpriv is unavailable: a requested privilege drop is NOT applied',
    },
    {
      constraint: 'approval',
      mechanism: 'decision-gate',
      enforced: 'yes',
      note: 'a policy with approvalRequired runs nothing unless the call carries approvalGranted',
    },
  ]
}

/** Pulls the allow-listed NAMES out of an environment map (values stay verbatim). */
export function pickEnv(env: Record<string, string | undefined>, allow: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    out[key] = value
  }
  return filterSandboxEnv(out, allow)
}

/** Clamps a requested ceiling against the policy cap (the policy always wins). */
export function clampCeiling(requested: number | undefined, cap: number | undefined, fallback: number): number {
  const values: number[] = []
  if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) values.push(requested)
  if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) values.push(cap)
  return values.length === 0 ? fallback : Math.min(...values)
}

// ---------------------------------------------------------------------------
// The service.
// ---------------------------------------------------------------------------

/** Appends a chunk, keeping at most `cap` bytes and counting the real total. */
function appendCapped(chunks: Buffer[], chunk: Buffer, cap: number, total: number): { total: number; truncated: boolean } {
  const next = total + chunk.length
  const room = cap - total
  if (room > 0) chunks.push(room >= chunk.length ? chunk : chunk.subarray(0, room))
  return { total: next, truncated: next > cap }
}

/**
 * Builds the enforcing provider. `report` is injected so a test can drive the
 * plan against a fake host (bwrap/unshare cannot be exercised where they are not
 * installed) while the real report comes from `probeMechanisms`.
 */
export function createSandboxEnforceService(
  config: SandboxEnforceConfig = {},
  report: ProbeReport = probeMechanisms(config.shell ?? '/bin/sh'),
): SandboxService {
  const policy = normalizeSandboxPolicyConfig(config, 'sandbox-enforce')
  const mechanisms = mechanismReport(report)
  const rows = enforcementRows(report)
  const view = (resource: SandboxResource): SandboxConstraints => constraintView(policy, resource)
  const enforcement = (): SandboxEnforcement => sandboxEnforcement({ provider: providerId, mechanisms, constraints: rows })

  const decide = (request: SandboxRequestLike, options: SandboxDecisionOptions = {}): SandboxDecision =>
    evaluateSandbox(request, view(request.resource), {
      unconfigured: policy.unconfigured,
      ...(options.approvalGranted === undefined ? {} : { approvalGranted: options.approvalGranted }),
    })

  const deniedRun = (decision: SandboxDeny, argv: readonly string[]): SandboxExecResult => ({
    allowed: false,
    decision,
    effectiveArgv: argv,
    mechanisms: [],
    enforcement: enforcement(),
    exitCode: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    durationMs: 0,
    timedOut: false,
    killed: false,
    truncated: false,
    note: `nothing was started: ${decision.reason} - ${decision.message}`,
  })

  return {
    contract: SANDBOX_CONTRACT,
    provider: providerId,

    check(request, options = {}) {
      return decide(request, options)
    },

    policyFor(resource) {
      return view(resource)
    },

    activePolicy(): SandboxActivePolicy {
      const views = policyViews(policy)
      const defaults = views[views.length - 1] ?? constraintView(policy, 'defaults')
      return {
        contract: SANDBOX_CONTRACT,
        provider: providerId,
        source: policy.source,
        unconfigured: policy.unconfigured,
        mode: defaults.mode,
        approvalRequired: policy.approvalRequired,
        resources: views,
        enforcement: enforcement(),
      }
    },

    enforcement,

    checkCommand(plan: { argv: readonly string[]; shell?: boolean; cwd?: string }): SandboxCommandVerdict {
      const decision = decide({
        resource: 'subprocess',
        operation: 'spawn',
        argv: plan.argv,
        ...(plan.shell === undefined ? {} : { shell: plan.shell }),
        ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }),
      })
      return decision.allowed
        ? { allowed: true, decision }
        : { allowed: false, reason: decision.message, decision }
    },

    async exec(input: SandboxExecInput): Promise<SandboxExecResult> {
      if (!Array.isArray(input?.argv) || input.argv.length === 0) {
        throw new SandboxError('sandbox.invalid-request', 'sandbox exec needs a non-empty argv array', {
          stage: 'sandbox-enforce.exec',
        })
      }
      const resource: SandboxResource = input.resource ?? 'subprocess'
      const envNames = Array.isArray(input.envNames) ? input.envNames : []
      const decision = decide(
        {
          resource,
          operation: 'exec',
          argv: input.argv,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
          ...(envNames.length === 0 ? {} : { envNames }),
        },
        input.approvalGranted === undefined ? {} : { approvalGranted: input.approvalGranted },
      )
      if (!decision.allowed) return deniedRun(decision, input.argv)
      const allowed: SandboxAllow = decision

      const constraints = allowed.constraints
      const env = { ...pickEnv(process.env, constraints.env), ...filterSandboxEnv(input.env ?? {}, constraints.env) }
      // Every allowed NAME the caller asked for is resolved from the provider
      // environment; a name the decision did not allow never reaches this point.
      for (const name of envNames) {
        const value = process.env[name]
        if (value !== undefined) env[name] = value
      }
      const plan = buildEnforcementPlan({
        argv: input.argv,
        ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        env,
        constraints,
        availability: report.availability,
      })
      const wallTimeMs = clampCeiling(input.timeoutMs, constraints.limits.wallTimeMs, config.timeoutMs ?? 30000)
      const maxOutputBytes = clampCeiling(input.maxOutputBytes, constraints.limits.maxOutputBytes, config.maxOutputBytes ?? 65536)

      return await new Promise<SandboxExecResult>((resolve) => {
        const started = Date.now()
        let stdoutBytes = 0
        let stderrBytes = 0
        let truncated = false
        let timedOut = false
        let killed = false
        const outChunks: Buffer[] = []
        const errChunks: Buffer[] = []

        const child = spawn(plan.argv[0] as string, plan.argv.slice(1) as string[], {
          cwd: plan.cwd,
          env: plan.env,
          detached: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })

        const killGroup = (signal: NodeJS.Signals): void => {
          if (child.pid === undefined) return
          killed = true
          try {
            process.kill(-child.pid, signal)
          } catch {
            try {
              child.kill(signal)
            } catch {
              // already gone
            }
          }
        }

        const timer = setTimeout(() => {
          timedOut = true
          killGroup('SIGTERM')
          setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref()
        }, wallTimeMs)

        child.stdout?.on('data', (chunk: Buffer) => {
          const next = appendCapped(outChunks, chunk, maxOutputBytes, stdoutBytes)
          stdoutBytes = next.total
          truncated = truncated || next.truncated
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          const next = appendCapped(errChunks, chunk, maxOutputBytes, stderrBytes)
          stderrBytes = next.total
          truncated = truncated || next.truncated
        })
        child.on('error', (error: Error) => {
          clearTimeout(timer)
          resolve({
            allowed: true,
            decision: allowed,
            effectiveArgv: plan.argv,
            mechanisms: plan.mechanisms,
            enforcement: enforcement(),
            exitCode: null,
            signal: null,
            stdout: Buffer.concat(outChunks).toString('utf8'),
            stderr: Buffer.concat(errChunks).toString('utf8'),
            stdoutBytes,
            stderrBytes,
            durationMs: Date.now() - started,
            timedOut,
            killed,
            truncated,
            note: `the command could not be started: ${messageOf(error)}`,
          })
        })
        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer)
          const notes: string[] = []
          if (timedOut) notes.push(`the deadline of ${wallTimeMs}ms expired and the process group was signalled`)
          if (truncated) notes.push(`a stream was truncated at the inline cap of ${maxOutputBytes} bytes`)
          for (const gap of plan.gaps) notes.push(`NOT enforced: ${gap}`)
          resolve({
            allowed: true,
            decision: allowed,
            effectiveArgv: plan.argv,
            mechanisms: plan.mechanisms,
            enforcement: enforcement(),
            exitCode: code,
            signal,
            stdout: Buffer.concat(outChunks).toString('utf8'),
            stderr: Buffer.concat(errChunks).toString('utf8'),
            stdoutBytes,
            stderrBytes,
            durationMs: Date.now() - started,
            timedOut,
            killed,
            truncated,
            ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
          })
        })
        child.stdin?.on('error', () => undefined)
        child.stdin?.end(input.stdin ?? '')
      })
    },
  }
}

/** The request shape `decide` accepts (the definition's `SandboxRequest`). */
type SandboxRequestLike = Parameters<typeof evaluateSandbox>[0]

/** Probes the host and builds the enforcing provider (the testable entry). */
export function createSandboxEnforce(config: SandboxEnforceConfig = {}): SandboxService {
  return createSandboxEnforceService(config, probeMechanisms(config.shell ?? '/bin/sh'))
}

/**
 * Registers the enforcing sandbox provider. The manifest gate runs first: a
 * plugin that starts host processes without declaring `"execution": "host"` and
 * the `sandbox@1` policy in its own manifest does not load at all.
 */
export function apply(ctx: ServiceContext, config: SandboxEnforceConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [SANDBOX] })
  provideService(ctx, SANDBOX, createSandboxEnforce(config))
}

export default { name, inject: [], apply }
