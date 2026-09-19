// core/ssh-impl - the `ssh@1` PROVIDER (`ssh-cli`): REMOTE execution.
//
// The command string is handed to the REMOTE shell exactly once, as ONE ssh
// argument:
//
//   ssh [-F <cfg>] [-p <port>] [-i <keyfile>] <user@host> "sh -c '<input>'"
//
// ssh passes that single string to the remote login shell, which parses the
// quoting and runs `sh -c <input>` THERE: pipes, redirections, quotes, globs and
// `$` are evaluated on the remote machine, never on the workbench host. The host
// only ever starts `ssh` with an argv array (`execFile`), so no host shell is
// involved. A command whose target is unreachable fails (`unreachable` when ssh
// exits 255, `spawn-failed` when the ssh binary is missing): it NEVER falls back
// to the host.
//
// The private key is a CREDENTIAL NAME (`privateKeyName`), resolved at call time
// through the credentials capability, written to a private temp file (0600) for
// the duration of the call and removed afterwards. The value never appears in a
// log, a result or an error (the argv is redacted when it is reported).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  SSH,
  SSH_CONTRACT,
  planSsh,
  sshOptionArgv,
  validateSshConfig,
  type NormalizedSshConfig,
  type SshConfig,
  type SshInstance,
  type SshResult,
  type SshRunOptions,
  type SshService,
} from '../../definitions/ssh.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  credentialsOf,
  messageOf,
  provideService,
  redactArgv,
  type CredentialsLike,
  type ServiceContext,
} from '../../definitions/support.ts'
import { runProcess } from '../../lib/process.ts'

export const name = 'ssh-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'ssh-cli'

export const contract = SSH_CONTRACT

/** Resolves a credential NAME to its value (never logged, never returned). */
async function resolveKey(
  credentials: CredentialsLike | undefined,
  name: string | undefined,
): Promise<{ path?: string; cleanup?: () => void }> {
  if (name === undefined) return {}
  if (credentials === undefined || typeof credentials.resolve !== 'function') {
    throw new ServiceError(
      'credential-unsupported',
      `ssh: '${name}' is a credential NAME but this deployment has no credentials capability (ctx.credentials)`,
      { stage: 'ssh.credentials', details: { credential: name } },
    )
  }
  let value: string | undefined
  try {
    const resolution = await credentials.resolve({ name })
    value = resolution?.value
  } catch (error) {
    throw new ServiceError('credential-unsupported', `ssh: cannot resolve credential '${name}': ${messageOf(error)}`, {
      stage: 'ssh.credentials',
      details: { credential: name },
    })
  }
  if (value === undefined || value.length === 0) {
    throw new ServiceError('credential-unsupported', `ssh: credential '${name}' resolved to no value`, {
      stage: 'ssh.credentials',
      details: { credential: name },
    })
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-ssh-'))
  const keyPath = path.join(dir, 'id_key')
  fs.writeFileSync(keyPath, value.endsWith('\n') ? value : `${value}\n`, { mode: 0o600 })
  return {
    path: keyPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    },
  }
}

/** Builds the service of this provider for a validated config. */
export function createSshService(config: SshConfig, credentials?: CredentialsLike): SshService {
  const normalized = validateSshConfig(config)

  const runWith = async (input: string, options: SshRunOptions = {}, bound: NormalizedSshConfig = normalized): Promise<SshResult> => {
    const key = await resolveKey(credentials, bound.privateKeyName)
    try {
      const { argv, display } = planSsh(bound, input, key.path)
      const outcome = await runProcess(argv, {
        timeoutMs: options.timeoutMs ?? bound.timeoutMs,
        maxOutputBytes: options.maxOutputBytes ?? bound.maxOutputBytes,
        stage: 'ssh.run',
        details: { transport: 'ssh', target: bound.target, launcher: redactArgv(argv, [key.path]) },
      })
      void display
      if (outcome.code === 255) {
        throw new ServiceError('unreachable', `ssh: cannot reach '${bound.target}': ${outcome.stderr?.trim() || 'ssh exited 255'}`, {
          stage: 'ssh.run',
          details: { transport: 'ssh', target: bound.target, code: 255 },
        })
      }
      return {
        output: outcome.output,
        code: outcome.code,
        stderr: outcome.stderr,
        durationMs: outcome.durationMs,
        ...(outcome.truncated === true ? { truncated: true } : {}),
      }
    } finally {
      key.cleanup?.()
    }
  }

  const create = (raw: SshConfig): SshInstance => {
    const child = validateSshConfig(raw)
    return {
      contract: SSH_CONTRACT,
      provider: providerId,
      run: (input, options) => runWith(input, options, child),
    }
  }

  return {
    contract: SSH_CONTRACT,
    provider: providerId,
    describe: () => `ssh ${normalized.target}${normalized.port === undefined ? '' : `:${normalized.port}`}`,
    run: runWith,
    create,
  }
}

export function apply(ctx: ServiceContext, config: SshConfig): void {
  assertPolicyDeclared(import.meta.url, { execution: 'remote', capabilities: [SSH] })
  const service = createSshService(config, credentialsOf(ctx))
  provideService(ctx, SSH, service)
}

export { sshOptionArgv }
export default { name, inject: [], apply }
