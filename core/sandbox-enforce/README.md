# core/sandbox-enforce - the ENFORCING `sandbox@1` provider

One directory, one plugin: the `sandbox` capability (`sandbox@1`, provider id
`local-os`) that DECIDES like the declarative provider and then really
CONSTRAINS a local child process - under the strongest mechanism the host
measurably has, with every constraint it cannot enforce reported as a GAP.

## Wiring

| piece | value |
| --- | --- |
| manifest | `workbench.plugin.json` (`capabilities: [{ id: sandbox, version: 1, provider: local-os }]`, `"execution": "host"`, `sandbox` provide/require policy) |
| config roster | replace the `sandbox-policy:` row with `sandbox-enforce:` carrying the SAME policy shape plus the runner knobs (`shell`, `timeoutMs`, `maxOutputBytes`, `probe`) |
| provides | `ctx.provide('sandbox', service)` - the same service name, so consumers are untouched |

## The probe (never assume, measure)

At apply time `probeMechanisms(shell)` runs `PROBE_SCRIPT` (one `key=value`
line per check) and checks BOTH that a binary exists AND that the mechanism
really works on this host (an installed `unshare` that cannot create a
namespace is NOT available). `probe: false` skips it for tests, which inject
their own report.

| mechanism id | kind | what it confines |
| --- | --- | --- |
| `bwrap` | namespace | filesystem (read-only `/` + writable bind per granted write root), plus `--unshare-net` when the policy denies network |
| `unshare-net` | network | egress only (no filesystem confinement) |
| `prlimit` | rlimit | `RLIMIT_CPU` / `RLIMIT_AS` / `RLIMIT_NOFILE` |
| `sh-ulimit` | rlimit | the fallback: a `/bin/sh` prologue sets `ulimit -t/-v/-n` and `exec`s the argv unchanged |
| `setpriv` | process | `--no-new-privs` (and `--reuid/--regid` when the policy names a user/group) |
| `timeout-pgroup` | limit | wall time: the provider starts the child in its OWN process group and signals the GROUP (SIGTERM, then SIGKILL) |
| provider layers | - | filtered environment (rebuilt from the policy NAMES), pinned `cwd`, inline output cap |

`mechanismReport(report)` turns the raw probe into that list with the evidence
line of each one, and `enforcementRows(report)` produces the constraint ->
mechanism -> `enforced: true|false` matrix returned by `sandbox policy`, so a
gap is VISIBLE (an unenforced constraint is never silently dropped).

## API

* `check(request, options)`: the same pure decision as the declarative provider.
* `exec({ argv, cwd?, resource?, env?, envNames?, stdin?, timeoutMs?, maxOutputBytes?, approvalGranted? })`:
  decides FIRST (a deny starts nothing and returns the decision), then builds the
  plan (`buildEnforcementPlan`) and runs it. The answer carries the effective
  argv (the wrappers that were prepended), the mechanisms used, the enforcement
  matrix, the exit code/signal, the capped stdout/stderr, the duration and the
  `timedOut` / `killed` / `truncated` flags.
* `activePolicy()`: the policy views PLUS the mechanism matrix.
* `policyFor(capability)` / `checkCommand(plan)`: the shapes the `fs`,
  `subprocess` and `jobs` seams already consume.

## Honesty rule

A constraint with no available mechanism is reported as a gap
(`enforced: false` + note) and returned next to the run result. The provider
never claims isolation it does not have, and the README/matrix rows above
distinguish "always" layers (provider-implemented: env, cwd, deadline, output
cap) from the ones that depend on the host (namespaces, rlimits, setpriv).

Tests: `test/sandbox.test.ts` (the plan against an injected fake probe plus a
REAL `exec` on this host: an allowed run and a blocked one).
