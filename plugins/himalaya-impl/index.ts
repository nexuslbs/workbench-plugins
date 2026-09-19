// plugins/himalaya-impl - the `himalaya@1` PROVIDER (`cli`): typed mail actions
// over the himalaya CLI, driven THROUGH the general service.
//
// It shells out to NOTHING itself: it injects `general-service@1`, and the
// transport himalaya runs in (a container of the current stack, a remote
// machine, a local binary) is CONFIG - not code:
//
//   config: { general: { type: 'container', params: {
//     engine: 'docker-compose',
//     compose: { project_dir: '${env:OMNI_DIR}', service: 'toolbox' } } } }
//
// The plugin names no image, no host and no project dir of its own: they come
// from the config row (omni-root `config/workbench.yml` in the stack, the
// plugins-repo `config.yml` in development).
//
// The typed actions of the Definition are converted into a himalaya ARGV STRING
// (every value single-quoted, so spaces/quotes survive), sent to the general
// service, and the returned string is parsed back into the typed output. The
// himalaya CLI quirks are honoured here (they are the CLI's, not the
// Definition's): `-o json`, OPTIONS BEFORE THE POSITIONAL QUERY, and
// `message read -o json` returning a JSON STRING.
//
// NOT CONFIGURED is a valid state: with no `general` config the plugin loads,
// logs the reason and provides nothing; a call then answers a structured
// `not-configured` error. It never appears under `failures`.
import {
  HIMALAYA,
  HIMALAYA_CONTRACT,
  himalayaAccount,
  himalayaFolder,
  himalayaMessageId,
  type HimalayaAccount,
  type HimalayaEnvelope,
  type HimalayaEnvelopeQuery,
  type HimalayaFolder,
  type HimalayaFolderQuery,
  type HimalayaInstance,
  type HimalayaMessage,
  type HimalayaMessageQuery,
  type HimalayaRunInput,
  type HimalayaRunResult,
  type HimalayaService,
} from '../../definitions/himalaya.ts'
import {
  GENERAL_SERVICE,
  serviceOfGeneralService,
  type GeneralService,
  type GeneralServiceConfig,
  type GeneralServiceInstance,
} from '../../definitions/general-service.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  messageOf,
  provideService,
  shellQuote,
  waitForServices,
  type ServiceContext,
} from '../../definitions/support.ts'

export const name = 'himalaya-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'cli'

export const contract = HIMALAYA_CONTRACT

/** Default bound of the soft wait for the general service (ms). */
export const DEFAULT_GENERAL_WAIT_MS = 1500

/** Largest page the driver ever asks himalaya for. */
export const MAX_FETCH = 200

export interface HimalayaImplConfig {
  /** The transport himalaya runs in: a `general-service@1` config. */
  general?: GeneralServiceConfig
  /** Optional per-call timeout override (ms). */
  timeoutMs?: number
  /** Bound of the soft wait for the general service (ms). */
  generalWaitMs?: number
}

/** Assembles a himalaya argv STRING from already-validated pieces. */
export function buildArgv(parts: { account?: string; args: readonly string[] }): string {
  const argv: string[] = []
  if (parts.account !== undefined) argv.push('-a', parts.account)
  argv.push(...parts.args)
  return argv.map((part) => shellQuote(part)).join(' ')
}

/** Parses a himalaya `-o json` answer (a JSON document or a JSON string). */
export function parseJson(output: string, what: string): unknown {
  const text = output.trim()
  if (text.length === 0) {
    throw new ServiceError('malformed-output', `himalaya: empty answer for ${what}`, { stage: 'himalaya.parse' })
  }
  try {
    const first = JSON.parse(text) as unknown
    // `message read -o json` answers a JSON STRING containing a JSON document.
    if (typeof first === 'string') return JSON.parse(first)
    return first
  } catch (error) {
    throw new ServiceError('malformed-output', `himalaya: cannot parse the ${what} answer: ${messageOf(error)}`, {
      stage: 'himalaya.parse',
      details: { what, sample: text.slice(0, 200) },
    })
  }
}

function asArray(value: unknown, what: string): unknown[] {
  if (Array.isArray(value)) return value
  if (value === null || value === undefined) return []
  throw new ServiceError('malformed-output', `himalaya: ${what} expects a JSON array`, {
    stage: 'himalaya.parse',
    details: { what, got: typeof value },
  })
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new ServiceError('malformed-output', `himalaya: ${what} expects a JSON object`, {
    stage: 'himalaya.parse',
    details: { what, got: typeof value },
  })
}

function text(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Maps one himalaya envelope (the CLI's own JSON shape) to the Definition's. */
export function toEnvelope(raw: unknown): HimalayaEnvelope {
  const record = asRecord(raw, "an 'envelope list' entry")
  const flagsRaw = record.flags ?? record['flags']
  const flags = Array.isArray(flagsRaw) ? flagsRaw.map((flag) => text(flag)) : text(flagsRaw).length > 0 ? [text(flagsRaw)] : []
  return {
    id: text(record.id ?? record['uid']),
    flags,
    subject: text(record.subject),
    from: text((record.from as Record<string, unknown> | undefined)?.addr ?? record.from),
    to: text(
      Array.isArray(record.to)
        ? (record.to as Record<string, unknown>[]).map((entry) => text(entry.addr ?? entry.name)).filter(Boolean).join(', ')
        : (record.to as Record<string, unknown> | undefined)?.addr ?? record.to,
    ),
    date: text(record.date),
    hasAttachment: Array.isArray(record.attachments) ? (record.attachments as unknown[]).length > 0 : false,
  }
}

/** The `himalaya@1` service bound to ONE general-service instance. */
export function createHimalayaService(general: GeneralServiceInstance): HimalayaService {
  const call = async (args: readonly string[], account?: string): Promise<string> => {
    const argv = buildArgv({ ...(account === undefined ? {} : { account }), args })
    const result = await general.call(argv)
    if (result.code !== 0) {
      throw new ServiceError('non-zero-exit', `himalaya: '${args.join(' ')}' exited ${String(result.code)}: ${(result.stderr ?? result.output).trim().slice(0, 400)}`, {
        stage: 'himalaya.call',
        details: { args: [...args], code: result.code, account: account ?? null },
      })
    }
    return result.output
  }

  const service: HimalayaInstance = {
    contract: HIMALAYA_CONTRACT,
    provider: providerId,
    accounts: async (): Promise<HimalayaAccount[]> => {
      const parsed = parseJson(await call(['account', 'list', '-o', 'json']), 'account list')
      return asArray(parsed, 'account list').map((entry) => {
        const record = asRecord(entry, 'an account entry')
        return {
          name: text(record.name),
          backend: text(record.backend),
          default: record.default === true,
        }
      })
    },
    folders: async (query: HimalayaFolderQuery = {}): Promise<HimalayaFolder[]> => {
      const account = himalayaAccount(query.account)
      const parsed = parseJson(await call(['folder', 'list', '-o', 'json'], account), 'folder list')
      return asArray(parsed, 'folder list').map((entry) => ({
        name: typeof entry === 'string' ? entry : text(asRecord(entry, 'a folder entry').name),
      }))
    },
    envelopeList: async (query: HimalayaEnvelopeQuery = {}): Promise<HimalayaEnvelope[]> => {
      const account = himalayaAccount(query.account)
      const folder = himalayaFolder(query.folder)
      const args: string[] = ['envelope', 'list', '-o', 'json']
      const pageSize = query.pageSize === undefined ? MAX_FETCH : Math.min(Math.max(1, Math.floor(query.pageSize)), MAX_FETCH)
      args.push('--page-size', String(pageSize))
      if (folder !== undefined) args.push(folder)
      // OPTIONS BEFORE THE POSITIONAL QUERY (himalaya quirk 2).
      if (query.query !== undefined && query.query.trim().length > 0) args.push(query.query.trim())
      const parsed = parseJson(await call(args, account), 'envelope list')
      return asArray(parsed, 'envelope list').map((entry) => toEnvelope(entry))
    },
    messageRead: async (query: HimalayaMessageQuery): Promise<HimalayaMessage> => {
      const id = himalayaMessageId(query.id)
      const account = himalayaAccount(query.account)
      const folder = himalayaFolder(query.folder)
      const args: string[] = ['message', 'read', '-o', 'json']
      if (query.noHeaders === true) args.push('--no-headers')
      if (folder !== undefined) args.push('--folder', folder)
      args.push(id)
      const raw = await call(args, account)
      let parsed: unknown
      try {
        parsed = parseJson(raw, 'message read')
      } catch {
        // The CLI answered plain text: honour it rather than failing the read.
        return { text: raw }
      }
      if (typeof parsed === 'string') return { text: parsed, raw: raw.trim() }
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        return { text: text(record.text ?? record.body ?? record.content), raw: raw.trim() }
      }
      return { text: raw }
    },
    run: async (input: HimalayaRunInput): Promise<HimalayaRunResult> => {
      const account = himalayaAccount(input.account)
      const output = await call([input.args], account)
      return { output, code: 0 }
    },
  }
  return service
}

/** The service a consumer sees: configured, or a structured not-configured one. */
export function createNotConfiguredService(reason: string): HimalayaService {
  const fail = (): never => {
    throw new ServiceError('not-configured', `himalaya: ${reason}`, { stage: 'himalaya.apply' })
  }
  return {
    contract: HIMALAYA_CONTRACT,
    provider: providerId,
    describe: () => `not configured (${reason})`,
    accounts: async () => fail(),
    folders: async () => fail(),
    envelopeList: async () => fail(),
    messageRead: async () => fail(),
    run: async () => fail(),
  }
}

export async function apply(ctx: ServiceContext, config: HimalayaImplConfig = {}): Promise<void> {
  assertPolicyDeclared(import.meta.url, { execution: 'remote', capabilities: [HIMALAYA] })
  if (config.general === undefined) {
    provideService(ctx, HIMALAYA, createNotConfiguredService('no `general` transport configured for himalaya'))
    ctx.logger?.info?.('himalaya-impl: not configured (no `general` config row): calls answer a structured error')
    return
  }
  // SOFT, BOUNDED ordering hint: the general service is the transport selector.
  await waitForServices(ctx, [GENERAL_SERVICE], {
    timeoutMs: config.generalWaitMs ?? DEFAULT_GENERAL_WAIT_MS,
    pollMs: 25,
  })
  const general: GeneralService | undefined = serviceOfGeneralService(ctx)
  if (general === undefined) {
    throw new ServiceError(
      'missing-service',
      `himalaya: the '${GENERAL_SERVICE}' service is not loaded (enable plugins/general-service-impl)`,
      { stage: 'himalaya.apply', details: { missing: GENERAL_SERVICE } },
    )
  }
  // Instance-style: the transport is validated HERE, at load, BEFORE any call.
  const instance = general.create(config.general)
  provideService(ctx, HIMALAYA, createHimalayaService(instance))
}

export default { name, inject: [], apply }
