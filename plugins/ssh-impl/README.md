# `ssh-impl` - the `ssh@1` provider `ssh-cli`

REMOTE execution: the command string runs on the remote machine ONLY.

## Contract

`ssh@1` (`definitions/ssh.ts`). Service name `ctx.ssh`.

```ts
run(input: string, options?: { timeoutMs?, maxOutputBytes? })
  -> { output, code, stderr?, durationMs, truncated? }
create(config) -> instance bound to its own config
```

## Configuration

| key | default | meaning |
|---|---|---|
| `host` | - | `host`, `user@host` or `user@host:port` (required) |
| `privateKeyName` | - | credential NAME whose value is the private key |
| `configFilePath` | - | ssh config file (`-F`), for aliases/options |
| `binary` | `ssh` | ssh executable on PATH |
| `timeoutMs` | 30000 | per-call timeout (SIGKILL on expiry) |
| `maxOutputBytes` | 4194304 | output cap |
| `options` | - | extra ssh options, verbatim argv entries |

## The launcher (shell-safety)

`planSsh(config, input, keyPath)` (pure, exported by the Definition) builds

```
ssh [-F <cfg>] [-p <port>] [-i <keyPath>] [-o ...] <user@host> "sh -c '<input>'"
```

The last element is ONE argument: ssh hands it to the remote login shell, which
parses the quoting and runs `sh -c <input>` on the REMOTE machine. The workbench
host only starts `ssh` through `execFile` (argv array): no host shell, no host
splitting/globbing/expansion of the input.

ssh exit 255 means "cannot reach the target": the call fails with `unreachable`.
It NEVER falls back to a local command.

## Credentials

`privateKeyName` is a NAME. It is resolved at call time through
`ctx.credentials`, written to a `0600` temp file for the duration of the call and
removed afterwards; the argv reported in errors/logs is redacted
(`redactArgv`). A deployment without the credentials capability answers
`credential-unsupported` at call time (never a load failure).

## Swapping the provider

Disable this plugin and enable another plugin declaring
`{ "id": "ssh", "version": 1, "provider": "<other>" }` (e.g. a native JS SSH
client): a `general-service` config of type `ssh` resolves to it with no change
to `general-service-impl`.

## Tests

`test/transports.test.ts` asserts the launcher argv per type and exercises the
`ssh` + `ssh+container` types against the operator's reachable host (or reports
them explicitly BLOCKED when no host is reachable).
