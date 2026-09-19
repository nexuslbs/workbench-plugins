// plugins/tools-impl - the `tools@1` PROVIDER `registry`.
//
// Placement (operator rule 2026-09-19): the tools capability lives ENTIRELY in
// THIS repository. The core (`nexuslbs/workbench`) holds no tool module, exports
// no tool Definition and registers no `/api/tools*` route: it loads this
// repository as a source and nothing else. This plugin is the PROVIDER role of
//
//        Provider  ->  Definition  <-  Consumer
//
// - it creates the registry from `definitions/tools.ts` and provides it as the
//   `tools` service (`ctx.tools`), so a CONSUMER plugin registers a tool through
//   the SERVICE and never imports this module;
// - it registers the by-name HTTP seams on the `web@1` seam (`ctx.web`) when a
//   web provider plugin is loaded, with the unchanged wire contract:
//     GET  /api/tools               the tool list (name, description, plugin, schema)
//     GET  /api/tools/<name>        one descriptor
//     POST /api/tools/<name>        invoke, the PARAMETERS are the JSON body
//     POST /api/tools               alias: body {"tool","params"}
//     POST /api/tool/call           the same alias (the shipped omniagent consumer)
//   With NO web provider the registry still works, the CLI still answers and the
//   HTTP seams simply do not exist (a 404 from the web provider, never a crash).
// - it registers the CLI commands `tools` and `tool <name> [<params-json>]`
//   through the host's command registry (`ctx.workbench.registerCommand`), so
//   the core CLI carries no tools code either.
//
// It deliberately imports NOTHING from the core package: `ctx.workbench` (the
// host service) and `ctx.web` (the web seam) are structural, exactly like every
// other plugin of this repository.
import {
  TOOLS,
  TOOLS_CONTRACT,
  ToolArgsError,
  ToolUnknownError,
  Tools,
  type ToolInfo,
} from '../../definitions/tools.ts'
import { provideService } from '../../definitions/support.ts'

/** The HOST service slice this plugin uses (commands + plugin attribution). */
interface WorkbenchLike {
  /** The plugin whose `apply` is running (attribution of a registration). */
  attribution?(): string | undefined
  registerCommand(def: {
    name: string
    description?: string
    run(args: string[]): string | void | Promise<string | void>
  }): () => void
}

/** One route a seam provider accepts. */
interface WebRouteSpec {
  method: string
  path: string
  handler: (request: WebRequest) => WebResponse | undefined | void | Promise<WebResponse | undefined | void>
  description?: string
}

/** The request slice the tool routes read. */
interface WebRequest {
  method: string
  path: string
  params?: Record<string, string>
  readText(): Promise<string>
  readJson<T = unknown>(): Promise<T>
}

/** What a seam route answers. */
interface WebResponse {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

/** The `web@1` seam as this plugin uses it (provided by a web provider plugin). */
interface WebSeam {
  route(spec: WebRouteSpec): () => void
  routes?(): { method: string; path: string }[]
}

/** The plugin context slice this plugin uses. */
interface PluginContext {
  workbench: WorkbenchLike
  web?: WebSeam
  /** Deferred service injection: the callback runs once `web` exists. */
  inject?(deps: string[], callback: (ctx: PluginContext) => void): void
  effect(callback: () => () => void): void
  /** Every other context member (the structural view of the host context). */
  [key: string]: unknown
}

export const name = 'tools-impl'

export interface Config {
  /** Log the registered tool count at load (default true). */
  log?: boolean
}

/** A JSON response (every route of this plugin answers JSON). */
function json(status: number, payload: unknown): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(payload, null, 2)}\n` }
}

/** Readable text of anything a handler threw. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** A structured tool error body (`status: 'error'`), the only error shape here. */
function errorBody(kind: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { status: 'error', error: { kind, message, ...extra } }
}

/**
 * Read the request body as JSON. An EMPTY body is `undefined` (the dispatcher
 * then takes `{}`), so a parameterless tool can be invoked with no body at all.
 */
async function readJsonBody(request: WebRequest): Promise<{ ok: true; value: unknown } | { ok: false; message: string }> {
  let text: string
  try {
    text = await request.readText()
  } catch (error) {
    return { ok: false, message: `could not read the request body: ${messageOf(error)}` }
  }
  if (text.trim().length === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    return { ok: false, message: `request body must be valid JSON: ${messageOf(error)}` }
  }
}

/** The tool name of a path parameter (decoded by the provider already). */
function toolNameOf(request: WebRequest): string {
  return request.params?.name ?? ''
}

/**
 * THE invocation: the one place a tool call is executed and its outcome mapped
 * to a status. The path routes and the alias routes all call exactly this.
 */
async function invoke(tools: Tools, tool: string, params: unknown): Promise<WebResponse> {
  try {
    const result = await tools.execute(tool, params)
    return json(200, { status: 'ok', tool, result })
  } catch (error) {
    if (error instanceof ToolUnknownError) {
      return json(404, errorBody('unknown-tool', `unknown tool '${error.tool}'`, { tool: error.tool }))
    }
    if (error instanceof ToolArgsError) {
      return json(400, errorBody('invalid-params', error.message, { tool: error.tool, violations: error.violations }))
    }
    return json(500, errorBody('tool-failed', messageOf(error), { tool }))
  }
}

/** The `{ tool, params }` body of the alias routes (canonical + shipped path). */
async function invokeAlias(tools: Tools, request: WebRequest): Promise<WebResponse> {
  const body = await readJsonBody(request)
  if (!body.ok) return json(400, errorBody('bad-request', body.message))
  if (body.value === undefined) {
    return json(400, errorBody('bad-request', 'the request body must be a JSON object like {"tool":"<name>","params":{...}}'))
  }
  if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
    return json(400, errorBody('bad-request', 'the request body must be a JSON object like {"tool":"<name>","params":{...}}'))
  }
  const { tool, params } = body.value as { tool?: unknown; params?: unknown }
  if (typeof tool !== 'string' || tool.trim().length === 0) {
    return json(400, errorBody('bad-request', 'the request body needs a non-empty "tool" name'))
  }
  return invoke(tools, tool, params)
}

/** The `GET /api/tools` payload. */
function listPayload(tools: Tools): unknown {
  const registered = tools.tools()
  return { status: 'ok', contract: TOOLS_CONTRACT, count: registered.length, tools: registered }
}

/**
 * Registers the tool routes on the web seam and returns their disposer. The
 * provider calls this once `ctx.web` exists; nothing here is a core feature and
 * nothing runs at import time.
 */
export function registerToolRoutes(web: WebSeam, tools: Tools): () => void {
  const disposers: Array<() => void> = [
    web.route({
      method: 'GET',
      path: '/api/tools',
      description: 'list the registered tools with their parameter schemas',
      handler: () => json(200, listPayload(tools)),
    }),
    web.route({
      method: 'GET',
      path: '/api/tools/:name',
      description: 'one registered tool descriptor',
      handler: (request) => {
        const toolName = toolNameOf(request)
        const tool = tools.tools().find((entry) => entry.name === toolName)
        if (tool === undefined) return json(404, errorBody('unknown-tool', `unknown tool '${toolName}'`, { tool: toolName }))
        return json(200, { status: 'ok', tool })
      },
    }),
    web.route({
      method: 'POST',
      path: '/api/tools/:name',
      description: 'invoke a tool by name, the parameters are the JSON body',
      handler: async (request) => {
        const body = await readJsonBody(request)
        if (!body.ok) return json(400, errorBody('bad-request', body.message))
        return invoke(tools, toolNameOf(request), body.value)
      },
    }),
    web.route({
      method: 'POST',
      path: '/api/tools',
      description: 'invoke a tool by name, body {"tool","params"}',
      handler: (request) => invokeAlias(tools, request),
    }),
    web.route({
      method: 'POST',
      path: '/api/tool/call',
      description: 'invoke a tool by name, body {"tool","params"} (omniagent consumer path)',
      handler: (request) => invokeAlias(tools, request),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/** The `workbench tools` command body (list, or `--json`). */
export function toolsCommand(tools: Tools, args: string[]): string {
  const registered = tools.tools()
  if (args.includes('--json')) {
    return JSON.stringify({ contract: TOOLS_CONTRACT, tools: registered }, null, 2)
  }
  if (!registered.length) return 'no tools registered'
  const lines: string[] = []
  for (const tool of registered) {
    lines.push(`${tool.name}${tool.description ? `  ${tool.description}` : ''}  [${tool.plugin}]`)
    const required = new Set(tool.parameters?.required ?? [])
    for (const [parameter, property] of Object.entries(tool.parameters?.properties ?? {})) {
      const description = property.description ? `  ${property.description}` : ''
      lines.push(`    ${parameter}${required.has(parameter) ? ' (required)' : ''}: ${property.type}${description}`)
    }
  }
  return lines.join('\n')
}

/**
 * The `workbench tool <name> [<params-json>]` command body. It runs the very
 * dispatch the HTTP routes run (resolve, validate, then the handler), so the two
 * surfaces cannot drift; an invalid body exits 2, an unknown tool exits 1.
 */
export async function toolCommand(tools: Tools, args: string[]): Promise<string | void> {
  const [toolName, ...rest] = args
  if (!toolName) throw new Error('tool: needs a tool name (workbench tool <name> [<params-json>])')
  const raw = rest.join(' ').trim()
  let params: unknown = {}
  if (raw.length > 0) {
    try {
      params = JSON.parse(raw) as unknown
    } catch (error) {
      throw new Error(`tool ${toolName}: the parameters must be valid JSON (${messageOf(error)})`)
    }
  }
  try {
    const result = await tools.execute(toolName, params)
    return JSON.stringify({ status: 'ok', tool: toolName, result }, null, 2)
  } catch (error) {
    if (error instanceof ToolArgsError) {
      process.stderr.write(`${error.message}\n`)
      for (const violation of error.violations) process.stderr.write(`  - ${violation}\n`)
      process.exitCode = 2
      return
    }
    if (error instanceof ToolUnknownError) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
      return
    }
    throw error
  }
}

/** Does the seam already answer this method+path? (never register twice) */
function answered(web: WebSeam, method: string, path: string): boolean {
  return (web.routes?.() ?? []).some((route) => route.method === method && route.path === path)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const tools = new Tools({
    // Attribution: the host marks the plugin it is applying, so a tool reports
    // the CONSUMER plugin that registered it (not this provider).
    owner: () => ctx.workbench?.attribution?.(),
    fallbackOwner: 'unknown',
    log: (message) => process.stderr.write(`[tools-impl] ${message}\n`),
  })

  // THE SERVICE: a consumer registers through `ctx.tools`, never by importing
  // this plugin (Provider -> Definition <- Consumer).
  provideService(ctx, TOOLS, tools.consumer())

  // The by-name HTTP seams: registered on the web seam only when a `web@1`
  // provider plugin is loaded. With no web provider the registry keeps working
  // (CLI + in process) and the seams simply do not exist.
  const registerOn = (seam: WebSeam): void => {
    if (answered(seam, 'GET', '/api/tools')) return
    ctx.effect(() => registerToolRoutes(seam, tools))
  }
  // Deferred dependency declaration: `web` may be provided LATER (a provider
  // plugin loads after this one), so the seam is NEVER read as a bare property
  // (cordis refuses a property access that is not declared in `inject`).
  if (ctx.inject) {
    ctx.inject(['web'], (injected) => {
      if (!injected.web) return
      process.stderr.write('[tools-impl] web@1 provider loaded: registering the /api/tools seams\n')
      registerOn(injected.web)
    })
  } else if (ctx.web) {
    // A bare context (unit test): the seam is handed in directly.
    registerOn(ctx.web)
  }

  // The CLI surface of the capability, registered through the HOST command
  // registry (the core CLI carries no tools code).
  ctx.effect(() =>
    ctx.workbench.registerCommand({
      name: 'tools',
      description: 'list the registered tools with their parameter schemas',
      run: (args) => toolsCommand(tools, args),
    }),
  )
  ctx.effect(() =>
    ctx.workbench.registerCommand({
      name: 'tool',
      description: 'invoke a tool by name through the same dispatch as POST /api/tools/<name>',
      run: (args) => toolCommand(tools, args),
    }),
  )

  if (config.log !== false) {
    process.stderr.write(`[tools-impl] tools@1 provider 'registry' loaded (${tools.tools().length} tool(s) registered so far)\n`)
  }
}

/**
 * The entry module: `workbench` (the host service: commands + attribution) is
 * DECLARED, `web` is injected dynamically above. This plugin provides `tools`
 * (the manifest capability), so consumers never import it.
 */
export default { name, inject: ['workbench'], apply }

export type { ToolInfo }
