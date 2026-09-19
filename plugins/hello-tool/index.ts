// External workbench plugin: registers a TOOL with the core.
//
// It deliberately imports NOTHING from the core package: `ctx.workbench` is the
// whole contract this plugin relies on. A tool is a NAME, a description, the
// PARAMETERS it expects (a small DSH-style property map, `required: true` per
// property) and a handler. The core exposes the registered tool so any caller
// can invoke it BY NAME - over HTTP (`POST /api/tools/<name>`, the parameters in
// the body, or the `{"tool","params"}` alias at `POST /api/tool/call`), from the
// CLI (`workbench tool <name>`) or in process - and validates the parameters
// against this schema before the handler runs.

/** One declared parameter: the type the caller must pass and whether it is required. */
interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'
  description?: string
  required?: boolean
  enum?: readonly (string | number | boolean)[]
}

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = Record<string, ToolParameter>

interface WorkbenchLike {
  registerTool(def: {
    name: string
    description?: string
    parameters?: ToolParameters
    handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  }): () => void
}

interface PluginContext {
  workbench: WorkbenchLike
  effect(callback: () => () => void): void
}

export const name = 'hello-tool'

export interface Config {
  /** Greeting used when the caller passes none (default: `Hello`). */
  greeting?: string
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  const fallback = config.greeting ?? 'Hello'
  ctx.effect(() =>
    ctx.workbench.registerTool({
      name: 'hello greet',
      description: 'greets one person: required name, optional greeting and times',
      parameters: {
        name: { type: 'string', description: 'who to greet', required: true },
        greeting: { type: 'string', description: `greeting word (default: ${fallback})` },
        times: { type: 'integer', description: 'how many times to greet (default: 1)' },
      },
      handler: (params) => {
        const who = String(params.name)
        const greeting = typeof params.greeting === 'string' ? params.greeting : fallback
        const times = typeof params.times === 'number' ? params.times : 1
        return {
          message: Array.from({ length: times }, () => `${greeting}, ${who}!`).join(' '),
          plugin: name,
        }
      },
    }),
  )
}

export default { name, inject: ['workbench'], apply }
