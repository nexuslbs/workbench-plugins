# `web-search-searxng` - the key-free REAL search engine

Provider `searxng` of the `web-search@1` contract (`definitions/web-search.ts`).
One plugin = one engine, and this one talks to a **SearXNG** instance over its
JSON API:

```
GET <baseUrl>/search?q=<query>&format=json[&count=&language=&time_range=&safesearch=&categories=&engines=]
```

It is the engine the deployment can actually use today: the workbench credential
store holds **no search-engine key** (only `GITHUB_APP_KEY`,
`HOSTINGER_EMAIL_PASSWORD`, `WBSESSION_USER`, `WBSESSION_PASSWORD`), the process
environment has none either, and SearXNG is the one engine from the task's list
that answers **without a key**. The keyed engines (`core/web-search-tavily`)
stay shipped and simply report themselves `available: false` until an operator
adds the credential NAME.

`baseUrl` defaults to a public instance (`https://searx.be`); point it at your
OWN instance for regular use (public instances rate-limit shared clients and many
disable the JSON API entirely - a `403` there is `web-search.auth-failed` and the
error says so).

## What it does and does not do

- It returns the instance's `results` array **as the vendor shaped it**: the
  `web-search@1` seam normalizes (title / url / snippet / published), ranks,
  fills `engine` and counts the entries it had to skip.
- Every HTTP failure is a **typed** `web-search.*` reason: `401/403`
  `auth-failed`, `429` `rate-limited`, DNS/TLS/refused `network`, a non-JSON body
  (an instance with the JSON API disabled answers HTML) `bad-response`, and 0
  results whose `unresponsive_engines` are all dead `provider-error` - never a
  silent empty list.
- Availability is a **LOCAL** check: no `credential` configured -> usable; a
  `credential` configured -> a credential-store read. It never opens a socket, so
  `web search providers` cannot hang on an unreachable instance.
- No host execution, no browser, no scraping: this is an API call.

## Config

```yaml
web-search-searxng:
  baseUrl: https://searx.be        # your own instance for regular use
  # credential: SEARXNG_TOKEN      # ONLY for a protected instance (a NAME)
  timeoutMs: 15000
  maxResults: 20
  # safesearch: 1                  # unset: safe:true -> 1, safe:false -> 0
  # categories: general
  # engines: duckduckgo,brave
```

Filters the engine declares and honours: `language`, `freshness` (`time_range`),
`safe` (`safesearch`), `site` (the `site:` operator). A filter the request asks
for that the row cannot honour is reported in `ignoredFilters` of the answer.

## Credentials

The repository carries credential **NAMES only**. A protected instance is
configured with `credential: <NAME>` and the value is resolved at call time
through `credentials@1`; it is never written to the config, a log, an answer or a
commit. A key-free instance needs no row here at all.
