/**
 * settings - view and edit the active workbench config from the Web UI.
 *
 * Two rules, both enforced by the core config seam this plugin consumes
 * (`ctx.workbench.config()`), never re-implemented here:
 *
 *   1. the file path is always shown, and edits go through the config layer and
 *      are persisted there (validated + atomic), then RE-READ so the page shows
 *      what is on disk;
 *   2. values are read UNEXPANDED. A `${cred:NAME}` / `${env:VAR}` reference is
 *      shown BY NAME and its VALUE is never resolved, returned, logged or
 *      rendered - the plugin only ever sees the raw config text. The per-plugin
 *      config therefore comes from `configApi.view().value` (the file as
 *      written), never from the core's expanded per-plugin accessor.
 *
 * Endpoints:
 *   GET  /api/settings                     the config file, its raw view, the
 *                                          per-plugin config and the references
 *   GET  /api/settings/plugins/<name>      one plugin's config as written
 *   POST /api/settings/patch               { op, path, value } -> persist -> re-read
 *
 * External plugin rule: the core package is never imported.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const PAGE_ID = 'settings'
export const API_BASE = `/api/${PAGE_ID}`

// ---------------------------------------------------------------- seam types

interface WebRequest {
  method: string
  path: string
  query: URLSearchParams
  readText(): Promise<string>
  readJson<T = unknown>(): Promise<T>
}

interface WebResponse {
  status?: number
  contentType?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

interface WebRouteSpec {
  method: string
  path: string
  handler: (request: WebRequest) => WebResponse | void | Promise<WebResponse | void>
  description?: string
}

interface WebAssetSpec {
  path: string
  file: string
  contentType?: string
}

interface WebPageSpec {
  id: string
  title: string
  path: string
  module: string
  description?: string
}

interface WebService {
  route(spec: WebRouteSpec): () => void
  asset(spec: WebAssetSpec): () => void
  page(spec: WebPageSpec): () => void
}

interface ConfigPatch {
  op: 'set' | 'delete' | 'append'
  path: (string | number)[]
  value?: unknown
}

/** The config file as written: path, format, text and parsed value (unexpanded). */
interface RawConfigView {
  file: string
  format: string
  text: string
  value: Record<string, unknown>
}

interface ConfigApi {
  file(): string
  /** The active config file AS WRITTEN: the parsed text, no expansion applied. */
  view(): RawConfigView
  update(patch: ConfigPatch[]): RawConfigView
}

interface WorkbenchService {
  config(): ConfigApi
  /** The loader's discovered set, used only to validate a plugin name. */
  inventory(): { discovered: { name: string }[] }
  log(message: string): void
}

interface PluginContext {
  effect(setup: () => void | (() => void)): void
  web: WebService
  workbench: WorkbenchService
}

export interface SettingsConfig {
  page?: string
  path?: string
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

/** Matches a config reference: `${cred:NAME}`, `${secret:NAME}`, `${env:VAR}`. */
const REFERENCE = /\$\{([A-Za-z0-9_.-]+):([A-Za-z0-9_./-]+)\}/g

/**
 * Every reference in a parsed config value, WITH its path and its kind - the
 * name only, never a value. The page lists these so an operator can see which
 * secrets a plugin config points at.
 */
export function collectReferences(value: unknown, at: (string | number)[] = []): { path: string; kind: string; name: string }[] {
  const found: { path: string; kind: string; name: string }[] = []
  if (typeof value === 'string') {
    for (const match of value.matchAll(REFERENCE)) {
      found.push({ path: at.join('.'), kind: match[1], name: match[2] })
    }
    return found
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...collectReferences(item, [...at, index])))
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      found.push(...collectReferences(item, [...at, key]))
    }
  }
  return found
}

function referencesIn(view: RawConfigView): { path: string; kind: string; name: string }[] {
  return collectReferences(view.value)
}

/**
 * One plugin's config EXACTLY AS WRITTEN: taken from the raw view, so every
 * reference (`${env:VAR}` and `${cred:NAME}`) comes back BY NAME and none is
 * resolved. The core's expanded per-plugin accessor is deliberately NOT used
 * here - it returns the config a plugin was INSTANTIATED with, which would
 * resolve `${env:VAR}` and leak its value into a response.
 */
export function writtenPluginConfig(view: RawConfigView, name: string): Record<string, unknown> {
  const plugins = view.value.plugins
  if (plugins === null || typeof plugins !== 'object' || Array.isArray(plugins)) return {}
  const entry = (plugins as Record<string, unknown>)[name]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return {}
  return { ...(entry as Record<string, unknown>) }
}

export const name = PAGE_ID

export function apply(ctx: PluginContext, config: SettingsConfig = {}): void {
  const title = config.page ?? 'Settings'
  const pagePath = config.path ?? `/${PAGE_ID}`
  const modulePath = `/plugins/${PAGE_ID}/app.js`

  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: API_BASE,
      description: 'the active config file, its raw (unexpanded) view and the references by name',
      handler: () => {
        const configApi = ctx.workbench.config()
        const view = configApi.view()
        const pluginNames = Object.keys((view.value.plugins as Record<string, unknown> | undefined) ?? {}).sort()
        const plugins: Record<string, unknown> = {}
        for (const name of pluginNames) plugins[name] = writtenPluginConfig(view, name)
        return json({
          contract: 'settings@1',
          file: configApi.file(),
          format: view.format,
          text: view.text,
          value: view.value,
          plugins,
          // Names only: the values of these references are never resolved here.
          references: referencesIn(view),
          secretPolicy: 'references are shown by name only ($cred/$secret/$env); values are never resolved or returned',
        })
      },
    }),
  )

  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: `${API_BASE}/plugins`,
      description: 'the per-plugin config as written',
      handler: () => {
        const configApi = ctx.workbench.config()
        const view = configApi.view()
        const names = Object.keys((view.value.plugins as Record<string, unknown> | undefined) ?? {}).sort()
        const plugins: Record<string, unknown> = {}
        for (const name of names) plugins[name] = writtenPluginConfig(view, name)
        return json({ file: configApi.file(), plugins })
      },
    }),
  )

  // One plugin's config. The seam matches EXACT paths (the core ships no
  // router), so the name travels as a query parameter.
  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: `${API_BASE}/plugin-config`,
      description: "one plugin's config as written (?name=<plugin>)",
      handler: (request) => {
        const name = request.query.get('name') ?? ''
        if (name.length === 0) return json({ error: 'a plugin name is required (?name=<plugin>)' }, 400)
        const configApi = ctx.workbench.config()
        const rawView = configApi.view()
        const view = writtenPluginConfig(rawView, name)
        const declared = Object.keys((rawView.value.plugins as Record<string, unknown> | undefined) ?? {})
        const known = ctx.workbench.inventory().discovered.map((entry) => entry.name)
        if (!declared.includes(name) && !known.includes(name)) {
          return json({ error: `unknown plugin '${name}': it has no 'plugins.${name}' entry and no source declares it`, file: configApi.file(), plugin: name }, 404)
        }
        return json({ file: configApi.file(), plugin: name, config: view, references: collectReferences(view, ['plugins', name]) })
      },
    }),
  )

  // The edit path: one patch, persisted by the config layer, then RE-READ from
  // disk. The response carries the file before and after.
  ctx.effect(() =>
    ctx.web.route({
      method: 'POST',
      path: `${API_BASE}/patch`,
      description: 'persist one config patch and re-read the file',
      handler: async (request) => {
        let body: Partial<ConfigPatch>
        try {
          body = await request.readJson<Partial<ConfigPatch>>()
        } catch (error) {
          return json({ ok: false, message: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` }, 400)
        }
        const op = body?.op ?? 'set'
        if (op !== 'set' && op !== 'delete' && op !== 'append') {
          return json({ ok: false, message: `unsupported op '${String(op)}' (expected set, delete or append)` }, 400)
        }
        if (!Array.isArray(body?.path) || body.path.length === 0) {
          return json({ ok: false, message: "a patch needs a non-empty 'path' array" }, 400)
        }
        const patch: ConfigPatch = { op, path: body.path, ...(body.value === undefined ? {} : { value: body.value }) }
        const configApi = ctx.workbench.config()
        const before = configApi.view()
        let after: RawConfigView
        try {
          after = configApi.update([patch])
        } catch (error) {
          return json({ ok: false, message: `patch rejected: ${error instanceof Error ? error.message : String(error)}`, patch, file: configApi.file(), before }, 409)
        }
        return json({ ok: true, patch, file: configApi.file(), before, after, message: `patched ${body.path.join('.')} in ${configApi.file()} and re-read it` })
      },
    }),
  )

  ctx.effect(() =>
    ctx.web.asset({
      path: modulePath,
      file: path.join(HERE, 'web', 'app.js'),
      contentType: 'text/javascript; charset=utf-8',
    }),
  )

  ctx.effect(() =>
    ctx.web.page({
      id: PAGE_ID,
      title,
      path: pagePath,
      module: modulePath,
      description: 'View and edit the active config file; secret references appear by name only.',
    }),
  )

  ctx.workbench.log(`settings: page ${pagePath} -> ${modulePath} (API ${API_BASE})`)
}

export default { name, inject: ['workbench', 'web'], apply }
