// External workbench plugin `credentials-basic`: the four BASIC credential
// provider backends of workbench, MOVED OUT OF THE CORE (operator rule,
// 2026-09-19: "the core must be minimal" - the core keeps at most the
// credentials INTERFACE, every implementation is a plugin).
//
//   env          the direct process environment
//   file         a JSON/YAML credentials file
//   project-env  <projectDir>/.env
//   user-env     $HOME/.env (the per-user scope)
//
// Because this plugin lives in the PUBLIC plugins repository the bootstrap
// chicken-and-egg is broken: it is fetchable from a source that needs no
// credential, and only once it is loaded do the `${cred:...}` sources and plugins
// of a config become loadable. It holds NO secret value: every provider resolves
// a credential NAME against the environment / files at RUNTIME.
//
// The manifest declares all four provider ids of the `credentials@1` contract:
//
//   "capabilities": [
//     { "id": "credentials", "version": 1, "provider": "env" },
//     { "id": "credentials", "version": 1, "provider": "file" },
//     { "id": "credentials", "version": 1, "provider": "project-env" },
//     { "id": "credentials", "version": 1, "provider": "user-env" }
//   ]
//
// so the core accepts the registrations. The config is one sub-object per
// backend; an ABSENT sub-object registers that backend with its DEFAULTS (this
// plugin is the "basic" set, so a bare `credentials-basic:` row is the useful
// default), while an unknown key is a loud config error.
import { createProvider as createEnvProvider, resolveConfig as resolveEnvConfig } from './providers/env.ts'
import { createProvider as createFileProvider, resolveConfig as resolveFileConfig } from './providers/file.ts'
import { createProvider as createProjectEnvProvider, resolveConfig as resolveProjectEnvConfig } from './providers/project-env.ts'
import { createProvider as createUserEnvProvider, resolveConfig as resolveUserEnvConfig } from './providers/user-env.ts'
import type { CredentialProvider, ProviderContext } from './types.ts'

export const name = 'credentials-basic'

/** Plugin config: one optional sub-object per backend. */
export interface Config {
  env?: Record<string, unknown>
  file?: Record<string, unknown>
  projectEnv?: Record<string, unknown>
  userEnv?: Record<string, unknown>
}

/** The sub-object keys this plugin understands; anything else is a config error. */
const KEYS = ['env', 'file', 'projectEnv', 'userEnv'] as const

function subObject(config: Config, key: (typeof KEYS)[number]): Record<string, unknown> {
  const value = config[key]
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`credentials-basic: '${key}' must be a mapping (got ${Array.isArray(value) ? 'array' : typeof value})`)
  }
  return value as Record<string, unknown>
}

/** Rejects unknown top-level keys: a typo must never silently disable a backend. */
export function resolveConfig(raw: Record<string, unknown> = {}): Config {
  const unknown = Object.keys(raw).filter((key) => !(KEYS as readonly string[]).includes(key))
  if (unknown.length > 0) {
    throw new Error(`credentials-basic: unknown config key(s) ${unknown.map((key) => JSON.stringify(key)).join(', ')} (expected ${KEYS.join(', ')})`)
  }
  return raw as Config
}

/**
 * Builds the providers this config asks for: every backend is registered, with
 * its defaults when its sub-object is absent. `configDir` is the directory of
 * the config file, used to resolve the `file`/`project-env`/`user-env` paths.
 */
export function createProviders(config: Config = {}, configDir: string = process.cwd()): CredentialProvider[] {
  return [
    createEnvProvider(resolveEnvConfig(subObject(config, 'env'))),
    createFileProvider(resolveFileConfig(subObject(config, 'file'), configDir)),
    createProjectEnvProvider(resolveProjectEnvConfig(subObject(config, 'projectEnv'), configDir), configDir),
    createUserEnvProvider(resolveUserEnvConfig(subObject(config, 'userEnv'), configDir)),
  ]
}

export function apply(ctx: ProviderContext, config: Config = {}, configDir: string = process.cwd()): void {
  const providers = createProviders(config, configDir)
  ctx.effect(() => {
    const disposers = providers.map((provider) => ctx.credentials.register(provider))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin
