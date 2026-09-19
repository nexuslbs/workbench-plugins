// Unit test for the external tool plugin: it must register `hello greet` with
// the parameters it expects (one required, two optional) through the context
// service, answer with the config fallback, and clean the tool up when disposed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, default as plugin, name } from '../plugins/hello-tool/index.ts'

interface ToolParameter {
  type: string
  description?: string
  required?: boolean
}

interface Registered {
  name: string
  description?: string
  parameters?: Record<string, ToolParameter>
  handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
}

function makeContext() {
  const tools: Registered[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    workbench: {
      registerTool(def: Registered): () => void {
        tools.push(def)
        return () => {
          const index = tools.indexOf(def)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
    effect(callback: () => () => void): void {
      disposers.push(callback())
    },
  }
  return { ctx, tools, disposers }
}

test('registers the hello greet tool with one required and two optional parameters', () => {
  const { ctx, tools } = makeContext()
  apply(ctx, {})
  assert.equal(tools.length, 1)
  const tool = tools[0] as Registered
  assert.equal(tool.name, 'hello greet')
  assert.ok(tool.description, 'a tool needs a description for the tool list')
  const parameters = tool.parameters ?? {}
  assert.deepEqual(Object.keys(parameters), ['name', 'greeting', 'times'])
  assert.equal(parameters.name?.type, 'string')
  assert.equal(parameters.name?.required, true)
  assert.equal(parameters.greeting?.required, undefined, 'greeting is optional')
  assert.equal(parameters.times?.type, 'integer')
  assert.equal(parameters.times?.required, undefined, 'times is optional')
})

test('the handler greets with the parameters and the config fallback', async () => {
  const { ctx, tools } = makeContext()
  apply(ctx, {})
  assert.deepEqual(await tools[0]?.handler({ name: 'Ada' }), { message: 'Hello, Ada!', plugin: 'hello-tool' })
  assert.deepEqual(await tools[0]?.handler({ name: 'Ada', greeting: 'Hi', times: 2 }), { message: 'Hi, Ada! Hi, Ada!', plugin: 'hello-tool' })

  const configured = makeContext()
  apply(configured.ctx, { greeting: 'Servus' })
  assert.deepEqual(await configured.tools[0]?.handler({ name: 'Ada' }), { message: 'Servus, Ada!', plugin: 'hello-tool' })
})

test('disposing the plugin unregisters the tool', () => {
  const { ctx, tools, disposers } = makeContext()
  apply(ctx, {})
  assert.equal(tools.length, 1)
  for (const dispose of disposers) dispose()
  assert.equal(tools.length, 0)
})

test('entry export and manifest agree on the plugin name', () => {
  assert.equal(plugin.name, name)
  assert.deepEqual((plugin as { inject?: string[] }).inject, ['workbench'])
})
