// core/browser-use-playwright/frames - FRAMES, COORDINATE MOUSE and CHALLENGES.
//
// WHY THIS MODULE EXISTS (measured, not theoretical):
//
//   * The interesting half of a real page is often in a CROSS-ORIGIN IFRAME. A
//     Turnstile widget (`challenges.cloudflare.com`), an hCaptcha box, an
//     embedded payment form: `act { selector: 'iframe[src*=challenges...]' }`
//     resolves the ELEMENT in the main document, but nothing inside it is
//     reachable from there - the interaction has to happen INSIDE the frame.
//   * A widget that has no addressable element at all still has PIXELS, so the
//     only honest fallback is the real mouse at coordinates (`page.mouse`), which
//     goes through the same input pipeline a human click uses.
//   * A Cloudflare-protected page has three very different outcomes that a
//     caller MUST be able to tell apart: a MANAGED challenge the browser passes
//     on its own (`cf_clearance` appears, the caller gets the real page), an
//     INTERACTIVE widget that needs a click, and a HARD IP-REPUTATION BLOCK
//     (HTTP 403, "Just a moment...", "unusual traffic patterns detected ... you
//     have been temporarily blocked") where there is NO challenge to solve and
//     no amount of browser realism changes anything. The last one must be
//     REPORTED, never turned into a silent empty read.
//
// HONESTY: the classification is derived from signals that are READ from the
// live document (status, title, body markers, frame urls, the response token,
// the `cf_clearance` cookie) and every signal is echoed in `signals`, so a
// caller can audit the verdict. NO stealth fingerprint spoofing is used or
// needed: this is a real Chromium driven through CDP.
import type { CDPSession, ElementHandle, Frame, Locator, Page } from 'playwright-core'
import {
  BrowserUseError,
  CHALLENGE_ACTIONS,
  CHALLENGE_KINDS,
  CHALLENGE_TOKEN_FIELDS,
  MOUSE_ACTIONS,
  MOUSE_BUTTONS,
  MOUSE_ORIGINS,
  requireEnum,
  requireNonNegativeInt,
  requirePositiveInt,
  requireText,
  type BrowserChallengeAnswer,
  type BrowserChallengeRequest,
  type BrowserChallengeWidget,
  type BrowserFrameInfo,
  type BrowserFrameTarget,
  type BrowserMouseRequest,
  type ChallengeClassification,
  type ChallengeKind,
  type ChallengeOutcome,
  type MouseAction,
  type MouseButton,
  type MouseOrigin,
} from '../../definitions/browser-use.ts'

// ---------------------------------------------------------------------------
// The widget vocabulary: which frame URL belongs to which challenge.
// ---------------------------------------------------------------------------

/** The frame URL patterns of the known widgets (first match wins). */
export const WIDGET_FRAME_PATTERNS: readonly { kind: ChallengeKind; pattern: RegExp }[] = [
  { kind: 'turnstile', pattern: /challenges\.cloudflare\.com|challenge-platform|turnstile/i },
  { kind: 'hcaptcha', pattern: /hcaptcha\.com|newassets\.hcaptcha\.com/i },
  { kind: 'recaptcha', pattern: /google\.com\/recaptcha|gstatic\.com\/recaptcha|recaptcha\/api/i },
]

/** The kind of widget a frame URL belongs to (`unknown` when it is neither). */
export function kindOfFrameUrl(url: string): ChallengeKind | undefined {
  for (const entry of WIDGET_FRAME_PATTERNS) if (entry.pattern.test(url)) return entry.kind
  return undefined
}

/**
 * True when a widget frame is INTERACTION-FREE (the `auto`/`invisible` variants).
 * Cloudflare renders those on a page that has ALREADY passed, so they are
 * reported but never make a document `interactive` - there is nothing to click.
 * Measured on https://nowsecure.nl: a rendered page (HTTP 200, real title),
 * `cf_clearance` present, two `/auto/...` turnstile frames. Classifying that page
 * `interactive/unsolved` was the false negative this helper fixes.
 */
export function isInvisibleWidgetUrl(url: string): boolean {
  return /\/auto\//i.test(url) || /(?:^|[?&])size=invisible/i.test(url) || /\/invisible\//i.test(url)
}

/**
 * The hard IP-reputation refusal. These markers mean "this address is refused";
 * there is NO widget to click, so the only honest answer is
 * `blocked-ip` / `unsolvable-from-this-ip`.
 */
export const HARD_BLOCK_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'unusual-traffic', pattern: /unusual traffic patterns detected/i },
  { id: 'non-human-interaction', pattern: /non-human interaction/i },
  { id: 'temporarily-blocked', pattern: /you have been temporary(?:ily)? blocked/i },
  { id: 'blocked-by-cloudflare', pattern: /(?:error\s*)?1020|access denied[^<]{0,40}cloudflare/i },
  { id: 'ray-id-denied', pattern: /ray id[^<]{0,120}(?:blocked|denied|restricted)/i },
]

/** The markers of a challenge/interstitial DOCUMENT (no widget frame yet). */
export const CHALLENGE_PAGE_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'just-a-moment', pattern: /just a moment/i },
  { id: 'challenge-platform-script', pattern: /cdn-cgi\/challenge-platform/i },
  { id: 'cf-chl', pattern: /cf-chl|cf_chl_/i },
  { id: 'enable-js-cookies', pattern: /enable javascript and cookies to continue/i },
  { id: 'checking-your-browser', pattern: /checking your browser/i },
]

/**
 * The elements tried INSIDE a widget frame, in order, to find the clickable
 * checkbox. The list is deliberately explicit: each entry was seen in a real
 * widget markup, and the last resort is a PIXEL click on the widget box (below)
 * when no element resolves at all.
 */
export const WIDGET_CLICK_SELECTORS: readonly string[] = [
  'input[type="checkbox"]',
  'label.cb-lb',
  '.cb-lb input',
  '#cf-stage input[type="checkbox"]',
  '[role="checkbox"]',
  '#challenge-stage input',
  '.ctp-checkbox-label',
  '#anchor-state',
  'div.cb-c',
  '#cf-stage',
]

/** The offset of the checkbox inside a Turnstile widget box (its own layout). */
const WIDGET_CHECKBOX_OFFSET = 30

// ---------------------------------------------------------------------------
// Classification (PURE: no browser, so it is unit-testable).
// ---------------------------------------------------------------------------

/** Everything the classifier reads from a live document. */
export interface ChallengeDocument {
  url: string
  title: string
  /** The main document's HTML, already bounded by the caller. */
  html: string
  /**
   * The main document's VISIBLE text, already bounded by the caller. The refusal
   * of a block page is often in the text while the HTML excerpt is a script
   * (measured on downdetector.com.br: "Unusual traffic patterns detected" and
   * "non-human interaction" live in `innerText`), so the markers are matched
   * against HTML + text, never HTML alone.
   */
  text?: string
  /** The HTTP status of the main document, when the engine reported one. */
  httpStatus?: number
  /** True when the `cf_clearance` cookie is present in the context. */
  cfClearance: boolean
  /** True when a response token is present and NON-EMPTY. */
  tokenPresent: boolean
  /** The field the token was found in, when one was. */
  tokenField?: string
  /** True when a widget frame reported its own solved state. */
  widgetReportedSuccess?: boolean
  /** The challenge frames currently in the page. */
  challengeFrames: { frameId: string; url: string; kind: ChallengeKind }[]
}

/** The verdict of {@link classifyChallengeDocument}. */
export interface ChallengeVerdict {
  classification: ChallengeClassification
  outcome: ChallengeOutcome
  reason: string
  signals: string[]
  unsolvableFromThisIp: boolean
}

/**
 * Classifies a document from the signals it really carries. The ORDER of the
 * checks IS the design: a hard refusal is decided FIRST, because a block page
 * also says "Just a moment..." and would otherwise be mistaken for a solvable
 * challenge (that is exactly the misclassification this module exists to fix).
 */
export function classifyChallengeDocument(document: ChallengeDocument): ChallengeVerdict {
  const body = document.html
  // Markers are matched against the HTML AND the visible text: a block page
  // hides its refusal in the rendered text while the HTML excerpt is a script.
  const corpus = document.text === undefined || document.text.length === 0 ? body : `${body}\n${document.text}`
  const signals: string[] = [
    `url=${document.url}`,
    `title=${JSON.stringify(document.title)}`,
    `httpStatus=${document.httpStatus === undefined ? 'unknown' : String(document.httpStatus)}`,
    `challengeFrames=${String(document.challengeFrames.length)}`,
    `cf_clearance=${document.cfClearance ? 'present' : 'absent'}`,
    `token=${document.tokenPresent ? `present${document.tokenField === undefined ? '' : `:${document.tokenField}`}` : 'absent'}`,
  ]

  // 1. A HARD refusal: no challenge to solve, this address is refused.
  const hard = HARD_BLOCK_PATTERNS.filter((entry) => entry.pattern.test(corpus))
  if (hard.length > 0) {
    for (const entry of hard) signals.push(`hard-block:${entry.id}`)
    const status = document.httpStatus === undefined ? 'unknown' : String(document.httpStatus)
    return {
      classification: 'blocked-ip',
      outcome: 'unsolvable-from-this-ip',
      reason:
        `the page refused this address (HTTP ${status}, title "${document.title}", no solvable challenge) - ` +
        `the body names ${hard.map((entry) => entry.id).join(', ')}: this is an IP/edge reputation block, not a Turnstile widget, ` +
        'so no browser interaction can pass it from this address',
      signals,
      unsolvableFromThisIp: true,
    }
  }

  // 2. A VISIBLE widget is ON SCREEN: it needs an interaction (or it was
  //    already solved). An invisible frame is reported as a signal and then the
  //    classification continues on the OTHER signals: a page carrying only
  //    interaction-free widgets has nothing to click (`managed-pass` when the
  //    clearance cookie is present, `none` when there is nothing at all).
  const frames = document.challengeFrames
  const invisible = frames.filter((frame) => isInvisibleWidgetUrl(frame.url))
  for (const frame of invisible) signals.push(`invisible-widget:${frame.kind}:${frame.url}`)
  const visibleFrames = frames.filter((frame) => !isInvisibleWidgetUrl(frame.url))
  if (visibleFrames.length > 0) {
    for (const frame of visibleFrames) signals.push(`challenge-frame:${frame.kind}:${frame.url}`)
    const solved = document.tokenPresent || document.widgetReportedSuccess === true
    const kinds = [...new Set(visibleFrames.map((frame) => frame.kind))].join(', ')
    if (document.widgetReportedSuccess === true) signals.push('widget-reported-success')
    const suffix =
      invisible.length === 0 ? '' : ` (the page also carries ${invisible.length} interaction-free widget frame(s))`
    return {
      classification: 'interactive',
      outcome: solved ? 'solved' : 'unsolved',
      reason:
        (solved
          ? `a ${kinds} widget is present and reports a solved state (token or success marker)`
          : `a ${kinds} widget is present and needs a mouse interaction: target its frame and click its checkbox`) + suffix,
      signals,
      unsolvableFromThisIp: false,
    }
  }

  // 3. A response token without any widget frame: an invisible/managed widget
  //    already produced its token, the caller can use the page.
  if (document.tokenPresent) {
    signals.push('token-without-widget')
    return {
      classification: 'interactive',
      outcome: 'solved',
      reason: `no widget frame is left but the response token is present (${document.tokenField ?? 'unknown field'}): the challenge was passed`,
      signals,
      unsolvableFromThisIp: false,
    }
  }

  // 4. A challenge DOCUMENT without a widget frame: a JS/interstitial challenge
  //    (a real browser passes it by waiting); `cf_clearance` appears when it did.
  const page = CHALLENGE_PAGE_PATTERNS.filter((entry) => entry.pattern.test(corpus))
  if (page.length > 0) {
    for (const entry of page) signals.push(`challenge-page:${entry.id}`)
    return {
      classification: document.cfClearance ? 'managed-pass' : 'interactive',
      outcome: document.cfClearance ? 'already-passed' : 'unsolved',
      reason: document.cfClearance
        ? 'a challenge document was served and `cf_clearance` is present: the browser passed it'
        : `the document is a challenge interstitial (${page.map((entry) => entry.id).join(', ')}) with no widget frame: ` +
          'wait for it to clear (a real browser solves it without an interaction)',
      signals,
      unsolvableFromThisIp: false,
    }
  }

  // 5. A CLEARANCE cookie on an otherwise normal page: the managed challenge
  //    ran and was auto-passed by this browser.
  if (document.cfClearance) {
    signals.push('cf_clearance-without-challenge')
    const hasWidgetMarkup = /cf-turnstile|turnstile|cf_clearance/i.test(body)
    return {
      classification: 'managed-pass',
      outcome: 'already-passed',
      reason:
        'the page is not a challenge document and `cf_clearance` is present: a managed challenge was auto-passed by this browser' +
        (hasWidgetMarkup ? ' (the page also carries challenge markup)' : ''),
      signals,
      unsolvableFromThisIp: false,
    }
  }

  // 6. Nothing challenge-shaped at all.
  return {
    classification: 'none',
    outcome: 'no-challenge',
    reason:
      'no challenge widget, no challenge document and no clearance cookie: this is an ordinary page' +
      (invisible.length > 0
        ? ` (it does carry ${invisible.length} interaction-free widget frame(s), which need no click)`
        : ''),
    signals,
    unsolvableFromThisIp: false,
  }
}

// ---------------------------------------------------------------------------
// The frame tree.
// ---------------------------------------------------------------------------

/** The session-side binding of a frame id, so `frameId` round-trips. */
export interface FrameBinding {
  frameId: string
  index: number
  url: string
  name: string
}

/** One row of the CDP frame tree (the ENGINE's view, real frame ids). */
interface CdpFrameRow {
  frameId: string
  parentFrameId?: string
  url: string
  name?: string
  depth: number
}

/** Flattens `Page.getFrameTree` into DFS rows (main frame first). */
function flattenFrameTree(result: unknown): CdpFrameRow[] {
  const root = (result as { frameTree?: CdpFrameTree }).frameTree
  const rows: CdpFrameRow[] = []
  const walk = (node: CdpFrameTree | undefined, depth: number, parentFrameId?: string): void => {
    const frame = node?.frame
    if (frame === undefined || typeof frame.id !== 'string' || frame.id.length === 0) return
    rows.push({
      frameId: frame.id,
      ...(parentFrameId === undefined ? {} : { parentFrameId }),
      url: typeof frame.url === 'string' ? frame.url : '',
      ...(typeof frame.name === 'string' && frame.name.length > 0 ? { name: frame.name } : {}),
      depth,
    })
    for (const child of Array.isArray(node?.childFrames) ? node.childFrames : []) walk(child, depth + 1, frame.id)
  }
  walk(root, 0, undefined)
  return rows
}

interface CdpFrameTree {
  frame?: { id?: string; url?: string; name?: string }
  childFrames?: CdpFrameTree[]
}

/** The origin of a URL (`undefined` when it cannot be parsed). */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/** A CSS string literal (a frame `src` goes into a selector verbatim). */
function cssLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** The selector of a frame ELEMENT in its parent document (best effort). */
async function selectorOfFrame(frame: Frame): Promise<string | undefined> {
  let handle: ElementHandle<Element> | null = null
  try {
    // `frameElement()` is typed `ElementHandle<Node>` by this playwright-core
    // version while it really is the `iframe`/`frame` ELEMENT: narrow it once
    // here so the attribute reads below stay typed.
    handle = (await frame.frameElement()) as unknown as ElementHandle<Element> | null
  } catch {
    return undefined
  }
  if (handle === null) return undefined
  const tag = await frame.page().evaluate((element: Element) => element.tagName.toLowerCase(), handle).catch(() => 'iframe')
  const src = await handle.getAttribute('src').catch(() => null)
  if (src !== null && src.length > 0) return `${tag}[src=${cssLiteral(src)}]`
  const id = await handle.getAttribute('id').catch(() => null)
  if (id !== null && id.length > 0) return `${tag}[id=${cssLiteral(id)}]`
  const name = await handle.getAttribute('name').catch(() => null)
  if (name !== null && name.length > 0) return `${tag}[name=${cssLiteral(name)}]`
  return tag
}

/**
 * Enumerates the frame tree of the page. The ids are the ENGINE's CDP frame
 * ids when they can be read (`frameIdSource: 'cdp'`), else positional ids
 * (`pw:<index>`) - and the caller can SEE which one it got, so it never trusts
 * an id that is only a position.
 */
export async function enumerateFrames(
  page: Page,
  cdp: CDPSession | undefined,
  maxFrames: number,
): Promise<{ frames: BrowserFrameInfo[]; bindings: Map<string, FrameBinding>; mainFrameId: string }> {
  let rows: CdpFrameRow[] | undefined
  if (cdp !== undefined) {
    rows = await cdp
      .send('Page.getFrameTree')
      .then((result) => flattenFrameTree(result))
      .catch(() => undefined)
  }
  const playwrightFrames = page.frames()
  const main = page.mainFrame()
  const mainOrigin = originOf(main.url())
  const frames: BrowserFrameInfo[] = []
  const bindings = new Map<string, FrameBinding>()
  const used = new Set<string>()
  const limit = Math.max(1, maxFrames)
  for (const [index, frame] of playwrightFrames.entries()) {
    if (frames.length >= limit) break
    const url = frame.url()
    const name = frame.name()
    const sameName = (row: CdpFrameRow): boolean => (row.name ?? '') === name
    const candidate =
      rows?.find((row) => !used.has(row.frameId) && row.url === url && sameName(row)) ??
      (rows !== undefined && rows[index] !== undefined && !used.has(rows[index]!.frameId) && rows[index]!.url === url
        ? rows[index]
        : undefined)
    if (candidate !== undefined) used.add(candidate.frameId)
    const frameId = candidate?.frameId ?? `pw:${String(index)}`
    const selector = index === 0 ? undefined : await selectorOfFrame(frame)
    const frameOrigin = originOf(url)
    const challenge = kindOfFrameUrl(url)
    frames.push({
      frameId,
      frameIdSource: candidate === undefined ? 'positional' : 'cdp',
      ...(candidate?.parentFrameId === undefined ? {} : { parentFrameId: candidate.parentFrameId }),
      url,
      ...(name.length === 0 ? {} : { name }),
      depth: candidate?.depth ?? (index === 0 ? 0 : 1),
      isMainFrame: frame === main,
      crossOrigin: mainOrigin !== undefined && frameOrigin !== undefined && mainOrigin !== frameOrigin,
      ...(selector === undefined ? {} : { selector }),
      ...(challenge === undefined ? {} : { challenge }),
    })
    bindings.set(frameId, { frameId, index, url, name })
  }
  const mainFrameId = frames[0]?.frameId ?? 'pw:0'
  return { frames, bindings, mainFrameId }
}

/**
 * Resolves a frame target against the LIVE frame list, using the bindings the
 * last enumeration recorded (so a `frameId` round-trips). The order is
 * `frameId`, `selector`, `url`, `name`, `index`; no target at all is the MAIN
 * frame. Every failure is typed, never a guess at "some" frame.
 */
export async function resolveFrameTarget(
  page: Page,
  target: BrowserFrameTarget | undefined,
  bindings: Map<string, FrameBinding>,
): Promise<Frame> {
  const frames = page.frames()
  if (target === undefined) return page.mainFrame()
  if (target.frameId !== undefined) {
    const frameId = requireText(target.frameId, 'frame.frameId', 256)
    const binding = bindings.get(frameId)
    if (binding !== undefined) {
      const frame = frames[binding.index]
      if (frame !== undefined) return frame
    }
    const positional = /^pw:(\d+)$/.exec(frameId)
    if (positional !== null) {
      const frame = frames[Number(positional[1])]
      if (frame !== undefined) return frame
    }
    throw new BrowserUseError(
      'browser-use.invalid-input',
      `no frame '${frameId}' in this session (call \`frames\` and use a frameId it reported)`,
      { stage: 'frame', details: { frameId, known: [...bindings.keys()] } },
    )
  }
  if (target.selector !== undefined) {
    const selector = requireText(target.selector, 'frame.selector', 4_096)
    const locator = page.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count === 0) {
      throw new BrowserUseError('browser-use.selector-not-found', `'frame.selector': '${selector}' matched no element`, {
        stage: 'frame',
        details: { selector, frames: page.frames().map((frame) => frame.url()) },
      })
    }
    const handle = await locator.first().elementHandle()
    const frame = handle === null ? null : await handle.contentFrame()
    if (frame === null) {
      throw new BrowserUseError(
        'browser-use.invalid-input',
        `'frame.selector': '${selector}' is not a frame (an iframe/frame element)`,
        { stage: 'frame', details: { selector } },
      )
    }
    return frame
  }
  if (target.url !== undefined) {
    const wanted = requireText(target.url, 'frame.url', 4_096)
    const frame = frames.find((candidate) => candidate.url() === wanted) ?? frames.find((candidate) => candidate.url().includes(wanted))
    if (frame === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `no frame whose URL is '${wanted}'`, {
        stage: 'frame',
        details: { url: wanted, frames: frames.map((candidate) => candidate.url()) },
      })
    }
    return frame
  }
  if (target.name !== undefined) {
    const wanted = requireText(target.name, 'frame.name', 256)
    const frame = frames.find((candidate) => candidate.name() === wanted)
    if (frame === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `no frame named '${wanted}'`, {
        stage: 'frame',
        details: { name: wanted, frames: frames.map((candidate) => candidate.name()) },
      })
    }
    return frame
  }
  if (target.index !== undefined) {
    const index = requireNonNegativeInt(target.index, 'frame.index', 10_000)
    const frame = frames[index]
    if (frame === undefined) {
      throw new BrowserUseError('browser-use.invalid-input', `no frame at index ${String(index)} (the page has ${String(frames.length)})`, {
        stage: 'frame',
        details: { index, frames: frames.length },
      })
    }
    return frame
  }
  throw new BrowserUseError(
    'browser-use.invalid-input',
    "'frame' names no frame: pass frameId, selector, url, name or index",
    { stage: 'frame', details: { accepted: ['frameId', 'selector', 'url', 'name', 'index'] } },
  )
}

// ---------------------------------------------------------------------------
// Mouse input at coordinates.
// ---------------------------------------------------------------------------

/** A finite number in range, or a typed `invalid-input`. */
function requireNumber(value: unknown, field: string, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN
  if (!Number.isFinite(number) || Math.abs(number) > max) {
    throw new BrowserUseError('browser-use.invalid-input', `'${field}' must be a number between -${String(max)} and ${String(max)}`, {
      stage: 'mouse',
      details: { field, value: typeof value === 'number' || typeof value === 'string' ? value : String(value) },
    })
  }
  return number
}

/** Where the coordinates of this gesture are measured, plus the frame box. */
async function coordinateBase(
  page: Page,
  request: BrowserMouseRequest,
  bindings: Map<string, FrameBinding>,
  fallback: Frame | undefined,
): Promise<{ origin: MouseOrigin; frame: Frame | undefined; offsetX: number; offsetY: number; frameId?: string }> {
  const origin = requireEnum(request.relativeTo ?? 'page', MOUSE_ORIGINS, 'relativeTo', 'page')
  const frame = request.frame === undefined ? fallback : await resolveFrameTarget(page, request.frame, bindings)
  if (origin === 'page') {
    const anchor = frame === undefined ? undefined : frameIdOf(frame, bindings)
    return { origin, frame, offsetX: 0, offsetY: 0, ...(anchor === undefined ? {} : { frameId: anchor }) }
  }
  const target = frame ?? page.mainFrame()
  if (target === page.mainFrame()) return { origin, frame: target, offsetX: 0, offsetY: 0, frameId: frameIdOf(target, bindings) }
  const handle = await target.frameElement().catch(() => null)
  const box = handle === null ? null : await handle.boundingBox().catch(() => null)
  if (box === null) {
    throw new BrowserUseError('browser-use.invalid-input', "the frame has no box: it is detached or not rendered", {
      stage: 'mouse',
      details: { frameUrl: target.url() },
    })
  }
  return { origin, frame: target, offsetX: box.x, offsetY: box.y, frameId: frameIdOf(target, bindings) }
}

/** The id the bindings know for a frame (`undefined` when it was never listed). */
function frameIdOf(frame: Frame, bindings: Map<string, FrameBinding>): string | undefined {
  for (const [frameId, binding] of bindings) {
    if (binding.url === frame.url() && binding.name === frame.name()) return frameId
  }
  return undefined
}

/** What a mouse gesture really did (the coordinates the browser received). */
export interface MouseResult {
  mouseAction: MouseAction
  x: number
  y: number
  toX?: number
  toY?: number
  relativeTo: MouseOrigin
  button: MouseButton
  frameId?: string
}

/**
 * Drives the REAL mouse. `relativeTo: 'page'` (default) uses the main frame
 * viewport - the SAME origin a screenshot uses; `relativeTo: 'frame'` measures
 * from the target frame's box, and the offset is added here so the browser
 * always receives main-frame coordinates (which is what makes a click inside a
 * cross-origin OOPIF land where the caller meant).
 */
export async function driveMouse(
  page: Page,
  request: BrowserMouseRequest,
  bindings: Map<string, FrameBinding>,
  fallback: Frame | undefined,
): Promise<MouseResult> {
  const action = requireEnum(request.mouseAction ?? 'click', MOUSE_ACTIONS, 'mouseAction', 'click')
  const button = requireEnum(request.button ?? 'left', MOUSE_BUTTONS, 'button', 'left')
  const base = await coordinateBase(page, request, bindings, fallback)
  const steps = request.steps === undefined ? 10 : requirePositiveInt(request.steps, 'steps', 200)
  const max = 100_000
  const toResult = (x: number, y: number, extra: { toX?: number; toY?: number } = {}): MouseResult => ({
    mouseAction: action,
    x,
    y,
    ...extra,
    relativeTo: base.origin,
    button,
    ...(base.frameId === undefined ? {} : { frameId: base.frameId }),
  })
  if (action === 'wheel') {
    const deltaX = request.deltaX === undefined ? 0 : requireNumber(request.deltaX, 'deltaX', max)
    const deltaY = request.deltaY === undefined ? 0 : requireNumber(request.deltaY, 'deltaY', max)
    if (request.x !== undefined && request.y !== undefined) {
      await page.mouse.move(requireNumber(request.x, 'x', max) + base.offsetX, requireNumber(request.y, 'y', max) + base.offsetY)
    }
    await page.mouse.wheel(deltaX, deltaY)
    return toResult(
      request.x === undefined ? 0 : requireNumber(request.x, 'x', max),
      request.y === undefined ? 0 : requireNumber(request.y, 'y', max),
    )
  }
  const x = requireNumber(request.x, 'x', max) + base.offsetX
  const y = requireNumber(request.y, 'y', max) + base.offsetY
  if (action === 'drag') {
    const toX = requireNumber(request.toX, 'toX', max) + base.offsetX
    const toY = requireNumber(request.toY, 'toY', max) + base.offsetY
    await page.mouse.move(x, y)
    await page.mouse.down({ button })
    await page.mouse.move(toX, toY, { steps })
    await page.mouse.up({ button })
    return toResult(x, y, { toX, toY })
  }
  if (action === 'down') {
    await page.mouse.move(x, y)
    await page.mouse.down({ button })
    return toResult(x, y)
  }
  if (action === 'up') {
    await page.mouse.move(x, y)
    await page.mouse.up({ button })
    return toResult(x, y)
  }
  if (action === 'click' || action === 'dblclick') {
    const defaultCount = action === 'dblclick' ? 2 : 1
    const clickCount = request.clickCount === undefined ? defaultCount : requirePositiveInt(request.clickCount, 'clickCount', 3)
    // A MOVE first, then the click: the pointer really travels to the pixel (an
    // element that reacts to hover/pointermove sees it, exactly like a human).
    await page.mouse.move(x, y)
    await page.mouse.click(x, y, { button, clickCount })
    return toResult(x, y)
  }
  await page.mouse.move(x, y, { steps })
  return toResult(x, y)
}

// ---------------------------------------------------------------------------
// Reading a document through the challenge lens.
// ---------------------------------------------------------------------------

/** What a frame's own DOM reported (token / success / text). */
interface FrameReport {
  tokenField?: string
  text: string
}

/** The selectors probed for a response token, main document first. */
function tokenSelectors(): string[] {
  return [...CHALLENGE_TOKEN_FIELDS, 'input[name$="response"]', 'textarea[name$="response"]', '[id$="_response"]']
}

/** Reads the token/success state of ONE frame (never throws). */
async function probeFrame(frame: Frame): Promise<FrameReport> {
  const selectors = tokenSelectors()
  const report = await frame
    .evaluate((fields: string[]) => {
      let tokenField: string | undefined
      for (const selector of fields) {
        const element = document.querySelector(selector)
        if (element === null) continue
        const value = (element as HTMLInputElement | HTMLTextAreaElement).value
        if (typeof value === 'string' && value.trim().length > 0) {
          tokenField = selector
          break
        }
      }
      return { ...(tokenField === undefined ? {} : { tokenField }), text: (document.body?.innerText ?? '').slice(0, 600) }
    }, selectors)
    .catch(() => undefined)
  return report === undefined ? { text: '' } : report
}

/** The success markers a widget prints when it passed. */
const SUCCESS_TEXT = /success|verified|verificado|voc(?:e|ê) (?:foi )?verificado|you are human|human verified/i

/** Everything one challenge reading needs (document + tree + verdict). */
export interface ChallengeReading {
  document: ChallengeDocument
  verdict: ChallengeVerdict
  frames: BrowserFrameInfo[]
  bindings: Map<string, FrameBinding>
  mainFrameId: string
  /** frameId -> the frame's own report (token/success), for the widget frames. */
  reports: Map<string, FrameReport>
}

/**
 * Reads the live page through the challenge lens: status, title, bounded HTML,
 * the `cf_clearance` cookie, the response token, the frame tree and the widget
 * frames. The document HTML is bounded HERE (never the whole page): what leaves
 * this module is a classification plus a bounded excerpt.
 */
export async function readChallenge(
  page: Page,
  cdp: CDPSession | undefined,
  options: { maxFrames: number; excerptChars: number },
): Promise<ChallengeReading> {
  const { frames, bindings, mainFrameId } = await enumerateFrames(page, cdp, options.maxFrames)
  const info: { title: string; html: string; text: string; httpStatus?: number } = await page
    .evaluate((limit: number) => {
      let httpStatus: number | undefined
      try {
        const entries = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]
        const status = entries[0]?.responseStatus
        if (typeof status === 'number' && status > 0) httpStatus = status
      } catch {
        httpStatus = undefined
      }
      return {
        title: document.title,
        html: document.documentElement === null ? '' : document.documentElement.outerHTML.slice(0, limit),
        text: (document.body === null || document.body === undefined ? '' : document.body.innerText ?? '').slice(0, 8000),
        ...(httpStatus === undefined ? {} : { httpStatus }),
      }
    }, Math.max(20_000, options.excerptChars * 40))
    .catch(() => ({ title: '', html: '', text: '' }))
  const cookies = await page.context().cookies().catch(() => [])
  const clearance = cookies.find((cookie) => cookie.name === 'cf_clearance')
  const mainReport = await probeFrame(page.mainFrame())
  let tokenPresent = mainReport.tokenField !== undefined
  let tokenField = mainReport.tokenField
  let widgetReportedSuccess = mainReport.tokenField !== undefined
  const reports = new Map<string, FrameReport>()
  const challengeFrames: ChallengeDocument['challengeFrames'] = []
  for (const frame of frames) {
    if (frame.isMainFrame) continue
    const kind = kindOfFrameUrl(frame.url)
    if (kind === undefined) continue
    challengeFrames.push({ frameId: frame.frameId, url: frame.url, kind })
    const live = page.frames().find((candidate) => candidate.url() === frame.url && candidate.name() === (frame.name ?? ''))
    if (live === undefined) continue
    const report = await probeFrame(live)
    reports.set(frame.frameId, report)
    if (!tokenPresent && report.tokenField !== undefined) {
      tokenPresent = true
      tokenField = report.tokenField
    }
    if (SUCCESS_TEXT.test(report.text)) widgetReportedSuccess = true
  }
  const doc: ChallengeDocument = {
    url: page.url(),
    title: info.title === '' ? await page.title().catch(() => '') : info.title,
    html: info.html,
    text: info.text,
    ...(info.httpStatus === undefined ? {} : { httpStatus: info.httpStatus }),
    cfClearance: clearance !== undefined,
    tokenPresent,
    ...(tokenField === undefined ? {} : { tokenField }),
    widgetReportedSuccess,
    challengeFrames,
  }
  return {
    document: doc,
    verdict: classifyChallengeDocument(doc),
    frames,
    bindings,
    mainFrameId,
    reports,
  }
}

// ---------------------------------------------------------------------------
// Solving: frame targeting + coordinate mouse, then WAIT for the evidence.
// ---------------------------------------------------------------------------

/** Options a solve needs from the seam. */
export interface ChallengeSolveOptions {
  timeoutMs: number
  maxTextChars: number
  /** The frame the caller pointed at (`challenge { frame }`), preferred for the widget. */
  preferFrameUrl?: string
}

/** The `cf_clearance` cookie view (never a value). */
function cookieView(cookies: { name: string; domain: string; expires: number }[]): {
  name: string
  present: boolean
  domain?: string
  expires?: number
} {
  const clearance = cookies.find((cookie) => cookie.name === 'cf_clearance')
  if (clearance === undefined) return { name: 'cf_clearance', present: false }
  return {
    name: 'cf_clearance',
    present: true,
    domain: clearance.domain,
    ...(clearance.expires === undefined || clearance.expires <= 0 ? {} : { expires: Math.round(clearance.expires * 1000) }),
  }
}

/** The token/cookie state used while waiting for a solve. */
async function pollPassed(page: Page): Promise<{ passed: boolean; tokenField?: string; cfClearance: boolean; widgetReportedSuccess: boolean; challengeFrames: number }> {
  const cookies = await page.context().cookies().catch(() => [])
  const cfClearance = cookies.some((cookie) => cookie.name === 'cf_clearance')
  const main = await probeFrame(page.mainFrame())
  let tokenField = main.tokenField
  let success = main.tokenField !== undefined
  let challengeFrames = 0
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue
    if (kindOfFrameUrl(frame.url()) === undefined) continue
    challengeFrames += 1
    const report = await probeFrame(frame)
    if (tokenField === undefined && report.tokenField !== undefined) tokenField = report.tokenField
    if (SUCCESS_TEXT.test(report.text)) success = true
  }
  return {
    passed: tokenField !== undefined || cfClearance || success || (challengeFrames === 0 && success),
    ...(tokenField === undefined ? {} : { tokenField }),
    cfClearance,
    widgetReportedSuccess: success,
    challengeFrames,
  }
}

/**
 * Solves an INTERACTIVE challenge: locate the widget frame, find its checkbox
 * (or fall back to the widget box's checkbox offset), click it with the REAL
 * mouse and WAIT for the evidence (token / `cf_clearance` / the widget's own
 * success marker). Every attempt is logged into the returned widget report, so
 * a failure says WHAT was tried instead of "not solved".
 */
export async function solveChallenge(
  page: Page,
  cdp: CDPSession | undefined,
  sessionId: string,
  request: BrowserChallengeRequest,
  options: ChallengeSolveOptions,
): Promise<BrowserChallengeAnswer> {
  const started = Date.now()
  const action = requireEnum(request.challengeAction ?? 'detect', CHALLENGE_ACTIONS, 'challengeAction', 'detect')
  const waitMs = request.waitMs === undefined ? 15_000 : requirePositiveInt(request.waitMs, 'waitMs', 120_000)
  const maxAttempts = request.maxAttempts === undefined ? 3 : requirePositiveInt(request.maxAttempts, 'maxAttempts', 10)
  const kinds = Array.isArray(request.kinds) && request.kinds.length > 0 ? request.kinds.map((kind) => requireEnum(kind, CHALLENGE_KINDS, 'kinds[]')) : undefined
  const explicitSelector = request.selector === undefined ? undefined : requireText(request.selector, 'selector', 4_096)
  const wantClick = request.click !== false && action === 'solve'
  const log: string[] = []
  let reading = await readChallenge(page, cdp, { maxFrames: 200, excerptChars: 4_000 })
  const cookieByPage = await page.context().cookies().catch(() => [])
  let widget = widgetOf(reading, kinds, log, options.preferFrameUrl)

  if (action !== 'solve') {
    return {
      action: 'challenge',
      session: sessionId,
      challengeAction: action,
      url: reading.document.url,
      title: reading.document.title,
      classification: reading.verdict.classification,
      outcome: reading.verdict.outcome,
      unsolvableFromThisIp: reading.verdict.unsolvableFromThisIp,
      reason: reading.verdict.reason,
      signals: reading.verdict.signals,
      ...(reading.document.httpStatus === undefined ? {} : { httpStatus: reading.document.httpStatus }),
      ...excerptOf(reading),
      ...(widget.found ? { widget } : {}),
      cookie: cookieView(cookieByPage),
      elapsedMs: Date.now() - started,
    }
  }

  if (reading.verdict.classification !== 'interactive' || !widget.found) {
    // Nothing to click: a hard block, a page that already passed, or an
    // interstitial that a real browser clears by waiting. The answer is the
    // STRUCTURED verdict - never a silent "empty read".
    const outcome: ChallengeOutcome =
      reading.verdict.outcome === 'unsolved' ? (reading.verdict.unsolvableFromThisIp ? 'unsolvable-from-this-ip' : 'unsolved') : reading.verdict.outcome
    return {
      action: 'challenge',
      session: sessionId,
      challengeAction: action,
      url: reading.document.url,
      title: reading.document.title,
      classification: reading.verdict.classification,
      outcome,
      unsolvableFromThisIp: reading.verdict.unsolvableFromThisIp,
      reason:
        reading.verdict.classification === 'blocked-ip'
          ? reading.verdict.reason
          : `${reading.verdict.reason} - there is no widget to interact with, so no click was driven`,
      signals: reading.verdict.signals,
      ...(reading.document.httpStatus === undefined ? {} : { httpStatus: reading.document.httpStatus }),
      ...excerptOf(reading),
      ...(widget.found ? { widget } : {}),
      cookie: cookieView(cookieByPage),
      elapsedMs: Date.now() - started,
    }
  }

  const passed = await solveWidget(page, reading, widget, { wantClick, waitMs, maxAttempts, explicitSelector, log })
  reading = passed.reading
  widget = passed.widget
  const cookies = await page.context().cookies().catch(() => [])
  let outcome: ChallengeOutcome
  if (widget.tokenPresent || widget.widgetReportedSuccess === true || cookies.some((cookie) => cookie.name === 'cf_clearance')) outcome = 'solved'
  else if (reading.verdict.unsolvableFromThisIp) outcome = 'unsolvable-from-this-ip'
  else outcome = 'unsolved'
  return {
    action: 'challenge',
    session: sessionId,
    challengeAction: action,
    url: readerUrl(page, reading),
    title: reading.document.title,
    classification: reading.verdict.classification,
    outcome,
    unsolvableFromThisIp: reading.verdict.unsolvableFromThisIp,
    reason:
      outcome === 'solved'
        ? `the ${widget.kind} widget was completed (${widget.tokenPresent ? `token in '${widget.tokenField ?? 'unknown'}'` : ''}${widget.widgetReportedSuccess === true ? 'widget reported success' : ''}${cookies.some((cookie) => cookie.name === 'cf_clearance') ? 'cf_clearance present' : ''})`.replace('  ', ' ')
        : `${reading.verdict.reason} - ${String(widget.attempts)} interaction(s) were driven and the token/clearance did not appear within ${String(waitMs)} ms`,
    signals: [...reading.verdict.signals, ...widget.log],
    ...(reading.document.httpStatus === undefined ? {} : { httpStatus: reading.document.httpStatus }),
    ...excerptOf(reading),
    widget,
    cookie: cookieView(cookies),
    elapsedMs: Date.now() - started,
  }
}

/** The final URL of the call (`page.url()` re-read: a solve can navigate). */
function readerUrl(page: Page, reading: ChallengeReading): string {
  const live = page.url()
  return live.length === 0 ? reading.document.url : live
}

/** The bounded body excerpt of a reading (only when the page is a refusal). */
function excerptOf(reading: ChallengeReading): { bodyExcerpt?: string } {
  if (!reading.verdict.unsolvableFromThisIp) return {}
  const text = reading.document.html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { bodyExcerpt: text.slice(0, 600) }
}

/** Builds the widget report from a reading (called before and after clicking). */
function widgetOf(
  reading: ChallengeReading,
  kinds: ChallengeKind[] | undefined,
  log: string[],
  preferFrameUrl?: string,
): BrowserChallengeWidget {
  const candidates = reading.frames
    .filter((frame) => !frame.isMainFrame)
    .filter((frame) => kindOfFrameUrl(frame.url) !== undefined)
    .filter((frame) => kinds === undefined || kinds.length === 0 || kinds.includes(kindOfFrameUrl(frame.url) ?? 'unknown'))
  const preferred = preferFrameUrl === undefined ? undefined : candidates.find((candidate) => candidate.url === preferFrameUrl)
  const frame = preferred ?? candidates.find((candidate) => candidate.challenge !== undefined) ?? candidates[0]
  const report = frame === undefined ? undefined : reading.reports.get(frame.frameId)
  if (frame === undefined) {
    log.push('no challenge widget frame in the page')
    return { found: false, kind: 'unknown', clicked: false, attempts: 0, tokenPresent: false, log }
  }
  const kind = frame.challenge ?? kindOfFrameUrl(frame.url) ?? 'unknown'
  log.push(`widget frame ${kind} ${frame.url} (${frame.frameId}, source ${frame.frameIdSource})`)
  return {
    found: true,
    kind,
    frameId: frame.frameId,
    frameUrl: frame.url,
    ...(frame.selector === undefined ? {} : { frameSelector: frame.selector }),
    clicked: false,
    attempts: 0,
    tokenPresent: report?.tokenField !== undefined,
    ...(report?.tokenField === undefined ? {} : { tokenField: report.tokenField }),
    ...(reading.document.widgetReportedSuccess ? { widgetReportedSuccess: true } : {}),
    log,
  }
}

/** Where a click inside the widget landed. */
interface ClickPoint {
  x: number
  y: number
  selector?: string
}

/**
 * Finds the point to click for a widget: an element inside the frame when one
 * resolves, else the widget box's own checkbox offset (the pixel fallback).
 */
async function clickPointFor(page: Page, widget: BrowserChallengeWidget, frame: Frame, explicitSelector: string | undefined, log: string[]): Promise<ClickPoint | undefined> {
  const selectors = explicitSelector === undefined ? WIDGET_CLICK_SELECTORS : [explicitSelector, ...WIDGET_CLICK_SELECTORS]
  for (const selector of selectors) {
    const locator: Locator = frame.locator(selector)
    const count = await locator.count().catch(() => 0)
    if (count === 0) continue
    const first = locator.first()
    const visible = await first.isVisible().catch(() => false)
    if (!visible) continue
    const box = await first.boundingBox().catch(() => null)
    if (box === null || box.width === 0 || box.height === 0) continue
    log.push(`clickable element '${selector}' in the widget frame at (${String(Math.round(box.x + box.width / 2))},${String(Math.round(box.y + box.height / 2))})`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, selector }
  }
  const handle = await frame.frameElement().catch(() => null)
  const box = handle === null ? null : await handle.boundingBox().catch(() => null)
  if (box === null) {
    log.push('no clickable element and no widget box: nothing to click')
    return undefined
  }
  const x = box.x + Math.min(WIDGET_CHECKBOX_OFFSET, Math.max(4, box.width / 2))
  const y = box.y + box.height / 2
  log.push(`no clickable element inside the widget: clicking the widget box checkbox offset (${String(Math.round(x))},${String(Math.round(y))})`)
  return { x, y }
}

/** Drives the clicks and waits for the evidence. */
async function solveWidget(
  page: Page,
  reading: ChallengeReading,
  initial: BrowserChallengeWidget,
  options: { wantClick: boolean; waitMs: number; maxAttempts: number; explicitSelector: string | undefined; log: string[] },
): Promise<{ reading: ChallengeReading; widget: BrowserChallengeWidget }> {
  const widget = initial
  let current = reading
  for (let attempt = 1; attempt <= (options.wantClick ? options.maxAttempts : 1); attempt += 1) {
    const frame = await frameForWidget(page, current, widget, options.log)
    if (frame === undefined) break
    const point = await clickPointFor(page, widget, frame, options.explicitSelector, options.log)
    if (point === undefined) break
    if (options.wantClick) {
      await page.mouse.move(point.x, point.y)
      await page.mouse.click(point.x, point.y, { button: 'left' })
      widget.clicked = true
      widget.attempts = attempt
      widget.coordinates = { x: Math.round(point.x), y: Math.round(point.y) }
      if (point.selector !== undefined) widget.clickedSelector = point.selector
      options.log.push(`clicked at (${String(Math.round(point.x))},${String(Math.round(point.y))}) attempt ${String(attempt)}`)
    }
    const deadline = Date.now() + options.waitMs
    for (;;) {
      const poll = await pollPassed(page)
      if (poll.tokenField !== undefined) {
        widget.tokenPresent = true
        widget.tokenField = poll.tokenField
      }
      if (poll.widgetReportedSuccess) widget.widgetReportedSuccess = true
      if (poll.passed || Date.now() >= deadline) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    current = await readChallenge(page, undefined, { maxFrames: 200, excerptChars: 4_000 })
    if (widget.tokenPresent || widget.widgetReportedSuccess === true) break
    if (current.document.challengeFrames.length === 0) {
      options.log.push('the widget frame is gone after the interaction (the challenge was cleared or the page navigated)')
      break
    }
  }
  if (options.wantClick && widget.attempts === 0) widget.attempts = 0
  return { reading: current, widget }
}

/** The live Frame of the widget the report points at. */
async function frameForWidget(page: Page, reading: ChallengeReading, widget: BrowserChallengeWidget, log: string[]): Promise<Frame | undefined> {
  const frames = page.frames().filter((frame) => kindOfFrameUrl(frame.url()) !== undefined)
  const byUrl = widget.frameUrl === undefined ? undefined : frames.find((frame) => frame.url() === widget.frameUrl)
  const target = byUrl ?? frames[0]
  if (target === undefined) {
    log.push('the widget frame disappeared before the click')
    return undefined
  }
  void reading
  return target
}

/** The main-document token read (used by tests through the provider's answer). */
export async function tokenState(page: Page): Promise<{ tokenPresent: boolean; tokenField?: string }> {
  const report = await probeFrame(page.mainFrame())
  return { tokenPresent: report.tokenField !== undefined, ...(report.tokenField === undefined ? {} : { tokenField: report.tokenField }) }
}

/** Re-exported for the unit tests: the classification of a bare document. */
export type { ChallengeClassification }
