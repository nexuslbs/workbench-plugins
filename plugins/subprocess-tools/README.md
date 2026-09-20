# subprocess-tools

The **consumer** half of the `subprocess@1` capability seam: it exposes the local
process capability as named tools and imports the DEFINITION
(`definitions/subprocess.ts`) only, never a provider.

| Role | Where |
|---|---|
| Definition | `definitions/subprocess.ts` (the contract, `ctx.subprocess`) |
| Provider | `core/subprocess-local` (provider id `local-process`) |
| Consumer | **this plugin** (the `subprocess ...` named tools) |

Because only the definition is imported, swapping the provider for another
`subprocess@1` implementation (an ssh- or container-backed runner on the same
contract) is a `plugins:` roster edit: this file does not change, and
`npm run check:seam` enforces the direction.

## Tools

| Tool | What it does |
|---|---|
| `subprocess run` | one bounded LOCAL command: argv (no shell unless `shell: true`), `cwd`, `env`/`envRefs`, `stdin`, `timeoutMs`, `maxOutputBytes`, `spill`, `label` |
| `subprocess policy` | the policy in effect: default and hard deadline, inline cap, overflow bytes, kill grace, whether a shell is allowed, default cwd |

One tool per operation (the `fs@1` sibling seam uses the same shape): the two
operations have different parameter shapes and the tools seam publishes a JSON
Schema per tool, so an action-enum tool would force a union schema no caller
could validate against.

### The structured answer of `subprocess run`

`{ argv, display, shell, cwd, exitCode, signal, stdout, stderr, stdoutBytes,
stderrBytes, durationMs, timedOut, killed, truncated, spill?, note }`

* a **non-zero exit is a normal result** (`exitCode: 2` plus both streams), so a
  caller never has to catch an exception to read a failing command;
* `timedOut: true` means the deadline expired and the **whole process group** was
  signalled (SIGTERM, then SIGKILL after the grace) - no orphan survives;
* `truncated: true` means a stream exceeded `maxOutputBytes`; the bytes beyond the
  cap are in the file named by `spill.path` (the `spill@1` seam), with
  `spill.preview` and `spill.sha256` - read them back in ranges with `spill read`;
* `envRefs` values of the form `${cred:NAME}` / `${env:NAME}` are resolved at call
  time by the provider; a resolved VALUE never appears in the answer, an error or
  a log.

## Wiring

`plugins/subprocess-tools` in `workbench.config.yml` (`plugins:` roster):

```yaml
plugins:
  subprocess-local: {}          # provider (core/subprocess-local)
  subprocess-tools: {}          # this consumer
```

With no `subprocess@1` provider loaded the tool fails with a structured error
naming the missing capability instead of silently doing nothing.
