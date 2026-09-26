# `browser-use-playwright` - the `browser-use@1` provider `playwright`

The REAL half of the `browser-use@1` seam: it drives a real chromium through
`playwright-core` - session lifecycle, navigate, the compact SNAPSHOT with
SHORT STABLE refs, the full act vocabulary (click/type/fill/select/hover/
scroll/press/upload/check/focus/waitFor/back/forward/reload), `evaluate`,
readable `extract` (text/markdown/html/table/attributes/links/json), FILE
screenshots, tabs, waits, downloads/network observation and storage-state
reuse. The host (`core/browser-use-impl`) owns the registry/selection/bounds;
this plugin owns a chromium and the sessions a caller drives.

## WHERE the browser runs is CONFIG, never code (the himalaya pattern)

The plugin is **location-agnostic**, exactly like the himalaya impl plugin:
it never decides where the browser runs and it does NOT know what transport
types the `general-service@1` seam supports (local / container / ssh / http
are the GENERAL SERVICE's concern, never this plugin's). The config row names
the `browserService.generalService` instance (`type` + `params`) and the plugin
passes it through UNCHANGED - if the general service starts supporting a new
transport type, this plugin needs NO change. `wsEndpoint` /
`browserService.endpoint` name the CDP endpoint the provider ATTACHES to; a
browser service that does not answer yet is started/probed through the seam
instance the config names. The provider never hard-wires docker, ssh or http.

## Config

```yaml
plugins:
  browser-use-playwright:
    # The browser is a SEPARATE service (its own image), CDP attach.
    # The endpoint is where the service answers; the `generalService` instance
    # is the seam that probes/starts it when the endpoint does not answer yet.
    # The instance is passed through UNCHANGED: its `type` (container / ssh /
    # http / ...) is the GENERAL SERVICE's vocabulary, not this plugin's.
    browserService:
      endpoint: http://browser:9222
      image: ghcr.io/nexuslbs/omni-images/browser:0.0.4
      generalService:
        type: container
        params:
          engine: docker-compose
          compose: { project_dir: ${env:OMNI_DIR}, service: browser }
      start: /usr/local/bin/start-browser --background
      startTimeoutMs: 20000
```

A bare `wsEndpoint`/`cdpEndpoint` (no `browserService`) is plain CDP attach: the
endpoint IS the browser, and no seam instance is involved. With no endpoint at
all, the provider launches a local chromium (`executablePath` or the playwright
cache).

## Honesty

A deployment without a browser fails with the typed `browser-use.no-browser`
error naming the exact prerequisite, and an unreachable configured endpoint
fails with the typed `browser-use.endpoint-unreachable` naming the endpoint,
the image and the seam instance - NEVER a silent fallback to a local launch or
to a non-browser HTTP fetch. Every answer carries the provider and the engine
that produced it.

## Reuse

The chromium process comes from the SHARED launcher of the repository
(`shared/browser.ts`, refcounted), so `web-page`, `web-session` and this
provider never launch competing browsers. Storage state uses the SAME
convention as `web-session` (`<stateDir>/<session>.json`, reuse on open,
persist on close).