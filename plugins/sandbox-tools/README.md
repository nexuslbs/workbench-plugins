# plugins/sandbox-tools - the inspectable `sandbox@1` surface

One directory, one plugin, three TOOLS on the `tools@1` seam (`ctx.tools.registerTool`).
It CONSUMES the `sandbox` capability; it never implements a policy of its own and
it imports `definitions/sandbox.ts`, never a provider.

| tool | what it answers |
| --- | --- |
| `sandbox check` | decides ONE request and returns the RAW decision (`allow` + constraints, or `deny` + `sandbox.*` reason + message + details) plus the ACTIVE policy. It never touches the host: it is the decision call the other capabilities make, exposed so the behaviour is inspectable without code |
| `sandbox policy` | the ACTIVE policy (source, fail-open/closed default, one constraint view per resource) and, for an ENFORCING provider, the MEASURED mechanism matrix with the gaps it cannot enforce |
| `sandbox run` | runs a command THROUGH an enforcing provider: decide first (a deny starts NOTHING), then run under the mechanisms the provider really has. A declarative-only deployment answers `sandbox.exec-unavailable` |

## Parameters

* `sandbox check`: `resource` (required: `fs` | `subprocess` | `jobs` |
  `computer-use` | `browser-use` | custom), `operation`, `path`, `argv`, `shell`,
  `cwd`, `envNames`, `network`, `bytes`, `wallTimeMs`, `approvalGranted`,
  `metadata`.
* `sandbox policy`: none.
* `sandbox run`: `argv` (required), `cwd`, `resource`, `env` (literal entries;
  every NAME is still checked against the allow-list), `envNames`, `stdin`,
  `timeoutMs`, `maxOutputBytes`, `approvalGranted`.

## Wiring

| piece | value |
| --- | --- |
| manifest | `workbench.plugin.json` (`"execution": "host"`, no capability provider: only tool surfaces) |
| config roster | `sandbox-tools: {}` in `config.yml` |
| resolves | `requireSandbox(ctx)` -> the `sandbox` service by NAME at CALL time (so the provider can be swapped or absent) |

Config: `{ reportPolicy?: boolean }` (default `true`; `false` keeps the policy
out of the `sandbox check` answer).

Without a `sandbox@1` provider in the roster the plugin still loads and the tools
answer with the `sandbox.unconfigured` error the Definition defines - the seam is
optional, and the failure names the roster row to enable.

Tests: `test/sandbox.test.ts` drives all three tools through a fake `tools`
context against both providers.
