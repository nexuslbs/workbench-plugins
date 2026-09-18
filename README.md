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

Default core config (`workbench.config.json` in the core repo) already points at
a sibling checkout:

```json
{ "kind": "path", "id": "workbench-plugins", "path": "../workbench-plugins/plugins" }
```

Git coordinate alternative:

```json
{ "kind": "git", "id": "workbench-plugins", "url": "https://github.com/nexuslbs/workbench-plugins.git", "ref": "main", "subdir": "plugins" }
```

No core change is needed to add a plugin here: create the plugin directory, and
the next boot of the core picks it up.

## Plugins

| Plugin | Capability | Output |
| --- | --- | --- |
| `hello-otherworld` | `command:hello otherworld` | `Hello Otherworld` |

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
