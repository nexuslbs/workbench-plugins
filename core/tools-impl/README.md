# core/tools-impl - the `tools@1` PROVIDER `registry`

The tools capability lives **entirely in this repository** (operator rule
2026-09-19). The core (`nexuslbs/workbench`) holds no tool module, exports no
tool Definition and registers no `/api/tools*` route.

```
Provider (this plugin)  ->  Definition (definitions/tools.ts)  <-  Consumer (any plugin)
```

## What it does

* creates the registry (`definitions/tools.ts`) and provides it as the `tools`
  service: `ctx.tools` (manifest capability `{ "id": "tools", "version": 1,
  "provider": "registry" }`);
* registers the by-name HTTP seams on the `web@1` seam (`ctx.web`) once a web
  provider plugin (`core/web-impl`) is loaded, with the **unchanged** wire
  contract:
  * `GET  /api/tools` - the tool list (name, description, plugin, parameter schema)
  * `GET  /api/tools/<name>` - one descriptor
  * `POST /api/tools/<name>` - invoke, the parameters are the JSON body
  * `POST /api/tools` / `POST /api/tool/call` - alias, body `{"tool","params"}` (the path the shipped omniagent `workbench` MCP plugin posts to)
  * status contract: `200` ran, `400` invalid params (readable `error.violations`), `404` unknown tool, `500` handler threw (the process keeps serving);
* registers the CLI commands `tools` and `tool <name> [<params-json>]` through
  the host command registry (`ctx.workbench.registerCommand`), so the core CLI
  carries no tools code either.

## Deferral, not a fallback server

The registry is provided **immediately**; the HTTP seams are registered with
`ctx.inject(['web'], ...)`, i.e. when the `web@1` provider plugin appears. With
no web provider loaded:

* `/api/tools*` does not exist (the web provider answers `404` for an unknown
  route - there is no core-owned server to fall back on);
* the registry, the CLI commands and every consumer keep working.

## Consuming it

```ts
export const name = 'my-tools'
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(() => ctx.tools.registerTool({
    name: 'my tool',
    description: 'does something',
    parameters: { input: { type: 'string', required: true } },
    handler: async ({ input }) => ({ echo: input }),
  }))
}
```

`ctx.tools` is the **service**; a consumer never imports this plugin (or any
provider). `npm run check:seam` enforces that direction.
