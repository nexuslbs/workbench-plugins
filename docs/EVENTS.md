# Plugin events (`events@1`) and `effect()`

The plugin-facing event surface of this repository, plus the lifecycle API a
plugin uses to release the external resources it owns (sockets, pools, timers,
subprocesses, browser contexts).

This is what the operator asked for in telegram thread 2517: the
deepseek-harness style surface - `on`, `once`, `off`, `emit`, `serial`,
`parallel`, `bail`, `waterfall` - with subscriptions that **disappear when the
owning plugin is unloaded**, and an **`effect()`** whose returned disposer runs
when the plugin unloads or the process shuts down.

> Everything lives in THIS repository. The core
> ([nexuslbs/workbench](https://github.com/nexuslbs/workbench)) is UNTOUCHED by
> this feature: no core file, no core API and no core change is needed (see
> ["Host contract"](#host-contract-no-core-change) below).

## Files

| Path | Role |
| --- | --- |
| `definitions/events.ts` | the typed CONTRACT: `EventScope`, `Listener`, `Disposer`, `EventsError`, the name convention, `LIFECYCLE`, `isAnswer`, `qualify` |
| `lib/events.ts` | the runtime: `createEvents(ctx, options)` (one scope per plugin), `eventsRegistry()`, `installShutdownHooks()` |
| `plugins/events-demo` | example PUBLISHER: drives every mode, exposes a drive + audit route |
| `plugins/events-subscriber-a` | example SUBSCRIBER (incl. a listener that throws on purpose) |
| `plugins/events-subscriber-b` | example OWNER OF EXTERNAL RESOURCES (TCP server, interval, child process), released by `effect()` |
| `test/events.test.ts` | the layer's unit tests (every mode, error isolation, disposers) |
| `test/events-plugins.test.ts` | the three example plugins driven end to end through a fake host |

## Quick start

A plugin creates ONE scope, binds it to its own fiber, and registers everything
through it:

```ts
import { createEvents } from '../../lib/events.ts'

export const name = 'email-watcher'

export function apply(ctx: any, config: any = {}) {
  // One scope per plugin. `ctx` is the cordis Context the core hands to THIS
  // plugin (its own fiber), so every registration below is unloaded with it.
  const events = createEvents(ctx, { namespace: name })

  // A subscription: gone when this plugin is unloaded.
  events.on('received', (message) => console.log('mail from', message.from))

  // ... another plugin's event, by full name:
  events.on('email-watcher/polled', () => {/* ... */})

  // Fire and forget on our own namespace:
  events.emit('polled', { at: Date.now() })

  // An EXTERNAL resource: the callback ACQUIRES now and returns the RELEASE.
  events.effect(() => {
    const timer = setInterval(() => events.emit('polled'), 30_000)
    return () => clearInterval(timer) // runs on unload / shutdown, exactly once
  })
}
```

An `apply()` that returns a value may also `return createEvents(...).dispose`,
but the scope is bound to the plugin's fiber anyway: when the core unloads the
plugin it disposes the fiber, which disposes the scope (see
[Auto-unsubscribe](#automatic-unsubscribe-on-plugin-unload)).

## API reference

`createEvents(ctx, { namespace, logger?, strictNamespaces?, disposeTimeoutMs? })`
returns an `EventScope` (class `PluginEvents`):

| Member | Semantics |
| --- | --- |
| `on(name, listener, options?)` | subscribe; returns an **idempotent** `unsubscribe()` (calling it twice is safe) |
| `once(name, listener, options?)` | subscribe for a single dispatch; same disposer |
| `off(name, listener?)` | remove one listener, or every listener of `name` when `listener` is omitted; returns how many were removed |
| `emit(name, ...args)` | fire and forget: run every listener NOW, ignore results, never throw |
| `serial(name, ...args)` | `await` every listener ONE AFTER ANOTHER; stop at the first **answer**; returns it (or `undefined`) |
| `parallel(name, ...args)` | `await` every listener CONCURRENTLY; resolves when all settled; caller-visible errors are reported, never thrown |
| `bail(name, ...args)` | synchronous first-answer-wins; the winning listener's value is returned |
| `waterfall(name, value, next?)` | thread `value` through the listeners; a listener calls `next(newValue?)` to continue; may **abort** by returning without calling `next` |
| `effect(callback, options?)` | acquire now, release later; returns an idempotent `unsubscribe()` that runs the disposers immediately |
| `listenerCount(name)` / `listeners(name)` | what THIS scope registered for `name` (audit / tests) |
| `declare(names)` | publish names in the process registry so a collision is reported (see [Names](#event-names-ownership-and-collisions)) |
| `dispose()` | run every effect disposer (LIFO) and remove every subscription; idempotent; returns `{ plugin, effects, listeners, errors, first }` |
| `contract` / `namespace` / `disposed` | read-only identity/state |

`options` for `on`/`once` (`EventOptions`):

- `prepend: boolean` - register at the HEAD of the chain (forwarded to the host;
  a prepended listener runs first in `emit`/`serial`/`bail`).
- `declare: boolean` - also DECLARE the name in the process registry, so a
  second plugin declaring the same name is reported as a collision.

`options` for `effect` (`EffectOptions`):

- `label: string` - human label in logs and audits (default: the callback name).
- `shutdown: boolean` (default `true`) - also run this disposer on the process
  SHUTDOWN path (SIGTERM/SIGINT); with `shutdown: false` it runs only on unload.
- `timeoutMs: number` - bound for THIS disposer (default: the scope's
  `disposeTimeoutMs`, itself default 5000 ms).

## Semantics per mode

`isAnswer(value)` is the single "this listener answered" rule, identical to
cordis' `isBailed` and to dsh: a value is an answer when it is **not** `null`,
`undefined` or `false`.

| Mode | Order | Async | Stops when | Returns | A listener that THROWS |
| --- | --- | --- | --- | --- | --- |
| `emit` | registration order (prepended first) | no (results ignored) | never | `void` | logged (`error`), the remaining listeners still run |
| `serial` | registration order, awaited one by one | yes | first answer | that answer, else `undefined` | logged, the chain CONTINUES with the next listener |
| `parallel` | started together | yes | never | `void` | logged, the other listeners are unaffected (never an unhandled rejection) |
| `bail` | registration order | no | first answer | that answer, else `undefined` | logged, the chain CONTINUES; the thrower is not an answer |
| `waterfall` | registration order | no | a listener that returns WITHOUT calling `next` (that is the abort) | the last value: the aborting listener's return, or `next()`'s result at the end of the chain | logged, the chain CONTINUES (the next listener still runs) with the value unchanged |

Two documented differences from the bare host (`ctx.emit` / `ctx.serial` / ...),
both of them ADDITIONS, never replacements:

- **Isolation**: cordis' `emit` has no `try/catch` (one throw aborts the emitter
  and the remaining listeners) and `parallel` rejects with an `AggregateError`.
  Listeners registered through a scope are wrapped: the throw is logged
  (`error`) and swallowed, so the emitter, the other listeners and the process
  survive. R1/4 requires exactly this per mode, and it is tested for all five.
- **Waterfall value threading**: the host shares one argument list and its
  `next()` ignores its arguments. The scope's wrapper threads the value
  (`next(2)` really changes what the following listener receives) and treats a
  non-middleware listener as TRANSPARENT: it may observe and its return value is
  ignored unless it explicitly called `next`. A middleware `next()` called twice
  keeps the host's error.

Everything else - the dispatch loops, the answer rule, the fiber binding, the
`prepend` option - is the HOST's and is not re-implemented here.

## Event names, ownership and collisions

Convention (the cordis one, and the one dsh uses):

```
<namespace>/<event>          e.g.  email/received   plugin/loaded   internal/service
```

- A plugin declares **its own namespace** (normally its plugin name, the
  `namespace` option) and emits only `<its-namespace>/<event>`. The short form
  (`received`) is resolved against the scope namespace by `qualify()`.
- `internal/` belongs to the HOST (cordis lifecycle) and is never emitted by a
  plugin. `plugin/` is this layer's lifecycle namespace, `events/` is reserved
  too: `RESERVED_NAMESPACES = ['internal', 'plugin', 'events']`. Claiming one
  throws `EventsError` with code `reserved-namespace`.
- Malformed names (empty, empty segment, whitespace) throw `EventsError` with
  code `invalid-name`.
- **Collisions are detectable**: with `declare: true` (or an explicit
  `declare([...])`) the name is recorded in the process registry together with
  its owner; a second plugin declaring the SAME full name throws
  `EventsError` code `collision`. Emitting/serving an undeclared name is still
  allowed (events are open) but is not protected by that check - and the
  registry audit (`eventsRegistry().snapshot()`) shows the owners of every live
  event, which is how the example's `/api/events/demo/audit` route reports them.
- Lifecycle events this layer emits on the host bus (`LIFECYCLE`):
  `plugin/loaded` (`{ plugin, namespace }`) and `plugin/unloaded`
  (`{ plugin, namespace, effects, listeners, errors }`).

## Automatic unsubscribe on plugin unload

The mechanism is the HOST's fiber scope, which is exactly why nothing is
re-implemented: cordis' `ctx.on()`/`ctx.once()` register a **fiber effect** that
removes the hook when the calling plugin's fiber is disposed, and the
`EventScope` registers every listener through the host (its own `on`/`once`
delegation), while the scope itself is bound to the same fiber with ONE host
`ctx.effect(() => () => scope.dispose())`.

Consequences (all tested):

- unloading a plugin removes every hook it registered: the listener count on the
  host bus returns to the baseline, a subsequent dispatch does not call it, and
  the process and the OTHER plugins keep working;
- repeated load/unload cycles leak nothing (no `MaxListenersExceededWarning`,
  no growing hook list);
- a call AFTER unload returns immediately: the wrapper checks
  `registration.active` and `scope.disposed` before calling the listener, so even
  a hook retained by a hostile host cannot re-enter a dead plugin;
- explicit unsubscribe works too: `on()`/`once()`/`effect()` return an
  **idempotent** disposer, so calling it twice releases once;
- `scope.dispose()` is idempotent and reports what it did
  (`{ effects, listeners, errors, first }`), which is what makes the audit
  routes and the tests able to prove it.

## `effect()`: releasing external resources

`effect(callback)` is THE recommended way for a plugin to release anything the
cordis container does not own: HTTP keep-alive agents and sockets, DB
connections and pools, fs watchers, timers and intervals, spawned subprocesses,
browser/webdriver contexts (the playwright based plugins), and any other
external handle.

Semantics (all implemented and tested):

1. the callback runs **when it is registered** (it ACQUIRES the resource then
   and returns how to release it, or an array of disposers; `null`/`undefined`
   means "nothing to release");
2. every disposer runs **exactly once**, even when unload and shutdown both
   happen and even when the plugin unregisters it explicitly (the explicit
   `unsubscribe()` runs it, the later unload skips it);
3. at unload, disposers run in **LIFO** order (the last acquired is released
   first), which is the order cordis itself uses for a fiber's effects;
4. a **throwing/rejecting disposer is isolated**: it is logged (`error`, with
   the label) and pushed into `dispose().errors`, and the remaining disposers
   still run - one bad release never blocks the unload, the other plugins or the
   process;
5. an **async disposer is AWAITED**, bounded by `timeoutMs`; a timeout is
   REPORTED (logged + `errors`), never thrown at the caller;
6. an effect registered while a plugin is being applied is bound to that
   plugin's fiber by construction, so nothing can leak on unload;
7. a disposer registered on a SERVICE is disposed when the service is disposed:
   create the scope with the service's own `namespace` and dispose it in the
   service's teardown (`scope.dispose()` awaits the same semantics).

Shutdown: `createEvents` installs the shutdown coordinator by default
(`shutdown: false` opts out). On `SIGTERM`/`SIGINT` it disposes every live scope
(bounded, logged) so the disposers run on a real process shutdown too; the
cores' own exit path then exits with code 0. `installShutdownHooks({ signals,
exit, timeoutMs })` / `uninstallShutdownHooks()` are exported for explicit
control (the tests uninstall them to stay hermetic).

## Example plugins (a runnable specification)

The three example plugins are the copy-pasteable specification of the API and
the evidence surface for the tests and for a live replay. They are NOT in the
default `config.yml` roster (an example binds a TCP port); load them by adding
rows to the consuming config:

```yaml
sources:
  - kind: path
    id: workbench-plugins
    path: ./plugins            # the checkout of THIS repository (external source)

plugins:
  events-demo: {}              # publisher + drive/audit routes
  events-subscriber-a: {}      # subscriber (one listener throws on purpose)
  events-subscriber-b:         # owner of external resources
    port: 12398                #   a real TCP server
    heartbeatFile: /tmp/events-subscriber-b.heartbeat   #   an interval
                               #   + a spawned subprocess
```

| Plugin | What it demonstrates | Surface |
| --- | --- | --- |
| `events-demo` | publishes `events-demo/{tick,serial-work,parallel-work,bail-work,waterfall-work,flaky}`; `flaky` carries a listener that throws | `GET /api/events/demo` (drives every mode, returns the per-mode result), `GET /api/events/demo/audit` (registry snapshot, owners, host hook counts) |
| `events-subscriber-a` | `on`, `once`, `serial`, `parallel`, `bail`, `waterfall`, and one listener that throws | `GET /api/events/subscriber-a` (its counters) |
| `events-subscriber-b` | `effect()` releasing a REAL TCP server, a REAL interval and a REAL child process | `GET /api/events/subscriber-b` (counters + what was released) |

Reading the drive route tells the story of the modes in one call: `serial`
stops at the first answer (`a:payload-1`), `parallel` finishes in less than the
sum of the listener delays, `bail` returns the first non-false answer, the
throwing listener of `flaky` is logged while the other listeners still run, and
`waterfall` returns the value the last middleware threaded. Unloading a
subscriber removes its handlers (the audit route's counts go back) while the
publisher and the other subscriber keep answering; unloading `events-subscriber-b`
closes its socket (a connection is then REFUSED), kills its child and stops its
interval.

## Host contract (no core change)

The scope needs only what a cordis plugin context already offers, read
STRUCTURALLY (nothing is imported from the core, exactly like
`definitions/support.ts` does for the service stack): `on`, `once`, `emit`,
`serial`, `parallel`, `bail`, `waterfall`, `effect`, plus an optional `logger`
and the `events._hooks` bookkeeping. When a richer dispatcher is missing the
scope falls back to the synchronous `emit`, so the surface degrades gracefully
instead of failing.

Therefore: **no core change**. `definitions/events.ts` and `lib/events.ts` are
importable by both providers and consumers on this side of the seam, and
`npm run check:seam` stays green (a definition depends on `node:` and its own
siblings only; no plugin imports the core repo).

## Verify

```bash
npm run typecheck            # tsc -p tsconfig.json
npm test                     # node --test test/*.test.ts
npm run check:seam           # no plugin imports the core; definitions stay clean
```

`test/events.test.ts` covers the layer itself: each mode incl. the
stop/return-value semantics and one throwing listener per mode, `once`, `off`,
double dispose, auto-unsubscribe, listener count after unload, the registry
collision, and the effect semantics (LIFO, exactly once, throwing isolated,
async awaited, timeout reported). `test/events-plugins.test.ts` drives the three
example plugins end to end against a fake host and proves the real release of
the socket, the child process and the interval.
