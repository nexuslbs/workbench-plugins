# plugin-manager (workbench Web UI, M2)

Page that installs, enables, disables, retries, reloads and composes plugins -
and shows the loader state change the action caused.

- Page: `/plugin-manager` (nav title `Plugin Manager`), module served at
  `/plugins/plugin-manager/app.js`.
- Read: `GET /api/plugin-manager/state` returns the live loader inventory, the
  available actions, the config file, whether the host can persist
  (`canPersist`) and the web seam facts.
- Mutate: `POST /api/plugin-manager/action` with
  `{ "action": "enable|disable|load|unload|reload|retry|compose|install", "target": "<plugin>", "config"?: {...}, "source"?: {...} }`.
  The response carries the RAW loader result (`ok`, `message`, `persisted`,
  `before`, `after`) plus the refreshed state.

Every mutation goes through the loader API of the core contract
(`ctx.workbench.host()`): the plugin never writes to the filesystem itself.
Enable/disable and install persist as config edits
(`plugins.<name>.disabled`, `sources[]`); when the host runs on an inline config
the action still applies to the running process and reports `persisted: false`.

The page refreshes the inventory after every action, so the before/after state
is visible in the browser.

## Verify

```bash
npm run typecheck && npm test     # in this repository
```
