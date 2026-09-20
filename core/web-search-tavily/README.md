# web-search-tavily - the real search engine (`web-search@1`, provider id `tavily`)

The HTTP engine of the web-search capability: one POST to the Tavily `/search`
endpoint, the vendor payload handed to the seam for normalization, every HTTP
failure mapped onto the typed `web-search.*` reasons.

## The key is never a value here

- the config carries the credential **NAME** (`credential: TAVILY_API_KEY` by default):
  the config file, the logs, the manifests and the answers only ever hold the name;
- the value is resolved **at call time** through `credentials@1`
  (`ctx.credentials.resolve({ name })`), so this plugin loads fine in a deployment
  with no key: `available()` is then false and both `web search providers` and a
  failed call name the credential and the credentials file to add it to;
- any vendor text echoed into an error is scrubbed of the key before it leaves the module.

## Availability is a local check

`available()` only asks the credential store (a local read). It never calls the
network, so `web search providers` is fast and cannot hang on an unreachable
engine; network problems belong to the CALL (`web-search.network`).

## Status mapping

| HTTP / failure | reason |
| --- | --- |
| 401, 403 | `web-search.auth-failed` |
| 429 | `web-search.rate-limited` |
| any other non-2xx | `web-search.provider-error` |
| connection refused / DNS / TLS | `web-search.network` |
| deadline exceeded | `web-search.timeout` |
| body is not JSON, or has no `results` array | `web-search.bad-response` |

## Filters

The engine honours `freshness` (mapped to the vendor's `days`) and `site` (mapped
to `include_domains`). A requested filter it does not honour (`language`, `safe`)
is reported in the answer's `ignoredFilters` by the seam - never pretended.

## Wiring

```yaml
plugins:
  # the seam host: point the default at this engine
  web-search-impl:
    provider: tavily
    fallback: [stub]        # optional: keep the offline engine as a fallback
  web-search-tavily:
    credential: TAVILY_API_KEY
```

Then put the value in the credentials file the `credentials-basic` row points at
(`/opt/workspace/workbench-secrets/credentials.yml` in dev):

```yaml
TAVILY_API_KEY: <the key>
```

and reload the service (the roster/config is read at boot; `config-watch` applies
a live edit to the config FILE, a new credential file entry needs the provider to
re-read it, so a restart is the predictable path).

## Verification without a key

`npm test` in this repository runs the whole HTTP path against a LOCAL mock
server (`test/web-search-tavily.test.ts`): the request body, the normalization,
and every status mapping above are exercised with no key and no internet access.
