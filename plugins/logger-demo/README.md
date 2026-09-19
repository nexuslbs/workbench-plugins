# logger-demo

The logger service **drive surface**: a consumer plugin that emits Messages so
the sinks can be exercised with raw output. It owns **no stream** - it only calls
the service, which is why it doubles as the proof of the model:

* rostered with no sink -> it logs and **nothing appears**;
* rostered with `logger-console` -> the same Messages appear on stdout/stderr;
* rostered with `logger-jsonl` -> the same Messages land in the file as JSONL.

## Routes

| route | behaviour |
|---|---|
| `GET /api/logger/demo?count=N&name=<logger>&level=<level>&marker=<m>` | emits `N` Messages (all four levels, or just `level`) on `name` and answers what it emitted |
| `GET /api/logger/demo/audit` | what a plugin sees of the service: present, exporter count, buffer size |

At apply time it emits one Message per level (disable with `onLoad: false`).

```sh
curl -s 'http://127.0.0.1:8080/api/logger/demo?count=2&level=debug&marker=gate-c' | jq '.emitted'
```
