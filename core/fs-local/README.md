# `fs-local` - the `fs@1` provider `local-fs`

The filesystem capability of the workbench, implemented on the LOCAL filesystem
of the workbench host (`node:fs`), behind the contract
`fs@1` (`definitions/fs.ts`). Service name `ctx.fs`.

`definitions/fs.ts` is the contract: this directory is ONE implementation of it.
The consumer side (`plugins/fs-tools`) imports the DEFINITION, never this module,
so a future `fs-ssh` / `fs-container` provider (see "Follow-ups" below) is a
config edit for the deployment and no change to any tool.

## What it does

Every operation of the contract, with the confinement rule that gives the
capability its safety story:

| operation | reaches the host how | notes |
|---|---|---|
| `stat(path)` | `fs.stat` (`lstat` when `followSymlinks: false`) | type, size, mtime, octal mode, permission booleans, an opaque `version` token |
| `read({path,offset,limit,...})` | `fs.readFile` + the paging math of the definition | LINE-numbered answer, cap, truncation flag, `nextOffset`, `eof`, `note` |
| `write({path,content,...})` | `fs.writeFile` (mkdir -p by default) | **confined to `roots`** |
| `append({path,content})` | `fs.appendFile` | **confined to `roots`**, creates the file |
| `edit({path,edits})` | read + the definition's pure edit engine + write | ATOMIC: all edits, or none |
| `list(path,{limit})` | `fs.readdir(withFileTypes)` + `stat` | entries with type/size/mtime, cap |
| `glob({pattern,path,limit})` | a bounded recursive walk + the definition's glob compiler | `**/*.ts`, `*README*`, ... |
| `grep({pattern,...,maxResults})` | the `node` engine (default) or a spawn of `rg` | `path:line: text`, hard cap, **overflow spilled to disk** |

There is no shell anywhere in this plugin: it is `node:fs` only, so a consumer
gets file access WITHOUT the `shell@1` transport.

## Configuration

```yaml
fs-local:
  cwd: /opt/workspace
  roots: [/opt/workspace, /tmp/workbench-fs]
  followSymlinks: true
  maxReadBytes: 4194304
  maxWriteBytes: 16777216
  listLimit: 1000
  globLimit: 200
  spillDir: /tmp/workbench-fs-spill
  ignore: [.git, node_modules]
  grep:
    engine: node        # or: ripgrep + binary: /usr/bin/rg
    maxResults: 250
```

Defaults: `cwd` = the process cwd, `roots` = `[cwd]`, `followSymlinks` = true,
`maxReadBytes` = 4 MiB, `maxWriteBytes` = 16 MiB, `listLimit` = 1000,
`globLimit` = 200, `spillDir` = `<tmpdir>/workbench-fs-spill`,
`ignore` = `[.git, node_modules]`, `grep.engine` = `node`, `grep.maxResults` = 250.

`grep.engine: ripgrep` without `grep.binary` is a CONFIG ERROR (`invalid-config`):
there is no silent fallback to another engine (a search that answers differently
than configured is worse than one that refuses to start). `engine: node` is the
default because it needs no binary and answers identically on every deployment;
`ripgrep` is for a large tree where spawning `rg` pays off.

## Confinement (the safety rule)

* **Reads are unrestricted**: `read`/`stat`/`list`/`glob`/`grep` answer for any
  path the workbench process itself may read. Reads have no root check, on
  purpose: an agent that can only read inside one directory tree cannot inspect
  the deployment it is asked to diagnose.
* **Writes are confined**: `write`/`append`/`edit` resolve the path (symlinks
  included) and require the RESULT to sit inside one of `roots`. Outside them
  the call fails with `reason: fs.outside-root` (shared code `policy`) - a typed
  error, never a silent success and no `..`-escape:
  `..` segments are resolved BEFORE the check, so `roots: [/srv/app]` plus
  `write /srv/app/../etc/passwd` is refused.
* **`sandbox` narrows, never widens**: when the config carries a
  `sandbox` policy (or a `sandbox@1` service is loaded, see below) the effective
  allowed roots are the INTERSECTION of both and `readOnly` refuses every write.

## Sandbox extension point (no hard dependency)

`definitions/fs.ts` documents the seam: `FsSandboxPolicy` is an optional
`{ writeRoots?, readRoots?, readOnly?, source? }` handle. This provider accepts it

* in its own config (`sandbox:`), and
* from the context when a `sandbox@1` service is loaded
  (`sandboxPolicyFrom(ctx)` reads it structurally; absent = no policy).

It asks for the SERVICE policy on EVERY read and write, never once at apply
time: plugins apply in discovery order, so `fs-local` is always applied BEFORE
any `sandbox-*` provider is provided, and a lookup cached at apply time saw
nothing and silently ignored the provider's deny (thread 2553). Every policy in
force is INTERSECTED, so the seam is exactly as strict as the strictest policy.

The `sandbox` capability lives in separate plugins (`definitions/sandbox.ts`,
`core/sandbox-policy`, `core/sandbox-enforce`). Nothing here imports it, nothing
here requires it, and with no sandbox loaded the behaviour is exactly the
config-only confinement above. A loaded provider either publishes a `sandbox@1`
service (picked up automatically, lazily) or is wired by adding a `sandbox:`
block to this plugin's config.

## Policy declaration

Because this provider reads and writes HOST paths, its manifest declares
`"execution": "host"` and `"policies": { "fs": { "provide": "fs@1", "require": "fs@1" } }`,
and `apply()` calls `assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [FS] })`
(`definitions/support.ts`). Without the declaration the plugin refuses to LOAD -
the same guard `core/shell-impl` uses for host command execution.

## What was reused from the DeepSeek harness (MIT)

The `fs` capability group of `deepseek-ai/deepseek-harness` (MIT, cordis) is the
reference for the CONTRACT shape and the tricky algorithms; the code here is
adapted to the workbench plugin contract (no cordis import, no `@deepseek-ai/*`
package, plain `node:fs`). The reused parts are named in `THIRD_PARTY.md` at the
repository root, next to the MIT notice. In short:

* the paging semantics (`offset`/`limit`/`truncated`/`nextOffset`/end-of-file
  note) and the line-numbered rendering - `packages/fs/fs` + the `read` tool of
  `packages/fs/tool-fs`;
* the edit engine (`str_replace` exact-match / occurrence / ambiguity rules,
  `insert` line semantics, the atomic batch) - `packages/fs/tool-str-replace-editor`;
* the content-search shape: `--json`-style path/line/text records, per-line byte
  caps, the inline match cap and the SPILL of the full list -
  `packages/fs/tool-fs-search` (with `dsh-spill` / `dsh-output-retention`).

## Follow-ups (NOT in this task)

* `fs-ssh` / `fs-container` providers: a remote/container-rooted implementation
  of the SAME contract is a new plugin next to this one plus a roster change. It
  belongs to the transports work, not here.
* An `fs` transport for the `general-service` facade is not needed: the
  capability already reaches a host filesystem directly, and a remote target
  wants the provider above, not a config `type`.
