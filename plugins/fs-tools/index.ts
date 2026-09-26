// plugins/fs-tools - the CONSUMER of the filesystem capability (`fs@1`).
//
// Three roles make up the capability seam (core `docs/PLUGIN-CONTRACT.md` 4g):
//   Definition (definitions/fs.ts) - the contract, `ctx.fs`
//   Provider                       - a backend implementation (`core/fs-local` today)
//   Consumer                       - THIS plugin: it exposes the capability as
//                                    named TOOLS and never learns which backend
//                                    answers, nor where a file physically lives.
//
// It imports the DEFINITION (never a provider): swapping `fs-local` for a
// future ssh/container-backed `fs@1` provider is a config edit, this file does
// not change, and `npm run check:seam` enforces that direction.
//
// The tools are the agent-facing half of the seam, one per operation:
//   `fs read`         - LINE-NUMBERED, paged read (offset/limit, end-of-file note)
//   `fs write`        - full content, overwrite (createParents, expectedVersion)
//   `fs append`       - append, creating the file when missing
//   `fs str_replace`  - one exact-match replacement (occurrence rules in the definition)
//   `fs insert`       - insert whole lines before a 1-based line number
//   `fs apply_patch`  - an ATOMIC batch of `str_replace` / `insert` edits
//   `fs list`         - directory entries with their type
//   `fs info`         - size / type / mtime / permissions (the metadata call)
//   `fs search`       - file NAME glob (`**/*.ts`) with a cap
//   `fs grep`         - file CONTENT regex with a hard cap + SPILL of the full list
//
// Every tool answers with the STRUCTURED result of the definition (paging
// metadata, edit reports, the spill reference): nothing here re-formats an answer
// into prose, so a caller can page and retry deterministically.

import { fsOf, parseFsEdits, FsError } from '../../definitions/fs.ts'
import type { FsGrepResult, FsService } from '../../definitions/fs.ts'
import type { ParameterSchemaSpec } from '../../definitions/tools.ts'
import { defineTool, renderValue, type ToolDefinition } from '../../definitions/tools.ts'

export const name = 'fs-tools'

/** One declared tool parameter (the author form of `definitions/tools.ts`). */
type ToolParameter = ParameterSchemaSpec[string]

/** The parameter map of a tool (what `GET /api/tools` publishes). */
type ToolParameters = ParameterSchemaSpec

interface ToolsLike {
  register(def: ToolDefinition): () => void
}

interface PluginContext {
  tools: ToolsLike
  effect(callback: () => () => void): void
}

/** The config of this consumer (a single knob: how many directory entries `list` returns). */
export interface Config {
  listLimit?: number
}

/** Read a required string parameter, rejecting a missing/empty one with a typed error. */
function requiredPath(params: Record<string, unknown>, key = 'path'): string {
  const value = params[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new FsError('fs.invalid-input', `the '${key}' parameter is required and must be a non-empty string`, {
      stage: 'fs-tools',
      details: { parameter: key },
    })
  }
  return value
}

/** Read an optional string parameter (a non-string is an error, never a coercion). */
function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new FsError('fs.invalid-input', `the '${key}' parameter must be a string`, { stage: 'fs-tools', details: { parameter: key } })
  }
  return value
}

/** Read an optional boolean parameter. */
function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new FsError('fs.invalid-input', `the '${key}' parameter must be a boolean`, { stage: 'fs-tools', details: { parameter: key } })
  }
  return value
}

/** Read an optional integer parameter (a positive integer or a typed error). */
function optionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new FsError('fs.invalid-input', `the '${key}' parameter must be an integer`, { stage: 'fs-tools', details: { parameter: key } })
  }
  return value
}

/**
 * The `fs grep` answer, trimmed for a caller: the inline window plus the spill
 * reference. The definition already caps and spills; this only drops nothing.
 */
function grepAnswer(result: FsGrepResult): FsGrepResult {
  return result
}

export function apply(ctx: PluginContext, config: Config = {}): void {
  // `ctx.fs` is the SEAM: resolved lazily at call time through the definition,
  // so this plugin loads on its own and fails only when a call cannot be served.
  const fs = (): FsService => {
    const service = fsOf(ctx as never)
    if (service === undefined) {
      throw new FsError('fs.invalid-input', 'no fs@1 provider is loaded: enable a provider plugin (core/fs-local) in the roster', {
        stage: 'fs-tools',
      })
    }
    return service
  }

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs read',
      description:
        'READS a text file LINE BY LINE, numbered: offset/limit page the lines (default limit 2000), every line is byte-capped, and the answer carries totalLines/nextOffset/eof plus an end-of-file note',
      parameters: {
        path: { type: 'string', description: 'file to read (absolute, or relative to the fs provider cwd)', required: true },
        offset: { type: 'integer', description: '1-based number of the FIRST line to return (default 1)' },
        limit: { type: 'integer', description: 'maximum number of lines to return (default and max 2000)' },
        maxLineBytes: { type: 'integer', description: 'byte cap of one returned line (default 2000)' },
      },
      execute: (params) =>
        fs().read({
          path: requiredPath(params),
          ...(optionalInteger(params, 'offset') !== undefined ? { offset: optionalInteger(params, 'offset') } : {}),
          ...(optionalInteger(params, 'limit') !== undefined ? { limit: optionalInteger(params, 'limit') } : {}),
          ...(optionalInteger(params, 'maxLineBytes') !== undefined ? { maxLineBytes: optionalInteger(params, 'maxLineBytes') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs write',
      description: 'WRITES a file with the given content (overwrite, creating parent directories): writes are confined to the provider roots',
      parameters: {
        path: { type: 'string', description: 'file to write', required: true },
        content: { type: 'string', description: 'the full new content of the file', required: true },
        createParents: { type: 'boolean', description: 'create missing parent directories (default true)' },
        expectedVersion: { type: 'string', description: 'the version returned by a previous read/info: a mismatch fails with fs.edit-conflict instead of overwriting' },
      },
      execute: (params) =>
        fs().write({
          path: requiredPath(params),
          content: String(params.content ?? ''),
          ...(optionalBoolean(params, 'createParents') !== undefined ? { createParents: optionalBoolean(params, 'createParents') } : {}),
          ...(optionalString(params, 'expectedVersion') !== undefined ? { expectedVersion: optionalString(params, 'expectedVersion') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs append',
      description: 'APPENDS content to a file, creating it when it does not exist (writes are confined to the provider roots)',
      parameters: {
        path: { type: 'string', description: 'file to append to', required: true },
        content: { type: 'string', description: 'the content appended at the end of the file', required: true },
        createParents: { type: 'boolean', description: 'create missing parent directories (default true)' },
      },
      execute: (params) =>
        fs().append({
          path: requiredPath(params),
          content: String(params.content ?? ''),
          ...(optionalBoolean(params, 'createParents') !== undefined ? { createParents: optionalBoolean(params, 'createParents') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs str_replace',
      description:
        'SURGICAL edit: replaces ONE exact occurrence of oldText with newText (literal, never a regex); when oldText occurs several times pass occurrence (1-based)',
      parameters: {
        path: { type: 'string', description: 'file to edit', required: true },
        oldText: { type: 'string', description: 'the EXACT text to replace (must occur exactly once unless occurrence is given)', required: true },
        newText: { type: 'string', description: 'the replacement text (may be empty to delete)', required: true },
        occurrence: { type: 'integer', description: 'which occurrence to replace when oldText occurs several times (1-based)' },
        expectedVersion: { type: 'string', description: 'the version returned by a previous read/info: a mismatch fails with fs.edit-conflict' },
      },
      execute: (params) =>
        fs().edit({
          path: requiredPath(params),
          edits: [
            {
              kind: 'str_replace',
              oldText: String(params.oldText ?? ''),
              newText: String(params.newText ?? ''),
              ...(optionalInteger(params, 'occurrence') !== undefined ? { occurrence: optionalInteger(params, 'occurrence') } : {}),
            },
          ],
          ...(optionalString(params, 'expectedVersion') !== undefined ? { expectedVersion: optionalString(params, 'expectedVersion') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs insert',
      description: 'SURGICAL edit: inserts whole lines BEFORE the 1-based line number (line = totalLines + 1 appends at the end)',
      parameters: {
        path: { type: 'string', description: 'file to edit', required: true },
        line: { type: 'integer', description: '1-based line the inserted block starts at (totalLines + 1 appends)', required: true },
        content: { type: 'string', description: 'the lines to insert (a trailing newline is optional)', required: true },
        expectedVersion: { type: 'string', description: 'the version returned by a previous read/info: a mismatch fails with fs.edit-conflict' },
      },
      execute: (params) =>
        fs().edit({
          path: requiredPath(params),
          edits: [
            {
              kind: 'insert',
              line: optionalInteger(params, 'line') ?? 0,
              content: String(params.content ?? ''),
            },
          ],
          ...(optionalString(params, 'expectedVersion') !== undefined ? { expectedVersion: optionalString(params, 'expectedVersion') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs apply_patch',
      description:
        'ATOMIC batch edit: applies a list of edits (str_replace / insert) in order; when ANY edit fails NOTHING is written. Each edit reports the line it touched; the answer carries the new size',
      parameters: {
        path: { type: 'string', description: 'file to edit', required: true },
        edits: {
          type: 'json',
          description:
            'the ordered edits, e.g. [{"kind":"str_replace","oldText":"a","newText":"b","occurrence":1},{"kind":"insert","line":3,"content":"new line"}]',
          required: true,
        },
        expectedVersion: { type: 'string', description: 'the version returned by a previous read/info: a mismatch fails with fs.edit-conflict' },
      },
      execute: (params) =>
        fs().edit({
          path: requiredPath(params),
          edits: parseFsEdits(params.edits),
          ...(optionalString(params, 'expectedVersion') !== undefined ? { expectedVersion: optionalString(params, 'expectedVersion') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs list',
      description: 'LISTS a directory: one entry per child with its type (file/dir/symlink), size and mtime, capped by limit',
      parameters: {
        path: { type: 'string', description: 'directory to list (default: the fs provider cwd)' },
        limit: { type: 'integer', description: `maximum entries returned (default ${config.listLimit ?? 1000})` },
      },
      execute: (params) =>
        fs().list(optionalString(params, 'path') ?? '.', {
          ...(optionalInteger(params, 'limit') !== undefined ? { limit: optionalInteger(params, 'limit') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs info',
      description: 'METADATA of a path: type, size, mtime, octal mode, permission booleans and the opaque version token a guarded write passes back',
      parameters: {
        path: { type: 'string', description: 'the path to observe', required: true },
      },
      execute: (params) => fs().stat(requiredPath(params)),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs search',
      description:
        'Finds files by NAME: glob search (e.g. "**/*.rs", "*tsconfig*") over the tree, capped; a pattern without "/" matches a basename at any depth',
      parameters: {
        pattern: { type: 'string', description: 'the glob, e.g. **/*.ts or *README*', required: true },
        path: { type: 'string', description: 'the directory to walk (default: the fs provider cwd)' },
        limit: { type: 'integer', description: 'maximum matches returned (default 200)' },
        includeDirs: { type: 'boolean', description: 'also return matching directories (default false)' },
      },
      execute: (params) =>
        fs().glob({
          pattern: requiredPath(params, 'pattern'),
          ...(optionalString(params, 'path') !== undefined ? { path: optionalString(params, 'path') } : {}),
          ...(optionalInteger(params, 'limit') !== undefined ? { limit: optionalInteger(params, 'limit') } : {}),
          ...(optionalBoolean(params, 'includeDirs') !== undefined ? { includeDirs: optionalBoolean(params, 'includeDirs') } : {}),
        }),
      output: { schema: {}, render: renderValue },
    })),

  )

  ctx.effect(() =>
    ctx.tools.register(defineTool({
      name: 'fs grep',
      description:
        'Searches file CONTENTS with a regular expression: returns path:line: text matches, capped inline (maxResults, default 250); when more matches exist the FULL list is written to a spill file and its path is returned, so nothing is lost',
      parameters: {
        pattern: { type: 'string', description: 'the regular expression to search for', required: true },
        path: { type: 'string', description: 'the directory to walk (default: the fs provider cwd)' },
        glob: { type: 'string', description: 'only search files matching this glob, e.g. **/*.ts' },
        maxResults: { type: 'integer', description: 'maximum matches returned inline (default 250); the rest goes to the spill file' },
        maxLineBytes: { type: 'integer', description: 'byte cap on one matched-line preview (default 2000)' },
        ignoreCase: { type: 'boolean', description: 'case-insensitive match' },
      },
      execute: async (params) =>
        grepAnswer(
          await fs().grep({
            pattern: requiredPath(params, 'pattern'),
            ...(optionalString(params, 'path') !== undefined ? { path: optionalString(params, 'path') } : {}),
            ...(optionalString(params, 'glob') !== undefined ? { glob: optionalString(params, 'glob') } : {}),
            ...(optionalInteger(params, 'maxResults') !== undefined ? { maxResults: optionalInteger(params, 'maxResults') } : {}),
            ...(optionalInteger(params, 'maxLineBytes') !== undefined ? { maxLineBytes: optionalInteger(params, 'maxLineBytes') } : {}),
            ...(optionalBoolean(params, 'ignoreCase') !== undefined ? { ignoreCase: optionalBoolean(params, 'ignoreCase') } : {}),
          }),
        ),
      output: { schema: {}, render: renderValue },
    })),

  )
}

export default { name, inject: ['fs', 'tools'], apply }
