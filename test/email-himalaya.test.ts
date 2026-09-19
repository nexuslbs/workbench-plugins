// Unit test for the `email@1` PROVIDER (EmailHimalaya, plugins/email-himalaya).
//
// It must implement the GENERIC email contract ON TOP OF the `himalaya@1`
// service: no CLI, no docker, no ssh, no protocol. The `himalaya` service is a
// FAKE here (a recording stub), so every assertion is about the MAPPING and the
// account/credential discipline - never about a binary.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_HIMALAYA_WAIT_MS,
  MAX_PAGE,
  apply,
  buildRawMessage,
  createEmailProvider,
  createNotConfiguredService,
  name,
  providerId,
  sendArgv,
  toSummary,
} from '../plugins/email-himalaya/index.ts'
import { EMAIL_CONTRACT, MAIL } from '../definitions/email.ts'
import { HIMALAYA } from '../definitions/himalaya.ts'
import { ServiceError } from '../definitions/support.ts'

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'email-himalaya')

interface HimalayaCall {
  method: string
  query?: Record<string, unknown>
  args?: string
  account?: string
}

/** A recording FAKE `himalaya@1` service: the typed surface, no CLI at all. */
function fakeHimalaya(describe = 'fake himalaya (test)'): {
  calls: HimalayaCall[]
  service: Record<string, unknown>
} {
  const calls: HimalayaCall[] = []
  const service = {
    contract: 'himalaya@1',
    provider: 'fake',
    describe: () => describe,
    accounts: async () => [
      { name: 'personal', backend: 'imap', default: true },
      { name: 'work', backend: 'imap' },
    ],
    folders: async () => [{ name: 'INBOX' }],
    envelopeList: async (query?: Record<string, unknown>) => {
      calls.push({ method: 'envelopeList', query })
      return [
        {
          id: '42',
          flags: [],
          subject: 'Your sign-in code',
          from: 'Acme <no-reply@acme.test>',
          to: 'Me <me@example.com>, Other <o@example.com>',
          date: '2026-09-19T09:00:00Z',
          hasAttachment: false,
        },
        {
          id: '41',
          flags: ['Seen'],
          subject: 'Shipped',
          from: 'Shop <shop@acme.test>',
          to: '',
          date: '2026-09-17T09:00:00Z',
          hasAttachment: false,
        },
      ]
    },
    messageRead: async (query: Record<string, unknown>) => {
      calls.push({ method: 'messageRead', query })
      return { text: 'Your code is 123456', raw: '{"text":"Your code is 123456"}' }
    },
    run: async (input: { args: string; account?: string }) => {
      calls.push({ method: 'run', args: input.args, account: input.account })
      return { output: 'message sent', code: 0 }
    },
  }
  return { calls, service }
}

interface Booted {
  services: Map<string, Record<string, unknown>>
  logs: string[]
  kernel: Record<string, unknown>[]
  disposers: (() => void)[]
}

async function boot(
  config: Record<string, unknown>,
  services: Record<string, Record<string, unknown>> = {},
  credentials?: { resolve: (ref: { name: string }) => Promise<{ value?: string } | undefined> },
): Promise<Booted> {
  const store = new Map<string, Record<string, unknown>>(Object.entries(services))
  const logs: string[] = []
  const kernel: Record<string, unknown>[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    provide(serviceName: string, value: unknown): unknown {
      store.set(serviceName, value as Record<string, unknown>)
      return value
    },
    get(serviceName: string): unknown {
      return store.get(serviceName)
    },
    on(): unknown {
      return undefined
    },
    effect(callback: () => () => void): void {
      disposers.push(callback())
    },
    // The logger SERVICE is a CALLABLE that yields the levelled handle
    // (definitions/logger.ts): `ctx.logger(name).info(...)`, not an object.
    logger: (name?: string) => ({
      error: (...args: unknown[]) => logs.push(args.join(' ')),
      warn: (...args: unknown[]) => logs.push(args.join(' ')),
      info: (...args: unknown[]) => logs.push(args.join(' ')),
      debug: (...args: unknown[]) => logs.push(args.join(' ')),
    }),
    ...(credentials === undefined ? {} : { credentials }),
    email: {
      register(descriptor: Record<string, unknown>): void {
        kernel.push(descriptor)
      },
    },
  }
  // The soft, bounded load-after wait uses UNREF'D timers (it must never hold a
  // real process open). A test has no other handle, so it keeps the loop alive
  // for the duration of `apply` - otherwise node drains the loop while the wait
  // is pending.
  const keepAlive = setInterval(() => {}, 5)
  try {
    await apply(ctx as never, { himalayaWaitMs: 20, ...config } as never)
  } finally {
    clearInterval(keepAlive)
  }
  return { services: store, logs, kernel, disposers }
}

const ACCOUNTS = {
  personal: { address: 'me@example.com', accountName: 'personal', folder: 'INBOX' },
  work: { address: 'me@work.example', accountName: 'work' },
}

test('the plugin speaks email@1 and claims the manifest provider id', () => {
  assert.equal(name, 'email-himalaya')
  assert.equal(providerId, 'himalaya')
  assert.equal(EMAIL_CONTRACT, 'email@1')
  assert.equal(MAIL, 'mail')
  assert.equal(DEFAULT_HIMALAYA_WAIT_MS, 1500)
  assert.equal(MAX_PAGE, 50)
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'workbench.plugin.json'), 'utf8')) as {
    capabilities: { id: string; version: number; provider: string }[]
  }
  assert.deepEqual(manifest.capabilities, [{ id: 'email', version: 1, provider: 'himalaya' }])
})

test('no himalaya service: NOT CONFIGURED (a service that answers structured errors), never a throw', async () => {
  const booted = await boot({ accounts: ACCOUNTS })
  assert.equal(booted.kernel.length, 0, 'nothing is registered with the kernel')
  const service = booted.services.get(MAIL)
  assert.ok(service, 'the plugins-repo service is still provided')
  await assert.rejects(
    () => (service?.list as (ref?: unknown, options?: unknown) => Promise<unknown>)(undefined, {}),
    (error: unknown) => error instanceof ServiceError && error.code === 'not-configured',
  )
  assert.ok(
    booted.logs.some((line) => line.includes('not configured') && line.includes(HIMALAYA)),
    'the reason is logged',
  )
})

test('no accounts configured: the provider is still usable and lists nothing (labels come from the CLI)', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: {} }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as { accounts: () => Promise<{ label: string; default?: boolean }[]> }
  const accounts = await service.accounts()
  assert.deepEqual(accounts, [{ label: 'personal', default: true }, { label: 'work', default: undefined }])
})

test('accounts() reports the configured labels, the himalaya account names and the DEFAULT account', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS, defaultAccount: 'work' }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as {
    accounts: () => Promise<{ label: string; address?: string; default?: boolean; description?: string }[]>
    describe?: () => string
  }
  const accounts = await service.accounts()
  assert.deepEqual(accounts.map((account) => account.label), ['personal', 'work'])
  assert.equal(accounts[0]?.address, 'me@example.com')
  assert.equal(accounts[0]?.default, false)
  assert.equal(accounts[1]?.default, true, "the operator's defaultAccount is the default")
  assert.match(accounts[0]?.description ?? '', /himalaya account 'personal'/)
  assert.match(service.describe?.() ?? '', /himalaya \(2 account\(s\), default 'work'\)/)
})

test('list() asks himalaya for the account + folder + a bounded page and normalises the envelope', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS, defaultAccount: 'personal' }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as {
    list: (ref?: unknown, options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  }
  const messages = await service.list(undefined, { pageSize: 500 })
  assert.deepEqual(fake.calls[0], {
    method: 'envelopeList',
    query: { account: 'personal', folder: 'INBOX', pageSize: MAX_PAGE },
  })
  assert.deepEqual(messages[0], {
    id: '42',
    subject: 'Your sign-in code',
    from: 'Acme <no-reply@acme.test>',
    to: ['Me <me@example.com>', 'Other <o@example.com>'],
    date: '2026-09-19T09:00:00Z',
    unread: true,
    folder: 'INBOX',
  })
  assert.equal(messages[1]?.unread, false, "himalaya's Seen flag means read")
  assert.deepEqual(messages[1]?.to, [], 'an empty To list is an empty list')
})

test('list() selects the account by LABEL and unreadOnly filters the typed answer', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as {
    list: (ref?: unknown, options?: Record<string, unknown>) => Promise<{ id: string }[]>
  }
  const unread = await service.list({ label: 'work' }, { unreadOnly: true })
  assert.equal((fake.calls[0]?.query as { account: string }).account, 'work')
  assert.deepEqual(unread.map((message) => message.id), ['42'])
})

test('an unknown account label is a structured error naming the configured labels', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as { list: (ref?: unknown, options?: unknown) => Promise<unknown> }
  await assert.rejects(
    () => service.list({ label: 'absent' }, {}),
    (error: unknown) => error instanceof ServiceError && error.code === 'invalid-input' && /unknown account 'absent' \(configured: personal, work\)/.test(error.message),
  )
})

test('get() forwards the id, the folder and the noHeaders flag and returns the typed body', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as {
    get: (ref: unknown, id: string, options?: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  const message = await service.get({ label: 'personal' }, '42', { format: 'text', noHeaders: true })
  assert.deepEqual(fake.calls[0], {
    method: 'messageRead',
    query: { account: 'personal', id: '42', folder: 'INBOX', noHeaders: true },
  })
  assert.equal(message.text, 'Your code is 123456')
  assert.equal(message.raw, '{"text":"Your code is 123456"}')
  assert.equal(message.format, 'text')
  assert.deepEqual(message.attachments, [])
})

test('send() builds the RFC 5322 message and hands ONE quoted argv string to himalaya', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as {
    send: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
  }
  const result = await service.send({
    ref: { label: 'work' },
    to: 'hermes@nexuslbs.org',
    cc: 'copy@nexuslbs.org',
    subject: 'workbench smoke',
    body: 'hello from the test',
  })
  assert.equal(result.account, 'work')
  assert.deepEqual(result.accepted, ['hermes@nexuslbs.org'])
  const argv = String(fake.calls[0]?.args)
  assert.equal(
    fake.calls[0]?.account,
    'work',
    'the account travels as the account field (himalaya-impl prepends the binary and -a)',
  )
  assert.ok(!argv.includes('himalaya'), 'the fragment carries NO binary: the himalaya service owns it')
  assert.ok(
    argv.startsWith("message send <<'WB_HIMALAYA_MESSAGE_EOF'\n"),
    'the raw message rides on STDIN: a POSITIONAL raw message crashes himalaya v1.2 (mail-parser panic)',
  )
  assert.ok(
    argv.trimEnd().endsWith('WB_HIMALAYA_MESSAGE_EOF'),
    'the quoted heredoc closes at the very end (the target shell expands nothing in the body)',
  )
  assert.ok(argv.includes('To: hermes@nexuslbs.org'), 'the recipient header rides in the message body')
  assert.ok(argv.includes('Cc: copy@nexuslbs.org'))
  assert.ok(argv.includes('Subject: workbench smoke'))
  assert.ok(argv.includes('hello from the test'))
  // Exactly ONE argument after `message send`: the raw message cannot word-split.
  assert.equal((argv.match(/'/g) ?? []).length % 2, 0, 'single quotes are balanced')
})

test('the argv builders are pure: headers, quoting and the account flag', () => {
  const raw = buildRawMessage({ to: ['a@x.test', 'b@x.test'], subject: 's', body: 'b' })
  assert.equal(raw, 'To: a@x.test, b@x.test\r\nSubject: s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nb')
  const withFrom = buildRawMessage({ to: 'a@x.test', subject: 's', body: 'b' }, 'hermes@nexuslbs.org')
  assert.ok(withFrom.startsWith('From: hermes@nexuslbs.org\r\n'), 'himalaya rejects a message without a sender')
  const html = buildRawMessage({ to: 'a@x.test', subject: "it's here", body: 'b', html: true }, 'hermes@nexuslbs.org')
  assert.ok(html.includes("Subject: it's here"))
  assert.ok(html.includes('Content-Type: text/html'))
  const argv = sendArgv(html)
  assert.ok(argv.startsWith('message send '), 'the fragment starts AFTER the binary and carries no account flag')
  assert.ok(argv.includes("<<'WB_HIMALAYA_MESSAGE_EOF'"), 'the message travels on stdin, never as a positional word')
  assert.deepEqual(toSummary({ id: '1', flags: [], subject: 's', from: 'f', to: '', date: 'd', hasAttachment: false }).to, [])
})

test('a credential NAME is resolved through credentials at CALL time; the value never reaches the argv', async () => {
  const fake = fakeHimalaya()
  const resolved: string[] = []
  const secret = 'app-password-not-a-real-secret'
  const booted = await boot(
    { accounts: { personal: { ...ACCOUNTS.personal, credential: 'EMAIL_PERSONAL_PASSWORD' } } },
    { [HIMALAYA]: fake.service },
    {
      resolve: async (ref: { name: string }) => {
        resolved.push(ref.name)
        return { value: secret }
      },
    },
  )
  const service = booted.services.get(MAIL) as {
    list: (ref?: unknown, options?: unknown) => Promise<unknown>
    send: (input: Record<string, unknown>) => Promise<unknown>
  }
  await service.list(undefined, {})
  assert.deepEqual(resolved, ['EMAIL_PERSONAL_PASSWORD'])
  await service.send({ to: 'a@x.test', subject: 's', body: 'b' })
  assert.deepEqual(resolved, ['EMAIL_PERSONAL_PASSWORD', 'EMAIL_PERSONAL_PASSWORD'], 'checked on every call')
  assert.equal(
    (fake.calls[0]?.query === undefined ? '' : String(fake.calls[0].query)).includes(secret),
    false,
    'the value never reaches a himalaya query',
  )
  assert.equal(
    fake.calls.some((call) => String(call.args ?? '').includes(secret)),
    false,
    'the value never reaches the argv',
  )
  assert.equal(
    booted.logs.some((line) => line.includes(secret)),
    false,
    'the value never reaches a log line',
  )
})

test('an unresolvable credential is a structured error BEFORE any backend call', async () => {
  const fake = fakeHimalaya()
  const booted = await boot(
    { accounts: { personal: { ...ACCOUNTS.personal, credential: 'MISSING_ONE' } } },
    { [HIMALAYA]: fake.service },
    { resolve: async () => undefined },
  )
  const service = booted.services.get(MAIL) as { list: (ref?: unknown, options?: unknown) => Promise<unknown> }
  await assert.rejects(
    () => service.list(undefined, {}),
    (error: unknown) => error instanceof ServiceError && error.code === 'not-configured' && /credential 'MISSING_ONE' is not resolvable/.test(error.message),
  )
  assert.equal(fake.calls.length, 0, 'the backend was never called')
})

test('a credential with NO credentials capability is a structured missing-service error', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: { personal: { ...ACCOUNTS.personal, credential: 'SOME_NAME' } } }, { [HIMALAYA]: fake.service })
  const service = booted.services.get(MAIL) as { list: (ref?: unknown, options?: unknown) => Promise<unknown> }
  await assert.rejects(
    () => service.list(undefined, {}),
    (error: unknown) => error instanceof ServiceError && error.code === 'missing-service',
  )
})

test('a CONFIGURED provider is also fed to the kernel-hosted email service (backward compat)', async () => {
  const fake = fakeHimalaya()
  const booted = await boot({ accounts: ACCOUNTS }, { [HIMALAYA]: fake.service })
  assert.equal(booted.kernel.length, 1)
  assert.equal(booted.kernel[0]?.id, 'himalaya')
  assert.equal(typeof (booted.kernel[0]?.descriptor as Record<string, unknown>)?.send, 'function')
  assert.deepEqual(Object.keys(booted.kernel[0]?.descriptor as Record<string, unknown>).sort(), ['accounts', 'get', 'list', 'send'])
})

test('a NOT-CONFIGURED provider never throws at load and its service answers structured errors', async () => {
  const service = createNotConfiguredService("the 'himalaya' service is not loaded")
  await assert.rejects(
    () => service.accounts(),
    (error: unknown) => error instanceof ServiceError && error.code === 'not-configured',
  )
  assert.match(service.describe?.() ?? '', /not configured/)
})

test('createEmailProvider is instantiable directly with any himalaya@1 service', async () => {
  const fake = fakeHimalaya()
  const provider = createEmailProvider(fake.service as never, { accounts: ACCOUNTS }, {} as never)
  const summaries = await provider.list(undefined, { pageSize: 1 })
  assert.equal(summaries.length, 2)
  assert.equal((fake.calls[0]?.query as { pageSize: number }).pageSize, 1)
})
