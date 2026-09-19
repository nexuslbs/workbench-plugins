/**
 * Credentials provider `user-env`: the user level env file, i.e.
 * `$HOME/.env` by default (the per-user scope).
 *
 * Moved out of the core (operator rule, 2026-09-19: the core ships NO provider
 * implementation). Semantics unchanged (core `docs/CREDENTIALS.md`): the file
 * defaults to `<dir>/.env` where `dir` is the plugin's configured `dir`,
 * defaulting to the user's home directory (`$HOME`, then the OS answer); an
 * explicit `file` wins over `dir`. A missing file answers "not found"; a key is
 * looked up exactly, then as its ENV-normalised form (`demo-token` ->
 * `DEMO_TOKEN`). `ref.scope` is ignored.
 */
import path from 'node:path'
import { type CredentialProvider, type ProviderContext } from '../types.ts'
import { dotenvProvider, homeDir } from './dotenv.ts'

/** Plugin name (also the per-plugin config key in the workbench config). */
export const name = 'credentials-user-env'
/** Provider id this module registers. */
export const providerId = 'user-env'

export interface Config {
  /** User directory (default: the user's home directory). */
  dir?: string
  /** Env file (default: `<dir>/.env`); wins over `dir` when given. */
  file?: string
}

/** Normalises the plugin config: relative paths resolve against the config dir. */
export function resolveConfig(raw: Record<string, unknown> = {}, configDir: string): Config {
  const dir = raw.dir
  const file = raw.file
  for (const [key, value] of [['dir', dir], ['file', file]] as const) {
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`credentials-user-env: '${key}' must be a non-empty string (got ${JSON.stringify(value)})`)
    }
  }
  const config: Config = {}
  if (typeof dir === 'string') config.dir = path.resolve(configDir, dir)
  if (typeof file === 'string') config.file = path.resolve(configDir, file)
  return config
}

/** The user env file this config points at. */
export function envFile(config: Config): string {
  if (config.file) return config.file
  return path.resolve(config.dir ?? homeDir(), '.env')
}

export function createProvider(config: Config): CredentialProvider {
  const file = envFile(config)
  return dotenvProvider({
    id: providerId,
    file,
    describe: `user env file ${file}`,
  })
}

export function apply(ctx: ProviderContext, config: Config): void {
  const provider = createProvider(config)
  ctx.effect(() => ctx.credentials.register(provider))
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin
