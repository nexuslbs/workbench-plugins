// Unit test for the TOTP CONSUMER: it must register the two operator tools on
// the injected context, validate real typed parameters, forward the entry label
// and `at` (never a backend detail) and stay identical when the provider behind
// `ctx.totp` is swapped. Nothing here imports a provider or the core.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { apply, name } from '../plugins/totp-tools/index.ts'

const PLUGIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'totp-tools')

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
  label: string
  at: number | undefined
}

/** A FAKE totp service: the same Definition surface, no RFC code at all. */
function fakeTotp(marker: string): { calls: Call[]; service: Record<string, unknown> } {
  const calls: Call[] = []
  const service = {
    entries: async () => [
      { label: 'github', issuer: `${marker} issuer`, account: 'me@example.com', digits: 6, period: 30, algorithm: 'SHA1', configured: true },
      { label: 'aws-root', digits: 8, period: 60, algorithm: 'SHA256', configured: false },
    ],
    code: (label: string, options?: { at?: number }) => {
      calls.push({ label, at: options?.at })
      if (label === 'nope') throw new Error(`totp: unknown entry 'nope' (configured: github)`)
      if (label === 'aws-root') throw new Error("totp: entry 'aws-root' is not configured: no key resolved")
      return {
        label,
        code: marker === 'alpha' ? '287082' : '654321',
        digits: 6,
        period: 30,
        algorithm: 'SHA1',
        generatedAt: options?.at ?? 1_789_000_000,
        remainingSeconds: 1,
      }
    },
  }
  return { calls, service }
}

function makeContext(totp: Record<string, unknown>): { ctx: unknown; tools: Map<string, ToolDef> } {
  const tools = new Map<string, ToolDef>()
  const ctx = {
    totp,
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

function boot(totp: Record<string, unknown>, config?: Record<string, unknown>): Map<string, ToolDef> {
  const { ctx, tools } = makeContext(totp)
  apply(ctx as never, config as never)
  return tools
}

const EXPECTED = ['totp code', 'totp list']

test('the consumer registers the two totp tools with typed parameter schemas', () => {
  const tools = boot(fakeTotp('alpha').service)
  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED].sort())
  for (const tool of tools.values()) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} documents itself`)
  }
  // `totp list` takes NO parameter (the task's "no params" case).
  assert.deepEqual(tools.get('totp list')?.parameters, {})
  // `totp code` has one REQUIRED string and one optional integer.
  const code = tools.get('totp code')
  assert.equal(code?.parameters?.label?.type, 'string')
  assert.equal(code?.parameters?.label?.required, true)
  assert.equal(code?.parameters?.at?.type, 'integer')
})

test('totp list reports the labels and the entry metadata, never a secret', async () => {
  const tools = boot(fakeTotp('alpha').service)
  const result = (await tools.get('totp list')?.handler({})) as { count: number; entries: Record<string, unknown>[] }
  assert.equal(result.count, 2)
  assert.deepEqual(
    result.entries.map((entry) => entry.label),
    ['github', 'aws-root'],
  )
  assert.equal(result.entries[0]?.issuer, 'alpha issuer')
  assert.equal(result.entries[0]?.digits, 6)
  assert.equal(result.entries[1]?.configured, false)
  const payload = JSON.stringify(result)
  assert.equal(/secret|key|password/i.test(payload), false, `no key vocabulary in the answer: ${payload}`)
})

test('totp code forwards the label and `at`, and returns the capability code object', async () => {
  const fake = fakeTotp('alpha')
  const tools = boot(fake.service)
  const generated = (await tools.get('totp code')?.handler({ label: 'github', at: 59 })) as Record<string, unknown>
  assert.deepEqual(fake.calls[0], { label: 'github', at: 59 })
  assert.equal(generated.code, '287082')
  assert.equal(generated.digits, 6)
  assert.equal(generated.period, 30)
  assert.equal(generated.algorithm, 'SHA1')
  assert.equal(generated.generatedAt, 59)
  assert.equal(generated.remainingSeconds, 1)
  assert.equal(generated.issuer, 'alpha issuer')
  assert.equal(generated.account, 'me@example.com')
})

test('an omitted `at` is forwarded as NO option: the capability uses its own clock', async () => {
  const fake = fakeTotp('alpha')
  const tools = boot(fake.service)
  await tools.get('totp code')?.handler({ label: 'github' })
  assert.deepEqual(fake.calls[0], { label: 'github', at: undefined })
})

test('a missing or blank label is refused by the handler with a readable message', async () => {
  const fake = fakeTotp('alpha')
  const tools = boot(fake.service)
  await assert.rejects(async () => await tools.get('totp code')?.handler({}), /the 'label' parameter must be a non-empty entry label/)
  await assert.rejects(async () => await tools.get('totp code')?.handler({ label: '   ' }), /the 'label' parameter must be a non-empty entry label/)
  assert.deepEqual(fake.calls, [], 'the capability is never reached without a label')
})

test('an unknown label and a not-configured entry surface the capability error unchanged', async () => {
  const tools = boot(fakeTotp('alpha').service)
  await assert.rejects(async () => await tools.get('totp code')?.handler({ label: 'nope' }), /totp: unknown entry 'nope' \(configured: github\)/)
  await assert.rejects(async () => await tools.get('totp code')?.handler({ label: 'aws-root' }), /totp: entry 'aws-root' is not configured/)
})

test('reportEntryMetadata:false drops issuer/account from a code answer (totp list keeps them)', async () => {
  const tools = boot(fakeTotp('alpha').service, { reportEntryMetadata: false })
  const generated = (await tools.get('totp code')?.handler({ label: 'github' })) as Record<string, unknown>
  assert.equal('issuer' in generated, false)
  assert.equal('account' in generated, false)
  const listed = (await tools.get('totp list')?.handler({})) as { entries: Record<string, unknown>[] }
  assert.equal(listed.entries[0]?.issuer, 'alpha issuer')
})

test('the consumer is provider agnostic: swapping ctx.totp leaves every tool untouched and working', async () => {
  const alpha = fakeTotp('alpha')
  const beta = fakeTotp('beta')
  const toolsAlpha = boot(alpha.service)
  const toolsBeta = boot(beta.service)
  assert.deepEqual([...toolsAlpha.keys()], [...toolsBeta.keys()])
  assert.deepEqual(toolsAlpha.get('totp code')?.parameters, toolsBeta.get('totp code')?.parameters, 'the tool contract does not depend on the provider')
  assert.deepEqual(toolsAlpha.get('totp list')?.parameters, toolsBeta.get('totp list')?.parameters)
  const fromAlpha = (await toolsAlpha.get('totp code')?.handler({ label: 'github' })) as { code: string }
  const fromBeta = (await toolsBeta.get('totp code')?.handler({ label: 'github' })) as { code: string }
  assert.equal(fromAlpha.code, '287082')
  assert.equal(fromBeta.code, '654321')
})

test('the consumer holds no key-handling vocabulary in its CODE (comments may name the provider it is agnostic to)', () => {
  const source = fs.readFileSync(path.join(PLUGIN_DIR, 'index.ts'), 'utf8')
  // Strip comments: the header/table documents the provider role on purpose;
  // the executable code must name no key handling and no provider.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  for (const forbidden of ['hmac', 'base32', 'rfc6238', 'createhmac', 'child_process', 'node:crypto', 'totp-rfc6238']) {
    assert.equal(code.toLowerCase().includes(forbidden), false, `the consumer code must not name '${forbidden}'`)
  }
  assert.equal(name, 'totp-tools')
})
