/**
 * Tools capability - SERVICE DEFINITION (registry + the single dispatch).
 *
 * A CONSUMER plugin registers a named tool together with the parameters it
 * expects (a small, JSON-Schema-compatible spec) and a handler; the PROVIDER
 * plugin (`core/tools-impl`) exposes the tool set so a caller can invoke a
 * tool BY NAME - in process ({@link Tools.execute}), from the CLI and over HTTP
 * (`GET /api/tools`, `GET /api/tools/<name>`, `POST /api/tools/<name>`,
 * `POST /api/tools`, `POST /api/tool/call`). Workbench has no model and no agent
 * loop: the consumers are plugins and operators.
 *
 *   Provider  ->  Definition  <-  Consumer
 *
 * Placement (operator rule 2026-09-19): the whole capability lives HERE, in the
 * PUBLIC `nexuslbs/workbench-plugins` repository. The core
 * (`nexuslbs/workbench`) holds no tool module, exports no tool Definition and
 * registers no `/api/tools*` route: it only loads this repository as a source.
 * A consumer registers through the SERVICE (`ctx.tools`), never by importing a
 * provider.
 *
 * The shape follows DSH (`packages/core/tools/src/schema.ts`):
 *
 * - the author form is a per-property parameter map with `required: true` on a
 *   property ({@link ParameterSpec}),
 * - it COMPILES to plain JSON Schema (`parameterSchemaSpecToJsonSchema`, DSH
 *   `packages/core/tools/src/schema.ts:449`),
 * - `validateArgs(spec, args): string[]` returns human-readable, path-qualified
 *   violations BEFORE the handler runs (DSH `schema.ts:478`), and
 * - registration is fail-closed on a duplicate name (`Tools.registerTool`
 *   rejects it), exactly like the DSH `ToolRuntime` registry
 *   (`packages/core/tools/src/index.ts:789`).
 *
 * What workbench deliberately does NOT take from DSH: prompt assembly, tool
 * schemas for a model, presentation/rendering, the agent loop, policy guards,
 * scoped layers. None of that exists here.
 *
 * This module is CORDIS-FREE and imports nothing: the service base is
 * STRUCTURAL, so the file compiles and runs inside any host that exposes a
 * `tools` service with the published shape.
 */

/** Name of the cordis service (`ctx.tools`). */
export const TOOLS = 'tools'

/** Contract version this definition speaks. A provider must implement it. */
export const TOOLS_VERSION = 1

/** Contract id including the version, e.g. `tools@1`. */
export const TOOLS_CONTRACT = `${TOOLS}@${TOOLS_VERSION}`

/**
 * Scalar/structural kinds a parameter may declare. They map 1:1 to the JSON
 * Schema `type` keyword, plus `integer` and the escape hatch `json` (any JSON
 * value, DSH's `json` author node).
 */
export type ParameterType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json'

/**
 * One declared parameter (DSH `ParameterSchemaSpec` node). `required: true`
 * marks the property required IN ITS PARENT; the compiler folds those flags into
 * the parent's JSON Schema `required` array.
 */
export interface ParameterSpec {
  type: ParameterType
  /** Human readable purpose, shown in `GET /api/tools` and `workbench tools`. */
  description?: string
  /** True when the caller MUST pass this parameter. */
  required?: boolean
  /** Allowed scalar values (closed set). */
  enum?: readonly (string | number | boolean)[]
  /** `array` only: the schema of one element. */
  items?: ParameterSpec
  /** `object` only: the property map of the nested object. */
  properties?: ParameterSchemaSpec
}

/**
 * The parameter map a tool registers: one entry per parameter, DSH's author
 * form. An omitted/empty map means the tool takes no parameters (and any
 * parameter in the body is then an "unknown parameter" violation).
 */
export type ParameterSchemaSpec = Record<string, ParameterSpec>

/** One property of the compiled JSON Schema. */
export interface ParameterJsonSchemaProperty {
  type: ParameterType
  description?: string
  enum?: readonly (string | number | boolean)[]
  items?: ParameterJsonSchemaProperty
  /** `object` only: the nested property map (same shape as the root schema). */
  properties?: ParameterJsonSchema
  required?: string[]
}

/** The compiled JSON Schema of a tool's parameters (what `GET /api/tools` shows). */
export interface ParameterJsonSchema {
  type: 'object'
  properties: Record<string, ParameterJsonSchemaProperty>
  required?: string[]
}

/** A tool a plugin registered with the tools service. */
export interface ToolDefinition {
  /** Unique tool name, e.g. `hello greet`. */
  name: string
  /** Runs the tool with validated parameters and returns its result. */
  handler: (params: Record<string, unknown>) => unknown | Promise<unknown>
  /** Human readable purpose. */
  description?: string
  /** The parameters the tool expects (author form). */
  parameters?: ParameterSchemaSpec
  /** Plugin that registered the tool (attributed by the provider/host). */
  plugin?: string
  /** The compiled parameter schema (snapshotted at registration). */
  schema?: ParameterJsonSchema
}

/** A registered tool as the inventory/HTTP list reports it. */
export interface ToolInfo {
  name: string
  description?: string
  /** Plugin that registered the tool. */
  plugin: string
  parameters: ParameterJsonSchema
}

/** The body/param value did not satisfy the registered parameter schema. */
export class ToolArgsError extends Error {
  readonly tool: string
  /** Human readable, path-qualified violations; empty means valid. */
  readonly violations: string[]

  constructor(tool: string, violations: string[]) {
    super(`invalid params for tool '${tool}': ${violations.join('; ')}`)
    this.name = 'ToolArgsError'
    this.tool = tool
    this.violations = violations
  }
}

/** The tool named by the caller is not registered (or was disposed). */
export class ToolUnknownError extends Error {
  readonly tool: string

  constructor(tool: string) {
    super(`unknown tool '${tool}'`)
    this.name = 'ToolUnknownError'
    this.tool = tool
  }
}

function authorError(message: string): never {
  throw new Error(`tools: ${message}`)
}

/** Plain object check (no arrays, no null, no class instances). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The JSON kind of a candidate value, for readable violations. */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Compiles ONE declared parameter, validating the declaration itself. */
function compileProperty(spec: ParameterSpec, where: string): ParameterJsonSchemaProperty {
  if (!isPlainObject(spec)) authorError(`${where} must be an object with a 'type' (got ${kindOf(spec)})`)
  const { type, description, required, enum: values, items, properties } = spec
  const allowed: ParameterType[] = ['string', 'number', 'integer', 'boolean', 'array', 'object', 'json']
  if (typeof type !== 'string' || !allowed.includes(type as ParameterType)) {
    authorError(`${where}.type must be one of ${allowed.join('/')} (got ${JSON.stringify(type)})`)
  }
  if (description !== undefined && typeof description !== 'string') authorError(`${where}.description must be a string`)
  if (required !== undefined && typeof required !== 'boolean') authorError(`${where}.required must be a boolean`)
  const compiled: ParameterJsonSchemaProperty = {
    type: type as ParameterType,
    ...(description === undefined ? {} : { description }),
  }
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) authorError(`${where}.enum must be a non-empty array`)
    for (const value of values) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        authorError(`${where}.enum entries must be scalars (string/number/boolean)`)
      }
    }
    compiled.enum = values
  }
  if (items !== undefined) {
    if (type !== 'array') authorError(`${where}.items is only valid for type 'array'`)
    compiled.items = compileProperty(items, `${where}.items`)
  }
  if (properties !== undefined) {
    if (type !== 'object') authorError(`${where}.properties is only valid for type 'object'`)
    compiled.properties = compileParameterMap(properties, `${where}.properties`)
  }
  return compiled
}

/** Compiles a parameter map into a JSON Schema object root (required folded in). */
export function parameterSchemaSpecToJsonSchema(spec: ParameterSchemaSpec): ParameterJsonSchema {
  return compileParameterMap(spec, 'parameters')
}

function compileParameterMap(spec: ParameterSchemaSpec, where: string): ParameterJsonSchema {
  if (!isPlainObject(spec)) authorError(`${where} must be a property map (got ${kindOf(spec)})`)
  const properties: Record<string, ParameterJsonSchemaProperty> = {}
  const required: string[] = []
  for (const [name, property] of Object.entries(spec)) {
    if (name.length === 0) authorError(`${where} has an empty parameter name`)
    properties[name] = compileProperty(property, `${where}.${name}`)
    if (property.required === true) required.push(name)
  }
  return { type: 'object', properties, ...(required.length === 0 ? {} : { required }) }
}

/** `parent.child` (or `child` at the root) - the path form of a violation. */
function joinPath(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}.${name}`
}

function validateProperties(
  schema: ParameterJsonSchema,
  args: Record<string, unknown>,
  path: string,
  violations: string[],
): void {
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(args, name) || args[name] === undefined) {
      violations.push(`${joinPath(path, name)}: missing required parameter`)
    }
  }
  for (const [name, value] of Object.entries(args)) {
    const where = joinPath(path, name)
    const property = schema.properties[name]
    if (property === undefined) {
      violations.push(`${where}: unknown parameter`)
      continue
    }
    validateValue(property, value, where, violations)
  }
}

function validateValue(
  property: ParameterJsonSchemaProperty,
  value: unknown,
  where: string,
  violations: string[],
): void {
  switch (property.type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${where}: expected a string, got ${kindOf(value)}`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${where}: expected a number, got ${kindOf(value)}`)
      break
    case 'integer':
      if (!Number.isInteger(value)) violations.push(`${where}: expected an integer, got ${kindOf(value)}`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${where}: expected a boolean, got ${kindOf(value)}`)
      break
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${where}: expected an array, got ${kindOf(value)}`)
        break
      }
      const items = property.items
      if (items) value.forEach((entry, index) => validateValue(items, entry, `${where}[${index}]`, violations))
      break
    }
    case 'object': {
      if (!isPlainObject(value)) {
        violations.push(`${where}: expected an object, got ${kindOf(value)}`)
        break
      }
      // `property.properties` IS the compiled JSON Schema root of the nested object
      // (its own `required` array included), so it is passed through unchanged.
      validateProperties(property.properties ?? { type: 'object', properties: {} }, value, where, violations)
      break
    }
    case 'json':
      break
  }
  if (property.enum !== undefined && !property.enum.some((allowed) => allowed === value)) {
    violations.push(`${where}: expected one of ${property.enum.map((allowed) => JSON.stringify(allowed)).join(', ')}, got ${JSON.stringify(value)}`)
  }
}

/**
 * Validates candidate parameters against a declared parameter map, DSH
 * `validateArgs` style: structural only (required, types, unknown keys, enum),
 * path-qualified and human readable; an empty array means the args are valid.
 * The registry calls this BEFORE the handler, so a handler only ever sees a body
 * that satisfies its declared schema.
 */
export function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[] {
  const schema = parameterSchemaSpecToJsonSchema(spec)
  if (!isPlainObject(args)) return [`params: expected an object, got ${kindOf(args)}`]
  const violations: string[] = []
  validateProperties(schema, args, '', violations)
  return violations
}

/** How the provider attributes a tool to the plugin that registered it. */
export interface ToolsOptions {
  /**
   * Name of the plugin whose `apply` is running right now. The host answers this
   * (it marks the plugin it is applying); it is what `GET /api/tools` reports per
   * tool. Falls back to {@link ToolsOptions.fallbackOwner}.
   */
  owner?: () => string | undefined
  /** Owner used when the host cannot attribute the registration. */
  fallbackOwner?: string
  /** Log sink (stderr by default at the provider). */
  log?: (message: string) => void
}

/**
 * The tool registry: what plugins register with and the SINGLE dispatch entry
 * point every caller (HTTP, CLI, in-process) goes through. It never touches a
 * socket and never builds a prompt.
 */
export class Tools {
  // Plain (runtime) properties, not `#private`: the registry is reachable
  // through a cordis Proxy and a Proxy breaks private fields.
  protected entries = new Map<string, { definition: ToolDefinition; schema: ParameterJsonSchema }>()
  protected options: ToolsOptions

  constructor(options: ToolsOptions = {}) {
    this.options = options
  }

  /** The plugin a registration made right now belongs to. */
  owner(): string {
    const fromHost = this.options.owner?.()
    if (typeof fromHost === 'string' && fromHost.length > 0) return fromHost
    return this.options.fallbackOwner ?? 'unknown'
  }

  /**
   * Registers one tool; returns the disposer that unregisters it. A duplicate
   * name is rejected (never a silent overwrite) and a malformed parameter
   * declaration throws, so a plugin fails at load instead of at call time.
   */
  registerTool(def: Omit<ToolDefinition, 'plugin' | 'schema'> & { plugin?: string }): () => void {
    const raw = def?.name
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (name.length === 0) throw new Error('registerTool: a tool name is required')
    if (name !== raw) throw new Error(`registerTool('${raw}'): a tool name must not start or end with whitespace`)
    if (name.includes('/')) {
      throw new Error(`registerTool('${name}'): a tool name must not contain '/'; names with a slash are only reachable through the POST /api/tools alias body`)
    }
    if (typeof def.handler !== 'function') throw new Error(`registerTool('${name}'): 'handler' must be a function`)
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new Error(`registerTool('${name}'): 'description' must be a string`)
    }
    if (this.entries.has(name)) throw new Error(`tool '${name}' is already registered`)
    const spec = def.parameters ?? {}
    const schema = parameterSchemaSpecToJsonSchema(spec)
    const definition: ToolDefinition = {
      name,
      handler: def.handler,
      ...(def.description === undefined ? {} : { description: def.description }),
      parameters: spec,
      schema,
      plugin: def.plugin ?? this.owner(),
    }
    const entry = { definition, schema }
    this.entries.set(name, entry)
    return () => {
      if (this.entries.get(name) === entry) this.entries.delete(name)
    }
  }

  /** The registered tool names (registration order). */
  toolNames(): Set<string> {
    return new Set(this.entries.keys())
  }

  /** Every registered tool with its compiled parameter schema, sorted by name. */
  tools(): ToolInfo[] {
    return [...this.entries.values()]
      .map(({ definition, schema }) => ({
        name: definition.name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        plugin: definition.plugin ?? 'unknown',
        parameters: schema,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  /** One registered tool, or undefined. */
  get(name: string): ToolDefinition | undefined {
    return this.entries.get(name)?.definition
  }

  /**
   * THE dispatch: resolve the tool by name, validate the parameters against its
   * registered schema, then run the handler. Throws {@link ToolUnknownError}
   * (unknown/unloaded tool) or {@link ToolArgsError} (validation) before the
   * handler runs; a handler error propagates unchanged (the caller maps it).
   */
  async execute(name: string, params?: unknown): Promise<unknown> {
    const entry = this.entries.get(name)
    if (!entry) throw new ToolUnknownError(name)
    const args = params === undefined ? {} : params
    const violations = validateArgs(entry.definition.parameters ?? {}, args)
    if (violations.length > 0) throw new ToolArgsError(name, violations)
    return await entry.definition.handler(args as Record<string, unknown>)
  }

  /** Log sink shared with the host. */
  logLine(message: string): void {
    const sink = this.options.log
    if (sink) sink(message)
  }

  /**
   * The CONSUMER slice of the capability: what a consumer is allowed to call.
   * {@link Tools} satisfies it structurally; `ctx.tools` is an instance of it.
   */
  consumer(): ToolConsumer {
    return {
      registerTool: (def) => this.registerTool(def),
      toolNames: () => this.toolNames(),
      tools: () => this.tools(),
    }
  }
}

/**
 * The CONSUMER slice of the capability: what a consumer plugin is allowed to
 * call (`ctx.tools`). It registers a named tool and can read the registry; it
 * never runs a tool (that is the caller/provider surface).
 */
export interface ToolConsumer {
  /** Registers a tool (name + parameter schema + handler); returns the disposer. */
  registerTool(def: Omit<ToolDefinition, 'plugin' | 'schema'>): () => void
  /** The registered tool names. */
  toolNames(): Set<string>
  /** Every registered tool with its compiled parameter schema, sorted by name. */
  tools(): ToolInfo[]
}
