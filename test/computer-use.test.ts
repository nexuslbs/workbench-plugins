// Unit tests for the `computer-use@1` seam: the PURE contract helpers and the
// three plugin families of the capability
//   * definitions/computer-use.ts   - the contract (errors, vocabulary, helpers)
//   * core/computer-use-impl        - the service host (registry + selection +
//                                     caps + the typed-error mapping)
//   * core/computer-use-x11         - the X11 driver (config validation + the
//                                     LIVE smoke, which SKIPS with a reason when
//                                     the host has no X11 toolchain)
//   * plugins/computer-use-tools    - the consumer tool against a fake `tools`
//                                     service and a fake capability
//
// NOTHING here touches a real display except the last test, and that one SKIPS
// (with the missing binaries named) instead of pretending to have run. No test
// ever reports a fake success: every unavailable action is asserted to answer a
// TYPED error.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  COMPUTER_USE,
  COMPUTER_USE_CONFIG_ROW,
  COMPUTER_USE_CONTRACT,
  ComputerUseError,
  extensionOfFormat,
  isComputerUseError,
  mimeOfFormat,
  normalizeChord,
  normalizePointer,
  normalizeRegion,
  notImplemented,
  requireEnum,
  requirePositiveInt,
  requireText,
  resolveScreenshotFormat,
  slugOf,
} from '../definitions/computer-use.ts'
import type {
  ComputerUseCapabilityReport,
  ComputerUseProvider,
  ComputerUseService,
  DisplayTarget,
  RunnerKind,
  ScreenshotRequest,
} from '../definitions/computer-use.ts'
import { createComputerUseService, validateComputerUseConfig } from '../core/computer-use-impl/index.ts'
import { X11_TOOLS, X11Provider, createX11Provider, spawnExec, validateX11Config } from '../core/computer-use-x11/index.ts'
import type { ExecRequest, ExecResult, X11Runner } from '../core/computer-use-x11/index.ts'
import * as computerTools from '../plugins/computer-use-tools/index.ts'
import type { ToolDefinition } from '../definitions/tools.ts'
import { ToolArgsError } from '../definitions/tools.ts'

// ---------------------------------------------------------------------------
// Harness: a fake `tools` service plus a structural cordis context.
// ---------------------------------------------------------------------------

type ToolDef = ToolDefinition

function harness(services: Record<string, unknown> = {}): {
  ctx: never
  tools: Map<string, ToolDef>
  unload: () => void
} {
  const tools = new Map<string, ToolDef>()
  const disposers: Array<() => void> = []
  const ctx: Record<string, unknown> = {
    ...services,
    get: (name: string) => services[name],
    tools: {
      register: (def: ToolDefinition): (() => void) => {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    effect: (callback: () => () => void): void => {
      disposers.push(callback())
    },
  }
  return { ctx: ctx as never, tools, unload: () => disposers.splice(0).forEach((dispose) => dispose()) }
}

/** The typed reason of a thrown call, or a loud failure when it is not typed. */
async function reasonOf(call: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await call()
  } catch (error) {
    assert.ok(isComputerUseError(error), `expected a typed computer-use error, got ${String(error)}`)
    return (error as ComputerUseError).reason
  }
  assert.fail('the call was expected to fail, but it answered')
}

// ---------------------------------------------------------------------------
// A FAKE driver: every half can be left out, so the seam's "absent half is a
// typed not-implemented" rule is provable without a display.
// ---------------------------------------------------------------------------

interface FakeDriverOptions {
  id?: string
  available?: boolean
  reason?: string
  runner?: RunnerKind
  target?: DisplayTarget
  display?: string
  screen?: { width: number; height: number; depth?: number }
  screenshot?: { path: string; bytes: number; format?: 'png' | 'jpeg'; mime?: string }
  withInput?: boolean
  withWindows?: boolean
}

function fakeDriver(options: FakeDriverOptions = {}): { driver: ComputerUseProvider; calls: string[] } {
  const calls: string[] = []
  const driver: ComputerUseProvider = {
    id: options.id ?? 'fake',
    runner: options.runner ?? 'local',
    target: options.target ?? 'existing',
    display: options.display ?? ':0',
    available: () => options.available ?? true,
    unavailableReason: () => options.reason,
    capabilities: () => {
      calls.push('capabilities')
      return {
        provider: 'fake',
        runner: driver.runner,
        target: driver.target,
        display: driver.display,
        reachable: true,
        actions: { screen: true, screenshot: true, mouse: options.withInput ?? true, keyboard: options.withInput ?? true },
        tools: [],
        notes: [],
      } as unknown as ComputerUseCapabilityReport
    },
    screenInfo: () => {
      calls.push('screenInfo')
      return {
        display: driver.display,
        width: options.screen?.width ?? 1024,
        height: options.screen?.height ?? 768,
        depth: options.screen?.depth ?? 24,
        provider: 'fake',
      }
    },
    screenshot: () => {
      calls.push('screenshot')
      const image = options.screenshot ?? { path: '/tmp/fake.png', bytes: 64 }
      return {
        path: image.path,
        mime: image.mime ?? 'image/png',
        bytes: image.bytes,
        format: image.format ?? 'png',
        width: 1024,
        height: 768,
        provider: 'fake',
        truncated: false,
      }
    },
  }
  if (options.withInput ?? true) {
    driver.mouseMove = (request) => {
      calls.push(`mouseMove:${request.x},${request.y}`)
      return { action: 'mouse.move' }
    }
    driver.mouseClick = (request) => {
      calls.push(`mouseClick:${request.button ?? 'left'}x${request.clicks ?? 1}`)
      return { action: 'mouse.click' }
    }
    driver.mouseDrag = () => {
      calls.push('mouseDrag')
      return { action: 'mouse.drag' }
    }
    driver.mouseScroll = () => {
      calls.push('mouseScroll')
      return { action: 'mouse.scroll' }
    }
    driver.typeText = (request) => {
      calls.push(`typeText:${request.text}`)
      return { action: 'keyboard.type' }
    }
    driver.pressKey = (request) => {
      calls.push(`pressKey:${request.chord}`)
      return { action: 'keyboard.key' }
    }
    driver.clipboard = (request) => {
      calls.push(`clipboard:${request.text === undefined ? 'read' : 'write'}`)
      return { action: request.text === undefined ? 'clipboard.read' : 'clipboard.write', selection: 'clipboard', text: request.text ?? 'from-x', bytes: (request.text ?? 'from-x').length, truncated: false }
    }
  }
  if (options.withWindows ?? true) {
    driver.windows = (request) => {
      calls.push(`windows:${request.action ?? 'list'}`)
      return {
        action: request.action ?? 'list',
        windows: [{ id: '0x0040000c', title: 'xterm', active: true }],
        detail: 'fake',
      }
    }
    driver.wait = () => {
      calls.push('wait')
      return { action: 'wait', windows: [] }
    }
  }
  return { driver, calls }
}

// ---------------------------------------------------------------------------
// definitions/computer-use.ts - the pure vocabulary and helpers
// ---------------------------------------------------------------------------

test('contract: the seam is computer-use@1 and names its config row', () => {
  assert.equal(COMPUTER_USE, 'computer-use')
  assert.equal(COMPUTER_USE_CONTRACT, 'computer-use@1')
  assert.match(COMPUTER_USE_CONFIG_ROW, /computer-use/)
})

test('helpers: screenshot format <-> mime <-> extension', () => {
  assert.equal(resolveScreenshotFormat(undefined), 'png')
  assert.equal(resolveScreenshotFormat('JPEG'), 'jpeg')
  assert.equal(resolveScreenshotFormat('webp'), 'png')
  assert.equal(mimeOfFormat('png'), 'image/png')
  assert.equal(mimeOfFormat('jpeg'), 'image/jpeg')
  assert.equal(extensionOfFormat('png'), 'png')
  assert.equal(extensionOfFormat('jpeg'), 'jpg')
})

test('helpers: requirePositiveInt / requireText / requireEnum refuse bad input', () => {
  assert.equal(requirePositiveInt('12', 'x'), 12)
  assert.equal(requirePositiveInt(12, 'x'), 12)
  assert.throws(() => requirePositiveInt(0, 'x'), (error: unknown) => isComputerUseError(error))
  assert.throws(() => requirePositiveInt(99, 'x', 10), (error: unknown) => isComputerUseError(error))
  assert.equal(requireText('  hi  ', 'text'), 'hi')
  assert.throws(() => requireText('   ', 'text'), /required|empty/i)
  assert.throws(() => requireText('x'.repeat(11), 'text', 10), (error: unknown) => isComputerUseError(error))
  assert.equal(requireEnum('LEFT', ['left', 'right'] as const, 'button', 'right'), 'left')
  assert.equal(requireEnum(undefined, ['left', 'right'] as const, 'button', 'right'), 'right')
  assert.throws(() => requireEnum('middle', ['left', 'right'] as const, 'button'), (error: unknown) => isComputerUseError(error))
})

test('helpers: normalizeRegion / normalizePointer / normalizeChord / slugOf', () => {
  assert.deepEqual(normalizeRegion({ x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 })
  assert.equal(normalizeRegion(undefined), undefined)
  assert.throws(() => normalizeRegion({ x: 1, y: 2, width: 0, height: 4 }), (error: unknown) => isComputerUseError(error))
  assert.deepEqual(normalizePointer({ x: 5, y: 6 }), { x: 5, y: 6 })
  assert.throws(() => normalizePointer({ x: -1, y: 0 }, 'from'), (error: unknown) => isComputerUseError(error))
  assert.equal(normalizeChord('  ctrl + Shift + t '), 'ctrl+shift+t')
  assert.equal(normalizeChord('Return'), 'Return')
  assert.throws(() => normalizeChord('   '), (error: unknown) => isComputerUseError(error))
  assert.equal(slugOf('Hello / World!'), 'hello-world')
  assert.equal(slugOf('   ', 'screen'), 'screen')
})

test('errors: notImplemented names the missing half and is machine-branchable', () => {
  const error = notImplemented('mouse.click')
  assert.ok(error instanceof ComputerUseError)
  assert.equal(error.reason, 'computer-use.not-implemented')
  assert.equal(error.code, 'unsupported')
  assert.equal(error.details.action, 'mouse.click')
  assert.deepEqual(Object.keys(error.toJSON()).sort(), ['code', 'details', 'error', 'reason', 'stage'])
  assert.ok(isComputerUseError(error))
  assert.ok(isComputerUseError({ reason: 'computer-use.timeout' } as never))
  assert.equal(isComputerUseError(new Error('nope')), false)
})

// ---------------------------------------------------------------------------
// core/computer-use-impl - the service host (selection, caps, typed errors)
// ---------------------------------------------------------------------------

test('host: config is bounded, never thrown', () => {
  const bounds = validateComputerUseConfig({ provider: 'x11', fallback: ['a', 'b'], maxImageBytes: -5, timeoutMs: 'nope' } as never)
  assert.equal(bounds.provider, 'x11')
  assert.deepEqual(bounds.fallback, ['a', 'b'])
  assert.ok(Number.isInteger(bounds.maxImageBytes) && bounds.maxImageBytes > 0)
  assert.ok(Number.isInteger(bounds.timeoutMs) && bounds.timeoutMs > 0)
  assert.equal(validateComputerUseConfig().fallback.length, 0)
})

test('host: an empty registry answers a TYPED no-provider, never a fake result', async () => {
  const service = createComputerUseService({} as never, {})
  const { driver } = fakeDriver()
  assert.ok(driver)
  assert.equal(await reasonOf(() => service.screenshot({})), 'computer-use.no-provider')
  assert.equal(await reasonOf(() => service.screenInfo()), 'computer-use.no-provider')
  assert.deepEqual(service.providers(), [])
  const selection = service.selection()
  assert.equal(selection.configRow, COMPUTER_USE_CONFIG_ROW)
  assert.equal(selection.selected, undefined)
  assert.ok(typeof selection.reason === 'string' && selection.reason.length > 0)
})

test('host: register / duplicate / unregister / unknown provider', async () => {
  const service = createComputerUseService({} as never, { provider: 'fake' })
  const { driver } = fakeDriver()
  const unregister = service.register(driver)
  assert.throws(() => service.register(driver), (error: unknown) => isComputerUseError(error) && (error as ComputerUseError).reason === 'computer-use.duplicate-provider')
  assert.equal(service.providerId, '')
  const info = service.providers()
  assert.equal(info.length, 1)
  assert.deepEqual({ id: info[0].id, configured: info[0].configured, available: info[0].available, runner: info[0].runner, target: info[0].target }, { id: 'fake', configured: true, available: true, runner: 'local', target: 'existing' })
  await service.screenInfo()
  assert.equal(service.providerId, 'fake')
  assert.equal(await reasonOf(() => service.screenshot({}, 'nope')), 'computer-use.unknown-provider')
  unregister()
  assert.deepEqual(service.providers(), [])
})

test('host: an unavailable driver is reported AND refused, with its reason', async () => {
  const service = createComputerUseService({} as never, { provider: 'fake' })
  const { driver } = fakeDriver({ available: false, reason: 'no display in this deployment' })
  service.register(driver)
  const info = service.providers()[0]
  assert.equal(info.available, false)
  assert.equal(info.reason, 'no display in this deployment')
  assert.equal(await reasonOf(() => service.screenshot({})), 'computer-use.provider-unavailable')
  const selection = service.selection()
  assert.equal(selection.selected, undefined)
  assert.match(String(selection.reason), /no display in this deployment/)
})

test('host: several usable drivers and none named is AMBIGUOUS, never a silent pick', async () => {
  const service = createComputerUseService({} as never, {})
  service.register(fakeDriver({ id: 'one' }).driver)
  service.register(fakeDriver({ id: 'two' }).driver)
  assert.equal(await reasonOf(() => service.screenInfo()), 'computer-use.ambiguous')
  // Naming one resolves it, and the fallback chain does too.
  assert.equal((await service.screenInfo('two')).provider, 'two')
  const chained = createComputerUseService({} as never, { fallback: ['missing', 'two'] })
  chained.register(fakeDriver({ id: 'one' }).driver)
  chained.register(fakeDriver({ id: 'two' }).driver)
  assert.equal((await chained.screenInfo()).provider, 'two')
})

test('host: the seam STAMPS the identity of the driver on every answer', async () => {
  const service = createComputerUseService({} as never, { provider: 'fake' })
  const { driver } = fakeDriver({ display: ':77', screen: { width: 800, height: 600, depth: 16 } })
  service.register(driver)
  const screen = await service.screenInfo()
  assert.deepEqual(
    { display: screen.display, width: screen.width, height: screen.height, depth: screen.depth, provider: screen.provider, runner: screen.runner, target: screen.target },
    { display: ':77', width: 800, height: 600, depth: 16, provider: 'fake', runner: 'local', target: 'existing' },
  )
  const report = await service.capabilities()
  assert.equal(report.provider, 'fake')
  assert.equal(report.reachable, true)
  assert.ok(typeof report.actions === 'object' && report.actions !== null)
})

test('host: a malformed driver answer is a typed malformed-output, never a guess', async () => {
  const service = createComputerUseService({} as never, { provider: 'broken' })
  service.register({
    id: 'broken',
    runner: 'local',
    target: 'existing',
    available: () => true,
    capabilities: () => ({}) as never,
    screenInfo: () => ({ provider: 'broken' }) as never,
    screenshot: () => ({ truncated: false }) as never,
  })
  assert.equal(await reasonOf(() => service.capabilities()), 'computer-use.malformed-output')
  assert.equal(await reasonOf(() => service.screenInfo()), 'computer-use.malformed-output')
  assert.equal(await reasonOf(() => service.screenshot({})), 'computer-use.malformed-output')
})

test('host: the screenshot byte cap is enforced on the REAL size', async () => {
  const service = createComputerUseService({} as never, { provider: 'fake', maxImageBytes: 100 })
  service.register(fakeDriver({ screenshot: { path: '/tmp/cap.png', bytes: 100 } }).driver)
  const atCap = await service.screenshot({})
  assert.equal(atCap.bytes, 100)
  assert.equal(atCap.truncated, true)
  assert.equal(atCap.mime, 'image/png')
  assert.equal(atCap.path, '/tmp/cap.png')

  const over = createComputerUseService({} as never, { provider: 'fake', maxImageBytes: 100 })
  over.register(fakeDriver({ screenshot: { path: '/tmp/over.png', bytes: 101 } }).driver)
  assert.equal(await reasonOf(() => over.screenshot({})), 'computer-use.oversized')
})

test('host: an absent half is a typed not-implemented naming the action', async () => {
  const service = createComputerUseService({} as never, { provider: 'minimal' })
  service.register(fakeDriver({ id: 'minimal', withInput: false, withWindows: false }).driver)
  assert.equal(await reasonOf(() => service.mouse('move', { x: 1, y: 1 })), 'computer-use.not-implemented')
  assert.equal(await reasonOf(() => service.keyboard('type', { text: 'hi' })), 'computer-use.not-implemented')
  assert.equal(await reasonOf(() => service.windows({ action: 'list' })), 'computer-use.not-implemented')
  assert.equal(await reasonOf(() => service.clipboard({})), 'computer-use.not-implemented')
  // The halves it DOES serve still work.
  const shot = await service.screenshot({})
  assert.equal(shot.provider, 'minimal')
})

test('host: a bad request field is a typed invalid-input, and a served action reaches the driver', async () => {
  const service = createComputerUseService({} as never, { provider: 'fake' })
  const { driver, calls } = fakeDriver()
  service.register(driver)
  assert.equal(await reasonOf(() => service.mouse('move', { x: -1, y: 0 })), 'computer-use.invalid-input')
  assert.equal(await reasonOf(() => service.mouse('click', { button: 'thumb' })), 'computer-use.invalid-input')
  assert.equal(await reasonOf(() => service.keyboard('type', { text: '   ' })), 'computer-use.invalid-input')
  const answer = await service.mouse('move', { x: 12, y: 34 })
  assert.equal(answer.action, 'mouse.move')
  await service.mouse('click', { x: 12, y: 34, clicks: 2 })
  await service.keyboard('type', { text: 'hello' })
  await service.keyboard('key', { chord: 'ctrl+shift+t' })
  await service.clipboard({ text: 'copy me' })
  await service.windows({ action: 'list' })
  assert.deepEqual(calls, [
    'mouseMove:12,34',
    'mouseClick:leftx2',
    'typeText:hello',
    'pressKey:ctrl+shift+t',
    'clipboard:write',
    'windows:list',
  ])
})

// ---------------------------------------------------------------------------
// core/computer-use-x11 - config validation (the driver itself is smoke-tested
// against a REAL display by the last test of this file)
// ---------------------------------------------------------------------------

test('x11: the driver config is normalized and its toolchain table is explicit', () => {
  const config = validateX11Config({ target: 'xvfb', runner: 'docker', container: 'desktop', windowManager: 'none', typeDelayMs: 0 })
  assert.equal(config.target, 'xvfb')
  assert.equal(config.runner, 'docker')
  assert.equal(config.container, 'desktop')
  assert.equal(config.display, ':99')
  assert.equal(config.width, 1280)
  assert.equal(config.height, 800)
  assert.equal(config.depth, 24)
  assert.equal(config.windowManager, 'none')
  assert.ok(config.typeDelayMs > 0, 'a zero delay falls back to the documented default')
  assert.equal(config.screenshotDir.length > 0, true)
  const binaries = X11_TOOLS.map((tool) => tool.binary)
  for (const required of ['xdpyinfo', 'xdotool', 'import', 'xclip', 'wmctrl', 'Xvfb']) {
    assert.ok(binaries.includes(required), `${required} must be in the toolchain table`)
  }
  for (const tool of X11_TOOLS) {
    assert.ok(tool.package.length > 0 && tool.usedFor.length > 0)
  }
})

// ---------------------------------------------------------------------------
// core/computer-use-x11 - the driver against a FAKE runner. No display is
// touched, yet the two rules a real display would hide are asserted: an owned
// display is brought up BEFORE it is probed/reported, and a call never waits for
// the pipes of a process that forks a descendant (xclip).
// ---------------------------------------------------------------------------

/** A structural X11 runner: the fake display answers only once Xvfb started. */
class FakeX11Runner implements X11Runner {
  readonly kind: RunnerKind = 'local'
  readonly calls: Array<{ argv: readonly string[]; input?: string; stdio: string }> = []
  private readonly options: { xvfb: boolean }
  private displayPid?: number

  constructor(options: { xvfb?: boolean } = {}) {
    this.options = { xvfb: options.xvfb ?? true }
  }

  get displayUp(): boolean {
    return this.displayPid !== undefined
  }

  async run(request: ExecRequest): Promise<ExecResult> {
    this.calls.push({
      argv: request.argv,
      ...(request.input === undefined ? {} : { input: request.input.toString() }),
      stdio: request.stdio ?? 'capture',
    })
    const [binary] = request.argv as string[]
    if (binary === 'xdpyinfo') {
      if (!this.displayUp) return { code: 1, stdout: Buffer.alloc(0), stderr: "xdpyinfo:  unable to open display ':77'" }
      return { code: 0, stdout: Buffer.from('dimensions:    640x480 pixels\ndepth of root window:    24 planes\n'), stderr: '' }
    }
    if (binary === 'sh') return { code: 0, stdout: Buffer.from('state=absent\n'), stderr: '' }
    if (binary === 'xclip') return { code: 0, stdout: Buffer.from('FAKE-CLIPBOARD'), stderr: '' }
    return { code: 0, stdout: Buffer.alloc(0), stderr: '' }
  }

  async background(argv: readonly string[]): Promise<number | undefined> {
    this.calls.push({ argv, stdio: 'background' })
    this.displayPid = 4242
    return this.displayPid
  }

  async kill(): Promise<void> {
    this.displayPid = undefined
  }

  async has(binary: string): Promise<boolean> {
    if (binary === 'Xvfb') return this.options.xvfb
    return true
  }
}

/** The driver of a fake `:77` that OWNS its display (windowManager: none). */
function fakeOwnedProvider(runner: FakeX11Runner): X11Provider {
  return new X11Provider(validateX11Config({ target: 'xvfb', display: ':77', windowManager: 'none' }), runner)
}

test('x11: spawnExec settles on the EXIT of the process, not on pipes a forked child holds', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-spawn-exec-'))
  const script = path.join(dir, 'forker.sh')
  // The background child inherits stdout/stderr, so the pipes stay open after the
  // parent exited - exactly what `xclip -i` does with its selection owner.
  await fs.writeFile(script, '#!/bin/sh\nsleep 30 &\nprintf "done"\nexit 0\n', { mode: 0o755 })
  try {
    const started = Date.now()
    const result = await spawnExec([script], { timeoutMs: 20_000 })
    const elapsed = Date.now() - started
    assert.equal(result.code, 0)
    assert.equal(result.stdout.toString(), 'done')
    assert.ok(elapsed < 5_000, `the call must answer when the process exited, not when its descendant died (took ${elapsed} ms)`)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('x11: spawnExec still answers a TYPED timeout when the process itself does not exit', async () => {
  const started = Date.now()
  await assert.rejects(
    () => spawnExec(['sh', '-c', 'sleep 30'], { timeoutMs: 400 }),
    (error: unknown) => {
      assert.ok(isComputerUseError(error), `expected a typed computer-use error, got ${String(error)}`)
      assert.equal((error as ComputerUseError).reason, 'computer-use.timeout')
      assert.equal((error as ComputerUseError).details?.binary, 'sh')
      return true
    },
  )
  assert.ok(Date.now() - started < 5_000, 'the deadline must answer, never wait for the pipes')
})

test('x11: capabilities() brings an OWNED display up itself (no false negative on `computer open`)', async () => {
  const runner = new FakeX11Runner()
  const provider = fakeOwnedProvider(runner)
  try {
    assert.equal(runner.displayUp, false, 'the fake display starts DOWN')
    const report = await provider.capabilities()
    assert.equal(runner.displayUp, true, 'the capability report must start the display this driver owns')
    assert.equal(report.reachable, true, `the owned display must be reported reachable: ${String(report.unreachableReason)}`)
    assert.equal(report.actions.screenshot, true)
    assert.equal(report.actions.clipboard, true)
    assert.deepEqual(report.unavailable, [])
    assert.equal(report.unreachableReason, undefined)
    assert.deepEqual(report.screen, { width: 640, height: 480, depth: 24 })
  } finally {
    await provider.dispose()
  }
})

test('x11: capabilities() REPORTS an owned display that cannot start instead of throwing', async () => {
  const runner = new FakeX11Runner({ xvfb: false })
  const provider = fakeOwnedProvider(runner)
  const report = await provider.capabilities()
  assert.equal(report.reachable, false)
  assert.match(String(report.unreachableReason), /Xvfb/, 'the typed reason must name the missing half')
  assert.equal(report.actions.screenshot, false)
  assert.ok(report.unavailable.some((entry) => entry.action === 'screenshot'))
  await provider.dispose()
})

test('x11: clipboard() starts the owned display, and a write never inherits a captured pipe', async () => {
  const runner = new FakeX11Runner()
  const provider = fakeOwnedProvider(runner)
  try {
    const written = await provider.clipboard({ text: 'copy me' })
    assert.equal(written.action, 'clipboard.write')
    assert.equal(written.bytes, 7)
    assert.equal(runner.displayUp, true, 'the clipboard path must bring the owned display up, like the screenshot path')
    const clips = runner.calls.filter((call) => call.argv[0] === 'xclip')
    assert.equal(clips.length, 1, 'the write must really run xclip once')
    assert.equal(clips[0]?.stdio, 'ignore', 'writes hand the selection to a fork: no captured pipe may keep the call pending')
    assert.equal(clips[0]?.input, 'copy me')

    const read = await provider.clipboard({})
    assert.equal(read.action, 'clipboard.read')
    assert.equal(read.text, 'FAKE-CLIPBOARD')
    assert.equal(runner.calls.filter((call) => call.argv[0] === 'xclip')[1]?.stdio, 'capture')
  } finally {
    await provider.dispose()
  }
})

// ---------------------------------------------------------------------------
// plugins/computer-use-tools - the consumer tool (routing + typed failures)
// ---------------------------------------------------------------------------

/** A fake `computer-use@1` service that RECORDS every call it receives. */
function fakeService(): { service: ComputerUseService; calls: string[] } {
  const calls: string[] = []
  const service = {
    contract: COMPUTER_USE_CONTRACT,
    providerId: 'fake',
    register: () => () => undefined,
    providers: () => {
      calls.push('providers')
      return [
        { id: 'fake', configured: true, available: true, runner: 'local' as RunnerKind, target: 'existing' as DisplayTarget, display: ':0' },
      ]
    },
    selection: () => ({ provider: 'fake', fallback: [], selected: 'fake', configRow: COMPUTER_USE_CONFIG_ROW }),
    capabilities: async () => {
      calls.push('capabilities')
      return { provider: 'fake', runner: 'local', target: 'existing', reachable: true, actions: { screenshot: true }, tools: [], notes: [] } as unknown as ComputerUseCapabilityReport
    },
    screenInfo: async () => {
      calls.push('screenInfo')
      return { width: 1024, height: 768, provider: 'fake' }
    },
    screenshot: async (request: ScreenshotRequest) => {
      calls.push(`screenshot:${request.format ?? 'png'}${request.region === undefined ? '' : `:${request.region.width}x${request.region.height}+${request.region.x}+${request.region.y}`}`)
      return { path: '/tmp/tool.png', mime: 'image/png', bytes: 42, format: 'png' as const, width: 1024, height: 768, provider: 'fake', truncated: false }
    },
    mouse: async (action: string) => {
      calls.push(`mouse:${action}`)
      return { action: `mouse.${action}` }
    },
    keyboard: async (action: string) => {
      calls.push(`keyboard:${action}`)
      return { action: `keyboard.${action}` }
    },
    clipboard: async (request: { text?: string }) => {
      calls.push(`clipboard:${request.text === undefined ? 'read' : 'write'}`)
      return { action: 'clipboard.read', selection: 'clipboard' as const, text: 'x', bytes: 1, truncated: false }
    },
    windows: async (request: { action?: string }) => {
      calls.push(`windows:${request.action ?? 'list'}`)
      return { action: request.action ?? 'list', windows: [] }
    },
    wait: async () => {
      calls.push('wait')
      return { action: 'wait' as const, windows: [] }
    },
    close: async (request: { title?: string }) => {
      calls.push(`close:${request.title ?? ''}`)
      return { action: 'close' as const, windows: [] }
    },
  } as unknown as ComputerUseService
  return { service, calls }
}

function toolOf(ctx: never): ToolDef {
  computerTools.apply(ctx as never)
  const { tools } = harnessServices
  const def = tools.get('computer')
  assert.ok(def, "the consumer must register a tool named 'computer'")
  return def
}

let harnessServices: { tools: Map<string, ToolDef> }

test('tools: the consumer registers ONE action-enum tool named `computer`', () => {
  const fake = fakeService()
  const built = harness({ 'computer-use': fake.service })
  harnessServices = { tools: built.tools }
  const def = toolOf(built.ctx)
  assert.equal(def.name, 'computer')
  assert.match(String(def.description), /screenshot/)
  const params = def.parameters.properties as Record<string, { type: string; required?: boolean }>
  assert.equal(def.parameters.required?.includes('action'), true)
  assert.equal(params.screenshot, undefined, 'the actions are ONE enum parameter, not one parameter per action')
  built.unload()
  assert.equal(built.tools.size, 0, 'the tool must be released by the disposer')
})

test('tools: every action routes to the capability and answers ok:true', async () => {
  const fake = fakeService()
  const built = harness({ 'computer-use': fake.service })
  harnessServices = { tools: built.tools }
  const def = toolOf(built.ctx)

  const providers = (await def.execute({ action: 'providers' })) as { ok: boolean; providers: unknown[] }
  assert.equal(providers.ok, true)
  assert.equal(providers.providers.length, 1)

  assert.equal(((await def.execute({ action: 'open' })) as { ok: boolean }).ok, true)
  assert.equal(((await def.execute({ action: 'screen' })) as { width: number }).width, 1024)

  const shot = (await def.execute({ action: 'screenshot', format: 'jpeg', regionWidth: 100, regionHeight: 50, regionX: 5, regionY: 6 })) as { path: string; bytes: number }
  assert.equal(shot.path, '/tmp/tool.png')
  assert.equal(shot.bytes, 42)

  assert.equal(((await def.execute({ action: 'act', kind: 'move', x: 3, y: 4 })) as { action: string }).action, 'mouse.move')
  assert.equal(((await def.execute({ action: 'act', kind: 'click', x: 3, y: 4, clicks: 2 })) as { action: string }).action, 'mouse.click')
  assert.equal(((await def.execute({ action: 'act', kind: 'drag', fromX: 0, fromY: 0, toX: 9, toY: 9 })) as { action: string }).action, 'mouse.drag')
  assert.equal(((await def.execute({ action: 'act', kind: 'scroll', direction: 'down' })) as { action: string }).action, 'mouse.scroll')
  assert.equal(((await def.execute({ action: 'act', kind: 'type', text: 'hi' })) as { action: string }).action, 'keyboard.type')
  assert.equal(((await def.execute({ action: 'act', kind: 'key', chord: 'Return' })) as { action: string }).action, 'keyboard.key')
  assert.equal(((await def.execute({ action: 'act', kind: 'copy', text: 'x' })) as { action: string }).action, 'clipboard.read')
  assert.equal(((await def.execute({ action: 'act', kind: 'paste' })) as { action: string }).action, 'clipboard.read')

  assert.equal(((await def.execute({ action: 'window', windowAction: 'list' })) as { action: string }).action, 'list')
  assert.equal(((await def.execute({ action: 'window', windowAction: 'focus', title: 'xterm' })) as { action: string }).action, 'focus')
  assert.equal(((await def.execute({ action: 'window', windowAction: 'launch', command: 'xterm' })) as { action: string }).action, 'launch')
  assert.equal(((await def.execute({ action: 'wait', ms: 10 })) as { action: string }).action, 'wait')
  assert.equal(((await def.execute({ action: 'close', title: 'xterm' })) as { action: string }).action, 'close')

  assert.deepEqual(fake.calls, [
    'providers',
    'capabilities',
    'screenInfo',
    'screenshot:jpeg:100x50+5+6',
    'mouse:move',
    'mouse:click',
    'mouse:drag',
    'mouse:scroll',
    'keyboard:type',
    'keyboard:key',
    'clipboard:write',
    'clipboard:read',
    'windows:list',
    'windows:focus',
    'windows:launch',
    'wait',
    'close:xterm',
  ])
  built.unload()
})

test('tools: a bad parameter is a TYPED body, never a thrown generic failure', async () => {
  const fake = fakeService()
  const built = harness({ 'computer-use': fake.service })
  harnessServices = { tools: built.tools }
  const def = toolOf(built.ctx)

  // SCHEMA-level violations are rejected BEFORE the handler (a typed ToolArgsError).
  const schemaRejects: Array<[Record<string, unknown>, RegExp]> = [
    [{}, /action: missing required parameter/],
    [{ action: 'window', windowAction: 'list', windowAction2: 1 }, /windowAction2: unknown parameter/],
  ]
  for (const [params, pattern] of schemaRejects) {
    await assert.rejects(async () => await def.execute(params), pattern, `${JSON.stringify(params)} must be rejected by the surface`)
  }
  // CONDITIONAL requirements (per action kind) are runtime checks of the handler:
  // a typed body, never a thrown generic failure.
  const handlerCases: Array<[Record<string, unknown>, string]> = [
    [{ action: 'teleport' }, 'action'],
    [{ action: 'act' }, 'kind'],
    [{ action: 'act', kind: 'type' }, 'text'],
    [{ action: 'act', kind: 'key' }, 'chord'],
    [{ action: 'act', kind: 'move', x: 1 }, 'y'],
    [{ action: 'wait' }, 'ms'],
    [{ action: 'close' }, 'title'],
  ]
  for (const [params, expected] of handlerCases) {
    const answer = (await def.execute(params)) as { ok: boolean; error?: { reason: string; details?: { field?: string } } }
    assert.equal(answer.ok, false, `${JSON.stringify(params)} must fail`)
    assert.equal(answer.error?.reason, 'computer-use.invalid-input')
    assert.equal(answer.error?.details?.field, expected, `${JSON.stringify(params)} must name the '${expected}' field`)
  }
  built.unload()
})

test('tools: a missing capability answers the typed missing-service body naming the roster row', async () => {
  const built = harness({})
  harnessServices = { tools: built.tools }
  const def = toolOf(built.ctx)
  const answer = (await def.execute({ action: 'screen' })) as { ok: boolean; error?: { reason: string; hint?: string } }
  assert.equal(answer.ok, false)
  assert.equal(answer.error?.reason, 'computer-use.missing-service')
  assert.match(String(answer.error?.hint), /computer-use/)
  built.unload()
})

test('tools: a capability failure keeps its reason, code and hint', async () => {
  const broken = {
    ...fakeService().service,
    screenshot: async () => {
      throw new ComputerUseError('computer-use.no-display', 'the target has no display', { stage: 'provider', details: { display: ':0' } })
    },
  } as unknown as ComputerUseService
  const built = harness({ 'computer-use': broken })
  harnessServices = { tools: built.tools }
  const def = toolOf(built.ctx)
  const answer = (await def.execute({ action: 'screenshot' })) as { ok: boolean; error?: { reason: string; code: string; hint: string; stage: string } }
  assert.equal(answer.ok, false)
  assert.equal(answer.error?.reason, 'computer-use.no-display')
  assert.equal(answer.error?.code, 'unreachable')
  assert.equal(answer.error?.stage, 'provider')
  assert.equal(answer.error?.hint, COMPUTER_USE_CONFIG_ROW)
  built.unload()
})

// ---------------------------------------------------------------------------
// LIVE smoke: the real X11 driver against a display IT owns. Skipped - with the
// missing binaries named - on a host without the toolchain; never green-because-
// unused when the toolchain IS there.
// ---------------------------------------------------------------------------

/**
 * A display number this test can OWN: not answered by a live server, and not
 * held by a live one either (a lock left by a DEAD server is not a reason to
 * skip: the provider removes it). Hard-coding a display number would make the
 * gate fail on the second run, because a killed Xvfb leaves its lock behind.
 */
function freeDisplay(): string {
  for (let number = 99; number >= 90; number -= 1) {
    const display = `:${number}`
    if (spawnSync('xdpyinfo', ['-display', display], { stdio: 'ignore' }).status === 0) continue
    const pid = spawnSync('sh', ['-c', `cat /tmp/.X${number}-lock 2>/dev/null`], { encoding: 'utf8' }).stdout.trim()
    if (/^\d+$/.test(pid) && isAlive(Number(pid))) continue
    return display
  }
  throw new Error('no free X display in :90..:99: free one, or remove the stale /tmp/.X<n>-lock files')
}

/** True when the process is still there (`kill -0`). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Fails LOUDLY when a call does not answer in time: a hang IS the defect here. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms)
      timer.unref()
    }),
  ])
}

test('LIVE x11: capability report, screenshot, pointer, keyboard, clipboard and window listing on an owned display', async (t) => {
  // `xclip` is required too: the clipboard round-trip below is a REAL call, and a
  // missing binary must SKIP the gate instead of failing it.
  const required = ['Xvfb', 'xdpyinfo', 'xdotool', 'import', 'xclip', 'wmctrl']
  const missing = required.filter((binary) => spawnSync('sh', ['-c', `command -v ${binary}`]).status !== 0)
  if (process.env.COMPUTER_USE_LIVE === '0') {
    t.skip('COMPUTER_USE_LIVE=0: the live gate was disabled by the caller')
    return
  }
  if (missing.length > 0) {
    t.skip(`no X11 toolchain on this host: missing ${missing.join(', ')} (apt-get install -y xvfb x11-utils xdotool imagemagick xclip wmctrl)`)
    return
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-computer-use-'))
  const display = freeDisplay()
  const provider = createX11Provider({
    target: 'xvfb',
    display,
    xvfb: { display, width: 640, height: 480, depth: 24 },
    windowManager: 'none',
    screenshotDir: dir,
    toolTimeoutMs: 20_000,
  })
  const service = createComputerUseService({} as never, { provider: 'x11', screenshotDir: dir })

  try {
    const unregister = service.register(provider)

    // The FIRST call of a fresh process is the capability report (`computer open`):
    // it must bring the owned display up itself, or an agent is told the desktop
    // is unusable one call before it works (D2).
    const report = await within(service.capabilities(), 30_000, 'the capability report')
    assert.equal(report.reachable, true, `the owned display must answer: ${String(report.unreachableReason)}`)
    assert.ok(report.tools.length > 0, 'the capability report must list the probed binaries')
    assert.ok(report.tools.every((tool) => tool.present), `every probed binary must be present: ${JSON.stringify(report.tools.filter((tool) => !tool.present))}`)
    assert.equal(report.actions.screenshot, true)
    assert.equal(report.actions.clipboard, true)

    const started = await provider.start?.()
    assert.ok(started === undefined || typeof started === 'object', 'start() answers the geometry of the display it owns')

    const info = await service.screenInfo()
    assert.equal(info.provider, 'x11')
    assert.equal(info.display, display)
    assert.equal(info.width, 640)
    assert.equal(info.height, 480)

    const shots: string[] = []
    const shot = await service.screenshot({ format: 'png', label: 'live' })
    shots.push(shot.path)
    assert.ok(shot.bytes > 0, 'a screenshot must be a non-empty file')
    assert.equal(shot.mime, 'image/png')
    assert.equal((await fs.stat(shot.path)).size, shot.bytes)
    assert.match((await fs.readFile(shot.path)).subarray(1, 4).toString('latin1'), /PNG/)

    const region = await service.screenshot({ region: { x: 0, y: 0, width: 64, height: 32 } })
    shots.push(region.path)
    assert.equal(region.width, 64)
    assert.equal(region.height, 32)

    const moved = await service.mouse('move', { x: 10, y: 20 })
    assert.match(moved.action, /mouse/)
    await service.keyboard('type', { text: 'hello' })
    await service.keyboard('key', { chord: 'Return' })

    // The clipboard must round-trip AND answer: `xclip -i` hands the selection to
    // a forked child, so a call that waits for the pipes of that fork never
    // returns (D1). Both calls are bounded, so a hang fails the gate loudly.
    const written = await within(service.clipboard({ text: 'wb-computer-use-clip' }), 15_000, 'clipboard write')
    assert.equal(written.action, 'clipboard.write')
    assert.equal(written.bytes, 'wb-computer-use-clip'.length)
    const pasted = await within(service.clipboard({}), 15_000, 'clipboard read')
    assert.equal(pasted.action, 'clipboard.read')
    assert.equal(pasted.text, 'wb-computer-use-clip')

    const windows = await service.windows({ action: 'list' })
    assert.equal(windows.action, 'list')
    assert.ok(Array.isArray(windows.windows))

    // The pointer really moved: the driver reports where it is now.
    const after = await service.screenInfo()
    if (after.pointer !== undefined) assert.deepEqual(after.pointer, { x: 10, y: 20 })

    unregister()
    await Promise.all(shots.map((file) => fs.rm(file, { force: true })))
  } finally {
    await provider.stop?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
