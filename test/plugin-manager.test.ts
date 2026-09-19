// plugin-manager: the `reconcile` action.
//
// The manager is the HTTP surface through which a config-file edit reaches the
// RUNNING workbench process. `reconcile` diffs the desired `plugins:` roster
// against the live tree and applies only the delta, so it takes NO target (it
// acts on the whole roster) and its answer carries the per-plugin delta. The
// core implements the diff (`Host.reconcile()`); this test pins the contract the
// page and any external caller relies on, with a fake context (the plugin only
// depends on the documented `ctx.web` / `ctx.workbench` seams, no core checkout).
import assert from 'node:assert/strict'
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

const INVENTORY = {
  contract: 'workbench-inventory@1',
  configFile: '/tmp/workbench.config.yml',
  plugins: [{ name: 'hello-world', version: '0.1.0', source: 'core', external: false, dir: '/tmp/hello-world' }],
  available: ['hello-otherworld'],
  discovered: [
    { name: 'hello-world', version: '0.1.0', source: 'core', external: false, dir: '/tmp/hello-world', state: 'loaded', capabilities: [], commands: [] },
    { name: 'hello-otherworld', version: '0.1.0', source: 'external-plugins', external: true, dir: '/tmp/hello-otherworld', state: 'loaded', capabilities: [], commands: [] },
  ],
  loaded: 2,
  failed: 0,
  failures: [],
  disabled: [],
  sources: [{ id: 'external-plugins', kind: 'path', dir: '/tmp/plugins' }],
  commands: [],
}

/** The extra shape `Host.reconcile()` returns on top of a plain action result. */
const REPORT = {
  ok: true,
  action: 'reconcile',
  target: '/tmp/workbench.config.yml',
  request: {},
  persisted: false,
  before: INVENTORY,
  after: INVENTORY,
  message: "reconciled the 'plugins:' roster from /tmp/workbench.config.yml: 2 desired row(s), 1 change",
  changes: [
    { name: 'hello-otherworld', desired: true, loaded: true, action: 'load', reason: "loaded from source 'external-plugins'" },
    { name: 'hello-world', desired: true, loaded: true, action: 'unchanged', reason: 'already converged' },
  ],
  deferred: [],
  errors: [],
  loaded: 2,
}

interface Fake {
  ctx: unknown
  routes: Map<string, RouteSpec>
  calls: string[]
  disposers: number[]
}

function fakeContext(report: Record<string, unknown> = REPORT): Fake {
  const routes = new Map<string, RouteSpec>()
  const calls: string[] = []
  const disposers: number[] = []
  const action = async (name: string) => ({
    ok: true,
    action: name,
    target: 'hello-world',
    request: {},
    persisted: false,
    before: INVENTORY,
    after: INVENTORY,
    message: name,
  })
  const host = {
    inventory: () => INVENTORY,
    configFilePath: () => INVENTORY.configFile,
    canPersist: () => ({ ok: true }),
    load: (name: string) => action(`load ${name}`),
    unload: (name: string) => action(`unload ${name}`),
    reload: (name: string) => action(`reload ${name}`),
    retry: (name: string) => action(`retry ${name}`),
    enable: (name: string) => action(`enable ${name}`),
    disable: (name: string) => action(`disable ${name}`),
    install: () => action('install'),
    uninstall: (id: string) => action(`uninstall ${id}`),
    reconcile: async () => {
      calls.push('reconcile')
      return report
    },
  }
  const testCtx = {
    effect(callback: () => () => void): void {
      const dispose = callback()
      disposers.push(disposers.length)
      void dispose
    },
    web: {
      route(spec: RouteSpec): () => void {
        routes.set(`${spec.method} ${spec.path}`, spec)
        return () => routes.delete(`${spec.method} ${spec.path}`)
      },
      asset: () => () => {},
      page: () => () => {},
      info: () => ({ contract: 'web@1' }),
    },
    workbench: {
      inventory: () => INVENTORY,
      host: () => host,
      log: () => {},
      config: () => ({ file: () => INVENTORY.configFile, view: () => ({}), update: () => ({}), pluginConfig: () => ({}) }),
    },
  }
  return { ctx: testCtx, routes, calls, disposers }
}

function request(body: unknown) {
  return { path: '/api/plugin-manager/action', query: new URLSearchParams(), readText: async () => JSON.stringify(body), readJson: async () => body }
}

async function apply(report?: Record<string, unknown>): Promise<Fake> {
  const entry = (await import('../plugins/plugin-manager/index.ts')) as { apply: (ctx: unknown, config?: unknown) => void }
  const fake = fakeContext(report)
  entry.apply(fake.ctx as never, {})
  assert.ok(fake.routes.has('POST /api/plugin-manager/action'), 'the manager registers its action route')
  assert.ok(fake.routes.has('GET /api/plugin-manager/state'), 'the manager registers its state route')
  return fake
}

async function post(fake: Fake, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const route = fake.routes.get('POST /api/plugin-manager/action')
  assert.ok(route)
  const response = (await route.handler(request(body))) as { status?: number; body?: string }
  return { status: response.status ?? 200, body: JSON.parse(response.body ?? '{}') as Record<string, unknown> }
}

test('plugin-manager exposes reconcile in ACTIONS and through its state endpoint', async () => {
  const entry = (await import('../plugins/plugin-manager/index.ts')) as { ACTIONS: readonly string[] }
  assert.ok(entry.ACTIONS.includes('reconcile'), 'reconcile must be one of the exposed actions')

  const fake = await apply()
  const state = fake.routes.get('GET /api/plugin-manager/state')
  const response = (await state?.handler(request({}) as never)) as { body?: string }
  const parsed = JSON.parse(response.body ?? '{}') as { actions: string[] }
  assert.ok(parsed.actions.includes('reconcile'))
})

test('plugin-manager: action "reconcile" needs no target and answers the per-plugin delta', async () => {
  const fake = await apply()
  const answer = await post(fake, { action: 'reconcile' })
  assert.equal(answer.status, 200)
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.action, 'reconcile')
  assert.equal(answer.body.persisted, false, 'reconcile persists nothing by itself: the file is the input')
  const changes = answer.body.changes as { name: string; action: string }[]
  assert.equal(changes.length, 2)
  assert.deepEqual(changes.map((change) => change.action), ['load', 'unchanged'])
  assert.deepEqual(fake.calls, ['reconcile'], 'the action reaches the loader exactly once')
  assert.ok(answer.body.state, 'the refreshed inventory is attached to the answer')
})

test('plugin-manager: a reconcile that did not converge answers 409 with ok false', async () => {
  const fake = await apply({ ...REPORT, ok: false, message: 'one row failed to load', errors: ['bad-row'] })
  const answer = await post(fake, { action: 'reconcile' })
  assert.equal(answer.status, 409)
  assert.equal(answer.body.ok, false)
  assert.deepEqual(answer.body.errors, ['bad-row'], 'the failing rows are reported, the others still converged')
  assert.deepEqual(fake.calls, ['reconcile'])
})

test('plugin-manager: reconcile is still accepted when a target is sent (it is ignored)', async () => {
  const fake = await apply()
  const answer = await post(fake, { action: 'reconcile', target: 'ignored-plugin' })
  assert.equal(answer.status, 200)
  assert.deepEqual(fake.calls, ['reconcile'])
})
