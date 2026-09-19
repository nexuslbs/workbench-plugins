// External workbench plugin: an EMAIL SERVICE PROVIDER implemented entirely
// OUTSIDE the core repository (no core module is imported here; the core
// injects `ctx.email` and this plugin only registers an implementation of the
// published contract `email@1`).
//
// Backend: the himalaya mail CLI (https://github.com/pimalaya/himalaya), driven
// in machine mode. himalaya owns the protocol work (IMAP/SMTP/JMAP) and its own
// account configuration (`himalaya account configure <name>` writes
// config.toml); this plugin only maps the capability's calls onto CLI
// invocations and normalises the answers. Trade-off, stated plainly: a CLI
// process per call is slower than a library and depends on the installed
// himalaya version (see README.md, "himalaya version"), in exchange for zero
// protocol code here and a backend that the operator configures once with
// himalaya's own tooling.
//
// The manifest declares the capability, which is what makes `ctx.email.register`
// legal:
//
//   "capabilities": [{ "id": "email", "version": 1, "provider": "himalaya" }]
//
// Contract rule 6: `apply()` must not throw on missing optional config. With no
// account configured the plugin is NOT CONFIGURED: it logs the reason, declares
// nothing and registers nothing (the capability then reports itself as not
// configured). A MISSING BINARY is not a config error either: with accounts
// configured the provider is registered and every call that needs the CLI fails
// with a structured `email: ...` error naming exactly what is missing - the
// plugin never appears under `failures` for that.
import { execFile } from 'node:child_process'

export const name = 'email-himalaya'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'himalaya'

/** Contract version implemented (the core speaks `email@1`). */
export const CONTRACT_VERSION = 1

/** Largest page the driver ever asks himalaya for. */
export const MAX_FETCH = 200

/** Default per-invocation timeout (ms) and stdout/stderr cap (bytes). */
export const DEFAULT_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

// ---------------------------------------------------------------------------
// The local view of the contract. The plugins repository has no dependency on
// the core package, so the shapes are restated structurally (exactly like
// credentials-stub and hello-tool do); the core enforces the contract at run
// time through `ctx.email.register`.
// ---------------------------------------------------------------------------

interface AccountRef {
  label: string
}

interface EmailAccount {
  label: string
  address?: string
  default?: boolean
  description?: string
}

type EmailFormat = 'text' | 'markdown' | 'html' | 'raw'

interface EmailListOptions {
  folder?: string
  limit?: number
  unreadOnly?: boolean
  since?: string
}

interface EmailSummary {
  id: string
  subject: string
  from: string
  to: string[]
  date: string
  unread: boolean
  snippet?: string
  folder?: string
}

interface EmailAttachment {
  filename: string
  contentType?: string
  size?: number
}

interface EmailGetOptions {
  format?: EmailFormat
  maxBytes?: number
}

interface EmailMessage extends EmailSummary {
  text?: string
  markdown?: string
  html?: string
  raw?: string
  attachments: EmailAttachment[]
  format: EmailFormat
}

interface EmailProvider {
  id: string
  version: number
  describe?: () => string
  accounts: () => EmailAccount[]
  list: (ref?: AccountRef, options?: EmailListOptions) => Promise<EmailSummary[]>
  get: (ref: AccountRef | undefined, id: string, options?: EmailGetOptions) => Promise<EmailMessage>
}

interface EmailLike {
  register: (provider: EmailProvider) => () => void
}

interface CredentialRef {
  name: string
  scope?: string
}

interface CredentialsLike {
  resolve: (ref: CredentialRef) => Promise<{ value?: string } | undefined>
}

interface PluginContext {
  email: EmailLike
  credentials?: CredentialsLike
  effect: (callback: () => () => void) => void
}

/** One configured account. Secrets appear only as a credential NAME. */
export interface AccountConfig {
  /** Address of the mailbox, as reported by `accounts()` (never a credential). */
  address?: string
  /** himalaya account name in ITS config (default: the label). */
  accountName?: string
  /** Credential NAME (`${cred:...}` style) resolved at call time, never a value. */
  credential?: string
  /** Default folder for the account (default: `INBOX`). */
  folder?: string
}

/** The `plugins.email-himalaya` config row. */
export interface Config {
  /** Label used when a call passes no account (default: the first configured one). */
  defaultAccount?: string
  /** Accounts by label: the operator's "multiple emails". */
  accounts?: Record<string, AccountConfig>
  /** himalaya executable (default `himalaya`, resolved on PATH). */
  binary?: string
  /** Per-invocation timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number
  /** Cap of one command's stdout+stderr (default {@link DEFAULT_MAX_OUTPUT_BYTES}). */
  maxOutputBytes?: number
}

// ---------------------------------------------------------------------------
// Errors. The names are the documented ones a consumer may branch on; the
// message always starts with `email:` and never carries a credential.
// ---------------------------------------------------------------------------

/** Nothing the provider can answer with: no account, or no usable CLI. */
class NotConfiguredError extends Error {
  constructor(message: string) {
    super(`email: ${message}`)
    this.name = 'EmailNotConfiguredError'
  }
}

/** The account label is not configured here. */
class UnknownAccountError extends Error {
  readonly label: string

  constructor(label: string, known: string[]) {
    super(`email: unknown account '${label}' (configured: ${known.length ? known.join(', ') : 'none'})`)
    this.name = 'EmailUnknownAccountError'
    this.label = label
  }
}

/** The CLI failed (non-zero exit, timeout, unparseable answer). */
class BackendError extends Error {
  constructor(message: string) {
    super(`email: ${message}`)
    this.name = 'EmailBackendError'
  }
}

// ---------------------------------------------------------------------------
// himalaya driver
// ---------------------------------------------------------------------------

interface CliResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  missing: boolean
}

/** Runs the CLI once. Never throws: the caller turns the result into an error. */
async function runCli(
  binary: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number; env?: Record<string, string> },
): Promise<CliResult> {
  return await new Promise<CliResult>((resolve) => {
    execFile(
      binary,
      args,
      {
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ...(options.env ?? {}) },
      },
      (error, stdout, stderr) => {
        const text = typeof stdout === 'string' ? stdout : ''
        const err = typeof stderr === 'string' ? stderr : ''
        if (!error) return resolve({ ok: true, stdout: text, stderr: err, code: 0, timedOut: false, missing: false })
        const code = typeof error.code === 'number' ? error.code : null
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
        const timedOut = error.killed === true || (error as { signal?: string }).signal === 'SIGTERM'
        return resolve({ ok: false, stdout: text, stderr: err, code, timedOut, missing })
      },
    )
  })
}

/** First line of stderr, trimmed and bounded: safe to show, never a value. */
function reasonOf(result: CliResult): string {
  if (result.timedOut) return 'timed out'
  if (result.missing) return 'executable not found'
  const line = result.stderr.split('\n').map((part) => part.trim()).find((part) => part.length > 0)
  if (line) return line.slice(0, 200)
  return `exit code ${result.code ?? 'unknown'}`
}

// ---------------------------------------------------------------------------
// Tolerant normalisation of himalaya's JSON (the exact field set moves between
// releases; the driver accepts the documented v1 shape and its aliases)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (isRecord(value)) {
    for (const key of ['addr', 'address', 'email']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.length > 0) {
        const display = value['name']
        return typeof display === 'string' && display.length > 0 ? `${display} <${candidate}>` : candidate
      }
    }
  }
  return undefined
}

function joinBody(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.filter((part): part is string => typeof part === 'string')
    return parts.length > 0 ? parts.join('\n') : undefined
  }
  return undefined
}

/** Reads a body field from either the top level or the nested `body` object. */
function bodyField(record: Record<string, unknown>, keys: string[]): string | undefined {
  const scopes = [record, isRecord(record['body']) ? record['body'] : undefined]
  for (const scope of scopes) {
    if (!scope) continue
    for (const key of keys) {
      const value = joinBody(scope[key])
      if (value !== undefined && value.length > 0) return value
    }
  }
  return undefined
}

function isoDate(value: unknown): string {
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return value
  }
  if (typeof value === 'number') {
    const parsed = new Date(value > 1e12 ? value : value * 1000)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date(0).toISOString()
}

function isUnread(flags: unknown): boolean {
  const list = asArray(flags).filter((flag): flag is string => typeof flag === 'string')
  return !list.some((flag) => flag.toLowerCase() === 'seen')
}

function parseJson(text: string, what: string): unknown {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new BackendError(`himalaya returned no ${what} (empty output)`)
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    throw new BackendError(
      `himalaya returned unparseable ${what} (${error instanceof Error ? error.message : String(error)}); ` +
        'the installed version may not support --output json',
    )
  }
}

/** Envelope list payload: an array, or `{ envelopes: [...] }` on some releases. */
function parseEnvelopes(text: string): Record<string, unknown>[] {
  const payload = parseJson(text, 'envelope list')
  const list = Array.isArray(payload) ? payload : isRecord(payload) ? asArray(payload['envelopes'] ?? payload['items']) : []
  return list.filter(isRecord)
}

function snippetOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const flattened = text.replace(/\s+/g, ' ').trim()
  if (flattened.length === 0) return undefined
  return flattened.length > 160 ? `${flattened.slice(0, 157)}...` : flattened
}

/** Builds the config view the driver works with. */
function readAccounts(raw: Config | undefined, log: (message: string) => void) {
  const accounts = new Map<string, AccountConfig & { label: string }>()
  for (const [label, value] of Object.entries(raw?.accounts ?? {})) {
    const key = label.trim()
    if (key.length === 0) continue
    const account = isRecord(value) ? (value as AccountConfig) : {}
    accounts.set(key, { ...account, label: key })
  }
  const labels = [...accounts.keys()]
  const requested = typeof raw?.defaultAccount === 'string' ? raw.defaultAccount.trim() : ''
  let defaultLabel = labels[0] ?? ''
  if (requested.length > 0) {
    if (accounts.has(requested)) defaultLabel = requested
    else log(`email-himalaya: 'defaultAccount' '${requested}' is not a configured account; using '${defaultLabel}'`)
  }
  return { accounts, labels, defaultLabel }
}

/**
 * Applies the plugin: with at least one account configured it registers the
 * `himalaya` email provider; otherwise it reports NOT CONFIGURED and registers
 * nothing (a normal state, never a load failure).
 */
export function apply(ctx: PluginContext, raw: Config = {}): void {
  const log = (message: string): void => {
    // The dev service pipes stderr into its logs; a message carries names only.
    console.error(message)
  }
  const { accounts, labels, defaultLabel } = readAccounts(raw, log)
  if (labels.length === 0) {
    log(
      "email-himalaya: not configured (no 'accounts' in plugins.email-himalaya) - provider 'himalaya' is declared " +
        'but not registered; add plugins.email-himalaya.accounts (see plugins/email-himalaya/README.md) to enable it',
    )
    return
  }

  const binary = typeof raw.binary === 'string' && raw.binary.trim().length > 0 ? raw.binary.trim() : 'himalaya'
  const timeoutMs = typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? Math.floor(raw.timeoutMs) : DEFAULT_TIMEOUT_MS
  const maxOutputBytes =
    typeof raw.maxOutputBytes === 'number' && raw.maxOutputBytes > 0
      ? Math.floor(raw.maxOutputBytes)
      : DEFAULT_MAX_OUTPUT_BYTES

  /** The configured account of a call, or the default one; never a secret. */
  const targetOf = (ref: AccountRef | undefined): AccountConfig & { label: string } => {
    const label = ref?.label ?? defaultLabel
    const account = accounts.get(label)
    if (!account) throw new UnknownAccountError(label, labels)
    return account
  }

  /** Credential NAME -> value, in the child ENV only (never argv, never a log). */
  const credentialEnv = async (account: AccountConfig): Promise<Record<string, string>> => {
    const credential = account.credential
    if (typeof credential !== 'string' || credential.length === 0) return {}
    if (!ctx.credentials) return {}
    const resolution = await ctx.credentials.resolve({ name: credential })
    return resolution?.value === undefined ? {} : { HIMALAYA_PASSWORD: resolution.value }
  }

  const invoke = async (account: AccountConfig, args: string[], what: string): Promise<string> => {
    const result = await runCli(binary, args, { timeoutMs, maxOutputBytes, env: await credentialEnv(account) })
    if (result.ok) return result.stdout
    if (result.missing) {
      throw new NotConfiguredError(
        `the mail CLI '${binary}' was not found (${what}); install himalaya or set ` +
          "plugins.email-himalaya.binary to its absolute path",
      )
    }
    throw new BackendError(`'${binary} ${args.join(' ')}' failed: ${reasonOf(result)}`)
  }

  const accountNameOf = (account: AccountConfig & { label: string }): string => account.accountName ?? account.label

  const provider: EmailProvider = {
    id: providerId,
    version: CONTRACT_VERSION,
    describe: () => `himalaya CLI '${binary}' (${labels.length} configured account(s))`,

    accounts: () => {
      const defaultIndex = labels.indexOf(defaultLabel)
      return labels.map((label, index) => {
        const account = accounts.get(label) as AccountConfig & { label: string }
        const accountName = accountNameOf(account)
        return {
          label,
          ...(typeof account.address === 'string' ? { address: account.address } : {}),
          ...(index === defaultIndex ? { default: true } : {}),
          description: `himalaya account '${accountName}'${account.folder ? ` folder ${account.folder}` : ''}`,
        }
      })
    },

    list: async (ref?: AccountRef, options: EmailListOptions = {}): Promise<EmailSummary[]> => {
      const account = targetOf(ref)
      const limit = Math.min(Math.max(Math.floor(options.limit ?? 10), 1), MAX_FETCH)
      const needsFilter = options.unreadOnly === true || typeof options.since === 'string'
      // The CLI pages, it does not filter: ask for more rows when a client-side
      // filter will drop some, then trim to the requested limit.
      const pageSize = Math.min(needsFilter ? limit * 4 : limit, MAX_FETCH)
      const folder = options.folder ?? account.folder ?? 'INBOX'
      const args = [
        'envelope',
        'list',
        '--account',
        accountNameOf(account),
        '--folder',
        folder,
        '--page-size',
        String(pageSize),
        '--output',
        'json',
      ]
      const envelopes = parseEnvelopes(await invoke(account, args, `listing ${folder}`))
      const messages = envelopes.map((envelope) => toSummary(envelope, folder))
      const filtered = messages
        .filter((message) => (options.unreadOnly === true ? message.unread : true))
        .filter((message) => (typeof options.since === 'string' ? message.date >= options.since : true))
      return filtered.slice(0, limit)
    },

    get: async (ref: AccountRef | undefined, id: string, options: EmailGetOptions = {}): Promise<EmailMessage> => {
      const account = targetOf(ref)
      const format: EmailFormat = options.format ?? 'text'
      const accountName = accountNameOf(account)
      if (format === 'raw') {
        const raw = await invoke(account, ['message', 'read', id, '--account', accountName, '--raw'], `reading ${id}`)
        const bounded = options.maxBytes === undefined ? raw : raw.slice(0, options.maxBytes)
        return {
          ...emptySummary(id, account.folder),
          raw: bounded,
          attachments: [],
          format,
        }
      }
      const json = await invoke(
        account,
        ['message', 'read', id, '--account', accountName, '--output', 'json'],
        `reading ${id}`,
      )
      const record = asRecordOf(parseJson(json, `message ${id}`))
      const text = bodyField(record, ['text_plain', 'textPlain', 'text'])
      const html = bodyField(record, ['text_html', 'textHtml', 'html'])
      const summary = toSummary(record, account.folder ?? 'INBOX', id)
      const body = {
        ...(text === undefined ? {} : { text }),
        ...(format === 'markdown' ? { markdown: text ?? '' } : {}),
        ...(format === 'html' ? { html: html ?? text ?? '' } : {}),
      }
      return {
        ...summary,
        ...body,
        ...(summary.snippet === undefined && (text ?? html) !== undefined ? { snippet: snippetOf(text ?? html) } : {}),
        attachments: parseAttachments(record),
        format,
      }
    },
  }

  ctx.effect(() => ctx.email.register(provider))
}

function asRecordOf(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    // Some releases wrap the message: `{ message: {...} }`.
    const nested = value['message']
    return isRecord(nested) ? { ...nested, ...value } : value
  }
  throw new BackendError('himalaya returned a message payload that is not an object')
}

function emptySummary(id: string, folder: string | undefined): EmailSummary {
  return {
    id,
    subject: '',
    from: '',
    to: [],
    date: new Date(0).toISOString(),
    unread: false,
    ...(folder === undefined ? {} : { folder }),
  }
}

/** Normalises one envelope/message record into the capability's summary shape. */
function toSummary(record: Record<string, unknown>, folder: string, fallbackId?: string): EmailSummary {
  const id = textOf(record['id'] ?? record['uid'] ?? record['messageId'] ?? record['message_id']) ?? fallbackId ?? ''
  const subject = textOf(record['subject']) ?? ''
  const from = textOf(record['from']) ?? ''
  const to = asArray(record['to'])
    .map((value) => textOf(value))
    .filter((value): value is string => value !== undefined && value.length > 0)
  const text = bodyField(record, ['text_plain', 'textPlain', 'text', 'preview', 'snippet'])
  const snippet = snippetOf(text)
  return {
    id,
    subject,
    from,
    to,
    date: isoDate(record['date'] ?? record['receivedAt'] ?? record['received_at']),
    unread: isUnread(record['flags']),
    ...(snippet === undefined ? {} : { snippet }),
    folder,
  }
}

function parseAttachments(record: Record<string, unknown>): EmailAttachment[] {
  const scopes = [record, isRecord(record['body']) ? record['body'] : undefined]
  const found: unknown[] = []
  for (const scope of scopes) {
    if (!scope) continue
    for (const key of ['attachments', 'attachment']) {
      if (scope[key] !== undefined) found.push(...asArray(scope[key]))
    }
  }
  return found.filter(isRecord).flatMap((attachment) => {
    const filename = textOf(attachment['filename'] ?? attachment['name'] ?? attachment['file_name'])
    if (filename === undefined) return []
    const contentType = textOf(attachment['contentType'] ?? attachment['content_type'] ?? attachment['mime'])
    const size = attachment['size']
    return [
      {
        filename,
        ...(contentType === undefined ? {} : { contentType }),
        ...(typeof size === 'number' ? { size } : {}),
      },
    ]
  })
}

export default { name, inject: ['email'], apply }
