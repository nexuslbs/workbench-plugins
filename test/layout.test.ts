// Regression test for the REPOSITORY LAYOUT: the core service implementations
// live under `core/`, the consumers/tools/UI under `plugins/`, the runnable
// examples under `examples/`.
//
// The rule (README.md, "The rule that decides the tree"):
//   core/     = an IMPLEMENTATION of a workbench core service: a manifest that
//               declares a capability whose contract is a `definitions/<id>.ts`
//               module (`{id, version, provider}` for a provider, or the
//               provider-less `{id, version}` declaration of the git auth
//               STRATEGY `credentials-github-app`), or the SERVICE HOST of such
//               a contract (`capabilities-impl`, which declares no capability of
//               its own and discovers the providers from its sibling manifests);
//   plugins/  = consumers / operator tools / UI plugins: they register a
//               consumer surface (`tool:` / `command:` / `web:` / `events:` /
//               `route:` / `effect:` / `service:`), never a PROVIDER of a
//               `definitions/` contract;
//   examples/ = runnable examples (unchanged by the move).
//
// The two trees are TWO separate `sources:` in config.yml (a source scans exactly
// ONE directory) and the `plugins:` roster names every plugin by NAME, so moving
// a plugin between the trees must not change WHAT loads.
import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** The trees of this repository, in the order config.yml must declare them. */
const TREES = ['core', 'plugins', 'examples'] as const
type Tree = (typeof TREES)[number]

/** The core service implementations: the capability providers / service hosts. */
const CORE = [
  'capabilities-impl',
  'credentials-basic',
  'credentials-github-app',
  'credentials-stub',
  'docker-impl',
  'email-himalaya',
  'general-service-impl',
  'himalaya-impl',
  'http-impl',
  'logger-console',
  'logger-jsonl',
  'logger-ring',
  'shell-impl',
  'sms-twilio',
  'ssh-impl',
  'tools-impl',
  'totp-rfc6238',
  'web-impl',
].sort()

/** The consumers, operator tools, UI plugins and shared libs. */
const PLUGINS = [
  'config-watch',
  'cordis-ui',
  'email-tools',
  'events-demo',
  'events-subscriber-a',
  'events-subscriber-b',
  'hello-otherworld',
  'hello-tool',
  'hello-world',
  'logger-demo',
  'plugin-inventory',
  'plugin-manager',
  'settings',
  'sms-tools',
  'totp-tools',
  'web-page',
  'web-recipe',
  'web-session',
  'web-shared',
].sort()

/** A source/util dir that is NOT a plugin and therefore carries no manifest. */
const NOT_A_PLUGIN = ['web-shared']

/** The runnable examples that carry a manifest. */
const EXAMPLES = ['git-source-demo']

interface ProviderCapability {
  id: string
  version: number
  provider: string
}

interface Manifest {
  name: string
  version?: string
  capabilities?: (string | ProviderCapability | { id: string; version: number })[]
}

function dirsOf(tree: Tree): string[] {
  const dir = path.join(root, tree)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function manifestPath(tree: Tree, plugin: string): string {
  return path.join(root, tree, plugin, 'workbench.plugin.json')
}

function manifestOf(tree: Tree, plugin: string): Manifest {
  const file = manifestPath(tree, plugin)
  assert.ok(existsSync(file), `${tree}/${plugin}/workbench.plugin.json must exist`)
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest
}

function isProvider(
  capability: string | ProviderCapability | { id: string; version: number },
): capability is ProviderCapability {
  return typeof capability === 'object' && typeof (capability as ProviderCapability).provider === 'string'
}

const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
const config = readFileSync(path.join(root, 'config.yml'), 'utf8')

test('core/ holds exactly the classified core service implementations', () => {
  const dirs = dirsOf('core')
  assert.deepEqual(
    dirs,
    CORE,
    'core/ must hold exactly the core service implementations (move/remove of a plugin between the trees must update this list)',
  )
  for (const plugin of dirs) {
    const manifest = manifestOf('core', plugin)
    assert.equal(manifest.name, plugin, `core/${plugin} must be named '${plugin}' by its manifest`)
    const capabilities = manifest.capabilities ?? []
    const hosting = plugin === 'capabilities-impl' // the SERVICE HOST: no capability of its own
    assert.ok(
      hosting || capabilities.length > 0,
      `core/${plugin} must declare a capability (or be the service host)`,
    )
    for (const capability of capabilities) {
      if (typeof capability === 'string') continue // a service/<consumer> surface, not a definitions/ contract
      // the contract of a core service is a definitions/ module
      assert.ok(
        existsSync(path.join(root, 'definitions', `${capability.id}.ts`)),
        `core/${plugin} declares '${capability.id}': definitions/${capability.id}.ts must exist`,
      )
    }
    // a provider declaration must carry a provider id
    const providers = capabilities.filter(isProvider)
    for (const provider of providers) {
      assert.ok(provider.provider.length > 0, `core/${plugin} provider id must not be empty`)
    }
  }
})

test('plugins/ holds no provider of a definitions/ contract (consumers only)', () => {
  const dirs = dirsOf('plugins')
  assert.deepEqual(
    dirs,
    PLUGINS,
    'plugins/ must hold exactly the consumers/tools/UI/shared-lib entries',
  )
  for (const plugin of dirs) {
    if (NOT_A_PLUGIN.includes(plugin)) {
      // a shared lib: consumed by other plugins via a relative import, no manifest
      assert.ok(
        !existsSync(manifestPath('plugins', plugin)),
        `plugins/${plugin} is a shared lib and must not carry a plugin manifest`,
      )
      continue
    }
    const manifest = manifestOf('plugins', plugin)
    assert.equal(manifest.name, plugin, `plugins/${plugin} must be named '${plugin}' by its manifest`)
    const providers = (manifest.capabilities ?? []).filter(isProvider)
    assert.deepEqual(
      providers,
      [],
      `plugins/${plugin} declares a capability PROVIDER: a core service implementation belongs in core/`,
    )
  }
})

test('every plugin lives in exactly ONE tree (no duplicate, no rename)', () => {
  const seen = new Map<string, Tree>()
  for (const tree of TREES) {
    for (const plugin of dirsOf(tree)) {
      if (!existsSync(manifestPath(tree, plugin))) continue // a shared lib / resource dir
      const manifest = manifestOf(tree, plugin)
      assert.equal(manifest.name, plugin, `${tree}/${plugin} must be named '${plugin}' by its manifest`)
      const previous = seen.get(manifest.name)
      assert.equal(previous, undefined, `plugin '${manifest.name}' exists in both ${previous} and ${tree}`)
      seen.set(manifest.name, tree)
    }
  }
  // the whole plugin set is accounted for: 18 core services, 18 plugins (web-shared is
  // not a plugin) and the manifest-bearing examples
  assert.equal(
    seen.size,
    CORE.length + (PLUGINS.length - NOT_A_PLUGIN.length) + EXAMPLES.length,
    `saw ${seen.size} plugin(s)`,
  )
  for (const name of EXAMPLES) assert.equal(seen.get(name), 'examples', `'${name}' must live in examples/`)
  for (const name of CORE) assert.equal(seen.get(name), 'core', `'${name}' must live in core/`)
  for (const name of PLUGINS) {
    if (NOT_A_PLUGIN.includes(name)) continue
    assert.equal(seen.get(name), 'plugins', `'${name}' must live in plugins/`)
  }
})

test('config.yml discovers BOTH trees, core/ first, with its own source id', () => {
  const coreIndex = config.indexOf('path: ./core')
  const pluginsIndex = config.indexOf('path: ./plugins')
  assert.ok(coreIndex >= 0, 'config.yml must declare a path source for ./core')
  assert.ok(pluginsIndex >= 0, 'config.yml must declare a path source for ./plugins')
  assert.ok(
    coreIndex < pluginsIndex,
    './core must be listed FIRST: the credential providers must be discovered before any gated source is resolved',
  )
  assert.match(config, /id: workbench-plugins-core/, 'the core source needs its own source id')
  // both sources are `kind: path` rows (a source scans exactly ONE directory)
  const sourceBlock = config.slice(config.indexOf('sources:'), config.indexOf('\nplugin'))
  const paths = [...sourceBlock.matchAll(/^\s*path: (\S+)/gm)].map((match) => match[1])
  assert.ok(paths.includes('./core'), 'the core/ source must be a path source')
  assert.ok(paths.includes('./plugins'), 'the plugins/ source must be a path source')

  // the `plugins:` roster still names plugins by NAME (never by path)
  const rosterMarker = '\nplugins:\n'
  const rosterIndex = config.indexOf(rosterMarker)
  assert.ok(rosterIndex >= 0, 'config.yml must carry a plugins: roster')
  const rosterBody = config.slice(rosterIndex + rosterMarker.length)
  const names: string[] = []
  for (const line of rosterBody.split('\n')) {
    if (/^\S/.test(line)) break
    const match = /^  ([A-Za-z0-9_.-]+):/.exec(line)
    if (match) names.push(match[1])
  }
  assert.ok(names.length >= 20, `the roster must still name the plugins (saw ${names.length})`)
  const known = new Set(TREES.flatMap((tree) => dirsOf(tree)))
  const dangling = names.filter((name) => !known.has(name))
  assert.deepEqual(dangling, [], `config.yml roster rows without a plugin: ${dangling.join(', ')}`)
})

test('README.md documents the two trees and their rule', () => {
  assert.match(readme, /## Layout/, 'README must carry the Layout section')
  const table = readme.slice(readme.indexOf('The rule that decides the tree'))
  for (const tree of ['`core/`', '`plugins/`', '`examples/`']) {
    assert.ok(table.includes(tree), `the Layout rule table must mention ${tree}`)
  }
  assert.match(table, /capabilit/, 'the rule must state that a capability provider of definitions/ is core')
})
