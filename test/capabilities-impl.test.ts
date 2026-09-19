// Unit test for the CAPABILITY SERVICE HOST: the plugin that provides the two
// capability services of this repository's definitions which no provider hosts
// itself (`totp@1`, `sms@1`).
//
// It asserts the four things that make the seam work in a real deployment:
//   1. the sibling-manifest scan finds the REAL provider ids of this checkout
//      (`totp/rfc6238`, `sms/twilio`), so a provider row is declared by config
//      alone and a NEW provider needs no host edit;
//   2. `apply` PROVIDES both services and declares those ids;
//   3. an UNDECLARED provider id cannot register (the manifest stays the gate);
//   4. a declared provider registers and then ANSWERS through the Definition
//      (the definition walks the enabled providers, so registration is what made
//      `totp code` / `sms list` possible at all).
//
// Nothing here imports the core or cordis: a fake context implements exactly the
// structural `ServiceContext` the definitions rely on.
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { apply, siblingProviders } from '../plugins/capabilities-impl/index.ts'

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'capabilities-impl')

/** The definition surface the test drives (structural: no definition import). */
interface CapabilityService {
  declare(declaration: Record<string, unknown>): void
  register(descriptor: Record<string, unknown>): () => void
  providers(): Array<{ id: string; contract: string; plugin: string; enabled: boolean; registered: boolean }>
  entries(): Promise<unknown[]>
  code(label: string, options?: { at?: number }): Promise<{ label: string; code: string }>
}

/** The stubbed cordis context: provide/get/logger, nothing else. */
function fakeContext(): { ctx: Record<string, unknown>; provided: Map<string, unknown>; logs: string[] } {
  const provided = new Map<string, unknown>()
  const logs: string[] = []
  const ctx: Record<string, unknown> = {
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return value
    },
    get: (name: string) => provided.get(name),
    // The logger SERVICE is a CALLABLE that yields the levelled handle
    // (definitions/logger.ts): `ctx.logger(name).info(...)`, not an object.
    logger: (name?: string) => ({
      error: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: (...args: unknown[]) => logs.push(args.join(' ')),
      info: (...args: unknown[]) => logs.push(args.join(' ')),
      debug: (...args: unknown[]) => logs.push(args.join(' ')),
    }),
  }
  return { ctx, provided, logs }
}

test('the sibling scan finds the provider ids this checkout ships', () => {
  const found = siblingProviders(pathToFileURL(path.join(PLUGIN_DIR, 'index.ts')).href)
  const pairs = found.map((entry) => `${entry.capability}:${entry.provider}`)
  assert.ok(pairs.includes('totp:rfc6238'), `expected totp:rfc6238 in ${pairs.join(', ')}`)
  assert.ok(pairs.includes('sms:twilio'), `expected sms:twilio in ${pairs.join(', ')}`)
  // A manifest capability is what the declaration is made from: the declaring
  // plugin and the contract version travel with it.
  const rfc = found.find((entry) => entry.capability === 'totp' && entry.provider === 'rfc6238')
  assert.equal(rfc?.plugin, 'totp-rfc6238')
  assert.equal(rfc?.version, 1)
})

test('apply provides and declares both capability services', () => {
  const { ctx, provided, logs } = fakeContext()
  apply(ctx as never, {})

  const totp = provided.get('totp') as CapabilityService | undefined
  const sms = provided.get('sms') as CapabilityService | undefined
  assert.ok(totp !== undefined, 'ctx.totp must be provided')
  assert.ok(sms !== undefined, 'ctx.sms must be provided')

  assert.deepEqual(
    totp.providers().map((provider) => [provider.id, provider.plugin, provider.enabled, provider.registered]),
    [['rfc6238', 'totp-rfc6238', true, false]],
  )
  assert.deepEqual(
    sms.providers().map((provider) => [provider.id, provider.plugin, provider.enabled, provider.registered]),
    [['twilio', 'sms-twilio', true, false]],
  )
  assert.equal(logs.length, 2)
  assert.match(logs[0] as string, /provided totp@1/)
})

test('an undeclared provider id cannot register; a declared one answers', async () => {
  const { ctx, provided } = fakeContext()
  apply(ctx as never, {})
  const totp = provided.get('totp') as CapabilityService
  const sms = provided.get('sms') as CapabilityService

  // 3. The declaration is the gate: 'nope' is in no sibling manifest, even
  //    though it implements the whole provider surface.
  const stub = {
    id: 'nope',
    describe: () => 'stub',
    entries: async () => [],
    code: async () => ({}),
    numbers: async () => [],
    list: async () => [],
    get: async () => ({}),
  }
  assert.throws(() => totp.register({ ...stub }), /not declared|declar/i)
  assert.throws(() => sms.register({ ...stub }), /not declared|declar/i)

  // Nothing registered yet: the definition reports no usable provider.
  await assert.rejects(totp.entries(), /no totp provider is available/)

  // 4. A DECLARED provider registers and answers through the Definition.
  const answered: string[] = []
  totp.register({
    id: 'rfc6238',
    version: 1,
    describe: () => 'stub rfc6238',
    entries: async () => [{ label: 'github', digits: 6, period: 30, algorithm: 'SHA1', configured: true }],
    code: (label: string) => {
      answered.push(label)
      return { label, code: '287082', digits: 6, period: 30, algorithm: 'SHA1', generatedAt: 59, remainingSeconds: 1 }
    },
  })
  assert.deepEqual(await totp.entries(), [{ label: 'github', digits: 6, period: 30, algorithm: 'SHA1', configured: true }])
  assert.equal((await totp.code('github')).code, '287082')
  assert.deepEqual(answered, ['github'])
  assert.equal(totp.providers()[0]?.registered, true)

  sms.register({
    id: 'twilio',
    version: 1,
    describe: () => 'stub twilio',
    numbers: async () => [{ label: 'personal', number: '+10000000000', default: true }],
    list: async () => [],
    get: async () => ({}),
  })
  assert.equal(sms.providers()[0]?.registered, true)
})

test('the host can be told to provide neither service', () => {
  const { ctx, provided } = fakeContext()
  apply(ctx as never, { totp: false, sms: false })
  assert.equal(provided.size, 0)
})

test('a renamed provider id is hosted with no host edit (config-only selection)', () => {
  const { ctx, provided } = fakeContext()
  apply(ctx as never, { source: 'custom-source', external: false, totpProviders: ['rfc6238'] })
  const totp = provided.get('totp') as CapabilityService
  assert.equal(totp.providers()[0]?.contract, 'totp@1')
})

test('the plugin module exposes the manifest name and the default entry', async () => {
  const mod = (await import('../plugins/capabilities-impl/index.ts')) as { name: string; default: { name: string } }
  assert.equal(mod.name, 'capabilities-impl')
  assert.equal(mod.default.name, 'capabilities-impl')
})
