// Unit test for the external plugin: it must register `hello otherworld` through
// the context service, and must clean the command up again when disposed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, default as plugin, name } from '../plugins/hello-otherworld/index.ts'

interface Registered {
  name: string
  description?: string
  run: (args: string[]) => string | Promise<string>
}

function makeContext() {
  const commands: Registered[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    workbench: {
      registerCommand(def: Registered): () => void {
        commands.push(def)
        return () => {
          const index = commands.indexOf(def)
          if (index >= 0) commands.splice(index, 1)
        }
      },
    },
    effect(callback: () => () => void): void {
      disposers.push(callback())
    },
  }
  return { ctx, commands, disposers }
}

test('registers the hello otherworld command', async () => {
  const { ctx, commands } = makeContext()
  apply(ctx, {})
  const command = commands.find((entry) => entry.name === 'hello otherworld')
  assert.ok(command, 'hello otherworld must be registered')
  assert.equal(await command.run([]), 'Hello Otherworld')
})

test('reads the greeting from the plugin config', async () => {
  const { ctx, commands } = makeContext()
  apply(ctx, { message: 'Hi Otherworld' })
  assert.equal(commands.length, 1)
  assert.equal(await commands[0].run([]), 'Hi Otherworld')
})

test('disposing the plugin unregisters the command', () => {
  const { ctx, commands, disposers } = makeContext()
  apply(ctx, {})
  assert.equal(commands.length, 1)
  for (const dispose of disposers) dispose()
  assert.equal(commands.length, 0)
})

test('entry export and manifest agree on the plugin name', () => {
  assert.equal(plugin.name, name)
  assert.deepEqual((plugin as { inject?: string[] }).inject, ['workbench'])
})
