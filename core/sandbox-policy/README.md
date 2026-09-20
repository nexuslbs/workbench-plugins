# core/sandbox-policy - the DECLARATIVE `sandbox@1` provider

One directory, one plugin, one provider of the `sandbox` capability
(`definition: definitions/sandbox.ts`, contract `sandbox@1`, provider id
`declarative`). It DECIDES; it never touches the host and it has no `exec`.

## Wiring

| piece | value |
| --- | --- |
| manifest | `workbench.plugin.json` (`capabilities: [{ id: sandbox, version: 1, provider: declarative }]`) |
| config roster | `sandbox-policy: { ... }` in `config.yml` (the dev default) |
| provides | `ctx.provide('sandbox', service)` (`provideService`), so every consumer resolves it by NAME |
| consumed by | `definitions/fs.ts` (`sandboxPolicyFrom` -> `policyFor`), `definitions/subprocess.ts` + `definitions/jobs.ts` (`sandboxOf` -> `checkCommand`), `plugins/sandbox-tools` (`check` / `policy`), `plugins/sandbox-consumer` |

`apply()` also calls `assertPolicyDeclared` (the manifest declares
`"execution": "host"` and the `sandbox` provide/require policy), so the
capability declaration cannot drift from the code.

## Config (the same shape as the enforcing provider)

```yaml
sandbox-policy:
  source: config.yml (dev)   # reported verbatim by `sandbox policy`
  unconfigured: deny         # deny | allow - what a resource with NO rule gets
  defaults:                  # narrowed per resource, NEVER widened
    mode: workspace-write    # read-only | workspace-write | danger-full-access
    readRoots: []            # optional read confinement
    writeRoots: [/tmp]
    env: [PATH, HOME]        # environment NAMES a child may receive
    network: none            # none | allow-list (hosts) | unrestricted
    limits: { wallTimeMs: 30000, maxOutputBytes: 65536, cpuSeconds: 30,
              memoryBytes: 1073741824, nofile: 256 }
  resources:
    fs: { mode: workspace-write, writeRoots: [/tmp] }
    subprocess: { mode: danger-full-access, denyCommands: [rm] }
    browser-use: { network: { mode: allow-list, hosts: [example.com] } }
```

## Decision

`check(request, { approvalGranted? })` builds the constraint VIEW of the
requested resource (`constraintView(policy, resource)`: the resource rule
NARROWED by the defaults, never widened) and runs the pure engine
(`evaluateSandbox`). The first refusal wins, in this order: resource denied
outright, resource unconfigured (fail-closed), a requested limit above the
ceiling, an environment name outside the allow-list, an `fs` path outside the
roots or a write under `read-only`, argv deny-list / missing allow-list entry /
`cwd` outside the roots, a network target outside the allow-list, approval
required but not granted.

The answer is a `SandboxAllow` (with the constraints and notes) or a
`SandboxDeny` carrying a machine-readable `sandbox.*` reason, a message and the
details a caller branches on. `activePolicy()` reports the ACTIVE policy
(source, default, one view per configured resource) for `sandbox policy`.

## What it does NOT do

It does not enforce anything: it has no `exec`, no child process and no
filesystem access. A consumer that needs REAL confinement of a child process
mounts `core/sandbox-enforce` (provider `local-os`) instead - same service name,
same config shape, so the swap is a config edit and no consumer changes.

Tests: `test/sandbox.test.ts` (decision matrix, deny precedence, fail-closed
default, `policyFor` / `checkCommand` interop).
