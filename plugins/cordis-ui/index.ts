/**
 * cordis-ui - inspect and manage the LIVE cordis runtime from the Web UI.
 *
 * Two halves:
 *
 *   GET  /api/cordis-ui/runtime        the live runtime as it is: the services
 *                                      the context carries (and one fact about
 *                                      each), the registry entries (plugins /
 *                                      fibers / their effects) and the loader
 *                                      states of the plugin set.
 *   POST /api/cordis-ui/action         { action, target } - start / stop /
 *                                      reload / dispose a plugin on the live
 *                                      runtime, plus `inspect` for one entry.
 *
 * The manage side goes through the loader API (`ctx.workbench.host()`), which
 * drives the very same fiber operations the boot uses; the answer carries the
 * runtime before and after, so the page shows the real change.
 *
 * External plugin rule: the core package is never imported, and the cordis
 * internals are read DEFENSIVELY (duck typing): the registry shape is not part
 * of this plugin's contract, so a missing or renamed member degrades to
 * "unavailable" instead of failing the page.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const PAGE_ID = 'cordis-ui'
export const API_BASE = `/api/${PAGE_ID}`

/** Actions the page can drive on the live runtime. */
export const ACTIONS = ['start', 'stop', 'reload', 'dispose', 'inspect'] as const
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
  info(): WebSeamInfo
}

interface WebSeamInfo {
  contract: string
  routes: unknown[]
  assets: unknown[]
  pages: unknown[]
}

interface InventoryEntry {
  name: string
  version: string
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
  load(name: string): Promise<HostActionResult>
  unload(name: string): Promise<HostActionResult>
  reload(name: string): Promise<HostActionResult>
}

interface WorkbenchService {
  inventory(): HostInventory
  host(): HostApi
  commands(): { name: string; plugin?: string }[]
  log(message: string): void
}

/** A live fiber of the registry, AS OBSERVED (every field optional). */
interface RuntimeFiber {
  name: string
  state?: string
  effects?: number
}

interface RegistryLike {
  size?: number
  entries?: () => Iterable<unknown>
}

interface ServiceFact {
  service: string
  available: boolean
  facts: Record<string, unknown>
}

interface RuntimeView {
  contract: string
  services: ServiceFact[]
  registry: { available: boolean; size?: number; fibers: RuntimeFiber[]; note?: string }
  loader: { entries: InventoryEntry[]; failures: unknown[]; disabled: string[] }
}

interface PluginContext {
  effect(setup: () => void | (() => void)): void
  web: WebService
  workbench: WorkbenchService
  credentials?: unknown
  registry?: RegistryLike
  reflect?: unknown
}

export interface CordisUiConfig {
  page?: string
  path?: string
}

function json(body: unknown, status = 200): WebResponse {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(body, null, 2)}\n` }
}

function countOf(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined
}

/**
 * cordis' registry maps a plugin to its `Runtime`, and the Runtime owns the
 * fibers that ran it; the LAST fiber is the live one. A Runtime passed straight
 * in (already a fiber-shaped object) is used as is.
 */
function pickFiber(holder: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (holder === undefined) return undefined
  if (typeof holder.getEffects === 'function' || holder.state !== undefined) return holder
  const fibers = holder.fibers as Iterable<unknown> | undefined
  if (fibers === undefined || typeof fibers[Symbol.iterator] !== 'function') return undefined
  const candidates = [...fibers].filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
  return candidates[candidates.length - 1]
}

/** Normalises one registry entry, tolerating `[plugin, runtime]` or `{plugin, fiber}`. */
function fiberOf(item: unknown): RuntimeFiber | undefined {
  let plugin: Record<string, unknown> | undefined
  let runtime: Record<string, unknown> | undefined
  if (Array.isArray(item)) {
    const pair = item as unknown[]
    plugin = pair[0] as Record<string, unknown> | undefined
    runtime = pair[1] as Record<string, unknown> | undefined
  } else if (item !== null && typeof item === 'object') {
    const holder = item as Record<string, unknown>
    plugin = holder.plugin as Record<string, unknown> | undefined
    runtime = (holder.runtime ?? holder.fiber) as Record<string, unknown> | undefined
  } else {
    return undefined
  }
  const name = (plugin?.name ?? runtime?.name) as string | undefined
  if (name === undefined || name.length === 0) return undefined
  const fiber = pickFiber(runtime)
  let effects: number | undefined
  if (fiber !== undefined && typeof fiber.getEffects === 'function') {
    try {
      effects = countOf((fiber.getEffects as () => unknown).call(fiber))
    } catch {
      effects = undefined
    }
  }
  return {
    name,
    ...(fiber?.state === undefined ? {} : { state: String(fiber.state) }),
    ...(effects === undefined ? {} : { effects }),
  }
}

/**
 * Reads a service off the context, tolerating cordis' guard that throws when a
 * service is not `inject`ed (e.g. `ctx.credentials` in a plugin that does not
 * inject it). An absent service is a FACT the page reports, not a 500.
 */
function optionalService(ctx: unknown, name: string): Record<string, unknown> | undefined {
  try {
    const value = (ctx as Record<string, unknown>)[name]
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The live runtime view: services + registry + loader states. */
export function runtimeView(ctx: PluginContext): RuntimeView {
  const web = ctx.web.info()
  const inventory = ctx.workbench.inventory()

  const services: ServiceFact[] = [
    {
      service: 'workbench',
      available: typeof ctx.workbench === 'object' && ctx.workbench !== null,
      facts: {
        commands: countOf(ctx.workbench.commands()),
        plugins: inventory.plugins.length,
        host: typeof ctx.workbench.host === 'function',
      },
    },
    {
      service: 'web',
      available: typeof ctx.web === 'object' && ctx.web !== null,
      facts: {
        contract: web.contract,
        routes: web.routes.length,
        assets: web.assets.length,
        pages: web.pages.length,
      },
    },
    { service: 'credentials', available: optionalService(ctx, 'credentials') !== undefined, facts: {} },
    { service: 'reflect', available: optionalService(ctx, 'reflect') !== undefined, facts: {} },
  ]

  const registryService = optionalService(ctx, 'registry') as { size?: number; entries?: () => unknown } | undefined
  const registry: RuntimeView['registry'] = { available: false, fibers: [] }
  if (registryService !== undefined) {
    registry.available = true
    registry.size = registryService.size
    if (typeof registryService.entries === 'function') {
      const fibers: RuntimeFiber[] = []
      try {
        for (const item of registryService.entries() as unknown[]) {
          const fiber = fiberOf(item)
          if (fiber !== undefined) fibers.push(fiber)
        }
      } catch (error) {
        registry.note = `entries() failed: ${error instanceof Error ? error.message : String(error)}`
      }
      registry.fibers = fibers
    } else {
      registry.note = 'this cordis build exposes no registry.entries()'
    }
  } else {
    registry.note = 'no registry service on this context'
  }

  return {
    contract: 'cordis-ui@1',
    services,
    registry,
    loader: { entries: inventory.discovered, failures: inventory.failures, disabled: inventory.disabled },
  }
}

export const name = PAGE_ID

export function apply(ctx: PluginContext, config: CordisUiConfig = {}): void {
  const title = config.page ?? 'Cordis UI'
  const pagePath = config.path ?? `/${PAGE_ID}`
  const modulePath = `/plugins/${PAGE_ID}/app.js`

  ctx.effect(() =>
    ctx.web.route({
      method: 'GET',
      path: `${API_BASE}/runtime`,
      description: 'the live cordis runtime: services, registry fibers, loader states',
      handler: () => json(runtimeView(ctx)),
    }),
  )

  ctx.effect(() =>
    ctx.web.route({
      method: 'POST',
      path: `${API_BASE}/action`,
      description: `live runtime management: ${ACTIONS.join(', ')}`,
      handler: async (request) => {
        let body: { action?: string; target?: string }
        try {
          body = await request.readJson<{ action?: string; target?: string }>()
        } catch (error) {
          return json({ ok: false, message: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` }, 400)
        }
        const action = typeof body?.action === 'string' ? body.action.trim() : ''
        const target = typeof body?.target === 'string' ? body.target.trim() : ''
        if (!(ACTIONS as readonly string[]).includes(action)) {
          return json({ ok: false, message: `unknown action '${action}' (expected one of ${ACTIONS.join(', ')})` }, 400)
        }
        if (target.length === 0) return json({ ok: false, message: `action '${action}' needs a 'target'` }, 400)

        const host = ctx.workbench.host()
        const before = runtimeView(ctx)

        if (action === 'inspect') {
          const fiber = before.registry.fibers.find((item) => item.name === target)
          const entry = before.loader.entries.find((item) => item.name === target)
          return json({ ok: fiber !== undefined || entry !== undefined, action, target, fiber, entry, runtime: before })
        }

        const mutations: Record<string, (name: string) => Promise<HostActionResult>> = {
          start: (name) => host.load(name),
          stop: (name) => host.unload(name),
          reload: (name) => host.reload(name),
          dispose: (name) => host.unload(name),
        }
        const mutate = mutations[action]
        if (mutate === undefined) return json({ ok: false, message: `action '${action}' is not a runtime action` }, 400)
        const result = await mutate(target)
        const after = runtimeView(ctx)
        return json(
          {
            ok: result.ok,
            action,
            target,
            persisted: result.persisted,
            message: result.message,
            entry: after.loader.entries.find((item) => item.name === target),
            fiber: after.registry.fibers.find((item) => item.name === target),
            runtimeBefore: before,
            runtime: after,
          },
          result.ok ? 200 : 409,
        )
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
      description: 'Inspect the live cordis runtime (services, fibers, effects) and manage a plugin on it.',
    }),
  )

  ctx.workbench.log(`cordis-ui: page ${pagePath} -> ${modulePath} (API ${API_BASE})`)
}

export default { name, inject: ['workbench', 'web'], apply }
