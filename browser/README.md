# The browser service (a SEPARATE image)

The workbench core image is **browser-free**: no chromium, no playwright browser
cache, no `PLAYWRIGHT_BROWSERS_PATH`. Driving a real browser is a **deployment
input**, exactly like a plugin source:

* run ONE browser service from its OWN image (below), and
* point the `browser-use-playwright` provider at it through
  `browserService.endpoint` (the `wsEndpoint` / `cdpEndpoint` alias) - the
  provider ATTACHES over CDP, it never launches a local browser when a service is
  configured.

Operator ruling (telegram thread 2593): *"the browser image is a separate image,
not the workbench image. It could be accessible using GeneralService"*.

This directory lives in **`nexuslbs/workbench-plugins`** (it was moved here out of
the core repo, which keeps only its own `deploy/` material): the browser service
is part of the browser capability of the plugins repository, and it is published
by THIS repository's own workflow.

## The image

`Dockerfile` here builds the service: `FROM mcr.microsoft.com/playwright:v1.63.0-noble`
plus `start-browser.sh`, which runs the image's own chromium with
`--remote-debugging-port=9222`. Nothing workbench-related is inside it.

```sh
docker build -t wb-browser:local browser
docker run --rm -p 127.0.0.1:9222:9222 wb-browser:local
curl -fsS http://127.0.0.1:9222/json/version    # {"Browser":"Chrome/153...."}
```

`.github/workflows/browser-publish.yml` publishes the SAME Dockerfile as
`ghcr.io/nexuslbs/workbench-plugins/browser:X.Y.Z` (and `:latest`) when a tag
**`browser-X.Y.Z`** is pushed - the image tag is the tag name with the `browser-`
prefix stripped (`browser-0.0.1` -> `ghcr.io/nexuslbs/workbench-plugins/browser:0.0.1`).
That workflow is the ONLY publisher of this image, and a `browser-*` tag is its
ONLY trigger; the core image's `publish.yml` in `nexuslbs/workbench` no longer
builds any browser image.

`browser/docker-compose.yml` runs it as its own compose project:

```sh
docker compose -f browser/docker-compose.yml -p workbench-browser up -d
```

The upstream `mcr.microsoft.com/playwright:v1.63.0-noble` image is an equally
valid browser service if you prefer the vendor artifact; the shipped Dockerfile
only adds the container entrypoint (chromium already listening on 9222).

## Wiring a deployment to it

```yaml
plugins:
  general-service-impl: {}      # reaches the service (any transport)
  docker-impl: {}               # type: container
  browser-use-impl: { provider: playwright }
  browser-use-playwright:
    browserService:
      endpoint: http://browser:9222          # or ws://browser:9222/
      image: ghcr.io/nexuslbs/workbench-plugins/browser:0.0.1
      generalService: { type: container, params: { container: workbench-browser } }
      start: "sh -lc 'start-browser'"        # started ONLY when the endpoint is silent
      probe: "curl -fsS http://127.0.0.1:9222/json/version"
  browser-use-tools: {}
```

* `endpoint` is where the service answers; the provider connects with
  `chromium.connectOverCDP`.
* `generalService` is the `general-service@1` instance (`local` / `container` /
  `ssh` / `ssh+container` / `http`) used to START or PROBE the service when the
  endpoint does not answer yet - the transport is CONFIG, the provider never
  hard-wires docker or ssh.
* No `browserService` and no `wsEndpoint`: the provider behaves as before (a
  local chromium if one exists), and with no local chromium the call fails with
  the typed `browser-use.no-browser` naming the prerequisite.
* A configured service that never answers fails with the typed
  `browser-use.endpoint-unreachable` (endpoint, image, general-service instance
  and the start attempt in the error) - **never** a silent local launch and never
  a silent HTTP fetch pretending to be a browser.

## Scaling / sharing

One service can serve every session: each workbench session gets its own browser
CONTEXT on the shared browser (`isolation` in the provider config), so
storage-state isolation, `snapshot` refs and cookie separation are unchanged.
