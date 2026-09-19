# logger-jsonl

The `logger@1` **sink** `jsonl`: it appends **one JSON object per line** to a
file - the structured `Message` (`sn`, `ts`, `name`, `type`, `level`, `args`),
never a rendered string - with bounded rotation (`<path>.1`, `<path>.2`, ...).

One exporter, one plugin. See [`docs/LOGGING.md`](../../docs/LOGGING.md).

## Wiring

```yaml
plugins:
  logger-jsonl:
    level: debug
    path: /var/lib/workbench/logs/workbench.jsonl
    maxBytes: 10485760
    maxFiles: 3
```

Reading it:

```sh
jq -c 'select(.level <= 1) | {ts, name, type, args}' workbench.jsonl   # only error/warn
```

A line is written with a synchronous append on an open handle; the handle and the
exporter live in ONE `ctx.effect`, so unloading or reloading the plugin closes
the file and removes the sink together (no duplicate sink, no leaked fd).

**Secrets**: the sink serializes the `Message` only - it never writes a plugin's
resolved config, and a caller must log a credential NAME, never its value.
