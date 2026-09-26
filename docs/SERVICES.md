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
`FsSandboxPolicy` (`denied` / `writeRoots` / `readRoots` / `readOnly`), either
from its own `sandbox:` config block or from a `sandbox@1` service when one is
loaded (`sandboxPolicyFrom(ctx)`). BOTH are resolved on EVERY read/write, never
once at apply time: plugins apply in discovery order, so `fs-local` is always
applied BEFORE any `sandbox-*` provider is provided, and a policy cached at apply
time silently ignored the provider's deny (thread 2553). Every policy in force is
INTERSECTED, so a policy only NARROWS the configured roots.

A `sandbox@1` DENY is HONOURED, never silently ignored. The mapping from the
provider's constraint view (`policyFor`) to this seam is:

| provider view | fs seam |
| --- | --- |
| the resource rule or the defaults refuse `fs` (`deny: true`), or the provider is fail-closed (`unconfigured: deny`) and the view comes from no rule and no defaults | `denied: true`: the READ and the WRITE are both refused (`fs.outside-root`, `details.denied`), and nothing reaches the disk (thread 2556) |
| an explicit `writeRoots: []` | grants NO write root, so every write is refused |
| `readRoots: []` | no read confinement (the documented meaning is kept, the two sides are not overloaded) |
| `readOnly: true` | every write is refused |
| any other narrowing | intersected with the configured roots; a write inside them still works |

Which policy a
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
## Web search capability (`web-search@1`)

`definitions/web-search.ts` is the SEARCH seam: a provider plugin registers an
ENGINE (`ctx['web-search'].register(provider)`) and a caller asks the service for
a NORMALIZED result list. The caller never imports an engine and never sees
provider-shaped JSON.

| role | plugin | provider | what it does |
| --- | --- | --- | --- |
| Definition | `definitions/web-search.ts` | - | the contract, the PURE helpers (`normalizeResults`, `applyCountCap`, `searchSpillPayload`, `freshnessToDays`, `resolveCount`) and the typed `WebSearchError` |
| Service host | `core/web-search-impl` | `registry` | the ENGINE REGISTRY (duplicate ids rejected), the SELECTION, the cap and the spill |
| Provider (offline) | `core/web-search-stub` | `stub` | deterministic fixtures, NO network, urls under `.invalid`, `stub: true` in the answer |
| Provider (real) | `core/web-search-tavily` | `tavily` | `POST https://api.tavily.com/search`; the credential is resolved BY NAME from `credentials@1` at call time |
| Provider (real, KEY-FREE) | `core/web-search-searxng` | `searxng` | `GET <baseUrl>/search?format=json` on a SearXNG instance; no credential needed (an OPTIONAL `credential` NAME is sent as a bearer token for a protected instance) |
| Tools / consumer | `plugins/web-search-tools` | - | `web search` and `web search providers` |

SELECTION (the FIRST usable engine wins): an explicit `engine` in the request ->
the configured `provider` -> the ordered `fallback` chain -> with NOTHING
configured, the single USABLE engine (several usable and none configured is
`web-search.ambiguous`). A NAMED engine that cannot run is an error, never a
silent fallback. Availability is a cheap LOCAL check (does the credential
resolve), never a network call, so `web search providers` is fast and safe.

A CONFIGURATION GAP is a TYPED error, never an empty result list:
`web-search.not-configured` (nothing usable) and `web-search.provider-unavailable`
(the engine exists but cannot run) both name the credential NAME and the roster
row to add, and `web search providers` distinguishes that gap from a query that
legitimately found nothing.

```yaml
web-search-impl:
  provider: stub           # the offline default; `searxng`/`tavily` for a real engine
  fallback: []             # tried in order when the configured engine is not USABLE
  count: 5                # default results per call
  maxCount: 20            # hard ceiling of `count`
  maxChars: 12000         # inline budget of the result list; the overflow is SPILLED
  spill: true             # hand the overflow to `spill@1` when it is loaded
  timeoutMs: 15000
web-search-stub: { results: 3 }
web-search-searxng: { baseUrl: http://searxng:8080 }   # a JSON-ENABLED instance (self-hosted)
web-search-tavily: { credential: TAVILY_API_KEY }   # a NAME through `credentials@1`
web-search-tools: {}
```

Caps and spill: the answer carries the ranked results inline, and when the set
does not fit `maxChars` the FULL set is written through `spill@1` and the answer
carries `spill_path` (read it back with `spill read`). Without `spill@1` the
answer SAYS the rest was dropped - it never invents a path.

Adding an engine: a new plugin whose manifest declares
`{id: web-search, version: 1, provider: <id>}`, an `apply(ctx)` calling
`ctx['web-search'].register(...)` (`id`, optional `engine`, `stub`, `filters`,
`available()`, `unavailableReason?()`, `search(request, options)`), and a roster
row. No change to the Definition, the host or the tools.

Credentials: the repo carries NAMES only (`${cred:TAVILY_API_KEY}` /
`credential: TAVILY_API_KEY`). A deployment without that credential still boots,
keeps the stub as its engine and reports the missing NAME.

Which engine the dev roster selects, and why: the deployment holds NO search-engine
key (the credential store has `GITHUB_APP_KEY`, `HOSTINGER_EMAIL_PASSWORD` and the
`WBSESSION_*` pair, and the process environment has none), so the keyed engines
(including `tavily`) are UNUSABLE until an operator adds a NAME. Consequently the
shipped roster keeps `provider: stub` - deterministic fixtures, `stub: true`, no
socket - as the DEFAULT a keyless deployment answers with, and
`web search providers` names the row to flip for a real engine.

SearXNG is the one engine of the task's list that needs no key, and it is the
key-free real-engine path: `provider: searxng` plus a JSON-ENABLED instance as
`baseUrl`. MEASURED on 2026-09-20: every PUBLIC instance probed refuses the JSON
API - searx.be answers HTML (-> `web-search.bad-response`) and the others answer
429/403 (-> `web-search.rate-limited` / `web-search.auth-failed`) - which is why
the shipped roster stays on `stub` and a working deployment points `baseUrl` at
its OWN instance (or adds `credential: <NAME>` for an instance that wants a
bearer token). The engine's HTTP path (normalization, a filter -> query string,
a status -> typed error) is covered by the mocked-fetch unit tests.

## Computer-use capability (`computer-use@1`)

`definitions/computer-use.ts` is the seam for CONTROLLING a desktop: an agent
takes a screenshot, moves/clicks/drags/scrolls the pointer, types text and key
chords, reads and writes the clipboard, lists/focuses/launches/closes windows
and waits for readiness - all through ONE typed contract. The shape follows the
DeepSeek harness `computer-use` group (MIT, see `THIRD_PARTY.md`): ONE
capability, a PROVIDER that talks to a real display, a SERVICE HOST that selects
among providers, and a CONSUMER that exposes it as a tool. The core repo stays
untouched.

| role | plugin | provider | what it does |
| --- | --- | --- | --- |
| Definition | `definitions/computer-use.ts` | - | the typed model (screen info, region/pointer, mouse, keyboard, clipboard, window requests and answers), the typed errors (`computer-use.no-display`, `not-permitted`, `timeout`, `not-implemented`, `invalid-input`, `oversized`, `ambiguous`), the pure normalizers (`normalizeRegion`, `normalizePointer`, `normalizeChord`) and the shared caps |
| Service host | `core/computer-use-impl` | `registry` | owns the driver registry, the selection (`provider` -> configured default -> ordered `fallback` -> the single usable driver), the bounds of one call (screenshot byte cap, deadline, clipboard inline cap), the delegation of an unimplemented half as a typed `not-implemented` and the OPTIONAL `sandbox@1` gate. It imports no driver and touches no desktop (`execution: none`) |
| Provider | `core/computer-use-x11` | `x11` | the real driver on X11: `target: xvfb` STARTS a headless display it owns (killed by its disposer, optionally with `openbox`), `target: existing` attaches to `display`/`$DISPLAY` and owns nothing; `runner: local` runs the toolchain where workbench runs, `runner: docker` runs every binary inside `container` through `docker exec`, so the desktop is disposable |
| Tools / consumer | `plugins/computer-use-tools` | - | the action-enum tool `computer` (`providers` / `open` / `screen` / `screenshot` / `act` / `window` / `wait` / `close`) |

Exactly ONE host is mounted (`computer-use-impl`); drivers are separate plugins
that register themselves on `ctx['computer-use']`, so a deployment adds a driver
by adding a row. `computer-use-tools` names NO backend: swapping the driver is a
config edit and the tool schema does not change.

The driver requires these binaries on the runner: `xdpyinfo` (display probe),
`xdotool` (pointer, keyboard, window fallback), ImageMagick `import`
(screenshot), `xclip` (clipboard) and `wmctrl` (precise window list/activate/
close), plus `Xvfb` and a WM (`openbox`) for `target: xvfb`. It PROBES every one
of them at startup and in `providers`: a missing binary turns its actions into a
typed `computer-use.not-implemented` / `computer-use.no-display` naming what is
missing - never a silent no-op and never a fabricated result.

Screenshots are captured on the tool's stdout and written by the DRIVER to
`screenshotDir` (default `<tmpdir>/workbench-computer-use`), so the `local` and
`docker` runners behave identically: the answer is a PATH with mime and size
(bounded by `maxImageBytes`), never unbounded base64.

Config (see `config.yml` and the two plugin READMEs): the host takes `provider`,
`fallback`, `screenshotDir`, `maxImageBytes`, `timeoutMs`, `maxTextChars`; the
driver takes `target`, `runner`, `display`, `container`, `xvfb` (display,
geometry, extra argv), `windowManager`, `screenshotDir`, `typeDelayMs`,
`toolTimeoutMs` and `extraTools`. On a host with no X server the working shape
is `target: xvfb` (optionally with `runner: docker` and a container that has the
toolchain), which is what the dev roster in this repo uses.

The `sandbox@1` gate is an EXTENSION POINT, not a dependency: the host consults
a `sandbox` provider when one is loaded (the request names the target) and
degrades to "no policy handle" when none is - the same optional shape `fs@1` and
`subprocess@1` use.

## Browser-use capability (`browser-use@1`)

`definitions/browser-use.ts` is the seam for DRIVING a real browser: an agent
opens a session, navigates, takes a compact SNAPSHOT whose nodes carry SHORT
STABLE refs, acts on those refs (click / type / fill / select / hover / scroll /
press / upload / check / focus / back / forward / reload / waitFor), evaluates
JS, extracts text / markdown / html / tables / attributes / links / json, takes a
screenshot FILE, manages tabs, waits and observes the requests and downloads of
the session - all through ONE typed contract. The shape follows the DeepSeek
harness `browser-use` group (MIT, see `THIRD_PARTY.md`): ONE capability, a
PROVIDER that owns a browser, a SERVICE HOST that selects among providers, and a
CONSUMER that exposes it as a tool. The core repo stays untouched.

| role | plugin | provider | what it does |
| --- | --- | --- | --- |
| Definition | `definitions/browser-use.ts` | - | the typed model (engine info, provider capabilities, session spec/info, snapshot + refs, navigate/act/evaluate/extract/screenshot/tabs/wait/observe/state requests and answers), the typed reasons (`browser-use.no-browser`, `stale-ref`, `timeout`, `navigation-failed`, `selector-not-found`, `not-implemented`, `unknown-provider`, `provider-unavailable`, `oversized`, `session-missing`, `invalid-input`, ...), the pure helpers (bounds resolution, viewport/URL/ref validation, slugging) and the shared caps |
| Service host | `core/browser-use-impl` | `registry` | owns the provider registry (duplicate ids rejected), the selection (`provider` -> configured default -> ordered `fallback` -> the single usable provider), the bounds of one call (snapshot nodes, text chars, screenshot bytes, deadlines, max sessions), the typed failure when nothing is usable, and the OPTIONAL `sandbox@1` gate. It imports no provider and launches no browser (`execution: none`) |
| Provider | `core/browser-use-playwright` | `playwright` | the REAL provider on `playwright-core`: one refcounted chromium launcher shared with `web-page`/`web-session` (`shared/browser.ts`), an ISOLATED browser CONTEXT per session id (viewport, locale, timezone, user agent, proxy, downloads, storage state), a snapshot that mints stable `e12` refs, ref-resolving actions with the page-change -> `stale-ref` rule, extract with `web-recipe`, screenshot written to a file with a byte cap, tab management, request/download observation, storage-state save/read/clear, and an `effect()` disposer that closes every context, the browser and the profile/temp dirs it owns |
| Tools / consumer | `plugins/browser-use-tools` | - | the action-enum tool `browser` (`providers` / `capabilities` / `open` / `navigate` / `snapshot` / `act` / `evaluate` / `extract` / `screenshot` / `tabs` / `wait` / `observe` / `state` / `sessions` / `close`) |

Exactly ONE host is mounted (`browser-use-impl`); providers are separate plugins
that register themselves on `ctx['browser-use']`, so a deployment adds a browser
backend by adding a row and the tool schema does not change.

REUSE BOUNDARY: the seam does NOT fork a second browser stack. `web-page` (the
one-call renderer), `web-session` (ONE action-enum tool with persistent sessions
and change deltas) and `web-recipe` (the per-domain recipe store) keep their
tools and behaviour; `browser-use-playwright` shares their chromium LAUNCHER
(`shared/browser.ts`, refcounted, one browser process per host) and consults
`web-recipe` from `extract` when that service is loaded (a missing recipe never
fails the call: the answer carries `recipe.used: false`). A consumer that wants a
one-shot render should keep calling `page read`; `browser` is for INTERACTION.

ENGINE HONESTY: `capabilities` reports the engine actually used (`engine`), its
binary (`executablePath`) and whether it is launchable RIGHT NOW (`available`),
plus the exact `requirement` when it is not. There is NO silent fallback: a
missing browser is the typed `browser-use.no-browser` naming the prerequisite
(install the chromium build, or point `executablePath` at one), never a plain
HTTP fetch pretending to be a browser.

The `sandbox@1` gate is an EXTENSION POINT, not a dependency: the host consults a
`sandbox` provider when one is loaded (the session opens a browser, so the
request names the network/download roots) and degrades to "no policy handle" when
none is - the same optional shape `fs@1`, `subprocess@1` and `computer-use@1` use.

SCREENSHOT LOCATION: `screenshot` answers a PATH, never inline base64, and that
path is ALWAYS ABSOLUTE. The caller (omniagent) reads the file back in its own
container/filesystem namespace, so a path resolved against whatever CWD the core
was started in is useless (and can even be ENOENT). Precedence: an explicit
`path` in the call wins, then the provider's own `screenshotDir`, then the
`screenshotDir` bound of the `browser-use-impl` row, then the seam default
`<tmpdir>/workbench-browser-use`. An oversized image is deleted and reported as
the typed `browser-use.oversized`, never handed over.

DEPLOYMENT MODEL: the browser is a SEPARATE IMAGE (operator decision,
telegram thread 2593: "the browser image is a separate image, not the workbench
image"). The published `ghcr.io/nexuslbs/workbench` image stays BROWSER-FREE: it
ships no chromium and no browser cache. A deployment runs ONE browser service
from its own image - the browser service image published FROM the omni-images
repository as `ghcr.io/nexuslbs/omni-images/browser:X.Y.Z` (source `browser/`,
publishing workflow `.github/workflows/publish.yml` on a `browser-*` tag, built
FROM `mcr.microsoft.com/playwright:vX-noble`; any image shipping chromium works
too) - and the provider ATTACHES to it over CDP. The service is
declared - and, when it does not answer yet, STARTED - through the
`general-service@1` seam, so the transport (container / ssh / shell / http) is
CONFIG, never a hard-wired docker or ssh call inside the provider.

```yaml
browser-use-impl:                 # the service host
  provider: playwright            # -> plugins.browser-use-playwright row
  fallback: []
browser-use-playwright:           # the provider: it OWNS NO BROWSER
  headless: false                 # the service runs a REAL headful chromium on Xvfb
  viewport: { width: 1280, height: 720 }
  browserService:
    endpoint: http://127.0.0.1:9222   # where the browser image answers (or a ws:// CDP URL)
    image: ghcr.io/nexuslbs/omni-images/browser:0.0.4
    generalService: { type: container, params: { container: workbench-browser } }
    start: '<start chromium with --remote-debugging-port=9222>'
    startTimeoutMs: 20000
  storageStateDir: <tmp>/workbench-browser-use/state
  screenshotDir: <tmp>/workbench-browser-use
```

`browserService.endpoint` is the SAME attach endpoint as the bare `wsEndpoint`
(`cdpEndpoint` is a documented alias of it): the block only adds the IMAGE, the
`general-service@1` instance and the START command, so ONE shared browser is
brought up and named in every answer. When the endpoint does not answer, the
provider runs the `start` command THROUGH the instance ONCE, waits up to
`startTimeoutMs` and retries the attach; the path taken is reported in the call
(`browserServiceStart`: attempted / type / command / code / output / waitedMs /
connected). If it still does not answer, the call fails with the typed
`browser-use.endpoint-unreachable` naming the endpoint, the image, the instance
and the requirement - **never** a silent local launch and **never** an HTTP
fetch pretending to be a browser. `browser-use.no-browser` is the typed answer
when the deployment names no browser at all (no `browserService`, no
`wsEndpoint`, no binary); the plugin still loads (no boot failure). A
`browserService.endpoint` written as a NAME (`http://browser:9222`) is resolved to
its IP before the attach - chromium rejects DevTools requests whose `Host` header
is not an IP or `localhost` - so the compose service-name form is a valid
deployment value; the CONFIGURED endpoint stays the one named in the typed error.

LOCAL ALTERNATIVES (not the default): a chromium binary reachable through
`executablePath`, the `PLAYWRIGHT_BROWSERS_PATH` cache, or a system chromium.

INTROSPECTION INSTEAD OF GUESSING: the `browser` tool publishes its FULL
per-action contract - every action with its parameter NAMES, types, units,
required/optional and one-line descriptions - through the seam an agent already
reads (`GET /api/tools/browser`, the tool catalog, and the `schema` action of
the tool itself; `{ action: schema, schemaFor: act }` narrows it to one action).
Every duration field is in MILLISECONDS and the schema says so; DOCUMENTED
ALIASES are accepted for the names callers really write (`text` -> `value` on
`act`, `milliseconds` / `ms` -> the wait duration, `storageStateFile` /
`storageState` -> the `open` storage-state field, `timeout` -> `timeoutMs`),
the canonical name WINS when both are given, and a genuinely unknown parameter
is the typed `not-implemented` error listing every accepted key and alias.

STALE REFS SELF-HEAL: an `act` whose ref no longer matches the DOM re-snapshots
ONCE, re-resolves the target (by ref, else by role+name / selector / label) and
retries the action; the answer carries `retried: true` and the path taken. Only
when that fails is it the typed `browser-use.stale-ref`, and that error carries
the FRESH refs of the re-snapshot, so a caller can retry against the current DOM
instead of guessing. A `timeout` on a control the call DID resolve names the
element and the REASON (visible but disabled / covered / zero-size) when the
evidence is available, instead of a bare timeout.

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

`plugins/email-tools` registers, through `ctx.tools.register(defineTool(...))` (the `tools@1`
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
