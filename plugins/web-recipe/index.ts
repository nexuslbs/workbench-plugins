// `web-recipe`: the DURABLE per-domain recipe store, plus the service that makes
// a repeated site ONE cheap call.
//
// It is an external workbench plugin with three seams, nothing else:
//   - `ctx.tools.register(defineTool(...))` (tools@1, public plugins repo): the five
//     `recipe *` tools an agent/operator drives;
//   - `ctx.provide('web-recipe', service)`: the consumer contract web-page looks
//     up (`ctx.inject(['web-recipe'], ...)`), so the read-through is a SERVICE
//     lookup and NOT an import of another plugin's internals;
//   - `ctx.credentials`: a recipe stores credential NAMES; this plugin resolves
//     only when a verification needs one, at call time, and never logs a value.
//
// NO CORE CHANGE IS NEEDED for any of this: the core keeps hosting plugins, the
// store and the contract live here.
import { RecipeError, RecipeStore, defaultRecipeDir } from './store.ts'
import type { DeleteMode } from './store.ts'
import {
  DEFAULT_POLICY,
  RECORDED_CONFIDENCE,
  buildRecipe,
  domainOfUrl,
  normalizeDomain,
  summarize,
  validatePatch,
  withVerification,
  recipeUsable,
} from './schema.ts'
import type { Recipe, RecipePatch, RecipePolicy, RecipeSummary } from './schema.ts'
import { verifyRecipe } from './verify.ts'
import type { RecipeVerifier, VerifyOutcome, VerifyOptions } from './verify.ts'
import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'web-recipe'

export type { Recipe, RecipePatch, RecipeSummary } from './schema.ts'
export type { VerifyOutcome, VerifyOutcome as RecipeVerifyOutcome } from './verify.ts'

/** The `plugins: web-recipe:` row, exactly as an operator writes it. */
export interface WebRecipeConfig {
  /** Where recipes live (default `<tmp>/workbench-web-recipe`). */
  dir?: string
  /** A recipe below this confidence is not used by the read-through (0.2). */
  minConfidence?: number
  /** When > 0, a recipe older than this many days (since `lastVerifiedAt`) is not used (0 = no age limit). */
  maxAgeDays?: number
  /** Demote a recipe whose verification failed (default true). */
  demoteOnFailure?: boolean
  /** How much a verification moves confidence (default 0.2). */
  demoteStep?: number
  /** May a CONSUMER record a discovery at all? (default true; the consumer has its own `record` gate.) */
  acceptRecords?: boolean
  /** Confidence a freshly recorded (never verified) recipe starts with (0.3). */
  recordConfidence?: number
  /** HTTP timeout of `recipe verify` (default 10000 ms). */
  verifyTimeoutMs?: number
}

/** What a consumer tells the store when it discovers a site's read path. */
export interface RecipeDiscovery extends RecipePatch {
  /** The domain key, or a URL the store derives it from. */
  domain?: string
  url?: string
}

/** The service web-page (and any other consumer) looks up by name. */
export interface WebRecipeService {
  /** The contract tag, so a consumer can refuse an incompatible service. */
  readonly contract: 'web-recipe@1'
  /** The freshness policy this store applies to the read-through. */
  readonly policy: RecipePolicy
  /** The raw recipe of a domain (tools + operators). */
  get(domain: string): Promise<Recipe | undefined>
  /** The read-through lookup: the recipe of a URL's domain + whether it is usable. */
  lookup(urlOrDomain: string): Promise<{ domain: string; recipe: Recipe; usable: boolean; reason?: string } | undefined>
  /** Store a DISCOVERED read path (refused when a recipe already exists). */
  record(discovery: RecipeDiscovery): Promise<RecordResult>
  /** Update provenance after a recipe-driven read (success or failure). */
  markVerified(domain: string, ok: boolean, detail?: string): Promise<Recipe | undefined>
  /** Re-run the read path of a recipe (render paths need a registered verifier). */
  verify(domain: string): Promise<{ domain: string; outcome: VerifyOutcome; recipe?: Recipe }>
  /** A consumer's render-path verifier (returns its disposer). */
  registerVerifier(verifier: RecipeVerifier): () => void
  /** The compact inventory. */
  list(): Promise<RecipeSummary[]>
}

export interface RecordResult {
  status: 'recorded' | 'skipped' | 'refused'
  domain: string
  reason?: string
  violations?: string[]
  recipe?: Recipe
  file?: string
}

/** The tool parameter shape the core validates (400 + violations on a mismatch). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
  items?: ToolParameter
  properties?: Record<string, ToolParameter>
}

type ToolParameters = Record<string, ToolParameter>

interface ToolDef {
  name: string
  description?: string
  parameters?: ToolParameters
  execute: (params: Record<string, unknown>) => unknown | Promise<unknown>
}

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface CredentialsLike {
  resolve(ref: { name: string }): Promise<{ value: string } | undefined>
}

interface PluginContext {
  tools: ToolsLike
  credentials?: CredentialsLike
  provide?(name: string, service: unknown): void
  effect(callback: () => () => void): void
}

/** Optional collaborators, so the plugin can be tested without a network. */
export interface WebRecipeDeps {
  fetchImpl?: typeof fetch
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A structured failure answer: the server keeps serving, the caller sees why. */
export function failure(error: unknown): Record<string, unknown> {
  if (error instanceof RecipeError) {
    const status =
      error.code === 'not_found' ? 'not_found' : error.code === 'recipe_corrupt' || error.code === 'recipe_invalid' ? 'invalid' : 'error'
    return {
      status,
      code: error.code,
      message: error.message,
      ...(error.violations.length === 0 ? {} : { violations: error.violations }),
      ...error.detail,
    }
  }
  return { status: 'error', message: messageOf(error) }
}

/**
 * The plugin entry. `deps` is a test seam (the core calls `apply(ctx, config)`):
 * without it `recipe verify` uses global fetch.
 */
export function apply(ctx: PluginContext, config: WebRecipeConfig = {}, deps: WebRecipeDeps = {}): void {
  const dir = str(config.dir) ?? defaultRecipeDir()
  const policy: RecipePolicy = {
    minConfidence: clamp(config.minConfidence, DEFAULT_POLICY.minConfidence, 0, 1),
    maxAgeDays: clamp(config.maxAgeDays, 0, 0, 3650),
  }
  const demoteOnFailure = config.demoteOnFailure !== false
  const demoteStep = clamp(config.demoteStep, 0.2, 0.01, 1)
  const acceptRecords = config.acceptRecords !== false
  const recordConfidence = clamp(config.recordConfidence, RECORDED_CONFIDENCE, 0, 1)
  const verifyTimeoutMs = clamp(config.verifyTimeoutMs, 10_000, 500, 120_000)
  const store = new RecipeStore(dir)

  // Render-path verification belongs to whoever owns a renderer: a consumer
  // registers it here, and `recipe verify` uses it when it is present.
  const verifiers = new Set<RecipeVerifier>()

  function resolveCredentialName(): ((name: string) => Promise<string | undefined>) | undefined {
    const credentials = ctx.credentials
    if (credentials === undefined) return undefined
    return async (credentialName: string) => {
      try {
        const resolution = await credentials.resolve({ name: credentialName })
        return resolution === undefined ? undefined : resolution.value
      } catch {
        return undefined
      }
    }
  }

  async function verify(domain: string, timeoutMs = verifyTimeoutMs): Promise<{ domain: string; outcome: VerifyOutcome; recipe?: Recipe }> {
    const recipe = await store.read(domain)
    if (recipe === undefined) {
      return { domain, outcome: { status: 'failed', readPath: 'none', detail: `no recipe for '${domain}'` } }
    }
    const options: VerifyOptions = {
      timeoutMs,
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    }
    const resolveCredential = resolveCredentialName()
    if (resolveCredential !== undefined) options.resolveCredential = resolveCredential
    const verifier = [...verifiers][0]
    if (verifier !== undefined) options.renderVerifier = verifier
    const outcome = await verifyRecipe(recipe, options)
    await store.write(
      withVerification(recipe, { status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) }, {
        now: new Date().toISOString(),
        demoteOnFailure,
        demoteStep,
      }),
    )
    const updated = await store.read(domain)
    // `store.write` answers with the file path; the caller wants the refreshed
    // recipe (provenance bumped by `withVerification`).
    return { domain, outcome, ...(updated === undefined ? {} : { recipe: updated }) }
  }

  const service: WebRecipeService = {
    contract: 'web-recipe@1',
    policy,
    get: async (domain) => await store.read(domain),
    lookup: async (urlOrDomain) => {
      const domain = normalizeDomain(urlOrDomain) ?? domainOfUrl(urlOrDomain)
      if (domain === undefined) return undefined
      let recipe: Recipe | undefined
      try {
        recipe = await store.read(domain)
      } catch {
        // A corrupt or unreadable recipe never poisons a read: the caller falls
        // back to the normal path (`recipe get` reports the problem in detail).
        return { domain, recipe: undefined as unknown as Recipe, usable: false, reason: 'the stored recipe could not be read' }
      }
      if (recipe === undefined) return undefined
      const verdict = recipeUsable(recipe, policy)
      return { domain, recipe, usable: verdict.usable, ...(verdict.reason === undefined ? {} : { reason: verdict.reason }) }
    },
    record: async (discovery) => {
      const domain = normalizeDomain(discovery.domain ?? discovery.url)
      if (domain === undefined) {
        return { status: 'refused', domain: String(discovery.domain ?? discovery.url ?? ''), violations: ["domain: a domain or URL is required to record a recipe"], reason: 'no usable domain' }
      }
      if (!acceptRecords) {
        return { status: 'refused', domain, reason: 'records are disabled in this deployment (plugins.web-recipe.acceptRecords: false)' }
      }
      let existing: Recipe | undefined
      try {
        existing = await store.read(domain)
      } catch (error) {
        return { status: 'refused', domain, reason: `the stored recipe could not be read: ${messageOf(error)}` }
      }
      if (existing !== undefined) {
        return { status: 'skipped', domain, reason: 'a recipe already exists: a discovery never overwrites curated knowledge (use recipe save)' }
      }
      const { domain: _domain, url: _url, ...fields } = discovery
      const patch: RecipePatch = { ...fields, confidence: fields.confidence ?? recordConfidence, discoveredBy: fields.discoveredBy ?? 'web-recipe' }
      const validated = validatePatch(patch)
      if (!validated.ok) return { status: 'refused', domain, violations: validated.violations, reason: 'the discovered fields did not validate' }
      const saved = await store.save(domain, validated.patch, { requireExists: false })
      return { status: 'recorded', domain, recipe: saved.recipe, file: saved.file }
    },
    markVerified: async (domain, ok, detail) => {
      const recipe = await store.read(domain)
      if (recipe === undefined) return undefined
      const updated = withVerification(recipe, { status: ok ? 'ok' : 'failed', ...(detail === undefined ? {} : { detail }) }, {
        now: new Date().toISOString(),
        demoteOnFailure,
        demoteStep,
      })
      await store.write(updated)
      return updated
    },
    verify: async (domain) => await verify(domain),
    registerVerifier: (verifier) => {
      verifiers.add(verifier)
      return () => {
        verifiers.delete(verifier)
      }
    },
    list: async () => (await store.list()).recipes,
  }

  // The seam a consumer looks up: `ctx.provide('web-recipe', service)`, the same
  // mechanism the core itself uses to publish `ctx.workbench`.
  ctx.provide?.('web-recipe', service)

  // ---------------------------------------------------------------------
  // The tool surface
  // ---------------------------------------------------------------------

  const readPathParameter: ToolParameter = {
    type: 'object',
    description: 'how to read this domain: { kind: "api" | "render", url, api?, jsonPath?, selectors?, waitFor? }',
    properties: {
      kind: { type: 'string', description: 'api (a discovered JSON endpoint) or render (the page itself)', enum: ['api', 'render'] },
      url: { type: 'string', description: 'the URL to read, or a template with {param} placeholders' },
      api: { type: 'string', description: "kind 'api': the name of the apis[] entry to call" },
      jsonPath: { type: 'string', description: 'where the data sits in the payload, e.g. data.items[0].title' },
      selectors: { type: 'array', items: { type: 'string' }, description: "kind 'render': CSS scopes the extraction should use" },
      waitFor: { type: 'string', description: "kind 'render': a selector that must appear before extracting" },
      notes: { type: 'string' },
    },
  }

  const selectorParameter: ToolParameter = {
    type: 'object',
    description: 'a named selector',
    properties: {
      name: { type: 'string', description: 'the name the recipe refers to, e.g. main' },
      form: { type: 'string', description: 'how the selector is interpreted', enum: ['css', 'xpath', 'role'] },
      selector: { type: 'string', description: "the CSS/XPath/role text, e.g. 'article .body'" },
      description: { type: 'string' },
    },
  }

  const apiParameter: ToolParameter = {
    type: 'object',
    description: 'a discovered JSON/XHR endpoint (credential is a NAME, never a value)',
    properties: {
      name: { type: 'string', description: 'the name readPath.api refers to' },
      url: { type: 'string', description: 'endpoint URL or template with {param} placeholders' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      params: { type: 'json', description: 'template values by placeholder name' },
      headers: { type: 'json', description: 'static request headers' },
      credential: { type: 'string', description: 'credential NAME resolved by the caller at call time' },
      credentialHeader: { type: 'string', description: 'header the resolved credential is sent in (default authorization)' },
      sampleShape: { type: 'string', description: 'free-form description of the payload, e.g. { items: [{id,title}] }' },
      jsonPath: { type: 'string', description: 'where the data sits in the payload' },
      notes: { type: 'string' },
    },
  }

  // A login FORM FIELD carries one thing a plain selector does not: the
  // credential NAME whose resolved value fills it (`password: PASSWORD`). The
  // value itself is never part of a recipe - the consumer resolves the NAME.
  const loginFieldParameter: ToolParameter = {
    type: 'object',
    description: 'one login-form field: how to find it, plus the credential NAME that fills it (never a value)',
    properties: {
      name: { type: 'string', description: 'the field name the flow refers to, e.g. username' },
      form: { type: 'string', description: 'how the selector is interpreted', enum: ['css', 'xpath', 'role'] },
      selector: { type: 'string', description: "the CSS/XPath/role text that finds the field, e.g. '#login_field'" },
      credential: { type: 'string', description: 'credential NAME whose resolved value fills this field (never a value)' },
      description: { type: 'string' },
    },
  }

  const loginFlowParameter: ToolParameter = {
    type: 'object',
    description: 'how to log in when a read needs a session (credential NAMES only)',
    properties: {
      url: { type: 'string', description: 'the login page or endpoint' },
      fields: { type: 'array', items: loginFieldParameter, description: 'the form fields, by name (each may name its credential)' },
      credential: { type: 'string', description: 'credential NAME holding the account identity' },
      notes: { type: 'string' },
    },
  }

  const domainParameter: ToolParameter = {
    type: 'string',
    description: "the domain key, e.g. 'github.com' (a bare host, a host:port or a URL are all accepted)",
    required: true,
  }

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'recipe get',
      description:
        'returns the stored per-domain recipe (read path, named selectors, discovered API endpoints, login flow, quirks, provenance) or a structured not-found; a recipe is durable knowledge every thread can reuse',
      parameters: {
        domain: domainParameter,
        raw: { type: 'boolean', description: 'include the stored document verbatim (default: the validated recipe)' },
      },
      execute: async (params): Promise<Record<string, unknown>> => {
        const domain = str(params.domain)
        if (domain === undefined) return { status: 'invalid', violations: ["domain: a non-empty domain is required"] }
        try {
          const recipe = await store.read(domain)
          if (recipe === undefined) {
            const known = (await store.list()).recipes.map((entry) => entry.domain)
            return {
              status: 'not_found',
              domain,
              hint: 'no recipe is stored for this domain: read the page normally, then `recipe save` what you learned (or enable recording on web-page)',
              known,
            }
          }
          return { status: 'ok', domain: recipe.domain, file: store.fileFor(recipe.domain), recipe }
        } catch (error) {
          return failure(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'recipe save',
      description:
        'creates or MERGES a per-domain recipe (read path, selectors, discovered endpoints, login flow, quirks, confidence); provenance is updated, a replacement read path resets verification, and a credential is stored by NAME only',
      parameters: {
        domain: domainParameter,
        readPath: readPathParameter,
        selectors: { type: 'array', items: selectorParameter, description: 'named selectors (replaced as a whole when given)' },
        apis: { type: 'array', items: apiParameter, description: 'discovered JSON/XHR endpoints (replaced as a whole when given)' },
        loginFlow: loginFlowParameter,
        quirks: { type: 'string', description: 'free-form notes about this site' },
        disabled: { type: 'boolean', description: 'park the recipe: keep the file, stop using it for reads' },
        confidence: { type: 'number', description: '0..1; a cited confidence beats the default 0.5' },
        discoveredBy: { type: 'string', description: 'who/what discovered this (e.g. an agent name or thread id)' },
        sourceThread: { type: 'string', description: 'provenance: the conversation/thread it came from' },
        lastVerifiedAt: { type: 'string', description: 'ISO-8601 timestamp of an external verification' },
        replace: { type: 'boolean', description: 'replace the recipe instead of merging into it (default false)' },
      },
      execute: async (params): Promise<Record<string, unknown>> => {
        const domain = str(params.domain)
        if (domain === undefined) return { status: 'invalid', violations: ["domain: a non-empty domain is required"] }
        const { domain: _domain, replace, ...fields } = params
        const validated = validatePatch(fields)
        if (!validated.ok) return { status: 'invalid', domain, violations: validated.violations, message: 'the recipe was refused; nothing was written' }
        try {
          const existing = replace === true ? undefined : await store.read(domain)
          const key = normalizeDomain(domain)
          if (key === undefined) return { status: 'invalid', domain, violations: [`domain: '${domain}' must be a host name such as 'github.com'`] }
          const recipe = buildRecipe(key, validated.patch, existing, { now: new Date().toISOString() })
          const file = await store.write(recipe)
          return { status: 'ok', domain: key, file, created: existing === undefined, summary: summarize(recipe), recipe }
        } catch (error) {
          return failure(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'recipe list',
      description: 'lists the stored recipes: domain, read path kind, counts, confidence, lastVerifiedAt and parked state, plus any unreadable file',
      parameters: {
        limit: { type: 'integer', description: 'cap the number of entries (default 100)' },
      },
      execute: async (params): Promise<Record<string, unknown>> => {
        try {
          const listed = await store.list()
          const limit = clamp(params.limit, 100, 1, 1000)
          return {
            status: 'ok',
            dir,
            count: listed.recipes.length,
            recipes: listed.recipes.slice(0, limit),
            ...(listed.problems.length === 0 ? {} : { problems: listed.problems }),
          }
        } catch (error) {
          return failure(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'recipe delete',
      description:
        "parks a recipe (`mode: disable`, default: the file and its provenance stay, reads stop using it) or removes it from disk (`mode: purge`)",
      parameters: {
        domain: domainParameter,
        mode: { type: 'string', description: 'disable (park, default) or purge (delete the file)', enum: ['disable', 'purge'] },
      },
      execute: async (params): Promise<Record<string, unknown>> => {
        const domain = str(params.domain)
        if (domain === undefined) return { status: 'invalid', violations: ["domain: a non-empty domain is required"] }
        const mode: DeleteMode = params.mode === 'purge' ? 'purge' : 'disable'
        try {
          const result = await store.remove(domain, mode)
          return { status: 'ok', domain, mode, ...result }
        } catch (error) {
          return failure(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'recipe verify',
      description:
        "re-runs a recipe's read path (an API endpoint is probed directly; a rendered page needs a consumer verifier such as web-page), updates lastVerifiedAt/confidence and reports whether the stored knowledge still holds",
      parameters: {
        domain: domainParameter,
        timeoutMs: { type: 'integer', description: `HTTP timeout of the probe (default ${String(verifyTimeoutMs)} ms)` },
      },
      execute: async (params): Promise<Record<string, unknown>> => {
        const domain = str(params.domain)
        if (domain === undefined) return { status: 'invalid', violations: ["domain: a non-empty domain is required"] }
        try {
          const result = await verify(domain, clamp(params.timeoutMs, verifyTimeoutMs, 500, 120_000))
          return {
            status: result.outcome.status,
            domain: result.domain,
            outcome: result.outcome,
            ...(result.recipe === undefined ? {} : { summary: summarize(result.recipe), provenance: result.recipe.provenance }),
          }
        } catch (error) {
          return failure(error)
        }
      },
      output: { schema: {}, render: renderValue },
    })),

  )
}

export default { name, inject: ['credentials', 'tools'], apply }
