// Unit test for the external credentials provider: it must register a provider
// honouring `credentials@1` on the injected context, resolve through a
// Vault-style HTTP backend, and never leak a value into an error message.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  apply,
  CONTRACT_VERSION,
  createProvider,
  default as plugin,
  name,
  providerId,
  readConfig,
  resolveConfig,
  type Config,
} from '../plugins/credentials-stub/index.ts'

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'credentials-stub')

interface RequestSeen {
  url: string
  token: string | undefined
}

/** A tiny Vault-style KV stub: one KV-v2 key, one flat key, 404 and 500 paths. */
async function startStub(): Promise<{ url: string; seen: RequestSeen[]; close: () => Promise<void> }> {
  const seen: RequestSeen[] = []
  const server = http.createServer((request, response) => {
    seen.push({ url: request.url ?? '', token: request.headers['x-vault-token'] as string | undefined })
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    switch (request.url) {
      case '/v1/secret/data/demo-token':
        return send(200, { data: { data: { value: 'example-stub-token' } } })
      case '/v1/secret/data/flat-token':
        return send(200, { value: 'example-flat-token' })
      case '/v1/secret/data/team/deploy-token':
        return send(200, { data: { value: 'example-scoped-token' } })
      case '/v1/secret/data/absent':
        return send(404, { errors: [] })
      case '/v1/secret/data/boom':
        return send(500, { errors: ['boom'] })
      default:
        return send(404, { errors: [] })
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object', 'the stub must listen on a port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}

function makeContext() {
  const registered: { id: string; version: number; describe?: () => string }[] = []
  const disposers: (() => void)[] = []
  const logs: string[] = []
  const ctx = {
    credentials: {
      register(provider: { id: string; version: number; describe?: () => string }): () => void {
        registered.push(provider)
        return () => {
          const index = registered.indexOf(provider)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    workbench: {
      log(message: string): void {
        logs.push(message)
      },
    },
    effect(callback: () => () => void): void {
      disposers.push(callback())
    },
  }
  return { ctx, registered, disposers, logs }
}

test('the manifest DECLARES the credentials capability (what makes the provider resolvable)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'workbench.plugin.json'), 'utf8')) as {
    name: string
    entry: string
    capabilities: unknown[]
  }
  assert.equal(manifest.name, name)
  assert.equal(manifest.entry, 'index.ts')
  assert.deepEqual(manifest.capabilities, [{ id: 'credentials', version: CONTRACT_VERSION, provider: providerId }])
})

test('registers a credentials@1 provider on the injected context', () => {
  const { ctx, registered, disposers } = makeContext()
  apply(ctx, { url: 'http://127.0.0.1:1' })
  assert.deepEqual(
    registered.map((provider) => [provider.id, provider.version]),
    [[providerId, CONTRACT_VERSION]],
  )
  for (const dispose of disposers) dispose()
  assert.equal(registered.length, 0)
})

// `apply` receives `{}` for every discovered plugin WITHOUT a `plugins.<name>`
// config row (docs/PLUGIN-CONTRACT.md): that is the normal DEV state, so it must
// not be a load failure and must not register a provider that cannot answer.
test('an UNCONFIGURED plugin loads: no throw, no provider, a not-configured announcement', () => {
  const { ctx, registered, disposers, logs } = makeContext()
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.doesNotThrow(() => apply(ctx, { mount: 'kv' })) // partial config: url still missing
  assert.deepEqual(registered, [])
  assert.equal(disposers.length, 0)
  assert.equal(logs.length, 2)
  assert.match(logs[0] ?? '', /credentials-stub: not configured \(no 'url' in plugins\.credentials-stub\)/)
  assert.match(logs[0] ?? '', /'stub-vault' is declared but not registered/)
})

test('resolves a KV v2 secret, a flat secret and a scoped secret through the SAME backend', async () => {
  const stub = await startStub()
  try {
    const provider = createProvider({ url: stub.url })
    assert.equal(await provider.resolve({ name: 'demo-token' }), 'example-stub-token')
    assert.equal(await provider.resolve({ name: 'flat-token' }), 'example-flat-token')
    assert.equal(await provider.resolve({ name: 'deploy-token', scope: 'team' }), 'example-scoped-token')
    // A 404 is "not found", never an error.
    assert.equal(await provider.resolve({ name: 'absent' }), undefined)
  } finally {
    await stub.close()
  }
})

test('sends the configured token and never puts it (or a value) in an error', async () => {
  const stub = await startStub()
  try {
    const provider = createProvider({ url: stub.url, token: 'example-stub-token-header' })
    await provider.resolve({ name: 'demo-token' })
    assert.equal(stub.seen[0]?.token, 'example-stub-token-header')

    await assert.rejects(
      () => provider.resolve({ name: 'boom' }),
      (error: Error) => {
        assert.match(error.message, /answered HTTP 500/)
        assert.match(error.message, /secret\/data\/boom/)
        assert.ok(!error.message.includes('example-stub-token-header'), 'the token must not leak')
        assert.ok(!error.message.includes('example-stub-token'), 'no value may leak')
        return true
      },
    )
  } finally {
    await stub.close()
  }
})

test('an unreachable endpoint is an error naming the endpoint, not a value', async () => {
  const provider = createProvider({ url: 'http://127.0.0.1:1' })
  await assert.rejects(() => provider.resolve({ name: 'demo-token' }), /stub-vault: cannot reach http:\/\/127\.0\.0\.1:1/)
})

test('resolveConfig requires a url and defaults the mount', () => {
  assert.throws(() => resolveConfig({} as Partial<Config>), /'url' must be a non-empty string/)
  const config: Config = resolveConfig({ url: 'http://vault:8200' })
  assert.deepEqual(config, { url: 'http://vault:8200' })
})

test('readConfig treats a missing url as NOT CONFIGURED and still validates a present one', () => {
  assert.equal(readConfig({}), undefined)
  assert.equal(readConfig({ mount: 'kv' }), undefined)
  assert.equal(readConfig({ url: '' }), undefined)
  assert.throws(() => readConfig({ url: 42 as unknown as string }), /'url' must be a non-empty string/)
  assert.deepEqual(readConfig({ url: 'http://vault:8200', mount: 'kv' }), { url: 'http://vault:8200', mount: 'kv' })
})

test('entry export and manifest agree on the plugin name', () => {
  assert.equal(plugin.name, name)
  assert.deepEqual((plugin as { inject?: string[] }).inject, ['credentials', 'workbench'])
})
