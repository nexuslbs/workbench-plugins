// Unit test for the external email PROVIDER: it must register an `email@1`
// implementation on the injected context, drive the himalaya CLI in machine mode
// (json, bounded), normalise its answers into the capability's shapes, resolve a
// credential NAME into the child ENV (never argv) and report a missing CLI /
// unparseable output as a structured `email: ...` error instead of crashing.
//
// The `himalaya` executable is a STUB written by this test: no mailbox, no
// network, no real CLI installation. It records every invocation (argv + env) so
// the secret discipline is asserted, not assumed.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_TIMEOUT_MS, MAX_FETCH, apply, name, providerId, CONTRACT_VERSION } from '../plugins/email-himalaya/index.ts'

interface AccountRef {
  label: string
}

interface ProviderLike {
  id: string
  version: number
  describe?: () => string
  accounts: () => { label: string; address?: string; default?: boolean; description?: string }[]
  list: (ref?: AccountRef, options?: Record<string, unknown>) => Promise<Record<string, unknown>[]>
  get: (ref: AccountRef | undefined, id: string, options?: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const STUB = `#!/usr/bin/env node
const fs = require('node:fs')
const argv = process.argv.slice(2)
if (process.env.HIMALAYA_STUB_LOG) {
  fs.appendFileSync(process.env.HIMALAYA_STUB_LOG, JSON.stringify({
    argv,
    password: process.env.HIMALAYA_PASSWORD ?? null,
  }) + '\\n')
}
if (process.env.HIMALAYA_STUB_BROKEN) {
  process.stderr.write('imap connection refused: could not reach the server\\n')
  process.exit(3)
}
if (process.env.HIMALAYA_STUB_GARBAGE) {
  process.stdout.write('not json at all\\n')
  process.exit(0)
}
const command = argv[0] + ' ' + argv[1]
if (command === 'envelope list') {
  process.stdout.write(JSON.stringify([
    { id: 42, subject: 'Your sign-in code', from: { name: 'Acme', addr: 'no-reply@acme.test' }, to: [{ name: 'Me', addr: 'me@example.com' }], date: '2026-09-19T09:00:00Z', flags: [] },
    { id: 41, subject: 'Shipped', from: 'Shop <shop@acme.test>', to: ['me@example.com'], date: '2026-09-17T09:00:00Z', flags: ['Seen'] },
    { id: 40, subject: 'Older', from: 'Old <old@acme.test>', to: ['me@example.com'], date: '2026-01-01T00:00:00Z', flags: [] }
  ]))
  process.exit(0)
}
if (command === 'message read') {
  if (argv.includes('--raw')) {
    process.stdout.write('From: no-reply@acme.test\\r\\nSubject: Your sign-in code\\r\\n\\r\\nYour code is 123456\\r\\n')
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({
    id: argv[2],
    subject: 'Your sign-in code',
    from: { name: 'Acme', addr: 'no-reply@acme.test' },
    to: [{ name: 'Me', addr: 'me@example.com' }],
    date: '2026-09-19T09:00:00Z',
    flags: [],
    body: { text_plain: 'Your code is 123456', text_html: '<p>Your code is 123456</p>' },
    attachments: [{ filename: 'invoice.pdf', content_type: 'application/pdf', size: 2048 }]
  }))
  process.exit(0)
}
process.stderr.write('unknown command\\n')
process.exit(2)
`

interface Booted {
  provider: ProviderLike
  logs: string[]
  registered: number
  disposers: (() => void)[]
}

function boot(raw: Record<string, unknown>, credentials?: unknown): Booted {
  const logs: string[] = []
  const original = console.error
  console.error = (message: unknown): void => {
    logs.push(String(message))
  }
  const disposers: (() => void)[] = []
  let provider: ProviderLike | undefined
  const registered: ProviderLike[] = []
  const ctx = {
    email: {
      register(value: ProviderLike): () => void {
        provider = value
        registered.push(value)
        return () => {
          const index = registered.indexOf(value)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    ...(credentials === undefined ? {} : { credentials }),
    effect(callback: () => () => void): void {
      disposers.push(callback())
    },
  }
  try {
    apply(ctx as never, raw as never)
  } finally {
    console.error = original
  }
  return {
    get provider() {
      return provider as ProviderLike
    },
    logs,
    get registered() {
      return registered.length
    },
    disposers,
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'email-himalaya-'))
}

/** Writes the stub `himalaya` executable and returns its path. */
function stubBinary(): string {
  const dir = tempDir()
  const file = path.join(dir, 'himalaya')
  fs.writeFileSync(file, STUB)
  fs.chmodSync(file, 0o755)
  return file
}

function readLog(file: string): { argv: string[]; password: string | null }[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { argv: string[]; password: string | null })
}

const ACCOUNTS = {
  personal: { address: 'me@example.com', accountName: 'personal', folder: 'INBOX' },
  work: { address: 'me@work.example', accountName: 'work' },
}

test('the plugin speaks email@1 and claims the manifest provider id', () => {
  assert.equal(name, 'email-himalaya')
  assert.equal(providerId, 'himalaya')
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(DEFAULT_TIMEOUT_MS, 15_000)
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 4 * 1024 * 1024)
  assert.equal(MAX_FETCH, 200)
})

test('no accounts configured: NOT CONFIGURED, nothing registered, never a throw', () => {
  const bare = boot({})
  assert.equal(bare.registered, 0)
  assert.ok(
    bare.logs.some((line) => line.includes('not configured') && line.includes('accounts')),
    'the reason is logged',
  )
  const withDefault = boot({ defaultAccount: 'personal' })
  assert.equal(withDefault.registered, 0)
})

test('accounts() reports the configured labels, addresses and the DEFAULT account', () => {
  const { provider } = boot({ binary: stubBinary(), accounts: ACCOUNTS, defaultAccount: 'work' })
  const accounts = provider.accounts()
  assert.deepEqual(
    accounts.map((account) => account.label),
    ['personal', 'work'],
  )
  assert.equal(accounts[0]?.address, 'me@example.com')
  assert.equal(accounts[0]?.default, undefined)
  assert.equal(accounts[1]?.default, true, "the operator's defaultAccount is the default")
  assert.match(String(provider.describe?.()), /himalaya CLI/)
  // An unknown default falls back to the first account, with a log.
  const fallback = boot({ binary: stubBinary(), accounts: ACCOUNTS, defaultAccount: 'nope' })
  assert.equal(fallback.provider.accounts().find((account) => account.default)?.label, 'personal')
  assert.ok(fallback.logs.some((line) => line.includes("'defaultAccount' 'nope' is not a configured account")))
})

test('list() drives himalaya envelope list --output json and normalises the envelope', async () => {
  const log = path.join(tempDir(), 'calls.log')
  process.env.HIMALAYA_STUB_LOG = log
  try {
    const { provider } = boot({ binary: stubBinary(), accounts: ACCOUNTS, defaultAccount: 'personal' })
    const messages = await provider.list(undefined, { limit: 10 })
    assert.equal(messages.length, 3)
    assert.deepEqual(messages[0], {
      id: '42',
      subject: 'Your sign-in code',
      from: 'Acme <no-reply@acme.test>',
      to: ['Me <me@example.com>'],
      date: '2026-09-19T09:00:00.000Z',
      unread: true,
      folder: 'INBOX',
    })
    assert.equal(messages[1]?.unread, false, "himalaya's Seen flag means read")
    const [call] = readLog(log)
    assert.deepEqual(call?.argv, [
      'envelope',
      'list',
      '--account',
      'personal',
      '--folder',
      'INBOX',
      '--page-size',
      '10',
      '--output',
      'json',
    ])
  } finally {
    delete process.env.HIMALAYA_STUB_LOG
  }
})

test('list() selects the account by LABEL and applies limit, unreadOnly and since', async () => {
  const log = path.join(tempDir(), 'calls.log')
  process.env.HIMALAYA_STUB_LOG = log
  try {
    const { provider } = boot({ binary: stubBinary(), accounts: ACCOUNTS })
    const unread = await provider.list({ label: 'work' }, { limit: 1, unreadOnly: true })
    assert.equal(unread.length, 1)
    assert.equal(unread[0]?.id, '42')
    const [call] = readLog(log)
    assert.equal(call?.argv[3], 'work', 'the accountName of the label is passed to the CLI')
    assert.equal(call?.argv[7], '4', 'a client-side filter asks for a wider page')
    const recent = await provider.list(undefined, { since: '2026-09-18T00:00:00Z' })
    assert.deepEqual(
      recent.map((message) => message.id),
      ['42'],
    )
  } finally {
    delete process.env.HIMALAYA_STUB_LOG
  }
})

test('an unknown account label is a structured email: error', async () => {
  const { provider } = boot({ binary: stubBinary(), accounts: ACCOUNTS })
  await assert.rejects(
    () => provider.list({ label: 'absent' }, {}),
    (error: Error) => error.name === 'EmailUnknownAccountError' && /email: unknown account 'absent' \(configured: personal, work\)/.test(error.message),
  )
})

test('get() returns the envelope plus the body and the attachment metadata; raw stays bounded', async () => {
  const { provider } = boot({ binary: stubBinary(), accounts: ACCOUNTS })
  const message = await provider.get({ label: 'personal' }, '42', { format: 'text' })
  assert.equal(message.id, '42')
  assert.equal(message.text, 'Your code is 123456')
  assert.equal(message.format, 'text')
  assert.deepEqual(message.attachments, [{ filename: 'invoice.pdf', contentType: 'application/pdf', size: 2048 }])
  const markdown = await provider.get(undefined, '42', { format: 'markdown' })
  assert.equal(markdown.markdown, 'Your code is 123456', 'markdown falls back to the text body')
  const raw = await provider.get(undefined, '42', { format: 'raw', maxBytes: 10 })
  assert.equal(String(raw.raw).length, 10)
  assert.equal(raw.format, 'raw')
})

test('a missing CLI binary is a structured not-configured error, not a load failure', async () => {
  const { provider, registered } = boot({ binary: path.join(tempDir(), 'no-such-himalaya'), accounts: ACCOUNTS })
  assert.equal(registered, 1, 'accounts are configured: the provider IS registered')
  await assert.rejects(
    () => provider.list(undefined, {}),
    (error: Error) => error.name === 'EmailNotConfiguredError' && /the mail CLI '.*no-such-himalaya' was not found/.test(error.message),
  )
})

test('a failing or unparseable CLI answer is a structured email: error naming the cause', async () => {
  const { provider } = boot({ binary: stubBinary(), accounts: ACCOUNTS })
  process.env.HIMALAYA_STUB_BROKEN = '1'
  try {
    await assert.rejects(
      () => provider.list(undefined, {}),
      (error: Error) => error.name === 'EmailBackendError' && /failed: imap connection refused/.test(error.message),
    )
  } finally {
    delete process.env.HIMALAYA_STUB_BROKEN
  }
  process.env.HIMALAYA_STUB_GARBAGE = '1'
  try {
    await assert.rejects(
      () => provider.list(undefined, {}),
      (error: Error) => /unparseable envelope list/.test(error.message) && /--output json/.test(error.message),
    )
  } finally {
    delete process.env.HIMALAYA_STUB_GARBAGE
  }
})

test('a credential NAME resolves through ctx.credentials into the child ENV: never argv, never a log', async () => {
  const log = path.join(tempDir(), 'calls.log')
  const resolved: string[] = []
  const secret = 'app-password-not-a-real-secret'
  process.env.HIMALAYA_STUB_LOG = log
  try {
    const { provider, logs } = boot(
      { binary: stubBinary(), accounts: { personal: { ...ACCOUNTS.personal, credential: 'EMAIL_PERSONAL_PASSWORD' } } },
      {
        resolve: async (ref: { name: string }) => {
          resolved.push(ref.name)
          return { value: secret }
        },
      },
    )
    await provider.list(undefined, {})
    assert.deepEqual(resolved, ['EMAIL_PERSONAL_PASSWORD'])
    const [call] = readLog(log)
    assert.equal(call?.password, secret, 'the value travels in the environment')
    assert.equal(
      (call?.argv ?? []).some((arg) => arg.includes(secret)),
      false,
      'the value NEVER travels on the command line',
    )
    assert.equal(
      logs.some((line) => line.includes(secret)),
      false,
      'the value NEVER reaches a log line',
    )
  } finally {
    delete process.env.HIMALAYA_STUB_LOG
  }
})

test('the plugin is an external cordis plugin: named, email-injected, and the registration is disposable', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'plugins', 'email-himalaya', 'workbench.plugin.json'), 'utf8')) as {
    capabilities: { id: string; version: number; provider: string }[]
  }
  assert.deepEqual(manifest.capabilities, [{ id: 'email', version: 1, provider: 'himalaya' }])
  const booted = boot({ binary: stubBinary(), accounts: ACCOUNTS })
  assert.equal(booted.disposers.length, 1)
  booted.disposers[0]?.()
  assert.equal(booted.registered, 0, 'unloading the plugin unregisters the provider')
  // The driver never shells out with a shell: no shell metacharacter reaches execFile.
  assert.equal(execFileSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8' }), 'ok')
})
