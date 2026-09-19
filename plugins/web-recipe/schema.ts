// `web-recipe` SCHEMA: the versioned recipe model, its validation (a readable
// violations list, never a silent coercion) and the merge rules `recipe save`
// applies to an existing recipe.
//
// The model is deliberately site-agnostic: nothing here knows github.com or any
// other site. A recipe is DATA - one JSON document per domain - and this module
// is the only place that decides what a valid recipe is.
//
// NO SECRET VALUE IS EVER PART OF A RECIPE. A recipe may name a credential
// (`credential: 'GITHUB_TOKEN'`), never carry one; `validatePatch` refuses both
// a secret-shaped VALUE and a secret-shaped FIELD, so a caller cannot use the
// store as a vault by accident.

/** The schema version this build writes and reads. */
export const RECIPE_SCHEMA_VERSION = 1

/** Selector forms a recipe may name. */
export const SELECTOR_FORMS = ['css', 'xpath', 'role'] as const
/** Read-path kinds: a discovered JSON endpoint, or a rendered page. */
export const READ_PATH_KINDS = ['api', 'render'] as const
/** HTTP methods an API entry may name. */
export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
/** Confidence a freshly recorded (unverified) recipe starts with. */
export const RECORDED_CONFIDENCE = 0.3
/** Confidence of a handwritten recipe that names no number. */
export const DEFAULT_CONFIDENCE = 0.5

export type SelectorForm = (typeof SELECTOR_FORMS)[number]
export type ReadPathKind = (typeof READ_PATH_KINDS)[number]
export type ApiMethod = (typeof API_METHODS)[number]

/** One named selector (the form says how it is interpreted). */
export interface RecipeSelector {
  name: string
  form: SelectorForm
  selector: string
  description?: string
}

/** One discovered JSON/XHR endpoint. `credential` is a NAME, never a value. */
export interface RecipeApi {
  name: string
  url: string
  method?: ApiMethod
  params?: Record<string, string>
  headers?: Record<string, string>
  /** Credential NAME resolved by the caller at call time. */
  credential?: string
  /** Header the resolved credential is sent in (default `authorization`). */
  credentialHeader?: string
  /** Free-form description of the payload, e.g. `{ items: [{id,title}] }`. */
  sampleShape?: string
  /** Where the interesting data sits in the payload, e.g. `data.items[0].title`. */
  jsonPath?: string
  notes?: string
}

/** One field of a login form (`username`, `password`, `submit`). */
export interface RecipeLoginField {
  name: string
  form: SelectorForm
  selector: string
  /** Credential NAME for this field (only `password`-like fields carry one). */
  credential?: string
  description?: string
}

/** How to log in when the read needs a session. Values live in credentials. */
export interface RecipeLoginFlow {
  url: string
  fields: RecipeLoginField[]
  /** Credential NAME holding the account identity, when it is not a literal. */
  credential?: string
  notes?: string
}

/** How to read this domain: an API endpoint (`apis[].name`) or a render. */
export interface RecipeReadPath {
  kind: ReadPathKind
  /** The URL to read (a template is allowed) or the page to render. */
  url: string
  /** `kind: 'api'`: the name of the `apis[]` entry to call. */
  api?: string
  /** `kind: 'api'`: payload location when it is not the whole body. */
  jsonPath?: string
  /** `kind: 'render'`: CSS scopes the extraction should use. */
  selectors?: string[]
  /** `kind: 'render'`: a selector that must appear before extraction. */
  waitFor?: string
  notes?: string
}

/** Provenance: where a recipe came from and how much it can be trusted. */
export interface RecipeProvenance {
  createdAt: string
  updatedAt: string
  lastVerifiedAt?: string
  /** 0..1; a failed verification demotes it, a good one raises it. */
  confidence: number
  discoveredBy?: string
  sourceThread?: string
  verificationFailures?: number
  lastVerificationStatus?: 'ok' | 'failed' | 'unverifiable'
  lastVerificationError?: string
}

/** One stored recipe: the whole document that lives in `<dir>/<domain>.json`. */
export interface Recipe {
  domain: string
  schemaVersion: number
  /** `true` parks the recipe: it keeps its file but is not used for reads. */
  disabled?: boolean
  readPath?: RecipeReadPath
  selectors?: RecipeSelector[]
  apis?: RecipeApi[]
  loginFlow?: RecipeLoginFlow
  quirks?: string
  provenance: RecipeProvenance
}

/** The mutable part of a recipe: what `recipe save` accepts besides `domain`. */
export interface RecipePatch {
  readPath?: RecipeReadPath
  selectors?: RecipeSelector[]
  apis?: RecipeApi[]
  loginFlow?: RecipeLoginFlow
  quirks?: string
  disabled?: boolean
  confidence?: number
  discoveredBy?: string
  sourceThread?: string
  lastVerifiedAt?: string
}

/** The compact list entry `recipe list` answers with. */
export interface RecipeSummary {
  domain: string
  schemaVersion: number
  disabled: boolean
  confidence: number
  updatedAt?: string
  lastVerifiedAt?: string
  readPathKind?: ReadPathKind
  apiCount: number
  selectorCount: number
  hasLoginFlow: boolean
}

/** What the read-through consumer needs to know about a recipe. */
export interface RecipePolicy {
  /** A recipe below this confidence is ignored by the read-through. */
  minConfidence: number
  /** When > 0, a recipe older than this many days is ignored. */
  maxAgeDays: number
}

export const DEFAULT_POLICY: RecipePolicy = { minConfidence: 0.2, maxAgeDays: 0 }

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/
const CREDENTIAL_NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const RECIPE_FIELDS = [
  'domain',
  'schemaVersion',
  'disabled',
  'readPath',
  'selectors',
  'apis',
  'loginFlow',
  'quirks',
  'provenance',
] as const
const PATCH_FIELDS = [
  'readPath',
  'selectors',
  'apis',
  'loginFlow',
  'quirks',
  'disabled',
  'confidence',
  'discoveredBy',
  'sourceThread',
  'lastVerifiedAt',
] as const

/** A secret-shaped FIELD name: its value would be a secret, not a reference. */
const SECRET_FIELD_RE = /^(password|passwd|secret|token|access[-_]?token|refresh[-_]?token|api[-_]?key|apikey|private[-_]?key|client[-_]?secret|authorization|cookie|bearer)$/i
/** A secret-shaped VALUE, caught even under an innocuous field name. */
const SECRET_VALUE_RE = /^(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

/**
 * Normalize a domain or a URL to the key a recipe is stored under: the
 * lowercased host, with a leading `www.` dropped. Accepts `github.com`,
 * `GitHub.com:443`, `https://www.github.com/foo/bar?x=1` and `127.0.0.1:8080`.
 */
export function normalizeDomain(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  if (raw.length === 0) return undefined
  let host = raw
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      host = new URL(raw).host
    } catch {
      return undefined
    }
  } else {
    // A bare `host[:port][/path]` spelling.
    host = raw.split('/')[0] ?? raw
  }
  host = host.replace(/:\d+$/, '').toLowerCase()
  host = host.startsWith('www.') ? host.slice(4) : host
  if (host.length === 0 || !DOMAIN_RE.test(host)) return undefined
  return host
}

/** The domain a URL belongs to (`undefined` when it is not an absolute URL). */
export function domainOfUrl(value: unknown): string | undefined {
  return normalizeDomain(value)
}

/** A human readable violation: `path: message`, the shape the core publishes. */
export function violation(path: string, message: string): string {
  return `${path}: ${message}`
}

/** A violation that would leak a secret VALUE: the message never echoes it. */
function secretViolation(path: string, detail: string): string {
  return violation(path, `a recipe stores credential NAMES, never values (${detail})`)
}

/**
 * Walk any candidate value and collect secret-shaped fields/values. Runs over
 * the WHOLE patch, so a secret cannot be smuggled through `quirks` or a header
 * map either.
 */
function collectSecretViolations(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'string') {
    if (SECRET_VALUE_RE.test(value.trim())) out.push(secretViolation(path, 'the value looks like a live secret'))
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectSecretViolations(entry, `${path}[${String(index)}]`, out))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const where = path.length === 0 ? key : `${path}.${key}`
    if (key === 'credential') {
      if (typeof entry !== 'string' || !CREDENTIAL_NAME_RE.test(entry.trim())) {
        out.push(violation(where, 'must be a credential NAME (UPPER_SNAKE), resolved by the caller; never a value'))
      } else if (SECRET_VALUE_RE.test(entry.trim())) {
        out.push(secretViolation(where, 'the credential reference looks like a value'))
      }
      continue
    }
    if (SECRET_FIELD_RE.test(key) && typeof entry === 'string' && entry.trim().length > 0) {
      out.push(secretViolation(where, `the field '${key}' would carry a value`))
      continue
    }
    collectSecretViolations(entry, where, out)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function optionalString(value: unknown, path: string, out: string[]): string | undefined {
  if (value === undefined || value === null) return undefined
  const text = str(value)
  if (text === undefined) out.push(violation(path, 'must be a non-empty string when present'))
  return text
}

function optionalStringMap(value: unknown, path: string, out: string[]): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value)) {
    out.push(violation(path, 'must be an object of string values'))
    return undefined
  }
  const map: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    const text = str(entry)
    if (text === undefined) out.push(violation(`${path}.${key}`, 'must be a non-empty string'))
    else map[key] = text
  }
  return map
}

function validateSelector(value: unknown, path: string, out: string[]): RecipeSelector | undefined {
  if (!isRecord(value)) {
    out.push(violation(path, 'must be an object { name, form, selector }'))
    return undefined
  }
  const name = str(value.name)
  if (name === undefined) out.push(violation(`${path}.name`, 'is required (a non-empty name, e.g. "main")'))
  const form = str(value.form) ?? 'css'
  if (!(SELECTOR_FORMS as readonly string[]).includes(form)) {
    out.push(violation(`${path}.form`, `must be one of ${SELECTOR_FORMS.join(', ')}`))
  }
  const selector = str(value.selector)
  if (selector === undefined) out.push(violation(`${path}.selector`, 'is required (the CSS/XPath/role text)'))
  if (name === undefined || selector === undefined || !(SELECTOR_FORMS as readonly string[]).includes(form)) return undefined
  const description = optionalString(value.description, `${path}.description`, out)
  return { name, form: form as SelectorForm, selector, ...(description === undefined ? {} : { description }) }
}

function validateApi(value: unknown, path: string, out: string[]): RecipeApi | undefined {
  if (!isRecord(value)) {
    out.push(violation(path, 'must be an object { name, url, ... }'))
    return undefined
  }
  const name = str(value.name)
  if (name === undefined) out.push(violation(`${path}.name`, 'is required (the name `readPath.api` refers to)'))
  const url = str(value.url)
  if (url === undefined) out.push(violation(`${path}.url`, 'is required (the endpoint URL or template)'))
  const method = str(value.method) ?? 'GET'
  if (!(API_METHODS as readonly string[]).includes(method.toUpperCase())) {
    out.push(violation(`${path}.method`, `must be one of ${API_METHODS.join(', ')}`))
  }
  if (name === undefined || url === undefined) return undefined
  const params = optionalStringMap(value.params, `${path}.params`, out)
  const headers = optionalStringMap(value.headers, `${path}.headers`, out)
  const credential = optionalString(value.credential, `${path}.credential`, out)
  const credentialHeader = optionalString(value.credentialHeader, `${path}.credentialHeader`, out)
  const sampleShape = optionalString(value.sampleShape, `${path}.sampleShape`, out)
  const jsonPath = optionalString(value.jsonPath, `${path}.jsonPath`, out)
  const notes = optionalString(value.notes, `${path}.notes`, out)
  return {
    name,
    url,
    method: method.toUpperCase() as ApiMethod,
    ...(params === undefined ? {} : { params }),
    ...(headers === undefined ? {} : { headers }),
    ...(credential === undefined ? {} : { credential }),
    ...(credentialHeader === undefined ? {} : { credentialHeader }),
    ...(sampleShape === undefined ? {} : { sampleShape }),
    ...(jsonPath === undefined ? {} : { jsonPath }),
    ...(notes === undefined ? {} : { notes }),
  }
}

function validateLoginFlow(value: unknown, path: string, out: string[]): RecipeLoginFlow | undefined {
  if (!isRecord(value)) {
    out.push(violation(path, 'must be an object { url, fields }'))
    return undefined
  }
  const url = str(value.url)
  if (url === undefined) out.push(violation(`${path}.url`, 'is required (the login page or endpoint)'))
  const fields: RecipeLoginField[] = []
  const rawFields = value.fields
  if (rawFields !== undefined && rawFields !== null) {
    if (!Array.isArray(rawFields)) out.push(violation(`${path}.fields`, 'must be an array of { name, form, selector }'))
    else {
      rawFields.forEach((entry, index) => {
        const selector = validateSelector(entry, `${path}.fields[${String(index)}]`, out)
        if (selector === undefined) return
        const credential = isRecord(entry) ? optionalString(entry.credential, `${path}.fields[${String(index)}].credential`, out) : undefined
        fields.push({ ...selector, ...(credential === undefined ? {} : { credential }) })
      })
    }
  }
  if (url === undefined) return undefined
  const credential = optionalString(value.credential, `${path}.credential`, out)
  const notes = optionalString(value.notes, `${path}.notes`, out)
  return { url, fields, ...(credential === undefined ? {} : { credential }), ...(notes === undefined ? {} : { notes }) }
}

function validateReadPath(value: unknown, path: string, out: string[]): RecipeReadPath | undefined {
  if (!isRecord(value)) {
    out.push(violation(path, "must be an object { kind: 'api' | 'render', url }"))
    return undefined
  }
  const kind = str(value.kind)
  if (kind === undefined || !(READ_PATH_KINDS as readonly string[]).includes(kind)) {
    out.push(violation(`${path}.kind`, `must be one of ${READ_PATH_KINDS.join(', ')}`))
  }
  const url = str(value.url)
  if (url === undefined) out.push(violation(`${path}.url`, 'is required (the URL to read, or a template)'))
  if (kind === undefined || url === undefined || !(READ_PATH_KINDS as readonly string[]).includes(kind)) return undefined
  const api = optionalString(value.api, `${path}.api`, out)
  const jsonPath = optionalString(value.jsonPath, `${path}.jsonPath`, out)
  const waitFor = optionalString(value.waitFor, `${path}.waitFor`, out)
  const notes = optionalString(value.notes, `${path}.notes`, out)
  let selectors: string[] | undefined
  if (value.selectors !== undefined && value.selectors !== null) {
    if (!Array.isArray(value.selectors)) out.push(violation(`${path}.selectors`, 'must be an array of CSS scopes'))
    else {
      selectors = []
      value.selectors.forEach((entry, index) => {
        const text = str(entry)
        if (text === undefined) out.push(violation(`${path}.selectors[${String(index)}]`, 'must be a non-empty string'))
        else selectors?.push(text)
      })
    }
  }
  if (kind === 'api' && api === undefined) {
    out.push(violation(`${path}.api`, "is required when kind is 'api' (the name of an `apis[]` entry)"))
  }
  return {
    kind: kind as ReadPathKind,
    url,
    ...(api === undefined ? {} : { api }),
    ...(jsonPath === undefined ? {} : { jsonPath }),
    ...(selectors === undefined ? {} : { selectors }),
    ...(waitFor === undefined ? {} : { waitFor }),
    ...(notes === undefined ? {} : { notes }),
  }
}

/**
 * Validate the mutable fields of a recipe (`recipe save`, `recipe record`).
 * Returns the normalized patch, or the violations that refused it. Unknown
 * fields are refused instead of ignored: a typo must not silently do nothing.
 */
export function validatePatch(value: unknown): { ok: true; patch: RecipePatch } | { ok: false; violations: string[] } {
  if (value === undefined || value === null) return { ok: true, patch: {} }
  if (!isRecord(value)) return { ok: false, violations: [violation('', 'must be an object of recipe fields')] }
  const out: string[] = []
  collectSecretViolations(value, '', out)
  for (const key of Object.keys(value)) {
    if (!(PATCH_FIELDS as readonly string[]).includes(key)) {
      out.push(violation(key, `unknown recipe field (known: ${PATCH_FIELDS.join(', ')})`))
    }
  }
  const patch: RecipePatch = {}
  if (value.readPath !== undefined && value.readPath !== null) {
    const readPath = validateReadPath(value.readPath, 'readPath', out)
    if (readPath !== undefined) patch.readPath = readPath
  }
  if (value.selectors !== undefined && value.selectors !== null) {
    if (!Array.isArray(value.selectors)) out.push(violation('selectors', 'must be an array of { name, form, selector }'))
    else {
      const selectors: RecipeSelector[] = []
      value.selectors.forEach((entry, index) => {
        const selector = validateSelector(entry, `selectors[${String(index)}]`, out)
        if (selector !== undefined) selectors.push(selector)
      })
      patch.selectors = selectors
    }
  }
  if (value.apis !== undefined && value.apis !== null) {
    if (!Array.isArray(value.apis)) out.push(violation('apis', 'must be an array of { name, url, ... }'))
    else {
      const apis: RecipeApi[] = []
      value.apis.forEach((entry, index) => {
        const api = validateApi(entry, `apis[${String(index)}]`, out)
        if (api !== undefined) apis.push(api)
      })
      patch.apis = apis
    }
  }
  if (value.loginFlow !== undefined && value.loginFlow !== null) {
    const loginFlow = validateLoginFlow(value.loginFlow, 'loginFlow', out)
    if (loginFlow !== undefined) patch.loginFlow = loginFlow
  }
  if (value.quirks !== undefined && value.quirks !== null) {
    const quirks = str(value.quirks)
    if (quirks === undefined) out.push(violation('quirks', 'must be a non-empty string when present'))
    else patch.quirks = quirks
  }
  if (value.disabled !== undefined && value.disabled !== null) {
    if (typeof value.disabled !== 'boolean') out.push(violation('disabled', 'must be a boolean'))
    else patch.disabled = value.disabled
  }
  if (value.confidence !== undefined && value.confidence !== null) {
    const confidence = typeof value.confidence === 'number' ? value.confidence : Number(value.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) out.push(violation('confidence', 'must be a number between 0 and 1'))
    else patch.confidence = confidence
  }
  const discoveredBy = optionalString(value.discoveredBy, 'discoveredBy', out)
  if (discoveredBy !== undefined) patch.discoveredBy = discoveredBy
  const sourceThread = optionalString(value.sourceThread, 'sourceThread', out)
  if (sourceThread !== undefined) patch.sourceThread = sourceThread
  const lastVerifiedAt = optionalString(value.lastVerifiedAt, 'lastVerifiedAt', out)
  if (lastVerifiedAt !== undefined) {
    if (Number.isNaN(Date.parse(lastVerifiedAt))) out.push(violation('lastVerifiedAt', 'must be an ISO-8601 timestamp'))
    else patch.lastVerifiedAt = lastVerifiedAt
  }
  if (out.length > 0) return { ok: false, violations: out }
  return { ok: true, patch }
}

/**
 * Validate a document READ FROM DISK: the domain it was filed under, its
 * schemaVersion and its provenance are part of the contract, so a hand-edited
 * file that lost them is refused with the same violations shape a save gets.
 */
export function validateStored(domain: string, value: unknown): { ok: true; recipe: Recipe } | { ok: false; violations: string[] } {
  if (!isRecord(value)) return { ok: false, violations: [violation('', 'the recipe file must contain a JSON object')] }
  const out: string[] = []
  collectSecretViolations(value, '', out)
  if (value.domain !== domain) out.push(violation('domain', `must be '${domain}' (the filename key) - a recipe never travels to another domain`))
  if (typeof value.schemaVersion !== 'number') out.push(violation('schemaVersion', 'is required (a number)'))
  const provenance = value.provenance
  if (!isRecord(provenance)) {
    out.push(violation('provenance', 'is required (createdAt, updatedAt, confidence)'))
  } else {
    if (timestamp(provenance.createdAt) === undefined) out.push(violation('provenance.createdAt', 'must be an ISO-8601 timestamp'))
    if (timestamp(provenance.updatedAt) === undefined) out.push(violation('provenance.updatedAt', 'must be an ISO-8601 timestamp'))
    const confidence = typeof provenance.confidence === 'number' ? provenance.confidence : NaN
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      out.push(violation('provenance.confidence', 'must be a number between 0 and 1'))
    }
  }
  const mutable: Record<string, unknown> = {}
  for (const key of PATCH_FIELDS) if (value[key] !== undefined) mutable[key] = value[key]
  const validated = validatePatch(mutable)
  if (!validated.ok) out.push(...validated.violations)
  if (!validated.ok || out.length > 0 || !isRecord(provenance)) return { ok: false, violations: out }
  const now = timestamp(provenance.updatedAt) ?? new Date().toISOString()
  const built = buildRecipe(domain, validated.patch, undefined, { now })
  return { ok: true, recipe: { ...built, provenance: normalizeProvenance(provenance, now) } }
}

/** The provenance block of a stored recipe, with its optional fields kept. */
function normalizeProvenance(value: Record<string, unknown>, now: string): RecipeProvenance {
  const provenance: RecipeProvenance = {
    createdAt: timestamp(value.createdAt) ?? now,
    updatedAt: timestamp(value.updatedAt) ?? now,
    confidence: typeof value.confidence === 'number' ? value.confidence : DEFAULT_CONFIDENCE,
  }
  const lastVerifiedAt = timestamp(value.lastVerifiedAt)
  if (lastVerifiedAt !== undefined) provenance.lastVerifiedAt = lastVerifiedAt
  const discoveredBy = str(value.discoveredBy)
  if (discoveredBy !== undefined) provenance.discoveredBy = discoveredBy
  const sourceThread = str(value.sourceThread)
  if (sourceThread !== undefined) provenance.sourceThread = sourceThread
  if (typeof value.verificationFailures === 'number') provenance.verificationFailures = value.verificationFailures
  if (value.lastVerificationStatus === 'ok' || value.lastVerificationStatus === 'failed' || value.lastVerificationStatus === 'unverifiable') {
    provenance.lastVerificationStatus = value.lastVerificationStatus
  }
  const lastVerificationError = str(value.lastVerificationError)
  if (lastVerificationError !== undefined) provenance.lastVerificationError = lastVerificationError
  return provenance
}

/** An ISO-8601 timestamp string, or `undefined` when it is not one. */
function timestamp(value: unknown): string | undefined {
  const text = str(value)
  return text === undefined || Number.isNaN(Date.parse(text)) ? undefined : text
}

/** Merge a patch over an existing recipe (or build a fresh one). */
export function buildRecipe(
  domain: string,
  patch: RecipePatch,
  base: Recipe | undefined,
  options: { now: string; resetVerification?: boolean },
): Recipe {
  const now = options.now
  const previous = base?.provenance
  const touchesRead = patch.readPath !== undefined || patch.selectors !== undefined || patch.apis !== undefined
  const resetVerification = options.resetVerification ?? touchesRead
  const provenance: RecipeProvenance = {
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    confidence: patch.confidence ?? previous?.confidence ?? DEFAULT_CONFIDENCE,
    ...(patch.lastVerifiedAt ?? previous?.lastVerifiedAt) === undefined
      ? {}
      : { lastVerifiedAt: patch.lastVerifiedAt ?? previous?.lastVerifiedAt },
    ...((patch.discoveredBy ?? previous?.discoveredBy) === undefined ? {} : { discoveredBy: patch.discoveredBy ?? previous?.discoveredBy }),
    ...((patch.sourceThread ?? previous?.sourceThread) === undefined ? {} : { sourceThread: patch.sourceThread ?? previous?.sourceThread }),
    ...(resetVerification || previous?.verificationFailures === undefined ? {} : { verificationFailures: previous.verificationFailures }),
    ...(resetVerification || previous?.lastVerificationStatus === undefined ? {} : { lastVerificationStatus: previous.lastVerificationStatus }),
    ...(resetVerification || previous?.lastVerificationError === undefined ? {} : { lastVerificationError: previous.lastVerificationError }),
  }
  return {
    domain,
    schemaVersion: RECIPE_SCHEMA_VERSION,
    ...(patch.disabled === undefined ? (base?.disabled === undefined ? {} : { disabled: base.disabled }) : patch.disabled ? { disabled: true } : {}),
    ...((patch.readPath ?? base?.readPath) === undefined ? {} : { readPath: patch.readPath ?? base?.readPath }),
    ...((patch.selectors ?? base?.selectors) === undefined ? {} : { selectors: patch.selectors ?? base?.selectors }),
    ...((patch.apis ?? base?.apis) === undefined ? {} : { apis: patch.apis ?? base?.apis }),
    ...((patch.loginFlow ?? base?.loginFlow) === undefined ? {} : { loginFlow: patch.loginFlow ?? base?.loginFlow }),
    ...((patch.quirks ?? base?.quirks) === undefined ? {} : { quirks: patch.quirks ?? base?.quirks }),
    provenance,
  }
}

/** A recipe after a verification attempt: `ok` raises, a failure demotes. */
export function withVerification(
  recipe: Recipe,
  result: { status: 'ok' | 'failed' | 'unverifiable'; detail?: string },
  options: { now: string; demoteOnFailure: boolean; demoteStep: number },
): Recipe {
  const provenance: RecipeProvenance = { ...recipe.provenance, lastVerificationStatus: result.status }
  if (result.status === 'ok') {
    provenance.lastVerifiedAt = options.now
    provenance.confidence = Math.min(1, round2(recipe.provenance.confidence + options.demoteStep))
    provenance.verificationFailures = 0
    delete provenance.lastVerificationError
  } else if (result.status === 'failed') {
    provenance.verificationFailures = (recipe.provenance.verificationFailures ?? 0) + 1
    provenance.lastVerificationError = result.detail?.slice(0, 300)
    if (options.demoteOnFailure) provenance.confidence = Math.max(0, round2(recipe.provenance.confidence - options.demoteStep))
  }
  return { ...recipe, provenance }
}

/** `true` when the read-through may use this recipe at all. */
export function recipeUsable(
  recipe: Recipe,
  policy: RecipePolicy,
  now: number = Date.now(),
): { usable: boolean; reason?: string } {
  if (recipe.disabled === true) return { usable: false, reason: 'disabled' }
  if (recipe.readPath === undefined) return { usable: false, reason: 'no readPath' }
  if (recipe.provenance.confidence < policy.minConfidence) {
    return { usable: false, reason: `confidence ${String(recipe.provenance.confidence)} below the minimum ${String(policy.minConfidence)}` }
  }
  if (policy.maxAgeDays > 0) {
    const last = recipe.provenance.lastVerifiedAt
    if (last === undefined) return { usable: false, reason: 'never verified' }
    const ageDays = (now - Date.parse(last)) / 86_400_000
    if (!Number.isFinite(ageDays) || ageDays > policy.maxAgeDays) {
      return { usable: false, reason: `last verified ${String(Math.round(ageDays))} days ago (max ${String(policy.maxAgeDays)})` }
    }
  }
  return { usable: true }
}

/** The compact summary `recipe list` reports. */
export function summarize(recipe: Recipe): RecipeSummary {
  return {
    domain: recipe.domain,
    schemaVersion: recipe.schemaVersion,
    disabled: recipe.disabled === true,
    confidence: recipe.provenance.confidence,
    ...(recipe.provenance.updatedAt === undefined ? {} : { updatedAt: recipe.provenance.updatedAt }),
    ...(recipe.provenance.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: recipe.provenance.lastVerifiedAt }),
    ...(recipe.readPath === undefined ? {} : { readPathKind: recipe.readPath.kind }),
    apiCount: recipe.apis?.length ?? 0,
    selectorCount: recipe.selectors?.length ?? 0,
    hasLoginFlow: recipe.loginFlow !== undefined,
  }
}

/** The domain key of a recipe document, or `undefined` when it is invalid. */
export function recipeDomainKey(value: unknown): string | undefined {
  return normalizeDomain(value)
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}
