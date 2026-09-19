/**
 * plugin-inventory - the Host Loader's live plugin inventory as a web page.
 *
 * Read-only, and deliberately thin: the page shows what the LOADER knows (the
 * same data `workbench plugins` prints), never a file it scraped or a config it
 * parsed itself. It consumes the core through `ctx.workbench.inventory()` only.
 *
 * External plugin rule: the core package is never imported. The interfaces
 * below are the structural description of the `web@1` and `workbench` surfaces
 * this plugin uses (see docs/PLUGIN-CONTRACT.md sections 4 and 4c).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** Page/route identity; the manifest's capability names the same page. */
export const PAGE_ID = 'plugin-inventory'
/** Base path of this plugin's JSON API. */
export const API_BASE = `/api/${PAGE_ID}`

// ---------------------------------------------------------------- seam types
// Structural copies: an external plugin must not import the core package.

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

/** One plugin as the loader discovered it (`HostInventory.discovered`). */
interface InventoryEntry {
  name: string
  version: string
  description?: string
  dir: string
  source: string
  external: boolean
  capabilities: string[]
  state: string
  /** True when the config NAMES the plugin under `plugins:` (the roster). */
  roster?: boolean
  error?: string
  commands: string[]
}

/** The loader inventory (`HostInventory`, the data of `workbench plugins`). */
interface HostInventory {
  configFile: string
  plugins: unknown[]
  sources: unknown[]
  failures: unknown[]
  disabled: string[]
  /**
   * Discovered plugins the config does NOT name under `plugins:`: installable in
   * one click (`enable`), never loaded. The "available plugins to load" list.
   */
  available: string[]
  discovered: InventoryEntry[]
  commands: unknown[]
}

interface WorkbenchService {
  inventory(): HostInventory
  log(message: string): void
}

interface PluginContext {
  effect(setup: () => void | (() => void)): void
  web: WebService
  workbench: WorkbenchService
}

export interface PluginInventoryConfig {
  /** Nav title of the page. */
  page?: string
  /** URL path the shell answers with itself. */
  path?: string
}

/** JSON response helper: every route of this plugin answers JSON. */
function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

export const name = PAGE_ID

/**
 * Registers the inventory API, the page module asset and the nav entry. Every
 * registration is a cordis effect, so unloading the plugin removes them again.
 */
export function apply(ctx: PluginContext, config: PluginInventoryConfig = {}): void {
  const title = config.page ?? 'Plugin Inventory'
  const pagePath = config.path ?? `/${PAGE_ID}`
  const modulePath = `/plugins/${PAGE_ID}/app.js`

  // The whole inventory, exactly as the loader reports it (`workbench plugins`).
  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: API_BASE,
      description: "the Host Loader's live plugin inventory (read-only)",
      handler: () => {
        const inventory = ctx.workbench.inventory()
        return json({
          contract: 'plugin-inventory@1',
          configFile: inventory.configFile,
          entries: inventory.discovered,
          loaded: inventory.plugins.length,
          failed: inventory.failures.length,
          disabled: inventory.disabled,
          // The ROSTER split: discovered plugins the config does not name are
          // AVAILABLE (installable in one click), never loaded.
          available: inventory.available,
          sources: inventory.sources,
          commands: inventory.commands,
        })
      },
    }),
  )

  // The entries on their own (a smaller payload for the table).
  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: `${API_BASE}/plugins`,
      description: 'the discovered plugins with their live state (loaded / available / disabled / failed)',
      handler: () => json(ctx.workbench.inventory().discovered),
    }),
  )

  // The page module, served straight from this plugin directory (no build step).
  ctx.effect(() =>
    ctx.web.asset({
      path: modulePath,
      file: path.join(HERE, 'web', 'app.js'),
      contentType: 'text/javascript; charset=utf-8',
    }),
  )

  // The nav entry + mount point the core shell renders.
  ctx.effect(() =>
    ctx.web.page({
      id: PAGE_ID,
      title,
      path: pagePath,
      module: modulePath,
      description: "The Host Loader's current plugin inventory (name, version, source, path, state, capabilities).",
    }),
  )

  ctx.workbench.log(`plugin-inventory: page ${pagePath} -> ${modulePath} (API ${API_BASE})`)
}

export default { name, inject: ['workbench', 'web'], apply }
