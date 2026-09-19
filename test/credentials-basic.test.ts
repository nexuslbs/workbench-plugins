// Tests for the EXTERNAL credentials provider plugin `credentials-basic`
// (`plugins/credentials-basic/`), the four basic backends moved out of the core.
//
// What is asserted: every backend answers by credential NAME, the env-shaped
// backends accept the ENV-normalised form of a name, a missing file/name is
// "not found" (never a throw), an unknown config key is a LOUD error, and the
// plugin registers exactly the four provider ids its manifest declares and
// unregisters them on disposal. No cordis dependency: the context is a fake.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  apply,
  createProviders,
  resolveConfig,
} from '../plugins/credentials-basic/index.ts'
import type { CredentialProvider } from '../plugins/credentials-basic/types.ts'

/** A fake cordis context: records registrations and unwinds them on dispose. */
function fakeContext(): { ctx: { credentials: { register(p: CredentialProvider): () => void }; effect(cb: () => () => void): void }; ids: () => string[]; dispose: () => void } {
  const live = new Map<string, CredentialProvider>()
  let teardown: (() => void) | undefined
  return {
    ctx: {
      credentials: {
        register(provider) {
          live.set(provider.id, provider)
          return () => live.delete(provider.id)
        },
      },
      effect(callback) {
        const dispose = callback()
        teardown = dispose
        return dispose
      },
    },
    ids: () => [...live.keys()].sort(),
    dispose: () => teardown?.(),
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-credentials-basic-'))
}

function providerFor(id: string, config: Record<string, unknown>, dir: string): CredentialProvider {
  const provider = createProviders(resolveConfig(config), dir).find((candidate) => candidate.id === id)
  assert.ok(provider, `expected a provider with id '${id}'`)
  return provider
}

test('the plugin registers the four provider ids of its manifest and disposes them', () => {
  const fake = fakeContext()
  apply(fake.ctx, {}, tempDir())
  assert.deepEqual(fake.ids(), ['env', 'file', 'project-env', 'user-env'])
  fake.dispose()
  assert.deepEqual(fake.ids(), [])
})

test('env: resolves a name exactly and in its ENV-normalised form; empty is not found', async () => {
  process.env.WORKBENCH_BASIC_DEMO = 'value-from-the-environment'
  try {
    const env = providerFor('env', {}, tempDir())
    assert.equal(await env.resolve({ name: 'WORKBENCH_BASIC_DEMO' }), 'value-from-the-environment')
    assert.equal(await env.resolve({ name: 'workbench-basic-demo' }), 'value-from-the-environment')
    assert.equal(await env.resolve({ name: 'NOT_SET_ANYWHERE' }), undefined)
  } finally {
    delete process.env.WORKBENCH_BASIC_DEMO
  }
})

test('file: resolves names and scopes from a JSON credentials file; missing name/file is not found', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ 'demo-token': 'from-the-file', staging: { 'demo-token': 'from-the-scope' } }))
  const fileProvider = providerFor('file', { file: { path: file } }, dir)
  assert.equal(await fileProvider.resolve({ name: 'demo-token' }), 'from-the-file')
  assert.equal(await fileProvider.resolve({ name: 'DEMO_TOKEN' }), 'from-the-file')
  assert.equal(await fileProvider.resolve({ name: 'demo-token', scope: 'staging' }), 'from-the-scope')
  assert.equal(await fileProvider.resolve({ name: 'absent' }), undefined)
  const missing = providerFor('file', { file: { path: path.join(dir, 'nope.json') } }, dir)
  assert.equal(await missing.resolve({ name: 'demo-token' }), undefined)
})

test('file: YAML credentials files are accepted (mapping of names and scopes)', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'credentials.yml')
  fs.writeFileSync(file, ['# a comment', 'demo-token: from-the-yaml-file', 'staging:', '  demo-token: from-the-yaml-scope', ''].join('\n'))
  const yamlProvider = providerFor('file', { file: { path: file } }, dir)
  assert.equal(await yamlProvider.resolve({ name: 'demo-token' }), 'from-the-yaml-file')
  assert.equal(await yamlProvider.resolve({ name: 'demo-token', scope: 'staging' }), 'from-the-yaml-scope')
})
test('file: YAML block scalars (| and >) resolve multi-line credentials such as a PEM', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'block.yml')
  fs.writeFileSync(
    file,
    [
      'GITHUB_APP_KEY: |',
      '  -----BEGIN PRIVATE KEY-----',
      '  MIIEvQIBADANBg',
      '  -----END PRIVATE KEY-----',
      'FOLDED: >',
      '  one',
      '  two',
      '',
    ].join('\n'),
  )
  const blockProvider = providerFor('file', { file: { path: file } }, dir)
  assert.equal(
    await blockProvider.resolve({ name: 'GITHUB_APP_KEY' }),
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----\n',
  )
  assert.equal(await blockProvider.resolve({ name: 'FOLDED' }), 'one two\n')
})

test('project-env: reads <dir>/.env relative to the given project directory', async () => {
  const dir = tempDir()
  fs.writeFileSync(path.join(dir, '.env'), 'PROJECT_DEMO_TOKEN=from-the-project-env\n')
  const projectEnv = providerFor('project-env', {}, dir)
  assert.equal(await projectEnv.resolve({ name: 'PROJECT_DEMO_TOKEN' }), 'from-the-project-env')
  assert.equal(await projectEnv.resolve({ name: 'project-demo-token' }), 'from-the-project-env')
})

test('user-env: reads the configured user env file', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'user.env')
  fs.writeFileSync(file, 'USER_DEMO_TOKEN=from-the-user-env\n')
  const userEnv = providerFor('user-env', { userEnv: { file } }, dir)
  assert.equal(await userEnv.resolve({ name: 'USER_DEMO_TOKEN' }), 'from-the-user-env')
})

test('an unknown config key is a loud error (a typo never disables a backend silently)', () => {
  assert.throws(() => resolveConfig({ projectENV: { file: '.env' } }), /unknown config key/)
  assert.throws(() => createProviders({ env: { path: '/tmp/x' } }), /credentials-env: unknown config key/)
})
