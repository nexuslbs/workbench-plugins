# `fs-tools` - the `fs@1` consumer (agent-facing tools)

Exposes the filesystem capability as named tools on the `tools@1` seam
(`POST /api/tools/<name>` or `POST /api/tool/call {"tool","params"}`, and
`workbench tool <name>` from the CLI). It imports `definitions/fs.ts` and calls
`ctx.fs`: it never names a backend, so the deployment decides whether the files
come from `core/fs-local` (today) or from a future remote provider.

## Tools

| tool | params | answer |
|---|---|---|
| `fs read` | `path` (required), `offset?` (1-based first line), `limit?`, `maxLineBytes?` | `{ path, lines: [{n,text}...], startLine, endLine, totalLines, truncated, nextOffset?, eof, note? }` |
| `fs write` | `path`, `content`, `createParents?`, `expectedVersion?` | `{ path, bytes, created, version, lines }` |
| `fs append` | `path`, `content`, `createParents?` | same shape as `fs write` (`created: false`) |
| `fs str_replace` | `path`, `oldText`, `newText`, `occurrence?`, `expectedVersion?` | `{ path, bytes, version, edits: [{kind, line, replacements}] }` |
| `fs insert` | `path`, `line`, `content`, `expectedVersion?` | same shape as `fs str_replace` |
| `fs apply_patch` | `path`, `edits` (the ordered edit array), `expectedVersion?` | same, one report per edit |
| `fs list` | `path?`, `limit?` | `{ path, entries: [{name,path,type,size,mtime}], total, truncated, note? }` |
| `fs info` | `path` | `{ path, type, size, mtime, mode, permissions, isSymlink, version }` |
| `fs search` | `pattern` (the glob), `path?`, `limit?`, `includeDirs?` | `{ pattern, root, matches: [...], total, truncated }` |
| `fs grep` | `pattern` (a regex), `path?`, `glob?`, `maxResults?`, `maxLineBytes?`, `ignoreCase?` | `{ matches: [{path,line,text}...], total, truncated, spill? }` |

## Reads: line-numbered and paged (the documented choice)

`fs read` is LINED (not char-paged, the DSH choice): one entry per line with its
1-based number, so a caller can quote a line, and `offset = nextOffset` resumes
exactly where the previous call stopped. The answer is explicit about the end:

* `truncated: false` + `eof: true` + `note: "end of file (N lines)"` = the whole
  file is in this answer;
* `truncated: true` + `nextOffset` = read the next page with
  `offset = nextOffset`; the note names the window and the total;
* a line longer than `maxLineBytes` is cut (UTF-8 safe) and marked `[truncated]`,
  the cap never enlarges the answer.

`limit` defaults to and never exceeds `2000` lines; a call that would exceed the
provider's `maxReadBytes` fails with `reason: fs.too-large` (a bounded answer or
a typed error, never an unbounded one).

## Edits: exact match, atomic batch

The edit engine is pure (`definitions/fs.ts`) and shared with the provider, so
the rules are testable without touching a disk:

* `str_replace` is LITERAL (never a regex) and must match exactly once unless
  `occurrence` names one; zero matches -> `fs.edit-not-found`, several without
  `occurrence` -> `fs.edit-ambiguous` (the message counts the occurrences);
* `insert` places whole lines BEFORE the 1-based `line` (`totalLines + 1`
  appends); an out-of-range line -> `fs.edit-invalid`;
* `apply_patch` applies its edits IN ORDER to an in-memory copy: when any one of
  them fails, NOTHING is written and the error names the failing index;
* `expectedVersion` (from `fs read`/`fs info`) turns a lost update into
  `fs.edit-conflict` instead of an overwrite.

## Writes: confined, and refusals are typed

Every write tool goes through the provider's root check; a path outside the
configured roots fails with `reason: fs.outside-root` (code `policy`), the same
way for a `..`-escape. No tool retries, falls back, or writes elsewhere.

## Overflow: caps + SPILL

`fs grep` keeps at most `maxResults` (default 250) matches inline. When the walk
found MORE, the FULL list is written to a spill file and the answer carries
`spill: { path, bytes, lines }` - nothing is lost, and the caller can page the
spill file with `fs read`. The walk itself is bounded too (`grep.maxTotal` in the
provider row, default 20000): at that ceiling the answer says so instead of
growing without limit.

`fs search` and `fs list` are capped as well (`limit`, `globLimit`); they report
`truncated` so a caller knows to narrow the pattern rather than believing a short
list is complete.
