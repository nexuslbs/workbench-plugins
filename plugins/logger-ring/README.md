# logger-ring

The `logger@1` **sink** `ring`: a bounded in-memory history of the last `size`
`Message`s, published as the `logs` service and (when the `web@1` seam is
present) readable over HTTP:

| route | meaning |
|---|---|
| `GET <path>?count=N` | `{ size, dropped, messages }` (last `N`) |
| `GET <path>/tail?count=N` | the last `N` Messages, oldest first |
| `POST <path>/clear` | drop the history |

`path` defaults to `/api/logs`. With no web provider loaded the history is still
kept - only the read routes are conditional, so the ring never depends on the web
plugin being rostered.

```yaml
plugins:
  logger-ring:
    level: debug
    size: 500
    path: /api/logs
```

A plugin reads the history through the seam instead of the routes:

```ts
const logs = serviceOf<LogsReader>(ctx, 'logs')   // definitions/logger.ts
logs?.tail(50)                                     // { messages, dropped, size }
```

One exporter, one plugin: unloading it drops the history and the routes together
(both live in `ctx.effect`).
