// core/computer-use-impl - the `computer-use@1` SERVICE HOST (provider `registry`).
//
// It owns the SEAM of the computer-use capability and nothing desktop-specific:
//
//   Provider plugins (THIS plugin)  ->  Definition  <-  Consumer
//   registry/host                         definitions/computer-use.ts   plugins/computer-use-tools
//        ^
//        | registers itself (ctx['computer-use'].register)
//   DRIVER plugins: core/computer-use-x11, a future vnc/wayland driver, ...
//
// What lives here (and nowhere else, so every driver plugin stays small):
//   * the PROVIDER REGISTRY: one entry per registered driver, duplicate ids
//     rejected (`computer-use.duplicate-provider`);
//   * the SELECTION policy (the DSH `packages/computer-use/computer-use` model:
//     "a deployment enables one computer-use provider at a time", MIT): an
//     explicit provider id wins; else the configured default, then the ordered
//     fallback chain; with NOTHING configured exactly one USABLE provider is
//     taken and several usable ones are an `ambiguous` error - selection is
//     decided at CALL time, never at load time, so it cannot depend on plugin
//     order;
//   * the SEAM BOUNDS: the screenshot byte cap (the answer is a FILE PATH, never
//     unbounded base64), the call deadline and the clipboard inline cap. The
//     seam, not the driver, owns them, so a driver cannot widen what reaches a
//     caller: an oversized image is a typed `computer-use.oversized` error naming
//     the real size and the cap, never a silent drop;
//   * the TYPED DELEGATION: a driver that does not implement an action is a
//     `computer-use.not-implemented` error naming the exact half (`mouse.drag`),
//     never a silent no-op and never a fabricated answer (requirement 3);
//   * the SANDBOX extension point (requirement 5): when the deployment loads a
//     `sandbox@1` provider, every desktop call is checked FIRST and a DENY
//     becomes `computer-use.sandbox-denied`. No sandbox provider = no change.
//
// No driver module is imported: a driver plugin only has to export the object
// `definitions/computer-use.ts` describes, and `npm run check:seam` enforces that
// direction. Desktops are the driver's business, so the manifest declares
// `"execution": "none"`.

import type { LoggerServiceLike } from '../../definitions/logger.ts'
import { assertPolicyDeclared, isRecord, provideService, str, type ServiceContext } from '../../definitions/support.ts'
import {
  CLIPBOARD_SELECTIONS,
  COMPUTER_USE,
  COMPUTER_USE_CONFIG_ROW,
  COMPUTER_USE_CONTRACT,
  ComputerUseError,
  computerUseSandbox,
  mimeOfFormat,
  MOUSE_BUTTONS,
  normalizeChord,
  normalizePointer,
  normalizeRegion,
  notImplemented,
  resolveComputerUseBounds,
  resolveScreenshotFormat,
  SCROLL_DIRECTIONS,
  WINDOW_ACTIONS,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireText,
} from '../../definitions/computer-use.ts'
import type {
  ClipboardAnswer,
  ClipboardRequest,
  ComputerUseCallOptions,
  ComputerUseCapabilityReport,
  ComputerUseConfig,
  ComputerUseProvider,
  ComputerUseProviderInfo,
  ComputerUseSelection,
  ComputerUseService,
  InputAnswer,
  KeyboardKeyRequest,
  KeyboardTypeRequest,
  LaunchRequest,
  MouseClickRequest,
  MouseDragRequest,
  MouseMoveRequest,
  MouseScrollRequest,
  ScreenshotAnswer,
  ScreenshotRequest,
  ScreenInfo,
  WaitRequest,
  WindowAction,
  WindowAnswer,
  WindowRequest,
} from '../../definitions/computer-use.ts'

export const name = 'computer-use-impl'

/** The provider id this host registers under (a service host, not a driver). */
export const providerId = 'registry'

/** The bounds and the selection policy of the host, once normalized. */
export interface NormalizedComputerUseConfig {
  provider?: string
  fallback: string[]
  screenshotDir?: string
  maxImageBytes: number
  timeoutMs: number
  maxTextChars: number
}

/** Reads + bounds the config (a bad value falls back, it never throws at load). */
export function validateComputerUseConfig(config: ComputerUseConfig = {}): NormalizedComputerUseConfig {
  const provider = str(config.provider)
  const fallback = Array.isArray(config.fallback)
    ? config.fallback.map((value) => str(value)).filter((value): value is string => value !== undefined)
    : []
  const screenshotDir = str(config.screenshotDir)
  return {
    ...(provider === undefined ? {} : { provider }),
    fallback,
    ...(screenshotDir === undefined ? {} : { screenshotDir }),
    ...resolveComputerUseBounds(config),
  }
}

/** True when a registered driver says it can run. */
function isAvailable(provider: ComputerUseProvider): boolean {
  try {
    return provider.available() !== false
  } catch {
    // A driver whose availability probe throws is NOT usable: reporting it as
    // usable would turn a broken driver into a confusing call-time failure.
    return false
  }
}

/** Why a registered driver cannot run, without trusting a thrown message. */
function reasonOf(provider: ComputerUseProvider): string | undefined {
  try {
    return str(provider.unavailableReason?.())
  } catch {
    return 'the driver availability probe threw'
  }
}

/**
 * Calls a driver method that may be ABSENT: an absent half is the typed
 * `computer-use.not-implemented` (naming the method), never a silent success, and
 * anything else the driver throws is wrapped without losing its type.
 */
async function invoke<T>(driver: ComputerUseProvider, method: string, what: string, args: unknown[]): Promise<T> {
  const fn = (driver as unknown as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw notImplemented(what, { provider: driver.id, missing: method })
  try {
    return (await (fn as (...values: unknown[]) => T | Promise<T>).apply(driver, args)) as T
  } catch (error) {
    if (error instanceof ComputerUseError) throw error
    throw new ComputerUseError(
      'computer-use.command-failed',
      `the computer-use driver '${driver.id}' failed the '${what}' call: ${error instanceof Error ? error.message : String(error)}`,
      { stage: 'provider', details: { provider: driver.id, action: what } },
    )
  }
}

/** The `ctx` a host needs. */
interface PluginContext extends ServiceContext {
  effect?(callback: () => () => void): unknown
  logger?: LoggerServiceLike
}

/**
 * Builds the `computer-use@1` service. Exported separately from `apply` on
 * purpose: the tests drive the SEAM (registry, selection, caps, typed errors)
 * with a FAKE driver and no cordis context at all.
 */
export function createComputerUseService(
  ctx: ServiceContext,
  config: ComputerUseConfig = {},
  logger?: { warn?: (message: string) => void },
): ComputerUseService {
  const bounds = validateComputerUseConfig(config)
  const registry = new Map<string, ComputerUseProvider>()
  let lastSelected: string | undefined

  /** The driver an action must go to, or a typed error explaining why none can. */
  const select = (requested?: string): ComputerUseProvider => {
    const named = str(requested)
    if (named !== undefined) {
      const driver = registry.get(named)
      if (driver === undefined) {
        throw new ComputerUseError(
          'computer-use.unknown-provider',
          `no computer-use driver is registered under the id '${named}' (registered: ${[...registry.keys()].join(', ') || 'none'})`,
          {
            stage: 'selection',
            details: { requested: named, registered: [...registry.keys()], configRow: COMPUTER_USE_CONFIG_ROW },
          },
        )
      }
      if (!isAvailable(driver)) {
        throw new ComputerUseError(
          'computer-use.provider-unavailable',
          `the computer-use driver '${named}' is not available: ${reasonOf(driver) ?? 'no reason reported'}`,
          { stage: 'selection', details: { provider: named, reason: reasonOf(driver), configRow: COMPUTER_USE_CONFIG_ROW } },
        )
      }
      lastSelected = named
      return driver
    }
    // The PREFERENCE LIST: the configured provider first, then the fallback chain
    // (a preference even when the config names no provider at all).
    const preferred: string[] = [
      ...(bounds.provider === undefined ? [] : [bounds.provider]),
      ...bounds.fallback,
    ]
    for (const [index, id] of preferred.entries()) {
      const candidate = registry.get(id)
      if (candidate === undefined || !isAvailable(candidate)) continue
      if (index === 0) lastSelected = id
      else {
        logger?.warn?.(
          `computer-use-impl: provider '${preferred[0]!}' is not usable; falling back to '${id}' (config ${COMPUTER_USE_CONFIG_ROW})`,
        )
        lastSelected = id
      }
      return candidate
    }
    if (preferred.length > 0) {
      // A preference was NAMED and IS registered, but unusable: report the driver
      // and ITS OWN reason, never a generic "no provider".
      const blocked = preferred.find((id) => registry.has(id))
      if (blocked !== undefined) {
        const driver = registry.get(blocked)!
        throw new ComputerUseError(
          'computer-use.provider-unavailable',
          `the computer-use provider '${blocked}' is not available: ${reasonOf(driver) ?? 'no reason reported'}`,
          {
            stage: 'selection',
            details: {
              provider: blocked,
              reason: reasonOf(driver),
              preferred,
              registered: [...registry.keys()],
              configRow: COMPUTER_USE_CONFIG_ROW,
            },
          },
        )
      }
    }
    if (bounds.provider !== undefined) {
      throw new ComputerUseError(
        'computer-use.no-provider',
        `the configured computer-use provider '${bounds.provider}' is not registered and no fallback provider is registered (fallback: ${bounds.fallback.join(', ') || 'none'})`,
        {
          stage: 'selection',
          details: {
            provider: bounds.provider,
            fallback: bounds.fallback,
            registered: [...registry.keys()],
            configRow: COMPUTER_USE_CONFIG_ROW,
          },
        },
      )
    }
    const usable = [...registry.values()].filter(isAvailable)
    if (usable.length === 1) {
      lastSelected = usable[0]!.id
      return usable[0]!
    }
    if (usable.length === 0) {
      throw new ComputerUseError(
        'computer-use.no-provider',
        registry.size === 0
          ? 'no computer-use driver is registered at all: add a provider plugin (e.g. computer-use-x11) to the plugins roster'
          : `none of the registered computer-use drivers is available (${[...registry.values()]
              .map((driver) => `${driver.id}: ${reasonOf(driver) ?? 'unavailable'}`)
              .join('; ')})`,
        { stage: 'selection', details: { registered: [...registry.keys()], configRow: COMPUTER_USE_CONFIG_ROW } },
      )
    }
    throw new ComputerUseError(
      'computer-use.ambiguous',
      `several computer-use drivers are usable (${usable.map((driver) => driver.id).join(', ')}) and the config names none: set one explicitly`,
      { stage: 'selection', details: { usable: usable.map((driver) => driver.id), configRow: COMPUTER_USE_CONFIG_ROW } },
    )
  }

  /** The call options the seam hands a driver (the seam owns the bounds). */
  const callOptions = (extra: ComputerUseCallOptions = {}): ComputerUseCallOptions => ({
    timeoutMs: bounds.timeoutMs,
    maxImageBytes: bounds.maxImageBytes,
    maxTextChars: bounds.maxTextChars,
    ...(bounds.screenshotDir === undefined ? {} : { screenshotDir: bounds.screenshotDir }),
    ...extra,
  })

  /**
   * The sandbox gate (extension point, requirement 5): a `sandbox@1` provider is
   * asked BEFORE a desktop call. A DENY - or a sandbox that cannot answer at all -
   * is a typed refusal, never a silently allowed call.
   */
  const guard = async (what: string, argv?: readonly string[]): Promise<void> => {
    const sandbox = computerUseSandbox(ctx)
    if (sandbox === undefined) return
    let decision: unknown
    try {
      decision = await sandbox.check({ resource: COMPUTER_USE, ...(argv === undefined ? {} : { command: { argv } }) })
    } catch (error) {
      throw new ComputerUseError(
        'computer-use.sandbox-denied',
        `the sandbox@1 provider could not decide the '${what}' call, which fails closed: ${error instanceof Error ? error.message : String(error)}`,
        { stage: 'sandbox', details: { action: what, cause: error instanceof Error ? error.message : String(error) } },
      )
    }
    if (isRecord(decision) && decision.allowed === false) {
      throw new ComputerUseError(
        'computer-use.sandbox-denied',
        `the sandbox@1 policy refused the '${what}' call: ${str(decision.reason) ?? 'no reason reported'}`,
        { stage: 'sandbox', details: { action: what, decision } },
      )
    }
  }

  /** Closes ONE window by title/id (shared by `windows` and `close`). */
  const closeWindow = async (driver: ComputerUseProvider, request: WindowRequest): Promise<WindowAnswer> => {
    const query: WindowRequest = { action: 'close' }
    if (request.title !== undefined) query.title = requireText(request.title, 'title', 512)
    if (request.id !== undefined) query.id = requireText(request.id, 'id', 64)
    if (query.title === undefined && query.id === undefined) {
      throw new ComputerUseError('computer-use.invalid-input', "'windowAction: close' needs a title or an id", {
        stage: 'request',
        details: { field: 'windowAction', action: 'close' },
      })
    }
    await guard('window.close', ['wmctrl', '-c'])
    return invoke<WindowAnswer>(driver, 'windows', 'window.close', [query, callOptions()])
  }

  const service: ComputerUseService = {
    contract: COMPUTER_USE_CONTRACT,

    get providerId(): string {
      return lastSelected ?? ''
    },

    register(provider: ComputerUseProvider): () => void {
      const id = str(provider?.id)
      if (id === undefined) {
        throw new ComputerUseError('computer-use.invalid-input', 'a computer-use provider must declare a non-empty id', {
          stage: 'register',
        })
      }
      if (registry.has(id)) {
        throw new ComputerUseError(
          'computer-use.duplicate-provider',
          `a computer-use driver is already registered under the id '${id}': a deployment loads ONE driver per id`,
          { stage: 'register', details: { provider: id } },
        )
      }
      registry.set(id, provider)
      return () => {
        if (registry.get(id) === provider) registry.delete(id)
      }
    },

    providers(): ComputerUseProviderInfo[] {
      return [...registry.values()].map((driver) => {
        const available = isAvailable(driver)
        const reason = available ? undefined : reasonOf(driver)
        return {
          id: driver.id,
          configured: bounds.provider === driver.id,
          available,
          runner: driver.runner,
          target: driver.target,
          ...(driver.display === undefined ? {} : { display: driver.display }),
          ...(reason === undefined ? {} : { reason }),
        }
      })
    },

    selection(): ComputerUseSelection {
      const info: ComputerUseSelection = { fallback: [...bounds.fallback], configRow: COMPUTER_USE_CONFIG_ROW }
      if (bounds.provider !== undefined) info.provider = bounds.provider
      try {
        info.selected = select().id
      } catch (error) {
        if (error instanceof ComputerUseError) info.reason = error.message
        else throw error
      }
      return info
    },

    async capabilities(provider?: string): Promise<ComputerUseCapabilityReport> {
      const driver = select(provider)
      await guard('capabilities')
      const report = await invoke<ComputerUseCapabilityReport>(driver, 'capabilities', 'capabilities', [])
      if (!isRecord(report) || !isRecord(report.actions)) {
        throw new ComputerUseError('computer-use.malformed-output', `the provider '${driver.id}' answered no capability report`, {
          stage: 'provider',
          details: { provider: driver.id },
        })
      }
      // The seam STAMPS the identity: a driver cannot claim to be another one.
      const notes = new Set<string>([...(report.notes ?? []), ...(driver.notes?.() ?? [])])
      return {
        ...report,
        provider: driver.id,
        runner: driver.runner,
        target: driver.target,
        ...(driver.display === undefined ? {} : { display: driver.display }),
        notes: [...notes],
      }
    },

    async screenInfo(provider?: string): Promise<ScreenInfo> {
      const driver = select(provider)
      await guard('screen-info')
      const info = await invoke<ScreenInfo>(driver, 'screenInfo', 'screen-info', [callOptions()])
      if (!isRecord(info) || typeof info.width !== 'number' || typeof info.height !== 'number') {
        throw new ComputerUseError(
          'computer-use.malformed-output',
          `the provider '${driver.id}' answered no usable screen geometry`,
          { stage: 'provider', details: { provider: driver.id, answer: info } },
        )
      }
      return {
        ...info,
        provider: driver.id,
        runner: driver.runner,
        target: driver.target,
        ...(driver.display === undefined ? {} : { display: driver.display }),
      }
    },

    async screenshot(request: ScreenshotRequest, provider?: string): Promise<ScreenshotAnswer> {
      const driver = select(provider)
      await guard('screenshot', ['screenshot'])
      const format = resolveScreenshotFormat(request.format)
      const normalized: ScreenshotRequest = { format }
      const region = normalizeRegion(request.region)
      if (region !== undefined) normalized.region = region
      if (request.quality !== undefined) normalized.quality = requirePositiveInt(request.quality, 'quality', 100)
      if (request.label !== undefined) normalized.label = requireText(request.label, 'label', 120)
      if (request.path !== undefined) normalized.path = requireText(request.path, 'path', 4096)
      const answer = await invoke<ScreenshotAnswer>(driver, 'screenshot', 'screenshot', [normalized, callOptions()])
      if (!isRecord(answer) || str(answer.path) === undefined) {
        throw new ComputerUseError(
          'computer-use.malformed-output',
          `the provider '${driver.id}' did not answer a screenshot file path (a screenshot is always a FILE, never inline base64)`,
          { stage: 'provider', details: { provider: driver.id } },
        )
      }
      const bytes = typeof answer.bytes === 'number' && answer.bytes >= 0 ? answer.bytes : 0
      if (bytes > bounds.maxImageBytes) {
        throw new ComputerUseError(
          'computer-use.oversized',
          `the screenshot is ${bytes} bytes, above the seam cap of ${bounds.maxImageBytes} bytes: capture a region or lower 'quality', or raise plugins.computer-use-impl.maxImageBytes`,
          { stage: 'seam', details: { provider: driver.id, path: answer.path, bytes, maxBytes: bounds.maxImageBytes } },
        )
      }
      const usedFormat = resolveScreenshotFormat(answer.format ?? format)
      return {
        ...answer,
        format: usedFormat,
        mime: str(answer.mime) ?? mimeOfFormat(usedFormat),
        bytes,
        truncated: bytes >= bounds.maxImageBytes,
        provider: driver.id,
        ...(driver.display === undefined ? {} : { display: driver.display }),
      }
    },

    async mouse(
      action: 'move' | 'click' | 'drag' | 'scroll',
      request: Record<string, unknown>,
      provider?: string,
    ): Promise<InputAnswer> {
      const driver = select(provider)
      if (action === 'move') {
        const input: MouseMoveRequest = {
          x: requireNonNegativeInt(request.x, 'x'),
          y: requireNonNegativeInt(request.y, 'y'),
        }
        if (request.durationMs !== undefined) {
          input.durationMs = requireNonNegativeInt(request.durationMs, 'durationMs', 60_000)
        }
        await guard('mouse.move', ['xdotool', 'mousemove'])
        return invoke<InputAnswer>(driver, 'mouseMove', 'mouse.move', [input, callOptions()])
      }
      if (action === 'click') {
        const input: MouseClickRequest = {}
        if (request.x !== undefined) input.x = requireNonNegativeInt(request.x, 'x')
        if (request.y !== undefined) input.y = requireNonNegativeInt(request.y, 'y')
        input.button = requireEnum(request.button, MOUSE_BUTTONS, 'button', 'left')
        if (request.clicks !== undefined) input.clicks = requirePositiveInt(request.clicks, 'clicks', 5)
        if (request.delayMs !== undefined) input.delayMs = requireNonNegativeInt(request.delayMs, 'delayMs', 10_000)
        await guard('mouse.click', ['xdotool', 'click'])
        return invoke<InputAnswer>(driver, 'mouseClick', 'mouse.click', [input, callOptions()])
      }
      if (action === 'drag') {
        const input: MouseDragRequest = {
          from: normalizePointer(request.from, 'from'),
          to: normalizePointer(request.to, 'to'),
        }
        input.button = requireEnum(request.button, MOUSE_BUTTONS, 'button', 'left')
        if (request.durationMs !== undefined) {
          input.durationMs = requireNonNegativeInt(request.durationMs, 'durationMs', 60_000)
        }
        await guard('mouse.drag', ['xdotool', 'mousedown'])
        return invoke<InputAnswer>(driver, 'mouseDrag', 'mouse.drag', [input, callOptions()])
      }
      const input: MouseScrollRequest = {}
      if (request.x !== undefined) input.x = requireNonNegativeInt(request.x, 'x')
      if (request.y !== undefined) input.y = requireNonNegativeInt(request.y, 'y')
      input.direction = requireEnum(request.direction, SCROLL_DIRECTIONS, 'direction', 'down')
      if (request.amount !== undefined) input.amount = requirePositiveInt(request.amount, 'amount', 100)
      await guard('mouse.scroll', ['xdotool', 'click'])
      return invoke<InputAnswer>(driver, 'mouseScroll', 'mouse.scroll', [input, callOptions()])
    },

    async keyboard(
      action: 'type' | 'key',
      request: Record<string, unknown>,
      provider?: string,
    ): Promise<InputAnswer> {
      const driver = select(provider)
      if (action === 'type') {
        const input: KeyboardTypeRequest = { text: requireText(request.text, 'text') }
        if (request.delayMs !== undefined) input.delayMs = requireNonNegativeInt(request.delayMs, 'delayMs', 10_000)
        await guard('keyboard.type', ['xdotool', 'type'])
        return invoke<InputAnswer>(driver, 'typeText', 'keyboard.type', [input, callOptions()])
      }
      const input: KeyboardKeyRequest = { chord: normalizeChord(request.chord) }
      input.action = requireEnum(request.keyAction, ['press', 'down', 'up'] as const, 'keyAction', 'press')
      await guard('keyboard.key', ['xdotool', 'key'])
      return invoke<InputAnswer>(driver, 'pressKey', 'keyboard.key', [input, callOptions()])
    },

    async clipboard(request: ClipboardRequest, provider?: string): Promise<ClipboardAnswer> {
      const driver = select(provider)
      const input: ClipboardRequest = {
        selection: requireEnum(request.selection, CLIPBOARD_SELECTIONS, 'selection', 'clipboard'),
      }
      if (request.text !== undefined) input.text = requireText(request.text, 'text', 200_000)
      await guard(input.text === undefined ? 'clipboard.read' : 'clipboard.write', ['xclip'])
      const answer = await invoke<ClipboardAnswer>(driver, 'clipboard', 'clipboard', [input, callOptions()])
      const text = typeof answer?.text === 'string' ? answer.text : ''
      const max = bounds.maxTextChars
      return {
        selection: input.selection ?? 'clipboard',
        text: text.length > max ? text.slice(0, max) : text,
        bytes: Buffer.byteLength(text, 'utf8'),
        truncated: text.length > max,
        action: input.text === undefined ? 'clipboard.read' : 'clipboard.write',
      }
    },

    async windows(request: WindowRequest, provider?: string): Promise<WindowAnswer> {
      const driver = select(provider)
      const action = requireEnum(request.action, WINDOW_ACTIONS, 'windowAction', 'list') as WindowAction
      if (action === 'close') return closeWindow(driver, request)
      if (action === 'launch') {
        const launch: LaunchRequest = { command: requireText(request.command, 'command') }
        if (Array.isArray(request.args)) launch.args = request.args.map((value) => requireText(value, 'args[]', 4096))
        if (request.waitTitle !== undefined) launch.waitTitle = requireText(request.waitTitle, 'waitTitle', 512)
        if (request.timeoutMs !== undefined) launch.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 120_000)
        await guard('window.launch', [launch.command, ...(launch.args ?? [])])
        return invoke<WindowAnswer>(driver, 'launch', 'window.launch', [launch, callOptions()])
      }
      if (action === 'wait') {
        // `windowAction: 'wait'` carries the `WaitRequest` fields on top of the
        // window query (the contract keeps ONE window request shape).
        const raw = request as WindowRequest & WaitRequest
        const wait: WaitRequest = {}
        if (raw.ms !== undefined) wait.ms = requireNonNegativeInt(raw.ms, 'ms', 120_000)
        if (request.title !== undefined) wait.title = requireText(request.title, 'title', 512)
        if (request.timeoutMs !== undefined) wait.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 120_000)
        await guard('window.wait', ['wmctrl', '-l'])
        return invoke<WindowAnswer>(driver, 'wait', 'window.wait', [wait, callOptions()])
      }
      const query: WindowRequest = { action }
      if (request.title !== undefined) query.title = requireText(request.title, 'title', 512)
      if (request.id !== undefined) query.id = requireText(request.id, 'id', 64)
      if (action === 'focus' && query.title === undefined && query.id === undefined) {
        throw new ComputerUseError('computer-use.invalid-input', "'windowAction: focus' needs a title or an id to focus", {
          stage: 'request',
          details: { field: 'windowAction', action },
        })
      }
      await guard(`window.${action}`, ['wmctrl', '-l'])
      return invoke<WindowAnswer>(driver, 'windows', `window.${action}`, [query, callOptions()])
    },

    async wait(request: WaitRequest, provider?: string): Promise<WindowAnswer> {
      const driver = select(provider)
      const input: WaitRequest = {}
      if (request.ms !== undefined) input.ms = requireNonNegativeInt(request.ms, 'ms', 120_000)
      if (request.title !== undefined) input.title = requireText(request.title, 'title', 512)
      if (request.timeoutMs !== undefined) input.timeoutMs = requirePositiveInt(request.timeoutMs, 'timeoutMs', 120_000)
      if (input.ms === undefined && input.title === undefined) {
        throw new ComputerUseError(
          'computer-use.invalid-input',
          "'wait' needs 'ms' (a delay) or 'title' (a window to appear)",
          { stage: 'request', details: { field: 'wait' } },
        )
      }
      await guard('wait')
      return invoke<WindowAnswer>(driver, 'wait', 'wait', [input, callOptions()])
    },

    async close(request: WindowRequest, provider?: string): Promise<WindowAnswer> {
      const driver = select(provider)
      if (request.title !== undefined || request.id !== undefined) return closeWindow(driver, request)
      // No window named: close the SESSION (a managed display), which is the
      // disposer the provider registered. A driver without `stop` is an explicit
      // `not-implemented`, never a fake "closed".
      await guard('close')
      await invoke<void>(driver, 'stop', 'close (the session target)', [])
      return { action: 'close', windows: [], detail: `closed the managed session of provider '${driver.id}'` }
    },
  }

  return service
}

/** Registers the `computer-use@1` service on the host context. */
export function apply(ctx: PluginContext, config: ComputerUseConfig = {}): void {
  // The plugin only provides the seam (no desktop, no process of its own), so its
  // manifest must declare `execution: none` and the policy of the capability.
  assertPolicyDeclared(import.meta.url, { execution: 'none', capabilities: [COMPUTER_USE] })
  const logger = {
    warn: (message: string): void => {
      // `LoggerServiceLike` is the cordis logger FACTORY whose handle carries
      // `warn`; the sink is optional, so a deployment without a logger still loads
      // the seam (the warn is simply dropped).
      const sink = (ctx.logger as { warn?: (message: string, ...args: unknown[]) => void } | undefined)?.warn
      if (typeof sink === 'function') sink.call(ctx.logger, message, 'computer-use-impl')
    },
  }
  const service = createComputerUseService(ctx, config, logger)
  provideService(ctx, COMPUTER_USE, service)
}

export default { name, inject: [], apply }
