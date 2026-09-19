# workbench-plugins

Plugins for the [workbench](https://github.com/nexuslbs/workbench) core.

This repository is consumed as an **external plugin source**: the core does not
contain any of these plugins, it discovers them at boot from a `path` source
(a sibling checkout) or a `git` source pointing at this repository. See
[the plugin contract](https://github.com/nexuslbs/workbench/blob/main/docs/PLUGIN-CONTRACT.md).

## Layout

```
plugins/
  <plugin-name>/
    workbench.plugin.json    # manifest (name, version, entry, capabilities, config)
    index.ts                 # entry module (cordis plugin, ESM)
```

## Adding this source to the core

The core repo is core-only by default (it has no dependency on this repository):
declare this source in YOUR config - a sibling checkout during development or a
git coordinate in production:

```yaml
sources:
  - kind: path
    id: workbench-plugins
    path: ../workbench-plugins/plugins   # local checkout (development)
  # production form:
  # - kind: git
  #   id: workbench-plugins
  #   url: https://github.com/nexuslbs/workbench-plugins
  #   ref: main
  #   subdir: plugins
```

## config.yml - development config for the workbench service

The repository also carries `config.yml`, the DEV config of the compose
workbench service (omni-stack / omni-root `docker-compose.dev.yml` passes it as
`CONFIG_FILE=/opt/workspace/workbench-plugins/config.yml`). It loads the core
plugins from the sibling core checkout and the plugins of THIS repository from
the local `./plugins` directory, so a plugin under development is picked up at
the next boot with no clone and no push. Production uses the tracked
`config/workbench.yml` of the omni-root stack, where this repository is a remote
git source.

No core change is needed to add a plugin here: create the plugin directory, and
add its row to the `plugins:` roster of the config of the core that consumes it -
discovery alone does not load it (see below).

## The plugin roster (`sources:` DISCOVERS, `plugins:` LOADS)

INTENTIONAL BREAKING CHANGE, the same contract as the core
([PLUGIN-CONTRACT.md](https://github.com/nexuslbs/workbench/blob/main/docs/PLUGIN-CONTRACT.md),
"Sources, the ROSTER and the `disabled` park"): a plugin discovered in a
configured source is **available**, and it is **loaded only when the config
NAMES it** under `plugins:` - that row is both the selection and the plugin's
config (`{}` is a valid row, so `apply()` must not require optional config).

```yaml
sources:
  - kind: path
    id: workbench-plugins
    path: ./plugins

plugins:                      # the ROSTER (enable list) + per-plugin config
  plugin-inventory: {}
  plugin-manager: {}
  settings: {}
  cordis-ui: {}
  credentials-stub:
    disabled: true            # parked: configured, deliberately off
# EVERY other discovered plugin is `available` - listed, never imported
```

`workbench plugins` and the Plugin Inventory page list every discovered plugin
with its state (`loaded` / `available` / `disabled` / `failed`); `enable`
persists the roster row, `disable` parks it with `disabled: true`. A config
written for the old scan-and-load semantics (a discovered plugin was installed
AND loaded in the same pass) must therefore list every plugin it wants loaded:
in `config.yml` of this repository that is the roster shown there, which names
the plugins of this checkout plus the Web UI plugins (`plugin-inventory`,
`plugin-manager`, `settings`, `cordis-ui`).

## Plugins

| Plugin | Capability | Output |
| --- | --- | --- |
| `hello-otherworld` | `command:hello otherworld` | `Hello Otherworld` |
| `credentials-stub` | `credentials:vault` | example credential provider |
| `hello-tool` | `tool:hello greet` | by-name tool over HTTP: `POST /api/tools/hello%20greet`, `POST /api/tool/call` (core contract, section 4d) |

### Web UI plugins (M1-M4)

The browser-based workbench UI is composed **only** of plugins: each one
registers its HTTP routes, its page module and its nav entry through the core's
`ctx.web` seam (`docs/PLUGIN-CONTRACT.md`, section 7). Removing a plugin from
the config removes its surface; the server keeps booting and serving the rest.

| Plugin | Surface | Page | API |
| --- | --- | --- | --- |
| `plugin-inventory` | loader inventory (read-only) | `/plugin-inventory` | `GET /api/plugin-inventory[/plugins]` |
| `plugin-manager` | install / enable / disable / retry / reload / compose | `/plugin-manager` | `GET /api/plugin-manager/state`, `POST /api/plugin-manager/action` |
| `settings` | active config file + per-plugin config, edit + persist | `/settings` | `GET /api/settings`, `GET /api/settings/plugins`, `GET /api/settings/plugin-config?name=`, `POST /api/settings/patch` |
| `cordis-ui` | live cordis runtime (services, fibers, loader) + manage | `/cordis-ui` | `GET /api/cordis-ui/runtime`, `POST /api/cordis-ui/action` |

The UI is served by the core (`npm run web`, or `workbench serve` with
`web.enabled: true`); the plugins only contribute routes, assets and pages. No
framework, no bundler, no build step at runtime: the page modules are plain ES
modules served from the plugin directory.

**Secrets**: the `settings` surface shows config references BY NAME only
(`${cred:NAME}`, `${env:VAR}`) and never resolves them.

### Tool plugins (by-name invocation)

A plugin can register a named **tool** (a description, the parameters it expects
and a handler) through `ctx.workbench.registerTool`; the core then exposes it for
invocation BY NAME over HTTP with the parameters as the request body. This is
NOT a model/agent feature: the callers are plugins and operators. The contract is
`docs/PLUGIN-CONTRACT.md` section 4d of the core.

| Plugin | Tool | Parameters | Routes |
| --- | --- | --- | --- |
| `hello-tool` | `hello greet` | `name` (string, required), `greeting` (string), `times` (integer) | `GET /api/tools`, `POST /api/tools/hello%20greet`, `POST /api/tool/call` |

The smoke for this end-to-end (the plugin registers a tool, the core lists it
with its schema, invokes it, validates the body and returns 400/404/500 without
restarting) is `test/hello-tool.test.ts` here plus the core's `test/tools.test.ts`.

## Develop / verify

```bash
npm install
npm test          # node --test test/*.test.ts
npm run typecheck
```

The plugin tests use a fake context (they do not need the core): the plugin only
depends on the documented `ctx.workbench` service, which is exactly what the
test simulates.

## License

MIT.
