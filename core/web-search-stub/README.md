# web-search-stub - the offline search engine (`web-search@1`, provider id `stub`)

The deterministic, networkless engine of the web-search capability. Its whole job
is to make the seam provable before an operator has chosen (and paid for) a real
engine: the `web search` tool answers, the provider registry is visible in
`web search providers`, and the integration tests are hermetic.

## What it does

- same query -> same titles, urls and snippets, byte for byte, on any host, at any time
  (the fixed `results` count and the fixed publication date are part of the fixture);
- urls live on the RFC 6761 `.invalid` TLD (`https://stub.invalid/fixtures/<slug>/result-<n>`),
  which can never resolve, so a fixture can never be mistaken for a fetched page;
- every answer carries `stub: true` and the service host adds
  "these are deterministic fixtures, not live web content" to the answer note;
- `site` is the one filter it honours (it shapes the fixture host) - every other
  requested filter is reported in the answer's `ignoredFilters`, never pretended.

## Config

```yaml
web-search-stub:
  results: 3           # fixtures for a call that names no count (max 50)
  latencyMs: 0         # artificial delay, to exercise a slow engine
  unavailable: false   # take the engine offline (available() -> false)
  failWith: null       # force a typed failure, e.g. web-search.rate-limited
```

`unavailable: true` and `failWith` are the NEGATIVE-CONTROL switches: they are how
an operator (or a test) proves that a broken engine produces a typed error instead
of an empty result list.

## Wiring

The engine is a plugin of `core/`; it registers itself with the `web-search@1`
service host (`core/web-search-impl`) through `ctx.inject(['web-search'], ...)`,
so its own row and `web-search-impl`'s row are both required in the roster:

```yaml
plugins:
  web-search-impl:
    provider: stub
  web-search-stub: {}
```

Swapping to a real engine is a config edit on `web-search-impl.provider` (plus the
engine's own row); this plugin is not imported by anybody - the contract lives in
`definitions/web-search.ts` and `npm run check:seam` enforces that direction.
