// plugins/email-himalaya - the `email@1` PROVIDER (EmailHimalaya), reworked.
//
// It implements the GENERIC email contract of this repository
// (`definitions/email.ts`, service name `ctx.mail` plus `ctx.email` for the
// kernel-hosted fallback) ON TOP OF the `himalaya@1` service. It knows no CLI,
// no docker, no ssh and no protocol: every mail operation is a typed call on the
// himalaya service, which in turn runs through the general service.
//
//   EmailConsumer (plugins/email-tools)
//        -> email@1  <- this provider
//        -> himalaya@1 (plugins/himalaya-impl)
//        -> general-service@1 (plugins/general-service-impl)
//        -> shell / docker / ssh / http
//
// The account is a LABEL everywhere in the contract. The config maps labels to
// himalaya account names (and optionally an address for display); credential
// NAMES may be declared per account and are resolved through the core
// `credentials` capability at call time, so this plugin can prove the reference
// resolves without ever holding - or logging - a value.
import {
  EMAIL,
  EMAIL_CONTRACT,
  EMAIL_POLICY_PROVIDE,
  EMAIL_POLICY_REQUIRE,
  MAIL,
  withDerivedEmailCommands,
  type EmailAccount,
  type EmailCode,
  type EmailCodeOptions,
  type EmailFormat,
  type EmailGetOptions,
  type EmailListOptions,
  type EmailMessage,
  type EmailProvider,
  type EmailRef,
  type EmailSendInput,
  type EmailSendResult,
  type EmailService,
  type EmailSummary,
} from '../../definitions/email.ts'
import {
  HIMALAYA,
  HIMALAYA_CONTRACT,
  type HimalayaEnvelope,
  type HimalayaService,
  serviceOfHimalaya,
} from '../../definitions/himalaya.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  credentialsOf,
  messageOf,
  provideService,
  shellQuote,
  waitForServices,
  type ServiceContext,
} from '../../definitions/support.ts'

export const name = 'email-himalaya'

/** Provider id: it must match the manifest capability `{ id: "email", version: 1, provider: ... }`. */
export const providerId = 'himalaya'

/** Contract this plugin implements (the plugins-repo re-homing of `email@1`). */
export const contract = EMAIL_CONTRACT

/** Bound of the soft wait for the himalaya service at load (ms). */
export const DEFAULT_HIMALAYA_WAIT_MS = 1500

/** Cap of one `list()` page unless the caller asks for less. */
export const MAX_PAGE = 50

export interface AccountRow {
  /** Mailbox address, for display only (never used to authenticate). */
  address?: string
  /** Account name in the himalaya configuration (default: the label itself). */
  accountName?: string
  /** Credential NAME resolved at call time (never a value). */
  credential?: string
  /** Default folder for this account. */
  folder?: string
}

export interface EmailHimalayaConfig {
  /** Account label used when a call passes no reference (default: the first row). */
  defaultAccount?: string
  /** Accounts by LABEL: `{ address?, accountName?, credential?, folder? }`. */
  accounts?: Record<string, AccountRow>
  /** Optional: the kernel-hosted `email@1` service is also fed (backward compat). */
  registerWithKernel?: boolean
  /** Bound of the soft wait for himalaya (ms). */
  himalayaWaitMs?: number
}

/** Maps the himalaya envelope shape to the generic email summary. */
export function toSummary(envelope: HimalayaEnvelope, folder?: string): EmailSummary {
  return {
    id: envelope.id,
    subject: envelope.subject,
    from: envelope.from,
    to: envelope.to.length === 0 ? [] : envelope.to.split(',').map((entry) => entry.trim()).filter(Boolean),
    date: envelope.date,
    unread: !envelope.flags.some((flag) => flag.toLowerCase().includes('seen')),
    ...(envelope.subject.length > 0 ? {} : {}),
    ...(folder === undefined ? {} : { folder }),
  }
}

/** Builds the raw RFC 5322 message himalaya submits over SMTP. */
export function buildRawMessage(input: EmailSendInput): string {
  const headers: string[] = []
  const recipients = (value: string | string[] | undefined): string[] =>
    value === undefined ? [] : typeof value === 'string' ? [value] : value
  headers.push(`To: ${recipients(input.to).join(', ')}`)
  const cc = recipients(input.cc)
  if (cc.length > 0) headers.push(`Cc: ${cc.join(', ')}`)
  const bcc = recipients(input.bcc)
  if (bcc.length > 0) headers.push(`Bcc: ${bcc.join(', ')}`)
  if (input.replyTo !== undefined) headers.push(`Reply-To: ${input.replyTo}`)
  headers.push(`Subject: ${input.subject}`)
  headers.push(`MIME-Version: 1.0`)
  headers.push(`Content-Type: ${input.html === true ? 'text/html' : 'text/plain'}; charset=utf-8`)
  return `${headers.join('\r\n')}\r\n\r\n${input.body}`
}

/**
 * The himalaya argv for one send. himalaya v1.2 takes the RAW message (headers
 * and body) as its positional argument, so the message travels as ONE
 * single-quoted argument: the transport hands it to the target shell, which
 * never word-splits or globs inside the quotes.
 */
export function sendArgv(account: string | undefined, raw: string): string {
  const argv = ['himalaya']
  if (account !== undefined) argv.push('-a', shellQuote(account))
  argv.push('message', 'send', shellQuote(raw))
  return argv.join(' ')
}

/**
 * The `email@1` provider over a `himalaya@1` service. The account map is
 * resolved once here; the credential NAME of an account is verified at call
 * time through the credentials capability (a missing credential is a structured
 * error, never a silent unauthenticated call).
 */
export function createEmailProvider(himalaya: HimalayaService, config: EmailHimalayaConfig, ctx: ServiceContext): EmailProvider {
  const rows = config.accounts ?? {}
  const labels = Object.keys(rows)
  const defaultLabel = config.defaultAccount ?? labels[0]

  const resolve = (ref?: EmailRef): { label: string; row: AccountRow; accountName: string } => {
    const label = ref?.label ?? defaultLabel
    if (label === undefined) {
      throw new ServiceError('not-configured', 'email-himalaya: no account configured', { stage: 'email.accounts' })
    }
    const row = rows[label]
    if (row === undefined) {
      throw new ServiceError('invalid-input', `email-himalaya: unknown account '${label}' (configured: ${labels.join(', ') || 'none'})`, {
        stage: 'email.accounts',
        details: { label, configured: labels },
      })
    }
    return { label, row, accountName: row.accountName ?? label }
  }

  /** Resolves the account's credential NAME, when one is declared. */
  const checkCredential = async (row: AccountRow): Promise<void> => {
    if (row.credential === undefined) return
    const credentials = credentialsOf(ctx)
    if (credentials === undefined) {
      throw new ServiceError('missing-service', `email-himalaya: account credential '${row.credential}' cannot be resolved: no credentials capability`, {
        stage: 'email.credentials',
        details: { credential: row.credential },
      })
    }
    const resolved = await credentials.resolve({ name: row.credential })
    if (resolved === undefined || resolved.value === undefined || resolved.value.length === 0) {
      throw new ServiceError('not-configured', `email-himalaya: credential '${row.credential}' is not resolvable`, {
        stage: 'email.credentials',
        details: { credential: row.credential },
      })
    }
  }

  const provider: EmailProvider = {
    id: providerId,
    version: 1,
    describe: () => `himalaya (${labels.length} account(s), default '${defaultLabel ?? 'none'}')`,
    accounts: async (): Promise<EmailAccount[]> => {
      const himalayaAccounts = await himalaya.accounts()
      const byName = new Map(himalayaAccounts.map((entry) => [entry.name, entry]))
      if (labels.length === 0) {
        return himalayaAccounts.map((entry) => ({ label: entry.name, default: entry.default }))
      }
      return labels.map((label) => {
        const row = rows[label] as AccountRow
        const accountName = row.accountName ?? label
        const known = byName.get(accountName)
        return {
          label,
          ...(row.address === undefined ? {} : { address: row.address }),
          default: label === defaultLabel,
          description: known === undefined ? `himalaya account '${accountName}' (not declared in the CLI config)` : `himalaya account '${accountName}'`,
        }
      })
    },
    list: async (ref?: EmailRef, options: EmailListOptions = {}): Promise<EmailSummary[]> => {
      const target = resolve(ref)
      await checkCredential(target.row)
      const folder = options.folder ?? target.row.folder
      const envelopes = await himalaya.envelopeList({
        account: target.accountName,
        ...(folder === undefined ? {} : { folder }),
        ...(options.query === undefined ? {} : { query: options.query }),
        pageSize: Math.min(options.pageSize === undefined ? MAX_PAGE : options.pageSize, MAX_PAGE),
      })
      const summaries = envelopes.map((envelope) => toSummary(envelope, folder))
      return options.unreadOnly === true ? summaries.filter((summary) => summary.unread) : summaries
    },
    get: async (ref: EmailRef | undefined, id: string, options: EmailGetOptions = {}): Promise<EmailMessage> => {
      const target = resolve(ref)
      await checkCredential(target.row)
      const folder = options.folder ?? target.row.folder
      const message = await himalaya.messageRead({
        account: target.accountName,
        id,
        ...(folder === undefined ? {} : { folder }),
        ...(options.noHeaders === true ? { noHeaders: true } : {}),
      })
      const format: EmailFormat = options.format ?? 'text'
      const summary: EmailSummary = {
        id,
        subject: '',
        from: '',
        to: [],
        date: '',
        unread: false,
        ...(folder === undefined ? {} : { folder }),
      }
      return {
        ...summary,
        text: message.text,
        raw: message.raw ?? message.text,
        attachments: [],
        format,
      }
    },
    send: async (input: EmailSendInput): Promise<EmailSendResult> => {
      const target = resolve(input.ref)
      await checkCredential(target.row)
      const raw = buildRawMessage(input)
      const result = await himalaya.run({ args: sendArgv(target.accountName, raw), account: undefined })
      return {
        account: target.label,
        accepted: [typeof input.to === 'string' ? input.to : input.to.join(', ')],
        output: result.output.trim().slice(0, 2000),
      }
    },
  }
  return provider
}

/** The service a consumer sees: configured, or a structured not-configured one. */
export function createNotConfiguredService(reason: string): EmailService {
  const fail = (): never => {
    throw new ServiceError('not-configured', `email: ${reason}`, { stage: 'email.apply' })
  }
  return withDerivedEmailCommands({
    id: providerId,
    describe: () => `not configured (${reason})`,
    accounts: async () => fail(),
    list: async () => fail(),
    get: async () => fail(),
    send: async () => fail(),
  })
}

export async function apply(ctx: ServiceContext, config: EmailHimalayaConfig = {}): Promise<void> {
  assertPolicyDeclared(import.meta.url, {
    execution: 'remote',
    capabilities: [EMAIL, HIMALAYA],
  })

  // SOFT, BOUNDED ordering hint: the himalaya service is this provider's backend.
  await waitForServices(ctx, [HIMALAYA], {
    timeoutMs: config.himalayaWaitMs ?? DEFAULT_HIMALAYA_WAIT_MS,
    pollMs: 25,
  })
  const himalaya = serviceOfHimalaya(ctx)
  if (himalaya === undefined || himalaya.describe?.()?.startsWith('not configured') === true) {
    const reason = himalaya === undefined ? "the 'himalaya' service is not loaded (enable plugins/himalaya-impl)" : 'the himalaya service is not configured'
    provideService(ctx, MAIL, createNotConfiguredService(reason))
    ctx.logger?.info?.(`email-himalaya: not configured (${reason})`)
    return
  }

  const provider = createEmailProvider(himalaya, config, ctx)
  const service = withDerivedEmailCommands(provider)
  // The plugins-repo service name (it has `send`, which the kernel copy lacks).
  provideService(ctx, MAIL, service)

  // Backward compatibility: when the kernel hosts `email@1` (a core service),
  // feed it too, so consumers using `ctx.email` keep working. A kernel whose
  // service is absent or already taken must not break this provider.
  if (config.registerWithKernel !== false) {
    const kernel = (ctx as { email?: { register?: (descriptor: unknown) => unknown } }).email
    if (kernel !== undefined && typeof kernel.register === 'function') {
      try {
        kernel.register({
          id: providerId,
          version: 1,
          descriptor: {
            accounts: provider.accounts,
            list: provider.list,
            get: provider.get,
            send: provider.send,
          },
        })
        ctx.logger?.info?.('email-himalaya: also registered with the kernel-hosted email service')
      } catch (error) {
        ctx.logger?.warn?.(`email-himalaya: the kernel email service refused the provider (${messageOf(error)})`)
      }
    }
  }
  void EMAIL
}

export default { name, inject: [], apply }
