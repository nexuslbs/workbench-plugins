# plugin-manager (workbench Web UI, M2)

Page that installs, enables, disables, retries, reloads and composes plugins,
reconciles the desired `plugins:` roster against the live tree, and shows the
loader state change the action caused.

- Page: `/plugin-manager` (nav title `Plugin Manager`), module served at
  `/plugins/plugin-manager/app.js`.
- Read: `GET /api/plugin-manager/state` returns the live loader inventory, the
  available actions, the config file, whether the host can persist
  (`canPersist`) and the web seam facts.
- Mutate: `POST /api/plugin-manager/action` with
  `{ "action": "enable|disable|load|unload|reload|retry|compose|install|reconcile", "target": "<plugin>", "config"?: {...}, "source"?: {...} }`.
  The response carries the RAW loader result (`ok`, `message`, `persisted`,
  `before`, `after`) plus the refreshed state.

Every mutation goes through the loader API of the core contract
(`ctx.workbench.host()`): the plugin never writes to the filesystem itself.
Enable/disable and install persist as config edits
(`plugins.<name>.disabled`, `sources[]`); when the host runs on an inline config
the action still applies to the running process and reports `persisted: false`.

`reconcile` is the exception to "one plugin per action": it takes NO target. It
diffs the desired `plugins:` roster (as written in the config file) against the
live cordis tree and applies only the delta - load, unload, reload, park - so a
config edit reaches the RUNNING process without a restart. Its answer extends the
plain action result with `changes` (`{ name, desired, loaded, action, reason }`,
action being `load|unload|reload|unchanged|deferred|error`), `deferred`,
`errors` and `loaded`. It persists nothing itself (the file is the input) and a
failing row never aborts the others: the process keeps running and the failing
row is reported with `ok: false` (HTTP 409).

The page refreshes the inventory after every action, so the before/after state
is visible in the browser.

## Verify

```bash
npm run typecheck && npm test     # in this repository
```
