#!/usr/bin/env node
/**
 * Seam enforcement for the capability shape THIS repository implements:
 *
 *        Provider  ->  Definition  <-  Consumer
 *
 *   provider   = a plugin directory whose manifest declares a capability with a
 *                `provider` id (`plugins/web-impl` -> `{id: "web", provider: "http"}`)
 *   definition = the contract every role talks to (`definitions/web.ts`, ...)
 *   consumer   = any OTHER plugin (it uses the capability through the seam)
 *
 * Rules (they are what makes the external loading model hold):
 *   1. NO file of this repository may import the CORE (`nexuslbs/workbench`):
 *      this repository is consumed as an EXTERNAL source and may only depend on
 *      the services, definitions and helpers it ships itself,
 *   2. a definition module must not import a plugin, a provider or `cordis`: the
 *      contract depends on nothing (its runtime helpers are structural),
 *   3. a CONSUMER must import the DEFINITION, never a provider plugin's module
 *      (a provider is replaceable: `web@1` has an `http` provider today and may
 *      have another one tomorrow),
 *   4. a PROVIDER must not import a consumer plugin's module: a provider may
 *      import its own directory and the definitions, nothing else,
 *   5. every capability a provider declares has a definition module here
 *      (`definitions/<id>.ts`) - the contract is what the seam is checked on.
 *
 * Deliberately ALLOWED: consumer <-> consumer imports (shared helpers such as
 * `plugins/web-shared` are ordinary modules), and `examples/**`.
 *
 * Usage: node scripts/check-seam.ts [root]
 * Exit code 1 when a violation is found, 0 otherwise.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Directories scanned as plugin code. */
const PLUGIN_DIRS = ['plugins', 'examples']
/** The contract modules of this repository (`definitions/<capability>.ts`). */
const DEFINITIONS_DIR = 'definitions'
/** The core package this repository must never depend on (rule 1). */
const CORE_MARKERS = ['nexuslbs/workbench', '../workbench/', '/workbench/src/']

type Layer = 'definition' | 'provider' | 'consumer' | 'other'

interface Violation {
  file: string
  layer: Layer
  message: string
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function toRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

/** Reads the capabilities a plugin manifest declares (`provider` = it IS a provider). */
function providerCapabilities(pluginDir: string): { id: string; provider: string }[] {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'workbench.plugin.json'), 'utf8'))
  } catch {
    return []
  }
  const capabilities = (raw as { capabilities?: unknown }).capabilities
  if (!Array.isArray(capabilities)) return []
  const providers: { id: string; provider: string }[] = []
  for (const entry of capabilities) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as { id?: unknown; provider?: unknown }
    if (typeof record.id !== 'string' || typeof record.provider !== 'string') continue
    providers.push({ id: record.id, provider: record.provider })
  }
  return providers
}

/** Every plugin directory that PROVIDES a capability, by directory name. */
function providerDirs(root: string): Map<string, { id: string; provider: string }[]> {
  const found = new Map<string, { id: string; provider: string }[]>()
  for (const parent of PLUGIN_DIRS) {
    const base = path.join(root, parent)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const capabilities = providerCapabilities(path.join(base, entry.name))
      if (capabilities.length > 0) found.set(`${parent}/${entry.name}`, capabilities)
    }
  }
  return found
}

/** The plugin directory a repo-relative path belongs to (`plugins/x/...` -> `plugins/x`). */
function pluginDirOf(relative: string): string | undefined {
  const parts = relative.split('/')
  if (parts.length < 2) return undefined
  if (!PLUGIN_DIRS.includes(parts[0] ?? '')) return undefined
  return `${parts[0]}/${parts[1]}`
}

function resolveSpecifier(root: string, fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined
  const base = path.resolve(path.dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return toRelative(root, candidate)
  }
  return toRelative(root, base)
}

const IMPORT_PATTERN = /(?:^|[^\w.$])(?:import|export)[\s\S]{0,400}?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm

function specifiersOf(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
  const specs: string[] = []
  for (const match of text.matchAll(IMPORT_PATTERN)) {
    const spec = match[1] ?? match[2]
    if (spec) specs.push(spec)
  }
  return specs
}

export function checkSeam(root: string): { scanned: number; violations: Violation[] } {
  const providers = providerDirs(root)
  const definitionOf = new Map<string, string>()
  for (const capabilities of providers.values()) {
    for (const capability of capabilities) definitionOf.set(capability.id, `${DEFINITIONS_DIR}/${capability.id}.ts`)
  }

  const files = [...walk(path.join(root, DEFINITIONS_DIR)), ...[...PLUGIN_DIRS].flatMap((dir) => walk(path.join(root, dir)))]
  const violations: Violation[] = []

  // Rule 5: a provided capability needs its contract module.
  for (const [capability, definition] of definitionOf) {
    if (!fs.existsSync(path.join(root, definition))) {
      violations.push({
        file: definition,
        layer: 'definition',
        message: `capability '${capability}' has a provider but no definition module (${definition})`,
      })
    }
  }

  for (const file of files) {
    const relative = toRelative(root, file)
    const dir = pluginDirOf(relative)
    const isProvider = dir !== undefined && providers.has(dir)
    const layer: Layer = relative.startsWith(`${DEFINITIONS_DIR}/`) ? 'definition' : dir === undefined ? 'other' : isProvider ? 'provider' : 'consumer'
    for (const specifier of specifiersOf(file)) {
      // Rule 1: never the core.
      if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
        if (layer === 'definition') {
          violations.push({ file: relative, layer, message: `a definition must not depend on '${specifier}': it is the contract, not a plugin` })
        }
        continue
      }
      if (CORE_MARKERS.some((marker) => specifier.includes(marker))) {
        violations.push({ file: relative, layer, message: `this repository is an EXTERNAL source and must not import the core ('${specifier}')` })
        continue
      }
      const target = resolveSpecifier(root, file, specifier)
      if (target === undefined) continue
      const targetDir = pluginDirOf(target)
      // Rule 2: a definition imports nothing of the plugin tree.
      if (layer === 'definition' && targetDir !== undefined) {
        violations.push({ file: relative, layer, message: `a definition must not import a plugin module ('${target}')` })
        continue
      }
      if (targetDir === undefined || targetDir === dir) continue
      const targetIsProvider = providers.has(targetDir)
      // Rule 3: a consumer talks to the DEFINITION, never to a provider plugin.
      if (!isProvider && targetIsProvider) {
        violations.push({
          file: relative,
          layer,
          message: `a consumer must not import the provider plugin '${targetDir}' ('${target}'): import the definition and use the seam`,
        })
        continue
      }
      // Rule 4: a provider imports its own directory and the definitions only.
      if (isProvider && !targetIsProvider) {
        violations.push({ file: relative, layer, message: `a provider must not import a consumer plugin ('${target}')` })
      }
    }
  }
  return { scanned: files.length, violations }
}

function main(): void {
  const root = path.resolve(process.argv[2] ?? DEFAULT_ROOT)
  const { scanned, violations } = checkSeam(root)
  if (violations.length === 0) {
    process.stdout.write(
      `seam check: OK (${scanned} module(s) scanned, direction Provider -> Definition <- Consumer holds, no core import)\n`,
    )
    return
  }
  process.stderr.write(`seam check: FAILED (${violations.length} violation(s))\n`)
  for (const violation of violations) {
    process.stderr.write(`  ${violation.file} (${violation.layer})\n    ${violation.message}\n`)
  }
  process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
