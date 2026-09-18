# cordis-ui (workbench Web UI, M4)

Page that inspects the **live cordis runtime** and manages it.

- Page: `/cordis-ui` (nav title `Cordis UI`), module served at
  `/plugins/cordis-ui/app.js`.
- Read: `GET /api/cordis-ui/runtime` returns
  - `services`: the services available on the context (`workbench`, `web`,
    `credentials`, `reflect`) with their facts;
  - `registry`: the cordis registry (size, and per fiber: name, state, effect
    count) when this cordis build exposes it;
  - `loader`: the live loader entries, failures and disabled plugins.
- Manage: `POST /api/cordis-ui/action` with
  `{ "action": "inspect|reload|stop|start|dispose", "target": "<plugin>" }`.
  The response carries the runtime view BEFORE and AFTER the action, the
  resulting fiber/entry and the raw loader result, so the change is visible.

`stop`/`dispose` unload the plugin's fiber (its effects are disposed), `start`
loads it again, `reload` does both; `inspect` is read-only.

## Verify

```bash
npm run typecheck && npm test     # in this repository
```
