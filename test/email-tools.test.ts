// Unit test for the email CONSUMER: it must register the four operator tools on
// the injected context, validate real typed parameters, forward the account
// reference (never a backend detail) and stay identical when the provider behind
// `ctx.email` is swapped. Nothing here imports a provider or the core.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, name } from '../plugins/email-tools/index.ts'

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'email-tools')

interface ToolParam {
  type: string
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

interface ToolDef {
  name: string
  description?: string
  parameters?: Record<string, ToolParam>
  handler: (params: Record<string, unknown>) => unknown
}

interface Call {
  method: string
  ref: { label: string } | undefined
  options: Record<string, unknown> | undefined
  id?: string
}

/** A FAKE email service: the same Definition surface, no backend at all. */
function fakeEmail(marker: string): {
  calls: Call[]
  service: Record<string, unknown>
} {
  const calls: Call[] = []
  const service = {
    accounts: async () => [
      { label: 'personal', address: 'me@example.com', default: true, description: `${marker} stub` },
      { label: 'work', address: 'me@work.example' },
    ],
    list: async (ref?: { label: string }, options?: Record<string, unknown>) => {
      calls.push({ method: 'list', ref, options })
      return [
        {
          id: '42',
          subject: `${marker} subject`,
          from: 'Acme <no-reply@acme.test>',
          to: ['Me <me@example.com>'],
          date: '2026-09-19T09:00:00.000Z',
          unread: true,
          snippet: 'your code',
        },
      ]
    },
    get: async (ref: { label: string } | undefined, id: string, options?: Record<string, unknown>) => {
      calls.push({ method: 'get', ref, options, id })
      return {
        id,
        subject: `${marker} subject`,
        from: 'Acme <no-reply@acme.test>',
        to: ['Me <me@example.com>'],
        date: '2026-09-19T09:00:00.000Z',
        unread: false,
        text: `text body from ${marker}`,
        markdown: `markdown body from ${marker}`,
        raw: `raw body from ${marker}`,
        attachments: [{ filename: 'code.txt', contentType: 'text/plain', size: 6 }],
        format: 'text',
      }
    },
    code: async (ref: { label: string } | undefined, options?: Record<string, unknown>) => {
      calls.push({ method: 'code', ref, options })
      return {
        code: marker === 'alpha' ? '123456' : '654321',
        subject: `${marker} subject`,
        from: 'Acme <no-reply@acme.test>',
        date: '2026-09-19T09:00:00.000Z',
        messageId: '42',
      }
    },
  }
  return { calls, service }
}

function makeContext(email: Record<string, unknown>): { ctx: unknown; tools: Map<string, ToolDef> } {
  const tools = new Map<string, ToolDef>()
  const ctx = {
    email,
    workbench: {
      registerTool(def: ToolDef): () => void {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
    effect(callback: () => () => void): void {
      callback()
    },
  }
  return { ctx, tools }
}

function boot(email: Record<string, unknown>): Map<string, ToolDef> {
  const { ctx, tools } = makeContext(email)
  apply(ctx as never)
  return tools
}

const EXPECTED = ['email accounts', 'email list', 'email get', 'email code']

test('the consumer registers the four email tools with typed parameter schemas', () => {
  const tools = boot(fakeEmail('alpha').service)
  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED].sort())
  for (const tool of tools.values()) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} documents itself`)
  }
  const list = tools.get('email list')
  assert.equal(list?.parameters?.account?.type, 'string')
  assert.equal(list?.parameters?.limit?.type, 'integer')
  assert.equal(list?.parameters?.unreadOnly?.type, 'boolean')
  assert.equal(list?.parameters?.since?.type, 'string')
  assert.equal(list?.parameters?.folder?.type, 'string')
  // One required parameter, with the enum constraint: real, enforced schema.
  const get = tools.get('email get')
  assert.equal(get?.parameters?.id?.required, true)
  assert.deepEqual(get?.parameters?.format?.enum, ['text', 'markdown', 'raw'])
  assert.equal(tools.get('email accounts')?.parameters?.format?.enum?.join(','), 'labels,full')
  assert.equal(tools.get('email code')?.parameters?.maxAgeSeconds?.type, 'integer')
})

test('email accounts reports the labels and the default account (never a secret)', async () => {
  const tools = boot(fakeEmail('alpha').service)
  const labels = (await tools.get('email accounts')?.handler({})) as { count: number; default?: string; accounts: unknown[] }
  assert.deepEqual(labels, { count: 2, default: 'personal', accounts: ['personal', 'work'] })
  const full = (await tools.get('email accounts')?.handler({ format: 'full' })) as { accounts: { label: string; address?: string }[] }
  assert.equal(full.accounts[1]?.address, 'me@work.example')
})

test('an omitted account is the DEFAULT account: the consumer forwards no reference and the provider decides', async () => {
  const fake = fakeEmail('alpha')
  const tools = boot(fake.service)
  await tools.get('email list')?.handler({})
  assert.equal(fake.calls[0]?.ref, undefined, 'no reference: the configured default account answers')
  await tools.get('email list')?.handler({ account: 'work', limit: 3, unreadOnly: true, since: '2026-09-01T00:00:00Z', folder: 'INBOX' })
  assert.deepEqual(fake.calls[1]?.ref, { label: 'work' })
  assert.deepEqual(fake.calls[1]?.options, { limit: 3, folder: 'INBOX', unreadOnly: true, since: '2026-09-01T00:00:00Z' })
})

test('email list caps the page size and reports the account the caller asked for', async () => {
  const fake = fakeEmail('alpha')
  const tools = boot(fake.service)
  const result = (await tools.get('email list')?.handler({ account: 'work', limit: 500 })) as {
    account: string
    count: number
    messages: { id: string; subject: string }[]
  }
  assert.equal(fake.calls[0]?.options?.limit, 50, 'the consumer cap applies')
  assert.equal(result.account, 'work')
  assert.equal(result.count, 1)
  assert.equal(result.messages[0]?.id, '42')
})

test('email get forwards the id and the format, and returns the body plus attachment metadata', async () => {
  const fake = fakeEmail('alpha')
  const tools = boot(fake.service)
  const text = (await tools.get('email get')?.handler({ id: '42' })) as { body: string; format: string; attachments: { filename: string }[] }
  assert.deepEqual(fake.calls[0], { method: 'get', ref: undefined, options: { format: 'text' }, id: '42' })
  assert.equal(text.body, 'text body from alpha')
  assert.equal(text.attachments[0]?.filename, 'code.txt')
  const markdown = (await tools.get('email get')?.handler({ id: '42', format: 'markdown' })) as { body: string }
  assert.equal(markdown.body, 'markdown body from alpha')
  const raw = (await tools.get('email get')?.handler({ id: '42', format: 'raw' })) as { body: string }
  assert.equal(raw.body, 'raw body from alpha')
})

test('email code forwards query/pattern/maxAgeSeconds and reports the mail the code came from', async () => {
  const fake = fakeEmail('alpha')
  const tools = boot(fake.service)
  const found = (await tools.get('email code')?.handler({ account: 'work', query: 'acme', maxAgeSeconds: 600 })) as {
    code: string
    messageId: string
    subject: string
  }
  assert.deepEqual(fake.calls[0]?.options, { query: 'acme', maxAgeSeconds: 600 })
  assert.deepEqual(fake.calls[0]?.ref, { label: 'work' })
  assert.equal(found.code, '123456')
  assert.equal(found.messageId, '42')
  await tools.get('email code')?.handler({ id: '42', pattern: '([0-9]{6})' })
  assert.deepEqual(fake.calls[1]?.options, { id: '42', pattern: '([0-9]{6})' })
})

test('the consumer is provider agnostic: swapping ctx.email leaves every tool untouched and working', async () => {
  const alpha = fakeEmail('alpha')
  const beta = fakeEmail('beta')
  const toolsAlpha = boot(alpha.service)
  const toolsBeta = boot(beta.service)
  assert.deepEqual([...toolsAlpha.keys()], [...toolsBeta.keys()])
  assert.deepEqual(
    toolsAlpha.get('email get')?.parameters,
    toolsBeta.get('email get')?.parameters,
    'the tool contract does not depend on the provider',
  )
  const fromAlpha = (await toolsAlpha.get('email code')?.handler({})) as { code: string }
  const fromBeta = (await toolsBeta.get('email code')?.handler({})) as { code: string }
  assert.equal(fromAlpha.code, '123456')
  assert.equal(fromBeta.code, '654321')
})

test('the consumer holds no backend vocabulary: no provider name, no protocol, no CLI in its source', () => {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, 'index.ts'), 'utf8')
  for (const forbidden of ['himalaya', 'imap', 'smtp', 'gmail', 'pop3', 'child_process', 'execFile']) {
    assert.equal(source.toLowerCase().includes(forbidden), false, `the consumer must not name '${forbidden}'`)
  }
  assert.equal(name, 'email-tools')
})
