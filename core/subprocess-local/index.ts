// core/subprocess-local - the `subprocess@1` PROVIDER: bounded LOCAL execution.
//
// It is the ONLY seam of this repository that starts an arbitrary LOCAL process
// without a transport. Everything it does is bounded:
//
//   * the command is an ARGV ARRAY, handed to the OS directly (no host shell, no
//     word splitting, no globbing); the single-shell escape hatch is an explicit
//     `shell: true` and the deployment can forbid it (`allowShell: false`);
//   * a deadline kills the whole process GROUP (SIGTERM, then SIGKILL after the
//     grace), so a `sh -c "sleep 30 & wait"` leaves no orphan behind;
//   * stdout/stderr are STREAMED to the caller's optional callbacks, capped
//     INLINE, and the bytes beyond the cap are handed to the `spill@1` seam
//     instead of being dropped;
//   * a NON-ZERO exit is a normal result: `run` resolves with the exit code, the
//     output and a human note. Only a real failure (spawn, unresolved reference,
//     sandbox refusal) is a structured `SubprocessError`.
//
// Environment references are resolved through the DEFINITION helper
// (`resolveEnvRefs`): `${cred:NAME}` goes through `credentials@1`, `${env:NAME}`
// through the process environment, anything else is literal. A value that came
// from a credential is masked in the display form AND in the returned output, so
// a secret never reaches a log, an error or a tool answer.
//
// The OPTIONAL sandbox extension point (requirement R11) is honoured here: when a
// `sandbox@1` provider is present in the context, its `checkCommand` runs BEFORE
// the process is started and its refusal is a structured error. No dependency:
// `sandboxOf(ctx)` returns undefined when the deployment has none.
import {
  classifyEnvRef,
  describeResult,
  displayCommand,
  normalizeSubprocessConfig,
  planSubprocess,
  resolveEnvRefs,
  sandboxOf,
  SUBPROCESS,
  SUBPROCESS_CONTRACT,
  SubprocessError,
} from '../../definitions/subprocess.ts'
import type {
  NormalizedSubprocessConfig,
  SubprocessConfig,
  SubprocessPlan,
  SubprocessPolicy,
  SubprocessResult,
  SubprocessRunInput,
  SubprocessService,
} from '../../definitions/subprocess.ts'
import { spillOf } from '../../definitions/spill.ts'
import type { SpillRef } from '../../definitions/spill.ts'
import { runManaged } from '../../lib/process.ts'
import type { ManagedRunOutcome } from '../../lib/process.ts'
import { assertPolicyDeclared, provideService } from '../../definitions/support.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'subprocess-local'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'local-process'

export const contract = SUBPROCESS_CONTRACT

/** Normalises a subprocess config (the testable entry point of the provider). */
export function validateSubprocessConfig(config: SubprocessConfig = {}, processCwd = process.cwd()): NormalizedSubprocessConfig {
  return normalizeSubprocessConfig(config, processCwd)
}

/**
 * Hands the output beyond the inline cap to the `spill@1` seam, so a capped
 * answer never loses bytes. The payload keeps the first `hardCap` bytes of each
 * stream plus a header naming the command and how much was observed - a caller
 * can page the rest with `spill read`. No spill provider loaded: nothing is
 * written and the result stays `truncated` (the note says so).
 */
async function spillOutput(
  ctx: ServiceContext,
  plan: SubprocessPlan,
  outcome: ManagedRunOutcome,
  mask: (text: string) => string,
  display: string,
): Promise<SpillRef | undefined> {
  const spill = spillOf(ctx)
  if (spill === undefined) return undefined
  const fullStdout = mask(outcome.overflow.stdout ?? outcome.stdout)
  const fullStderr = mask(outcome.overflow.stderr ?? outcome.stderr)
  const payload = [
    '# subprocess output spill',
    `# command: ${display}`,
    `# exit: ${outcome.exitCode === null ? `signal ${outcome.signal ?? 'unknown'}` : String(outcome.exitCode)}`,
    `# stdout: ${outcome.stdoutBytes} bytes observed, ${Buffer.byteLength(fullStdout, 'utf8')} kept below`,
    `# stderr: ${outcome.stderrBytes} bytes observed, ${Buffer.byteLength(fullStderr, 'utf8')} kept below`,
    '',
    '===== stdout =====',
    fullStdout,
    '',
    '===== stderr =====',
    fullStderr,
    '',
  ].join('\n')
  return spill.write({ content: payload, label: plan.label, source: 'core/subprocess-local' })
}

/**
 * Builds the service of this provider. `ctx` is only used for the OPTIONAL
 * capabilities this provider cooperates with (the credentials seam for
 * `${cred:...}`, the spill seam for the overflow, the sandbox handle when one is
 * loaded); a bare object works, which keeps the service unit-testable without a
 * cordis context.
 */
export function createSubprocessService(config: SubprocessConfig = {}, ctx: ServiceContext = {}): SubprocessService {
  const cfg = validateSubprocessConfig(config)

  const service: SubprocessService = {
    async run(input: SubprocessRunInput): Promise<SubprocessResult> {
      const plan = planSubprocess(input, cfg)

      const secrets: string[] = []
      let refEnv: Record<string, string> = {}
      if (Object.keys(plan.envRefs).length > 0) {
        refEnv = await resolveEnvRefs(ctx, plan.envRefs)
        for (const [key, raw] of Object.entries(plan.envRefs)) {
          if (classifyEnvRef(raw).kind !== 'credential') continue
          const value = refEnv[key]
          if (typeof value === 'string' && value.length > 0) secrets.push(value)
        }
      }

      // OPTIONAL sandbox extension point: when a sandbox@1 provider is loaded it
      // may refuse the command BEFORE anything is started. Never a dependency.
      const sandbox = sandboxOf(ctx)
      if (sandbox?.checkCommand !== undefined) {
        const verdict = await sandbox.checkCommand({ argv: plan.argv, shell: plan.shell, cwd: plan.cwd })
        if (verdict !== undefined && verdict.allowed === false) {
          throw new SubprocessError(
            'subprocess.sandbox-denied',
            `the sandbox of this deployment refused the command${verdict.reason === undefined ? '' : `: ${verdict.reason}`}`,
            { stage: 'subprocess.sandbox', details: { shell: plan.shell } },
          )
        }
      }

      const mask = (text: string): string => {
        let shown = text
        for (const secret of secrets) shown = shown.split(secret).join('***')
        return shown
      }

      const outcome = await runManaged(plan.argv, {
        timeoutMs: plan.timeoutMs,
        maxOutputBytes: plan.maxOutputBytes,
        overflowBytes: cfg.overflowBytes,
        killGraceMs: cfg.graceMs,
        cwd: plan.cwd,
        env: { ...plan.env, ...refEnv },
        stage: 'subprocess.run',
        ...(plan.stdin === undefined ? {} : { stdin: plan.stdin }),
        ...(input.onStdout === undefined ? {} : { onStdout: input.onStdout }),
        ...(input.onStderr === undefined ? {} : { onStderr: input.onStderr }),
      })

      const display = displayCommand(plan.argv, secrets)
      const result: Omit<SubprocessResult, 'note'> = {
        argv: plan.argv,
        display,
        shell: plan.shell,
        cwd: plan.cwd,
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stdout: mask(outcome.stdout),
        stderr: mask(outcome.stderr),
        stdoutBytes: outcome.stdoutBytes,
        stderrBytes: outcome.stderrBytes,
        durationMs: outcome.durationMs,
        timedOut: outcome.timedOut,
        killed: outcome.killed,
        truncated: outcome.truncated,
      }
      if (outcome.truncated && plan.spill) {
        const spill = await spillOutput(ctx, plan, outcome, mask, display)
        if (spill !== undefined) result.spill = spill
      }
      return { ...result, note: describeResult(result) }
    },

    policy(): SubprocessPolicy {
      return {
        cwd: cfg.cwd,
        timeoutMs: cfg.timeoutMs,
        maxTimeoutMs: cfg.maxTimeoutMs,
        maxOutputBytes: cfg.maxOutputBytes,
        overflowBytes: cfg.overflowBytes,
        graceMs: cfg.graceMs,
        shellAllowed: cfg.shellAllowed,
      }
    },
  }

  return service
}

/**
 * Registers the local-execution provider. The manifest gate runs FIRST: a plugin
 * that starts host processes without declaring `"execution": "host"` and the
 * `subprocess@1` policy in its own manifest does not load at all.
 */
export function apply(ctx: ServiceContext, config: SubprocessConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [SUBPROCESS] })
  provideService(ctx, SUBPROCESS, createSubprocessService(config, ctx))
}

export default { name, inject: [], apply }
