# spill-tools

The **consumer** half of the `spill@1` capability seam: the oversized-output
tools. It imports the DEFINITION (`definitions/spill.ts`) only, never a provider.

| Role | Where |
|---|---|
| Definition | `definitions/spill.ts` (the contract, `ctx.spill`) |
| Provider | `core/spill-local` (provider id `local-disk`) |
| Consumer | **this plugin** (the `spill ...` named tools) |
| Other consumers | `core/subprocess-local` (output beyond the inline cap), `core/jobs-local` (log ceiling) |

## Why the seam exists

Every cap in this repository answer the same way: the **inline window** the caller
receives plus a **durable file** holding the FULL payload, which the caller pages
back with a RANGE read. Before this contract each cap invented its own directory
(`plugins/web-page/spill.ts`, `fs-local`'s `spillDir`); now there is ONE place that
owns the location, the size policy and the retention.

## Tools

| Tool | What it does |
|---|---|
| `spill write` | writes a payload once, content-addressed, and returns `{ path, bytes, sha256, preview }` |
| `spill read` | bounded RANGE read (`offset`/`limit`, line-aligned by default) with `nextOffset`, `eof` and the hash of the WHOLE file |
| `spill info` | size, hash, mtime, age, `expired` flag |
| `spill list` | the provider's spill files, newest first |
| `spill purge` | max age and/or max total bytes (`dryRun` supported) |
| `spill policy` | directory, per-payload ceiling, directory ceiling, retention age, preview bytes |

## Retention and configuration

The provider (`core/spill-local`) owns the policy and reports it through
`spill policy`:

| Knob | Default | Meaning |
|---|---|---|
| `dir` | `<tmpdir>/workbench-spill` | where spill files live; every path a call names is confined to it |
| `maxBytes` | 64 MiB | ceiling of ONE payload (`spill.too-large` above it) |
| `maxTotalBytes` | 512 MiB | ceiling of the directory; a purge trims to it, oldest first |
| `maxAgeSeconds` | 7 days | retention age (0 disables the age purge) |
| `previewBytes` | 2048 | bytes copied into the `write` answer as a preview |
| `purgeOnWrite` | true | run the retention policy on every write (best effort) |

Set a deployment-wide location with the provider row:

```yaml
plugins:
  spill-local:
    dir: /opt/workbench/spill      # default: <tmpdir>/workbench-spill
    maxAgeSeconds: 86400
  spill-tools: {}
```

## Paging a spilled payload

```text
spill read { path: "/…/subprocess-stdout-<sha>.txt", offset: 0 }
  -> { offset: 0, nextOffset: 65536, eof: false, … }
spill read { path: "…", offset: 65536 }
  -> { offset: 65536, nextOffset: 131072, … }
```

The `nextOffset` of one answer is the `offset` of the next, so a caller pages
deterministically and can verify what it read against `sha256`.
