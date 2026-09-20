// plugins/computer-use-tools - the CONSUMER of the computer-USE capability
// (`computer-use@1`).
//
// Three roles make up the seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/computer-use.ts) - the contract, `ctx['computer-use']`
//   Provider                          - the service host (`core/computer-use-impl`)
//                                       plus the DRIVERS that register with it
//                                       (`core/computer-use-x11`, ...)
//   Consumer                          - THIS plugin: the agent-facing tool.
//
// It imports the DEFINITION only, so the desktop behind `computer` is a CONFIG
// choice (the target display, the runner, the container) and `npm run check:seam`
// enforces that direction.
//
// ONE TOOL, an ACTION ENUM (the `web-session` convention): `computer` with
//   * `providers`  - registered drivers, which is usable, and the selection;
//   * `open`       - the CAPABILITY REPORT (display reachable? which binaries?
//                    which actions usable?) - it also brings an owned display up;
//   * `screen`     - the screen geometry (+ pointer);
//   * `screenshot` - full screen or a region, written to a FILE (path + mime +
//                    bytes), never inline base64;
//   * `act`        - the pointer (`kind: move|click|drag|scroll`), the keyboard
//                    (`kind: type|key`) and the clipboard (`kind: copy|paste`);
//   * `window`     - `windowAction: list|focus|launch|close`;
//   * `wait`       - a bounded delay, or wait for a window to appear;
//   * `close`      - close ONE window by title or id.
//
// A TYPED FAILURE IS RETURNED, NOT THROWN: every action answers
// `{ ok: false, error: { reason, code, stage, details, hint } }` when the
// capability fails (no provider, no display, missing binary, timeout, sandbox
// denial), so the `reason` survives the tools seam (which maps a THROWN error to a
// generic `tool-failed` body) and a caller can branch on it. That is also how the
// "never a fake success" rule is enforced: an action the target cannot serve is
// `computer-use.not-implemented`/`no-display`/`missing-tool`, never a silent no-op.

import { COMPUTER_USE_CONFIG_ROW, computerUseOf, isComputerUseError } from '../../definitions/computer-use.ts'
import type {
  ClipboardRequest,
  ComputerUseService,
  ScreenshotRequest,
  WaitRequest,
  WindowRequest,
} from '../../definitions/computer-use.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'

export const name = 'computer-use-tools'

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

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
  effect(callback: () => () => void): void
  get?(name: string, strict?: boolean): unknown
}

/** The action enum of the tool (the ONE tool this plugin registers). */
export const ACTIONS = ['providers', 'open', 'screen', 'screenshot', 'act', 'window', 'wait', 'close'] as const
export type ComputerToolAction = (typeof ACTIONS)[number]

/** The `kind` values of `action: 'act'`. */
export const ACT_KINDS = ['move', 'click', 'drag', 'scroll', 'type', 'key', 'copy', 'paste'] as const

/** The `windowAction` values of `action: 'window'`. */
export const WINDOW_SUBACTIONS = ['list', 'focus', 'launch', 'close'] as const

/**
 * A parameter violation raised from the tool itself. The tools provider already
 * validates the declared schema before the handler runs, so this only fires for a
 * caller that bypassed it; it carries the SAME shape a capability error does.
 */
class ComputerToolInputError extends Error {
  readonly field: string

  constructor(message: string, field: string) {
    super(message)
    this.name = 'ComputerToolInputError'
    this.field = field
  }
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new ComputerToolInputError(`the '${key}' parameter must be a string`, key)
  return value.length === 0 ? undefined : value
}

/** A REQUIRED string parameter (empty counts as absent). */
function requiredString(params: Record<string, unknown>, key: string): string {
  const value = optionalString(params, key)
  if (value === undefined) throw new ComputerToolInputError(`the '${key}' parameter is required`, key)
  return value
}

/** Read an optional boolean parameter. */
function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new ComputerToolInputError(`the '${key}' parameter must be a boolean`, key)
  return value
}

/** Read an optional number parameter (integer, >= 0). */
function optionalNumber(params: Record<string, unknown>, key: string, min = 0): number | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new ComputerToolInputError(`the '${key}' parameter must be an integer >= ${min}`, key)
  }
  return value
}

/** Read an optional array-of-strings parameter. */
function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ComputerToolInputError(`the '${key}' parameter must be an array of strings`, key)
  }
  return value as string[]
}

/** One of a fixed vocabulary, or a parameter error naming the allowed values. */
function optionalEnum<T extends string>(
  params: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = optionalString(params, key)
  if (value === undefined) return undefined
  const match = allowed.find((candidate) => candidate.toLowerCase() === value.toLowerCase())
  if (match === undefined) {
    throw new ComputerToolInputError(`the '${key}' parameter must be one of ${allowed.join(' | ')}`, key)
  }
  return match
}

/** The action the caller asked for (a required, case-insensitive enum). */
function actionOf(params: Record<string, unknown>): ComputerToolAction {
  const action = optionalEnum(params, 'action', ACTIONS)
  if (action === undefined) {
    throw new ComputerToolInputError(`the 'action' parameter is required (one of ${ACTIONS.join(' | ')})`, 'action')
  }
  return action
}

/** The parameter names every action accepts (the selector, the driver choice, the bounds). */
const COMMON_KEYS = ['action', 'provider', 'timeoutMs', 'maxImageBytes'] as const

/** The parameter names each action reads beyond `COMMON_KEYS`. */
const ACTION_KEYS: Record<ComputerToolAction, readonly string[]> = {
  providers: [],
  open: [],
  screen: [],
  screenshot: ['format', 'quality', 'label', 'path', 'regionX', 'regionY', 'regionWidth', 'regionHeight'],
  act: [
    'kind',
    'x',
    'y',
    'fromX',
    'fromY',
    'toX',
    'toY',
    'button',
    'clicks',
    'direction',
    'amount',
    'durationMs',
    'delayMs',
    'text',
    'chord',
    'keyAction',
    'selection',
  ],
  window: ['windowAction', 'title', 'id', 'command', 'args', 'waitTitle'],
  wait: ['ms', 'title'],
  close: ['title', 'id'],
}

/** The parameter that SELECTED the behaviour an unknown key is reported against. */
const ACTION_FIELD: Record<ComputerToolAction, string> = {
  providers: 'action',
  open: 'action',
  screen: 'action',
  screenshot: 'action',
  act: 'kind',
  window: 'windowAction',
  wait: 'ms',
  close: 'title',
}

/**
 * Rejects a parameter the selected action does not read. Without this a caller's
 * typo (`windowAction2`, `regionWidht`) would be IGNORED silently - exactly the
 * quiet divergence this seam refuses. The typed answer names the parameter that
 * selects the action, so the caller sees WHICH sub-action rejected the key.
 */
function assertKnownParams(params: Record<string, unknown>, action: ComputerToolAction): void {
  const allowed = new Set<string>([...COMMON_KEYS, ...ACTION_KEYS[action]])
  const unknown = Object.keys(params).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new ComputerToolInputError(
      `the '${action}' action does not read ${unknown.map((key) => `'${key}'`).join(', ')} (accepted: ${[...allowed].join(', ')})`,
      ACTION_FIELD[action],
    )
  }
}

/** The failure body of a tool answer: the typed reason, never an empty list. */
function failureBody(error: unknown): Record<string, unknown> {
  if (isComputerUseError(error)) {
    return { ok: false, error: { ...error.toJSON(), hint: COMPUTER_USE_CONFIG_ROW } }
  }
  if (error instanceof ComputerToolInputError) {
    return {
      ok: false,
      error: {
        error: error.message,
        code: 'invalid-input',
        stage: 'computer-use-tools',
        reason: 'computer-use.invalid-input',
        details: { field: error.field },
        hint: COMPUTER_USE_CONFIG_ROW,
      },
    }
  }
  return {
    ok: false,
    error: {
      error: error instanceof Error ? error.message : String(error),
      code: 'invalid-input',
      stage: 'computer-use-tools',
      reason: 'computer-use.command-failed',
      details: {},
      hint: COMPUTER_USE_CONFIG_ROW,
    },
  }
}

/** The `computer-use@1` service, or a typed failure body (never a crash). */
function serviceOf(ctx: PluginContext): ComputerUseService | Record<string, unknown> {
  const service = computerUseOf(ctx as never)
  if (service === undefined || typeof service.screenshot !== 'function') {
    return {
      ok: false,
      error: {
        error:
          "no computer-use@1 provider is loaded: add a 'computer-use-impl' row (the service host) and a driver row such as 'computer-use-x11' to the plugins roster",
        code: 'missing-service',
        stage: 'lookup',
        reason: 'computer-use.missing-service',
        details: { service: 'computer-use' },
        hint: COMPUTER_USE_CONFIG_ROW,
      },
    }
  }
  return service
}

/** True when the value is the service (and not a failure body). */
function isService(value: ComputerUseService | Record<string, unknown>): value is ComputerUseService {
  return typeof (value as ComputerUseService).screenshot === 'function'
}

/** The per-call bounds the caller may override. */
function callOptions(params: Record<string, unknown>): { timeoutMs?: number; maxImageBytes?: number } {
  const timeoutMs = optionalNumber(params, 'timeoutMs', 1)
  const maxImageBytes = optionalNumber(params, 'maxImageBytes', 1)
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxImageBytes === undefined ? {} : { maxImageBytes }),
  }
}

/** `action: 'screenshot'` -> a `ScreenshotRequest`. */
function screenshotRequest(params: Record<string, unknown>): ScreenshotRequest {
  const request: ScreenshotRequest = {}
  const x = optionalNumber(params, 'regionX')
  const y = optionalNumber(params, 'regionY')
  const width = optionalNumber(params, 'regionWidth', 1)
  const height = optionalNumber(params, 'regionHeight', 1)
  if (x !== undefined || y !== undefined || width !== undefined || height !== undefined) {
    request.region = { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 }
  }
  const format = optionalEnum(params, 'format', ['png', 'jpeg'] as const)
  if (format !== undefined) request.format = format
  const quality = optionalNumber(params, 'quality', 1)
  if (quality !== undefined) request.quality = quality
  const label = optionalString(params, 'label')
  if (label !== undefined) request.label = label
  const path = optionalString(params, 'path')
  if (path !== undefined) request.path = path
  return request
}

/** `action: 'act'` -> the (method, sub-action, request) triple of the service. */
function actRequest(
  params: Record<string, unknown>,
): { method: 'mouse' | 'keyboard' | 'clipboard'; action: string; request: Record<string, unknown> } {
  const kind = optionalEnum(params, 'kind', ACT_KINDS)
  if (kind === undefined) {
    throw new ComputerToolInputError(`'action: act' needs a 'kind' (one of ${ACT_KINDS.join(' | ')})`, 'kind')
  }
  switch (kind) {
    case 'move': {
      const request: Record<string, unknown> = { x: requiredInteger(params, 'x'), y: requiredInteger(params, 'y') }
      const durationMs = optionalNumber(params, 'durationMs')
      if (durationMs !== undefined) request.durationMs = durationMs
      return { method: 'mouse', action: 'move', request }
    }
    case 'click': {
      const request: Record<string, unknown> = {}
      const x = optionalNumber(params, 'x')
      const y = optionalNumber(params, 'y')
      if (x !== undefined) request.x = x
      if (y !== undefined) request.y = y
      const button = optionalEnum(params, 'button', ['left', 'middle', 'right'] as const)
      if (button !== undefined) request.button = button
      const clicks = optionalNumber(params, 'clicks', 1)
      if (clicks !== undefined) request.clicks = clicks
      const delayMs = optionalNumber(params, 'delayMs')
      if (delayMs !== undefined) request.delayMs = delayMs
      return { method: 'mouse', action: 'click', request }
    }
    case 'drag': {
      const request: Record<string, unknown> = {
        from: { x: requiredInteger(params, 'fromX'), y: requiredInteger(params, 'fromY') },
        to: { x: requiredInteger(params, 'toX'), y: requiredInteger(params, 'toY') },
      }
      const button = optionalEnum(params, 'button', ['left', 'middle', 'right'] as const)
      if (button !== undefined) request.button = button
      const durationMs = optionalNumber(params, 'durationMs')
      if (durationMs !== undefined) request.durationMs = durationMs
      return { method: 'mouse', action: 'drag', request }
    }
    case 'scroll': {
      const request: Record<string, unknown> = {}
      const x = optionalNumber(params, 'x')
      const y = optionalNumber(params, 'y')
      if (x !== undefined) request.x = x
      if (y !== undefined) request.y = y
      const direction = optionalEnum(params, 'direction', ['up', 'down', 'left', 'right'] as const)
      if (direction !== undefined) request.direction = direction
      const amount = optionalNumber(params, 'amount', 1)
      if (amount !== undefined) request.amount = amount
      return { method: 'mouse', action: 'scroll', request }
    }
    case 'type': {
      const request: Record<string, unknown> = { text: requiredString(params, 'text') }
      const delayMs = optionalNumber(params, 'delayMs')
      if (delayMs !== undefined) request.delayMs = delayMs
      return { method: 'keyboard', action: 'type', request }
    }
    case 'key': {
      const request: Record<string, unknown> = { chord: requiredString(params, 'chord') }
      const keyAction = optionalEnum(params, 'keyAction', ['press', 'down', 'up'] as const)
      if (keyAction !== undefined) request.keyAction = keyAction
      return { method: 'keyboard', action: 'key', request }
    }
    default: {
      // copy | paste
      const request: Record<string, unknown> = {}
      const selection = optionalEnum(params, 'selection', ['clipboard', 'primary'] as const)
      if (selection !== undefined) request.selection = selection
      if (kind === 'copy') request.text = requiredString(params, 'text')
      return { method: 'clipboard', action: kind, request }
    }
  }
}

/** A required integer parameter. */
function requiredInteger(params: Record<string, unknown>, key: string): number {
  const value = optionalNumber(params, key)
  if (value === undefined) throw new ComputerToolInputError(`the '${key}' parameter is required`, key)
  return value
}

/** `action: 'window'` -> a `WindowRequest`. */
function windowRequest(params: Record<string, unknown>): WindowRequest {
  const action = optionalEnum(params, 'windowAction', WINDOW_SUBACTIONS) ?? 'list'
  const request: WindowRequest = { action }
  const title = optionalString(params, 'title')
  if (title !== undefined) request.title = title
  const id = optionalString(params, 'id')
  if (id !== undefined) request.id = id
  if (action === 'launch') request.command = requiredString(params, 'command')
  const args = optionalStringArray(params, 'args')
  if (args !== undefined) request.args = args
  const waitTitle = optionalString(params, 'waitTitle')
  if (waitTitle !== undefined) request.waitTitle = waitTitle
  const timeoutMs = optionalNumber(params, 'timeoutMs', 1)
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs
  return request
}

/** `action: 'wait'` -> a `WaitRequest` (a delay and/or a window to appear). */
function waitRequest(params: Record<string, unknown>): WaitRequest {
  const request: WaitRequest = {}
  const ms = optionalNumber(params, 'ms')
  if (ms !== undefined) request.ms = ms
  const title = optionalString(params, 'title')
  if (title !== undefined) request.title = title
  const timeoutMs = optionalNumber(params, 'timeoutMs', 1)
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs
  if (request.ms === undefined && request.title === undefined) {
    throw new ComputerToolInputError(
      "'action: wait' needs 'ms' (a bounded delay) and/or 'title' (wait for a window whose title contains it)",
      'ms',
    )
  }
  return request
}

export function apply(ctx: PluginContext): void {
  ctx.effect(() =>
    ctx.tools.registerTool({
      name: 'computer',
      description:
        'Drives a GUI desktop through the configured computer-use@1 driver: `action: providers` lists the drivers and the selection, ' +
        '`open` returns the CAPABILITY REPORT (display reachable, which tool binaries are present, which actions are usable), ' +
        '`screen` the geometry, `screenshot` writes a PNG/JPEG file and answers its path + mime + bytes (full screen or `regionX/Y/Width/Height`), ' +
        '`act` drives the POINTER (`kind: move|click|drag|scroll`), the KEYBOARD (`kind: type|key` with `text`/`chord`) and the CLIPBOARD (`kind: copy|paste`), ' +
        '`window` lists/focuses/launches/closes a window (`windowAction`, `title`, `id`, `command`), `wait` sleeps and/or waits for a window title, ' +
        "`close` closes one window by title or id. An unavailable action FAILS WITH A TYPED ERROR naming exactly what is missing " +
        '(`computer-use.no-display`, `.missing-tool`, `.not-implemented`, `.timeout`, ...) - never a silent no-op and never a fabricated result. ' +
        'Pass `provider` to force one driver.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          description: `the operation: ${ACTIONS.join(' | ')}`,
        },
        provider: { type: 'string', description: 'force ONE driver id (default: the configured driver + fallback chain)' },
        kind: { type: 'string', description: `'action: act' only: ${ACT_KINDS.join(' | ')}` },
        // pointer
        x: { type: 'integer', description: "the pointer X ('move'/'click'/'scroll'; screen pixels from the top-left)" },
        y: { type: 'integer', description: "the pointer Y ('move'/'click'/'scroll')" },
        fromX: { type: 'integer', description: "'act: drag' only: the X the drag starts at" },
        fromY: { type: 'integer', description: "'act: drag' only: the Y the drag starts at" },
        toX: { type: 'integer', description: "'act: drag' only: the X the drag ends at" },
        toY: { type: 'integer', description: "'act: drag' only: the Y the drag ends at" },
        button: { type: 'string', description: "'click'/'drag': left | middle | right (default left)" },
        clicks: { type: 'integer', description: "'click': 1 single, 2 double, 3 triple (default 1)" },
        direction: { type: 'string', description: "'scroll': up | down | left | right (default down)" },
        amount: { type: 'integer', description: "'scroll': how many wheel steps (default 3)" },
        durationMs: { type: 'integer', description: "'move'/'drag': the movement duration in ms (0 = teleport)" },
        delayMs: { type: 'integer', description: "'click'/'type': the delay between repeated clicks / keystrokes in ms" },
        // keyboard + clipboard
        text: { type: 'string', description: "'type': the literal text; 'act: copy': the text to put on the clipboard" },
        chord: { type: 'string', description: "'act: key': one keysym or a `+`-joined chord, e.g. Return, ctrl+shift+t, alt+F4" },
        keyAction: { type: 'string', description: "'act: key': press | down | up (default press)" },
        selection: { type: 'string', description: "'act: copy|paste': clipboard | primary (default clipboard)" },
        // screenshot
        format: { type: 'string', description: "'screenshot': png (default) | jpeg" },
        quality: { type: 'integer', description: "'screenshot': jpeg quality 1..100 (ignored for png)" },
        label: { type: 'string', description: "'screenshot': a short label used in the file name" },
        path: { type: 'string', description: "'screenshot': write the file HERE instead of the driver's screenshot directory" },
        regionX: { type: 'integer', description: "'screenshot': capture only the rectangle starting at this X" },
        regionY: { type: 'integer', description: "'screenshot': capture only the rectangle starting at this Y" },
        regionWidth: { type: 'integer', description: "'screenshot': the width of the captured rectangle" },
        regionHeight: { type: 'integer', description: "'screenshot': the height of the captured rectangle" },
        // windows
        windowAction: {
          type: 'string',
          description: `'action: window' only: ${WINDOW_SUBACTIONS.join(' | ')} (default list)`,
        },
        title: { type: 'string', description: 'match a window by title (substring, case-insensitive)' },
        id: { type: 'string', description: 'match a window by id (exact, as the driver prints it, e.g. 0x0040000c)' },
        command: { type: 'string', description: "'windowAction: launch': the binary to run on the target, e.g. xterm" },
        args: { type: 'array', description: "'windowAction: launch': the arguments of that binary" },
        waitTitle: { type: 'string', description: "'launch'/'wait': wait for a window whose title contains this" },
        ms: { type: 'integer', description: "'wait': sleep this long (bounded by timeoutMs)" },
        timeoutMs: { type: 'integer', description: 'the bound of the call in ms (also the bound of a launch/window wait)' },
        maxImageBytes: { type: 'integer', description: "'screenshot': the byte cap of the written file (default from the config)" },
      },
      handler: async (params) => {
        const service = serviceOf(ctx)
        if (!isService(service)) return service
        // EVERYTHING runs inside the try: a parameter violation is a TYPED answer,
        // not a throw (the tools provider turns a throw into a generic
        // `tool-failed` body and the reason would be lost).
        try {
          const action = actionOf(params)
          assertKnownParams(params, action)
          const provider = optionalString(params, 'provider')
          switch (action) {
            case 'providers':
              return { ok: true, selection: service.selection(), providers: service.providers(), hint: COMPUTER_USE_CONFIG_ROW }
            case 'open': {
              const report = await service.capabilities(provider)
              return { ok: true, ...report }
            }
            case 'screen':
              return { ok: true, ...(await service.screenInfo(provider)) }
            case 'screenshot': {
              const answer = await service.screenshot(screenshotRequest(params), provider)
              return { ok: true, ...answer }
            }
            case 'act': {
              const act = actRequest(params)
              if (act.method === 'clipboard') {
                return { ok: true, ...(await service.clipboard(act.request as ClipboardRequest, provider)) }
              }
              const answer =
                act.method === 'mouse'
                  ? await service.mouse(act.action as 'move' | 'click' | 'drag' | 'scroll', act.request, provider)
                  : await service.keyboard(act.action as 'type' | 'key', act.request, provider)
              return { ok: true, ...answer }
            }
            case 'window':
              return { ok: true, ...(await service.windows(windowRequest(params), provider)) }
            case 'wait':
              return { ok: true, ...(await service.wait(waitRequest(params), provider)) }
            default: {
              // close
              const title = optionalString(params, 'title')
              const id = optionalString(params, 'id')
              if (title === undefined && id === undefined) {
                throw new ComputerToolInputError("'action: close' needs a 'title' or an 'id'", 'title')
              }
              return { ok: true, ...(await service.close({ action: 'close', ...(title === undefined ? {} : { title }), ...(id === undefined ? {} : { id }) }, provider)) }
            }
          }
        } catch (error) {
          return failureBody(error)
        }
      },
    }),
  )
}

export default { name, inject: ['tools'], apply }
