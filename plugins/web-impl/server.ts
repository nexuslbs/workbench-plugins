/**
 * Web capability - PROVIDER `http` (plugin `web-impl`): the `node:http` server.
 *
 * It is the only module of this repository that touches a socket. It serves, in order:
 *
 *   1. the minimal core shell (HTML/CSS/JS below `/shell.css`, `/shell.js` and
 *      at `/`, `/p/<page-id>` or any registered page path),
 *   2. the static assets plugins registered (`ctx.web.asset`), read from the
 *      plugin's own directory on every request - no build step, no bundler,
 *   3. the routes plugins registered (`ctx.web.route`), through
 *      {@link Web.dispatch},
 *   4. a JSON 404 for everything else.
 *
 * Everything it registers on the seam (`GET /api/web/pages`, the shell assets)
 * is disposed when the server is closed, so the provider adds no global state.
 */
import fs from 'node:fs'
import http from 'node:http'
import {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  type Web,
  type WebHandler,
  type WebRequest,
  type WebResponse,
} from '../../definitions/web.ts'
import { renderShell, SHELL_CSS, SHELL_JS } from './shell.ts'

/** Request body cap (1 MiB): a route handler never buffers more than this. */
export const MAX_BODY_BYTES = 1024 * 1024

export interface WebServerOptions {
  /** Bind host (default `127.0.0.1`). */
  host?: string
  /** Bind port (default 12348; `0` picks a free port, reported back). */
  port?: number
  /** Log sink for request errors. */
  log?: (message: string) => void
  /** Body cap in bytes (default {@link MAX_BODY_BYTES}). */
  maxBodyBytes?: number
  /**
   * Handler called when the seam itself does not answer a request (after the
   * shell, the assets and the registered routes) and BEFORE the provider's JSON
   * 404. It is how the composition root puts another endpoint on the SAME
   * listener - `serve` keeps `/health` on the UI port when the config binds the
   * UI to the status port, so one published port carries both. Returning
   * nothing falls through to the 404.
   */
  fallback?: WebHandler
}

export interface WebServer {
  host: string
  /** The bound port (the effective one when `0` was requested). */
  port: number
  /** The URL the shell is served at. */
  url: string
  /** Stops listening and unregisters everything the provider registered. */
  close(): Promise<void>
}

function send(
  response: http.ServerResponse,
  method: string,
  payload: WebResponse,
): void {
  const body = payload.body ?? ''
  const headers: Record<string, string> = { 'cache-control': 'no-store', ...(payload.headers ?? {}) }
  headers['content-type'] = payload.contentType ?? (typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream')
  const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
  headers['content-length'] = String(buffer.byteLength)
  response.writeHead(payload.status ?? 200, headers)
  if (method === 'HEAD') response.end()
  else response.end(buffer)
}

/** True when the shell itself answers this path (GET/HEAD). */
function isShellPath(web: Web, path: string): boolean {
  if (path === '/' || path === '/index.html') return true
  if (/^\/p\/[^/]+$/.test(path)) return true
  return web.pageByPath(path) !== undefined
}

/** Reads a request body, capped; rejects with a 413-worthy error above the cap. */
function readBody(request: http.IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > cap) {
        reject(new Error(`request body exceeds the ${cap} byte cap`))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

/** Builds the I/O-free request object route handlers receive. */
function buildRequest(request: http.IncomingMessage, url: URL, cap: number): WebRequest {
  let pending: Promise<Buffer> | undefined
  const body = (): Promise<Buffer> => {
    pending ??= readBody(request, cap)
    return pending
  }
  return {
    method: (request.method ?? 'GET').toUpperCase(),
    path: decodeURIComponent(url.pathname),
    query: url.searchParams,
    headers: request.headers,
    readText: async () => (await body()).toString('utf8'),
    readJson: async <T = unknown>(): Promise<T> => {
      const text = (await body()).toString('utf8')
      if (text.trim().length === 0) return {} as T
      try {
        return JSON.parse(text) as T
      } catch (error) {
        throw new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

/**
 * Starts the `web@1` server for a {@link Web} seam. The caller owns the
 * lifecycle: `await close()` stops it and unregisters the provider's own routes.
 */
export async function createWebServer(web: Web, options: WebServerOptions = {}): Promise<WebServer> {
  const host = options.host ?? DEFAULT_WEB_HOST
  const port = options.port ?? DEFAULT_WEB_PORT
  const log = options.log ?? ((): void => undefined)
  const cap = options.maxBodyBytes ?? MAX_BODY_BYTES
  const fallback = options.fallback

  // The page index the shell mounts from: provider owned, disposed on close.
  const disposePages = web.route({
    method: 'GET',
    path: '/api/web/pages',
    description: 'the page index the shell mounts from',
    handler: () => ({
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(web.info(), null, 2) + '\n',
    }),
  })

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${host}:${port}`)
    const path = decodeURIComponent(url.pathname)
    const method = (request.method ?? 'GET').toUpperCase()
    void (async (): Promise<void> => {
      try {
        if ((method === 'GET' || method === 'HEAD') && isShellPath(web, path)) {
          send(response, method, { status: 200, contentType: 'text/html; charset=utf-8', body: renderShell(web, path) })
          return
        }
        if (method === 'GET' && path === '/shell.css') {
          send(response, method, { contentType: 'text/css; charset=utf-8', body: SHELL_CSS })
          return
        }
        if (method === 'GET' && path === '/shell.js') {
          send(response, method, { contentType: 'text/javascript; charset=utf-8', body: SHELL_JS })
          return
        }
        const asset = web.assetAt(path)
        if (asset && (method === 'GET' || method === 'HEAD')) {
          try {
            send(response, method, { contentType: asset.contentType, body: fs.readFileSync(asset.file) })
          } catch (error) {
            log(`web: asset ${asset.path} -> ${asset.file} is not readable: ${error instanceof Error ? error.message : String(error)}`)
            send(response, method, {
              status: 404,
              contentType: 'application/json; charset=utf-8',
              body: JSON.stringify({ status: 'not found', path, reason: 'asset file is not readable' }) + '\n',
            })
          }
          return
        }
        const dispatched = await web.dispatch(buildRequest(request, url, cap))
        if (dispatched) {
          send(response, method, dispatched)
          return
        }
        const fellThrough = fallback ? await fallback(buildRequest(request, url, cap)) : undefined
        if (fellThrough) {
          send(response, method, fellThrough)
          return
        }
        send(response, method, {
          status: 404,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ status: 'not found', method, path }) + '\n',
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`web: ${method} ${path} failed: ${message}`)
        send(response, method, {
          status: 500,
          contentType: 'application/json; charset=utf-8',
          body: JSON.stringify({ status: 'error', method, path, error: message }) + '\n',
        })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const address = server.address()
  const boundPort = typeof address === 'object' && address ? address.port : port
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host

  return {
    host,
    port: boundPort,
    url: `http://${displayHost}:${boundPort}`,
    close: async () => {
      disposePages()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
