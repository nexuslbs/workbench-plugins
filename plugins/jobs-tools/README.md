# jobs-tools

The **consumer** half of the `jobs@1` capability seam: the background-job tools.
It imports the DEFINITION (`definitions/jobs.ts`) only, never a provider.

| Role | Where |
|---|---|
| Definition | `definitions/jobs.ts` (the contract, `ctx.jobs`) |
| Provider | `core/jobs-local` (provider id `local-registry`) |
| Consumer | **this plugin** (the `jobs ...` named tools) |

## Tools

| Tool | What it does |
|---|---|
| `jobs start` | starts a background job (argv, `cwd`, `env`/`envRefs`, `label`, `timeoutMs`, `maxLogBytes`) and returns the stable job id + durable log path |
| `jobs list` | every job the provider owns: state, pid, exit code, duration, log path, log size |
| `jobs status` | one job by id |
| `jobs logs` | ONE page of the log by BYTE CURSOR: pass the `nextCursor` of the previous answer to get only the NEW lines |
| `jobs stop` | SIGTERM to the whole process group, then SIGKILL after the grace |
| `jobs cleanup` | removes finished jobs and their log files (`dryRun`, `olderThanSeconds`, `all`) |
| `jobs policy` | the policy in effect (log dir, job ceiling, log cap, grace) |

One tool per operation, the `fs@1` sibling convention: `start`, `logs` and `stop`
have different parameter shapes and the tools seam publishes a JSON Schema per
tool, so an action-enum tool would force a union schema no caller could validate
against. (`web-session` uses an action-enum because all its actions take the same
handle.)

## The cursor rule

`jobs logs` never re-reads the whole log. The answer carries `cursor`,
`nextCursor`, `bytes`, the complete `lines` of the window and `eof`; the next call
passes `cursor: nextCursor` and receives only what was appended since. A trailing
PARTIAL line stays in the file until it is complete, so a caller never sees half a
line. When nothing new arrived the page is empty with the SAME cursor and
`eof: true`.

## Job lifetime

A job's output lives in a file under the provider's jobs directory, so a job
survives a client disconnect, and `jobs list` after a restart of the caller still
sees it. Jobs are owned by the PROVIDER plugin: unloading it (or a config
reconcile dropping its row) stops every running job through the cordis `effect()`
disposer and cleans its log per the provider policy - no orphan process, no leaked
log file, and a running job never keeps a request handler alive.

## Wiring

```yaml
plugins:
  jobs-local: {}          # provider (core/jobs-local)
  jobs-tools: {}          # this consumer
```
