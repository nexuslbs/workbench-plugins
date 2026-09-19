# `http-impl` - the `http@1` provider `fetch`

The HTTP transport: the input is the request BODY, the answer is the response.
No shell, no argv, no quoting - the safe transport for a caller that must not
reach a command line.

## Contract

`http@1` (`definitions/http.ts`). Service name `ctx.http`.

```ts
call(body: string, options?: { method?, headers?, timeoutMs?, maxBodyBytes? })
  -> { status, body, headers, durationMs, truncated? }
create(config) -> instance bound to its own config
```

## Configuration

| key | default | meaning |
|---|---|---|
| `url` | - | target URL (required) |
| `method` | `POST` | HTTP method |
| `headers` | - | extra request headers |
| `credential` | - | credential NAME sent as `Authorization: Bearer <value>` |
| `timeoutMs` | 30000 | per-call timeout (the request is aborted on expiry) |
| `maxBodyBytes` | 4194304 | response body cap |

## Failure modes

An aborted request is a structured `timeout`; any other network failure is
`unreachable` (the URL is reported, never a credential). A non-2xx status is NOT
an error here: the status is part of the answer (`general-service` turns a
non-2xx status into a structured `non-zero-exit`, keeping the body in the error
details).

## Credentials

`credential` is a NAME, resolved at call time through `ctx.credentials` and sent
as a bearer token. The value never appears in a log, a result or an error. A
deployment without the credentials capability answers `credential-unsupported` at
call time.

## Swapping the provider

Disable this plugin and enable another plugin declaring
`{ "id": "http", "version": 1, "provider": "<other>" }` (e.g. a custom HTTP stack
with retries): a `general-service` config of type `http` resolves to it with no
change to `general-service-impl`.

## Tests

`test/transports.test.ts` starts a local HTTP echo server (`node:http`) and
asserts the method, the body and a binary-safe response through the `http` type.
