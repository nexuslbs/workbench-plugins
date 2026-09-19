# web-recipe - a durable, per-domain recipe store

`web-recipe` turns "understanding a site" into durable, agent-agnostic knowledge
instead of re-deriving it in every thread. ONE human-readable JSON file per
domain holds the read path, named selectors, discovered JSON/XHR endpoints, the
login flow (by credential **name**), known quirks and provenance. `web-page`
(the JS-aware reader) consults the store FIRST, so a repeated site becomes one
cheap call with API economics; `recipe save`/`recipe verify` keep the knowledge
curated and fresh.

```
plugins: web-recipe:  --provide('web-recipe', service)-->  web-page  (ctx.inject(['web-recipe']))
       |                                                        |
   <dir>/<domain>.json  <-- record (config-gated) ---------------+
                        <-- markVerified (ok/failed) ------------+
```

Nothing in this plugin knows about omniagent, a model or a specific site: the
per-site knowledge lives in the recipe files, never in code.

## What a recipe is

```jsonc
{
  "domain": "github.com",             // the key: a bare host (or host:port)
  "schemaVersion": 1,                 // see "Schema versions" below
  "disabled": false,                  // parked: file kept, reads stop using it
  "readPath": {                       // HOW to read this domain
    "kind": "api",                    //   "api"  -> call an apis[] entry (cheapest)
    "url": "https://api.github.com/repos/{owner}/{repo}",
    "api": "repo",                    //   "render" -> render `url` with these scopes
    "jsonPath": "description",        //   payload location when it is not the body
    "selectors": ["main"],            //   kind: "render" -> CSS scopes for the extractor
    "waitFor": "selector",            //   kind: "render" -> bounded wait before extract
    "notes": "the repo API needs no auth for public repos"
  },
  "selectors": [                      // NAMED selectors, each with its form
    { "name": "stars", "form": "css", "selector": "#repo-stars-counter-star", "description": "star count" },
    { "name": "issue-title", "form": "role", "selector": "heading" },
    { "name": "raw-count", "form": "xpath", "selector": "//span[@id='x']" }
  ],
  "apis": [                           // discovered JSON/XHR endpoints
    {
      "name": "repo",
      "url": "https://api.github.com/repos/{owner}/{repo}",   // {name} placeholders are templated
      "method": "GET",                // GET|POST|PUT|PATCH|DELETE
      "params": { "accept": "application/vnd.github+json" },  // query/body defaults
      "headers": {},
      "credential": "GITHUB_TOKEN",   // a NAME, resolved by the caller at call time
      "credentialHeader": "authorization",
      "jsonPath": "stargazers_count",
      "sampleShape": "{ id, full_name, stargazers_count }",
      "notes": "public repos answer without the token"
    }
  ],
  "loginFlow": {                      // how to log in when a read needs a session
    "url": "https://github.com/login",
    "fields": [
      { "name": "username", "form": "css", "selector": "#login_field" },
      { "name": "password", "form": "css", "selector": "#password", "credential": "GITHUB_PASSWORD" },
      { "name": "submit", "form": "css", "selector": "input[type=submit]" }
    ],
    "credential": "GITHUB_USER",
    "notes": "the CSRF token comes from the form; cookies live in web-session"
  },
  "quirks": "free-form: consent wall on first visit, rate limit 60/h unauthenticated",
  "provenance": {
    "createdAt": "2026-09-19T10:00:00.000Z",
    "updatedAt": "2026-09-19T10:00:00.000Z",
    "lastVerifiedAt": "2026-09-19T10:05:00.000Z",   // set by `recipe verify` / a read-through
    "confidence": 0.3,                              // 0..1, see "Freshness"
    "discoveredBy": "agent",                        // who/what learned it
    "sourceThread": "2415",                          // provenance: the conversation
    "verificationFailures": 0,
    "lastVerificationStatus": "ok",
    "lastVerificationError": "..."                  // only after a failure
  }
}
```

**A recipe never carries a secret VALUE.** Every `credential` field must be an
UPPER_SNAKE **name** (e.g. `GITHUB_TOKEN`); the schema refuses anything else and
refuses any field whose name looks like a secret (`password`, `token`, `secret`,
`api_key`, ...) or whose value looks like a live credential. Values are resolved
by the caller (web-page resolves through `ctx.credentials`) at call time only.

## Storage

* One file per domain: `<dir>/<domain>.json`, deterministic name
  (`github.com` -> `github.com.json`; characters a filesystem may dislike become
  `_`). The file is pretty-printed JSON with a trailing newline, mode `0600`.
* `dir` is configurable (`plugins.web-recipe.dir`); the default is
  `<tmp>/workbench-web-recipe`. The dev config points it at
  `.workbench/web-recipe`, which the repo's `.gitignore` already ignores.
* **Atomic writes**: a `.<name>.json.tmp-<n>` file is written, `fsync`ed and
  `rename`d over the target, so a reader never sees a half-written recipe and a
  crash never leaves a partial document at the real path.
* `recipe list` also reports `problems` (a corrupt/invalid file is listed, not
  swallowed), and a corrupt file never breaks the other recipes.

### Schema versions

`provenance` is the only place a version is not; `schemaVersion` sits at the top
level. On read:

* `schemaVersion === 1` -> validated and returned.
* an OLDER version -> passed through the registered migration chain for that
  version (none are needed yet; the seam exists and is tested).
* a NEWER (or unknown) version -> **refused**, never reinterpreted
  (`RecipeError('schema_version_unknown')`); the tool answers
  `{"status":"error","code":"schema_version_unknown"}` and the store keeps the
  file untouched.

## Tools

Registered through `ctx.workbench.registerTool`, so they are reachable on the
shipped seam (`POST /api/tools/<name>`, `POST /api/tool/call {"tool","params"}`)
and listed by `GET /api/tools` with their JSON schema.

| tool | params | answer |
|---|---|---|
| `recipe get` | `domain` (required), `raw?` | `{status:'ok', domain, file, recipe}` or `{status:'not_found', hint, known[]}` |
| `recipe save` | `domain` (required) + any recipe field (`readPath`, `selectors`, `apis`, `loginFlow`, `quirks`, `disabled`, `confidence`, `discoveredBy`, `sourceThread`, `lastVerifiedAt`), `replace?` | `{status:'ok', domain, file, created, summary, recipe}`; a partial save MERGES into the stored recipe, `replace:true` overwrites it, provenance is updated and a replacement read path resets verification |
| `recipe list` | `limit?` | `{status:'ok', dir, count, recipes:[{domain, readPathKind, apiCount, selectorCount, confidence, lastVerifiedAt, disabled}], problems?}` |
| `recipe delete` | `domain` (required), `mode: disable|purge` | `disable` (default) PARKS the recipe: the file and its provenance stay, the read-through stops using it (`disabled: true`). `purge` removes the file |
| `recipe verify` | `domain` (required), `timeoutMs?` | re-runs the read path, updates `lastVerifiedAt`/`confidence` and answers `{status:'ok'|'failed'|'unverifiable', outcome, summary, provenance}` |

Invalid input is answered as `{status:'invalid', violations:[...]}` (the same
shape the core's `ToolArgsError` uses); a missing `domain` is one of those
violations, never a crash. A failed read answers `{status:'error', code, message}`.

## The read-through contract (how web-page consumes it)

The seam is a **cordis service**, not an import:

* this plugin PROVIDES it: `ctx.provide('web-recipe', service)` where
  `service.contract === 'web-recipe@1'`;
* `web-page` CONSUMES it: `ctx.inject(['web-recipe'], cb)`, then reads
  `ctx['web-recipe']`. A deployment without `web-recipe` simply never gets the
  callback and keeps the plain render path; a service whose `contract` is not
  `web-recipe@1` is refused, again falling back to the normal path. No plugin
  reaches into another plugin's internals and no core contract change is needed.

The service surface (`plugins/web-recipe/index.ts`):

```ts
interface WebRecipeService {
  contract: 'web-recipe@1'
  policy: { minConfidence: number; maxAgeDays: number }
  get(domain): Promise<Recipe | undefined>
  lookup(urlOrDomain): Promise<{ domain, recipe, usable, reason? } | undefined>
  record(discovery): Promise<{ status: 'recorded'|'skipped'|'refused', ... }>
  markVerified(domain, ok, detail?): Promise<Recipe | undefined>
  verify(domain): Promise<{ domain, outcome, recipe? }>
  registerVerifier(verifier): () => void     // a consumer lends its renderer
  list(): Promise<RecipeSummary[]>
}
```

What `web-page` does with it (see `plugins/web-page/README.md`):

1. `lookup(url)` **before** launching a browser. A hit that is `usable` and has
   a `readPath.kind: 'api'` is fetched directly with `fetch` (no browser, no
   render) and answered with `status: 'recipe'`, API economics;
2. a `render` recipe contributes its CSS selectors to the normal render path
   (a caller-supplied selector still wins);
3. a recipe-driven read that FAILS is reported as
   `recipe: { domain, via, status: 'failed', detail, fallback: 'render' }`, the
   store is told via `markVerified(domain, false, detail)`, and the read
   continues on the **plain** render path: the recipe's own selectors are dropped
   for that attempt (they belong to the path that just failed and must not be
   able to fail the read a second time, which would turn a stale recipe into a
   read outage). **A stale recipe never poisons a read**;
4. a credential NAME in `apis[].credential` that this deployment cannot resolve
   is reported (`recipe: { ..., credentialMissing: 'NAME' }`) and the request
   goes out WITHOUT the auth header: a public endpoint answers, a protected one
   answers 401 - which lands in the fallback above with a hint naming the
   credential. A recipe naming an OPTIONAL credential never makes a domain
   unreadable;
5. a read that did NOT come from a recipe is a discovery, and it is written back
   only when `web-page`'s `recipes.record` gate is `true` (default `false`).

## Freshness and decay

`provenance.confidence` (0..1) plus `lastVerifiedAt` are the whole policy:

* a freshly RECORDED discovery starts at `recordConfidence` (default `0.3`) -
  low, because nobody has verified it;
* `recipe verify` (or a successful read-through) raises confidence by
  `demoteStep` (default `0.2`) up to 1 and sets `lastVerifiedAt`;
* a FAILED verification increments `verificationFailures`, records
  `lastVerificationError` and demotes confidence by `demoteStep` (never below
  0) when `demoteOnFailure` is on (default `true`);
* `recipeUsable` ignores a recipe that is `disabled`, has no `readPath`, sits
  below `minConfidence` (default `0.2`) or is older than `maxAgeDays`
  (default `0` = no age limit). The read-through then takes the normal path.

So a recipe that rots is demoted, then ignored - it degrades into `recipe
verify` evidence instead of poisoning reads.

## Configuration

```yaml
plugins:
  web-recipe:
    dir: /opt/workspace/workbench-plugins/.workbench/web-recipe  # default <tmp>/workbench-web-recipe
    minConfidence: 0.2    # below this a recipe is not used by the read-through
    maxAgeDays: 0         # 0 = no age limit since lastVerifiedAt
    demoteOnFailure: true # a failed verification demotes confidence
    demoteStep: 0.2       # how much a verification moves confidence
    acceptRecords: true   # may a consumer record a discovery at all?
    recordConfidence: 0.3 # the confidence a recorded (unverified) recipe starts with
    verifyTimeoutMs: 10000
  web-page:
    recipes:
      enabled: true       # consult the store at all
      record: false       # OFF by default: recipes stay curated, not accidental
      sourceThread: "2415" # optional provenance stamped on recorded recipes
```

## Tests

`test/web-recipe.test.ts` (no network, temp dirs, a fake cordis context):
schema merge + violations, credential-name enforcement, storage round-trip +
atomic rename + `0600` + unknown `schemaVersion` refusal, the `recipe *` tools,
the service lookup/policy gates, discovery-not-overwriting, verification decay,
and the web-page fallback (a broken recipe read still returns the rendered page).

Run: `npm run typecheck && npm test` in `workbench-plugins`.
