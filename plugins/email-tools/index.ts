// External workbench plugin: the CONSUMER of the email capability (`email@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4e):
//   Definition (core)  - the contract, `ctx.email`
//   Provider           - a backend implementation (any `email@1` provider plugin)
//   Consumer           - THIS plugin: it exposes the capability as TOOLS and
//                        never learns which backend answers.
//
// It imports NOTHING from the core and NOTHING from a provider: the only seam it
// touches is `ctx.email` (injected by name) plus `ctx.workbench.registerTool`.
// Swapping the provider (disable one `email@1` provider, enable another) is a
// config edit; this file does not change and its tools keep working, which is
// what `npm run check:seam` in the core repository enforces. This plugin names
// no mail backend anywhere - not even in a comment.

/** One declared tool parameter (the DSH-style property map the core publishes). */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

type ToolParameters = Record<string, ToolParameter>

/** One configured account, as the capability reports it (never a secret). */
interface EmailAccountLike {
  label: string
  address?: string
  default?: boolean
  description?: string
}

/** A LABEL naming a configured account - the capability's account reference. */
interface EmailRefLike {
  label: string
}

interface EmailSummaryLike {
  id: string
  subject: string
  from: string
  to: string[]
  date: string
  unread: boolean
  snippet?: string
  folder?: string
}

interface EmailMessageLike extends EmailSummaryLike {
  text?: string
  markdown?: string
  html?: string
  raw?: string
  attachments: { filename: string; contentType?: string; size?: number }[]
  format: 'text' | 'markdown' | 'html' | 'raw'
}

interface EmailCodeLike {
  code: string
  subject: string
  from: string
  date: string
  messageId: string
}

/**
 * The consumer-visible subset of the capability. The core service implements
 * more (provider registry, `accounts`, `list`, `get`, `code`, `search`); a
 * consumer only depends on the methods it calls.
 */
interface EmailLike {
  accounts(): Promise<EmailAccountLike[]>
  list(ref?: EmailRefLike, options?: Record<string, unknown>): Promise<EmailSummaryLike[]>
  get(ref: EmailRefLike | undefined, id: string, options?: Record<string, unknown>): Promise<EmailMessageLike>
  code(ref: EmailRefLike | undefined, options?: Record<string, unknown>): Promise<EmailCodeLike>
}

interface WorkbenchLike {
  registerTool(def: {
    name: string
    description?: string
    parameters?: ToolParameters
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  }): () => void
}

interface PluginContext {
  email: EmailLike
  workbench: WorkbenchLike
  effect(callback: () => () => void): void
}

export const name = 'email-tools'

export interface Config {
  /** Cap of the `limit` parameter clients may ask for (default 50, max 100). */
  maxListLimit?: number
  /** Default `limit` when a caller omits it (default 10). */
  defaultListLimit?: number
}

/** The hard cap of the definition itself: a client can never ask for more. */
const HARD_MAX_LIMIT = 100

/**
 * An account parameter (`account: 'work'`) becomes the capability's account
 * REFERENCE (`{ label: 'work' }`). An omitted/blank parameter means "the
 * provider's default account", which is what an `undefined` reference does, so
 * the operator's `defaultAccount` config decides - never this plugin.
 */
function refOf(params: Record<string, unknown>): EmailRefLike | undefined {
  const account = params.account
  if (typeof account !== 'string' || account.trim().length === 0) return undefined
  return { label: account.trim() }
}

/** The email error text of a failed call, prefixed so a caller can tell it apart. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const defaultListLimit = clampLimit(config.defaultListLimit ?? 10)
  const maxListLimit = clampLimit(config.maxListLimit ?? 50)

  // 1) Which mailboxes exist and which one a call without an account uses.
  // The tool NEVER sees an address list of its own: it forwards the capability.
  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'email accounts',
      description: 'lists the configured email accounts (labels, addresses, which one is the default); never a secret',
      parameters: {
        format: {
          type: 'string',
          description: "how much to report per account: 'labels' (default) or 'full'",
          enum: ['labels', 'full'],
        },
      },
      handler: async (params) => {
        const accounts = await ctx.email.accounts()
        const full = params.format === 'full'
        return {
          count: accounts.length,
          default: accounts.find((account) => account.default)?.label,
          accounts: full ? accounts : accounts.map((account) => account.label),
        }
      },
    }),
  )

  // 2) The last N messages of one account (default account when omitted).
  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'email list',
      description: 'lists the newest messages of an account: optional account label (default account when omitted), folder, limit, unreadOnly, since',
      parameters: {
        account: { type: 'string', description: 'account label (default: the configured default account)' },
        folder: { type: 'string', description: "mailbox folder (backend specific name, e.g. 'INBOX')" },
        limit: {
          type: 'integer',
          description: `how many of the newest messages (default ${String(defaultListLimit)}, max ${String(maxListLimit)})`,
        },
        unreadOnly: { type: 'boolean', description: 'only unread messages' },
        since: { type: 'string', description: 'ISO-8601 instant: only messages at/after it' },
      },
      handler: async (params) => {
        const options: Record<string, unknown> = { limit: clampLimit(Number(params.limit ?? defaultListLimit), maxListLimit) }
        const folder = str(params.folder)
        if (folder !== undefined) options.folder = folder
        if (params.unreadOnly !== undefined) options.unreadOnly = Boolean(params.unreadOnly)
        const since = str(params.since)
        if (since !== undefined) options.since = since
        const messages = await ctx.email.list(refOf(params), options)
        return { account: str(params.account) ?? '(default)', count: messages.length, messages }
      },
    }),
  )

  // 3) One message, body included (text by default; raw on request).
  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'email get',
      description: 'reads one message of an account by id: the envelope plus its body (text, markdown or raw) and attachment metadata',
      parameters: {
        id: { type: 'string', description: 'message id, as reported by "email list"', required: true },
        account: { type: 'string', description: 'account label (default: the configured default account)' },
        format: {
          type: 'string',
          description: "body format to return: 'text' (default), 'markdown' or 'raw'",
          enum: ['text', 'markdown', 'raw'],
        },
      },
      handler: async (params) => {
        const id = String(params.id)
        const format = str(params.format) ?? 'text'
        const message = await ctx.email.get(refOf(params), id, { format })
        return {
          account: str(params.account) ?? '(default)',
          id: message.id,
          subject: message.subject,
          from: message.from,
          to: message.to,
          date: message.date,
          unread: message.unread,
          format: message.format,
          body: format === 'raw' ? message.raw : format === 'markdown' ? (message.markdown ?? message.text) : message.text,
          attachments: message.attachments,
        }
      },
    }),
  )

  // 4) The operator's headline use case: the verification code inside a mail.
  // The extraction rule lives in the Definition (one place, every provider), so
  // this handler only picks the message and forwards the options.
  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'email code',
      description: 'extracts a verification code from a message (or from the newest message matching query/pattern) and reports which mail it came from',
      parameters: {
        id: { type: 'string', description: 'read THIS message instead of scanning the newest ones' },
        account: { type: 'string', description: 'account label (default: the configured default account)' },
        query: { type: 'string', description: 'only messages whose subject/from/snippet contains this (case-insensitive)' },
        pattern: { type: 'string', description: 'explicit extraction pattern; group 1 (or the whole match) is the code' },
        maxAgeSeconds: { type: 'integer', description: 'ignore messages older than this many seconds' },
      },
      handler: async (params) => {
        const options: Record<string, unknown> = {}
        const id = str(params.id)
        if (id !== undefined) options.id = id
        const query = str(params.query)
        if (query !== undefined) options.query = query
        const pattern = str(params.pattern)
        if (pattern !== undefined) options.pattern = pattern
        if (params.maxAgeSeconds !== undefined) options.maxAgeSeconds = Number(params.maxAgeSeconds)
        const found = await ctx.email.code(refOf(params), options)
        return {
          account: str(params.account) ?? '(default)',
          code: found.code,
          subject: found.subject,
          from: found.from,
          date: found.date,
          messageId: found.messageId,
        }
      },
    }),
  )

  // The four tools above ARE the plugin: nothing else to dispose (each
  // `ctx.effect` disposes its own registration when the plugin unloads).
  void messageOf
}

/** A trimmed non-empty string, or `undefined`. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** A positive integer within [1, HARD_MAX_LIMIT], or the fallback. */
function clampLimit(value: number, max = HARD_MAX_LIMIT): number {
  if (!Number.isFinite(value) || value <= 0) return Math.min(HARD_MAX_LIMIT, max)
  return Math.min(HARD_MAX_LIMIT, max, Math.trunc(value))
}

export default { name, inject: ['email', 'workbench'], apply }
