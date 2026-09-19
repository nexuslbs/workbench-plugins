// Tools capability tests (`definitions/tools.ts` + `plugins/tools-impl`).
//
// The by-name invocation surface is a CONTRACT: a consumer plugin registers a
// named tool with the parameters it expects, and any caller (HTTP, CLI, in
// process) invokes it through ONE dispatch that validates first. The HTTP
// assertions go through the PROVIDER's real route handlers, so a broken route,
// a missing validation or a leaking registration fails here instead of passing
// on a mock. The capability lives ENTIRELY in this repository: nothing below
// imports the workbench core.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  TOOLS,
  TOOLS_CONTRACT,
  ToolArgsError,
  ToolUnknownError,
  Tools,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
  type ParameterSchemaSpec,
} from '../definitions/tools.ts'
import { apply, registerToolRoutes, toolCommand, toolsCommand } from '../plugins/tools-impl/index.ts'

/** The tool schema the fixtures below register: one required, two optional params. */
const GREET_PARAMETERS: ParameterSchemaSpec = {
  name: { type: 'string', description: 'who to greet', required: true },
  greeting: { type: 'string', description: 'greeting word' },
  times: { type: 'integer', description: 'how many times to greet' },
}

/** A registry with one tool, as a consumer plugin would register it. */
function registryWithGreet(): Tools {
  const tools = new Tools({ fallbackOwner: 'hello-tool' })
  tools.registerTool({
    name: 'hello greet',
    description: 'greets one person by name',
    parameters: GREET_PARAMETERS,
    handler: (params) => `hello ${String(params.name)}`,
  })
  return tools
}

// ---------------------------------------------------------------------------
// The DEFINITION: schema compilation, validation, the registry
// ---------------------------------------------------------------------------

test('definitions/tools: parameterSchemaSpecToJsonSchema folds `required` in', () => {
  const schema = parameterSchemaSpecToJsonSchema(GREET_PARAMETERS)
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['name'])
  assert.equal(schema.properties.name.type, 'string')
  assert.equal(schema.properties.times.type, 'integer')
})

test('definitions/tools: validateArgs is path-qualified and structural', () => {
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'ada' }), [])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'ada', times: 3 }), [])
  const violations = validateArgs(GREET_PARAMETERS, { times: 'three' })
  assert.equal(violations.length, 2)
  assert.ok(violations.some((line) => line.startsWith('name: missing required parameter')))
  assert.ok(violations.some((line) => line.startsWith('times: expected an integer')))
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'ada', extra: 1 }), ['extra: unknown parameter'])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, ['ada']), ['params: expected an object, got array'])
})

test('definitions/tools: registerTool is fail-closed on duplicates and bad declarations', () => {
  const tools = registryWithGreet()
  assert.throws(() => tools.registerTool({ name: 'hello greet', handler: () => undefined }), /already registered/)
  assert.throws(() => tools.registerTool({ name: '  padded', handler: () => undefined }), /whitespace/)
  assert.throws(() => tools.registerTool({ name: 'slash/name', handler: () => undefined }), /must not contain/)
  assert.throws(
    () => tools.registerTool({ name: 'bad schema', handler: () => undefined, parameters: { x: { type: 'nope' } as never } }),
    /type must be one of/,
  )
})

test('definitions/tools: the registry dispatches through one validating entry point', async () => {
  const tools = registryWithGreet()
  assert.deepEqual([...tools.toolNames()], ['hello greet'])
  assert.equal(await tools.execute('hello greet', { name: 'ada' }), 'hello ada')
  await assert.rejects(() => tools.execute('nope'), (error: unknown) => {
    assert.ok(error instanceof ToolUnknownError)
    assert.equal(error.tool, 'nope')
    return true
  })
  await assert.rejects(() => tools.execute('hello greet', { greeting: 'hi' }), (error: unknown) => {
    assert.ok(error instanceof ToolArgsError)
    assert.deepEqual(error.violations, ['name: missing required parameter'])
    return true
  })
  const info = tools.tools()[0]
  assert.equal(info.plugin, 'hello-tool')
  assert.equal(info.parameters.required?.[0], 'name')
  const dispose = tools.registerTool({ name: 'second', handler: () => 'ok' })
  dispose()
  assert.equal(tools.get('second'), undefined)
})

// ---------------------------------------------------------------------------
// The PROVIDER: the `tools` service and the HTTP seams
// ---------------------------------------------------------------------------

interface Route {
  method: string
  path: string
  handler: (request: Request) => Response | undefined | void | Promise<Response | undefined | void>
}

interface Request {
  method: string
  path: string
  params?: Record<string, string>
  readText(): Promise<string>
}

interface Response {
  status?: number
  contentType?: string
  body?: string | Uint8Array
}

/** A host stub: the services `plugins/tools-impl` touches, nothing else. */
function createHost(): {
  ctx: Record<string, unknown>
  routes: Route[]
  commands: Map<string, (args: string[]) => string | void | Promise<string | void>>
  dispose(): void
} {
  const routes: Route[] = []
  const commands = new Map<string, (args: string[]) => string | void | Promise<string | void>>()
  const disposers: Array<() => void> = []
  const provided = new Map<string, unknown>()
  const web = {
    route(spec: Route): () => void {
      routes.push(spec)
      const dispose = (): void => {
        const index = routes.indexOf(spec)
        if (index >= 0) routes.splice(index, 1)
      }
      return dispose
    },
    routes: () => routes.map(({ method, path }) => ({ method, path })),
  }
  const ctx = {
    web,
    provide: (name: string, value: unknown): void => void provided.set(name, value),
    effect: (callback: () => () => void): void => void disposers.push(callback()),
    workbench: {
      attribution: () => 'hello-tool',
      registerCommand: (def: { name: string; run: (args: string[]) => string | void | Promise<string | void> }) => {
        commands.set(def.name, def.run)
        return () => void commands.delete(def.name)
      },
    },
  }
  return {
    ctx,
    routes,
    commands,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** Calls a registered route with a body (or none), the way the seam does. */
async function call(route: Route, params: Record<string, string> = {}, body?: unknown): Promise<Response> {
  const request: Request = {
    method: route.method,
    path: route.path.replace(/:(\w+)/g, (_, key: string) => params[key] ?? ''),
    params,
    readText: async () => (body === undefined ? '' : JSON.stringify(body)),
  }
  const answered = await route.handler(request)
  assert.ok(answered, `${route.method} ${route.path} must answer`)
  return answered
}

function routeOf(routes: Route[], method: string, path: string): Route {
  const found = routes.find((route) => route.method === method && route.path === path)
  assert.ok(found, `route ${method} ${path} must be registered`)
  return found
}

test('plugins/tools-impl: provides the tools service and the five wire routes', () => {
  const host = createHost()
  apply(host.ctx as never, { log: false })
  assert.ok(host.ctx.provide !== undefined)
  assert.deepEqual(
    host.routes.map((route) => `${route.method} ${route.path}`).sort(),
    ['GET /api/tools', 'GET /api/tools/:name', 'POST /api/tool/call', 'POST /api/tools', 'POST /api/tools/:name'],
  )
  assert.deepEqual([...host.commands.keys()].sort(), ['tool', 'tools'])
  host.dispose()
  assert.equal(host.routes.length, 0)
})

test('plugins/tools-impl: the routes dispatch, validate and 404 like the contract says', async () => {
  const host = createHost()
  const tools = registryWithGreet()
  const disposers = [registerToolRoutes((host.ctx.web as never), tools)]
  const routes = host.routes
  try {
    const list = await call(routeOf(routes, 'GET', '/api/tools'))
    assert.equal(list.status, 200)
    const payload = JSON.parse(String(list.body)) as { contract: string; count: number; tools: Array<{ name: string }> }
    assert.equal(payload.contract, TOOLS_CONTRACT)
    assert.equal(payload.count, 1)
    assert.equal(payload.tools[0].name, 'hello greet')

    const one = await call(routeOf(routes, 'GET', '/api/tools/:name'), { name: 'hello greet' })
    assert.equal(one.status, 200)
    assert.match(String(one.body), /hello greet/)

    const missing = await call(routeOf(routes, 'GET', '/api/tools/:name'), { name: 'nope' })
    assert.equal(missing.status, 404)

    const invoked = await call(routeOf(routes, 'POST', '/api/tools/:name'), { name: 'hello greet' }, { name: 'ada' })
    assert.equal(invoked.status, 200)
    assert.deepEqual(JSON.parse(String(invoked.body)), { status: 'ok', tool: 'hello greet', result: 'hello ada' })

    const badParams = await call(routeOf(routes, 'POST', '/api/tools/:name'), { name: 'hello greet' }, { times: 2 })
    assert.equal(badParams.status, 400)
    assert.equal((JSON.parse(String(badParams.body)) as { error: { kind: string } }).error.kind, 'invalid-params')

    const unknown = await call(routeOf(routes, 'POST', '/api/tools/:name'), { name: 'nope' }, {})
    assert.equal(unknown.status, 404)

    const alias = await call(routeOf(routes, 'POST', '/api/tool/call'), {}, { tool: 'hello greet', params: { name: 'bob' } })
    assert.equal(alias.status, 200)
    assert.match(String(alias.body), /hello bob/)

    const aliasNoTool = await call(routeOf(routes, 'POST', '/api/tools'), {}, { params: {} })
    assert.equal(aliasNoTool.status, 400)
  } finally {
    for (const dispose of disposers) dispose()
  }
  assert.equal(host.routes.length, 0, 'the disposer removes every route')
})

test('plugins/tools-impl: the CLI commands run the same dispatch', async () => {
  const tools = registryWithGreet()
  const listed = toolsCommand(tools, [])
  assert.match(listed, /hello greet/)
  assert.match(listed, /name \(required\): string/)
  const json = JSON.parse(toolsCommand(tools, ['--json'])) as { contract: string; tools: unknown[] }
  assert.equal(json.contract, TOOLS_CONTRACT)
  assert.equal(json.tools.length, 1)
  const result = await toolCommand(tools, ['hello greet', '{"name":"ada"}'])
  assert.match(String(result), /hello ada/)
  assert.equal(await toolCommand(tools, ['nope']), undefined)
  assert.equal(process.exitCode, 1)
  try {
    await toolCommand(tools, ['hello greet', 'not-json'])
  } catch (error) {
    assert.match(String(error), /must be valid JSON/)
  }
  process.exitCode = 0
})

test('plugins/tools-impl: the service name is the contract id', () => {
  assert.equal(TOOLS, 'tools')
  assert.equal(TOOLS_CONTRACT, 'tools@1')
})
