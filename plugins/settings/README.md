# settings (workbench Web UI, M3)

Page that views the active config file and the per-plugin config, edits a value
and persists it through the config layer, then re-reads it.

- Page: `/settings` (nav title `Settings`), module served at
  `/plugins/settings/app.js`.
- Read:
  - `GET /api/settings` - the active config file path and the config as written
    (`ctx.workbench.config().file()` / `.view()`).
  - `GET /api/settings/plugins` - the per-plugin config as written.
  - `GET /api/settings/plugin-config?name=<plugin>` - one plugin's config.
- Mutate: `POST /api/settings/patch` with
  `{ "patch": [{ "op": "set", "path": ["plugins","hello-world","message"], "value": "Hi" }] }`
  (also `append` / `delete`), persisted by the core config layer and re-read
  afterwards; the response is the re-read config.

**Secrets**: config values that reference a credential or an environment variable
(`${cred:NAME}`, `${env:VAR}`) are shown **by name only**. The
page and the API never resolve a reference, so no secret value can reach a
response, a log or a screenshot.

## Verify

```bash
npm run typecheck && npm test     # in this repository
```
