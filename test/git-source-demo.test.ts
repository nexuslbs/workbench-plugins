// Unit test of the plugin that is loaded from a GIT source in dev.
//
// It is deliberately tiny and imports NOTHING from the core: the plugin only
// uses the injected `ctx.workbench` contract, and this test fakes exactly that.
// The end-to-end proof (clone -> subdir scan -> command answers) lives in the
// core repo (`test/sources.test.ts`) and in the dev service.
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, name, VERSION } from '../examples/git-source-demo/index.ts'

interface CommandDef {
  name: string
  description?: string
  run: (args: string[]) => string | Promise<string>
}

test('the git-source demo plugin registers its command and answers with its version', () => {
  const commands: CommandDef[] = []
  const disposers: Array<() => void> = []
  let disposed = 0
  const ctx = {
    workbench: {
      registerCommand: (def: CommandDef): (() => void) => {
        commands.push(def)
        return () => {
          disposed += 1
        }
      },
    },
    // Mimics cordis `ctx.effect`: the callback runs now and its disposer is
    // registered, so the test can unload exactly like the kernel does.
    effect: (callback: () => () => void): (() => void) => {
      disposers.push(callback())
      return () => undefined
    },
  }

  apply(ctx as never, { message: 'Hi from a git source' })

  assert.equal(name, 'git-source-demo')
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'git source demo')
  assert.equal(commands[0].run([]), `Hi from a git source (git-source-demo@${VERSION})`)

  // Unloading disposes the registration exactly once (the plugin holds no global state).
  for (const dispose of disposers) dispose()
  assert.equal(disposed, 1)
})
