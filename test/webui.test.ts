// Web UI plugins: every plugin of this repository that contributes a surface to
// the workbench Web UI must (a) register its routes / asset / page through the
// documented `ctx.web` seam, (b) answer its read endpoints without throwing,
// and (c) dispose all of them again when the plugin is unloaded. The tests use
// a fake context (no core checkout required), exactly like the other plugin
// tests here: the plugin only depends on the documented services.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

interface RouteSpec {
  method: string
  path: string
  handler: (request: unknown) => unknown
  description?: string
}

interface PageSpec {
  id: string
  title: string
  path: string
  module: string
}

const INVENTORY = {
  contract: 'workbench-inventory@1',
  configFile: '/tmp/workbench.config.yml',
  plugins: [
    { name: 'hello-world', version: '0.1.0', source: 'core', external: false, dir: '/w/workbench/plugins/hello-world' },
    { name: 'plugin-inventory', version: '0.1.0', source: 'workbench-plugins', external: true, dir: '/w/workbench-plugins/plugins/plugin-inventory' },
  ],
  discovered: [
    { name: 'hello-world', version: '0.1.0', source: 'core', external: false, dir: '/w/workbench/plugins/hello-world', state: 'loaded', capabilities: ['command:hello world'], commands: ['hello world'] },
    { name: 'plugin-inventory', version: '0.1.0', source: 'workbench-plugins', external: true, dir: '/w/workbench-plugins/plugins/plugin-inventory', state: 'loaded', capabilities: ['page:plugin-inventory'], commands: [] },
  ],
  loaded: 2,
  failed: 0,
  failures: [],
  disabled: [],
  sources: [{ id: 'core', kind: 'path', dir: '/w/workbench/plugins', external: false, plugins: 2 }],
}

interface FakeOptions {
  /** Replaces the raw config value the fake config seam serves (unexpanded). */
  configValue?: Record<string, unknown>
  /** Per plugin name: what the fake EXPANDED accessor returns (values resolved). */
  expanded?: Record<string, Record<string, unknown>>
  /** Replaces the fake cordis registry service (what `entries()` yields). */
  registry?: { size?: number; entries?: () => Iterable<unknown> }
}

function fakeContext(options: FakeOptions = {}) {
  const routes = new Map<string, RouteSpec>()
  const assets: string[] = []
  const pages: PageSpec[] = []
  const disposers: (() => void)[] = []

  const host = {
    inventory: () => INVENTORY,
    configFilePath: () => INVENTORY.configFile,
    canPersist: () => true,
    // Models the core's EXPANDED per-plugin accessor: `${env:VAR}` is resolved
    // there, which is exactly why no read surface may take its data from it.
    pluginConfigView: (name: string) =>
      options.expanded?.[name] ?? { name, config: { message: 'Hi' }, written: { message: 'Hi' }, disabled: false },
    load: async (name: string) => ({ ok: true, action: 'load', target: name, message: `loaded ${name}`, persisted: false }),
    unload: async (name: string) => ({ ok: true, action: 'unload', target: name, message: `unloaded ${name}`, persisted: false }),
    reload: async (name: string) => ({ ok: true, action: 'reload', target: name, message: `reloaded ${name}`, persisted: false }),
    enable: async (name: string) => ({ ok: true, action: 'enable', target: name, message: `enabled ${name}`, persisted: true }),
    disable: async (name: string) => ({ ok: true, action: 'disable', target: name, message: `disabled ${name}`, persisted: true }),
    retry: async (name: string) => ({ ok: true, action: 'retry', target: name, message: `retried ${name}`, persisted: false }),
    install: async (source: unknown) => ({ ok: true, action: 'install-source', target: 'x', message: 'installed', persisted: true, source }),
  }

  const configView = {
    file: INVENTORY.configFile,
    format: 'yaml',
    text: 'sources:\n  - kind: path\n    id: core\n    path: ./plugins\n',
    value: options.configValue ?? {
      sources: [{ kind: 'path', id: 'core', path: './plugins' }],
      plugins: { 'plugin-inventory': { page: 'Inventory' } },
      web: { enabled: true },
    },
  }

  const ctx = {
    web: {
      route(spec: RouteSpec): () => void {
        routes.set(`${spec.method} ${spec.path}`, spec)
        return () => routes.delete(`${spec.method} ${spec.path}`)
      },
      asset(spec: { path: string }): () => void {
        assets.push(spec.path)
        return () => {
          const index = assets.indexOf(spec.path)
          if (index >= 0) assets.splice(index, 1)
        }
      },
      page(spec: PageSpec): () => void {
        pages.push(spec)
        return () => {
          const index = pages.indexOf(spec)
          if (index >= 0) pages.splice(index, 1)
        }
      },
      info: () => ({ contract: 'web@1', routes: [...routes.keys()], assets: [...assets], pages: [...pages] }),
    },
    workbench: {
      inventory: () => INVENTORY,
      host: () => host,
      log: () => {},
      commands: () => [{ name: 'hello world', plugin: 'hello-world' }],
      config: () => ({
        file: () => INVENTORY.configFile,
        view: () => configView,
        update: () => configView,
        pluginConfig: (name: string) => host.pluginConfigView(name),
      }),
    },
    registry: options.registry ?? { available: false, size: 0, entries: () => [] },
    effect(callback: () => () => void): void {
      disposers.push(callback())
    },
  }
  return { ctx, routes, assets, pages, disposers }
}

const PLUGINS = ['plugin-inventory', 'plugin-manager', 'settings', 'cordis-ui'] as const

const request = { path: '/', query: new Map<string, string>([['name', 'hello-world']]), readJson: async () => ({ action: 'reload', target: 'hello-world' }) }

for (const plugin of PLUGINS) {
  test(`${plugin}: registers routes, an asset and a page, and answers its reads`, async () => {
    const entry = await import(`../plugins/${plugin}/index.ts`)
    const { ctx, routes, assets, pages } = fakeContext()

    entry.apply(ctx as never, {})

    assert.ok(routes.size >= 2, `${plugin} must register at least a read and a write route (got ${routes.size})`)
    assert.equal(assets.length, 1, `${plugin} must register exactly one page module asset`)
    assert.equal(pages.length, 1, `${plugin} must register exactly one page`)
    assert.equal(pages[0].id, plugin, 'the page id is the plugin id')

    const moduleFile = path.join(ROOT, 'plugins', plugin, pages[0].module.replace(`/plugins/${plugin}/`, 'web/'))
    assert.ok(fs.existsSync(moduleFile), `the registered page module must exist on disk: ${moduleFile}`)
    assert.match(pages[0].module, new RegExp(`^/plugins/${plugin}/`), 'the page module is served under the plugin prefix')

    for (const route of routes.values()) {
      if (route.method !== 'GET') continue
      const response = (await route.handler(request)) as { status: number; body: unknown }
      assert.ok(response && typeof response.status === 'number', `${route.path} must return a response`)
      assert.ok(response.status < 500, `${route.method} ${route.path} must not fail: ${typeof response.body === 'string' ? response.body : JSON.stringify(response.body)}`)
    }
  })

  test(`${plugin}: disposing the plugin removes its routes, asset and page`, async () => {
    const entry = await import(`../plugins/${plugin}/index.ts`)
    const { ctx, routes, assets, pages, disposers } = fakeContext()

    entry.apply(ctx as never, {})
    assert.ok(routes.size > 0 && assets.length === 1 && pages.length === 1)

    for (const dispose of disposers) dispose()

    assert.equal(routes.size, 0, 'disposal must remove every route')
    assert.equal(assets.length, 0, 'disposal must remove the asset')
    assert.equal(pages.length, 0, 'disposal must remove the page')
  })
}

test('plugin-inventory reads the loader inventory through the contract (no scraping)', async () => {
  const entry = await import('../plugins/plugin-inventory/index.ts')
  const { ctx, routes } = fakeContext()
  entry.apply(ctx as never, {})

  const read = [...routes.values()].find((route) => route.method === 'GET' && !route.path.endsWith('/plugins'))
  assert.ok(read, 'plugin-inventory must expose a read route for the inventory')
  const response = (await read.handler(request)) as { status: number; body: unknown }
  assert.equal(response.status, 200)
  const payload = (typeof response.body === 'string' ? JSON.parse(response.body) : response.body) as { entries: unknown[]; loaded: number }
  assert.equal(payload.loaded, INVENTORY.loaded)
  assert.deepEqual(payload.entries, INVENTORY.discovered, 'the page serves the loader inventory verbatim')
})

test('settings: a config reference is served BY NAME - the `${env:VAR}` value is never resolved', async () => {
  const entry = await import('../plugins/settings/index.ts')
  const reference = '${env:DEMO_TOKEN}'
  const value = 's3cr3t-DO-NOT-LEAK-42'
  const { ctx, routes } = fakeContext({
    configValue: {
      sources: [{ kind: 'path', id: 'core', path: './plugins' }],
      plugins: { 'hello-world': { message: `env ref ${reference}`, other: 'cred ref ${secret:DEMO_TOKEN}' } },
    },
    // What the core's expanded accessor answers (the shape the leak came from).
    expanded: { 'hello-world': { message: `env ref ${value}`, other: 'cred ref ${secret:DEMO_TOKEN}' } },
  })

  entry.apply(ctx as never, {})

  const reads = [...routes.values()].filter((route) => route.method === 'GET')
  assert.ok(reads.length >= 2, `settings must expose its read routes (got ${reads.length})`)
  for (const route of reads) {
    const response = (await route.handler(request)) as { status: number; body: unknown }
    assert.equal(response.status, 200, `${route.path} must answer 200`)
    const body = typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
    assert.ok(body.includes(reference), `${route.path} must show the reference by name`)
    assert.ok(!body.includes(value), `${route.path} must never return the referenced value`)
  }
})

test('cordis-ui: a registry fiber is named by the RUNTIME, not by the plugin function key', async () => {
  const entry = await import('../plugins/cordis-ui/index.ts')
  // What `registry.entries()` yields for a plugin registered as a plain function:
  // the key is that function (its `.name` is the JS function name), the value is
  // the Runtime that carries the plugin's declared name.
  function namedByFunction() {}
  const runtime = { name: 'hello-world', fibers: [{ state: 'active', getEffects: () => [1, 2] }] }
  const { ctx, routes } = fakeContext({ registry: { size: 1, entries: () => [[namedByFunction, runtime]] } })

  entry.apply(ctx as never, {})

  const read = [...routes.values()].find((route) => route.method === 'GET' && route.path.endsWith('/runtime'))
  assert.ok(read, 'cordis-ui must expose its runtime read route')
  const response = (await read.handler(request)) as { status: number; body: string }
  assert.equal(response.status, 200)
  const payload = JSON.parse(response.body) as { registry: { fibers: unknown[] } }
  assert.deepEqual(
    payload.registry.fibers,
    [{ name: 'hello-world', state: 'active', effects: 2 }],
    'the fiber must be named after the runtime, never after the plugin function key',
  )
})

test('every web UI plugin declares the services it consumes in inject', async () => {
  for (const plugin of PLUGINS) {
    const entry = await import(`../plugins/${plugin}/index.ts`)
    const inject = (entry.default as { inject?: string[] }).inject ?? []
    assert.ok(inject.includes('workbench'), `${plugin} must inject 'workbench'`)
    assert.ok(inject.includes('web'), `${plugin} must inject 'web'`)
  }
})
