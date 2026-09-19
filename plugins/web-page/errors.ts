// Structured error envelope of the `web-page` plugin.
//
// Every failure a caller can hit has a CODE that names it (timeout, dns, tls,
// non-2xx, extractor empty, ...). The code is part of the ERROR MESSAGE, because
// that is what the tools seam surfaces: `POST /api/tools/<name>` answers
// `500 { "error": { "kind": "tool-failed", "message": ... } }` (core
// `src/tools/http.ts`), and the process keeps serving the other tools. The
// object also carries the code/url/detail as fields, so an in-process caller
// reads them without parsing the text.
export type PageErrorCode =
  | 'invalid_input'
  | 'browser_unavailable'
  | 'timeout'
  | 'dns'
  | 'tls'
  | 'http_status'
  | 'connection'
  | 'extract_empty'
  | 'cache'
  | 'internal'

export interface PageErrorOptions {
  /** The URL the failure belongs to (never a credential value). */
  url?: string
  /** The underlying transport/browser text, kept verbatim for diagnosis. */
  detail?: string
  /** Whether calling again can plausibly succeed (a 404 is not retryable). */
  retryable?: boolean
  /** What the operator can do about it (a NAME, never a value). */
  hint?: string
}

/** One named, structured failure of the page reader. */
export class PageError extends Error {
  readonly code: PageErrorCode
  readonly url: string | undefined
  readonly detail: string | undefined
  readonly retryable: boolean
  readonly hint: string | undefined

  constructor(code: PageErrorCode, message: string, options: PageErrorOptions = {}) {
    const where = options.url === undefined ? '' : ` [${options.url}]`
    const why = options.detail === undefined || options.detail.length === 0 ? '' : ` (${truncate(options.detail, 300)})`
    super(`web-page: ${code}: ${message}${where}${why}`)
    this.name = 'PageError'
    this.code = code
    this.url = options.url
    this.detail = options.detail
    this.retryable = options.retryable ?? false
    this.hint = options.hint
  }

  /** The JSON shape an in-process caller or a test can assert on. */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      url: this.url,
      detail: this.detail,
      retryable: this.retryable,
      hint: this.hint,
    }
  }
}

/** A short single-line form of any thrown value. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** The message of any thrown value (never a value: callers pass browser text). */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** `true` when the text names a browser navigation timeout. */
export function isTimeout(text: string): boolean {
  return /timeout|timed out/i.test(text)
}

/**
 * Map a browser/navigation failure to a CODE. The mapping is text based because
 * that is all chromium exposes (net::ERR_* strings in the error message).
 */
export function codeForBrowserFailure(text: string): PageErrorCode {
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED|EAI_AGAIN|ENOTFOUND/i.test(text)) return 'dns'
  if (/ERR_CERT|ERR_SSL|CERT_|self.signed|SSL/i.test(text)) return 'tls'
  if (/ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ECONNREFUSED|ECONNRESET/i.test(text)) return 'connection'
  if (isTimeout(text)) return 'timeout'
  if (/net::ERR_/.test(text)) return 'connection'
  return 'internal'
}

/** Wrap a browser/navigation failure into a named {@link PageError}. */
export function browserFailure(error: unknown, url: string, timeoutMs: number): PageError {
  const text = messageOf(error)
  const code = codeForBrowserFailure(text)
  if (code === 'timeout') {
    return new PageError('timeout', `the page did not finish loading within ${String(timeoutMs)}ms`, {
      url,
      detail: text,
      retryable: true,
      hint: 'raise navigationTimeoutMs/actionTimeoutMs or try again later',
    })
  }
  if (code === 'dns') {
    return new PageError('dns', 'the host name could not be resolved', { url, detail: text, hint: 'check the URL/host and DNS' })
  }
  if (code === 'tls') {
    return new PageError('tls', 'the TLS/HTTPS handshake failed', { url, detail: text, hint: 'check the certificate of the target' })
  }
  if (code === 'connection') {
    return new PageError('connection', 'the browser could not reach the target', { url, detail: text, retryable: true })
  }
  return new PageError('internal', 'the browser reported a failure', { url, detail: text })
}

/** Hard truncation for diagnostics (never a value). */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`
}
