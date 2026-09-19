// Unit test for the plugin that was MOVED out of the core repository
// (`nexuslbs/workbench` `plugins/hello-world`): it must register `hello world`
// through the context service and must clean the command up again when disposed.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, default as plugin, name } from '../plugins/hello-world/index.ts'

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

test('registers the hello world command', async () => {
  const { ctx, commands } = makeContext()
  apply(ctx, {})
  const command = commands.find((entry) => entry.name === 'hello world')
  assert.ok(command, 'hello world must be registered')
  assert.equal(await command.run([]), 'Hello World')
})

test('reads the greeting from the plugin config', async () => {
  const { ctx, commands } = makeContext()
  apply(ctx, { message: 'Hi' })
  assert.equal(commands.length, 1)
  assert.equal(await commands[0].run([]), 'Hi')
})

test('disposing the plugin unregisters the command', () => {
  const { ctx, commands, disposers } = makeContext()
  apply(ctx, {})
  assert.equal(commands.length, 1)
  for (const dispose of disposers) dispose()
  assert.equal(commands.length, 0)
})

test('entry export and manifest agree on the plugin name', async () => {
  assert.equal(plugin.name, name)
  assert.deepEqual((plugin as { inject?: string[] }).inject, ['workbench'])
  const manifest = JSON.parse(
    await import('node:fs').then((fs) => fs.readFileSync(new URL('../plugins/hello-world/workbench.plugin.json', import.meta.url), 'utf8')),
  ) as { name: string; capabilities: string[] }
  assert.equal(manifest.name, name, 'the manifest must name the plugin the entry module exports')
  assert.deepEqual(manifest.capabilities, ['command:hello world'])
})
