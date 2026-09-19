# config-watch

Notices an **EXTERNAL edit of the active workbench config file** and applies it
to the **running** process: no restart, no HTTP lifecycle action. The operator
does `vi /opt/omni/config/workbench.yml` (or `sed -i`), and a few hundred
milliseconds later the plugin roster of the live process has converged.

The watcher only **NOTICES and TRIGGERS**. The operation it triggers is the
host's own `reconcile()` (`ctx.workbench.host().reconcile()`, core
`src/host.ts`), which re-reads the file (`reloadConfig()`), re-resolves the
source auths, re-scans the sources and applies the DESIRED-vs-LIVE delta
(load / unload / reload / park). No diff, no load, no unload logic lives here.

This mirrors the reference implementation (dsh): there the watcher is the HMR
plugin (`packages/boot/hmr/src/index.ts`), not the kernel, and it calls
`reconcileProfilePatches` on a hand edit of the config.

## Wiring

Enabled by its own roster row - the row IS the opt-in:

```yaml
plugins:
  config-watch:
    debounceMs: 300      # coalescing window for filesystem events (default 300)
    minIntervalMs: 1000  # minimum delay between two applies (rate limit)
    # pollMs: 0          # optional polling fallback, off by default
    # readRetries: 4     # retries while an atomic write is in flight
    # recentLimit: 24    # size of the event ring buffer in the state
```

- **Row absent** or `disabled: true`: the plugin is not loaded / is parked and
  the process opens **no filesystem handle** at all.
- The file it watches is the file the host ACTUALLY loaded -
  `--config` / `CONFIG_FILE` / the default search order, resolved through
  `host.configFilePath()`. Never a hard-coded name. An inline config
  (`workbench ... --config '(inline)'`) leaves the watcher **inactive with a
  reason** in its state, and nothing else changes.

## What happens on an edit

| Edit | Result |
| --- | --- |
| valid (`plugins:` row added / removed / changed) | `reconcile()` applies only the delta; the affected plugin is loaded / unloaded / reloaded in the live process |
| invalid YAML / schema / unreadable file | the running configuration is KEPT (the host's `reconcile()` catches, reports and applies nothing), the error lands in `lastError` and the log, and the next VALID write recovers |
| byte-identical rewrite, `touch`, or the rename half of an atomic write | suppressed entirely: zero host calls (`counters.suppressedIdentical`) |
| a write made by the workbench itself (settings patch, `enable`/`disable`, `install`/`uninstall`) | at most ONE apply, and that apply is a no-op (`counters.noopApplies`, `counters.appliesWithChanges`) - see "No self-write loop" |

## Watching the DIRECTORY, not the file

The explicit choice: `fs.watch(dirname(file))`, filtered to the config's
basename. The core writes the config **atomically**
(`writeFileSync('<file>.tmp-<pid>')` + `renameSync(tmp, file)`,
`src/configfile.ts`), and editors / `sed -i` do the same - a watch on the file's
inode would be left pointing at the replaced inode and would go deaf. A
directory watch sees both an in-place write and a replace-over-target.

The temp file's own events (`.tmp-<pid>`) are filtered out, and the read is
retried (`readRetries` x `retryDelayMs`) so the intermediate empty/partial file
of an atomic write is never read as a config.

The watcher is `persistent: false` and `unref()`ed, and every handle is
registered as a cordis effect: unload/shutdown closes them and the process
exits promptly. A watcher that cannot be armed never takes down the web server
or the plugin load - the failure is reported in the state as `lastError`.

## No self-write loop

The workbench writes this same file through its config seam (the Settings page,
`enable`/`disable`, `install`/`uninstall`, `compose`). Three independent layers
make a reconcile storm impossible:

1. **Content equality** (the primitive the dsh settings-file watcher documents:
   "watcher events whose content equals the last read are ignored"): the file is
   hashed (sha256); an event whose content equals the last observed content does
   **zero** host work. That covers a re-write of the same bytes, a `touch`, and
   the `changed` + `rename` pair of one logical write.
2. **Re-entrancy guard + rate limit**: one apply at a time; events arriving
   during an apply are coalesced into exactly one follow-up read;
   `minIntervalMs` defers applies that arrive too soon after the previous one.
3. **By construction**: `reconcile()` never writes the config file - the file is
   its INPUT, so the watcher can never feed itself. A self-write therefore costs
   at most one apply, and that apply reports `changed=0` (the writer already
   applied its own change through the loader).

`GET /api/config-watch/state` exposes the counters that make this observable:
`events`, `coalesced`, `suppressedIdentical`, `applies`, `noopApplies`,
`appliesWithChanges`, `failures`, `readRetries`.

## State surface

`GET /api/config-watch/state` (contract `config-watch@1`):

```json
{
  "contract": "config-watch@1",
  "active": true, "watching": true,
  "file": "/opt/workspace/workbench-plugins/config.yml",
  "watchDir": "/opt/workspace/workbench-plugins",
  "settings": { "debounceMs": 300, "minIntervalMs": 1000, "pollMs": 0, "...": "..." },
  "lastEvent":  { "path": "...", "type": "change", "at": "..." },
  "lastApply":  { "at": "...", "ok": true, "hor": "...", "changed": 1, "unchangedRows": 6, "deferredRows": 0, "errorRows": 0 },
  "lastSuccess": { "at": "...", "changed": 1 },
  "lastError": null,
  "counters": { "events": 3, "applies": 2, "noopApplies": 0, "appliesWithChanges": 1 },
  "recent": [ { "at": "...", "kind": "fs", "detail": "change /opt/.../config.yml" } ]
}
```

- `lastApply` carries the summary of the host's reconcile REPORT (changes,
  loaded/unloaded/reloaded/unchanged/deferred/error rows), never a re-derived
  diff.
- `lastError` is `{ at, kind, message, file, hash }` with
  `kind` in `invalid-config` | `reconcile-error` | `reconcile-failed` |
  `read-failed` | `file-missing` | `watch-failed`; it is cleared by the next
  successful apply.
- `recent` is the event ring buffer (filesystem events, applies, suppressions,
  rate limits, errors) - the timeline the live verification pastes.

`POST /api/config-watch/apply` forces a read + reconcile now (body optional:
`{ "force": false }` re-enables the content-equality suppression) and returns
the same state object plus `triggered: true`.

Routes are registered through `ctx.inject(['web'], ...)`, so a deployment with
no `web@1` provider still gets the WATCH (the watcher is armed in `apply`
regardless) and simply no HTTP surface.

## Tests

`test/config-watch.test.ts` drives the real class against a REAL temporary
config file and the real `fs.watch`, with a fake host whose `reconcile()` is
recorded: debounce/coalescing, atomic rename over the target, content-equality
suppression (zero host calls), rate limiting, the re-entrancy guard, an invalid
file (kept state + `lastError` + recovery on the next valid write), a missing
file, the web seams, and dispose (no event after dispose, no leaked handles).

## Deployment note (single-file bind mounts)

Watch of a DIRECTORY works for a directory bind mount (the dev compose maps
`/opt` in-and-out, production mounts the omni config path). A deployment that
bind-mounts the config as a SINGLE FILE has a kernel-level limitation that no
watcher can fix: when the file is replaced by an atomic rename on the host, the
container keeps seeing the OLD inode. Mount the config DIRECTORY (or restart the
container for that edit) - the state endpoint reports the file that is being
watched, so the shape in use is always visible.
