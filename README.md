# workbench-plugins

Plugins for the [workbench](https://github.com/nexuslbs/workbench) core.

This repository is consumed as an **external plugin source**: the core does not
contain any of these plugins, it discovers them at boot from a `path` source
(a sibling checkout) or a `git` source pointing at this repository. See
[the plugin contract](https://github.com/nexuslbs/workbench/blob/main/docs/PLUGIN-CONTRACT.md).

## Layout

```
core/                        # the CORE SERVICE IMPLEMENTATIONS (table below)
  <service-plugin>/
    workbench.plugin.json    # manifest (name, version, entry, capabilities, config)
    index.ts                 # entry module (cordis plugin, ESM)
plugins/                     # consumers, operator tools, Web UI plugins
  <plugin-name>/
    workbench.plugin.json
    index.ts
examples/                    # runnable example plugins
definitions/                 # the CONTRACTS (definitions/<capability>.ts): imported by
                             # providers AND consumers, so a provider is swappable by config
```

The rule that decides the tree:

| Tree | What belongs there | Test |
| --- | --- | --- |
| `core/` | an IMPLEMENTATION of a workbench core service: a capability provider (`capabilities: [{id, version, provider}]`) whose contract is a `definitions/` module, or the SERVICE HOST that provides such a contract | it declares a `provider` id, or it hosts a `definitions/` service |
| `plugins/` | everything that CONSUMES a core service: operator tools, UI pages, watchers, feature plugins - including a plugin that provides a cordis-only service with no `definitions/` contract (`web-recipe`) | it imports `definitions/` and registers tools/pages |
| `examples/` | runnable examples, driven by the docs | it exists to be read and run |

## Adding this source to the core

The core repo is core-only by default (it has no dependency on this repository):
declare this source in YOUR config - a sibling checkout during development or a
git coordinate in production:

```yaml
sources:
  # TWO plugin trees -> TWO sources (a source scans exactly ONE directory, and
  # its `id` is what the inventory groups by). Order matters: `core/` first, so
  # the credential providers are discovered before any gated source is resolved.
  - kind: path
    id: workbench-plugins-core
    path: ../workbench-plugins/core      # the core service implementations
  - kind: path
    id: workbench-plugins
    path: ../workbench-plugins/plugins   # local checkout (development)
  # production form (the same split, one git source per subdir):
  # - kind: git
  #   id: workbench-plugins-core
  #   url: https://github.com/nexuslbs/workbench-plugins
  #   ref: main
  #   subdir: core
  # - kind: git
  #   id: workbench-plugins
  #   url: https://github.com/nexuslbs/workbench-plugins
  #   ref: main
  #   subdir: plugins
```

## config.yml - development config for the workbench service

The repository also carries `config.yml`, the DEV config of the compose
workbench service (omni-stack / omni-root `docker-compose.dev.yml` passes it as
`CONFIG_FILE=/opt/workspace/workbench-plugins/config.yml`). It loads the plugins
of THIS repository from TWO local path sources, `./core` (the core service
implementations) and `./plugins` (the consumers / tools / UI), so a plugin under
development is picked up at the next boot with no clone and no push. Production
uses the tracked `config/workbench.yml` of the omni-root stack, where this
repository is a remote git source - there too the split needs one git source per
subdir (`core`, `plugins`).

No core change is needed to add a plugin here: create the plugin directory, and
add its row to the `plugins:` roster of the config of the core that consumes it -
discovery alone does not load it (see below).

## The plugin roster (`sources:` DISCOVERS, `plugins:` LOADS)

INTENTIONAL BREAKING CHANGE, the same contract as the core
([PLUGIN-CONTRACT.md](https://github.com/nexuslbs/workbench/blob/main/docs/PLUGIN-CONTRACT.md),
"Sources, the ROSTER and the `disabled` park"): a plugin discovered in a
configured source is **available**, and it is **loaded only when the config
NAMES it** under `plugins:` - that row is both the selection and the plugin's
config (`{}` is a valid row, so `apply()` must not require optional config).

```yaml
sources:
  - kind: path
    id: workbench-plugins-core
    path: ./core
  - kind: path
    id: workbench-plugins
    path: ./plugins

plugins:                      # the ROSTER (enable list) + per-plugin config
  plugin-inventory: {}
  plugin-manager: {}
  settings: {}
  cordis-ui: {}
  credentials-stub:
    disabled: true            # parked: configured, deliberately off
# EVERY other discovered plugin is `available` - listed, never imported
```

`workbench plugins` and the Plugin Inventory page list every discovered plugin
with its state (`loaded` / `available` / `disabled` / `failed`); `enable`
persists the roster row, `disable` parks it with `disabled: true`. A config
written for the old scan-and-load semantics (a discovered plugin was installed
AND loaded in the same pass) must therefore list every plugin it wants loaded:
in `config.yml` of this repository that is the roster shown there, which names
the plugins of this checkout plus the Web UI plugins (`plugin-inventory`,
`plugin-manager`, `settings`, `cordis-ui`).

## Core services (`core/`) - the core service IMPLEMENTATIONS

Every module that IMPLEMENTS a workbench core service lives under `core/`, so
the core services are visible at a glance. Each row is a plugin directory whose
manifest declares the capability `{id, version, provider}`; the contract it
implements is `definitions/<id>.ts`, and its consumer side stays under
`plugins/`.

| `core/` directory | Capability / provider | What it implements |
| --- | --- | --- |
| `credentials-basic` | `credentials` (`env` / `file` / `project-env` / `user-env`) | the credential providers (the core itself may hold the Definition only) |
| `credentials-github-app` | `credentials` (git auth strategy) | turns an App private key into a short-lived installation token for a gated git source |
| `credentials-stub` | `credentials` (`stub-vault`) | the dev stub vault the docs/tests use |
| `logger-console` | `logger` (`console`) | one logger SINK: human-readable lines |
| `logger-jsonl` | `logger` (`jsonl`) | one logger SINK: one JSON object per line in a file |
| `logger-ring` | `logger` (`ring`) | one logger SINK: a bounded in-memory ring published as the `logs` service |
| `tools-impl` | `tools` (`registry`) | the named-tool registry, the `/api/tools*` seams and the CLI |
| `web-impl` | `web` (`http`) | the HTTP server, the shell and `/health` |
| `web-search-impl` | `web-search` (`registry`) | SERVICE HOST of the web-SEARCH seam: the engine registry (duplicate ids rejected), the selection (named engine -> configured default -> ordered fallback chain -> the single usable engine), the cap and the spill of an oversized result set |
| `web-search-stub` | `web-search` (`stub`) | the OFFLINE engine: deterministic fixtures, NO network, urls under `.invalid`; used by the tests and as the default when no real engine is configured (every answer is marked `stub: true`) |
| `web-search-tavily` | `web-search` (`tavily`) | a REAL HTTP engine (`POST https://api.tavily.com/search`): credential resolved BY NAME (`credential: TAVILY_API_KEY`, `${cred:...}`) at call time, availability is a LOCAL credential check, HTTP 401/403 -> `auth-failed`, 429 -> `rate-limited` |
| `web-search-searxng` | `web-search` (`searxng`) | the REAL engine that needs NO credential: a SearXNG instance's JSON API (`GET <baseUrl>/search?format=json`); `credential` is OPTIONAL (a NAME, sent as a bearer token for a protected instance) |
| `computer-use-impl` | `computer-use` (`registry`) | SERVICE HOST of the computer-USE seam: the driver registry, the selection (named provider -> configured default -> ordered fallback -> the single usable driver), the bounds of one call (screenshot byte cap, deadline, clipboard inline cap) and the optional `sandbox@1` gate; imports no driver and touches no desktop (`execution: none`) |
| `computer-use-x11` | `computer-use` (`x11`) | the X11 DRIVER: screenshot (full/region), pointer (move/click/drag/scroll), keyboard (type/chords), clipboard read/write, window list/focus/close/launch/wait; `target: xvfb` OWNS a headless display and `target: existing` attaches to one, `runner: local`/`docker` decides where the toolchain runs, and every missing binary or unserved action is a typed `not-implemented`/`no-display` error |
| `computer-use-tools` | - | the CONSUMER: the action-enum tool `computer` (`providers` / `open` / `screen` / `screenshot` / `act` / `window` / `wait` / `close`) |
| `browser-use-impl` | `browser-use` (`registry`) | SERVICE HOST of the browser-USE seam: the provider registry (duplicate ids rejected), the selection (named provider -> configured default -> ordered fallback -> the single usable provider), the bounds of one call (snapshot nodes, text chars, screenshot bytes, deadlines, max sessions) and the optional `sandbox@1` gate; it imports no provider and launches no browser (`execution: none`) |
| `browser-use-playwright` | `browser-use` (`playwright`) | the REAL provider on `playwright-core`: isolated browser CONTEXTS per session on the shared refcounted chromium launcher (`shared/browser.ts`), `navigate` + wait strategies, `snapshot` with SHORT STABLE refs (`e12`), `act` (click/type/fill/select/hover/scroll/press/upload/check/focus/back/forward/reload/waitFor), `evaluate`, `extract` (text/markdown/html/table/attributes/links/json, `web-recipe` aware), `screenshot` (a FILE path + bytes, never inline base64), `tabs`, `wait`, request/download `observe`, storage-state save/read/clear; a missing binary is the typed `browser-use.no-browser` naming the exact prerequisite, and the browser/page/profile/timers are released through its `effect()` disposer |
| `browser-use-tools` | - | the CONSUMER: the action-enum tool `browser` (`providers` / `capabilities` / `open` / `navigate` / `snapshot` / `act` / `evaluate` / `extract` / `screenshot` / `tabs` / `wait` / `observe` / `state` / `sessions` / `close`) |
| `shell-impl` | `shell` (`local-bash`) | the LOCAL transport (the only host-running one) |
| `fs-local` | `fs` (`local-fs`) | the LOCAL filesystem: reads unrestricted, WRITES confined to the configured roots; line-numbered paged read, atomic edits, glob/grep with caps + spill (no shell at all) |
| `docker-impl` | `docker` (`docker-compose-cli`) | the container transport |
| `ssh-impl` | `ssh` (`ssh-cli`) | the remote transport |
| `http-impl` | `http` (`fetch`) | a plain HTTP call, no shell at all |
| `general-service-impl` | `general-service` (`config-dispatch`) | the dispatcher that resolves the transport from CONFIG |
| `himalaya-impl` | `himalaya` (`cli`) | the mail-CLI transport |
| `email-himalaya` | `email` (`himalaya`) | the mail contract on top of `himalaya@1` |
| `sms-twilio` | `sms` (`twilio`) | read-only SMS over the Twilio REST API |
| `totp-rfc6238` | `totp` (`rfc6238`) | RFC 4226/6238 TOTP on `node:crypto` HMAC |
| `capabilities-impl` | SERVICE HOST of `totp@1` + `sms@1` | declares the discovered provider ids and provides `ctx.totp` / `ctx.sms` |
| `sandbox-policy` | `sandbox` (`declarative`) | the DECLARATIVE policy provider: per-resource rules decided in process, fail-closed by default, no host access and no `exec` |
| `sandbox-enforce` | `sandbox` (`local-os`) | the ENFORCING provider: decides AND constrains a real child process (namespaces, rlimits, filtered env, pinned cwd, deadline on the process group, output cap) and reports every constraint it could NOT enforce as a gap |

The two trees are discovered through two separate `sources:` (see above) and the
`plugins:` roster names every plugin by NAME (never by path), so moving a plugin
between the trees does not change WHAT loads. `npm run check:seam` scans `core/`
too: a provider may still import only its own directory and `definitions/`, and a
consumer still talks to the Definition, never to a provider plugin.

## Plugins (`plugins/`) - consumers, tools and the UI

| Plugin | Capability | Output |
| --- | --- | --- |
| `hello-otherworld` | `command:hello otherworld` | `Hello Otherworld` |
| `hello-tool` | `tool:hello greet` | by-name tool over HTTP: `POST /api/tools/hello%20greet`, `POST /api/tool/call` (core contract, section 4d) |
| `email-tools` | `tool:email accounts`, `tool:email list`, `tool:email get`, `tool:email code` | email CONSUMER: the four operator tools, provider agnostic (it only touches `ctx.email`) |
| `sandbox-tools` | `tool:sandbox check`, `tool:sandbox policy`, `tool:sandbox run` | sandbox CONSUMER: the inspectable decision surface (`check`), the active policy plus the measured enforcement matrix (`policy`) and an ENFORCED run (`run`) |
| `sandbox-consumer` | `tool:sandbox guarded run` | the REFERENCE consumer: asks for a decision and HONOURS a deny (a refused call never starts a process) |
| `web-page` | `tool:page read`, `tool:page map` | web-page CONSUMER: ONE-call JS-aware page read - chromium render through `playwright-core`, main content to compact markdown IN CODE, URL + content-hash cache (`unchanged since <hash>`), hard char cap with spill to a file; no browser driver, no model in the loop |

### Example plugins for the plugin EVENT API

These three are the runnable specification of `docs/EVENTS.md` (they are NOT in
the default `config.yml` roster - an example binds a TCP port; add a roster row
to load one):

| Plugin | Capability | Output |
| --- | --- | --- |
| `events-demo` | `events:publisher events-demo/{...}` | PUBLISHER: drives `emit` / `serial` / `parallel` / `bail` / `waterfall` incl. a throwing listener; `GET /api/events/demo`, `GET /api/events/demo/audit` |
| `events-subscriber-a` | `events:subscriber events-demo/{...}` | SUBSCRIBER: `on` / `once` per mode, one listener that throws on purpose; `GET /api/events/subscriber-a` |
| `events-subscriber-b` | `events:subscriber events-demo/{...}` | SUBSCRIBER that OWNS EXTERNAL RESOURCES (TCP server, interval, child process) released by `effect()`; `GET /api/events/subscriber-b` |

### Logger plugins (the logger SERVICE + one plugin per SINK)

Logging is a SERVICE plus EXPORTER plugins: never `console.log` sprinkled
around, never a monolithic logger plugin. The core hosts cordis' logger service
(`ctx.logger(name)` yields `{error,warn,info,debug}`, `ctx.logger.exporter(sink)`
mounts an output) and ships NO exporter, formatter or `console.*` call of its
own, so with no sink rostered the process emits NO log line at all. A plugin
always logs through the service (`loggerOf(ctx, name)` from
`definitions/logger.ts`) and prints nothing itself. Contract, Message shape,
level semantics and how to add a sink: `docs/LOGGING.md`.

| Plugin | Capability | Output |
| --- | --- | --- |
| `logger-console` | `logger:console` | human-readable lines: `error`/`warn` to stderr, `info`/`debug` to stdout; config `{ level, names, colors, maxLength }` |
| `logger-jsonl` | `logger:jsonl` | ONE JSON object per line (`{sn,ts,name,type,level,args}`) appended to a file, bounded rotation; config `{ level, names, path, maxBytes, maxFiles }` |
| `logger-ring` | `logger:ring` | bounded in-memory ring published as the `logs` service and readable over the web seam (`GET /api/logs`, `GET /api/logs/tail`, `POST /api/logs/clear`); config `{ level, names, size, path, routes }` |
| `logger-demo` | `logger:demo` | NOT a sink: the drive surface (`GET /api/logger/demo?count=N&name=<logger>&level=<level>`) used by the docs and the live gates |

Every sink is independently mountable, independently configurable and
independently disableable, and a failure in one is ISOLATED by the Definition's
`mountExporter` wrapper (it cannot reach the emitter or the other sinks);
unloading its plugin removes it, because the mount is a cordis `effect`.
`test/logger.test.ts` covers the level filter, the Message shape, mount/unmount,
the throwing-exporter isolation, the JSONL validity and the ring bounds.

### Web UI plugins (M1-M4)

The browser-based workbench UI is composed **only** of plugins: each one
registers its HTTP routes, its page module and its nav entry through the core's
`ctx.web` seam (`docs/PLUGIN-CONTRACT.md`, section 7). Removing a plugin from
the config removes its surface; the server keeps booting and serving the rest.

| Plugin | Surface | Page | API |
| --- | --- | --- | --- |
| `plugin-inventory` | loader inventory (read-only) | `/plugin-inventory` | `GET /api/plugin-inventory[/plugins]` |
| `plugin-manager` | install / enable / disable / retry / reload / compose | `/plugin-manager` | `GET /api/plugin-manager/state`, `POST /api/plugin-manager/action` |
| `settings` | active config file + per-plugin config, edit + persist | `/settings` | `GET /api/settings`, `GET /api/settings/plugins`, `GET /api/settings/plugin-config?name=`, `POST /api/settings/patch` |
| `cordis-ui` | live cordis runtime (services, fibers, loader) + manage | `/cordis-ui` | `GET /api/cordis-ui/runtime`, `POST /api/cordis-ui/action` |
| `config-watch` | config-file WATCHER: an EXTERNAL edit of the active config is applied live (reload + reconcile), debounced, with self-write suppression | (state endpoint) | `GET /api/config-watch/state`, `POST /api/config-watch/apply` |

The UI is served by the core (`npm run web`, or `workbench serve` with
`web.enabled: true`); the plugins only contribute routes, assets and pages. No
framework, no bundler, no build step at runtime: the page modules are plain ES
modules served from the plugin directory.

**Secrets**: the `settings` surface shows config references BY NAME only
(`${cred:NAME}`, `${env:VAR}`) and never resolves them.

### Tool plugins (by-name invocation)

A plugin can register a named **tool** (a description, the parameters it expects
and a handler) through `ctx.tools.registerTool` (the `tools@1` seam, provided by
the `tools-impl` plugin of this repository); the provider then exposes it for
invocation BY NAME over HTTP with the parameters as the request body. This is
NOT a model/agent feature: the callers are plugins and operators. The contract is
`docs/PLUGIN-CONTRACT.md` section 4d of the core.

| Plugin | Tool | Parameters | Routes |
| --- | --- | --- | --- |
| `hello-tool` | `hello greet` | `name` (string, required), `greeting` (string), `times` (integer) | `GET /api/tools`, `POST /api/tools/hello%20greet`, `POST /api/tool/call` |
| `email-tools` | `email accounts` | `format` (string, enum `labels` / `full`) | same seam: `GET /api/tools`, `POST /api/tools/email%20accounts`, `POST /api/tool/call` |
| `email-tools` | `email list` | `account` (string), `folder` (string), `limit` (integer), `unreadOnly` (boolean), `since` (string) | same seam |
| `email-tools` | `email get` | `id` (string, required), `account` (string), `format` (string, enum `text` / `markdown` / `raw`) | same seam |
| `email-tools` | `email code` | `account` (string), `id` (string), `query` (string), `pattern` (string), `maxAgeSeconds` (integer) | same seam |
| `web-page` | `page read` | `url` (string, required), `query` (string), `selectors` (array of string), `max_chars` (integer), `freshness` (string, enum `cache` / `revalidate` / `force`) | same seam (plugin README, "The two tools") |
| `web-page` | `page map` | `url` (string, required), `max_chars` (integer) | same seam |
| `web-search-tools` | `web search` | `query` (string, required), `count` (integer), `language` (string), `freshness` (string or integer), `safe` (boolean), `site` (string), `engine` (string) | same seam (normalized results: `title`/`url`/`snippet`/`rank`/`published`/`engine`, plus `engine`/`provider`/`took_ms`/`truncated`/`spill_path`; caps + spill when `spill@1` is loaded) |
| `web-search-tools` | `web search providers` | none | same seam (introspection: every registered engine with its configured/available state and the reason it cannot run, plus the selection in effect and the config row to add) |
| `computer-use-tools` | `computer` | `action` (string, enum `providers` / `open` / `screen` / `screenshot` / `act` / `window` / `wait` / `close`), `provider` (string), `kind` (string, enum `move` / `click` / `drag` / `scroll` / `type` / `key` / `copy` / `paste`), `x`/`y`/`fromX`/`fromY`/`toX`/`toY` (integer), `button` (string, enum `left`/`middle`/`right`), `clicks` (integer), `direction` (string, enum `up`/`down`/`left`/`right`), `amount` (integer), `durationMs`/`delayMs` (integer), `text` (string), `chord` (string), `keyAction` (string, enum `press`/`down`/`up`), `selection` (string, enum `clipboard`/`primary`), `format` (string, enum `png`/`jpeg`), `quality` (integer), `label` (string), `path` (string), `regionX`/`regionY`/`regionWidth`/`regionHeight` (integer), `windowAction` (string, enum `list`/`focus`/`close`/`launch`/`wait`), `title`/`id`/`command`/`waitTitle` (string), `args` (array of string), `ms`/`timeoutMs`/`maxImageBytes` (integer) | same seam (a `screenshot` answers a FILE PATH plus mime/size, byte-capped, never inline base64) |
| `browser-use-tools` | `browser` | `action` (string, required, enum `providers` / `capabilities` / `open` / `navigate` / `snapshot` / `act` / `evaluate` / `extract` / `screenshot` / `tabs` / `wait` / `observe` / `state` / `sessions` / `close`), `provider`/`session`/`url`/`selector`/`ref`/`expression`/`value`/`key`/`path`/`label`/`filter`/`locale`/`timezoneId`/`userAgent`/`stateFile`/`downloadDir`/`urlContains`/`text`/`mode`/`waitUntil`/`stateAction`/`tabAction`/`kind`/`direction`/`format`/`state` (string), `headless`/`allowHttpError`/`includeText`/`byLabel`/`settle`/`snapshot`/`awaitPromise`/`useRecipe`/`fullPage`/`navigate`/`networkIdle`/`checked` (boolean), `viewportWidth`/`viewportHeight`/`maxNodes`/`maxChars`/`maxBytes`/`timeoutMs`/`ms`/`amount`/`quality`/`index`/`limit` (integer), `files`/`attributes`/`args` (array) | same seam (a `snapshot` answers SHORT refs `e12` that `act`/`extract`/`screenshot` accept on a LATER call; a ref from an older snapshot is a typed `browser-use.stale-ref`, a missing browser a typed `browser-use.no-browser`; a `screenshot` answers a FILE PATH plus bytes, never inline base64) |
| `sandbox-tools` | `sandbox check` | `resource` (string, required), `operation` (string), `path` (string), `argv` (array of string), `shell` (boolean), `cwd` (string), `envNames` (array of string), `network` (json), `bytes` (integer), `wallTimeMs` (integer), `approvalGranted` (boolean) | same seam (raw decision + active policy) |
| `sandbox-tools` | `sandbox policy` | none | same seam (active policy + enforcement matrix) |
| `sandbox-tools` | `sandbox run` | `argv` (array of string, required), `cwd` (string), `resource` (string), `env` (object), `envNames` (array of string), `stdin` (string), `timeoutMs` (integer), `maxOutputBytes` (integer), `approvalGranted` (boolean) | same seam (enforced run, needs an enforcing provider) |
| `sandbox-consumer` | `sandbox guarded run` | `argv` (array of string, required), `cwd` (string), `resource` (string), `network` (json), `approvalGranted` (boolean) | same seam (decision honoured; deny -> nothing runs) |

The smoke for this end-to-end (the plugin registers a tool, the core lists it
with its schema, invokes it, validates the body and returns 400/404/500 without
restarting) is `test/hello-tool.test.ts` here plus the core's `test/tools.test.ts`.

The email capability seam (core contract, section 4e) is covered by
`test/email-himalaya.test.ts` (the provider driven against a stub `himalaya`
executable: accounts, list, get, credential-in-env-only, missing CLI, failing
and unparseable output) and `test/email-tools.test.ts` (the four tools, their
schemas, the default-account resolution and a provider swap).

The `web-page` plugin is covered by `test/web-page.test.ts`: the extractor on
fixture HTML, the cache/hash decision, the cap/spill path, the error envelope and
the two registered tool schemas driven through a fake renderer (no browser and no
network in the tests). Its chromium is a DEPLOYMENT input (`playwright-core` plus
an installed browser), never a test dependency.

The web-SEARCH seam is covered by `test/web-search.test.ts`: result
normalization and ranking (rejected hits counted, never silently dropped), the
cap and the spill payload, engine selection incl. the ordered fallback chain and
an explicit `engine`, the typed NOT-CONFIGURED error (which names the roster row
to add) versus a legitimately empty result set, the provider introspection, the
Tavily engine driven against a fake `fetch` (401/403, 429, non-JSON body, an
unreachable host) and the stub's determinism. No network in the tests.

The computer-USE seam is covered by `test/computer-use.test.ts`: the pure
contract helpers (input normalization, the error codes and the typed
`not-implemented` mapping), the service host (registry, selection, caps, the
typed failure when no driver is usable and the hint naming the roster row to
add), the consumer tool driven against a fake capability (action routing, the
screenshot answer as a path + byte cap, an unavailable action as a typed error)
and ONE live test that runs the real X11 driver against a display it owns
(`Xvfb` + `openbox`): screenshot bytes, a pointer move/click, keyboard input
proven by the window's own output and the window list. That live test SKIPS -
naming the missing binaries - when the host has no X11 toolchain, and
`COMPUTER_USE_LIVE=0` disables it explicitly.

The browser-USE seam is covered by `test/browser-use.test.ts`: the pure contract
helpers (ref shape, the typed reason table), the service host (registry, the
selection incl. an UNKNOWN and an UNAVAILABLE provider, the bounds and the
engine-honesty report), the consumer tool driven against a fake provider (ref
ROUND-TRIP: the ref a `snapshot` answers is what `act` accepts on the next call;
a stale ref is a typed `browser-use.stale-ref` and nothing is clicked; the whole
session lifecycle; the screenshot answer as a path plus the byte cap; a missing
`web-recipe` service; the unload disposer) and ONE live test that drives a REAL
browser against a LOCAL fixture page served in-process (`open` -> `snapshot` ->
`act` -> `extract` -> `screenshot` -> stale-ref -> `close`). That live test SKIPS
- naming the exact prerequisite (a chromium binary via `executablePath` or
`PLAYWRIGHT_BROWSERS_PATH`) - when the host has no browser; `BROWSER_USE_LIVE=0`
disables it explicitly.

## Plugin events and effects (`events@1`)

A plugin gets the deepseek-harness style event surface and a lifecycle-bound
`effect()` from `lib/events.ts`, typed by `definitions/events.ts`:

```ts
import { createEvents } from '../../lib/events.ts'

export const name = 'email-watcher'
export function apply(ctx: any) {
  const events = createEvents(ctx, { namespace: name })

  events.on('received', (message) => {/* ... */})        // gone when this plugin unloads
  events.once('email-watcher/started', () => {/* ... */})
  events.emit('polled', { at: Date.now() })              // fire and forget
  await events.serial('email-watcher/poll', {}); /* stop at the first answer */
  await events.parallel('email-watcher/poll', {}); /* all together, isolated */
  events.bail('email-watcher/who', {}); /* first answer wins */
  events.waterfall('email-watcher/parse', raw, () => 'done'); /* value threading */

  events.effect(() => {                                  // release on unload / shutdown
    const timer = setInterval(() => events.emit('polled'), 30_000)
    return () => clearInterval(timer)
  })
}
```

- Modes: `on` / `once` / `off` / `emit` / `serial` / `parallel` / `bail` /
  `waterfall`. The DISPATCH ENGINE is the host's cordis `EventsService` (not
  re-implemented); this repository adds the typed contract, the event NAME
  convention (`<namespace>/<event>`, reserved `internal/`, `plugin/`, `events/`,
  collision detection), the missing `off`, ERROR ISOLATION (a throwing listener is
  logged and never kills the emitter, the other listeners or the process) and the
  `waterfall` value threading. See `docs/EVENTS.md` for the per-mode semantics.
- Auto-unsubscribe: subscriptions are bound to the registering plugin's FIBER
  (cordis' own fiber effect), the scope checks `disposed` before every call, and
  every registration returns an IDEMPOTENT disposer - no leaked handler, no call
  after unload, no listener growth over load/unload cycles.
- `effect(callback)`: the callback acquires now and returns the releaser(s);
  disposers run EXACTLY ONCE, LIFO, isolated (a throwing one is logged and the
  rest still run), async ones awaited with a bound, on plugin unload AND on
  SIGTERM/SIGINT (`shutdown: false` opts out). This is THE recommended way to
  release HTTP agents/sockets, DB pools, fs watchers, timers, subprocesses and
  browser contexts.

Documents: `docs/EVENTS.md` (contract, semantics, examples, verification).
Tests: `test/events.test.ts` (the layer) and `test/events-plugins.test.ts` (the
three example plugins end to end, incl. the REAL release of a socket, a child
process and an interval).

## Develop / verify

```bash
npm install
npm test          # node --test test/*.test.ts
npm run typecheck
```

The plugin tests use a fake context (they do not need the core): the plugin only
depends on the documented `ctx.workbench` service, which is exactly what the
test simulates.

## License

MIT.
