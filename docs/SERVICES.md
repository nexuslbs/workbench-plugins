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
plugins/
  shell-impl          provider `local-bash`      (shell@1)
  ssh-impl            provider `ssh-cli`         (ssh@1)
  docker-impl         provider `docker-compose-cli` (docker@1)
  http-impl           provider `fetch`           (http@1)
  general-service-impl provider `config-dispatch` (general-service@1)
  himalaya-impl       provider `cli`             (himalaya@1)
  email-himalaya      provider `himalaya`        (email@1, over himalaya@1)
  email-tools         CONSUMER: the tools email accounts|list|get|code|send
```

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

`plugins/email-tools` registers, through `ctx.workbench.registerTool` (the core
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
