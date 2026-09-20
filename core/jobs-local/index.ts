// core/jobs-local - the `jobs@1` PROVIDER: background jobs with durable logs.
//
// A job is a child process that OUTLIVES the call that started it. The provider
// owns its lifecycle and its resources:
//
//   * STABLE ID: `job_<12 hex>`, the handle of every other call;
//   * DURABLE LOG: every byte of stdout/stderr is appended to a file under the
//     jobs directory, so the job survives the client that started it (a
//     disconnect, another process reading the same directory);
//   * CURSOR-PAGED READS: `logs({id, cursor})` returns the bytes from `cursor`
//     onward with the NEXT cursor - a poller never re-reads the whole log and
//     never loses a line between two calls (the page math is the pure
//     `readLogWindow` of the definition);
//   * BOUNDED LOG: a job whose log reaches the cap is STOPPED (the process group
//     is killed and the record says `truncated`), so one chatty job cannot fill
//     the disk;
//   * STOP / CLEANUP / UNLOAD: `stop` signals the process GROUP (SIGTERM, then
//     SIGKILL after the grace), `cleanup` removes finished jobs and their logs,
//     and unloading the plugin STOPS every running job and removes its log files
//     through the cordis `effect()` disposer - no orphan process, no leaked file;
//   * NO REQUEST IS HELD: the child is `unref()`ed, so a running job never keeps
//     a request handler (or the event loop) alive; a caller polls `logs` instead.
//
// The command rules are the SAME as `subprocess@1` - the provider reuses
// `planSubprocess` (argv preferred, no shell unless asked, `allowShell` honoured)
// and `resolveEnvRefs` (`${cred:NAME}` / `${env:VAR}`), so the two seams cannot
// drift apart. The OPTIONAL `sandbox@1` handle is consulted before a job starts.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  isTerminalState,
  logFileName,
  normalizeJobsConfig,
  readLogWindow,
  stateOfExit,
  JOBS,
  JOBS_CONTRACT,
  JobsError,
} from '../../definitions/jobs.ts'
import type {
  JobCleanupInput,
  JobCleanupResult,
  JobInfo,
  JobLogPage,
  JobLogsInput,
  JobsConfig,
  JobsPolicy,
  JobsService,
  JobStartInput,
  JobState,
  JobStopInput,
  NormalizedJobsConfig,
} from '../../definitions/jobs.ts'
import {
  classifyEnvRef,
  displayCommand,
  normalizeSubprocessConfig,
  planSubprocess,
  resolveEnvRefs,
  sandboxOf,
  SubprocessError,
} from '../../definitions/subprocess.ts'
import { killProcessGroup, spawnManagedProcess } from '../../lib/process.ts'
import { assertPolicyDeclared, messageOf, provideService } from '../../definitions/support.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'jobs-local'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'local-registry'

export const contract = JOBS_CONTRACT

/** The default jobs directory (a deployment normally overrides it). */
export const DEFAULT_JOBS_DIR = path.join(os.tmpdir(), 'workbench-jobs')

/** Normalises a jobs config (the testable entry point of the provider). */
export function validateJobsConfig(config: JobsConfig = {}, defaultDir = DEFAULT_JOBS_DIR): NormalizedJobsConfig {
  return normalizeJobsConfig(config, defaultDir)
}

/** One job of the registry: the process, its log and its lifecycle state. */
interface JobRecord {
  id: string
  label?: string
  display: string
  argv: string[]
  shell: boolean
  cwd: string
  state: JobState
  pid: number
  startedAtMs: number
  endedAtMs?: number
  exitCode: number | null
  signal: string | null
  logPath: string
  logFd: number
  logBytes: number
  truncated: boolean
  killed: boolean
  /** Resolved when the process is reaped (a `stop` call awaits it). */
  done: Promise<void>
  settle: () => void
  stopTimer?: NodeJS.Timeout
  killTimer?: NodeJS.Timeout
}

/** The jobs service, plus the lifecycle hooks the plugin disposer uses. */
export interface JobsLocalService extends JobsService {
  /** Stops every running job and removes the log files of this registry. */
  dispose(): Promise<void>
}

/** Builds the service of this provider. `ctx` is used for credentials/sandbox only. */
export function createJobsService(config: JobsConfig = {}, ctx: ServiceContext = {}, defaultDir = DEFAULT_JOBS_DIR): JobsLocalService {
  const cfg = validateJobsConfig(config, defaultDir)
  // The command rules are shared with `subprocess@1`: one planner, one policy.
  const planner = normalizeSubprocessConfig({ cwd: cfg.dir, allowShell: cfg.allowShell })
  const registry = new Map<string, JobRecord>()

  const infoOf = (record: JobRecord): JobInfo => {
    const end = record.endedAtMs ?? Date.now()
    return {
      id: record.id,
      ...(record.label === undefined ? {} : { label: record.label }),
      display: record.display,
      argv: record.argv,
      shell: record.shell,
      cwd: record.cwd,
      state: record.state,
      ...(record.pid > 0 ? { pid: record.pid } : {}),
      startedAt: new Date(record.startedAtMs).toISOString(),
      ...(record.endedAtMs === undefined ? {} : { endedAt: new Date(record.endedAtMs).toISOString() }),
      ...(record.endedAtMs === undefined ? {} : { exitCode: record.exitCode, signal: record.signal }),
      durationMs: Math.max(0, end - record.startedAtMs),
      logPath: record.logPath,
      logBytes: record.logBytes,
      truncated: record.truncated,
      note:
        record.state === 'running'
          ? `running (pid ${record.pid}); log: ${record.logPath} (${record.logBytes} bytes)`
          : `${record.state}${record.exitCode === null ? '' : ` (exit ${record.exitCode})`}${record.signal === null ? '' : ` (signal ${record.signal})`} in ${Math.max(0, end - record.startedAtMs)}ms; log: ${record.logPath} (${record.logBytes} bytes)${record.truncated ? ' [truncated at the log cap]' : ''}`,
    }
  }

  const lookup = (id: unknown): JobRecord => {
    if (typeof id !== 'string' || id.length === 0) {
      throw new JobsError('jobs.invalid-input', "a jobs call needs a non-empty string 'id'", { stage: 'jobs.lookup', details: { parameter: 'id' } })
    }
    const record = registry.get(id)
    if (record === undefined) {
      throw new JobsError('jobs.not-found', `no job '${id}' in this registry (${registry.size} job(s) known)`, {
        stage: 'jobs.lookup',
        details: { id },
      })
    }
    return record
  }

  /** Sends a signal to the process GROUP of a job and escalates to SIGKILL. */
  const signal = (record: JobRecord, name: NodeJS.Signals, graceMs: number): void => {
    if (record.pid <= 0 || isTerminalState(record.state)) return
    killProcessGroup(record.pid, name)
    if (name === 'SIGKILL') return
    if (record.killTimer !== undefined) clearTimeout(record.killTimer)
    record.killTimer = setTimeout(() => killProcessGroup(record.pid, 'SIGKILL'), Math.max(0, graceMs))
  }

  const stopRecord = (record: JobRecord, name: NodeJS.Signals = 'SIGTERM', graceMs = cfg.graceMs): void => {
    record.killed = true
    signal(record, name, graceMs)
  }

  /** Appends a chunk to the job log, stopping the job at the byte ceiling. */
  const append = (record: JobRecord, chunk: Buffer): void => {
    if (record.logFd < 0 || isTerminalState(record.state)) return
    const remaining = cfg.maxLogBytes - record.logBytes
    if (remaining <= 0) {
      record.truncated = true
      stopRecord(record)
      return
    }
    const slice = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining)
    try {
      fs.writeSync(record.logFd, slice)
    } catch {
      return
    }
    record.logBytes += slice.byteLength
    if (slice.byteLength < chunk.byteLength) {
      record.truncated = true
      stopRecord(record)
    }
  }

  const closeLog = (record: JobRecord): void => {
    if (record.logFd < 0) return
    try {
      fs.closeSync(record.logFd)
    } catch {
      // The fd is gone: nothing to release.
    }
    record.logFd = -1
  }

  const service: JobsLocalService = {
    async start(input: JobStartInput): Promise<JobInfo> {
      if (registry.size >= cfg.maxJobs) {
        throw new JobsError('jobs.limit', `this provider already keeps ${registry.size} job(s) (maxJobs: ${cfg.maxJobs}); stop or clean one up first`, {
          stage: 'jobs.start',
          details: { maxJobs: cfg.maxJobs, jobs: registry.size },
        })
      }
      // The argv/shell rules of `subprocess@1`, applied to a job command. A
      // planner refusal is re-thrown with the JOB reasons of this seam.
      let plan
      let refEnv: Record<string, string> = {}
      let secrets: string[] = []
      try {
        plan = planSubprocess(input, planner)
        if (Object.keys(plan.envRefs).length > 0) {
          refEnv = await resolveEnvRefs(ctx, plan.envRefs)
          secrets = Object.entries(plan.envRefs)
            .filter(([, raw]) => classifyEnvRef(raw).kind === 'credential')
            .map(([key]) => refEnv[key])
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
        }
      } catch (error) {
        if (error instanceof SubprocessError) {
          const reason =
            error.reason === 'subprocess.shell-disabled'
              ? 'jobs.shell-disabled'
              : error.reason === 'subprocess.reference-unresolved'
                ? 'jobs.reference-unresolved'
                : 'jobs.invalid-input'
          throw new JobsError(reason, error.message, { stage: 'jobs.start', details: { from: error.reason } })
        }
        throw error
      }

      const sandbox = sandboxOf(ctx)
      if (sandbox?.checkCommand !== undefined) {
        const verdict = await sandbox.checkCommand({ argv: plan.argv, shell: plan.shell, cwd: plan.cwd })
        if (verdict !== undefined && verdict.allowed === false) {
          throw new JobsError('jobs.invalid-input', `the sandbox of this deployment refused the job${verdict.reason === undefined ? '' : `: ${verdict.reason}`}`, {
            stage: 'jobs.start',
            details: { sandbox: 'denied' },
          })
        }
      }

      try {
        await fs.promises.mkdir(cfg.dir, { recursive: true })
      } catch (error) {
        throw new JobsError('jobs.io', `cannot create the jobs directory ${cfg.dir}: ${messageOf(error)}`, {
          stage: 'jobs.start',
          details: { dir: cfg.dir },
        })
      }

      const id = `job_${randomBytes(6).toString('hex')}`
      const logPath = path.join(cfg.dir, logFileName(id))
      let logFd = -1
      try {
        logFd = fs.openSync(logPath, 'a')
      } catch (error) {
        throw new JobsError('jobs.io', `cannot open the job log ${logPath}: ${messageOf(error)}`, {
          stage: 'jobs.start',
          details: { path: logPath },
        })
      }

      let settled = false
      let settle: () => void = () => undefined
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      const record: JobRecord = {
        id,
        ...(typeof input.label === 'string' && input.label.length > 0 ? { label: input.label } : {}),
        display: displayCommand(plan.argv, secrets),
        argv: plan.argv,
        shell: plan.shell,
        cwd: plan.cwd,
        state: 'running',
        pid: -1,
        startedAtMs: Date.now(),
        exitCode: null,
        signal: null,
        logPath,
        logFd,
        logBytes: 0,
        truncated: false,
        killed: false,
        done,
        settle: () => {
          if (settled) return
          settled = true
          settle()
        },
      }

      const finish = (code: number | null, name: NodeJS.Signals | null): void => {
        if (record.stopTimer !== undefined) clearTimeout(record.stopTimer)
        if (record.killTimer !== undefined) clearTimeout(record.killTimer)
        record.exitCode = code
        record.signal = name
        record.endedAtMs = Date.now()
        record.state = stateOfExit(code, name, record.killed || record.truncated)
        closeLog(record)
        record.settle()
      }

      let child
      try {
        child = spawnManagedProcess(plan.argv, { cwd: plan.cwd, env: { ...plan.env, ...refEnv }, stage: 'jobs.start' })
      } catch (error) {
        closeLog(record)
        throw new JobsError('jobs.spawn-failed', `cannot start the job command: ${messageOf(error)}`, {
          stage: 'jobs.start',
          details: { command: plan.argv[0] ?? null },
        })
      }
      record.pid = child.pid ?? -1

      child.stdout?.on('data', (chunk: Buffer) => append(record, chunk))
      child.stderr?.on('data', (chunk: Buffer) => append(record, chunk))
      child.on('error', (error) => {
        record.state = 'failed'
        record.endedAtMs = Date.now()
        record.signal = null
        record.exitCode = null
        record.truncated = false
        void error
        if (record.stopTimer !== undefined) clearTimeout(record.stopTimer)
        if (record.killTimer !== undefined) clearTimeout(record.killTimer)
        closeLog(record)
        record.settle()
      })
      child.on('close', (code, name) => finish(code, name))
      // A RUNNING JOB MUST NOT KEEP THE PROCESS (or a request) ALIVE: the child
      // is unreferenced, so only an explicit poll keeps a caller informed.
      child.unref()
      child.stdin?.end()

      if (typeof input.timeoutMs === 'number' && Number.isFinite(input.timeoutMs) && input.timeoutMs > 0) {
        record.stopTimer = setTimeout(() => stopRecord(record), Math.floor(input.timeoutMs))
        record.stopTimer.unref?.()
      }

      registry.set(id, record)
      return infoOf(record)
    },

    async list(): Promise<JobInfo[]> {
      return [...registry.values()].sort((a, b) => b.startedAtMs - a.startedAtMs).map(infoOf)
    },

    async status(id: string): Promise<JobInfo> {
      return infoOf(lookup(id))
    },

    async logs(input: JobLogsInput): Promise<JobLogPage> {
      const record = lookup(input?.id)
      const cursor = input.fromStart === true ? 0 : typeof input.cursor === 'number' ? input.cursor : 0
      const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : cfg.pageBytes
      // LIVE FOLLOW: while the job RUNS and this page has nothing new, wait
      // (bounded) for bytes instead of answering "no lines" and making every
      // caller poll. `waitMs: 0` answers immediately; the hard cap keeps one
      // call short whatever the caller asks for.
      const requested = typeof input.waitMs === 'number' && input.waitMs >= 0 ? Math.floor(input.waitMs) : 1_000
      const deadline = Date.now() + Math.min(requested, 10_000)
      const read = async (): Promise<Buffer> => {
        try {
          return await fs.promises.readFile(record.logPath)
        } catch {
          return Buffer.alloc(0)
        }
      }
      let buffer = await read()
      let window = readLogWindow(buffer, cursor, limit)
      while (window.lines.length === 0 && !isTerminalState(record.state) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        buffer = await read()
        window = readLogWindow(buffer, cursor, limit)
      }
      // `eof` means "up to date and nothing more can arrive": the page reached
      // the end of the log of a job that has FINISHED. A running job is never
      // `eof` (more bytes may follow), so a follower calls again.
      const eof = isTerminalState(record.state) && window.nextCursor >= buffer.length
      return {
        id: record.id,
        state: record.state,
        cursor: window.cursor,
        nextCursor: window.nextCursor,
        bytes: buffer.length,
        returnedBytes: window.returnedBytes,
        lines: window.lines,
        eof,
        note: `${window.lines.length} new line(s), bytes ${window.cursor}-${window.nextCursor} of ${buffer.length}${eof ? ' (up to date)' : ' (more to read)'}`,
      }
    },

    async stop(input: JobStopInput): Promise<JobInfo> {
      const record = lookup(input?.id)
      if (isTerminalState(record.state)) return infoOf(record)
      const name: NodeJS.Signals = input.signal ?? 'SIGTERM'
      const graceMs = typeof input.graceMs === 'number' && input.graceMs >= 0 ? Math.floor(input.graceMs) : cfg.graceMs
      stopRecord(record, name, graceMs)
      // Bounded wait for the reap: the caller learns the TERMINAL state, and a
      // process that ignores every signal cannot hang the call forever.
      await Promise.race([record.done, new Promise<void>((resolve) => setTimeout(resolve, graceMs + 2000).unref?.())])
      return infoOf(record)
    },

    async cleanup(input: JobCleanupInput = {}): Promise<JobCleanupResult> {
      const dryRun = input.dryRun === true
      const all = input.all === true
      const removeLogs = input.removeLogs !== false
      const olderThan = typeof input.olderThanSeconds === 'number' && input.olderThanSeconds > 0 ? Math.floor(input.olderThanSeconds) : 0
      const removed: string[] = []
      const stopped: string[] = []
      const removedLogs: string[] = []
      for (const record of [...registry.values()]) {
        const running = !isTerminalState(record.state)
        if (running && !all) continue
        if (!running && olderThan > 0) {
          const ageSeconds = Math.floor(((record.endedAtMs ?? Date.now()) - record.startedAtMs) / 1000)
          if (ageSeconds < olderThan) continue
        }
        if (running && !dryRun) {
          await service.stop({ id: record.id })
          stopped.push(record.id)
        } else if (running) {
          stopped.push(record.id)
        }
        removed.push(record.id)
        if (dryRun) continue
        registry.delete(record.id)
        if (removeLogs) {
          try {
            await fs.promises.rm(record.logPath, { force: true })
            removedLogs.push(record.logPath)
          } catch {
            // A log that is already gone is not a cleanup failure.
          }
        }
      }
      return {
        removed,
        stopped,
        removedLogs,
        dryRun,
        note: dryRun
          ? `would remove ${removed.length} job(s) (${stopped.length} still running), logs: ${removeLogs ? 'yes' : 'no'}`
          : `removed ${removed.length} job(s) (${stopped.length} stopped first), ${removedLogs.length} log file(s) deleted`,
      }
    },

    policy(): JobsPolicy {
      return {
        dir: cfg.dir,
        maxJobs: cfg.maxJobs,
        maxLogBytes: cfg.maxLogBytes,
        timeoutMs: cfg.timeoutMs,
        graceMs: cfg.graceMs,
        allowShell: cfg.allowShell,
        pageBytes: cfg.pageBytes,
      }
    },

    /**
     * The disposer the plugin registers: every job of this registry is stopped
     * (whole process group) and its log file removed. Called when the plugin is
     * unloaded or its config row is reconciled away.
     */
    async dispose(): Promise<void> {
      for (const record of [...registry.values()]) {
        if (!isTerminalState(record.state)) {
          stopRecord(record, 'SIGTERM', cfg.graceMs)
          await Promise.race([record.done, new Promise<void>((resolve) => setTimeout(resolve, cfg.graceMs + 2000).unref?.())])
          if (!isTerminalState(record.state)) killProcessGroup(record.pid, 'SIGKILL')
        }
        if (record.stopTimer !== undefined) clearTimeout(record.stopTimer)
        if (record.killTimer !== undefined) clearTimeout(record.killTimer)
        closeLog(record)
        try {
          await fs.promises.rm(record.logPath, { force: true })
        } catch {
          // Best effort: the registry is dropped either way.
        }
        registry.delete(record.id)
      }
    },
  }

  return service
}

/**
 * Registers the jobs provider. The manifest gate runs FIRST: a plugin that starts
 * host processes without declaring `"execution": "host"` and the `jobs@1` policy
 * in its own manifest does not load at all. The `effect()` disposer owns the
 * jobs: unloading the plugin (or a reconcile removing its row) stops them.
 */
export function apply(ctx: ServiceContext, config: JobsConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [JOBS] })
  const cfg = validateJobsConfig(config)
  const service = createJobsService(config, ctx)
  provideService(ctx, JOBS, service)
  if (cfg.stopOnUnload) ctx.effect?.(() => () => void service.dispose())
}

export default { name, inject: [], apply }
