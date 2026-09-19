// plugins/web-impl - the `web@1` PROVIDER `http`: a `node:http` server for the
// web seam.
//
// The whole web capability lives in THIS repository (operator rule: the core
// hosts configuration, cordis source discovery, plugin install and `${cred:}`
// resolution ONLY). This plugin owns the serving side:
//
//   Provider (this plugin)  ->  Definition (definitions/web.ts)  <-  Consumers
//                                                                  (UI plugins)
//
// * it declares the capability in its manifest
//   (`{"id":"web","version":1,"provider":"http"}`),
// * it provides the seam as the `web` service, so ANY consumer from ANY source
//   registers routes, assets and pages through `ctx.web`,
// * it owns the listener: the shell, the registered assets, the registered
//   routes, its own `/health` endpoint and a JSON 404.
//
// PORT: the plugin row wins (`plugins.web-impl.port`), then `WORKBENCH_WEB_PORT`,
// then `WORKBENCH_PORT` - the port the workbench SERVICE publishes - and finally
// the definition default. That order is what makes ONE published port carry the
// UI and the deployment healthcheck (`/health`) when the deployment pins them
// together.
//
// Unloading the plugin closes the listener and unregisters everything it
// registered (the seam and the routes are `ctx.effect` disposers): no global
// state, no socket left behind.
import {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  WEB,
  WEB_CONTRACT,
  Web,
} from '../../definitions/web.ts'
import { provideService, serviceOf, type ServiceContext } from '../../definitions/support.ts'
import { createWebServer, MAX_BODY_BYTES, type WebServer } from './server.ts'

export const name = 'web-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'http'

export const contract = WEB_CONTRACT

/** The plugin config, i.e. the `web-impl:` row of the `plugins:` roster. */
export interface WebImplConfig {
  /** Bind host (default `WORKBENCH_WEB_HOST`, then `127.0.0.1`). */
  host?: string
  /** Bind port (default `WORKBENCH_WEB_PORT`, then `WORKBENCH_PORT`, then 12348). */
  port?: number
  /** Request body cap in bytes (default 1 MiB). */
  maxBodyBytes?: number
}

/** The host context as this plugin uses it (structural: the core is never imported). */
interface HostContext extends ServiceContext {
  effect(callback: () => (() => void) | void): () => void
}

/** The loader inventory the core's `ctx.workbench` service reports. */
interface LoaderInventory {
  plugins?: unknown[]
  sources?: unknown[]
  failures?: unknown[]
}

/** The consumer-visible subset of the core's `ctx.workbench` service. */
interface WorkbenchLike {
  inventory?: () => LoaderInventory
  /**
   * The plugin whose `apply` is running (the host loader's attribution marker).
   * The seam asks for it at REGISTRATION time, so a page/route/asset a consumer
   * registers is attributed to that consumer, exactly as it was when the seam
   * lived in the core.
   */
  attribution?: () => string
}

/** The host's workbench service, when the deployment has one. */
function workbenchOf(ctx: ServiceContext): WorkbenchLike | undefined {
  return serviceOf<WorkbenchLike>(ctx, 'workbench')
}

/** Reads a numeric environment value as a port (an invalid value is a loud error). */
function envPort(name: string): number | undefined {
  const raw = process.env[name]?.trim()
  if (!raw) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`web-impl: ${name} must be a port number (0-65535), got '${raw}'`)
  }
  return port
}

/** Bind host: the plugin row, then the environment, then the loopback default. */
export function resolveHost(config: WebImplConfig): string {
  const fromEnv = process.env.WORKBENCH_WEB_HOST?.trim()
  return config.host?.trim() || fromEnv || DEFAULT_WEB_HOST
}

/**
 * Bind port: the plugin row, then `WORKBENCH_WEB_PORT`, then `WORKBENCH_PORT`
 * (the port the service publishes), then the definition default.
 */
export function resolvePort(config: WebImplConfig): number {
  if (config.port !== undefined) return config.port
  return envPort('WORKBENCH_WEB_PORT') ?? envPort('WORKBENCH_PORT') ?? DEFAULT_WEB_PORT
}

/**
 * Applies the provider: provides the seam, starts the server, registers the
 * health endpoint. Order matters: the seam is provided BEFORE the listener
 * starts, so a consumer that registers during its own apply is served.
 */
export async function apply(ctx: ServiceContext, config: WebImplConfig = {}): Promise<void> {
  const host = ctx as unknown as HostContext
  const log = (message: string): void => {
    process.stderr.write(`[web-impl] ${message}\n`)
  }

  // Registration attribution: the host's loader marker while a plugin applies,
  // this plugin's own name when the provider registers for itself.
  const web = new Web({ owner: () => workbenchOf(ctx)?.attribution?.() ?? name })

  const health = (): string =>
    JSON.stringify(
      {
        status: 'ok',
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        contract: WEB_CONTRACT,
        ...(workbenchOf(ctx)?.inventory?.() ?? {}),
        seam: { pages: web.pages().length, routes: web.routes().length, assets: web.assets().length },
      },
      null,
      2,
    )
  const healthHandler = (): { contentType: string; body: string } => ({
    contentType: 'application/json; charset=utf-8',
    body: health() + '\n',
  })

  provideService(ctx, WEB, web)
  host.effect(() =>
    web.route({ method: 'GET', path: '/health', handler: healthHandler, description: 'the deployment healthcheck (web-impl)' }),
  )
  host.effect(() => web.route({ method: 'HEAD', path: '/health', handler: healthHandler }))

  const server: WebServer = await createWebServer(web, {
    host: resolveHost(config),
    port: resolvePort(config),
    log,
    maxBodyBytes: config.maxBodyBytes ?? MAX_BODY_BYTES,
  })
  host.effect(() => () => server.close())
  log(`serving ${WEB_CONTRACT} on ${server.url} (provider '${providerId}')`)
}
