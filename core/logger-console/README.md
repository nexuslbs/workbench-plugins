# logger-console

The `logger@1` **sink** `console`: it renders every `Message` the logger service
emits as one human-readable line, `error`/`warn` to **stderr**, `info`/`debug` to
**stdout**.

It is one exporter and nothing else. Roster it to get console output; drop the
row and the process prints no log line at all (the plugins keep logging into the
service - with no sink mounted there is simply no output). See
[`docs/LOGGING.md`](../../docs/LOGGING.md).

## Wiring

```yaml
plugins:
  logger-console:
    level: info      # error | warn | info | debug  (default: info)
    names:           # optional per-name overrides
      web-session: debug
    colors: false    # ANSI (default false)
    maxLength: 10240
```

Manifest: `capabilities: [{ id: "logger", version: 1, provider: "console" }]`,
`policies: { logger: { provide: "logger@1" } }`.

Removing the row (or unloading the plugin) disposes the exporter with the
plugin's fiber: no sink, no output, no leftover handle.
