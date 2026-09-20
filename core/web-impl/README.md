# web-impl - the `web@1` PROVIDER `http`

The Web UI of workbench is composed ONLY of plugins. This plugin is the
**provider** of the `web` seam: it owns the socket and serves whatever the
consumers register.

```
Provider (this plugin)  ->  Definition (definitions/web.ts)  <-  Consumers
                                                               (UI plugins)
```

* **Definition**: `definitions/web.ts` in THIS repository (moved out of the core
  in v0.0.3). The core no longer exports it; the core does not know the seam at
  all beyond "some plugin provides the `web` service".
* **Consumers**: every UI plugin (`plugin-inventory`, `plugin-manager`,
  `settings`, `cordis-ui`, the web-* plugins) resolves the service by name and
  registers routes, assets and pages through `ctx.web`. A consumer declares its
  own structural interfaces and never imports this plugin.
* **Provider**: this plugin. It declares `{"id":"web","version":1,"provider":"http"}`
  in `workbench.plugin.json`, provides the `web` service and starts a
  `node:http` listener.

## What it serves

| Surface | Who owns it |
| --- | --- |
| `GET`/`HEAD /health` | this provider (the deployment healthcheck) |
| `GET /api/web/pages`, the shell document, its asset | this provider (the seam's own read surface) |
| the registered routes / assets / pages | the consumers, through `ctx.web` |
| `404` (JSON) for everything else | this provider |

## Configuration

The whole row is optional:

```yaml
plugins:
  web-impl:
    host: 0.0.0.0     # default: $WORKBENCH_WEB_HOST, then 127.0.0.1
    port: 8080        # default: $WORKBENCH_WEB_PORT, then $WORKBENCH_PORT, then 8080
    maxBodyBytes: 1048576
```

**Port precedence**: the plugin row wins, then `WORKBENCH_WEB_PORT`, then
`WORKBENCH_PORT` (the port a deployment publishes), then the definition default
`8080`. The core publishes the `web:` config section of the deployment to
`WORKBENCH_PORT` / `WORKBENCH_WEB_HOST` before it loads the plugins, so a
deployment keeps writing `web: { enabled: true, host: 0.0.0.0, port: 8080 }`
and this provider honours it. `port: 0` picks a free port (tests).

The core DEFERS the web UI when the config enables it and no `web@1` provider is
loaded: it reports a structured deferred state and keeps running, and a provider
loaded later serves it. Nothing in the core opens a socket.

## Deploy

```yaml
sources:
  - kind: git
    id: workbench-plugins
    url: https://github.com/nexuslbs/workbench-plugins
    ref: main
    subdir: plugins
plugins:
  web-impl: { host: 0.0.0.0, port: 8080 }
  plugin-manager: {}
  settings: {}
web:
  enabled: true
```

Unloading the plugin closes the listener and unregisters everything it
registered: the seam and its routes are `ctx.effect` disposers, so there is no
global state and no socket left behind.
