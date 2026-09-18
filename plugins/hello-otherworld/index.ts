// External workbench plugin.
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

export const name = 'hello-otherworld'

export interface Config {
  message?: string
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const message = config.message ?? 'Hello Otherworld'
  ctx.effect(() =>
    ctx.workbench.registerCommand({
      name: 'hello otherworld',
      description: 'prints the external greeting',
      run: () => message,
    }),
  )
}

export default { name, inject: ['workbench'], apply }
