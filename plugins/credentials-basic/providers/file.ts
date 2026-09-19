/**
 * Credentials provider `file`: a credentials file whose LOCATION is
 * configuration. The config carries the path/format, never the values.
 *
 * Moved out of the core (operator rule, 2026-09-19: the core ships NO provider
 * implementation). Semantics unchanged (core `docs/CREDENTIALS.md`): the file is
 * a JSON or YAML mapping whose keys are either credential names with string
 * values or scopes (nested mappings of credential names). A reference with a
 * scope resolves in `doc[scope][name]`, a reference without one in `doc[name]`.
 * A MISSING file answers "not found" (undefined); an unreadable/invalid file, a
 * non-string value or an unknown extension is an error naming the key/path -
 * never a value.
 *
 * This repository has no YAML dependency, so YAML is parsed by the small
 * mapping-only reader below: the documented shape (names/scopes -> strings) and
 * nothing else. JSON stays the recommended format.
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  CREDENTIALS_VERSION,
  refLabel,
  type CredentialProvider,
  type CredentialRef,
  type ProviderContext,
} from '../types.ts'
import { candidateKeys } from './dotenv.ts'

/** Plugin name (also the per-plugin config key in the workbench config). */
export const name = 'credentials-file'
/** Provider id this module registers. */
export const providerId = 'file'

/** Default file name, resolved against the config file directory. */
export const DEFAULT_FILE = 'credentials.json'

export interface Config {
  /** Absolute path of the credentials file (resolved against the config dir). */
  path: string
  /** Explicit format; default: by extension (`.json` = JSON, `.yml`/`.yaml` = YAML). */
  format?: 'json' | 'yaml'
}

/** Normalises the plugin config: the path becomes absolute, the format validated. */
export function resolveConfig(raw: Record<string, unknown> = {}, configDir: string): Config {
  const rawPath = raw.path === undefined ? DEFAULT_FILE : raw.path
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error(`credentials-file: 'path' must be a non-empty string (got ${JSON.stringify(rawPath)})`)
  }
  const format = raw.format
  if (format !== undefined && format !== 'json' && format !== 'yaml') {
    throw new Error(`credentials-file: 'format' must be 'json' or 'yaml' (got ${JSON.stringify(format)})`)
  }
  const file = path.resolve(configDir, rawPath)
  return format === undefined ? { path: file } : { path: file, format }
}

function formatOf(config: Config): 'json' | 'yaml' {
  if (config.format) return config.format
  const ext = path.extname(config.path).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  throw new Error(`credentials-file: cannot tell the format of ${config.path}; use .json/.yml/.yaml or set 'format'`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Strips one layer of matching quotes. */
function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

/** Removes a trailing `# comment` from an unquoted scalar. */
function stripComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) return value
  const index = value.indexOf(' #')
  return index === -1 ? value : value.slice(0, index).trim()
}

/**
 * Parses the documented YAML shape: a top-level mapping whose values are either
 * scalars or one-level nested mappings (scopes), 2-space indentation, `#`
 * comments. Anything else is a loud error - this is a credential file, not a
 * general YAML document.
 */
export function parseYamlMapping(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let scope: Record<string, unknown> | undefined
  let scopeIndent = -1
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const indent = rawLine.length - rawLine.trimStart().length
    const separator = line.indexOf(':')
    if (separator <= 0) {
      throw new Error(`credentials-file: cannot parse YAML line ${JSON.stringify(line)} (expected 'name: value')`)
    }
    const key = unquote(line.slice(0, separator).trim())
    const rawValue = line.slice(separator + 1).trim()
    if (rawValue.length === 0) {
      const nested: Record<string, unknown> = {}
      if (indent === 0 || scope === undefined || indent <= scopeIndent) {
        root[key] = nested
        scope = nested
        scopeIndent = indent
      } else {
        scope[key] = nested
      }
      continue
    }
    const value = unquote(stripComment(rawValue))
    const target = scope !== undefined && indent > scopeIndent ? scope : root
    target[key] = value
  }
  return root
}

/** Reads and parses the file; undefined when it does not exist. */
function readDocument(config: Config): Record<string, unknown> | undefined {
  let text: string
  try {
    text = fs.readFileSync(config.path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`credentials-file: cannot read ${config.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const format = formatOf(config)
  let parsed: unknown
  try {
    parsed = format === 'json' ? JSON.parse(text) : parseYamlMapping(text)
  } catch (error) {
    throw new Error(`credentials-file: invalid ${format.toUpperCase()} in ${config.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (!isRecord(parsed)) throw new Error(`credentials-file: ${config.path} must contain a mapping of credential names`)
  return parsed
}

function names(table: Record<string, unknown>): string[] {
  return Object.entries(table)
    .filter(([, value]) => typeof value === 'string')
    .map(([key]) => key)
}

export function createProvider(config: Config): CredentialProvider {
  return {
    id: providerId,
    version: CREDENTIALS_VERSION,
    describe: () => `credentials file ${config.path}`,
    list: () => {
      const document = readDocument(config)
      if (document === undefined) return []
      const top = Object.entries(document).filter(([, value]) => typeof value === 'string').map(([key]) => key)
      const scoped = Object.entries(document)
        .filter(([, value]) => isRecord(value))
        .flatMap(([scopeName, value]) => names(value as Record<string, unknown>).map((key) => `${scopeName}/${key}`))
      return [...top, ...scoped]
    },
    resolve: (ref: CredentialRef) => {
      const document = readDocument(config)
      if (document === undefined) return undefined
      const label = refLabel(ref)
      if (ref.scope) {
        const namespace = document[ref.scope]
        if (namespace === undefined) return undefined
        if (!isRecord(namespace)) {
          throw new Error(`credentials-file: '${ref.scope}' in ${config.path} must be a mapping of credential names`)
        }
        return stringLookup(namespace, ref.name, label, config)
      }
      return stringLookup(document, ref.name, label, config)
    },
  }
}

/**
 * Looks a name up by its candidate forms (exact, ENV form, kebab form), so a
 * file keyed `deploy-token` answers `DEPLOY_TOKEN` too.
 */
function stringLookup(table: Record<string, unknown>, lookupName: string, label: string, config: Config): string | undefined {
  for (const key of candidateKeys(lookupName)) {
    if (!(key in table)) continue
    const resolved = stringValue(table[key], label, config)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

/** A configured key holding anything but a string is a config error (never a value). */
function stringValue(value: unknown, label: string, config: Config): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`credentials-file: '${label}' in ${config.path} must be a string (got ${Array.isArray(value) ? 'array' : typeof value})`)
  }
  return value === '' ? undefined : value
}

export function apply(ctx: ProviderContext, config: Config): void {
  const provider = createProvider(config)
  ctx.effect(() => ctx.credentials.register(provider))
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin
