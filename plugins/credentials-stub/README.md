# credentials-stub

An EXTERNAL workbench **credentials provider** (`credentials@1`): it serves
credentials from a Vault-style HTTP endpoint (KV v2 answer shape). It is the
proof that a provider can be added from another repository with **no core
change at all**.

- Provider id: `stub-vault`
- Contract: `credentials@1` (`CAPABILITY: credentials`, `VERSION: 1` in the core docs)
- Manifest capability (this is what makes the provider resolvable):

```json
"capabilities": [{ "id": "credentials", "version": 1, "provider": "stub-vault" }]
```

## Config

`url` is required only to ENABLE the provider - the plugin is loadable with NO
config row at all (`plugins.credentials-stub` absent). Without a `url` it loads
and registers **no** provider (the manifest still DECLARES `stub-vault`, so the
credentials `providers()` view shows it with `registered: false`) and announces
the not-configured state through the core log; `apply()` never throws for missing
optional config (core `docs/PLUGIN-CONTRACT.md`, "An unconfigured plugin must
still load"). A `url` that IS present but not a non-empty string stays a loud
config error.

| key | default | meaning |
| --- | --- | --- |
| `url` | (required to enable) | base URL, e.g. `http://127.0.0.1:8200` |
| `mount` | `secret` | KV mount point |
| `token` | - | sent as `X-Vault-Token`, never logged |
| `timeoutMs` | `5000` | request timeout |

## Wiring it into a workbench config

```yaml
sources:
  - kind: path            # or kind: git in production
    id: workbench-plugins
    path: ../workbench-plugins/plugins
    external: true

credentials:
  providers: [stub-vault]   # selection is configuration only

plugins:
  credentials-stub:
    url: http://127.0.0.1:8200
```

Then `${cred:NAME}` in any config value (and every consumer calling
`ctx.credentials.resolve`) is served by this plugin instead of a core provider.

## Backend contract

`GET <url>/v1/<mount>/data/<name>` (scoped: `.../data/<scope>/<name>`) returns
`{ "data": { "data": { "value": "..." } } }` (Vault KV v2), or the simpler
`{ "data": { "value": "..." } }` / `{ "value": "..." }`. HTTP 404 means "not
found"; any other status is an error that names the endpoint and the reference,
never the value. `list()` is not implemented (it would need Vault's LIST verb).
