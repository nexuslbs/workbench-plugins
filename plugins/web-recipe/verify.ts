// `web-recipe` VERIFICATION: re-run a recipe's readPath and decide whether the
// stored knowledge still describes the site.
//
// Two kinds of read path, two kinds of proof:
//   - `api`   -> an HTTP probe this plugin can run itself (status + JSON shape);
//   - `render`-> only a RENDERER can prove it, and this plugin owns no browser.
//               A consumer (web-page) registers a verifier through the service,
//               and without one the answer is `unverifiable` - honest, and never
//               a silent promotion or demotion.
//
// A credential is resolved by NAME at call time and only ever travels in the
// request header: it is never returned, logged, or written into the recipe.
import { RecipeError } from './store.ts'
import type { Recipe, RecipeApi } from './schema.ts'

export type VerifyStatus = 'ok' | 'failed' | 'unverifiable'

/** The outcome of a verification attempt (never carries a secret). */
export interface VerifyOutcome {
  status: VerifyStatus
  readPath: 'api' | 'render' | 'none'
  detail: string
  checkedUrl?: string
  httpStatus?: number
  jsonPath?: string
  /** Compact description of the payload/scope: types and keys, never values. */
  sampleShape?: string
  elapsedMs?: number
}

/** A render-path verifier a consumer may register (it owns the renderer). */
export type RecipeVerifier = (recipe: Recipe, options: VerifyOptions) => Promise<VerifyOutcome>

export interface VerifyOptions {
  /** HTTP implementation (a test injects one; the default is global fetch). */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Resolve a credential NAME at call time (`ctx.credentials` in production). */
  resolveCredential?: (name: string) => Promise<string | undefined>
  /** The render-path verifier registered by a consumer, when there is one. */
  renderVerifier?: RecipeVerifier
}

/** The `apis[]` entry a readPath names. */
export function resolveApi(recipe: Recipe, name: string | undefined): RecipeApi | undefined {
  if (name === undefined) return undefined
  return (recipe.apis ?? []).find((api) => api.name === name)
}

/**
 * Fill an endpoint TEMPLATE: `{name}` placeholders come from the recipe's
 * `params`. An unresolved placeholder is an error (a request to a URL that still
 * contains `{q}` would be a silent wrong read).
 */
export function renderApiUrl(template: string, params: Record<string, string> = {}): string {
  const missing: string[] = []
  const url = template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_match, name: string) => {
    const value = params[name]
    if (value === undefined) {
      missing.push(name)
      return `{${name}}`
    }
    return encodeURIComponent(value)
  })
  if (missing.length > 0) {
    throw new RecipeError('invalid_recipe', `the endpoint template still has unresolved placeholders: ${missing.join(', ')}`, {
      violations: missing.map((name) => `apis.url: no value for placeholder '${name}'`),
    })
  }
  return url
}

/** A tiny JSON pointer-ish resolver: `data.items[0].title`, `$.a.b`. */
export function resolveJsonPath(value: unknown, jsonPath: string): unknown {
  let current = value
  for (const rawSegment of jsonPath.replace(/^\$\.?/, '').split('.')) {
    if (rawSegment.length === 0) continue
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(rawSegment)
    if (match === null) return undefined
    const key = match[1]
    if (key !== undefined && key.length > 0) {
      if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
      current = (current as Record<string, unknown>)[key]
    }
    for (const index of match[2]?.match(/\d+/g) ?? []) {
      if (!Array.isArray(current)) return undefined
      current = current[Number(index)]
    }
  }
  return current
}

/** A compact TYPE description of a payload: keys and types, never values. */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `array[${String(value.length)}]${depth < 3 && value.length > 0 ? ` of ${shapeOf(value[0], depth + 1)}` : ''}`
  }
  if (typeof value === 'object') {
    if (depth >= 3) return 'object'
    const keys = Object.keys(value as Record<string, unknown>)
    const shown = keys
      .slice(0, 12)
      .map((key) => `${key}: ${shapeOf((value as Record<string, unknown>)[key], depth + 1)}`)
      .join(', ')
    return `{ ${shown}${keys.length > 12 ? ', ...' : ''} }`
  }
  return typeof value
}

/**
 * Verify a recipe: probe its API read path, or delegate a render path to the
 * verifier a consumer registered. Never throws for a site-side failure (that is
 * a `failed` OUTCOME); only a malformed recipe raises.
 */
export async function verifyRecipe(recipe: Recipe, options: VerifyOptions = {}): Promise<VerifyOutcome> {
  const readPath = recipe.readPath
  if (readPath === undefined) {
    return { status: 'unverifiable', readPath: 'none', detail: 'the recipe names no readPath: there is nothing to re-run' }
  }
  if (readPath.kind === 'render') {
    if (options.renderVerifier === undefined) {
      return {
        status: 'unverifiable',
        readPath: 'render',
        detail:
          'the read path is a rendered page and this plugin owns no browser: no consumer verifier is registered (load web-page, which registers one), so only a real page read can prove it',
      }
    }
    return await options.renderVerifier(recipe, options)
  }
  const api = resolveApi(recipe, readPath.api)
  if (api === undefined) {
    const known = (recipe.apis ?? []).map((entry) => entry.name).join(', ')
    return {
      status: 'failed',
      readPath: 'api',
      detail: `readPath.api '${String(readPath.api)}' is not among this recipe's apis [${known}]`,
    }
  }
  const url = renderApiUrl(api.url, api.params ?? {})
  const headers: Record<string, string> = { ...(api.headers ?? {}) }
  if (api.credential !== undefined) {
    const value = await options.resolveCredential?.(api.credential)
    if (value === undefined) {
      return {
        status: 'failed',
        readPath: 'api',
        detail: `credential '${api.credential}' could not be resolved (the name is stored, the value lives in the credential store)`,
        checkedUrl: url,
      }
    }
    headers[api.credentialHeader ?? 'authorization'] = value
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 10_000
  const started = Date.now()
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: api.method ?? 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      status: 'failed',
      readPath: 'api',
      detail: `the endpoint could not be reached: ${messageOf(error)}`,
      checkedUrl: url,
      elapsedMs: Date.now() - started,
    }
  }
  const body = await response.text().catch(() => '')
  if (response.status >= 400) {
    return {
      status: 'failed',
      readPath: 'api',
      detail: `the endpoint answered HTTP ${String(response.status)}`,
      checkedUrl: url,
      httpStatus: response.status,
      sampleShape: body.slice(0, 200).length === 0 ? undefined : `text[${String(body.length)} chars]`,
      elapsedMs: Date.now() - started,
    }
  }
  const jsonPath = readPath.jsonPath ?? api.jsonPath
  if (jsonPath !== undefined) {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      return {
        status: 'failed',
        readPath: 'api',
        detail: `the endpoint did not answer JSON: ${messageOf(error)}`,
        checkedUrl: url,
        httpStatus: response.status,
        elapsedMs: Date.now() - started,
      }
    }
    const selected = resolveJsonPath(parsed, jsonPath)
    if (selected === undefined) {
      return {
        status: 'failed',
        readPath: 'api',
        detail: `jsonPath '${jsonPath}' found nothing in the payload`,
        checkedUrl: url,
        httpStatus: response.status,
        jsonPath,
        sampleShape: shapeOf(parsed),
        elapsedMs: Date.now() - started,
      }
    }
    return {
      status: 'ok',
      readPath: 'api',
      detail: `the endpoint answered HTTP ${String(response.status)} and jsonPath '${jsonPath}' resolved`,
      checkedUrl: url,
      httpStatus: response.status,
      jsonPath,
      sampleShape: shapeOf(selected),
      elapsedMs: Date.now() - started,
    }
  }
  const rendered = response.headers.get('content-type')?.includes('json') === true ? safeJson(body) : undefined
  return {
    status: 'ok',
    readPath: 'api',
    detail: `the endpoint answered HTTP ${String(response.status)} (${String(body.length)} chars)`,
    checkedUrl: url,
    httpStatus: response.status,
    sampleShape: rendered === undefined ? `text[${String(body.length)} chars]` : shapeOf(rendered),
    elapsedMs: Date.now() - started,
  }
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
