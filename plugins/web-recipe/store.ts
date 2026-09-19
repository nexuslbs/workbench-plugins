// `web-recipe` STORAGE: one human-readable JSON document per domain, written
// ATOMICALLY (temp file + fsync + rename) into a configured directory.
//
// Two refusals matter more than convenience here:
//   - an UNKNOWN schemaVersion is never reinterpreted: a document written by a
//     newer build is refused, not silently coerced into this build's model;
//   - an OLDER schemaVersion is only accepted when a migration for it is
//     registered - "no migration registered" is a refusal, not a best effort.
// The store keeps NO secret: a recipe names credentials, never carries them.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  RECIPE_SCHEMA_VERSION,
  buildRecipe,
  normalizeDomain,
  summarize,
  validatePatch,
  validateStored,
} from './schema.ts'
import type { Recipe, RecipePatch, RecipeSummary } from './schema.ts'

/** A named storage failure: `code` is stable, `message` is for a caller. */
export class RecipeError extends Error {
  readonly code: string
  readonly violations: string[]
  readonly detail: Record<string, unknown>

  constructor(code: string, message: string, options: { violations?: string[]; detail?: Record<string, unknown> } = {}) {
    super(message)
    this.name = 'RecipeError'
    this.code = code
    this.violations = options.violations ?? []
    this.detail = options.detail ?? {}
  }
}

/** `workbench recipe delete` modes: park the file, or remove it. */
export type DeleteMode = 'disable' | 'purge'

/** The store directory when the config omits `dir`. */
export function defaultRecipeDir(): string {
  return path.join(os.tmpdir(), 'workbench-web-recipe')
}

/**
 * The deterministic filename of a domain: `<host>.json`, with everything the
 * filesystem may dislike replaced by `_`. A normalized domain never contains a
 * slash, so the name is stable across runs and platforms.
 */
export function recipeFileName(domain: string): string {
  return `${domain.replace(/[^a-z0-9.-]/g, '_')}.json`
}

let tmpCounter = 0

/** An OLDER->newer migration. Registered per source version, never guessed. */
type Migration = (document: Record<string, unknown>) => Record<string, unknown>

/** The per-domain recipe store. */
export class RecipeStore {
  readonly dir: string
  private readonly migrations: Map<number, Migration>

  constructor(dir: string, migrations: Map<number, Migration> = new Map()) {
    this.dir = dir
    this.migrations = migrations
  }

  /** The file a domain is stored in (validates the domain first). */
  fileFor(domain: string): string {
    const key = normalizeDomain(domain)
    if (key === undefined) {
      throw new RecipeError('invalid_domain', `'${domain}' is not a usable domain key`, {
        violations: [`domain: '${domain}' must be a host name such as 'github.com'`],
      })
    }
    return path.join(this.dir, recipeFileName(key))
  }

  /** The recipe of a domain, or `undefined` when this domain has no file. */
  async read(domain: string): Promise<Recipe | undefined> {
    const file = this.fileFor(domain)
    let body: string
    try {
      body = await fs.readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new RecipeError('storage_error', `cannot read '${file}': ${messageOf(error)}`, { detail: { file } })
    }
    let document: unknown
    try {
      document = JSON.parse(body)
    } catch (error) {
      throw new RecipeError('recipe_corrupt', `'${file}' is not valid JSON: ${messageOf(error)}`, { detail: { file } })
    }
    const migrated = this.applySchemaVersion(document, file)
    const validated = validateStored(this.keyOf(domain), migrated)
    if (!validated.ok) {
      throw new RecipeError('recipe_invalid', `'${file}' does not satisfy the recipe schema`, {
        violations: validated.violations,
        detail: { file },
      })
    }
    return validated.recipe
  }

  /** Write a validated recipe atomically (temp file + fsync + rename). */
  async write(recipe: Recipe): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true })
    const file = this.fileFor(recipe.domain)
    const tmp = `${file}.tmp-${String(process.pid)}-${String(tmpCounter++)}`
    const body = `${JSON.stringify(recipe, null, 2)}\n`
    const handle = await fs.open(tmp, 'w', 0o600)
    try {
      await handle.writeFile(body, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await fs.rename(tmp, file)
    } catch (error) {
      await fs.rm(tmp, { force: true })
      throw new RecipeError('storage_error', `cannot write '${file}': ${messageOf(error)}`, { detail: { file } })
    }
    return file
  }

  /** Validate + merge a patch over the stored recipe, then write it. */
  async save(
    domain: string,
    patch: unknown,
    options: { now?: string; requireExists?: boolean } = {},
  ): Promise<{ recipe: Recipe; file: string; created: boolean }> {
    const key = normalizeDomain(domain)
    if (key === undefined) {
      throw new RecipeError('invalid_domain', `'${domain}' is not a usable domain key`, {
        violations: [`domain: '${domain}' must be a host name such as 'github.com'`],
      })
    }
    const existing = await this.read(key)
    if (existing === undefined && options.requireExists === true) {
      throw new RecipeError('not_found', `no recipe for '${key}'`, { detail: { domain: key } })
    }
    const validated = validatePatch(patch)
    if (!validated.ok) {
      throw new RecipeError('recipe_invalid', `the recipe for '${key}' was refused`, {
        violations: validated.violations,
        detail: { domain: key },
      })
    }
    const recipe = buildRecipe(key, validated.patch, existing, { now: options.now ?? new Date().toISOString() })
    const file = await this.write(recipe)
    return { recipe, file, created: existing === undefined }
  }

  /**
   * Park or remove a recipe. `disable` keeps the document (provenance survives)
   * and marks it unused; `purge` deletes the file.
   */
  async remove(domain: string, mode: DeleteMode = 'disable', options: { now?: string } = {}): Promise<{ file: string; disabled: boolean; removed: boolean }> {
    const key = normalizeDomain(domain)
    if (key === undefined) {
      throw new RecipeError('invalid_domain', `'${domain}' is not a usable domain key`, {
        violations: [`domain: '${domain}' must be a host name such as 'github.com'`],
      })
    }
    const file = this.fileFor(key)
    if (mode === 'purge') {
      try {
        await fs.rm(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new RecipeError('not_found', `no recipe for '${key}'`, { detail: { domain: key } })
        }
        throw new RecipeError('storage_error', `cannot remove '${file}': ${messageOf(error)}`, { detail: { file } })
      }
      return { file, disabled: false, removed: true }
    }
    const saved = await this.save(key, { disabled: true }, { now: options.now, requireExists: true })
    return { file: saved.file, disabled: true, removed: false }
  }

  /** Every stored recipe, as the compact summaries `recipe list` answers with. */
  async list(): Promise<{ recipes: RecipeSummary[]; problems: Array<{ file: string; error: string }> }> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { recipes: [], problems: [] }
      throw new RecipeError('storage_error', `cannot list '${this.dir}': ${messageOf(error)}`, { detail: { dir: this.dir } })
    }
    const recipes: RecipeSummary[] = []
    const problems: Array<{ file: string; error: string }> = []
    for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
      const domain = entry.slice(0, -'.json'.length)
      try {
        const recipe = await this.read(domain)
        if (recipe !== undefined) recipes.push(summarize(recipe))
      } catch (error) {
        problems.push({ file: entry, error: messageOf(error) })
      }
    }
    return { recipes, problems }
  }

  /** The schemaVersion gate: refuse, or run the REGISTERED migration chain. */
  private applySchemaVersion(document: unknown, file: string): unknown {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return document
    let current = document as Record<string, unknown>
    const version = current.schemaVersion
    if (version === RECIPE_SCHEMA_VERSION) return current
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      throw new RecipeError('schema_version_unknown', `'${file}' carries no usable schemaVersion (${JSON.stringify(version)})`, {
        detail: { file, schemaVersion: version, supported: RECIPE_SCHEMA_VERSION },
      })
    }
    if (version > RECIPE_SCHEMA_VERSION) {
      throw new RecipeError(
        'schema_version_unknown',
        `'${file}' was written with schemaVersion ${String(version)}; this build understands ${String(RECIPE_SCHEMA_VERSION)} and never reinterprets a newer document`,
        { detail: { file, schemaVersion: version, supported: RECIPE_SCHEMA_VERSION } },
      )
    }
    let from = version
    while (from < RECIPE_SCHEMA_VERSION) {
      const migration = this.migrations.get(from)
      if (migration === undefined) {
        throw new RecipeError(
          'schema_version_unsupported',
          `'${file}' uses schemaVersion ${String(from)} and no migration to ${String(from + 1)} is registered: refusing to reinterpret it`,
          { detail: { file, schemaVersion: from, supported: RECIPE_SCHEMA_VERSION } },
        )
      }
      current = migration(current)
      from += 1
    }
    return current
  }

  private keyOf(domain: string): string {
    return normalizeDomain(domain) ?? domain
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
