# The browser service image (a SEPARATE image, never the workbench image)

This directory holds the packaging material of the **browser service image** of the
workbench project. It carries **no workbench code and no workbench dependency**:
chromium (from the official playwright image), a raw TCP forwarder, and a tiny
entrypoint. The workbench core image (`ghcr.io/nexuslbs/workbench`) ships **no
browser at all** - driving a real browser is a *deployment input*, exactly like a
plugin source.

Operator decision (telegram thread 2593): *"the browser image is a separate image,
not the workbench image. It could be accessible using GeneralService"*.

## Files

| file | what it is |
| --- | --- |
| `Dockerfile` | `FROM mcr.microsoft.com/playwright:v1.63.0-noble` + the entrypoint and the forwarder, `EXPOSE 9222` |
| `start-browser.sh` | the entrypoint: finds chromium, runs it on a loopback port, runs the forwarder on `0.0.0.0:9222`, refuses to report success until the CDP endpoint really answers, then supervises both |
| `cdp-forward.js` | a ~60-line raw TCP proxy (`0.0.0.0:9222` -> `127.0.0.1:9223`); it exists because chromium binds loopback only (below) |
| `docker-compose.yml` | runs the image as its OWN compose project (`workbench-browser`) |

## Build and run it

```sh
docker build -t wb-browser:local browser         # or: docker build -t wb-browser:local .
docker run --rm -p 9222:9222 wb-browser:local
curl -fsS http://127.0.0.1:9222/json/version     # {"Browser":"Chrome/153...."}
```

As its own compose project (the published image by default):

```sh
docker compose -f browser/docker-compose.yml -p workbench-browser up -d
```

## Why the image needs a forwarder (why `--remote-debugging-address` is not enough)

Chromium binds its DevTools HTTP/WebSocket server to **loopback only**:
`--remote-debugging-address=0.0.0.0` is **ignored** by current builds. Measured on the
Chromium 153 shipped in `mcr.microsoft.com/playwright:v1.63.0-noble`:

```
$ docker run -d --rm wb-browser:local ; docker exec <ctr> \
    sh -c 'awk \'$4=="0A"{print $2}\' /proc/net/tcp'
0100007F:2406          # 127.0.0.1:9222 - and nothing else
$ docker exec <ctr> curl -s -o /dev/null -w '%{http_code}' http://<container-ip>:9222/json/version
000                    # refused: nothing listens on the container IP
```

Passing `--user-data-dir` makes no difference, and neither does dropping the other
flags. A browser **service** whose CDP endpoint only answers on its own loopback is
useless: the consumer runs in ANOTHER container and reaches this one by IP or
through a published port. So the image runs two processes:

```
chromium       127.0.0.1:${BROWSER_CDP_INTERNAL_PORT:-9223}   (loopback, its own)
cdp-forward.js 0.0.0.0:${BROWSER_CDP_PORT:-9222}  -->  chromium
```

The forwarder is a plain TCP pipe, so the CDP HTTP endpoints *and* the WebSocket
upgrade pass through untouched; it holds no CDP knowledge. `start-browser` verifies
the forwarded endpoint (`/json/version`) before declaring the service up - a
container that cannot be reached never looks healthy.

## Use an IP in the endpoint, not a container hostname

Chromium additionally rejects DevTools HTTP requests whose `Host` header is not an
IP address or `localhost`:

```
$ curl -s -i http://browser:9222/json/version
HTTP/1.1 500 Internal Server Error
Host header is specified and is not an IP address or localhost.
```

So `browserService.endpoint` must name the service by **IP** (`http://127.0.0.1:9222`
when the consumer shares the network namespace, or `http://<container-ip>:9222` on a
shared docker network) - never by its DNS name. This is a chromium policy, not a
property of this image.

## Wiring a deployment to it

```yaml
plugins:
  general-service-impl: {}      # reaches the service (any transport)
  docker-impl: {}               # type: container
  browser-use-impl: { provider: playwright }
  browser-use-playwright:
    browserService:
      endpoint: http://127.0.0.1:9222      # an IP: chromium refuses Host: hostnames
      image: ghcr.io/nexuslbs/workbench-plugins/browser:0.0.2
      generalService: { type: container, params: { container: workbench-browser } }
      start: '/usr/local/bin/start-browser --background'
      startTimeoutMs: 20000
```

`start-browser --background` starts both processes detached and exits `0` **only
after** `/json/version` answers, so a launcher (`docker exec`, ssh) does not block
on a foreground child and knows the endpoint is usable when the command returns.

The upstream `mcr.microsoft.com/playwright:v1.63.0-noble` image is an equally valid
service if you prefer the vendor artifact - but then YOU must provide the
reachability (it listens on loopback only, see above).

## Publishing

`.github/workflows/browser-publish.yml` is the ONLY publisher of this image, and it
triggers ONLY on a `browser-*` tag:

```sh
git tag browser-0.0.2 && git push origin browser-0.0.2
# -> ghcr.io/nexuslbs/workbench-plugins/browser:0.0.2  and  :latest
```

The workflow builds the image once, **smoke-tests the built image** (it must answer
`/json/version` on the CDP port), and pushes only the tested image. The image tag is
the git tag with the `browser-` prefix stripped. Nothing else publishes this image:
a branch push and a `v*` (core) tag build nothing here.
