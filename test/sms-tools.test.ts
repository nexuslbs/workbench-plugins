// Unit test for the SMS CONSUMER: it must register the four operator tools on
// the injected context, validate real typed parameters, forward the number LABEL
// and the options (never a backend detail) and stay identical when the provider
// behind `ctx.sms` is swapped. Nothing here imports a provider or the core.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, name } from '../plugins/sms-tools/index.ts'

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'sms-tools')

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
  label: string | undefined
  options: Record<string, unknown> | undefined
  id?: string
}

interface FakeSms {
  calls: Call[]
  service: Record<string, unknown>
}

/** A FAKE sms capability: the same Definition surface, no backend at all. */
function fakeSms(marker: string): FakeSms {
  const calls: Call[] = []
  const reason = {
    personal: '+15551234567',
    work: '+15557654321',
  } as Record<string, string>
  const service = {
    numbers: async () => [
      { label: 'personal', number: reason.personal, default: true, configured: true, description: `${marker} personal` },
      { label: 'work', number: reason.work, default: undefined, configured: false },
    ],
    list: async (ref: { label: string } | undefined, options?: Record<string, unknown>) => {
      calls.push({ method: 'list', label: ref?.label, options })
      if (ref?.label === 'nope') throw new Error("sms: unknown number 'nope' (configured: personal, work)")
      return [
        {
          id: `${marker}-SM1`,
          from: '+15550001111',
          to: reason[ref?.label ?? 'personal'] ?? reason.personal,
          date: '2026-09-19T10:00:00.000Z',
          body: `Your verification code is ${marker === 'alpha' ? '483920' : '111111'}.`,
          status: 'received',
          unread: true,
        },
      ]
    },
    get: async (ref: { label: string } | undefined, id: string) => {
      calls.push({ method: 'get', label: ref?.label, options: undefined, id })
      if (id === 'missing') throw new Error(`sms: message 'missing' was not found on number '${ref?.label ?? '(default)'}' (the backend answered HTTP 404)`)
      return {
        id,
        from: '+15550001111',
        to: reason[ref?.label ?? 'personal'] ?? reason.personal,
        date: '2026-09-19T10:00:00.000Z',
        body: `Your verification code is ${marker === 'alpha' ? '483920' : '111111'}.`,
        status: 'received',
        unread: true,
        segments: 1,
        direction: 'inbound',
      }
    },
    code: async (ref: { label: string } | undefined, options?: Record<string, unknown>) => {
      calls.push({ method: 'code', label: ref?.label, options })
      if (options?.id === 'missing') throw new Error("sms: no code found in 1 message(s) of (default)")
      return {
        code: marker === 'alpha' ? '483920' : '111111',
        body: 'Your verification code is 483920. Do not share it.',
        from: '+15550001111',
        date: '2026-09-19T10:00:00.000Z',
        messageId: `${marker}-SM1`,
      }
    },
  }
  return { calls, service }
}

function makeContext(sms: Record<string, unknown>): { ctx: unknown; tools: Map<string, ToolDef> } {
  const tools = new Map<string, ToolDef>()
  const ctx = {
    sms,
    tools: {
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

function boot(sms: Record<string, unknown>, config?: Record<string, unknown>): Map<string, ToolDef> {
  const { ctx, tools } = makeContext(sms)
  apply(ctx as never, config as never)
  return tools
}

const EXPECTED = ['sms numbers', 'sms list', 'sms get', 'sms code']

test('the consumer registers the four sms tools with typed parameter schemas', () => {
  const tools = boot(fakeSms('alpha').service)
  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED].sort())
  for (const tool of tools.values()) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} documents itself`)
    assert.ok(tool.parameters && Object.keys(tool.parameters).length > 0, `${tool.name} declares typed parameters`)
  }
  // `sms numbers` needs no input; its only parameter is optional and enumerated.
  assert.deepEqual(Object.keys(tools.get('sms numbers')?.parameters ?? {}), ['format'])
  assert.equal(tools.get('sms numbers')?.parameters?.format?.required, undefined)
  assert.deepEqual(tools.get('sms numbers')?.parameters?.format?.enum, ['labels', 'full'])
  // `sms list`: every parameter optional, typed.
  const list = tools.get('sms list')?.parameters ?? {}
  assert.deepEqual(Object.keys(list).sort(), ['from', 'limit', 'number', 'since', 'unreadOnly'])
  assert.equal(list.number?.type, 'string')
  assert.equal(list.limit?.type, 'integer')
  assert.equal(list.unreadOnly?.type, 'boolean')
  assert.equal(list.since?.type, 'string')
  assert.equal(list.from?.type, 'string')
  // `sms get`: the ONE required parameter of the tool set.
  const get = tools.get('sms get')?.parameters ?? {}
  assert.equal(get.id?.type, 'string')
  assert.equal(get.id?.required, true)
  assert.equal(get.number?.required, undefined)
  // `sms code`: the operator's headline tool.
  const code = tools.get('sms code')?.parameters ?? {}
  assert.deepEqual(Object.keys(code).sort(), ['id', 'maxAgeSeconds', 'number', 'occurrences', 'pattern', 'query'])
  assert.equal(code.maxAgeSeconds?.type, 'integer')
  assert.equal(code.occurrences?.type, 'integer')
})

test('sms numbers reports the labels, the default and the metadata, never a secret', async () => {
  const tools = boot(fakeSms('alpha').service)
  const labels = (await tools.get('sms numbers')?.handler({})) as { count: number; default?: string; numbers: unknown[] }
  assert.equal(labels.count, 2)
  assert.equal(labels.default, 'personal')
  assert.deepEqual(labels.numbers, ['personal', 'work'])
  const full = (await tools.get('sms numbers')?.handler({ format: 'full' })) as { numbers: Record<string, unknown>[] }
  assert.equal(full.numbers[0]?.description, 'alpha personal')
  assert.equal(full.numbers[1]?.configured, false)
  const payload = JSON.stringify(full)
  assert.equal(/secret|token|password/i.test(payload), false, `no credential vocabulary in the answer: ${payload}`)
})

test('sms list forwards the label and the bounded options, and defaults the limit', async () => {
  const fake = fakeSms('alpha')
  const tools = boot(fake.service)
  const first = (await tools.get('sms list')?.handler({})) as { number: string; count: number }
  assert.equal(first.number, '(default)')
  assert.deepEqual(fake.calls[0], { method: 'list', label: undefined, options: { limit: 10 } })
  const named = (await tools.get('sms list')?.handler({
    number: ' work ',
    limit: 3,
    since: '2026-09-01T00:00:00.000Z',
    from: 'BankAlert',
    unreadOnly: true,
  })) as { number: string; count: number }
  assert.equal(named.number, 'work')
  assert.deepEqual(fake.calls[1], {
    method: 'list',
    label: 'work',
    options: { limit: 3, since: '2026-09-01T00:00:00.000Z', from: 'BankAlert', unreadOnly: true },
  })
  // The client can never exceed the configured cap (and never the contract's 100).
  await tools.get('sms list')?.handler({ limit: 5000 })
  assert.deepEqual((fake.calls[2]?.options as { limit: number }).limit, 50)
  const tiny = boot(fakeSms('alpha').service, { defaultListLimit: 4, maxListLimit: 6 })
  await tiny.get('sms list')?.handler({ limit: 99 })
  const bounded = (await tiny.get('sms list')?.handler({})) as { count: number }
  assert.equal(bounded.count, 1)
})

test('sms list can drop the bodies when the operator asks for metadata only', async () => {
  const tools = boot(fakeSms('alpha').service, { includeBodies: false })
  const listed = (await tools.get('sms list')?.handler({})) as { messages: Record<string, unknown>[] }
  assert.equal('body' in (listed.messages[0] ?? {}), true)
  assert.equal(listed.messages[0]?.body, undefined)
  assert.equal(listed.messages[0]?.id, 'alpha-SM1', 'the metadata survives')
})

test('sms get requires an id and returns the full message of the referenced number', async () => {
  const fake = fakeSms('alpha')
  const tools = boot(fake.service)
  await assert.rejects(async () => await tools.get('sms get')?.handler({}), /the 'id' parameter must be a non-empty string/)
  await assert.rejects(async () => await tools.get('sms get')?.handler({ id: '   ' }), /the 'id' parameter must be a non-empty string/)
  assert.deepEqual(fake.calls, [], 'the capability is never reached without an id')
  const message = (await tools.get('sms get')?.handler({ id: 'SM1', number: 'work' })) as Record<string, unknown>
  assert.deepEqual(fake.calls[0], { method: 'get', label: 'work', options: undefined, id: 'SM1' })
  assert.equal(message.number, 'work')
  assert.equal(message.segments, 1)
  assert.equal(message.direction, 'inbound')
})

test('sms code forwards only the options the caller gave, and reports the message it came from', async () => {
  const fake = fakeSms('alpha')
  const tools = boot(fake.service)
  const plain = (await tools.get('sms code')?.handler({})) as Record<string, unknown>
  assert.deepEqual(fake.calls[0], { method: 'code', label: undefined, options: {} })
  assert.equal(plain.code, '483920')
  assert.equal(plain.messageId, 'alpha-SM1')
  assert.equal(plain.from, '+15550001111')
  const targeted = (await tools.get('sms code')?.handler({
    number: 'personal',
    id: 'SM1',
    query: 'Verify',
    pattern: '(\\d{6})',
    occurrences: 2,
    maxAgeSeconds: 300,
  })) as Record<string, unknown>
  assert.deepEqual(fake.calls[1], {
    method: 'code',
    label: 'personal',
    options: { id: 'SM1', query: 'Verify', pattern: '(\\d{6})', occurrences: 2, maxAgeSeconds: 300 },
  })
  assert.equal(targeted.number, 'personal')
})

test('a capability error surfaces unchanged (unknown number, missing message)', async () => {
  const tools = boot(fakeSms('alpha').service)
  await assert.rejects(async () => await tools.get('sms list')?.handler({ number: 'nope' }), /sms: unknown number 'nope' \(configured: personal, work\)/)
  await assert.rejects(async () => await tools.get('sms get')?.handler({ id: 'missing' }), /sms: message 'missing' was not found/)
  await assert.rejects(async () => await tools.get('sms code')?.handler({ id: 'missing' }), /no code found in 1 message\(s\)/)
})

test('the consumer is provider agnostic: swapping ctx.sms leaves every tool untouched and working', async () => {
  const alpha = fakeSms('alpha')
  const beta = fakeSms('beta')
  const toolsAlpha = boot(alpha.service)
  const toolsBeta = boot(beta.service)
  assert.deepEqual([...toolsAlpha.keys()], [...toolsBeta.keys()])
  assert.deepEqual(toolsAlpha.get('sms list')?.parameters, toolsBeta.get('sms list')?.parameters, 'the tool contract does not depend on the provider')
  assert.deepEqual(toolsAlpha.get('sms get')?.parameters, toolsBeta.get('sms get')?.parameters)
  assert.deepEqual(toolsAlpha.get('sms code')?.parameters, toolsBeta.get('sms code')?.parameters)
  const fromAlpha = (await toolsAlpha.get('sms code')?.handler({})) as { code: string }
  const fromBeta = (await toolsBeta.get('sms code')?.handler({})) as { code: string }
  assert.equal(fromAlpha.code, '483920')
  assert.equal(fromBeta.code, '111111')
})

test('the consumer holds no backend vocabulary in its CODE (comments may name the role it is agnostic to)', () => {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, 'index.ts'), 'utf8')
  // Strip comments: the header documents the seam on purpose; the executable
  // code must name no backend, no transport and no provider plugin.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const forbidden of ['twilio', 'fetch(', 'node:http', 'sms-twilio', 'accountsid', 'authtoken', 'basic ']) {
    assert.equal(code.toLowerCase().includes(forbidden), false, `the consumer code must not name '${forbidden}'`)
  }
  assert.equal(name, 'sms-tools')
})
