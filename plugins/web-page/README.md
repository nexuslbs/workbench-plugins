# web-page

One-call, **JS-aware page read** for the agent: render a URL that needs
JavaScript, distil it to compact markdown in CODE, cap it, cache it by content
hash. Two tools, no browser driver.

```
page read   url (required), query?, selectors?, max_chars?, freshness?
page map    url (required), max_chars?
```

This is the cheap single-shot READ path. It is deliberately NOT a browser
driver: `mcp-playwright` already covers clicking/typing/screenshots (24 tools,
multi-step orchestration). Here a React/Vue/Angular page is read in ONE call,
the HTML never reaches a caller's context, and a repeat visit costs ~20 tokens.

## Why it exists

| path | cost of one docs landing page |
| --- | --- |
| the 24-tool browser surface | ~3.6k tokens, several calls, browser + orchestration in the loop |
| this plugin | one call, distilled markdown, capped, cached (`unchanged since <hash>` on a re-read) |

No model, no LLM summarizer, no vision: the plugin is deterministic and
agent-agnostic, which is what keeps the result cheap and reproducible.

## How chromium is provided (dependency choice)

The only runtime dependency is **`playwright-core`**, not `playwright`:

- `playwright` bundles a browser downloader and its own toolchain; workbench
  needs neither. The browser is a **deployment input**, not a hidden side effect
  of `npm install`.
- `playwright-core` is imported **dynamically inside the render path**, so a
  plugin whose browser is missing still LOADS and answers a structured error
  instead of taking the process down with an import failure.

Chromium is therefore supplied by the deployment, in either of two ways:

1. **Standard playwright browser cache** - the deployment image runs
   `npx playwright install --with-deps chromium` (or uses
   `mcr.microsoft.com/playwright:v1.63.0-noble`) and leaves
   `PLAYWRIGHT_BROWSERS_PATH` at its default (`~/.cache/ms-playwright`), or
2. **A system chromium** - config `executablePath: /usr/bin/chromium`.

Local dev (this repo) uses the throwaway project `wb2428` in
`/opt/workspace/tmp/2428`: `npm ci` + `npx playwright-core install chromium`
(the browser download works through the same registry), browser cache under
`/opt/workspace/tmp/2428/browsers` (`PLAYWRIGHT_BROWSERS_PATH`).

## Config

Rows under the plugin's `config:` block in the deployment config
(`config.yml` in dev, `/opt/omni/config/workbench.yml` in production):

| key | default | meaning |
| --- | --- | --- |
| `cacheDir` | `<tmp>/workbench-web-page` | page cache root |
| `cacheTtlSeconds` | `900` | how long an entry counts as fresh |
| `maxChars` | `8000` | default cap of a returned body |
| `hardMaxChars` | `60000` | cap a caller can never exceed |
| `spillDir` | `<cacheDir>/spill` | where capped-away text is written |
| `mapMaxChars` | `4000` | default cap of a `page map` outline |
| `navigationTimeoutMs` | `20000` | `page.goto` budget |
| `actionTimeoutMs` | `6000` | bounded settle budget (network idle + content-quiet loop) |
| `retries` | `1` | extra navigation attempts after a transport failure |
| `waitUntil` | `domcontentloaded` | playwright wait condition for `goto` |
| `executablePath` | - | a chromium binary; absent: playwright resolves it |
| `browserArgs` | `--no-sandbox --disable-dev-shm-usage --disable-gpu` | extra chromium argv |
| `userAgent` | - | override the UA |
| `maxContexts` | `2` | reusable contexts kept warm |
| `blockResourceTypes` | `image, media, font` | never downloaded (a text read needs none) |
| `proxy` | - | `{ server, username?, credential? }`; `credential` is a **NAME** |
| `redact` | - | strings replaced by `[redacted]` in every error message/diagnostic |

**Secrets**: `proxy.credential` (and the `username`) is a credential NAME. It is
resolved at launch time through `ctx.credentials` (`${cred:NAME}` semantics) and
is never logged, never returned, never written to the cache or a spill file. The
resolved value is ALSO added to the redaction set of the renderer, so a browser
or launch error text that happens to quote it is scrubbed before it is surfaced.

`redact` (config) is the operator side of the same mechanism: every listed
string is replaced by `[redacted]` in the message, url and detail of any failure
leaving `page read` / `page map` (plain text match, case sensitive).

## The two tools

### `page read`

```json
{ "url": "https://example.com/docs", "query": "installation", "max_chars": 4000, "freshness": "cache" }
```

Returns:

```json
{
  "status": "rendered",
  "url": "https://example.com/docs",
  "finalUrl": "https://example.com/docs/",
  "title": "Docs",
  "hash": "sha256:1a2b...",
  "chars": 3987,
  "estimatedTokens": 997,
  "markdown": "# Docs\n\n...",
  "truncation": { "capped": true, "shownChars": 3987, "totalChars": 18342, "spillFile": "/.../spill/docs-1a2b.md" },
  "query": { "terms": ["installation"], "blocks": 3, "matchedChars": 1204 },
  "cache": { "state": "render", "ageSeconds": 0 },
  "render": { "attempts": 1, "elapsedMs": 1421 }
}
```

An unchanged page is answered in ~20 tokens instead of the body:

```json
{ "status": "unchanged", "url": "...", "hash": "sha256:1a2b...", "cache": { "state": "hit", "ageSeconds": 42 } }
```

`freshness`:

| value | behaviour |
| --- | --- |
| `cache` (default) | a fresh entry answers immediately; a stale one re-renders (after a conditional HTTP revalidation when possible) |
| `revalidate` | always try `If-None-Match` / `If-Modified-Since` first; a **304** proves the page did not change and NO browser is launched |
| `force` | always re-render, never answer `unchanged` |

`selectors` (e.g. `["main", ".article-body"]`) restrict extraction; they take
part in the cache key, so `selectors`-scoped reads never collide with whole-page
reads.

`query` slices the extracted markdown plugin-side (deterministic term scoring,
heading context preserved) BEFORE the char cap, so a keyword question about a
huge page returns the slice, not the page.

### `page map`

Returns the OUTLINE only: title, headings (level + text), per-section char
counts, and links (absolute URLs), under the same cache and cap. Use it to
decide what to read. `page map` output never contains the body.

## Cache semantics

- Key: `sha256(url + "\u0000" + selectors.join(","))`.
- Entry: the extracted markdown, its `sha256` **content hash**, the outline, the
  ETag/Last-Modified when the response carried them, `fetchedAt`, HTTP status.
- An entry older than `cacheTtlSeconds` is stale: `cache` re-renders,
  `revalidate` tries the conditional request first (a 304 refreshes the entry
  and answers `unchanged`, no browser).
- After a render, the NEW markdown is hashed: an identical hash answers
  `unchanged since <hash>` (the entry's `fetchedAt` is refreshed) - that is how
  a re-read of a live page costs ~20 tokens. `freshness: force` bypasses it.
- Entries are JSON files under `cacheDir`; a corrupt entry is dropped, never
  fatal.

## Budgets and failure envelope

- Hard char cap on every answer (`max_chars`, clamped to `[200, hardMaxChars]`).
  When the cap bites, the FULL text is written to a **spill file** named in
  `truncation.spillFile`; the caller reads it with a file tool instead of
  flooding its context.
- Navigation, settle and revalidation each have their own timeout, so a hung
  page can never stall a caller.
- Failures raise a structured, NAMED error and leave the process serving:
  `invalid_input`, `timeout`, `dns`, `tls`, `connection`, `http_status`,
  `extract_empty`, `browser_unavailable`, `cache`, `internal` - with `url`, `hint`
  and a `retryable` flag where it applies (`browser_unavailable` also names a
  missing chromium/playwright-core install).

## Wiring

The plugin is a directory in `nexuslbs/workbench-plugins` with the usual
manifest (`workbench.plugin.json`) and entry (`index.ts`); it registers its two
tools through `ctx.workbench.registerTool` and closes its browser through the
cordis effect disposal. The dev config carries one `plugins:` row for it, so the
repo's local `sources: path` entry picks it up - external git sources keep
working unchanged (this plugin is never vendored into the core).

## Tests

`node --test test/web-page.test.ts` - fixture-driven, no network and no browser:

- the extractor (fixture HTML -> markdown), nav/footer/boilerplate removal,
  determinism;
- the cache decision (miss/hit/stale/TTL/freshness) and content hash stability;
- the cap/spill path (a small cap writes a spill file with the full text);
- the error mapping (timeout/DNS/TLS/non-2xx/empty extractor);
- the registered tool schemas through a fake `ctx`.
