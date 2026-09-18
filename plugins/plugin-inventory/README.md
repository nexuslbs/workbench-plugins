# plugin-inventory (workbench Web UI, M1)

Read-only page that renders the **Host Loader's current plugin inventory**.

- Page: `/plugin-inventory` (nav title `Plugin Inventory`), module served at
  `/plugins/plugin-inventory/app.js`.
- Data: `GET /api/plugin-inventory` returns the loader inventory through the
  documented core contract (`ctx.workbench.inventory()`, the same data the
  `workbench plugins` CLI prints): per plugin name, version, source (core /
  path / git + coordinate), resolved path, load status/error and the
  capabilities/commands it provides, plus the sources and the config file.
  `GET /api/plugin-inventory/plugins` is the list-only variant.
- No filesystem scraping, no config parsing: the loader is the single source of
  truth.

## Wiring

The plugin is an ordinary external plugin of `workbench-plugins`; declare the
source in the core config (see the repository README) and enable the Web UI:

```yaml
web:
  enabled: true
```

Then `npm run web` (or `workbench web`) in the core and open the printed URL.

## Verify

```bash
npm run typecheck && npm test     # in this repository
```
