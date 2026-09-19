// lib/process.ts - the ONE process runner every transport provider uses.
//
// It exists so the shell-safety invariant is implemented ONCE: `execFile` takes
// an ARGV ARRAY, so the OS starts the launcher directly - there is no host
// shell, no word splitting, no globbing and no expansion of the caller's string
// on the workbench host. The only place a caller-supplied string is evaluated is
// the TARGET shell, which the transport argv names explicitly
// (`sh -c <input>` inside the container / on the remote machine).
//
// Bounds: every call carries a timeout (the process is KILLED on expiry, with
// SIGKILL) and an output cap; the result carries `truncated` when the cap cut it.
// A spawn failure and a timeout are STRUCTURED errors (`ServiceError`); a
// completed process is RETURNED with its exit code whatever that code is, so a
// caller can inspect stdout/stderr (the general service turns a non-zero code
// into the structured `non-zero-exit` error, details included).
import { execFile } from 'node:child_process'
import { ServiceError, capText, type CommandResult } from '../definitions/support.ts'

export interface RunProcessOptions {
  /** Per-call timeout in ms; the process is killed on expiry. */
  timeoutMs: number
  /** Output cap in bytes (applied to stdout and stderr separately). */
  maxOutputBytes: number
  cwd?: string
  /** Extra environment for the child (never logged). */
  env?: Record<string, string>
  /** Stage label used in structured errors, e.g. `shell.run`. */
  stage: string
  /** Structured details attached to errors (never a credential value). */
  details?: Record<string, unknown>
}

/** The stdout/stderr of a finished process plus its exit information. */
export interface ProcessOutcome extends CommandResult {
  /** True when the process was killed after its timeout. */
  timedOut: boolean
}

/**
 * Runs `argv` without a host shell and returns its outcome. Throws
 * `spawn-failed` when the launcher cannot be started (missing binary) and
 * `timeout` when it outlived its bound; a non-zero exit code is RETURNED.
 */
export function runProcess(argv: readonly string[], options: RunProcessOptions): Promise<ProcessOutcome> {
  const [command, ...args] = argv
  if (command === undefined || command.length === 0) {
    return Promise.reject(new ServiceError('spawn-failed', 'the launcher argv is empty', { stage: options.stage }))
  }
  const started = Date.now()
  return new Promise<ProcessOutcome>((resolve, reject) => {
    let timedOut = false
    const child = execFile(
      command,
      args as string[],
      {
        cwd: options.cwd,
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
        encoding: 'utf8',
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
        // The real cap is applied below; this only stops the child from filling
        // the pipe buffers of a runaway command.
        maxBuffer: Math.max(options.maxOutputBytes * 2, 1024 * 1024),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started
        const raw = error as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null
        if (raw !== null && raw.killed === true && raw.signal === 'SIGKILL') timedOut = true
        const out = capText(String(stdout ?? ''), options.maxOutputBytes)
        const err = capText(String(stderr ?? ''), options.maxOutputBytes)
        const truncated = out.truncated || err.truncated || raw?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
        const exitCode = timedOut ? null : typeof raw?.code === 'number' ? raw.code : raw === null ? 0 : 1

        if (timedOut) {
          reject(
            new ServiceError('timeout', `the command exceeded its ${options.timeoutMs}ms timeout and was killed`, {
              stage: options.stage,
              details: { command, timeoutMs: options.timeoutMs, output: out.text, stderr: err.text, ...options.details },
            }),
          )
          return
        }
        if (raw !== null && (raw.code === 'ENOENT' || raw.code === 'EACCES' || raw.code === 'ENOTDIR')) {
          reject(
            new ServiceError('spawn-failed', `cannot start '${command}': ${raw.message}`, {
              stage: options.stage,
              details: { command, code: String(raw.code), ...options.details },
            }),
          )
          return
        }
        if (raw !== null && raw.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            output: out.text,
            code: exitCode,
            stderr: err.text,
            durationMs,
            truncated: true,
            timedOut: false,
          })
          return
        }
        resolve({
          output: out.text,
          code: exitCode,
          stderr: err.text,
          durationMs,
          ...(truncated ? { truncated: true } : {}),
          timedOut: false,
        })
      },
    )
    child.on('error', (error) => {
      reject(
        new ServiceError('spawn-failed', `cannot start '${command}': ${error.message}`, {
          stage: options.stage,
          details: { command, ...options.details },
        }),
      )
    })
  })
}
