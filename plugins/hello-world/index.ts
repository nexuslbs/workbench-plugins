// External workbench plugin.
//
// This plugin USED TO SHIP INSIDE THE CORE (`plugins/hello-world` of
// nexuslbs/workbench). It now lives in the plugins repository like every other
// plugin: the core ships ZERO plugins, and this one is loaded through exactly
// the same plugin-source mechanism as any external source.
//
// It deliberately imports NOTHING from the core package: the core injects its
// service as `ctx.workbench`, which is the whole contract this plugin relies on.
// That keeps this plugin usable by any core version that honours the contract.

interface WorkbenchLike {
  registerCommand(def: { name: string; description?: string; run: (args: string[]) => string | Promise<string> }): () => void
}

interface PluginContext {
  workbench: WorkbenchLike
  effect(callback: () => () => void): void
}

export const name = 'hello-world'

export interface Config {
  message?: string
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const message = config.message ?? 'Hello World'
  ctx.effect(() =>
    ctx.workbench.registerCommand({
      name: 'hello world',
      description: 'prints the greeting',
      run: () => message,
    }),
  )
}

export default { name, inject: ['workbench'], apply }
