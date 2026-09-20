# Third-party code reused in this repository

This repository is MIT-licensed (see `LICENSE`). Parts of it are ADAPTED from
other MIT-licensed projects; the notice below is kept next to the code it
covers, as the MIT license requires.

## DeepSeek Harness (`deepseek-ai/deepseek-harness`)

MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### What was reused, and where it lives here

The harness runs on cordis, like the workbench core, so its packages are the
reference for the CONTRACT shape and for the algorithms that are easy to get
wrong. The code below was ADAPTED to the workbench plugin contract: no cordis
import, no `@deepseek-ai/*` dependency, plain `node:fs` / `node:child_process`,
and the workbench error/service conventions (`definitions/support.ts`).

| harness source (packages/...) | adapted into | what was taken |
| --- | --- | --- |
| `fs/fs` (`types.ts`, `index.ts`) | `definitions/fs.ts`, `core/fs-local/index.ts` | the capability surface (stat / read / write / edit / list / search / grep), the paging semantics (`offset`, `limit`, `truncated`, `nextOffset`, end-of-file note), the per-line and per-call byte caps, the version-token idea behind `expectedVersion` |
| `fs/tool-fs` (`read`, `write`, `edit`, `view` tools) | `definitions/fs.ts` (`paginateLines`, `renderNumberedLines`), `plugins/fs-tools` | the LINE-numbered read answer, the parameters of the read/write tools, the `str_replace` / `insert` edit shapes |
| `fs/tool-str-replace-editor` | `definitions/fs.ts` (`applyStrReplace`, `applyInsert`, `applyFsEdits`) | the exact-match / `occurrence` / ambiguity rules and the atomic batch (all edits, or none) |
| `fs/tool-fs-search` (`search-core`, `grep`, `glob`) | `definitions/fs.ts` (`globToRegExp`, `globMatches`, `buildRipgrepArgv`, `parseRipgrepJson`, `formatGrepMatches`) | the `path:line: text` result shape, the `--json` record parsing, the per-line preview byte cap, the inline match cap, the name-glob search, the glob-then-regex two-step |
| `tools/output-retention`, `output-spill` | `core/fs-local/index.ts` (the `grep` overflow) | the cap-then-SPILL behaviour: the full list is written to a file and its path returned, so a capped answer never loses matches |
| `fs/fs-sandbox`, `fs/fs-observation-policy` | `definitions/fs.ts` (`FsSandboxPolicy`, `sandboxPolicyFrom`) | the extension point: an optional policy handle that NARROWS what a provider may touch (no hard dependency here) |
| `subprocess/*` (`types.ts`, `index.ts`), `subprocess-local` | `definitions/subprocess.ts`, `core/subprocess-local/index.ts` | the command shape (an argv ARRAY run WITHOUT a host shell, plus the explicit `shell: true` escape hatch), the deadline that kills the whole process GROUP (SIGTERM, then SIGKILL after a grace), the inline output cap whose overflow is handed to `spill`, the streaming chunk callback for live output, the "a non-zero exit is a normal result" rule |
| `jobs/*` (`types.ts`, `index.ts`) | `definitions/jobs.ts`, `core/jobs-local/index.ts` | the background-job registry (stable id, the `running`/`exited`/`failed`/`killed` state machine), the durable log file, the CURSOR-based log paging (`cursor` in, `nextCursor` out), the log ceiling, the `stop` (process group) / `cleanup` lifecycle and the unload disposer |
| `spill/*` (`types.ts`, `index.ts`), `tools/output-spill` | `definitions/spill.ts`, `core/spill-local/index.ts` | the oversized-payload file (`path`, `bytes`, `sha256`, `preview`), the RANGE read (`offset`/`limit` -> `nextOffset`/`eof`), the line-aligned default window, the retention policy (max age, max total bytes, explicit purge) |

No file of the harness was copied verbatim; the modules above are re-expressed
in this repository's own plugin/definition layout, and every one of them has a
workbench-side test (`test/fs.test.ts`, `test/fs-local.test.ts`,
`test/subprocess.test.ts`, `test/jobs.test.ts`, `test/spill.test.ts`,
`test/process-tools.test.ts`).
