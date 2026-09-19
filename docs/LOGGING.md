# Logging: a service + exporter plugins

Workbench follows the cordis model the operator described (2026-09-19):

> Logging is not `console.log` sprinkled around, and not a single monolithic
> logger plugin. Cordis core ships a logger service, and output is produced by
> separately mounted exporter plugins.

So there are exactly three roles, and each one lives in the place its role
implies:

| role | lives in | what it is |
|---|---|---|
| **service** | the CORE (kernel wiring, `nexuslbs/workbench`) | cordis `LoggerService`: `ctx.logger(name)` -> `{error,warn,info,debug}`, `ctx.logger.exporter(sink)` -> a disposable registration. The core installs nothing extra (cordis already installs it on every context) and owns **no sink and no formatter**: with no exporter mounted the process prints **no log line at all** |
| **contract** | the PLUGINS repo, `definitions/logger.ts` (`logger@1`) | the `Message` and `Exporter` shapes, the level semantics, `loggerOf(ctx, name)` for a consumer, `mountExporter(ctx, sink)` for a sink, the serializers (`messageToJson`, `formatText`) |
| **sinks** | the PLUGINS repo, one DIRECTORY per sink | `logger-console`, `logger-jsonl`, `logger-ring`, ... each mounted by its **own roster row**, independently configurable, independently disableable, disposable with its plugin |

Nothing else. A plugin that wants to log **calls the service**; a plugin that
wants logs to *appear* mounts an **exporter**.

## The Message

One emitted call produces one `Message`, delivered to every mounted exporter:

```ts
interface Message {
  sn: number        // process-wide sequence number
  ts: number        // epoch ms
  name: string      // the logger name (the plugin name unless the caller named it)
  type: 'error' | 'warn' | 'info' | 'debug'
  level: number     // 0 error, 1 warn, 2 info, 3 debug
  args: unknown[]
  fiber?: { name?: string }   // the emitting plugin
}
```

`logger-jsonl` writes exactly this projection (`{sn,ts,name,type,level,args}`) as
one JSON object per line, so a deployment can `jq` the structure instead of
parsing rendered prose. Errors keep `name`/`message`/`stack`; cycles become
`[circular]`; the depth is bounded.

## Levels

`error 0 < warn 1 < info 2 < debug 3`. The **exporter** decides what it accepts:
each sink declares `levels: { default: <threshold>, <logger-name>: <threshold> }`
(built with `exporterLevels(level, names)`) and the service drops every Message
below the threshold for that sink - per sink, so two sinks can run at different
levels in the same process. The default when a sink omits `level` is `info`:
`debug` is invisible until a deployment asks for it.

```yaml
plugins:
  logger-console: { level: info }
  logger-jsonl:   { level: debug, path: /var/lib/workbench/logs/workbench.jsonl }
```

## Mounting a sink (the only way output is produced)

```ts
// core/logger-<sink>/index.ts
import { loggerOf, mountExporter, exporterLevels, messageToJson } from '../../definitions/logger.ts'

export function apply(ctx, config = {}) {
  const mounted = mountExporter(ctx, {
    levels: exporterLevels(config.level),          // what this sink accepts
    export(message) { /* stdout, a file, a buffer, ... */ },
  }, 'logger-<sink>')
}
```

`mountExporter` registers the sink through `ctx.logger.exporter(...)`, which is a
cordis `effect`: **unload / reload / disable the plugin and the sink is gone**,
with no manual bookkeeping. The wrapper adds the isolation cordis does not give
(a throwing `export()` propagates to the emitter in cordis - measured): every
call is guarded, the first failure per sink is reported once on stderr, later
ones are only counted, and the emitter plus the other sinks are never affected.

## Consuming the service

```ts
import { loggerOf } from '../../definitions/logger.ts'

const log = loggerOf(ctx, 'my-plugin')   // once, in apply()
log.info('listening on', port)           // not console.log(...)
log.error('call failed:', err)           // not console.error(...)
```

* the handle is **typed** (`error|warn|info|debug`) - no `ctx.logger?.info?.()`
  guessing, the service is present on every workbench context;
* with a host that has no logger service the handle is **silent**, never a
  `console` fallback: "no sink mounted = no output" is the model;
* a name is always attached, so a `Message` says *which* plugin emitted it.

## Adding a new sink

1. create `core/logger-<sink>/` with `index.ts`, `workbench.plugin.json` and
   `README.md`;
2. manifest: `capabilities: [{ "id": "logger", "version": 1, "provider": "<sink>" }]`
   and `policies: { "logger": { "provide": "logger@1" } }` (a `provider` id must
   have a definition module - `definitions/logger.ts` is it);
3. `mountExporter(ctx, sink, 'logger-<sink>')` in `apply()`, `levels` from config;
4. add a row to the roster (`config.yml` in dev, the deployment config in prod);
5. add a unit test (`test/logger.test.ts`) that mounts it and asserts the
   emitted lines.

**Never** add a sink, formatter or exporter to the core: the core hosts the
service only. And never grow a sink into a monolith - one exporter = one plugin.

## What the core still prints (documented exceptions)

The model is "no sink, no output", and the core keeps only the prints that
cannot go through the service:

* the **CLI's own output** (`workbench plugins`, `workbench credentials`,
  `workbench reconcile`, the `serve` boot summary line and `--help`): that is
  command output on stdout, not logging - a user piping it must not need a sink
  plugin to see the answer;
* **one stderr line per failing sink/emit** (`reportOnce` in
  `definitions/logger.ts`): the thing that just failed IS the service path, so
  reporting through it would re-enter the broken sink. It names the sink and the
  failure class only, never the Message args, and happens at most once per key
  per process;
* a **fatal config parse error** before the kernel context exists (the CLI
  reports it and exits 1) - there is no service yet at that point.

Everything else - the kernel's deferral notices, the web state, the boot
inventory counts, `host:` lines - goes through `ctx.logger('workbench')`, so it
is visible **only when a sink is mounted**, like any other log line.

## CLI context

The CLI boots the same kernel (`createKernel`), and the kernel installs the
service on its root context before any plugin loads; the CLI itself carries the
kernel context, so `kernel.ctx.logger('workbench')` works there too (the
shutdown and heartbeat lines use it). A plugin always receives a context derived
from that root, which is why `loggerOf(ctx, name)` is never a fallback path.

## Verification (raw runs)

`test/logger.test.ts` covers: level filtering, mount/unmount, a throwing sink not
affecting the others, the `Message` shape and valid JSONL output. The live gates
(no sink -> silence; console at two levels; JSONL lines valid; both at once;
live unmount/remount through `plugin-manager`; a throwing sink; per-plugin
names) are run against a throwaway compose project with this repository as the
EXTERNAL source - see the executor report of the logging task.
