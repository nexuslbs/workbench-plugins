// Unit tests for the per-domain RECIPE STORE (plugins/web-recipe): the schema
// and its MERGE, the versioned + atomic storage, the service the read-through
// consumer looks up, the discovery gate and the verification decay.
// No network at all: `fetchImpl` is faked and every store lives in a temp dir.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, failure } from '../plugins/web-recipe/index.ts'
import type { WebRecipeService } from '../plugins/web-recipe/index.ts'
import { apply as applyPage } from '../plugins/web-page/index.ts'
import { buildRecipe, recipeUsable, validatePatch } from '../plugins/web-recipe/schema.ts'
import { RecipeError, RecipeStore, recipeFileName } from '../plugins/web-recipe/store.ts'

type Ctx = Parameters<typeof apply>[0]
type Handler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>

interface ToolDef {
  name: string
  parameters?: Record<string, unknown>
  handler: Handler
}

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A fake cordis context: it records the tools, the provided service and the effects. */
function fakeCtx(): { ctx: Ctx; tools: Map<string, ToolDef>; services: Map<string, unknown> } {
  const tools = new Map<string, ToolDef>()
  const services = new Map<string, unknown>()
  const ctx = {
    workbench: {
      registerTool: (def: ToolDef) => {
        tools.set(def.name, def)
        return () => {
          tools.delete(def.name)
        }
      },
    },
    provide: (serviceName: string, value: unknown) => {
      services.set(serviceName, value)
    },
    effect: (callback: () => () => void) => {
      callback()
    },
  } as unknown as Ctx
  return { ctx, tools, services }
}

function serviceOf(services: Map<string, unknown>): WebRecipeService {
  const service = services.get('web-recipe') as WebRecipeService | undefined
  assert.ok(service, 'the plugin must provide the web-recipe service')
  return service
}

const failingFetch = (async () => {
  throw new Error('ECONNREFUSED 127.0.0.1:1')
}) as unknown as typeof fetch

const okFetch = (async () =>
  new Response(JSON.stringify({ data: { items: [{ id: 7 }] } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch

test('schema: a partial patch MERGES into the stored recipe and moves provenance only', () => {
  const first = buildRecipe('example.com', { readPath: { kind: 'render', url: 'https://example.com/' }, quirks: 'consent wall' }, undefined, {
    now: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(first.provenance.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(first.schemaVersion, 1)
  const merged = buildRecipe(
    'example.com',
    { selectors: [{ name: 'main', form: 'css', selector: 'main' }] },
    first,
    { now: '2026-02-02T00:00:00.000Z' },
  )
  assert.equal(merged.provenance.createdAt, '2026-01-01T00:00:00.000Z', 'createdAt survives a merge')
  assert.equal(merged.provenance.updatedAt, '2026-02-02T00:00:00.000Z')
  assert.equal(merged.quirks, 'consent wall', 'an untouched field survives')
  assert.deepEqual(merged.readPath, first.readPath, 'a read path survives a selector-only patch')
  assert.equal(merged.selectors?.length, 1)
})

test('schema: an unknown readPath kind and a credential VALUE are refused with violations', () => {
  const badKind = validatePatch({ readPath: { kind: 'watch', url: 'https://example.com/' } })
  assert.equal(badKind.ok, false)
  if (!badKind.ok) assert.ok(badKind.violations.some((violation) => violation.includes('readPath.kind')), badKind.violations.join('; '))

  const secret = validatePatch({
    loginFlow: { url: 'https://example.com/login', fields: [{ name: 'password', form: 'css', selector: '#pw', credential: 'hunter2' }] },
  })
  assert.equal(secret.ok, false, 'a credential VALUE must never be stored')
  if (!secret.ok) assert.ok(secret.violations.some((violation) => violation.includes('credential')), secret.violations.join('; '))

  const good = validatePatch({
    loginFlow: { url: 'https://example.com/login', fields: [{ name: 'password', form: 'css', selector: '#pw', credential: 'EXAMPLE_PASSWORD' }] },
  })
  assert.equal(good.ok, true, 'a credential NAME is exactly what a recipe carries')
})

test('store: save/read round-trip is byte-stable, atomic (no temp file left) and 0600', async () => {
  const dir = tmpDir('web-recipe-store-')
  const store = new RecipeStore(dir)
  const saved = await store.save('github.com', {
    readPath: { kind: 'api', url: 'https://api.github.com/repos/{owner}/{repo}', api: 'repo' },
    apis: [{ name: 'repo', url: 'https://api.github.com/repos/{owner}/{repo}', jsonPath: 'stargazers_count' }],
  })
  const file = path.join(dir, recipeFileName('github.com'))
  assert.equal(saved.file, file)
  assert.equal(saved.created, true)
  const written = fs.readFileSync(file, 'utf8')
  assert.equal(written.endsWith('\n'), true)
  assert.equal((JSON.parse(written) as { schemaVersion: number }).schemaVersion, 1)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(
    await store.read('https://github.com/nexuslbs/workbench'),
    saved.recipe,
    'a URL normalizes to the same domain key and reads the same document back',
  )
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [], 'the temp file is renamed away, never left behind')
  assert.equal(fs.readdirSync(dir).length, 1)
})

test('store: a newer schemaVersion is refused and NEVER reinterpreted', async () => {
  const dir = tmpDir('web-recipe-version-')
  fs.writeFileSync(
    path.join(dir, 'example.com.json'),
    JSON.stringify({ domain: 'example.com', schemaVersion: 2, provenance: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', confidence: 0.5 } }),
  )
  await assert.rejects(
    () => new RecipeStore(dir).read('example.com'),
    (error: unknown) => error instanceof RecipeError && error.code === 'schema_version_unknown',
  )
})

test('store: a corrupt file and an invalid domain are reported, never thrown as a crash', async () => {
  const dir = tmpDir('web-recipe-corrupt-')
  fs.writeFileSync(path.join(dir, 'bad.example.json'), '{ not json')
  await assert.rejects(
    () => new RecipeStore(dir).read('bad.example'),
    (error: unknown) => error instanceof RecipeError && error.code === 'recipe_corrupt',
  )
  assert.equal(await new RecipeStore(dir).read('no-such.example'), undefined, 'a missing file is a not-found, not an error')
  assert.equal(failure(new RecipeError('not_found', 'nope')).status, 'not_found')
  assert.equal(failure(new Error('boom')).status, 'error', 'a plain error still answers structurally')
})

test('tools: recipe save/get/list/delete over the registered surface', async () => {
  const dir = tmpDir('web-recipe-tools-')
  const { ctx, tools, services } = fakeCtx()
  apply(ctx, { dir })
  assert.deepEqual([...tools.keys()].sort(), ['recipe delete', 'recipe get', 'recipe list', 'recipe save', 'recipe verify'])
  assert.ok(serviceOf(services).contract === 'web-recipe@1')

  const save = tools.get('recipe save')!.handler
  const get = tools.get('recipe get')!.handler
  const list = tools.get('recipe list')!.handler
  const remove = tools.get('recipe delete')!.handler

  const saved = await save({ domain: 'github.com', readPath: { kind: 'render', url: 'https://github.com/{owner}/{repo}', selectors: ['main'] }, quirks: 'JS repo page' })
  assert.equal(saved.status, 'ok')
  assert.equal(saved.created, true)
  const read = await get({ domain: 'github.com' })
  assert.equal(read.status, 'ok')
  assert.equal((read.recipe as { quirks?: string }).quirks, 'JS repo page')

  const again = await save({ domain: 'github.com', quirks: 'updated note' })
  assert.equal(again.created, false)
  const merged = (await get({ domain: 'github.com' })).recipe as { quirks?: string; readPath?: unknown }
  assert.equal(merged.quirks, 'updated note')
  assert.ok(merged.readPath, 'a fields-only save keeps the read path')

  const inventory = await list({})
  assert.equal(inventory.count, 1)
  assert.equal((inventory.recipes as Array<{ domain: string }>)[0]?.domain, 'github.com')

  const parked = await remove({ domain: 'github.com' })
  assert.equal(parked.status, 'ok')
  assert.equal((await get({ domain: 'github.com' })).recipe !== undefined, true, 'a parked recipe keeps its file')
  assert.equal(((await get({ domain: 'github.com' })).recipe as { disabled?: boolean }).disabled, true)

  assert.equal((await get({})).status, 'invalid', 'a missing domain is a structured violation, not a crash')
  assert.ok(((await get({})).violations as string[]).length > 0)
  assert.equal((await get({ domain: 'nope.example' })).status, 'not_found')
  assert.equal((await get({ domain: 'github.com' })).status, 'ok', 'the server keeps serving after the errors')
})

test('service: lookup gates on existence, policy and the disabled marker; a discovery never overwrites', async () => {
  const dir = tmpDir('web-recipe-service-')
  const { ctx, tools, services } = fakeCtx()
  apply(ctx, { dir })
  const service = serviceOf(services)

  assert.equal(await service.lookup('https://unknown.example/page'), undefined)
  const recorded = await service.record({
    url: 'https://example.com/page',
    readPath: { kind: 'render', url: 'https://example.com/page', selectors: ['main'] },
    discoveredBy: 'test',
  })
  assert.equal(recorded.status, 'recorded')
  assert.equal(recorded.recipe?.provenance.confidence, 0.3, 'a recorded recipe starts at the low, unverified confidence')

  const looked = await service.lookup('https://example.com/other')
  assert.equal(looked?.usable, true)
  assert.equal(looked?.domain, 'example.com')
  assert.equal(looked?.recipe.readPath?.selectors?.[0], 'main')

  const second = await service.record({ url: 'https://example.com/other', readPath: { kind: 'api', url: 'https://api.example.com/x' } })
  assert.equal(second.status, 'skipped', 'a discovery never overwrites curated knowledge')
  assert.equal((await service.get('example.com'))?.readPath?.kind, 'render')

  await tools.get('recipe delete')!.handler({ domain: 'example.com' })
  const parked = await service.lookup('https://example.com/other')
  assert.equal(parked?.usable, false)
  assert.equal(parked?.reason, 'disabled')
})

test('service: a policy above the recorded confidence makes the recipe unusable (stale knowledge is ignored)', async () => {
  const dir = tmpDir('web-recipe-policy-')
  const { ctx, services } = fakeCtx()
  apply(ctx, { dir, minConfidence: 0.9 })
  const service = serviceOf(services)
  await service.record({ url: 'https://strict.example/page', readPath: { kind: 'render', url: 'https://strict.example/page' } })
  const looked = await service.lookup('https://strict.example/page')
  assert.equal(looked?.usable, false)
  assert.match(String(looked?.reason), /below the minimum/)
  assert.equal(recipeUsable((await service.get('strict.example'))!, { minConfidence: 0.9, maxAgeDays: 0 }).usable, false)
})

test('verify: a probe probes the API, a failure demotes and the recipe stops being used', async () => {
  const dir = tmpDir('web-recipe-verify-')
  const { ctx, services } = fakeCtx()
  apply(ctx, { dir, demoteStep: 0.2 }, { fetchImpl: okFetch })
  const service = serviceOf(services)
  await service.record({ url: 'https://api.example.com/page', readPath: { kind: 'api', url: 'https://api.example.com/items', api: 'items' }, apis: [{ name: 'items', url: 'https://api.example.com/items', jsonPath: 'data.items' }], confidence: 0.3 })

  const good = await service.verify('api.example.com')
  assert.equal(good.outcome.status, 'ok')
  assert.equal(good.recipe?.provenance.lastVerifiedAt !== undefined, true)
  assert.ok((good.recipe?.provenance.confidence ?? 0) > 0.3, 'a good verification raises confidence')

  const broken = new RecipeStore(dir)
  const brokenRecipe = await broken.read('api.example.com')
  await broken.write({ ...brokenRecipe!, apis: [{ name: 'items', url: 'https://api.example.com/gone' }], readPath: { kind: 'api', url: 'https://api.example.com/gone', api: 'items' } })
  const before = brokenRecipe!.provenance.confidence
  const { ctx: ctx2, services: services2 } = fakeCtx()
  apply(ctx2, { dir, demoteStep: 0.2 }, { fetchImpl: failingFetch })
  const failed = await serviceOf(services2).verify('api.example.com')
  assert.equal(failed.outcome.status, 'failed')
  assert.match(String(failed.outcome.detail), /could not be reached/)
  const after = await serviceOf(services2).get('api.example.com')
  assert.equal(after?.provenance.lastVerificationStatus, 'failed')
  assert.equal(after?.provenance.verificationFailures, 1)
  assert.ok((after?.provenance.confidence ?? 1) < before, 'a failure demotes confidence')
  assert.equal((await serviceOf(services2).lookup('https://api.example.com/page'))?.usable, true, 'still above the default floor')
  assert.equal((await serviceOf(services2).lookup('https://api.example.com/page'))?.recipe.provenance.lastVerificationStatus, 'failed')
})

test('service: no secret VALUE can reach a stored recipe (the schema refuses it)', async () => {
  const dir = tmpDir('web-recipe-secret-')
  const { ctx, tools } = fakeCtx()
  apply(ctx, { dir })
  const refused = await tools.get('recipe save')!.handler({
    domain: 'example.com',
    loginFlow: { url: 'https://example.com/login', fields: [{ name: 'password', form: 'css', selector: '#pw', credential: 'hunter2' }] },
  })
  assert.equal(refused.status, 'invalid')
  assert.equal(fs.existsSync(path.join(dir, 'example.com.json')), false, 'nothing was written')
  assert.equal(JSON.stringify(refused).includes('hunter2'), false, 'the refusal does not echo the value back either')
})

test('web-page read-through: a broken recipe is reported and demoted, and the render path still answers (fallback)', async () => {
  const dir = tmpDir('web-recipe-fallback-')
  const recipeCtx = fakeCtx()
  apply(recipeCtx.ctx, { dir, demoteStep: 0.2 })
  const service = serviceOf(recipeCtx.services)
  await service.record({
    url: 'https://broken.example/page',
    readPath: { kind: 'api', url: 'https://broken.example/api/items', api: 'items' },
    apis: [{ name: 'items', url: 'https://broken.example/api/items', jsonPath: 'items' }],
    confidence: 0.8,
  })

  const pageTools = new Map<string, ToolDef>()
  const renders: string[] = []
  const renderer = {
    render: async (request: { url: string }) => {
      renders.push(request.url)
      return {
        html: '<html><head><title>Rendered fallback</title></head><body><main><h1>Rendered heading</h1><p>The rendered body text of the fallback read.</p></main></body></html>',
        finalUrl: request.url,
        status: 200,
        attempts: 1,
        elapsedMs: 3,
      }
    },
    dispose: async () => undefined,
  }
  const cacheDir = tmpDir('web-page-fallback-cache-')
  applyPage(
    {
      workbench: {
        registerTool: (def: ToolDef) => {
          pageTools.set(def.name, def)
          return () => undefined
        },
      },
      effect: (callback: () => () => void) => {
        callback()
      },
      // cordis DEFERRED injection: only the injected scope exposes the service
      // (a real cordis root context refuses the property: 'without inject').
      inject: (_deps: string[], callback: (injected: unknown) => void) => {
        callback({ 'web-recipe': service })
      },
    } as never,
    { cacheDir, spillDir: path.join(cacheDir, 'spill'), recipes: { enabled: true, record: false } },
    { renderer: renderer as never, fetchImpl: failingFetch },
  )

  const read = await pageTools.get('page read')!.handler({ url: 'https://broken.example/page', max_chars: 4000 })
  assert.match(String(read.markdown), /rendered body text of the fallback read/, 'the render path still answers')
  assert.equal(renders.length, 1, 'the browser path ran exactly once')
  const note = read.recipe as { domain: string; via: string; status: string; fallback: string; detail: string }
  assert.equal(note.domain, 'broken.example')
  assert.equal(note.via, 'api')
  assert.equal(note.status, 'failed', 'the broken recipe is reported, not hidden')
  assert.equal(note.fallback, 'render')
  assert.match(note.detail, /did not answer/)
  assert.equal((read.discovered as unknown), undefined, 'a failed recipe read is not a discovery')

  const after = await service.get('broken.example')
  assert.equal(after?.provenance.lastVerificationStatus, 'failed', 'the read-through told the store')
  assert.equal(after?.provenance.verificationFailures, 1)
  assert.ok((after?.provenance.confidence ?? 1) < 0.8, 'the store demoted the stale recipe')
})

test('web-page read-through: an API recipe answers in ONE call with no browser at all', async () => {
  const dir = tmpDir('web-recipe-payoff-')
  const recipeCtx = fakeCtx()
  apply(recipeCtx.ctx, { dir })
  const service = serviceOf(recipeCtx.services)
  await service.record({
    url: 'https://api.example.com/page',
    readPath: { kind: 'api', url: 'https://api.example.com/items', api: 'items', jsonPath: 'data.items' },
    apis: [{ name: 'items', url: 'https://api.example.com/items', jsonPath: 'data.items' }],
    confidence: 0.9,
  })

  const pageTools = new Map<string, ToolDef>()
  const renders: string[] = []
  const renderer = {
    render: async (request: { url: string }) => {
      renders.push(request.url)
      throw new Error('the browser must never be launched for an API recipe')
    },
    dispose: async () => undefined,
  }
  const cacheDir = tmpDir('web-page-payoff-cache-')
  applyPage(
    {
      workbench: {
        registerTool: (def: ToolDef) => {
          pageTools.set(def.name, def)
          return () => undefined
        },
      },
      effect: (callback: () => () => void) => {
        callback()
      },
      // cordis DEFERRED injection: only the injected scope exposes the service
      // (a real cordis root context refuses the property: 'without inject').
      inject: (_deps: string[], callback: (injected: unknown) => void) => {
        callback({ 'web-recipe': service })
      },
    } as never,
    { cacheDir, spillDir: path.join(cacheDir, 'spill'), recipes: { enabled: true, record: false } },
    { renderer: renderer as never, fetchImpl: okFetch },
  )

  const read = await pageTools.get('page read')!.handler({ url: 'https://api.example.com/page', max_chars: 4000 })
  assert.equal(read.status, 'recipe', 'the answer names the recipe path')
  assert.equal(renders.length, 0, 'no browser render at all')
  assert.match(String(read.markdown), /"id":7/, 'the API payload was returned')
  assert.deepEqual(read.data, [{ id: 7 }], 'the recipe jsonPath slice is the answer')
  assert.equal((read.recipe as { verified: boolean }).verified, true)
  const raised = await service.get('api.example.com')
  assert.ok((raised?.provenance.confidence ?? 0) > 0.9, 'a good read-through raises confidence')
})

test('web-page read-through: an UNRESOLVABLE credential does not block the API read', async () => {
  // A recipe names a credential this deployment does not have. The read must
  // still go out (a public endpoint answers), report the NAME, and leak nothing.
  const dir = tmpDir('web-recipe-cred-')
  const recipeCtx = fakeCtx()
  apply(recipeCtx.ctx, { dir })
  const service = serviceOf(recipeCtx.services)
  await service.record({
    url: 'https://creds.example/page',
    readPath: { kind: 'api', url: 'https://creds.example/api/items', api: 'items' },
    apis: [{ name: 'items', url: 'https://creds.example/api/items', credential: 'MISSING_TOKEN' }],
    confidence: 0.9,
  })

  const headersSeen: Array<Record<string, string>> = []
  const credFetch = (async (_url: string, init: RequestInit) => {
    headersSeen.push((init.headers ?? {}) as Record<string, string>)
    return new Response(JSON.stringify({ items: [{ id: 7 }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const pageTools = new Map<string, ToolDef>()
  const renders: string[] = []
  const renderer = {
    render: async (request: { url: string }) => {
      renders.push(request.url)
      throw new Error('the browser must never be launched for an API recipe')
    },
    dispose: async () => undefined,
  }
  const cacheDir = tmpDir('web-page-cred-cache-')
  applyPage(
    {
      workbench: {
        registerTool: (def: ToolDef) => {
          pageTools.set(def.name, def)
          return () => undefined
        },
      },
      effect: (callback: () => () => void) => {
        callback()
      },
      inject: (_deps: string[], callback: (injected: unknown) => void) => {
        callback({ 'web-recipe': service })
      },
    } as never,
    { cacheDir, spillDir: path.join(cacheDir, 'spill'), recipes: { enabled: true, record: false } },
    { renderer: renderer as never, fetchImpl: credFetch },
  )

  const read = await pageTools.get('page read')!.handler({ url: 'https://creds.example/page', max_chars: 4000 })
  assert.equal(read.status, 'recipe', 'the recipe path still answers')
  assert.equal(read.via, 'api')
  assert.equal(renders.length, 0, 'no browser ran')
  const note = read.recipe as { credentialMissing?: string; verified?: boolean }
  assert.equal(note.credentialMissing, 'MISSING_TOKEN', 'the missing credential NAME is reported')
  assert.equal(note.verified, true)
  assert.equal(JSON.stringify(read).includes('MISSING_TOKEN'), true, 'only the NAME appears, never a value')
  assert.equal(headersSeen.length, 1)
  assert.equal('authorization' in headersSeen[0]!, false, 'no auth header was invented for the missing credential')
})

test('web-page read-through: a broken recipe must not poison the read with its OWN selectors', async () => {
  // The recipe's API endpoint 404s AND the recipe carries selectors that match
  // nothing in the rendered page. The read must still answer: the failed path's
  // selectors are dropped for the fallback (plain render), exactly once.
  const dir = tmpDir('web-recipe-poison-')
  const recipeCtx = fakeCtx()
  apply(recipeCtx.ctx, { dir })
  const service = serviceOf(recipeCtx.services)
  await service.record({
    url: 'https://poison.example/page',
    readPath: { kind: 'api', url: 'https://poison.example/api/items', api: 'items', selectors: ['article.markdown-body'] },
    selectors: [{ name: 'main', form: 'css', selector: 'article.markdown-body' }],
    apis: [{ name: 'items', url: 'https://poison.example/api/items' }],
    confidence: 0.9,
  })

  const goneFetch = (async () =>
    new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch

  const pageTools = new Map<string, ToolDef>()
  const renders: Array<string[] | undefined> = []
  const renderer = {
    render: async (request: { url: string; selectors?: string[] }) => {
      renders.push(request.selectors)
      return {
        html: '<html><head><title>Poison fallback</title></head><body><main><h1>Still readable</h1><p>The plain body text of the poisoned read.</p></main></body></html>',
        finalUrl: request.url,
        status: 200,
        attempts: 1,
        elapsedMs: 2,
      }
    },
    dispose: async () => undefined,
  }
  const cacheDir = tmpDir('web-page-poison-cache-')
  applyPage(
    {
      workbench: {
        registerTool: (def: ToolDef) => {
          pageTools.set(def.name, def)
          return () => undefined
        },
      },
      effect: (callback: () => () => void) => {
        callback()
      },
      inject: (_deps: string[], callback: (injected: unknown) => void) => {
        callback({ 'web-recipe': service })
      },
    } as never,
    { cacheDir, spillDir: path.join(cacheDir, 'spill'), recipes: { enabled: true, record: false } },
    { renderer: renderer as never, fetchImpl: goneFetch },
  )

  const read = await pageTools.get('page read')!.handler({ url: 'https://poison.example/page', max_chars: 4000 })
  assert.match(String(read.markdown), /plain body text of the poisoned read/, 'the read still answers')
  assert.equal(renders.length, 1, 'the browser ran exactly once')
  assert.equal(renders[0], undefined, 'the failed recipe selectors were dropped for the fallback')
  const note = read.recipe as { via: string; status: string; fallback: string }
  assert.equal(note.via, 'api')
  assert.equal(note.status, 'failed', 'the broken recipe is reported, not hidden')
  assert.equal(note.fallback, 'render')
  const after = await service.get('poison.example')
  assert.equal(after?.provenance.lastVerificationStatus, 'failed', 'the read-through told the store')
})
