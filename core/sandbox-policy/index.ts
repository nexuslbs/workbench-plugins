// core/sandbox-policy - the `sandbox@1` PROVIDER `declarative`: the policy is
// DATA (plugin config), the decision is PURE (`definitions/sandbox.ts`), and
// nothing is executed here.
//
// It is the provider a deployment gets by default and the one the `fs`,
// `subprocess`, `jobs`, `computer-use` and `browser-use` capabilities consume
// through the seam: they ask, it DECIDES (allow-with-constraints or deny with a
// machine-readable reason), and the consumer applies the constraints and reports
// any gap it cannot enforce.
//
// WHY A SEPARATE ENFORCING PROVIDER: a decision is not an enforcement. This
// provider can only constrain what a CONSUMER honors (the root narrowing of
// `core/fs-local`, the `checkCommand` refusal of `core/subprocess-local` and
// `core/jobs-local`). `core/sandbox-enforce` is the provider that also RUNS local
// work under the constraints (namespaces, rlimits, an environment allow-list, a
// deadline and a process-group kill) and reports, per constraint, what it really
// enforces. Both register the SAME contract: a deployment mounts exactly one.
//
// The vocabulary follows the DSH `sandbox` group (MIT, see THIRD_PARTY.md): the
// modes `read-only` / `workspace-write` / `danger-full-access`, a per-call
// policy, a fail-closed default and an approval rung. The decision engine lives
// in the DEFINITION module, so it is unit-testable without a host.
import {
  SANDBOX,
  SANDBOX_CONTRACT,
  constraintView,
  evaluateSandbox,
  normalizeSandboxPolicyConfig,
  policyViews,
} from '../../definitions/sandbox.ts'
import type {
  NormalizedSandboxPolicy,
  SandboxActivePolicy,
  SandboxCommandVerdict,
  SandboxConstraints,
  SandboxDecision,
  SandboxDecisionOptions,
  SandboxPolicyConfig,
  SandboxRequest,
  SandboxResource,
  SandboxService,
} from '../../definitions/sandbox.ts'
import { provideService } from '../../definitions/support.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'sandbox-policy'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'declarative'

export const contract = SANDBOX_CONTRACT

/**
 * Builds the service of this provider from an ALREADY normalized policy. Split
 * out so the tests (and the enforcing provider, which narrows the same policy)
 * can drive the pure decision engine without a cordis context.
 */
export function sandboxPolicyService(policy: NormalizedSandboxPolicy): SandboxService {
  /** The constraint view of a resource: the defaults narrowed by its rule. */
  const view = (resource: SandboxResource): SandboxConstraints => constraintView(policy, resource)

  const decide = (request: SandboxRequest, options: SandboxDecisionOptions = {}): SandboxDecision =>
    evaluateSandbox(request, view(request.resource), {
      unconfigured: policy.unconfigured,
      ...(options.approvalGranted === undefined ? {} : { approvalGranted: options.approvalGranted }),
    })

  return {
    contract: SANDBOX_CONTRACT,
    provider: providerId,

    // A DENY is an ANSWER, never a thrown error (the definition says so): the
    // caller branches on `decision.allowed` and on `decision.reason`.
    check(request: SandboxRequest, options: SandboxDecisionOptions = {}): SandboxDecision {
      return decide(request, options)
    },

    // Always answers: a consumer that narrows its own reach must SEE the policy
    // (an empty `writeRoots` view means "no write root is granted", which is how
    // `fs@1` turns a deny into a refusal instead of silently ignoring it).
    policyFor(resource: SandboxResource): SandboxConstraints {
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
      }
    },

    // The structural hook `definitions/subprocess.ts` and `core/jobs-local` call
    // BEFORE starting a process: `undefined`/`true` proceeds, `false` refuses.
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
  }
}

/** Normalizes the plugin config and builds the provider (the testable entry). */
export function createSandboxPolicyService(config: SandboxPolicyConfig = {}): SandboxService {
  return sandboxPolicyService(normalizeSandboxPolicyConfig(config, 'sandbox-policy'))
}

/**
 * Registers the declarative sandbox provider. It reaches no host resource (no
 * process, no file, no socket), so it declares no `execution` policy: the
 * manifest only declares the `sandbox@1` capability it provides.
 */
export function apply(ctx: ServiceContext, config: SandboxPolicyConfig = {}): void {
  provideService(ctx, SANDBOX, createSandboxPolicyService(config))
}

export default { name, inject: [], apply }
