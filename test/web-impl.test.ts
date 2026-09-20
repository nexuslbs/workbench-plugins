// web-impl - the `web@1` PROVIDER (plugin). The test proves the provider side of
// the seam end to end with a fake host context (no core checkout, exactly like
// the other plugin tests here):
//
//   1. the plugin DECLARES the capability `web@1` in its manifest,
//   2. applying it PROVIDES the `web` service on the host context,
//   3. a consumer that registers a route/asset/page through that service is
//      REALLY served over HTTP (a real listener, a real socket) and `/health`
//      answers with the contract id,
//   4. unloading it closes the listener and unregisters the seam (no leak).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { WEB, WEB_CONTRACT, Web } from '../definitions/web.ts'
import { apply, name as pluginName, providerId, resolvePort } from '../core/web-impl/index.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The host context as the seam uses it: provide/get/effect, nothing else. */
function fakeHost() {
  const services = new Map<string, unknown>()
  const disposers: (() => void)[] = []
  const ctx = {
    provide: (serviceName: string, value: unknown): void => {
      services.set(serviceName, value)
    },
    get: (serviceName: string): unknown => services.get(serviceName),
    effect: (callback: () => (() => void) | void): (() => void) => {
      const disposer = callback()
      if (disposer) disposers.push(disposer)
      return () => disposer?.()
    },
  }
  return {
    ctx,
    service: <T>(serviceName: string): T | undefined => services.get(serviceName) as T | undefined,
    async dispose(): Promise<void> {
      for (const disposer of disposers.reverse()) disposer()
      disposers.length = 0
    },
  }
}

/** A free port on the loopback interface (the provider needs one to listen on). */
async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function get(url: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        body += chunk
      })
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }))
    })
    request.on('error', reject)
  })
}

test('web-impl: the manifest declares the web@1 capability with provider http', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'core', 'web-impl', 'workbench.plugin.json'), 'utf8'))
  assert.equal(manifest.name, pluginName)
  assert.equal(providerId, 'http')
  assert.deepEqual(manifest.capabilities, [{ id: 'web', version: 1, provider: 'http' }])
  assert.deepEqual(manifest.policies, { web: { provide: WEB_CONTRACT } })
})

test('web-impl: apply provides the seam, serves a consumer registration and answers /health', async () => {
  const host = fakeHost()
  const port = await freePort()
  assert.equal(host.service<Web>(WEB), undefined)

  await apply(host.ctx, { host: '127.0.0.1', port })
  try {
    // 2. the seam is provided under the documented service name.
    const web = host.service<Web>(WEB)
    assert.ok(web instanceof Web, 'the provider provides the web service')

    // 3. a CONSUMER (any plugin from any source) registers through the seam and
    //    is really served by the provider's listener.
    const offRoute = web.route({
      method: 'GET',
      path: '/api/consumer/ping',
      handler: () => ({ contentType: 'application/json', body: '{"pong":true}\n' }),
      description: 'a consumer route',
    })
    const offAsset = web.asset({ path: '/consumer.js', file: fileURLToPath(import.meta.url) })
    const offPage = web.page({ id: 'consumer', title: 'Consumer', path: '/consumer', module: '/consumer.js' })

    const health = await get(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
    const payload = JSON.parse(health.body) as { status: string; contract: string }
    assert.equal(payload.status, 'ok')
    assert.equal(payload.contract, WEB_CONTRACT)

    const ping = await get(`http://127.0.0.1:${port}/api/consumer/ping`)
    assert.equal(ping.status, 200)
    assert.equal(ping.body, '{"pong":true}\n')

    const asset = await get(`http://127.0.0.1:${port}/consumer.js`)
    assert.equal(asset.status, 200)
    assert.ok(asset.body.includes('web@1'))

    const pages = await get(`http://127.0.0.1:${port}/api/web/pages`)
    assert.equal(pages.status, 200)
    assert.ok(pages.body.includes('/consumer'))

    const missing = await get(`http://127.0.0.1:${port}/nothing-here`)
    assert.equal(missing.status, 404)

    offRoute()
    offAsset()
    offPage()
    const gone = await get(`http://127.0.0.1:${port}/api/consumer/ping`)
    assert.equal(gone.status, 404, 'a disposed registration stops being served')
  } finally {
    // 4. unloading the plugin releases the socket and the seam.
    await host.dispose()
    await assert.rejects(get(`http://127.0.0.1:${port}/health`), 'the listener is closed')
  }
})

test('web-impl: the port comes from the row, then the environment, then the default', () => {
  const before = process.env.WORKBENCH_PORT
  try {
    delete process.env.WORKBENCH_PORT
    delete process.env.WORKBENCH_WEB_PORT
    assert.equal(resolvePort({}), 8080)
    process.env.WORKBENCH_PORT = '8080'
    assert.equal(resolvePort({}), 8080)
    process.env.WORKBENCH_WEB_PORT = '12500'
    assert.equal(resolvePort({}), 12500)
    assert.equal(resolvePort({ port: 9999 }), 9999)
  } finally {
    if (before === undefined) process.env.WORKBENCH_PORT = ''
    else process.env.WORKBENCH_PORT = before
    delete process.env.WORKBENCH_WEB_PORT
  }
})
