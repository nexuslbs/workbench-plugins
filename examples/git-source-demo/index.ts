// External workbench plugin loaded from a GIT source.
//
// It lives under `examples/` (NOT under `plugins/`) on purpose: the dev config
// points a `kind: "git"` source at this repository with `subdir: examples`, so
// this plugin can only be discovered after the core has cloned the repository
// into its cache and scanned the subtree. That makes "a git source, subdir
// selection and the plugin answering" one observable end-to-end fact.
//
// Like every workbench plugin it imports NOTHING from the core: the core injects
// its service as `ctx.workbench`, which is the whole contract.
//
// It also exposes the greeting message as plugin config, so a different `ref`
// (branch / tag / sha) can be told apart from the command output alone - that is
// the update-path evidence.

interface WorkbenchLike {
  registerCommand(def: { name: string; description?: string; run: (args: string[]) => string | Promise<string> }): () => void
}

interface PluginContext {
  workbench: WorkbenchLike
  effect(callback: () => () => void): void
}

export const name = 'git-source-demo'

/** Set from the manifest version at load time; part of the command output. */
export const VERSION = '0.1.0'

export interface Config {
  message?: string
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const message = config.message ?? 'Hello from a git plugin source'
  ctx.effect(() =>
    ctx.workbench.registerCommand({
      name: 'git source demo',
      description: 'prints the greeting of the plugin loaded from a git source',
      run: () => `${message} (${name}@${VERSION})`,
    }),
  )
}

export default { name, inject: ['workbench'], apply }
