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
the next boot of the core picks it up.

## Plugins

| Plugin | Capability | Output |
| --- | --- | --- |
| `hello-otherworld` | `command:hello otherworld` | `Hello Otherworld` |
| `credentials-stub` | `credentials:vault` | example credential provider |

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
