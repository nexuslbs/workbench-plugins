# plugins/sandbox-consumer - the reference CONSUMER that honours a deny

One directory, one plugin: the smallest honest consumer of the `sandbox@1` seam,
used as the INTEROP proof. It asks the loaded provider for a decision and only
then acts, so a deny can never be silently ignored.

| tool | what it does |
| --- | --- |
| `sandbox guarded run` | asks for a decision on the command (`argv`, `cwd`, `resource`, `network`, `approvalGranted`), then: `allow` -> runs it locally through the `subprocess@1` seam with the granted limits; `deny` -> starts NOTHING and returns the raw decision (`deniedBy`, `reason`, `message`, `details`), so the refusal is visible in the answer |

The answer always carries `request`, `decision`, `executed` and - for an allowed
call - the provider result, plus the `sandbox` provider id that decided.

## Wiring

| piece | value |
| --- | --- |
| manifest | `workbench.plugin.json` (`"execution": "host"`, no capability provider) |
| config roster | `sandbox-consumer: {}` in `config.yml` |
| injects | `sandbox`, `tools`, `subprocess` (all resolved at call time; a missing provider is a named error, not a crash) |

Deliberately NOT a product plugin: it exists to show the seam's contract in
action (decide -> honour -> report the gap) and to be the deny path the test
suite asserts. A real capability (`fs`, `jobs`, `computer-use`, ...) follows the
same two rules: resolve the service by NAME, and never soften a deny.

Tests: `test/sandbox.test.ts` (a denied command runs nothing and reports the
reason; an allowed command runs and returns its output).
