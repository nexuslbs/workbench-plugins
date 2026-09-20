# Services: Definition / Provider / Consumer (workbench-plugins)

This repository owns the WHOLE service stack of the workbench task
"GeneralService + Himalaya + Email": the **Definitions** (the contracts), the
**Providers** (the implementations) and the **Consumers** (the tools). Nothing
of it lives in the core repo `nexuslbs/workbench`, and the core is untouched by
this work: the operator's repo-placement rule (telegram threads 2442/2443/2446)
puts every module here.

## Layout

```
definitions/          the CONTRACTS (imported by providers AND consumers)
  support.ts          shared infra: ServiceError, serviceOf/requireService,
                      credentialsOf, waitForServices, shellQuote, normalisers
  shell@1   shell.ts  LOCAL execution (the only host-running transport)
  ssh@1     ssh.ts    execution ON a remote machine
  docker@1  docker.ts compose-capable container execution (IN the container)
  http@1    http.ts   a POST/GET call, no shell at all
  general-service@1   general-service.ts  ONE command string in, ONE result out,
                      with the transport chosen by a CONFIG VALUE
  himalaya@1 himalaya.ts  the mail-CLI contract (typed actions + typed outputs)
  email@1   email.ts  the mail contract of the deployment (accounts/list/get/
                      code/search/send), account = LABEL/reference
  index.ts            the public surface of the definitions module
core/                 the CORE SERVICE IMPLEMENTATIONS (capability providers)
  shell-impl          provider `local-bash`      (shell@1)
  ssh-impl            provider `ssh-cli`         (ssh@1)
  docker-impl         provider `docker-compose-cli` (docker@1)
  http-impl           provider `fetch`           (http@1)
  general-service-impl provider `config-dispatch` (general-service@1)
  himalaya-impl       provider `cli`             (himalaya@1)
  email-himalaya      provider `himalaya`        (email@1, over himalaya@1)
plugins/              the CONSUMERS / operator surfaces
  email-tools         CONSUMER: the tools email accounts|list|get|code|send
```

`core/` and `plugins/` are each declared as their own source (`kind: path`,
`path: ./core` / `path: ./plugins`, see the repository `config.yml`): the
implementation of a core service is visibly a CORE service, while the consumers
stay under `plugins/`. Nothing else changes - the roster names plugins by NAME.

A **provider** declares its contract in `workbench.plugin.json`
(`capabilities: [{ id, version, provider }]`) and provides the capability at
boot through the core seam. A **consumer** imports ONLY `definitions/...` and
reaches the service through the host (`ctx.get(<name>, false)` /
`serviceOfMail()`), never by importing a provider: that is what makes a provider
swappable with CONFIG ONLY.

## The three roles

* **Definition**: contract + version + the pure helpers that make a provider's
  launcher ARGV assertable (`planLocal`, `planSsh`, `planContainer`,
  `planRemoteDocker`, `planSshCommand`, `planRemoteCommand`, `planHttp`). No
  business vocabulary, no deployment paths, no credential value.
* **Provider**: owns the transport mechanics (spawn, timeouts, output cap,
  redaction) and the credential RESOLUTION by name (`ctx.credentials`).
* **Consumer**: owns the tool surface and the typed argument validation; it
  builds the action argv from TYPED inputs (never verbatim from a caller) and
  parses the answer into a typed result.

## The transport-config rule (general-service@1)

`general-service@1` takes a CONFIG, not a constructor:

```yaml
general:
  type: container            # local | container | ssh | ssh+container | http
  params:
    engine: docker-compose
    compose: { project_dir: ${env:OMNI_DIR}, service: toolbox }
```

* `general-service-impl` does **NOT** hard-inject the transports. At call time it
  resolves the service for the configured `type` (`local -> shell`,
  `container -> docker`, `ssh -> ssh`, `ssh+container -> ssh + docker`,
  `http -> http`) with a non-strict lookup, so a deployment that configures
  `ssh` works while NO `docker@1` provider is loaded, and vice versa.
* An instance initialised with a type whose service is missing FAILS TO
  INITIALISE (before any command runs) with an error naming the missing
  capability/type, and an unknown `type` is a structured error. There is never a
  silent fallback to another transport, and a command configured for a remote
  type never runs on the workbench host.
* Load ordering is SOFT and BOUNDED: `waitForServices` waits for the declared
  transport services with a bound (default 1500 ms) and reports what is still
  missing; it never hangs, and a transport that never loads does not stop
  `general-service-impl` from loading. "Load after" is an ordering hint, NOT a
  dependency.

### Swapping a transport provider (config only)

1. Disable (or remove) the row of the current provider in the deployment config
   (`plugins:` roster), e.g. `ssh-impl`.
2. Add the row of the replacement provider that declares the same capability
   (`{ id: "ssh", version: 1, provider: "<other>" }`).
3. That is all: `general-service-impl`, `himalaya-impl` and the email tools are
   untouched, because none of them imports a provider.

`test/transports.test.ts` proves this with stub providers (a second `ssh@1` and
a second `docker@1` provider) and `test/general-service.test.ts` proves the
config-driven dispatch and the missing-transport failure.

## Filesystem capability (`fs@1`)

The filesystem is a capability like any other transport (contract
`definitions/fs.ts`, service `ctx.fs`), which is what lets an agent reach files
WITHOUT going through `shell@1`:

| role | plugin | what it does |
| --- | --- | --- |
| Definition | `definitions/fs.ts` | the typed contract + the pure algorithms (paging, the edit engine, the glob compiler, the ripgrep `--json` parser) and the error taxonomy (`FsError`, `fs.*` reasons) |
| Provider | `core/fs-local` (`local-fs`) | the LOCAL filesystem through `node:fs` only (no shell): stat/read/write/append/edit/list/glob/grep |
| Consumer | `plugins/fs-tools` | the ten tools `fs read`, `fs write`, `fs append`, `fs str_replace`, `fs insert`, `fs apply_patch`, `fs list`, `fs info`, `fs search`, `fs grep` |

The one rule that matters operationally: **reads are unrestricted, writes are
confined**. `fs-local.roots` lists the directories a write may land in; a write
outside them (including through `..` or a symlink, both resolved BEFORE the
check) fails with `reason: fs.outside-root` (shared code `policy`). There is no
silent success, no fallback target and no retry.

Caps and spill: every answer is bounded. `read` pages by LINE (`offset` /
`limit`, default and max 2000 lines, per-line byte cap) and reports `truncated`
/ `nextOffset` / `eof` plus a human `note`; `list` and `glob` are capped and
report `truncated`; `grep` keeps at most `maxResults` (default 250) matches
inline and, when the walk found more, writes the FULL match list to a SPILL file
whose path it returns (`spill: { path, bytes, lines }`) - nothing is lost, and
the spill file is itself readable through `fs read`.

Execution policy: `core/fs-local` reads and writes HOST paths, so its manifest
declares `"execution": "host"` and the `fs` provide/require policy, and
`apply()` enforces it with `assertPolicyDeclared` (the same guard
`core/shell-impl` uses). Drop the `fs-local` row and every `fs *` tool becomes
unavailable while the rest of the stack keeps running - the tools resolve
`ctx.fs` at CALL time.

Sandbox extension point (no hard dependency): the provider accepts an OPTIONAL
`FsSandboxPolicy` (`writeRoots` / `readRoots` / `readOnly`), either from its
own `sandbox:` config block or from a `sandbox@1` service when one is loaded
(`sandboxPolicyFrom(ctx)`). BOTH are resolved on EVERY read/write, never once at
apply time: plugins apply in discovery order, so `fs-local` is always applied
BEFORE any `sandbox-*` provider is provided, and a policy cached at apply time
silently ignored the provider's deny (thread 2553). Every policy in force is
INTERSECTED, so a policy only NARROWS the configured roots, `readOnly: true`
refuses every write and an empty intersection denies every write. Which policy a
`sandbox@1` provider hands out is ITS decision (see "Sandbox
capability" below); with no provider loaded the behaviour is exactly the
config-only confinement above.

## Local execution capabilities (`subprocess@1`, `jobs@1`, `spill@1`)

Three seams cover LOCAL execution on the workbench host. They are the only
places of this repository that start an arbitrary process, so every one of them
is bounded by construction (deadline, byte cap, retention).

| role | plugin | what it does |
| --- | --- | --- |
| Definition | `definitions/subprocess.ts` | the typed contract + the pure algorithms (command planning: argv preferred / `shell: true` escape hatch, the `${cred:NAME}` / `${env:VAR}` reference resolution, the deadline and cap normalisation, the display/redaction form) and the error taxonomy (`SubprocessError`, reasons `subprocess.spawn-failed`, `subprocess.timeout`, `subprocess.missing-service`, ...) |
| Provider | `core/subprocess-local` (`local-process`) | ONE bounded run through `node:child_process` (no host shell unless asked): streamed stdout/stderr, a deadline that kills the process GROUP (`SIGTERM`, then `SIGKILL`), an inline output cap whose overflow goes to `spill@1`, and a structured result `{exit_code, stdout, stderr, duration, truncated, spill}` |
| Consumer | `plugins/subprocess-tools` | the tools `subprocess run`, `subprocess policy` |
| Definition | `definitions/jobs.ts` | the typed contract + the pure algorithms (the job-id shape, the `stateOfExit` state machine, `readLogWindow`: the cursor paging math) |
| Provider | `core/jobs-local` (`local-registry`) | background jobs with a stable id and a durable log file under a configured directory: `start`, `list`, `status`, `logs` (byte CURSOR), `stop` (process GROUP), `cleanup`; the log has a ceiling, the child is `unref()`ed so a job never holds a request handler, and unloading the plugin STOPS every running job and removes its logs through `effect()` |
| Consumer | `plugins/jobs-tools` | the tools `jobs start`, `jobs list`, `jobs status`, `jobs logs`, `jobs stop`, `jobs cleanup`, `jobs policy` |
| Definition | `definitions/spill.ts` | the typed contract + the pure algorithms (`clampRange`, the line-aligned window, `spillFileName`, `sanitizeLabel`, `sha256Of`, `previewOf`, `selectForPurge`) |
| Provider | `core/spill-local` (`local-disk`) | oversized payloads written ONCE (atomic temp + rename) to a content-addressed file under a configured directory, read back by byte RANGE, with the retention policy (max age / max total bytes / explicit `purge`); every path is confined to the spill directory |
| Consumer | `plugins/spill-tools` | the tools `spill write`, `spill read`, `spill list`, `spill purge`, `spill policy` |

### Configuration and directories

| knob | plugin | default |
| --- | --- | --- |
| `dir` | `spill-local` | `<tmpdir>/workbench-spill` (the dev config sets `/tmp/workbench-spill`) |
| `maxBytes` / `maxTotalBytes` / `maxAgeSeconds` / `previewBytes` | `spill-local` | 64 MiB per payload / 256 MiB total / 24 h / 2048 bytes of preview |
| `dir` | `jobs-local` | `<tmpdir>/workbench-jobs` (the dev config sets `/tmp/workbench-jobs`) |
| `maxJobs` / `maxLogBytes` / `stopOnUnload` | `jobs-local` | 32 jobs / 8 MiB per log / true |
| `timeoutMs` / `maxOutputBytes` / `overflowBytes` / `allowShell` / `spill` | `subprocess-local` | 30 s / 64 KiB inline / 4 MiB kept for the spill / true / true |

Both directories are plain host paths: point them at a durable volume for a
long-lived deployment. A `jobs` log and a `spill` file are ordinary files under
them, so an operator can inspect or delete them with the `fs` tools.

### The cap never loses data

A capped answer is never silently truncated: `subprocess` and `jobs` hand the
overflow to `spill@1` and the answer carries the spill path plus the preview
length, so the caller reads the rest with a RANGE read (`spill read`). This is
the same cap-then-spill rule the `fs` `grep` overflow follows.

### Optional sandbox extension point (no hard dependency)

`definitions/subprocess.ts` exposes `sandboxOf(ctx)` and `definitions/jobs.ts`
consults it too: when a `sandbox@1` provider (see "Sandbox capability" below) is present
in the context, its `checkCommand` runs BEFORE a process is started and a refusal
is a structured error. Nothing here imports or requires that seam: a deployment
without it behaves exactly as documented above.
## Sandbox capability (`sandbox@1`)

`definitions/sandbox.ts` is the POLICY seam every local capability consults
BEFORE it touches the host. A capability (`fs`, `subprocess`, `jobs`,
`computer-use`, `browser-use`, or a custom name) hands it ONE request - resource
+ operation + target (path, argv, cwd, environment NAMES, network, bytes, wall
time) - and gets back a DECISION: `allow` with the constraints that apply, or
`deny` with a machine-readable `sandbox.*` reason. The provider DECIDES, the
CONSUMER APPLIES: a consumer that cannot enforce a constraint must still honour
a deny (never silently ignore it) and report the enforcement gap it leaves.

| role | plugin | provider | what it does |
| --- | --- | --- | --- |
| Definition | `definitions/sandbox.ts` | - | the typed model (resources, requests, constraints, rules, allow/deny), the PURE decision engine (`evaluateSandbox`, fail-closed), the constraint views (`constraintView`, `policyViews`) and the enforcement PLAN (`buildEnforcementPlan`, `ulimitScript`, `filterSandboxEnv`) |
| Provider (declarative) | `core/sandbox-policy` | `declarative` | per-resource rules from config; DECIDES only, touches nothing, has no `exec` |
| Provider (enforcing) | `core/sandbox-enforce` | `local-os` | the same policy shape PLUS a mechanism PROBE and real enforcement: `check` decides, `exec` runs a command under the strongest mechanism the host measurably has, and every constraint it cannot enforce is reported as a GAP |
| Tools / consumer | `plugins/sandbox-tools` | - | tools `sandbox check`, `sandbox policy`, `sandbox run` |
| Reference consumer | `plugins/sandbox-consumer` | - | tool `sandbox guarded run`: asks for a decision, runs only when it is allowed, reports the deny otherwise |

Exactly ONE provider is mounted (both provide the service name `sandbox`), so
swapping them is a config edit and no consumer changes. With NO provider the
deployment still boots: `sandboxOf(ctx)` / `sandboxPolicyFrom(ctx)` answer
`undefined` and every consumer degrades to "no policy handle" - the seam is
optional by construction.

Config (the same shape for both providers; documented in `config.yml`):

```yaml
sandbox-policy:            # or `sandbox-enforce:` for the enforcing one
  source: config.yml (dev) # reported by `sandbox policy`
  unconfigured: deny       # fail-closed: a resource with no rule is REFUSED
  defaults:                # narrowed per resource, NEVER widened
    mode: workspace-write  # read-only | workspace-write | danger-full-access
    env: [PATH, HOME, ...] # environment NAMES the child may receive
    network: none          # none | allow-list (hosts) | unrestricted
    limits: { wallTimeMs: 30000, maxOutputBytes: 65536, cpuSeconds: 30,
              memoryBytes: 1073741824, nofile: 256 }
  resources:
    fs:         { mode: workspace-write, readRoots: [], writeRoots: [] }
    subprocess: { mode: danger-full-access, denyCommands: [], approval: false }
```

Decision order (the FIRST refusal wins): resource denied outright -> resource
unconfigured (fail-closed) -> a requested limit above the ceiling -> an
environment name outside the allow-list -> an `fs` path outside the roots or a
write under `read-only` -> argv deny-list, missing allow-list entry or a `cwd`
outside the roots -> a network target outside the allow-list -> approval
required but not granted.

### Enforcement matrix (`core/sandbox-enforce`)

The enforcing provider PROBES the host at apply time (binary presence AND a real
exercise of the mechanism) and reports the measured outcome through
`sandbox policy`; the plan is built from what is measurably THERE, never from
what is assumed:

| constraint | mechanism | enforced |
| --- | --- | --- |
| filesystem roots | `bwrap` mount namespace: read-only bind of `/` plus a writable bind of every granted write root | only where the probe finds a WORKING `bwrap`; otherwise NOT enforced and reported as a gap |
| network egress | `bwrap --unshare-net`, else `unshare -n` | only where the probe can create a network namespace; otherwise a gap |
| cpu / memory / open files | `prlimit --cpu --as --nofile`, else a `/bin/sh` ulimit prologue that `exec`s the real argv | the prologue is the fallback, so these hold on any Linux host |
| wall time | the provider's own deadline: the child runs in its OWN process group and the GROUP is signalled (SIGTERM, then SIGKILL) | always (implemented in the provider) |
| working directory | the child `cwd`, defaulting to the policy's first read root, else `/` | always (a `cwd` outside the roots is already refused by the decision) |
| environment | the child environment is REBUILT from the policy names, nothing is inherited implicitly | always |
| output bytes | stdout/stderr captured with an inline cap; the overflow is truncated and reported | always |
| privilege drop | `setpriv --no-new-privs`; `--reuid` / `--regid` when the policy names a user/group | where the probe finds `setpriv` and the host permits it |
| approval | policy flag: the decision answers `sandbox.approval-required` and the caller must pass `approvalGranted` | always (a decision-level constraint) |

A constraint with no available mechanism is NOT silently dropped: it appears in
the enforcement report as `enforced: false` with a note, and `sandbox run`
returns the gaps next to the result. The matrix above is what the mechanism
LAYERS can do; the MEASURED availability of one host is printed by
`sandbox policy` (`available` + the probe evidence per mechanism). Tests:
`test/sandbox.test.ts` (decision matrix, deny precedence, fail-closed default,
the plan against a fake probe, and a REAL enforced run).


## Shell safety invariant (mandatory)

For every REMOTE type the caller's input string is evaluated **exactly once, in
the target** (`container` = inside the container, `ssh` = on the remote machine,
`ssh+container` = inside the remote container, `http` = not shell-evaluated at
all). The launcher is assembled as an ARGV array and handed to the target shell
as ONE argument:

```
docker compose -p <proj> -f <file> --env-file <env> exec -T <service> sh -c <input>
ssh <host> -- sh -c <shell-quoted input>          # one single-quoted argument
ssh <host> -- docker compose -p <proj> exec -T <service> sh -c <quoted input>
```

* The host shell NEVER sees the input: no host-side `sh -c`, no `shell: true`
  with the caller string, no host-side word splitting, globbing or expansion.
* `local` (`shell@1`, provider `local-bash`) is the ONLY type that runs on the
  host, and its plugin README says so. It is OPT-IN: do not list `shell-impl` in
  a deployment that must never execute on the host.
* A remote-typed command whose target is unreachable FAILS; it is never retried
  on the host.

## Credentials

Credential VALUES live only in an unversioned artifact, resolved by NAME at call
time through the core credentials capability (`ctx.credentials`):

* the plugins repo dev config points `credentials-basic` (the `file` backend) at
  `/opt/workspace/workbench-secrets/credentials.yml` (git-ignored, outside both
  repositories);
* plugin configs carry NAMES (`credential:`, `privateKeyName:`,
  `email-himalaya.accounts.<label>.credential`), never a value;
* a resolved value is used in-flight only and is redacted from every log, error
  and argv DISPLAY string (`email-himalaya` and the transports redact it).

Required names for the omni stack: `HOSTINGER_EMAIL_PASSWORD` (the mailbox
password; the address/hosts are not secrets). The himalaya account of the `omni`
toolbox fetches the password itself at run time, so the container transport needs
no password in the workbench config at all.

## Tools (consumer surface)

`plugins/email-tools` registers, through `ctx.tools.registerTool` (the `tools@1`
seam: `POST /api/tools/<name>` and `POST /api/tool/call {"tool","params"}`):

| tool | params |
|---|---|
| `email accounts` | `format` (labels \| full) |
| `email list` | `account?`, `folder?`, `limit?`, `unreadOnly?`, `since?` |
| `email get` | `account?`, `id` (required), `folder?`, `format?` |
| `email code` | `account?`, `folder?`, `query?`, `from?`, `id?`, `pattern?`, `scan?`, `maxAgeSeconds?` |
| `email send` | `account?`, `to` (required), `subject` (required), `body` (required), `cc?`, `bcc?`, `replyTo?`, `html?` |

`account` is a LABEL the provider resolves (the configured default when
omitted): a second mailbox is added by config + credential reference, with no
code change.

## Findings for the operator

1. The core still hosts its own `email@1` copy (workbench core `229b67b`) under
   the kernel service name `email`, and a second `provide('email')` throws, so
   this repository's email provider publishes the deployment-visible service
   `mail` (contract `email@1` INCLUDING `send`) and additionally registers with
   the kernel service for backward compatibility when one is present. Removing
   the core copy (and letting this repo own the single `email` service) is the
   clean end state; it needs a core change and is therefore NOT done here.
2. There is no `declare module 'cordis'` augmentation in this repo: the plugins
   repo has no cordis dependency (the core supplies it at run time), so the
   typed `ctx.<service>` handle is obtained structurally
   (`definitions/support.ts` types the context it needs). A core-side
   augmentation module would be the alternative; it would put the Definitions
   back into the core, which R14 forbids.
