/**
 * plugin-manager - install, enable, disable, retry and compose plugins from the
 * Web UI.
 *
 * Every mutation goes through the LOADER API (`ctx.workbench.host()`), never
 * through a filesystem write of this plugin: the host performs the same
 * discovery/instantiation the boot uses and persists config edits through the
 * config seam. Each action answers the loader's own result - the inventory
 * BEFORE and AFTER plus the message - so the page shows a real state change.
 *
 * Mutating endpoints are explicit and inspectable:
 *   GET  /api/plugin-manager/state   the live inventory + what can be done
 *   POST /api/plugin-manager/action  { action, target, source?, config? }
 *
 * No auth in this round: the server binds loopback by default (see the core
 * README). External plugin rule: the core package is never imported, the
 * interfaces below describe the surfaces structurally.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const PAGE_ID = 'plugin-manager'
export const API_BASE = `/api/${PAGE_ID}`

/** Every action the manager exposes (one per loader mutation, plus compose). */
export const ACTIONS = ['load', 'unload', 'reload', 'retry', 'enable', 'disable', 'install', 'uninstall', 'compose'] as const
export type ActionName = (typeof ACTIONS)[number]

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
  info(): unknown
}

interface InventoryEntry {
  name: string
  version: string
  description?: string
  dir: string
  source: string
  external: boolean
  capabilities: string[]
  state: string
  error?: string
  commands: string[]
}

interface HostInventory {
  configFile: string
  plugins: unknown[]
  sources: unknown[]
  failures: unknown[]
  disabled: string[]
  discovered: InventoryEntry[]
  commands: unknown[]
}

/** One source coordinate (`sources[]` in the config). */
interface SourceSpec {
  kind: 'path' | 'git'
  id?: string
  path?: string
  url?: string
  ref?: string
  subdir?: string
  external?: boolean
}

/** The loader's action result: what changed, and the state around it. */
interface HostActionResult {
  ok: boolean
  action: string
  target: string
  request: Record<string, unknown>
  persisted: boolean
  before: HostInventory
  after: HostInventory
  message: string
}

interface HostApi {
  inventory(): HostInventory
  configFilePath(): string | undefined
  canPersist(): { ok: boolean; reason?: string }
  load(name: string): Promise<HostActionResult>
  unload(name: string): Promise<HostActionResult>
  reload(name: string): Promise<HostActionResult>
  retry(name: string): Promise<HostActionResult>
  enable(name: string): Promise<HostActionResult>
  disable(name: string): Promise<HostActionResult>
  install(spec: SourceSpec): Promise<HostActionResult>
  uninstall(id: string): Promise<HostActionResult>
}

interface ConfigPatch {
  op: 'set' | 'delete' | 'append'
  path: (string | number)[]
  value?: unknown
}

interface ConfigApi {
  file(): string
  view(): unknown
  update(patch: ConfigPatch[]): unknown
  pluginConfig(name: string): Record<string, unknown>
}

interface WorkbenchService {
  inventory(): HostInventory
  host(): HostApi
  config(): ConfigApi
  log(message: string): void
}

interface PluginContext {
  effect(setup: () => void | (() => void)): void
  web: WebService
  workbench: WorkbenchService
}

/** Request body of `POST /api/plugin-manager/action`. */
export interface ActionBody {
  action?: string
  target?: string
  /** `install` only: the source coordinate to add. */
  source?: SourceSpec
  /** `compose` only: the plugin config object to write to `plugins.<name>`. */
  config?: Record<string, unknown>
}

export interface PluginManagerConfig {
  page?: string
  path?: string
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

export const name = PAGE_ID

export function apply(ctx: PluginContext, config: PluginManagerConfig = {}): void {
  const title = config.page ?? 'Plugin Manager'
  const pagePath = config.path ?? `/${PAGE_ID}`
  const modulePath = `/plugins/${PAGE_ID}/app.js`

  // The state the manager acts on: the LIVE loader inventory plus the config
  // file it persists to (so the page can say what is possible).
  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: `${API_BASE}/state`,
      description: 'the live loader inventory and the available actions',
      handler: () => {
        const host = ctx.workbench.host()
        const inventory = host.inventory()
        return json({
          contract: 'plugin-manager@1',
          actions: ACTIONS,
          configFile: host.configFilePath() ?? inventory.configFile,
          canPersist: host.canPersist(),
          entries: inventory.discovered,
          failures: inventory.failures,
          disabled: inventory.disabled,
          sources: inventory.sources,
          seam: ctx.web.info(),
        })
      },
    }),
  )

  // The one mutating endpoint. It is deliberately explicit: the action name, the
  // target and the payload are validated here, and the RAW loader result is
  // returned unchanged (ok, message, persisted, before, after).
  ctx.effect(() =>
    ctx.web.route({
      method: 'POST',
      path: `${API_BASE}/action`,
      description: `plugin mutations: ${ACTIONS.join(', ')}`,
      handler: async (request) => {
        let body: ActionBody
        try {
          body = await request.readJson<ActionBody>()
        } catch (error) {
          return json({ ok: false, message: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` }, 400)
        }
        const action = typeof body?.action === 'string' ? body.action.trim() : ''
        if (!(ACTIONS as readonly string[]).includes(action)) {
          return json({ ok: false, message: `unknown action '${action}' (expected one of ${ACTIONS.join(', ')})` }, 400)
        }
        const target = typeof body?.target === 'string' ? body.target.trim() : ''
        const host = ctx.workbench.host()

        if (action === 'install') {
          const source = body?.source
          if (source === undefined || typeof source !== 'object' || (source.kind !== 'path' && source.kind !== 'git')) {
            return json({ ok: false, message: "install needs a 'source' object with kind 'path' or 'git'" }, 400)
          }
          const result = await host.install(source)
          return json({ ...result, state: host.inventory() }, result.ok ? 200 : 409)
        }

        if (target.length === 0) return json({ ok: false, message: `action '${action}' needs a 'target'` }, 400)

        if (action === 'compose') {
          const value = body?.config
          if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
            return json({ ok: false, message: "compose needs a 'config' object (it becomes plugins.<name>)" }, 400)
          }
          const before = host.inventory()
          let persisted = false
          let ok = true
          let message: string
          try {
            ctx.workbench.config().update([{ op: 'set', path: ['plugins', target], value }])
            persisted = true
            const reloaded = await host.reload(target)
            ok = reloaded.ok
            message = `composed plugin '${target}' (plugins.${target} written, ${reloaded.message})`
          } catch (error) {
            ok = false
            message = `compose '${target}' failed: ${error instanceof Error ? error.message : String(error)}`
          }
          const after = host.inventory()
          return json({ ok, action, target, request: { config: value }, persisted, before, after, message, state: after }, ok ? 200 : 409)
        }

        const mutations: Record<string, (name: string) => Promise<HostActionResult>> = {
          load: (name) => host.load(name),
          unload: (name) => host.unload(name),
          reload: (name) => host.reload(name),
          retry: (name) => host.retry(name),
          enable: (name) => host.enable(name),
          disable: (name) => host.disable(name),
          uninstall: (name) => host.uninstall(name),
        }
        const mutate = mutations[action]
        if (mutate === undefined) return json({ ok: false, message: `action '${action}' is not a plugin action` }, 400)
        const result = await mutate(target)
        return json({ ...result, state: host.inventory() }, result.ok ? 200 : 409)
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
      description: 'Install, enable, disable, retry and compose plugins through the loader API.',
    }),
  )

  ctx.workbench.log(`plugin-manager: page ${pagePath} -> ${modulePath} (API ${API_BASE})`)
}

export default { name, inject: ['workbench', 'web'], apply }
