/**
 * Shared helpers of the env-shaped core providers (project-env / user-env) and
 * of the direct `env` provider. A provider -> provider dependency is allowed
 * (the seam rule only forbids provider -> consumer and consumer -> provider).
 */
import fs from 'node:fs'
import os from 'node:os'
import { CREDENTIALS_VERSION, type CredentialProvider, type CredentialRef } from '../types.ts'

/** ENV-normalised form of a credential name: `demo-token` -> `DEMO_TOKEN`. */
export function envKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
}

/** Kebab form of a credential name: `DEMO_TOKEN` -> `demo-token`. */
export function kebabKey(name: string): string {
  return name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/**
 * The keys a credential name may be written as, in lookup order: the name as
 * given, then its ENV form (`demo-token` -> `DEMO_TOKEN`) and its kebab form
 * (`DEMO_TOKEN` -> `demo-token`). Deduplicated, order preserved.
 */
export function candidateKeys(name: string): string[] {
  return [...new Set([name, envKey(name), kebabKey(name)].filter((key) => key.length > 0))]
}

/**
 * Looks a credential name up in a name->value map, trying every candidate form.
 * Values are never returned empty (empty = not found).
 */
export function lookup(map: Record<string, string>, name: string): string | undefined {
  for (const key of candidateKeys(name)) {
    const value = map[key]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * Parses dotenv text: `KEY=VALUE` per line, blank lines and `#` comments
 * skipped, an optional leading `export ` ignored, one layer of matching single
 * or double quotes stripped from the value. The FIRST occurrence of a key wins
 * (later duplicates are ignored). Lines without `=` are skipped.
 */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const separator = body.indexOf('=')
    if (separator <= 0) continue
    const key = body.slice(0, separator).trim()
    if (key.length === 0 || key in result) continue
    let value = body.slice(separator + 1).trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

/** The user's home directory (`$HOME` first, then the OS answer). */
export function homeDir(): string {
  return process.env.HOME?.trim() || os.homedir()
}

/**
 * A provider that reads a dotenv file. A MISSING file answers "not found"
 * (undefined); an unreadable file is an error naming the path (never a value).
 */
export function dotenvProvider(options: { id: string; file: string; describe: string }): CredentialProvider {
  const read = (): Record<string, string> | undefined => {
    let text: string
    try {
      text = fs.readFileSync(options.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error(`${options.id}: cannot read ${options.file}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return parseDotenv(text)
  }
  return {
    id: options.id,
    version: CREDENTIALS_VERSION,
    describe: () => options.describe,
    list: () => Object.keys(read() ?? {}),
    resolve: (ref: CredentialRef) => {
      const map = read()
      return map === undefined ? undefined : lookup(map, ref.name)
    },
  }
}
