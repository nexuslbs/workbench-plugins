/**
 * Credentials provider `project-env`: the project level env file, i.e.
 * `<projectDir>/.env` (the project scope).
 *
 * Moved out of the core (operator rule, 2026-09-19: the core ships NO provider
 * implementation). Semantics unchanged (core `docs/CREDENTIALS.md`): the file
 * defaults to `<dir>/.env` where `dir` is the plugin's configured `dir`,
 * defaulting to the config file directory (the project root); an explicit `file`
 * wins over `dir`. A missing file answers "not found"; a key is looked up
 * exactly, then as its ENV-normalised form (`demo-token` -> `DEMO_TOKEN`).
 * `ref.scope` is ignored.
 */
import path from 'node:path'
import { type CredentialProvider, type ProviderContext } from '../types.ts'
import { dotenvProvider } from './dotenv.ts'

/** Plugin name (also the per-plugin config key in the workbench config). */
export const name = 'credentials-project-env'
/** Provider id this module registers. */
export const providerId = 'project-env'

export interface Config {
  /** Project directory (default: the config file directory). */
  dir?: string
  /** Env file (default: `<dir>/.env`); wins over `dir` when given. */
  file?: string
}

/** Normalises the plugin config: paths become absolute against the config dir. */
export function resolveConfig(raw: Record<string, unknown> = {}, configDir: string): Config {
  const dir = raw.dir
  const file = raw.file
  for (const [key, value] of [['dir', dir], ['file', file]] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`credentials-project-env: '${key}' must be a non-empty string (got ${JSON.stringify(value)})`)
    }
  }
  const config: Config = {}
  if (typeof dir === 'string') config.dir = path.resolve(configDir, dir)
  if (typeof file === 'string') config.file = path.resolve(configDir, file)
  return config
}

/** The project env file this config points at. */
export function envFile(config: Config, configDir: string): string {
  if (config.file) return config.file
  return path.resolve(config.dir ?? configDir, '.env')
}

export function createProvider(config: Config, configDir: string): CredentialProvider {
  const file = envFile(config, configDir)
  return dotenvProvider({
    id: providerId,
    file,
    describe: `project env file ${file}`,
  })
}

export function apply(ctx: ProviderContext, config: Config, configDir: string = process.cwd()): void {
  const provider = createProvider(config, configDir)
  ctx.effect(() => ctx.credentials.register(provider))
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin
