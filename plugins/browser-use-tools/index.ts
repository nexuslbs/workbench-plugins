// plugins/browser-use-tools - the CONSUMER of the browser-USE capability
// (`browser-use@1`).
//
// Three roles make up the seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/browser-use.ts) - the contract, `ctx['browser-use']`
//   Provider                          - the service host (`core/browser-use-impl`)
//                                       plus the providers that register with it
//                                       (`core/browser-use-playwright`, ...)
//   Consumer                          - THIS plugin: the agent-facing tool.
//
// It imports the DEFINITION only, so WHICH browser is driven (the chromium
// binary, the engine, the launch argv) is a config choice of the provider rows -
// and `npm run check:seam` enforces that direction.
//
// ONE TOOL, an ACTION ENUM (the `web-session` convention): `browser` with
//   * `providers`   - registered providers, which one is usable, the selection;
//   * `capabilities`- the CAPABILITY REPORT (engine, availability, the exact
//                     prerequisite when no browser is installed, actions);
//   * `open`        - open (or reuse) a session: engine report + storage-state
//                     outcome + the first snapshot refs are NOT included (call
//                     `snapshot` when you want them);
//   * `navigate`    - go to a URL (wait strategy + HTTP status in the answer);
//   * `snapshot`    - the compact STABLE view of the page: every actionable node
//                     carries a short `ref` (`e12`) that `act`/`extract`/`wait`
//                     accept in a LATER call;
//   * `act`         - click, type/fill, select, hover, scroll, press, upload,
//                     check, focus, waitFor, back, forward, reload;
//   * `evaluate`    - one JS expression in the page;
//   * `extract`     - readable text/markdown/html, a table, attributes, links or
//                     a JSON expression (a stored `web-recipe` is used when the
//                     deployment has one, and a missing recipe never fails);
//   * `screenshot`  - the viewport, the full page or one element, written to a
//                     FILE (path + mime + bytes), never inline base64;
//   * `tabs`        - list / new / switch / close;
//   * `wait`        - a bounded sleep and/or a condition (ref, selector, text,
//                     url fragment, network idle);
//   * `observe`     - the network + download view of the session (no polling);
//   * `state`       - `stateAction: save | read | clear` on the storage state;
//   * `sessions`    - the live sessions of every provider;
//   * `close`       - close ONE session and release its context and browser slot.
//
// A TYPED FAILURE IS RETURNED, NOT THROWN: every action answers
// `{ ok: false, error: { reason, code, stage, details, hint } }` when the
// capability fails (no provider, no browser, stale ref, timeout, sandbox
// denial), so the `reason` survives the tools seam (which maps a THROWN error to
// a generic `tool-failed` body) and a caller can branch on it. That is also how
// the "never a fake success" rule is enforced: a missing browser is
// `browser-use.no-browser` with the exact install requirement, and an old ref is
// `browser-use.stale-ref`, never a silent wrong click.

import {
  ACT_KINDS,
  BROWSER_USE_CONFIG_ROW,
  BROWSER_USE_TOOL_NAME,
  EXTRACT_MODES,
  SCREENSHOT_FORMATS,
  TAB_ACTIONS,
  WAIT_STATES,
  WAIT_UNTIL,
  browserUseOf,
  BrowserUseError,
  isBrowserUseError,
  notImplemented,
} from '../../definitions/browser-use.ts'
import type {
  ActKind,
  BrowserActRequest,
  BrowserExtractRequest,
  BrowserNavigateRequest,
  BrowserScreenshotRequest,
  BrowserSnapshotRequest,
  BrowserTabRequest,
  BrowserUseService,
  BrowserWaitRequest,
  ExtractMode,
  ScreenshotFormat,
  TabAction,
  WaitState,
  WaitUntil,
} from '../../definitions/browser-use.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'

export const name = 'browser-use-tools'

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

/** The service surface of the seam, as a consumer may use it. */
type BrowserService = BrowserUseService

interface ToolsLike {
  registerTool(def: {
    name: string
    description?: string
    parameters?: ToolParameters
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  }): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect?: (fn: () => (() => void) | void) => unknown
  'browser-use'?: BrowserService
  logger?: { warn?: (message: string, ...args: unknown[]) => void }
}

/** The actions of the one tool (an agent reads them in the description). */
const ACTIONS = [
  'providers',
  'schema',
  'capabilities',
  'open',
  'navigate',
  'snapshot',
  'act',
  'evaluate',
  'extract',
  'screenshot',
  'tabs',
  'wait',
  'observe',
  'state',
  'sessions',
  'close',
] as const
type Action = (typeof ACTIONS)[number]

/** The parameters each action accepts (a wrong name is a typed answer, not silence). */
const KNOWN_PARAMS: Record<Action, readonly string[]> = {
  providers: ['action'],
  schema: ['action', 'provider', 'schemaFor'],
  capabilities: ['action', 'provider'],
  sessions: ['action', 'provider'],
  open: ['action', 'provider', 'session', 'url', 'headless', 'viewportWidth', 'viewportHeight', 'locale', 'timezoneId', 'userAgent', 'stateMode', 'stateFile', 'downloadDir'],
  close: ['action', 'provider', 'session'],
  navigate: ['action', 'provider', 'session', 'url', 'waitUntil', 'allowHttpError', 'timeoutMs'],
  snapshot: ['action', 'provider', 'session', 'selector', 'includeText', 'maxNodes'],
  act: ['action', 'provider', 'session', 'kind', 'ref', 'selector', 'value', 'byLabel', 'key', 'files', 'direction', 'amount', 'state', 'checked', 'timeoutMs', 'settle', 'snapshot'],
  evaluate: ['action', 'provider', 'session', 'expression', 'args', 'awaitPromise', 'maxChars'],
  extract: ['action', 'provider', 'session', 'mode', 'selector', 'ref', 'attributes', 'index', 'expression', 'maxChars', 'useRecipe'],
  screenshot: ['action', 'provider', 'session', 'fullPage', 'selector', 'ref', 'format', 'quality', 'path', 'label', 'maxBytes'],
  tabs: ['action', 'provider', 'session', 'tabAction', 'index', 'url', 'navigate', 'timeoutMs'],
  wait: ['action', 'provider', 'session', 'ms', 'ref', 'selector', 'state', 'urlContains', 'text', 'networkIdle', 'timeoutMs'],
  observe: ['action', 'provider', 'session', 'limit', 'filter'],
  state: ['action', 'provider', 'session', 'stateAction', 'path'],
}

/**
 * The ALIASES this tool accepts, per action, for the parameter names a caller
 * really writes. They exist because the failure mode was MEASURED (thread 2590):
 * an agent that knows only the tool NAME guesses `text` for `value`,
 * `milliseconds` for the wait duration and `storageStateFile` for the storage
 * state - each guess cost a call. An alias is accepted ONLY where it is
 * unambiguous for that action; the canonical name always wins when both are
 * present.
 */
const PARAM_ALIASES: Partial<Record<Action, Record<string, string>>> = {
  act: { text: 'value', timeout: 'timeoutMs', timeoutMilliseconds: 'timeoutMs' },
  navigate: { timeout: 'timeoutMs', timeoutMilliseconds: 'timeoutMs' },
  wait: { milliseconds: 'ms', timeout: 'timeoutMs', timeoutMilliseconds: 'timeoutMs' },
  open: { storageStateFile: 'stateFile', storageState: 'stateFile' },
  screenshot: { timeout: 'timeoutMs' },
  tabs: { timeout: 'timeoutMs' },
}

/**
 * The parameters each action REQUIRES (everything else is optional). It mirrors
 * the runtime checks of the request builders - published so a caller can see the
 * contract instead of discovering it through a typed error.
 */
const REQUIRED_PARAMS: Record<Action, readonly string[]> = {
  providers: [],
  schema: [],
  capabilities: [],
  sessions: [],
  open: [],
  close: ['session'],
  navigate: ['session', 'url'],
  snapshot: ['session'],
  act: ['session', 'kind'],
  evaluate: ['session', 'expression'],
  extract: ['session'],
  screenshot: ['session'],
  tabs: ['session'],
  wait: ['session'],
  observe: ['session'],
  state: ['session'],
}

/** One action's published contract (what `action: schema` answers). */
interface ActionSchema {
  action: Action
  parameters: Record<string, ParameterSchemaSpec[string] & { required?: boolean }>
  required: string[]
  /** The aliases accepted for this action, alias -> canonical name. */
  aliases: Record<string, string>
}

/**
 * Normalizes the documented aliases of an action to their canonical names. The
 * canonical name WINS when both are present, and an alias is dropped from the
 * parameter map so the (strict) known-parameter check still sees only canonical
 * keys.
 */
function applyAliases(
  params: Record<string, unknown>,
  action: Action,
): { params: Record<string, unknown>; aliases: Record<string, string> } {
  const table = PARAM_ALIASES[action]
  if (table === undefined) return { params, aliases: {} }
  const normalized: Record<string, unknown> = { ...params }
  const aliases: Record<string, string> = {}
  for (const [alias, canonical] of Object.entries(table)) {
    if (normalized[alias] === undefined) continue
    if (normalized[canonical] === undefined) normalized[canonical] = normalized[alias]
    delete normalized[alias]
    aliases[alias] = canonical
  }
  return { params: normalized, aliases }
}

/**
 * The FULL per-action contract of this tool: the parameters each action accepts,
 * their types, their units, whether they are required and the aliases accepted
 * for them. It is built from the ONE source of truth (the published parameter
 * map + {@link KNOWN_PARAMS}), so the schema a caller INTROSPECTS cannot drift
 * from the parameters the tool validates.
 */
function actionSchemas(parameters: ParameterSchemaSpec): ActionSchema[] {
  return ACTIONS.map((action) => {
    const required = new Set(REQUIRED_PARAMS[action])
    const picked: ActionSchema['parameters'] = {}
    for (const name of KNOWN_PARAMS[action]) {
      const spec = parameters[name]
      picked[name] = {
        ...(spec === undefined ? { type: 'string' } : { type: spec.type }),
        ...(required.has(name) ? { required: true } : {}),
        ...(spec?.description === undefined ? {} : { description: spec.description }),
      }
    }
    return { action, parameters: picked, required: [...required], aliases: PARAM_ALIASES[action] ?? {} }
  })
}

function actionOf(params: Record<string, unknown>): Action {
  const raw = params.action
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw notImplemented("the parameter 'action' is required", { stage: 'request', details: { actions: [...ACTIONS] } })
  }
  const action = raw.trim() as Action
  if (!ACTIONS.includes(action)) {
    throw notImplemented(`unknown action '${raw}'`, { stage: 'request', details: { actions: [...ACTIONS] } })
  }
  return action
}

function assertKnownParams(params: Record<string, unknown>, action: Action): void {
  const known = new Set(KNOWN_PARAMS[action])
  const unknown = Object.keys(params).filter((key) => params[key] !== undefined && !known.has(key))
  if (unknown.length > 0) {
    // The message carries the ACCEPTED keys (and the aliases for this action):
    // a caller reading the failure can correct its call without a second guess.
    const aliases = Object.keys(PARAM_ALIASES[action] ?? {})
    // Built DIRECTLY, not through `notImplemented`: that helper nests the passed
    // object one level down under `details.action`, and a caller must be able to
    // read `details.accepted` / `details.aliases` FLAT.
    throw new BrowserUseError(
      'browser-use.not-implemented',
      `unknown parameter(s) for 'action: ${action}': ${unknown.join(', ')} - accepted: ${[...known].join(', ')}` +
        (aliases.length === 0 ? '' : ` (aliases: ${aliases.join(', ')})`),
      {
        stage: 'request',
        details: { action, accepted: [...known], ...(aliases.length === 0 ? {} : { aliases: PARAM_ALIASES[action] }) },
      },
    )
  }
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw notImplemented(`'${key}' must be a string`, { stage: 'request', details: { key, got: typeof value } })
  }
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined) {
    throw notImplemented(`'${key}' is required`, { stage: 'request', details: { key } })
  }
  return value
}

function optionalNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) {
    throw notImplemented(`'${key}' must be a number`, { stage: 'request', details: { key, got: String(value) } })
  }
  return numeric
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  throw notImplemented(`'${key}' must be a boolean`, { stage: 'request', details: { key, got: String(value) } })
}

/** One of a closed set (the seam re-validates: this is the friendly layer). */
function optionalOneOf<T extends string>(params: Record<string, unknown>, key: string, allowed: readonly T[]): T | undefined {
  const value = optionalString(params, key)
  if (value === undefined) return undefined
  if (!allowed.includes(value as T)) {
    throw notImplemented(`'${key}' must be one of ${allowed.join(' | ')}`, {
      stage: 'request',
      details: { key, got: value, allowed: [...allowed] },
    })
  }
  return value as T
}

function stringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : undefined
  if (list === undefined || list.some((entry) => typeof entry !== 'string')) {
    throw notImplemented(`'${key}' must be an array of strings`, { stage: 'request', details: { key } })
  }
  return list.map((entry) => String(entry))
}

/** The session a call addresses (the provider names its own default). */
function sessionOf(params: Record<string, unknown>): string | undefined {
  return optionalString(params, 'session')
}

/** The provider a call forces (absent: the host's selection policy applies). */
function providerOf(params: Record<string, unknown>): string | undefined {
  return optionalString(params, 'provider')
}

/**
 * The failure body of a typed error: the `reason` a caller branches on survives
 * the tools seam. A non-seam error is reported as a provider failure with its
 * message - never hidden.
 */
function failureBody(error: unknown, hint?: string): Record<string, unknown> {
  if (isBrowserUseError(error)) {
    return {
      ok: false,
      error: {
        reason: error.reason,
        code: error.code,
        stage: error.stage,
        message: error.message,
        details: error.details ?? {},
        ...(hint === undefined ? {} : { hint }),
      },
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0] ?? message
  return {
    ok: false,
    error: {
      reason: 'browser-use.provider-failed',
      code: 'internal',
      stage: 'tool',
      message: firstLine.length > 300 ? `${firstLine.slice(0, 300)}...` : firstLine,
      details: {},
      ...(hint === undefined ? {} : { hint }),
    },
  }
}

/** The service, or the typed answer explaining why there is none. */
function serviceOf(ctx: PluginContext): BrowserService | Record<string, unknown> {
  const service = browserUseOf(ctx as never)
  if (service === undefined) {
    return {
      ok: false,
      error: {
        reason: 'browser-use.missing-service',
        code: 'missing-service',
        stage: 'tool',
        message: 'the browser-use@1 service is not loaded: add the host plugin (browser-use-impl) and a provider plugin to the roster',
        details: {},
        hint: BROWSER_USE_CONFIG_ROW,
      },
    }
  }
  return service
}

function isService(value: BrowserService | Record<string, unknown>): value is BrowserService {
  return typeof (value as BrowserService).open === 'function'
}

// ---------------------------------------------------------------------------
// Request builders: the tool's flat parameters -> the seam's typed request.
// ---------------------------------------------------------------------------

function openSpec(params: Record<string, unknown>) {
  const width = optionalNumber(params, 'viewportWidth')
  const height = optionalNumber(params, 'viewportHeight')
  const viewport = width !== undefined && height !== undefined ? { width, height } : undefined
  const locale = optionalString(params, 'locale')
  const timezoneId = optionalString(params, 'timezoneId')
  const userAgent = optionalString(params, 'userAgent')
  const stateMode = optionalOneOf(params, 'stateMode', ['reuse', 'fresh', 'inline'] as const)
  const stateFile = optionalString(params, 'stateFile')
  const downloadDir = optionalString(params, 'downloadDir')
  const headless = optionalBoolean(params, 'headless')
  return {
    ...(sessionOf(params) === undefined ? {} : { session: sessionOf(params) }),
    ...(headless === undefined ? {} : { headless }),
    ...(viewport === undefined ? {} : { viewport }),
    ...(locale === undefined ? {} : { locale }),
    ...(timezoneId === undefined ? {} : { timezoneId }),
    ...(userAgent === undefined ? {} : { userAgent }),
    ...(stateMode === undefined ? {} : { stateMode }),
    ...(stateFile === undefined ? {} : { storageStateFile: stateFile }),
    ...(downloadDir === undefined ? {} : { downloadDir }),
  }
}

function navigateRequest(params: Record<string, unknown>): BrowserNavigateRequest {
  const waitUntil = optionalOneOf<WaitUntil>(params, 'waitUntil', WAIT_UNTIL)
  const timeoutMs = optionalNumber(params, 'timeoutMs')
  const allowHttpError = optionalBoolean(params, 'allowHttpError')
  return {
    url: requiredString(params, 'url'),
    ...(waitUntil === undefined ? {} : { waitUntil }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(allowHttpError === undefined ? {} : { allowHttpError }),
  }
}

function snapshotRequest(params: Record<string, unknown>): BrowserSnapshotRequest {
  const selector = optionalString(params, 'selector')
  const includeText = optionalBoolean(params, 'includeText')
  const maxNodes = optionalNumber(params, 'maxNodes')
  return {
    ...(selector === undefined ? {} : { selector }),
    ...(includeText === undefined ? {} : { includeText }),
    ...(maxNodes === undefined ? {} : { maxNodes }),
  }
}

function actRequest(params: Record<string, unknown>): BrowserActRequest {
  const kind = optionalOneOf<ActKind>(params, 'kind', ACT_KINDS)
  if (kind === undefined) {
    throw notImplemented(`'action: act' needs 'kind' (${ACT_KINDS.join(' | ')})`, {
      stage: 'request',
      details: { kinds: [...ACT_KINDS] },
    })
  }
  const ref = optionalString(params, 'ref')
  const selector = optionalString(params, 'selector')
  const value = optionalString(params, 'value')
  const byLabel = optionalBoolean(params, 'byLabel')
  const key = optionalString(params, 'key')
  const files = stringArray(params, 'files')
  const direction = optionalOneOf(params, 'direction', ['up', 'down', 'left', 'right'] as const)
  const amount = optionalNumber(params, 'amount')
  const state = optionalOneOf<WaitState>(params, 'state', WAIT_STATES)
  const checked = optionalBoolean(params, 'checked')
  const timeoutMs = optionalNumber(params, 'timeoutMs')
  const settle = optionalBoolean(params, 'settle')
  const snapshot = optionalBoolean(params, 'snapshot')
  return {
    kind,
    ...(ref === undefined ? {} : { ref }),
    ...(selector === undefined ? {} : { selector }),
    ...(value === undefined ? {} : { value }),
    ...(byLabel === undefined ? {} : { byLabel }),
    ...(key === undefined ? {} : { key }),
    ...(files === undefined ? {} : { files }),
    ...(direction === undefined ? {} : { direction }),
    ...(amount === undefined ? {} : { amount }),
    ...(state === undefined ? {} : { state }),
    ...(checked === undefined ? {} : { checked }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(settle === undefined ? {} : { settle }),
    ...(snapshot === undefined ? {} : { snapshot }),
  }
}

function extractRequest(params: Record<string, unknown>): BrowserExtractRequest {
  const mode = optionalOneOf<ExtractMode>(params, 'mode', EXTRACT_MODES)
  const selector = optionalString(params, 'selector')
  const ref = optionalString(params, 'ref')
  const attributes = stringArray(params, 'attributes')
  const index = optionalNumber(params, 'index')
  const expression = optionalString(params, 'expression')
  const maxChars = optionalNumber(params, 'maxChars')
  const useRecipe = optionalBoolean(params, 'useRecipe')
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(selector === undefined ? {} : { selector }),
    ...(ref === undefined ? {} : { ref }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(index === undefined ? {} : { index }),
    ...(expression === undefined ? {} : { expression }),
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(useRecipe === undefined ? {} : { useRecipe }),
  }
}

function screenshotRequest(params: Record<string, unknown>): BrowserScreenshotRequest {
  const fullPage = optionalBoolean(params, 'fullPage')
  const selector = optionalString(params, 'selector')
  const ref = optionalString(params, 'ref')
  const format = optionalOneOf<ScreenshotFormat>(params, 'format', SCREENSHOT_FORMATS)
  const quality = optionalNumber(params, 'quality')
  const path = optionalString(params, 'path')
  const label = optionalString(params, 'label')
  const maxBytes = optionalNumber(params, 'maxBytes')
  return {
    ...(fullPage === undefined ? {} : { fullPage }),
    ...(selector === undefined ? {} : { selector }),
    ...(ref === undefined ? {} : { ref }),
    ...(format === undefined ? {} : { format }),
    ...(quality === undefined ? {} : { quality }),
    ...(path === undefined ? {} : { path }),
    ...(label === undefined ? {} : { label }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  }
}

function tabRequest(params: Record<string, unknown>): BrowserTabRequest {
  const action = optionalOneOf<TabAction>(params, 'tabAction', TAB_ACTIONS)
  const index = optionalNumber(params, 'index')
  const url = optionalString(params, 'url')
  const navigate = optionalBoolean(params, 'navigate')
  const timeoutMs = optionalNumber(params, 'timeoutMs')
  return {
    ...(action === undefined ? {} : { action }),
    ...(index === undefined ? {} : { index }),
    ...(url === undefined ? {} : { url }),
    ...(navigate === undefined ? {} : { navigate }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function waitRequest(params: Record<string, unknown>): BrowserWaitRequest {
  const ms = optionalNumber(params, 'ms')
  const ref = optionalString(params, 'ref')
  const selector = optionalString(params, 'selector')
  const state = optionalOneOf<WaitState>(params, 'state', WAIT_STATES)
  const urlContains = optionalString(params, 'urlContains')
  const text = optionalString(params, 'text')
  const networkIdle = optionalBoolean(params, 'networkIdle')
  const timeoutMs = optionalNumber(params, 'timeoutMs')
  if (ms === undefined && ref === undefined && selector === undefined && urlContains === undefined && text === undefined && networkIdle === undefined) {
    throw notImplemented("'action: wait' needs at least one of 'ms', 'ref', 'selector', 'urlContains', 'text', 'networkIdle'", {
      stage: 'request',
      details: {},
    })
  }
  return {
    ...(ms === undefined ? {} : { ms }),
    ...(ref === undefined ? {} : { ref }),
    ...(selector === undefined ? {} : { selector }),
    ...(state === undefined ? {} : { state }),
    ...(urlContains === undefined ? {} : { urlContains }),
    ...(text === undefined ? {} : { text }),
    ...(networkIdle === undefined ? {} : { networkIdle }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  }
}

function observeRequest(params: Record<string, unknown>) {
  const limit = optionalNumber(params, 'limit')
  const filter = optionalString(params, 'filter')
  return {
    ...(limit === undefined ? {} : { limit }),
    ...(filter === undefined ? {} : { filter }),
  }
}

function stateRequest(params: Record<string, unknown>) {
  const action = optionalOneOf(params, 'stateAction', ['save', 'read', 'clear'] as const)
  const path = optionalString(params, 'path')
  return {
    ...(action === undefined ? {} : { action }),
    ...(path === undefined ? {} : { path }),
  }
}

// ---------------------------------------------------------------------------
// The plugin.
// ---------------------------------------------------------------------------

/**
 * The published parameter map of the `browser` tool: the ONE source of truth for
 * what a caller may pass. It is both the schema the tools provider serves
 * (`GET /api/tools/browser`, `POST /api/tool/call`) and the table the `schema`
 * action answers from, so the contract a caller can INTROSPECT can never drift
 * from the parameters this tool validates.
 *
 * UNITS: every duration field is in MILLISECONDS (`ms`, `timeoutMs`).
 * ALIASES: a documented alias is accepted too (see `PARAM_ALIASES`); an alias is
 * only accepted where it is unambiguous for the action it is listed under.
 */
const BROWSER_TOOL_PARAMETERS: ParameterSchemaSpec = {
  action: { type: 'string', required: true, description: `the operation: ${ACTIONS.join(' | ')}` },
  provider: { type: 'string', description: 'force ONE provider id (default: the configured provider of the host)' },
  session: { type: 'string', description: 'the session id this call addresses (default: the provider default session)' },
  schemaFor: { type: 'string', description: "'action: schema': publish the contract of ONE action only (default: all of them)" },
  // open
  url: { type: 'string', description: "the URL: 'navigate', or the first page of 'open'/'tabs: new'" },
  headless: { type: 'boolean', description: "'open': run without a window (a LAUNCH-time setting of the shared browser)" },
  viewportWidth: { type: 'integer', description: "'open': the viewport width in CSS pixels" },
  viewportHeight: { type: 'integer', description: "'open': the viewport height in CSS pixels" },
  locale: { type: 'string', description: "'open': the Accept-Language locale, e.g. en-US" },
  timezoneId: { type: 'string', description: "'open': the IANA timezone, e.g. Europe/Berlin" },
  userAgent: { type: 'string', description: "'open': the user agent of the session" },
  stateMode: { type: 'string', description: "'open': reuse (default) | fresh | inline - how the stored storage state is used" },
  stateFile: { type: 'string', description: "'open': the storage-state file of this session (default: the provider convention). Aliases: `storageStateFile`, `storageState`" },
  downloadDir: { type: 'string', description: "'open': where downloads of this session are saved" },
  // navigate
  waitUntil: { type: 'string', description: `'navigate': when it is done: ${WAIT_UNTIL.join(' | ')}` },
  allowHttpError: { type: 'boolean', description: "'navigate': accept an HTTP >= 400 answer instead of failing" },
  // snapshot / extract / act targeting
  selector: { type: 'string', description: 'a CSS selector to scope or target (snapshot/extract/screenshot/act/wait)' },
  ref: { type: 'string', description: "the SHORT ref from a `snapshot` (e.g. 'e12'); a ref from an older snapshot is retried ONCE automatically (see `refRetry` in the answer) and only then a typed stale-ref" },
  includeText: { type: 'boolean', description: "'snapshot': include non-actionable text nodes too (default true)" },
  maxNodes: { type: 'integer', description: "'snapshot': cap the nodes of this answer" },
  // act
  kind: { type: 'string', description: `'action: act' only: ${ACT_KINDS.join(' | ')}` },
  value: { type: 'string', description: "'type'/'fill'/'select': the text or option value to write. On `act`, `text` is accepted as an alias" },
  byLabel: { type: 'boolean', description: "'select': treat 'value' as the option LABEL, not its value" },
  key: { type: 'string', description: "'press': the key or chord, e.g. Enter, Control+A" },
  files: { type: 'array', description: "'upload': the file paths handed to the file input" },
  direction: { type: 'string', description: "'scroll': up | down | left | right (default down)" },
  amount: { type: 'integer', description: "'scroll': how many pixels (default one viewport)" },
  state: { type: 'string', description: `'act: waitFor'/'wait': the state to wait for: ${WAIT_STATES.join(' | ')}` },
  checked: { type: 'boolean', description: "'check': true to check, false to uncheck (default true)" },
  timeoutMs: { type: 'integer', description: 'the budget of this call in MILLISECONDS (navigation/action/wait); aliases: `timeout`, `timeoutMilliseconds`' },
  // COMPAT ALIASES: declared HERE as well as in `PARAM_ALIASES`, because the
  // tools surface REJECTS an undeclared key (`invalid-params`, naming it) before
  // the handler ever runs - an alias that is not in this map can never reach the
  // normalization step. The handler then rewrites each of these to its canonical
  // name, so `action: schema` keeps publishing the CANONICAL contract.
  milliseconds: { type: 'integer', description: "COMPAT alias of `ms` (`wait`): sleep this long, in MILLISECONDS" },
  timeout: { type: 'integer', description: 'COMPAT alias of `timeoutMs` (MILLISECONDS)' },
  timeoutMilliseconds: { type: 'integer', description: 'COMPAT alias of `timeoutMs` (MILLISECONDS)' },
  storageStateFile: { type: 'string', description: 'COMPAT alias of `stateFile` (`open`): the storage-state file of this session' },
  storageState: { type: 'string', description: 'COMPAT alias of `stateFile` (`open`): the storage-state file of this session' },
  settle: { type: 'boolean', description: "'act': let in-flight work settle afterwards (default true)" },
  snapshot: { type: 'boolean', description: "'act': answer a FRESH snapshot with the result (default false: the refs of the previous one go stale)" },
  // evaluate / extract
  expression: { type: 'string', description: "'evaluate'/'extract mode: json': the JS expression evaluated in the page" },
  args: { type: 'array', description: "'evaluate': arguments handed to the expression" },
  awaitPromise: { type: 'boolean', description: "'evaluate': await a promise result (default true)" },
  mode: { type: 'string', description: `'extract' only: ${EXTRACT_MODES.join(' | ')} (default text)` },
  attributes: { type: 'array', description: "'extract mode: attributes': the attribute names to read" },
  index: { type: 'integer', description: "'extract mode: table': which table of the page (0-based, default 0) / 'tabs: switch|close': the tab index" },
  useRecipe: { type: 'boolean', description: "'extract': consult a stored web-recipe for this domain (default true; a missing recipe never fails)" },
  maxChars: { type: 'integer', description: "'extract'/'evaluate': cap the answered characters" },
  // screenshot
  fullPage: { type: 'boolean', description: "'screenshot': capture the whole scrollable page (default false: the viewport)" },
  format: { type: 'string', description: `'screenshot': ${SCREENSHOT_FORMATS.join(' | ')} (default png)` },
  quality: { type: 'integer', description: "'screenshot': JPEG quality 1..100 (ignored for png)" },
  path: { type: 'string', description: "'screenshot': write the file HERE; 'state': use this state file" },
  label: { type: 'string', description: "'screenshot': a short label used in the file name" },
  maxBytes: { type: 'integer', description: "'screenshot': the byte cap of the written file (default from the config)" },
  // tabs / wait / observe / state
  tabAction: { type: 'string', description: `'action: tabs' only: ${TAB_ACTIONS.join(' | ')} (default list)` },
  navigate: { type: 'boolean', description: "'tabs: new': wait for the URL before answering (default true)" },
  ms: { type: 'integer', description: "'wait': sleep this long, in MILLISECONDS (alias: `milliseconds`)" },
  urlContains: { type: 'string', description: "'wait': wait until the URL contains this fragment" },
  text: { type: 'string', description: "'wait': wait until the page contains this text; on 'act' it is the COMPAT alias of `value` (what `type`/`fill`/`select` write)" },
  networkIdle: { type: 'boolean', description: "'wait': wait until no network request is in flight" },
  limit: { type: 'integer', description: "'observe': how many of the newest requests to report" },
  filter: { type: 'string', description: "'observe': only requests whose URL contains this fragment" },
  stateAction: { type: 'string', description: "'action: state' only: save (default) | read | clear" },
}

export function apply(ctx: PluginContext): void {
  ctx.effect?.(() =>
    ctx.tools.registerTool({
      name: BROWSER_USE_TOOL_NAME,
      description:
        'Drives a real browser through the configured browser-use@1 provider. `action: providers` lists the providers and the selection, ' +
        '`capabilities` the CAPABILITY REPORT (which engine, is it available, and the exact prerequisite when it is not), ' +
        '`open` opens or reuses a session (`session` id, viewport, locale, proxy, storage state), ' +
        '`navigate` loads a URL, `snapshot` returns the compact page view whose nodes carry SHORT STABLE refs (`e12`) that the later calls accept, ' +
        '`act` interacts (`kind`: ' + ACT_KINDS.join(' | ') + ') with `ref` or `selector`, ' +
        '`evaluate` runs one JS expression, `extract` reads text/markdown/html/table/attributes/links/json, ' +
        '`screenshot` writes a PNG/JPEG FILE and answers its path + bytes (never inline base64), ' +
        '`tabs` lists/opens/switches/closes tabs, `wait` sleeps and/or waits for a ref/selector/text/URL/network idle, ' +
        '`observe` reports the requests and downloads the session saw, `state` saves/reads/clears the storage state, ' +
        '`sessions` lists the live sessions and `close` closes one. ' +
        '`schema` publishes the FULL per-action contract (parameter names, types, units - every duration is MILLISECONDS -, ' +
        'which are required, and the accepted aliases such as `text` for `value` on `act`, `milliseconds` for `ms` on `wait`, ' +
        '`storageStateFile` for `stateFile` on `open`): INTROSPECT it instead of guessing. ' +
        'A ref that went stale between `snapshot` and `act` is re-snapshotted and retried ONCE automatically (the answer says so ' +
        'under `refRetry`), so a re-rendering page does not cost the caller a call. ' +
        'Every failure is a TYPED answer (`browser-use.no-browser`, `.stale-ref`, `.timeout`, `.navigation-failed`, ...) with the exact ' +
        'prerequisite - never a fabricated result and never a silent fallback. Pass `provider` to force one provider.',
      parameters: BROWSER_TOOL_PARAMETERS,
      handler: async (params) => {
        const service = serviceOf(ctx)
        if (!isService(service)) return service
        // EVERYTHING runs inside the try: a parameter violation is a TYPED answer,
        // not a throw (the tools provider turns a throw into a generic
        // `tool-failed` body and the reason would be lost).
        try {
          const action = actionOf(params)
          // Documented aliases FIRST, resolved against the CANONICAL action's
          // table: `text` on `act` becomes `value`, `milliseconds` on `wait`
          // becomes `ms`, `storageStateFile` on `open` becomes `stateFile`. The
          // strict known-parameter check below then sees canonical keys only.
          const normalized = applyAliases(params, action)
          params = normalized.params
          assertKnownParams(params, action)
          const provider = providerOf(params)
          const session = sessionOf(params)
          switch (action) {
            case 'schema': {
              const only = optionalString(params, 'schemaFor')
              const all = actionSchemas(BROWSER_TOOL_PARAMETERS)
              const selected = only === undefined ? all : all.filter((entry) => entry.action === only)
              if (selected.length === 0) {
                throw notImplemented(`'action: schema': unknown action '${only}'`, {
                  stage: 'request',
                  details: { actions: [...ACTIONS] },
                })
              }
              return {
                ok: true,
                tool: BROWSER_USE_TOOL_NAME,
                durationUnits: 'MILLISECONDS (every duration field: `ms`, `timeoutMs`)',
                aliasPolicy: 'an alias is accepted only where it is unambiguous for the action; the canonical name wins when both are given',
                actions: selected,
                hint: BROWSER_USE_CONFIG_ROW,
              }
            }
            case 'providers':
              return {
                ok: true,
                selection: service.selection(),
                providers: service.providers(),
                hint: BROWSER_USE_CONFIG_ROW,
              }
            case 'capabilities':
              return { ok: true, ...(await service.capabilities(provider)) }
            case 'sessions':
              return { ok: true, sessions: await service.sessions() }
            case 'open': {
              const info = await service.open(openSpec(params) as never, provider)
              const url = optionalString(params, 'url')
              if (url !== undefined) {
                const navigated = await service.navigate(info.id, { url }, provider)
                // The TOP-LEVEL url/title of the answer are the POST-navigation
                // values: `info` is the freshly opened session (about:blank), so
                // a caller reading the top-level `url` must not read a stale
                // value while `navigated` holds the real one (finding F2, thread
                // 2577). The full navigation answer stays under `navigated`.
                return { ok: true, ...info, url: navigated.url, title: navigated.title, navigated }
              }
              return { ok: true, ...info }
            }
            case 'close': {
              if (session === undefined) {
                throw notImplemented("'action: close' needs 'session' (the id `sessions`/`open` reported)", { stage: 'request', details: {} })
              }
              return { ok: true, ...(await service.close(session, provider)) }
            }
            case 'navigate': {
              if (session === undefined) {
                throw notImplemented("'action: navigate' needs 'session'", { stage: 'request', details: {} })
              }
              return { ok: true, ...(await service.navigate(session, navigateRequest(params), provider)) }
            }
            case 'snapshot':
              return { ok: true, ...(await service.snapshot(requireSession(session, 'snapshot'), snapshotRequest(params), provider)) }
            case 'act':
              return { ok: true, ...(await service.act(requireSession(session, 'act'), actRequest(params), provider)) }
            case 'evaluate': {
              const expression = requiredString(params, 'expression')
              const args = Array.isArray(params.args) ? params.args : undefined
              const awaitPromise = optionalBoolean(params, 'awaitPromise')
              const maxChars = optionalNumber(params, 'maxChars')
              return {
                ok: true,
                ...(await service.evaluate(requireSession(session, 'evaluate'), {
                  expression,
                  ...(args === undefined ? {} : { args }),
                  ...(awaitPromise === undefined ? {} : { awaitPromise }),
                  ...(maxChars === undefined ? {} : { maxChars }),
                }, provider)),
              }
            }
            case 'extract':
              return { ok: true, ...(await service.extract(requireSession(session, 'extract'), extractRequest(params), provider)) }
            case 'screenshot':
              return { ok: true, ...(await service.screenshot(requireSession(session, 'screenshot'), screenshotRequest(params), provider)) }
            case 'tabs':
              return { ok: true, ...(await service.tabs(requireSession(session, 'tabs'), tabRequest(params), provider)) }
            case 'wait':
              return { ok: true, ...(await service.wait(requireSession(session, 'wait'), waitRequest(params), provider)) }
            case 'observe':
              return { ok: true, ...(await service.observe(requireSession(session, 'observe'), observeRequest(params), provider)) }
            default:
              return { ok: true, ...(await service.state(requireSession(session, 'state'), stateRequest(params), provider)) }
          }
        } catch (error) {
          return failureBody(error, BROWSER_USE_CONFIG_ROW)
        }
      },
    }),
  )
}

/** Every action except `open`/`sessions`/`providers`/`capabilities` names its session. */
function requireSession(session: string | undefined, action: Action): string {
  if (session === undefined) {
    throw notImplemented(`'action: ${action}' needs 'session' (open one first, or read the id from 'sessions')`, {
      stage: 'request',
      details: { action },
    })
  }
  return session
}

export default { name, inject: ['tools'], apply }
