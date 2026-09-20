// core/computer-use-x11 - the DESKTOP DRIVER of the `computer-use@1` seam
// (provider id `x11`).
//
// WHY X11: the DSH `computer-use` group drives a GUI through the X11 toolchain
// (Xvfb as the disposable display, xdotool for input, ImageMagick for capture,
// xclip for the clipboard, a WM for window management). That is the only
// headless-capable stack with no desktop environment, no display server on the
// host and no package outside a normal Linux image - so the seam works in a
// container exactly as it works on a workstation.
//
// WHAT IT IS NOT: this driver never fakes a result. Every capability is PROBED
// (`xdpyinfo` answers? which binaries exist in the TARGET?) and every action that
// cannot run right now fails with a typed error naming the missing half
// (`computer-use.no-display`, `computer-use.missing-tool`, ...). A screenshot is
// always a real file whose byte size is reported; a click is a real X event.
//
// TWO INDEPENDENT CHOICES (both config):
//   * TARGET `existing` - attach to a display the deployment already provides
//     (`DISPLAY`, e.g. a workstation session or a container that runs its own
//     Xvfb). `xvfb` - the driver STARTS and OWNS a display (default `:99`),
//     optionally with a window manager, and kills it in its disposer, so nothing
//     outside the driver has to change.
//   * RUNNER `local` - the driver runs the binaries where the workbench process
//     runs. `docker` - every binary runs INSIDE a container (`docker exec -i`),
//     so an agent can drive a desktop in a disposable target.
//
// The screenshot is captured on stdout and WRITTEN BY THE DRIVER, which is what
// makes `local` and `docker` behave identically: no path mapping between the two
// filesystems is ever needed, and the answer is always a path on the side the
// caller reads from.
//
// THE CLIPBOARD IS SPECIAL: `xclip -i` publishes the selection and hands
// ownership to a FORKED child, which inherits the pipes of its parent. The
// driver therefore spawns it without captured pipes and settles on the EXIT of
// the process it started, never on the close of pipes a descendant still holds.
//
// It runs commands, so its manifest declares `execution: "host"`.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertPolicyDeclared, positiveInt, serviceOf, shellQuote, str, type ServiceContext } from '../../definitions/support.ts'
import {
  COMPUTER_USE,
  ComputerUseError,
  clampRegion,
  extensionOfFormat,
  mimeOfFormat,
  resolveScreenshotFormat,
  slugOf,
} from '../../definitions/computer-use.ts'
import type {
  ClipboardAnswer,
  ClipboardRequest,
  ComputerUseCallOptions,
  ComputerUseCapabilityReport,
  ComputerUseProvider,
  ComputerUseService,
  ComputerUseToolStatus,
  DisplayTarget,
  InputAnswer,
  KeyboardKeyRequest,
  KeyboardTypeRequest,
  LaunchRequest,
  MouseButton,
  MouseClickRequest,
  MouseDragRequest,
  MouseMoveRequest,
  MouseScrollRequest,
  PointerPosition,
  RunnerKind,
  ScreenInfo,
  ScreenRegion,
  ScreenshotAnswer,
  ScreenshotRequest,
  WaitRequest,
  WindowAnswer,
  WindowInfo,
  WindowRequest,
} from '../../definitions/computer-use.ts'

export const name = 'computer-use-x11'

/** The id this driver is configured and requested by. */
export const providerId = 'x11'

/** The display an owned Xvfb gets when the config names none. */
export const DEFAULT_XVFB_DISPLAY = ':99'

/** The geometry of an owned Xvfb when the config names none. */
export const DEFAULT_XVFB_WIDTH = 1280
export const DEFAULT_XVFB_HEIGHT = 800
export const DEFAULT_XVFB_DEPTH = 24

/** How long the driver waits for a display it started to answer, in ms. */
export const DEFAULT_DISPLAY_WAIT_MS = 10_000

/** The keystroke delay of `xdotool type` when the caller names none. */
export const DEFAULT_TYPE_DELAY_MS = 12

/** The button number of `xdotool` for each contract button. */
export const BUTTON_NUMBERS: Record<MouseButton, number> = { left: 1, middle: 2, right: 3 }

/** The display NUMBER of an X display name (`:99`, `host:99.0` -> 99). */
export function displayNumber(display: string): string | undefined {
  return /:(\d+)(?:\.\d+)?$/.exec(display)?.[1]
}

/**
 * What the lock file of a display says. The lock holds the PID of the X server:
 * `cleaned` means a STALE lock (its server was gone) was removed, `busy` that a
 * LIVE server holds the display.
 */
export interface DisplayLockState {
  state: 'absent' | 'cleaned' | 'busy' | 'unremovable' | 'unknown'
  display: string
  pid?: number
}

/** The `xdotool` wheel "button" number of each scroll direction. */
export const SCROLL_BUTTONS: Record<string, number> = { up: 4, down: 5, left: 6, right: 7 }

/** One binary the driver can use, and the actions that stop working without it. */
export interface X11ToolSpec {
  binary: string
  /** The Debian/Ubuntu package that usually provides it (operator-facing hint). */
  package: string
  usedFor: readonly string[]
  /** True when the config only needs it for one target kind. */
  forTarget?: DisplayTarget
  /** True when the config only needs it for one runner. */
  forRunner?: RunnerKind
}

/**
 * The toolchain, in ONE place: `computer screen` reports this table with the
 * present/absent state of the TARGET, so an operator sees exactly which package
 * is missing instead of a mystery failure.
 */
export const X11_TOOLS: readonly X11ToolSpec[] = [
  { binary: 'xdpyinfo', package: 'x11-utils', usedFor: ['screen', 'screenshot', 'display probe'] },
  { binary: 'xdotool', package: 'xdotool', usedFor: ['mouse', 'keyboard', 'window lookup'] },
  { binary: 'import', package: 'imagemagick', usedFor: ['screenshot'] },
  { binary: 'xclip', package: 'xclip', usedFor: ['clipboard'] },
  { binary: 'wmctrl', package: 'wmctrl', usedFor: ['window list/focus/close'] },
  { binary: 'Xvfb', package: 'xvfb', usedFor: ['the owned display'], forTarget: 'xvfb' },
  { binary: 'openbox', package: 'openbox', usedFor: ['window manager of the owned display'], forTarget: 'xvfb' },
  { binary: 'docker', package: 'docker-cli', usedFor: ['the docker runner'], forRunner: 'docker' },
]

/** The config of the driver. */
export interface X11Config {
  /** `existing` (default): attach to a display that already exists. `xvfb`: own one. */
  target?: DisplayTarget
  /** `local` (default) or `docker` (every binary runs inside `container`). */
  runner?: RunnerKind
  /** The X display name, e.g. `:0` or `:99`. Default: `$DISPLAY` (`:99` when owning). */
  display?: string
  /** The container the `docker` runner drives (required by that runner). */
  container?: string
  /** The geometry of an OWNED display. */
  xvfb?: {
    display?: string
    width?: number
    height?: number
    depth?: number
    /** Extra arguments handed to Xvfb verbatim (argv, never a shell string). */
    args?: string[]
  }
  /** The WM started on an owned display: a binary name, or `none`. Default `openbox`. */
  windowManager?: string
  /** Where screenshots are written (default: `<tmpdir>/workbench-computer-use`). */
  screenshotDir?: string
  /** The keystroke delay of `xdotool type` (ms). */
  typeDelayMs?: number
  /** The bound of ONE tool invocation in ms (default 15000). */
  toolTimeoutMs?: number
  /** Extra binaries `capabilities()` must also probe (a custom target's tools). */
  extraTools?: readonly string[]
}

/** The driver config once read and bounded (never a raw config value). */
export interface NormalizedX11Config {
  target: DisplayTarget
  runner: RunnerKind
  display?: string
  container?: string
  width: number
  height: number
  depth: number
  xvfbArgs: string[]
  windowManager: string
  screenshotDir: string
  typeDelayMs: number
  toolTimeoutMs: number
  extraTools: string[]
}

/** Reads + bounds the config. A bad value falls back to the documented default. */
export function validateX11Config(config: X11Config = {}): NormalizedX11Config {
  const target: DisplayTarget = config.target === 'xvfb' ? 'xvfb' : 'existing'
  const runner: RunnerKind = config.runner === 'docker' ? 'docker' : 'local'
  const xvfb = config.xvfb ?? {}
  const display = str(config.display) ?? str(xvfb.display) ?? str(process.env.DISPLAY) ?? (target === 'xvfb' ? DEFAULT_XVFB_DISPLAY : undefined)
  const container = str(config.container)
  return {
    target,
    runner,
    ...(display === undefined ? {} : { display }),
    ...(container === undefined ? {} : { container }),
    width: positiveInt(xvfb.width, DEFAULT_XVFB_WIDTH, 16_384),
    height: positiveInt(xvfb.height, DEFAULT_XVFB_HEIGHT, 16_384),
    depth: positiveInt(xvfb.depth, DEFAULT_XVFB_DEPTH, 32),
    xvfbArgs: Array.isArray(xvfb.args) ? xvfb.args.map((value) => String(value)) : [],
    windowManager: str(config.windowManager) ?? 'openbox',
    screenshotDir: str(config.screenshotDir) ?? path.join(os.tmpdir(), 'workbench-computer-use'),
    typeDelayMs: positiveInt(config.typeDelayMs, DEFAULT_TYPE_DELAY_MS, 5_000),
    toolTimeoutMs: positiveInt(config.toolTimeoutMs, 15_000, 300_000),
    extraTools: Array.isArray(config.extraTools) ? config.extraTools.map((value) => String(value)) : [],
  }
}

// ---------------------------------------------------------------------------
// Execution: the SAME provider code drives a local host and a container, which
// is the only way `runner: docker` can be a configuration detail and not a
// second implementation.
// ---------------------------------------------------------------------------

/** What one tool invocation answered. */
export interface ExecResult {
  code: number
  stdout: Buffer
  stderr: string
}

export interface ExecRequest {
  argv: readonly string[]
  input?: Buffer | string
  timeoutMs?: number
  /** `ignore` when the tool must be able to outlive the pipes of this call. */
  stdio?: StdioMode
}

/** Where the toolchain runs. */
export interface X11Runner {
  readonly kind: RunnerKind
  /** Runs a binary and waits for it (the exit code is reported, never thrown). */
  run(request: ExecRequest): Promise<ExecResult>
  /** Starts a long-lived process in the background, answering its pid when it can. */
  background(argv: readonly string[]): Promise<number | undefined>
  /** Signals a pid of the target (SIGKILL by default). */
  kill(pid: number, signal?: string): Promise<void>
  /** True when a binary is executable in the target. */
  has(binary: string): Promise<boolean>
}

interface SpawnOptions {
  input?: Buffer | string
  timeoutMs?: number
  env?: Record<string, string>
  /** Default `capture`: read stdout/stderr. See `StdioMode`. */
  stdio?: StdioMode
}

/**
 * How a spawned tool may use the pipes of the driver.
 *
 * `capture` (default) reads stdout and stderr. `ignore` gives the process NO
 * captured pipe at all, which is what a tool that FORKS a long-lived descendant
 * needs: the descendant inherits the file descriptors of its parent, so a
 * captured pipe stays open after the parent exited - `xclip -i` hands the
 * selection to exactly such a fork.
 */
export type StdioMode = 'capture' | 'ignore'

/**
 * How long a process that ALREADY EXITED may keep its pipes open before the
 * output collected so far is answered. A tool whose descendant inherited the
 * pipes never closes them, so waiting for them would hang the call.
 */
export const EXIT_FLUSH_GRACE_MS = 250

/**
 * Spawns one process with no shell in between, bounded by a deadline.
 *
 * It settles on `exit` (the process is GONE), not on `close` (which also waits
 * for the stdio pipes): a forking tool leaves the pipes open in a child that
 * outlives it, and waiting for them used to keep `clipboard.write` pending far
 * past its deadline - which then killed the very process that owned the
 * selection, so the following paste could not see the value either.
 */
export function spawnExec(argv: readonly string[], options: SpawnOptions = {}): Promise<ExecResult> {
  const { input, timeoutMs, env, stdio = 'capture' } = options
  return new Promise<ExecResult>((resolve, reject) => {
    const [binary, ...args] = argv as string[]
    let child: ChildProcess
    try {
      child = spawn(binary ?? '', args, {
        env: env === undefined ? process.env : { ...process.env, ...env },
        stdio: stdio === 'ignore' ? ['pipe', 'ignore', 'ignore'] : ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(
        new ComputerUseError('computer-use.command-failed', `could not start '${binary}': ${error instanceof Error ? error.message : String(error)}`, {
          stage: 'target',
          details: { binary },
        }),
      )
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let settled = false
    let timedOut = false
    let exited = false
    let exitCode: number | null = null
    let pending = 0
    let timer: NodeJS.Timeout | undefined
    let grace: NodeJS.Timeout | undefined
    const stopTimers = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      if (grace !== undefined) clearTimeout(grace)
    }
    const answer = (): void => {
      if (settled) return
      settled = true
      stopTimers()
      // The pipes of a descendant that outlived its parent are not ours to wait
      // for: release them so no handle leaks per call.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ code: exitCode ?? -1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') })
    }
    const fail = (error: ComputerUseError): void => {
      if (settled) return
      settled = true
      stopTimers()
      reject(error)
    }
    const watch = (stream: NodeJS.ReadableStream | null | undefined, sink: Buffer[]): void => {
      if (stream === null || stream === undefined) return
      pending += 1
      stream.on('data', (chunk: Buffer) => sink.push(chunk))
      stream.on('error', () => undefined)
      stream.on('end', () => {
        pending -= 1
        if (exited && pending <= 0) answer()
      })
    }
    watch(child.stdout, stdout)
    watch(child.stderr, stderr)
    if (timeoutMs !== undefined && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGKILL')
        fail(
          new ComputerUseError('computer-use.timeout', `'${binary}' did not finish within ${timeoutMs} ms`, {
            stage: 'target',
            details: { binary, timeoutMs },
          }),
        )
      }, timeoutMs)
    }
    child.on('error', (error) => {
      fail(
        new ComputerUseError('computer-use.command-failed', `'${binary}' could not be executed: ${error.message}`, {
          stage: 'target',
          details: { binary, code: (error as NodeJS.ErrnoException).code },
        }),
      )
    })
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      if (settled || timedOut) return
      if (pending <= 0) {
        answer()
        return
      }
      grace = setTimeout(answer, EXIT_FLUSH_GRACE_MS)
      grace.unref()
    })
    // A tool that exits without reading its input must not crash the driver with
    // an unhandled EPIPE on the stdin pipe.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(input)
  })
}

/** Runs the toolchain where the workbench process runs. */
export class LocalX11Runner implements X11Runner {
  readonly kind: RunnerKind = 'local'
  private readonly environment: Record<string, string>

  constructor(environment: Record<string, string> = {}) {
    this.environment = environment
  }

  run(request: ExecRequest): Promise<ExecResult> {
    return spawnExec(request.argv, {
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.stdio === undefined ? {} : { stdio: request.stdio }),
      timeoutMs: request.timeoutMs,
      env: this.environment,
    })
  }

  async background(argv: readonly string[]): Promise<number | undefined> {
    const script = `${(argv as string[]).map(shellQuote).join(' ')} >/dev/null 2>&1 & echo $!`
    const result = await this.run({ argv: ['sh', '-c', script], timeoutMs: 10_000 })
    return numberOrUndefined(result.stdout.toString().trim())
  }

  async kill(pid: number, signal = 'SIGKILL'): Promise<void> {
    try {
      process.kill(pid, signal as NodeJS.Signals)
    } catch {
      // The process is already gone: killing again is a no-op, not a failure.
    }
  }

  async has(binary: string): Promise<boolean> {
    const result = await this.run({ argv: ['sh', '-c', `command -v ${shellQuote(binary)}`], timeoutMs: 5_000 })
    return result.code === 0 && result.stdout.toString().trim().length > 0
  }
}

/** Runs the toolchain inside a container (`docker exec`), so the target is disposable. */
export class DockerX11Runner implements X11Runner {
  readonly kind: RunnerKind = 'docker'
  private readonly container: string
  private readonly environment: Record<string, string>

  constructor(container: string, environment: Record<string, string> = {}) {
    this.container = container
    this.environment = environment
  }

  /** `docker exec -i [-e K=V ...] <container> <argv...>` */
  private wrap(argv: readonly string[], interactive: boolean): string[] {
    const args = ['exec']
    if (interactive) args.push('-i')
    for (const [key, value] of Object.entries(this.environment)) args.push('-e', `${key}=${value}`)
    args.push(this.container, ...(argv as string[]))
    return args
  }

  run(request: ExecRequest): Promise<ExecResult> {
    return spawnExec(this.wrap(request.argv, true), {
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.stdio === undefined ? {} : { stdio: request.stdio }),
      timeoutMs: request.timeoutMs,
    })
  }

  async background(argv: readonly string[]): Promise<number | undefined> {
    const script = `${(argv as string[]).map(shellQuote).join(' ')} >/dev/null 2>&1 & echo $!`
    const result = await this.run({ argv: ['sh', '-c', script], timeoutMs: 10_000 })
    return numberOrUndefined(result.stdout.toString().trim())
  }

  async kill(pid: number, signal = 'SIGKILL'): Promise<void> {
    // The pid lives INSIDE the container, so the signal must too.
    await spawnExec(['docker', 'exec', this.container, 'sh', '-c', `kill -${signal.replace(/^SIG/, '')} ${pid} 2>/dev/null || true`], {
      timeoutMs: 10_000,
    })
  }

  async has(binary: string): Promise<boolean> {
    const result = await this.run({ argv: ['sh', '-c', `command -v ${shellQuote(binary)}`], timeoutMs: 10_000 })
    return result.code === 0 && result.stdout.toString().trim().length > 0
  }
}

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

// ---------------------------------------------------------------------------
// Pure parsers: the output shapes of the X11 tools, pinned here so a unit test
// can assert them without a display.
// ---------------------------------------------------------------------------

/** The geometry `xdpyinfo` reports (`dimensions:` + `depth of root window:`). */
export function parseXdpyinfo(output: string): { width?: number; height?: number; depth?: number } {
  const dimensions = /dimensions:\s+(\d+)x(\d+)\s+pixels/.exec(output)
  const depth = /depth of root window:\s+(\d+)\s+planes/.exec(output)
  const parsed: { width?: number; height?: number; depth?: number } = {}
  if (dimensions !== null) {
    parsed.width = Number(dimensions[1])
    parsed.height = Number(dimensions[2])
  }
  if (depth !== null) parsed.depth = Number(depth[1])
  return parsed
}

/**
 * One `wmctrl -lpG` line:
 * `0x0040000c  0 81  271  253  484  316  host WB-Test`
 * (id, desktop, pid, x, y, w, h, host, title...).
 */
export function parseWmctrlLine(line: string): WindowInfo | undefined {
  const fields = line.trim().split(/\s+/)
  if (fields.length < 8) return undefined
  const [id, desktop, pid, x, y, width, height] = fields as [string, string, string, string, string, string, string]
  if (!/^0x[0-9a-fA-F]+$/.test(id)) return undefined
  const window: WindowInfo = {
    id,
    title: fields.slice(8).join(' '),
    geometry: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) },
  }
  const desktopNumber = Number(desktop)
  if (Number.isFinite(desktopNumber)) window.desktop = desktopNumber
  const pidNumber = Number(pid)
  if (Number.isFinite(pidNumber) && pidNumber > 0) window.pid = pidNumber
  return window
}

/** The `xdotool getwindowgeometry --shell` key=value output. */
export function parseXdotoolGeometry(output: string): ScreenRegion | undefined {
  const values = new Map<string, number>()
  for (const line of output.split('\n')) {
    const match = /^([A-Z]+)=(-?\d+)\s*$/.exec(line.trim())
    if (match !== null) values.set(match[1] as string, Number(match[2]))
  }
  const x = values.get('X')
  const y = values.get('Y')
  const width = values.get('WIDTH')
  const height = values.get('HEIGHT')
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
  return { x, y, width, height }
}

/** The `xdotool getmouselocation --shell` output (`X=`, `Y=`, `WINDOW=`). */
export function parseXdotoolPointer(output: string): PointerPosition | undefined {
  const x = /^X=(-?\d+)\s*$/m.exec(output)
  const y = /^Y=(-?\d+)\s*$/m.exec(output)
  if (x === null || y === null) return undefined
  return { x: Number(x[1]), y: Number(y[1]) }
}

/** The `xdotool` button number of a contract button (default: left). */
export function buttonNumber(button: MouseButton | undefined): number {
  return button === undefined ? BUTTON_NUMBERS.left : BUTTON_NUMBERS[button] ?? BUTTON_NUMBERS.left
}

/** A bounded sleep (the driver waits for the target, never for a caller). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/** The first non-empty line of a stderr (what an operator needs to see). */
function firstLine(text: string): string {
  const line = text.split('\n').map((value) => value.trim()).find((value) => value.length > 0)
  return line === undefined ? '' : line.slice(0, 400)
}

/** What a display probe answered. */
export interface DisplayProbe {
  reachable: boolean
  reason?: string
  width?: number
  height?: number
  depth?: number
}

// ---------------------------------------------------------------------------
// The driver.
// ---------------------------------------------------------------------------

/**
 * The X11 driver of the `computer-use@1` seam.
 *
 * It owns NO state of the desktop except the display it started itself: every
 * call probes the target, every answer is derived from real tool output, and
 * every unavailable action fails with a typed error naming the missing half.
 */
export class X11Provider implements ComputerUseProvider {
  readonly id = providerId
  readonly runner: RunnerKind
  readonly target: DisplayTarget
  display?: string

  private readonly config: NormalizedX11Config
  private readonly exec: X11Runner
  private readonly toolCache = new Map<string, boolean>()
  private readonly wmPids: number[] = []
  private displayPid?: number
  private startPromise?: Promise<ScreenInfo>
  private stopped = false
  private wmStarted = false
  private wmNote?: string
  private lastProbe?: DisplayProbe

  constructor(config: NormalizedX11Config, runner: X11Runner) {
    this.config = config
    this.exec = runner
    this.runner = config.runner
    this.target = config.target
    if (config.display !== undefined) this.display = config.display
  }

  // -- availability ---------------------------------------------------------

  available(): boolean {
    if (this.stopped) return false
    if (this.display === undefined) return false
    // An OWNED display is brought up on demand, so it is available as long as
    // the driver was not stopped; an EXISTING display is available unless a probe
    // already proved it is dead.
    if (this.config.target === 'existing' && this.lastProbe?.reachable === false) return false
    return true
  }

  unavailableReason(): string | undefined {
    if (this.stopped) return 'the driver was stopped by the caller (`computer close` without a window)'
    if (this.display === undefined) return 'no X display: set `display` in the plugin config or export DISPLAY'
    if (this.config.target === 'existing' && this.lastProbe?.reachable === false) {
      return this.lastProbe.reason ?? 'the configured display did not answer'
    }
    return undefined
  }

  notes(): string[] {
    const notes = [
      `runner: ${this.runner}${this.config.container === undefined ? '' : ` (container ${this.config.container})`}`,
      `target: ${this.target}`,
      `display: ${this.display ?? '(none)'}`,
      `screenshots are written by the driver to ${this.config.screenshotDir} (captured on stdout, so local and docker behave identically)`,
    ]
    if (this.target === 'xvfb') {
      notes.push(
        `owned display ${this.display ?? DEFAULT_XVFB_DISPLAY} ${this.config.width}x${this.config.height}x${this.config.depth}, window manager: ${this.config.windowManager}`,
      )
    }
    if (this.wmNote !== undefined) notes.push(this.wmNote)
    return notes
  }

  // -- probing --------------------------------------------------------------

  /** Probes the display NOW and records the result (used by `available()`). */
  async refreshProbe(): Promise<DisplayProbe> {
    const probe = await this.probeDisplay()
    this.lastProbe = probe
    return probe
  }

  /** Runs `xdpyinfo` against the configured display. Never throws: a probe ANSWER. */
  async probeDisplay(): Promise<DisplayProbe> {
    const display = this.display
    if (display === undefined) return { reachable: false, reason: 'no display name is configured' }
    if (!(await this.toolPresent('xdpyinfo'))) {
      return { reachable: false, reason: "the target has no 'xdpyinfo' binary (package x11-utils), which is how this driver probes a display" }
    }
    const result = await this.exec.run({ argv: ['xdpyinfo', '-display', display], timeoutMs: this.config.toolTimeoutMs })
    if (result.code !== 0) {
      return { reachable: false, reason: `${display}: ${firstLine(result.stderr) || `xdpyinfo exited ${result.code}`}` }
    }
    const parsed = parseXdpyinfo(result.stdout.toString())
    if (parsed.width === undefined || parsed.height === undefined) {
      return { reachable: false, reason: `${display}: xdpyinfo answered without a usable geometry` }
    }
    const probe: DisplayProbe = { reachable: true, width: parsed.width, height: parsed.height }
    if (parsed.depth !== undefined) probe.depth = parsed.depth
    return probe
  }

  /** Is a binary executable in the TARGET? (cached: the toolchain does not move) */
  async toolPresent(binary: string): Promise<boolean> {
    const cached = this.toolCache.get(binary)
    if (cached !== undefined) return cached
    const present = await this.exec.has(binary)
    this.toolCache.set(binary, present)
    return present
  }

  /** The toolchain of the target, one entry per binary this config needs. */
  async probeTools(refresh = false): Promise<ComputerUseToolStatus[]> {
    if (refresh) this.toolCache.clear()
    const statuses: ComputerUseToolStatus[] = []
    for (const spec of X11_TOOLS) {
      if (spec.forTarget !== undefined && spec.forTarget !== this.config.target) continue
      if (spec.forRunner !== undefined && spec.forRunner !== this.config.runner) continue
      statuses.push({ binary: spec.binary, package: spec.package, present: await this.toolPresent(spec.binary), usedFor: spec.usedFor })
    }
    for (const binary of this.config.extraTools) {
      statuses.push({ binary, package: 'config extraTools', present: await this.toolPresent(binary), usedFor: ['configured extra tool'] })
    }
    return statuses
  }

  // -- display lifecycle ----------------------------------------------------

  /** What this driver can really do NOW (never cached, never guessed). */
  async capabilities(): Promise<ComputerUseCapabilityReport> {
    const tools = await this.probeTools(true)
    const present = new Map(tools.map((tool) => [tool.binary, tool.present]))
    const has = (binary: string): boolean => present.get(binary) === true
    // An OWNED display is brought up ON DEMAND (`resolveDisplay`), so this report
    // must do the same: the documented first call of an agent is `computer open`,
    // and answering "no usable display" one call before the desktop works is a
    // false negative. A start failure is REPORTED through the typed reason
    // (this call answers a report, so it never throws for that).
    let startFailure: string | undefined
    if (this.config.target === 'xvfb' && !this.stopped) {
      try {
        await this.resolveDisplay()
      } catch (error) {
        startFailure = error instanceof Error ? error.message : String(error)
      }
    }
    const probe = await this.probeDisplay()
    this.lastProbe = probe
    const reachable = probe.reachable
    const reason = reachable ? undefined : startFailure ?? probe.reason
    const actions: Record<string, boolean> = {
      screen: reachable && has('xdpyinfo'),
      screenshot: reachable && has('import'),
      mouse: reachable && has('xdotool'),
      keyboard: reachable && has('xdotool'),
      clipboard: reachable && has('xclip'),
      windows: reachable && (has('wmctrl') || has('xdotool')),
      launch: reachable,
      wait: reachable,
      close: reachable || this.target === 'xvfb',
    }
    const needed: Record<string, string> = {
      screen: 'xdpyinfo',
      screenshot: 'import',
      mouse: 'xdotool',
      keyboard: 'xdotool',
      clipboard: 'xclip',
    }
    const unavailable: Array<{ action: string; reason: string; missing?: string }> = []
    for (const [action, ok] of Object.entries(actions)) {
      if (ok) continue
      if (!reachable) {
        unavailable.push({ action, reason: `no usable display at '${this.display ?? '(none)'}': ${reason ?? 'unknown reason'}` })
        continue
      }
      const missing = needed[action]
      if (missing !== undefined && !has(missing)) {
        unavailable.push({ action, reason: `the target has no '${missing}' binary (package ${packageOf(missing)})`, missing })
        continue
      }
      unavailable.push({ action, reason: 'the target cannot serve this action with the tools it has' })
    }
    const report: ComputerUseCapabilityReport = {
      provider: this.id,
      runner: this.runner,
      target: this.target,
      reachable,
      tools,
      actions,
      unavailable,
      notes: this.notes(),
    }
    if (this.display !== undefined) report.display = this.display
    if (!reachable && reason !== undefined) report.unreachableReason = reason
    if (reachable && probe.width !== undefined && probe.height !== undefined) {
      const screen: { width: number; height: number; depth?: number } = { width: probe.width, height: probe.height }
      if (probe.depth !== undefined) screen.depth = probe.depth
      report.screen = screen
    }
    return report
  }

  /** Brings an OWNED display up (idempotent) and reports its geometry. */
  async start(): Promise<ScreenInfo> {
    await this.resolveDisplay()
    return this.screenInfo()
  }

  /**
   * Releases the SESSION: the display and the window manager this driver started.
   * Attached (`target: existing`) drivers own nothing, so closing the session is
   * an explicit `not-implemented` instead of a fake success - the caller closes a
   * WINDOW instead.
   */
  async stop(): Promise<void> {
    if (this.config.target !== 'xvfb') {
      throw new ComputerUseError(
        'computer-use.not-implemented',
        'this driver ATTACHES to a display it does not own, so there is no session to close: close a window instead (computer close title=...)',
        { stage: 'close', details: { target: this.config.target } },
      )
    }
    await this.release()
  }

  /** Kills what the driver started, without forbidding a later call to start it again. */
  private async release(): Promise<void> {
    for (const pid of this.wmPids.splice(0)) await this.exec.kill(pid)
    const displayPid = this.displayPid
    this.displayPid = undefined
    if (displayPid !== undefined) {
      // SIGTERM FIRST: an X server removes its own /tmp/.X<n>-lock on a clean
      // exit, while SIGKILL leaves the lock behind and the NEXT start of that
      // display fails with "Server is already active for display n".
      await this.exec.kill(displayPid, 'SIGTERM')
      await delay(200)
      await this.exec.kill(displayPid)
    }
    this.startPromise = undefined
    this.wmStarted = false
  }

  /** The disposer of the plugin: never throws, always frees the display. */
  async dispose(): Promise<void> {
    try {
      await this.release()
    } finally {
      this.stopped = true
    }
  }

  // -- geometry -------------------------------------------------------------

  /** The geometry of the display, starting an OWNED one when needed. */
  private async resolveDisplay(): Promise<{ width: number; height: number; depth?: number }> {
    if (this.stopped) {
      throw new ComputerUseError('computer-use.provider-unavailable', 'the computer-use driver was stopped (the plugin was unloaded)', {
        stage: 'display',
        details: { provider: this.id },
      })
    }
    if (this.config.target === 'xvfb') {
      if (this.startPromise === undefined) this.startPromise = this.startManaged()
      const info = await this.startPromise
      return { width: info.width, height: info.height, ...(info.depth === undefined ? {} : { depth: info.depth }) }
    }
    const probe = await this.probeDisplay()
    this.lastProbe = probe
    if (!probe.reachable) {
      throw new ComputerUseError('computer-use.no-display', `no usable X display at '${this.display ?? '(none)'}': ${probe.reason ?? 'unknown reason'}`, {
        stage: 'display',
        details: { display: this.display, runner: this.runner, target: this.target, reason: probe.reason },
      })
    }
    return { width: probe.width as number, height: probe.height as number, ...(probe.depth === undefined ? {} : { depth: probe.depth }) }
  }

  /** Starts the owned Xvfb (and the WM) once, adopting an already-running display. */
  private async startManaged(): Promise<ScreenInfo> {
    const adopted = await this.probeDisplay()
    if (adopted.reachable) {
      this.lastProbe = adopted
      await this.startWindowManager()
      return this.screenInfoFrom(adopted)
    }
    if (!(await this.toolPresent('Xvfb'))) {
      throw new ComputerUseError(
        'computer-use.missing-tool',
        "the owned display (target: 'xvfb') needs the 'Xvfb' binary in the target (package xvfb); install it, or point the config at an existing display",
        { stage: 'display', details: { binary: 'Xvfb', package: 'xvfb', runner: this.runner, configRow: 'plugins.computer-use-x11' } },
      )
    }
    const display = this.display ?? DEFAULT_XVFB_DISPLAY
    // Xvfb REFUSES to start when the lock of a DEAD server is still there: a
    // killed display leaves /tmp/.X<n>-lock behind and the next start fails
    // with "Server is already active for display n". The lock holds the server
    // PID, so a lock whose process is GONE is a stale artifact of a display
    // THIS provider owns and is removed; a LIVE server is reported, never
    // touched.
    const lock = await this.reconcileLock(display)
    if (lock.state === 'busy') {
      throw new ComputerUseError(
        'computer-use.no-display',
        `the display '${display}' is already in use by the running X server ${lock.pid ?? '(pid unknown)'}: set the config 'display' to a free display`,
        { stage: 'display', details: { display, lock: lock.state, pid: lock.pid, runner: this.runner } },
      )
    }
    const argv = [
      'Xvfb',
      display,
      '-screen',
      '0',
      `${this.config.width}x${this.config.height}x${this.config.depth}`,
      // `-noreset`: the X server must NOT reset when the last client
      // disconnects. Every tool call is a SHORT-LIVED client (xdotool exits
      // after each command), and a reset moves the pointer back to the centre
      // of the screen and wipes the root state - so a `mousemove` would look
      // like a silent no-op on an owned, otherwise-idle display.
      '-noreset',
      '-nolisten',
      'tcp',
      '-ac',
      ...this.config.xvfbArgs,
    ]
    this.displayPid = await this.exec.background(argv)
    const deadline = Date.now() + DEFAULT_DISPLAY_WAIT_MS
    for (;;) {
      const probe = await this.probeDisplay()
      if (probe.reachable) {
        this.lastProbe = probe
        await this.startWindowManager()
        return this.screenInfoFrom(probe)
      }
      if (Date.now() >= deadline) {
        throw new ComputerUseError(
          'computer-use.timeout',
          `the Xvfb display '${display}' did not answer within ${DEFAULT_DISPLAY_WAIT_MS} ms: ${probe.reason ?? 'unknown reason'}`,
          { stage: 'display', details: { display, runner: this.runner, argv0: 'Xvfb', lock: lock.state } },
        )
      }
      await delay(200)
    }
  }

  /**
   * The state of the X lock of `display` (`/tmp/.X<n>-lock`), REMOVING it when
   * the server that wrote it is gone. Only a display this provider OWNS reaches
   * this point, so cleaning a lock left by a dead Xvfb is exactly what Xvfb
   * itself asks for ("remove /tmp/.X<n>-lock and start again"); a lock a LIVE
   * server holds is never touched.
   */
  private async reconcileLock(display: string): Promise<DisplayLockState> {
    const number = displayNumber(display)
    if (number === undefined) return { state: 'unknown', display }
    const script =
      'n=' + number + '; lock=/tmp/.X${n}-lock; sock=/tmp/.X11-unix/X${n}; ' +
      '[ -f "$lock" ] || { echo "state=absent"; exit 0; }; ' +
      'read pid < "$lock" 2>/dev/null; ' +
      'pid=$(printf "%s" "${pid:-}" | tr -dc "0-9"); ' +
      'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "state=busy pid=$pid"; exit 0; fi; ' +
      'rm -f "$lock" "$sock" 2>/dev/null; ' +
      'if [ -f "$lock" ]; then echo "state=unremovable pid=${pid:-none}"; exit 0; fi; ' +
      'echo "state=cleaned pid=${pid:-none}"'
    let stdout = ''
    try {
      const result = await this.exec.run({ argv: ['sh', '-c', script], timeoutMs: 10_000 })
      stdout = result.stdout.toString()
    } catch {
      return { state: 'unknown', display }
    }
    const state = /state=(absent|cleaned|busy|unremovable)/.exec(stdout)?.[1] as DisplayLockState['state'] | undefined
    if (state === undefined) return { state: 'unknown', display }
    const pid = /pid=(\d+)/.exec(stdout)?.[1]
    return pid === undefined ? { state, display } : { state, display, pid: Number(pid) }
  }

  /** Starts the configured WM on an owned display (a missing one is REPORTED). */
  private async startWindowManager(): Promise<void> {
    if (this.wmStarted || this.config.windowManager === 'none') return
    const binary = this.config.windowManager
    if (!(await this.toolPresent(binary))) {
      this.wmNote = `the window manager '${binary}' is not present in the target: window listing falls back to xdotool (no EWMH), and focus/close may be imprecise`
      return
    }
    const pid = await this.exec.background([binary])
    if (pid !== undefined) this.wmPids.push(pid)
    this.wmStarted = true
    await delay(300)
  }

  private screenInfoFrom(probe: DisplayProbe): ScreenInfo {
    const info: ScreenInfo = {
      width: probe.width as number,
      height: probe.height as number,
      provider: this.id,
      runner: this.runner,
      target: this.target,
    }
    if (probe.depth !== undefined) info.depth = probe.depth
    if (this.display !== undefined) info.display = this.display
    return info
  }

  async screenInfo(options: ComputerUseCallOptions = {}): Promise<ScreenInfo> {
    const screen = await this.resolveDisplay()
    const pointer = await this.pointerPositionOrUndefined(options)
    const info: ScreenInfo = {
      width: screen.width,
      height: screen.height,
      provider: this.id,
      runner: this.runner,
      target: this.target,
    }
    if (screen.depth !== undefined) info.depth = screen.depth
    if (this.display !== undefined) info.display = this.display
    if (pointer !== undefined) info.pointer = pointer
    return info
  }

  // -- screenshots ----------------------------------------------------------

  async screenshot(request: ScreenshotRequest, options: ComputerUseCallOptions = {}): Promise<ScreenshotAnswer> {
    await this.need('import', 'screenshot')
    const screen = await this.resolveDisplay()
    const format = resolveScreenshotFormat(request.format)
    const region = request.region === undefined ? undefined : clampRegion(request.region, screen).region
    const argv = ['import', '-window', 'root']
    if (region !== undefined) argv.push('-crop', `${region.width}x${region.height}+${region.x}+${region.y}`, '+repage')
    if (format === 'jpeg') argv.push('-quality', String(request.quality ?? 85))
    argv.push(`${format === 'jpeg' ? 'jpeg' : 'png'}:-`)
    const result = await this.run(argv, options)
    if (result.code !== 0) {
      throw new ComputerUseError(
        'computer-use.command-failed',
        `'import' failed to capture the display (exit ${result.code}): ${firstLine(result.stderr) || 'no stderr'}`,
        { stage: 'screenshot', details: { binary: 'import', code: result.code, stderr: firstLine(result.stderr) } },
      )
    }
    if (result.stdout.length === 0) {
      throw new ComputerUseError('computer-use.malformed-output', "'import' produced an EMPTY image: nothing was captured", {
        stage: 'screenshot',
        details: { binary: 'import' },
      })
    }
    const cap = options.maxImageBytes
    if (cap !== undefined && result.stdout.length > cap) {
      throw new ComputerUseError(
        'computer-use.oversized',
        `the screenshot is ${result.stdout.length} bytes, above the seam cap of ${cap} bytes: capture a region, use jpeg, or raise plugins.computer-use-impl.maxImageBytes`,
        { stage: 'screenshot', details: { bytes: result.stdout.length, maxBytes: cap } },
      )
    }
    const label = slugOf(request.label ?? 'screen')
    const extension = extensionOfFormat(format)
    const destination =
      str(request.path) ??
      path.join(options.screenshotDir ?? this.config.screenshotDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.${extension}`)
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await fs.writeFile(destination, result.stdout)
    const answer: ScreenshotAnswer = {
      path: destination,
      mime: mimeOfFormat(format),
      bytes: result.stdout.length,
      format,
      width: region?.width ?? screen.width,
      height: region?.height ?? screen.height,
      provider: this.id,
      truncated: false,
    }
    if (region !== undefined) answer.region = region
    if (this.display !== undefined) answer.display = this.display
    return answer
  }

  // -- pointer --------------------------------------------------------------

  async pointerPosition(options: ComputerUseCallOptions = {}): Promise<PointerPosition> {
    await this.need('xdotool', 'mouse.position')
    const result = await this.ok(['xdotool', 'getmouselocation', '--shell'], 'mouse.position', options)
    const pointer = parseXdotoolPointer(result.stdout.toString())
    if (pointer === undefined) {
      throw new ComputerUseError('computer-use.malformed-output', "'xdotool getmouselocation' answered no usable position", {
        stage: 'pointer',
        details: { output: result.stdout.toString().slice(0, 200) },
      })
    }
    return pointer
  }

  private async pointerPositionOrUndefined(options: ComputerUseCallOptions): Promise<PointerPosition | undefined> {
    if (!(await this.toolPresent('xdotool'))) return undefined
    try {
      return await this.pointerPosition(options)
    } catch {
      return undefined
    }
  }

  /** Moves the pointer, interpolating when a duration is asked for. */
  private async moveTo(x: number, y: number, durationMs: number, options: ComputerUseCallOptions): Promise<void> {
    const steps = durationMs > 0 ? Math.min(20, Math.max(2, Math.round(durationMs / 50))) : 1
    if (steps === 1) {
      await this.ok(['xdotool', 'mousemove', String(x), String(y)], 'mouse.move', options)
      return
    }
    const from = (await this.pointerPositionOrUndefined(options)) ?? { x, y }
    for (let step = 1; step <= steps; step += 1) {
      const px = Math.round(from.x + ((x - from.x) * step) / steps)
      const py = Math.round(from.y + ((y - from.y) * step) / steps)
      await this.ok(['xdotool', 'mousemove', String(px), String(py)], 'mouse.move', options)
      await delay(Math.max(1, Math.round(durationMs / steps)))
    }
  }

  async mouseMove(request: MouseMoveRequest, options: ComputerUseCallOptions = {}): Promise<InputAnswer> {
    await this.need('xdotool', 'mouse.move')
    await this.moveTo(request.x, request.y, request.durationMs ?? 0, options)
    const pointer = await this.pointerPositionOrUndefined(options)
    const answer: InputAnswer = { action: 'mouse.move', detail: `moved the pointer to ${request.x},${request.y}` }
    if (pointer !== undefined) answer.pointer = pointer
    return answer
  }

  async mouseClick(request: MouseClickRequest, options: ComputerUseCallOptions = {}): Promise<InputAnswer> {
    await this.need('xdotool', 'mouse.click')
    if (request.x !== undefined && request.y !== undefined) {
      await this.ok(['xdotool', 'mousemove', String(request.x), String(request.y)], 'mouse.click', options)
    }
    const argv = ['xdotool', 'click', '--repeat', String(request.clicks ?? 1)]
    if (request.delayMs !== undefined) argv.push('--delay', String(request.delayMs))
    argv.push(String(buttonNumber(request.button)))
    await this.ok(argv, 'mouse.click', options)
    const pointer = await this.pointerPositionOrUndefined(options)
    const answer: InputAnswer = {
      action: 'mouse.click',
      detail: `clicked ${request.button ?? 'left'} x${request.clicks ?? 1}`,
    }
    if (pointer !== undefined) answer.pointer = pointer
    return answer
  }

  async mouseDrag(request: MouseDragRequest, options: ComputerUseCallOptions = {}): Promise<InputAnswer> {
    await this.need('xdotool', 'mouse.drag')
    const button = buttonNumber(request.button)
    await this.ok(['xdotool', 'mousemove', String(request.from.x), String(request.from.y)], 'mouse.drag', options)
    await this.ok(['xdotool', 'mousedown', String(button)], 'mouse.drag', options)
    try {
      const durationMs = request.durationMs ?? 0
      const steps = durationMs > 0 ? Math.min(20, Math.max(2, Math.round(durationMs / 50))) : 1
      for (let step = 1; step <= steps; step += 1) {
        const px = Math.round(request.from.x + ((request.to.x - request.from.x) * step) / steps)
        const py = Math.round(request.from.y + ((request.to.y - request.from.y) * step) / steps)
        await this.ok(['xdotool', 'mousemove', String(px), String(py)], 'mouse.drag', options)
        if (steps > 1) await delay(Math.max(1, Math.round(durationMs / steps)))
      }
    } finally {
      // The button is released even when a movement failed: a stuck button would
      // corrupt every later call of the session.
      await this.ok(['xdotool', 'mouseup', String(button)], 'mouse.drag', options)
    }
    return {
      action: 'mouse.drag',
      detail: `dragged from ${request.from.x},${request.from.y} to ${request.to.x},${request.to.y} with button ${request.button ?? 'left'}`,
    }
  }

  async mouseScroll(request: MouseScrollRequest, options: ComputerUseCallOptions = {}): Promise<InputAnswer> {
    await this.need('xdotool', 'mouse.scroll')
    if (request.x !== undefined && request.y !== undefined) {
      await this.ok(['xdotool', 'mousemove', String(request.x), String(request.y)], 'mouse.scroll', options)
    }
    const direction = request.direction ?? 'down'
    const button = SCROLL_BUTTONS[direction] ?? SCROLL_BUTTONS.down
    await this.ok(['xdotool', 'click', '--repeat', String(request.amount ?? 3), String(button)], 'mouse.scroll', options)
    return { action: 'mouse.scroll', detail: `scrolled ${direction} x${request.amount ?? 3}` }
  }

  // -- keyboard -------------------------------------------------------------

  async typeText(request: KeyboardTypeRequest, options: ComputerUseCallOptions = {}): Promise<InputAnswer> {
    await this.need('xdotool', 'keyboard.type')
    const delayMs = request.delayMs ?? this.config.typeDelayMs
    await this.ok(['xdotool', 'type', '--delay', String(delayMs), '--', request.text], 'keyboard.type', options)
    return { action: 'keyboard.type', detail: `typed ${request.text.length} character(s) with a ${delayMs} ms keystroke delay` }
  }

  async pressKey(request: KeyboardKeyRequest, options: ComputerUseCallOptions = {}): Promise<InputAnswer> {
    await this.need('xdotool', 'keyboard.key')
    const action = request.action ?? 'press'
    const verb = action === 'press' ? 'key' : action === 'down' ? 'keydown' : 'keyup'
    await this.ok(['xdotool', verb, request.chord], 'keyboard.key', options)
    return { action: 'keyboard.key', detail: `${verb} ${request.chord}` }
  }

  // -- clipboard ------------------------------------------------------------

  async clipboard(request: ClipboardRequest, options: ComputerUseCallOptions = {}): Promise<ClipboardAnswer> {
    await this.need('xclip', 'clipboard')
    // The clipboard is served by an X client (xclip), so it needs the display
    // exactly like a screenshot does: on an OWNED display this starts it. Without
    // this step the FIRST action of a process was `xclip: Can't open display`.
    await this.resolveDisplay()
    const selection = request.selection ?? 'clipboard'
    if (request.text !== undefined) {
      // `stdio: 'ignore'`: writing hands the selection to a FORKED child that
      // inherits the pipes of its parent, so captured stdout would stay open
      // after xclip exited and would keep this call pending. The exit code is
      // still reported, which is what a failed write needs.
      await this.ok(['xclip', '-selection', selection, '-i'], 'clipboard.write', options, Buffer.from(request.text, 'utf8'), 'ignore')
      return {
        selection,
        text: '',
        bytes: Buffer.byteLength(request.text, 'utf8'),
        truncated: false,
        action: 'clipboard.write',
      }
    }
    const result = await this.ok(['xclip', '-selection', selection, '-o'], 'clipboard.read', options)
    return {
      selection,
      text: result.stdout.toString('utf8'),
      bytes: result.stdout.length,
      truncated: false,
      action: 'clipboard.read',
    }
  }

  // -- windows --------------------------------------------------------------

  /** Every window of the target, with its id, title, geometry and active flag. */
  async listWindows(options: ComputerUseCallOptions = {}): Promise<WindowInfo[]> {
    await this.resolveDisplay()
    const windows: WindowInfo[] = []
    const active = await this.activeWindowId(options)
    if (await this.toolPresent('wmctrl')) {
      const result = await this.run(['wmctrl', '-lpG'], options)
      if (result.code === 0) {
        for (const line of result.stdout.toString().split('\n')) {
          const window = parseWmctrlLine(line)
          if (window === undefined) continue
          if (active !== undefined && Number.parseInt(window.id, 16) === active) window.active = true
          windows.push(window)
        }
      }
    }
    // No EWMH client (no window manager, or wmctrl absent): ask X directly. The
    // fallback is REPORTED, never silent (see `wmNote`).
    if (windows.length === 0 && (await this.toolPresent('xdotool'))) {
      const found = await this.run(['xdotool', 'search', '--onlyvisible', '--name', '.*'], options)
      const ids = found.stdout.toString().split('\n').map((value) => value.trim()).filter((value) => value.length > 0)
      for (const id of ids.slice(0, 50)) {
        const title = await this.run(['xdotool', 'getwindowname', id], options)
        if (title.code !== 0) continue
        const geometry = await this.run(['xdotool', 'getwindowgeometry', '--shell', id], options)
        const window: WindowInfo = { id, title: title.stdout.toString().trim() }
        const parsed = parseXdotoolGeometry(geometry.stdout.toString())
        if (parsed !== undefined) window.geometry = parsed
        if (active !== undefined && Number.parseInt(id, 10) === active) window.active = true
        windows.push(window)
      }
      if (windows.length > 0 && this.wmNote === undefined) {
        this.wmNote = 'windows were listed through xdotool, not wmctrl: no EWMH window manager is running on this display'
      }
    }
    return windows
  }

  private async activeWindowId(options: ComputerUseCallOptions): Promise<number | undefined> {
    if (!(await this.toolPresent('xdotool'))) return undefined
    const result = await this.run(['xdotool', 'getactivewindow'], options)
    if (result.code !== 0) return undefined
    const id = Number.parseInt(result.stdout.toString().trim(), 10)
    return Number.isFinite(id) ? id : undefined
  }

  /** The window a request names, or undefined when none matches. */
  matchWindow(windows: readonly WindowInfo[], request: WindowRequest): WindowInfo | undefined {
    const id = str(request.id)
    if (id !== undefined) {
      const wanted = id.toLowerCase()
      const asNumber = Number.parseInt(wanted.startsWith('0x') ? wanted.slice(2) : wanted, 16)
      return windows.find(
        (window) => window.id.toLowerCase() === wanted || (Number.isFinite(asNumber) && Number.parseInt(window.id, 16) === asNumber),
      )
    }
    const title = str(request.title)
    if (title === undefined) return undefined
    const needle = title.toLowerCase()
    return windows.find((window) => window.title.toLowerCase().includes(needle))
  }

  async windows(request: WindowRequest, options: ComputerUseCallOptions = {}): Promise<WindowAnswer> {
    const action = request.action ?? 'list'
    let list = await this.listWindows(options)
    if (action === 'list') return { action: 'list', windows: list, detail: `${list.length} window(s) on ${this.display ?? '(no display)'}` }
    const target = this.matchWindow(list, request)
    if (target === undefined) {
      throw new ComputerUseError(
        'computer-use.invalid-input',
        `no window matches ${describeWindowQuery(request)} on this display (${list.length} window(s) listed)`,
        { stage: 'window', details: { action, title: request.title, id: request.id, windows: list.map((window) => window.title) } },
      )
    }
    if (action === 'focus') {
      if (await this.toolPresent('wmctrl')) {
        await this.ok(['wmctrl', '-i', '-a', target.id], 'window.focus', options)
      } else {
        await this.ok(['xdotool', 'windowactivate', String(Number.parseInt(target.id, 16))], 'window.focus', options)
        await this.run(['xdotool', 'windowraise', String(Number.parseInt(target.id, 16))], options)
      }
      list = await this.listWindows(options)
      const refreshed = list.find((window) => window.id === target.id)
      return {
        action: 'focus',
        windows: list,
        window: refreshed ?? target,
        detail: `focused '${target.title}' (${target.id})${refreshed?.active === true ? '' : ' (the display did not confirm it as active)'}`,
      }
    }
    if (action === 'close') {
      if (await this.toolPresent('wmctrl')) {
        await this.ok(['wmctrl', '-i', '-c', target.id], 'window.close', options)
      } else {
        // A close without a WM is a client-message kill: xdotool can only ask the
        // client to exit, which is exactly what `wmctrl -c` does through EWMH.
        await this.ok(['xdotool', 'windowkill', String(Number.parseInt(target.id, 16))], 'window.close', options)
      }
      const after = await this.listWindows(options)
      const gone = after.every((window) => window.id !== target.id)
      return {
        action: 'close',
        windows: after,
        window: target,
        detail: gone ? `closed '${target.title}' (${target.id})` : `asked '${target.title}' (${target.id}) to close; it is still listed`,
      }
    }
    return { action, windows: [target], window: target, detail: `${action} '${target.title}' (${target.id})` }
  }

  async launch(request: LaunchRequest, options: ComputerUseCallOptions = {}): Promise<WindowAnswer> {
    const argv = [request.command, ...(request.args ?? [])]
    const pid = await this.exec.background(argv)
    const started = `started '${request.command}'${pid === undefined ? '' : ` (pid ${pid})`} on ${this.display ?? 'the target'}`
    if (request.waitTitle === undefined) {
      const answer: WindowAnswer = { action: 'launch', windows: [], detail: started }
      if (pid !== undefined) answer.pid = pid
      return answer
    }
    const timeoutMs = request.timeoutMs ?? this.config.toolTimeoutMs
    const found = await this.waitForWindow(request.waitTitle, timeoutMs, options)
    if (found.window === undefined) {
      throw new ComputerUseError(
        'computer-use.timeout',
        `${started}, but no window whose title contains '${request.waitTitle}' appeared within ${timeoutMs} ms`,
        { stage: 'window.launch', details: { command: request.command, waitTitle: request.waitTitle, timeoutMs } },
      )
    }
    const answer: WindowAnswer = {
      action: 'launch',
      windows: found.windows,
      window: found.window,
      pid: found.window.pid ?? pid,
      detail: `${started}; window '${found.window.title}' is up`,
    }
    return answer
  }

  async wait(request: WaitRequest, options: ComputerUseCallOptions = {}): Promise<WindowAnswer> {
    if (request.title !== undefined) {
      const timeoutMs = request.timeoutMs ?? this.config.toolTimeoutMs
      const found = await this.waitForWindow(request.title, timeoutMs, options)
      if (found.window === undefined) {
        throw new ComputerUseError(
          'computer-use.timeout',
          `no window whose title contains '${request.title}' appeared within ${timeoutMs} ms`,
          { stage: 'window.wait', details: { title: request.title, timeoutMs, windows: found.windows.map((window) => window.title) } },
        )
      }
      return { action: 'wait', windows: found.windows, window: found.window, detail: `window '${found.window.title}' appeared` }
    }
    const ms = request.ms ?? 0
    await delay(ms)
    return { action: 'wait', windows: [], detail: `waited ${ms} ms` }
  }

  private async waitForWindow(
    title: string,
    timeoutMs: number,
    options: ComputerUseCallOptions,
  ): Promise<{ windows: WindowInfo[]; window?: WindowInfo }> {
    const needle = title.toLowerCase()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const windows = await this.listWindows(options)
      const window = windows.find((candidate) => candidate.title.toLowerCase().includes(needle))
      if (window !== undefined) return { windows, window }
      if (Date.now() >= deadline) return { windows }
      await delay(300)
    }
  }

  // -- tool plumbing --------------------------------------------------------

  /** Runs a tool with the bounds of the call (no shell is ever involved). */
  private run(
    argv: readonly string[],
    options: ComputerUseCallOptions = {},
    input?: Buffer | string,
    stdio?: StdioMode,
  ): Promise<ExecResult> {
    return this.exec.run({
      argv,
      ...(input === undefined ? {} : { input }),
      ...(stdio === undefined ? {} : { stdio }),
      timeoutMs: options.timeoutMs ?? this.config.toolTimeoutMs,
    })
  }

  /** Runs a tool that MUST succeed; a non-zero exit becomes a typed error. */
  private async ok(
    argv: readonly string[],
    action: string,
    options: ComputerUseCallOptions = {},
    input?: Buffer | string,
    stdio?: StdioMode,
  ): Promise<ExecResult> {
    const result = await this.run(argv, options, input, stdio)
    if (result.code !== 0) {
      throw new ComputerUseError(
        'computer-use.command-failed',
        `'${argv[0]}' failed for '${action}' (exit ${result.code}): ${firstLine(result.stderr) || 'no stderr'}`,
        {
          stage: 'target',
          details: {
            action,
            binary: argv[0],
            code: result.code,
            stderr: firstLine(result.stderr),
            stdout: result.stdout.toString('utf8').slice(0, 400),
          },
        },
      )
    }
    return result
  }

  /** Refuses an action whose binary the TARGET does not have (typed, with package). */
  private async need(binary: string, action: string): Promise<void> {
    if (await this.toolPresent(binary)) return
    throw new ComputerUseError(
      'computer-use.missing-tool',
      `'${action}' needs the '${binary}' binary in the target (package ${packageOf(binary)}); the target is the ${this.runner} runner${this.config.container === undefined ? '' : ` (container ${this.config.container})`}`,
      {
        stage: 'tool',
        details: { action, binary, package: packageOf(binary), runner: this.runner, configRow: 'plugins.computer-use-x11' },
      },
    )
  }
}

/** The package hint of a tool binary, from the one tool table. */
function packageOf(binary: string): string {
  return X11_TOOLS.find((spec) => spec.binary === binary)?.package ?? 'unknown'
}

/** A readable description of the window a request named (for error details). */
function describeWindowQuery(request: WindowRequest): string {
  if (request.id !== undefined) return `window id '${request.id}'`
  if (request.title !== undefined) return `a window whose title contains '${request.title}'`
  return 'the request (no title and no id)'
}

// ---------------------------------------------------------------------------
// Plugin wiring.
// ---------------------------------------------------------------------------

/** The context this plugin needs: a cordis ctx plus the definition helpers. */
interface PluginContext {
  effect?(callback: () => () => void): unknown
  inject?(names: readonly string[], callback: (ctx: ServiceContext) => void): unknown
  logger?: { warn?: (message: string, ...args: unknown[]) => void }
  get?(name: string, strict?: boolean): unknown
}

/**
 * Builds the driver. Synchronous on purpose: the plugin registers itself during
 * `apply`, so the cordis disposer that kills an owned display is ALWAYS
 * registered. Probing is lazy (and `refreshProbe()` is fired and reported).
 */
export function createX11Provider(config: X11Config = {}): X11Provider {
  const normalized = validateX11Config(config)
  if (normalized.runner === 'docker' && normalized.container === undefined) {
    throw new ComputerUseError('computer-use.invalid-input', "the 'docker' runner needs 'container' in the plugin config", {
      stage: 'config',
      details: { row: 'plugins.computer-use-x11', runner: normalized.runner },
    })
  }
  const environment: Record<string, string> = normalized.display === undefined ? {} : { DISPLAY: normalized.display }
  const runner: X11Runner =
    normalized.runner === 'docker' ? new DockerX11Runner(normalized.container as string, environment) : new LocalX11Runner(environment)
  return new X11Provider(normalized, runner)
}

/**
 * Registers the X11 driver with the `computer-use@1` service. The dependency is
 * declared with `ctx.inject`, so the driver may be applied BEFORE the service
 * host (and is inert in a deployment without one).
 */
export function apply(ctx: PluginContext, config: X11Config = {}): void {
  // The driver runs binaries (xdotool, import, Xvfb, ...), so it must declare the
  // execution policy before it can be loaded.
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [COMPUTER_USE] })
  const attach = (target: ServiceContext): void => {
    const service = serviceOf<ComputerUseService>(target, COMPUTER_USE)
    if (service === undefined) return
    let provider: X11Provider
    try {
      provider = createX11Provider(config)
    } catch (error) {
      ctx.logger?.warn?.(`computer-use-x11: ${error instanceof Error ? error.message : String(error)}`, 'computer-use-x11')
      return
    }
    const unregister = service.register(provider)
    ctx.effect?.(() => () => {
      unregister()
      void provider.dispose()
    })
    // Probe once, in the background: `available()` and the first selection then
    // report the REAL state of the display without blocking the boot.
    void provider.refreshProbe().then((probe) => {
      if (!probe.reachable) {
        ctx.logger?.warn?.(
          `computer-use-x11: display '${provider.display ?? '(none)'}' is not reachable yet (${probe.reason ?? 'unknown'}); ` +
            `the driver stays registered and every call fails with a typed error until it answers (config row: plugins.computer-use-x11)`,
          'computer-use-x11',
        )
      }
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject([COMPUTER_USE], (injected) => attach(injected))
  else attach(ctx as unknown as ServiceContext)
}

export default { name, inject: [], apply }
