// Unit tests for the `jobs@1` seam (definitions/jobs.ts +
// core/jobs-local/index.ts): the job lifecycle, the CURSOR-based log paging, the
// process-group stop, the no-shell default and the cleanup-on-unload rule.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { JOBS_CONTRACT, JobsError, isValidJobId, stateOfExit, readLogWindow } from '../definitions/jobs.ts'
import type { ServiceContext } from '../definitions/support.ts'
import { createJobsService, providerId } from '../core/jobs-local/index.ts'

/** A throwaway directory plus its cleanup. */
function space(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-jobs-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A structural cordis context holding exactly the named services. */
function context(services: Record<string, unknown> = {}): ServiceContext {
  return {
    get: (name: string) => services[name],
    provide: (name: string, value: unknown) => {
      services[name] = value
      return value
    },
  }
}

/** Waits until `predicate` is true (bounded), so a test never sleeps blindly. */
async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return false
}

/** True while a pid is alive (`kill -0`). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('jobs: contract id, id shape and the state machine', () => {
  assert.equal(JOBS_CONTRACT, 'jobs@1')
  assert.equal(isValidJobId('job_0123456789ab'), true)
  assert.equal(isValidJobId('nope'), false)
  assert.equal(isValidJobId(42), false)
  assert.equal(stateOfExit(0, null, false), 'exited')
  assert.equal(stateOfExit(2, null, false), 'failed')
  assert.equal(stateOfExit(null, 'SIGKILL', true), 'killed')
})

test('jobs: readLogWindow pages complete lines from a byte cursor', () => {
  const buffer = Buffer.from('one\ntwo\nthree\n', 'utf8')
  const first = readLogWindow(buffer, 0, 8)
  assert.equal(first.nextCursor, Buffer.byteLength('one\ntwo\n'))
  assert.deepEqual(first.lines, ['one', 'two'])
  const second = readLogWindow(buffer, first.nextCursor, 64)
  assert.deepEqual(second.lines, ['three'])
  assert.equal(second.eof, true)
})

test('jobs-local: start returns a stable id and a durable log file', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    const info = await jobs.start({ argv: ['/bin/sh', '-c', 'printf "a\\n"; sleep 0.4; printf "b\\n"'], label: 'unit' })
    assert.equal(isValidJobId(info.id), true)
    assert.equal(info.state, 'running')
    assert.equal(info.label, 'unit')
    assert.equal(info.logPath.startsWith(dir), true)
    await until(async () => (await jobs.status(info.id)).state !== 'running')
    const final = await jobs.status(info.id)
    assert.equal(final.state, 'exited')
    assert.equal(final.exitCode, 0)
    assert.equal(existsSync(info.logPath), true)
    assert.equal((await jobs.list()).length, 1)
  } finally {
    done()
  }
})

test('jobs-local: a FAILED job reports the exit code as a normal state', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    const info = await jobs.start({ argv: ['/bin/sh', '-c', 'exit 7'] })
    await until(async () => (await jobs.status(info.id)).state !== 'running')
    const final = await jobs.status(info.id)
    assert.equal(final.state, 'failed')
    assert.equal(final.exitCode, 7)
  } finally {
    done()
  }
})

test('jobs-local: logs are CURSOR-paged, the second call returns only NEW lines', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    const info = await jobs.start({ argv: ['/bin/sh', '-c', 'printf "first\\n"; sleep 0.6; printf "second\\n"'] })
    // Wait for the first line to be ON DISK (the file exists as soon as the job
    // starts, so a size check is what makes the first page deterministic).
    await until(() => (existsSync(info.logPath) ? statSync(info.logPath).size > 0 : false))
    const page = await jobs.logs({ id: info.id, cursor: 0 })
    assert.equal(page.id, info.id)
    assert.equal(page.cursor, 0)
    assert.deepEqual(page.lines, ['first'])
    assert.equal(page.eof, false, 'a RUNNING job is never eof: its log still grows')

    // Wait until the second line is on disk, then page from the FIRST cursor:
    // the answer carries ONLY the new lines.
    await until(() => readFileSync(info.logPath, 'utf8').includes('second'))
    const rest = await jobs.logs({ id: info.id, cursor: page.nextCursor })
    assert.equal(rest.cursor, page.nextCursor)
    assert.deepEqual(rest.lines, ['second'])
    assert.equal(rest.nextCursor, rest.bytes, 'the page reached the end of the log')
    // The cursor never moves backwards and a re-read with the LAST cursor is empty.
    const again = await jobs.logs({ id: info.id, cursor: rest.nextCursor, waitMs: 0 })
    assert.deepEqual(again.lines, [])
    assert.equal(again.nextCursor, rest.nextCursor)

    // A FINISHED job whose page reached the end of its log is eof.
    await until(async () => (await jobs.status(info.id)).state !== 'running')
    const final = await jobs.logs({ id: info.id, cursor: rest.nextCursor, waitMs: 0 })
    assert.deepEqual(final.lines, [])
    assert.equal(final.eof, true, 'a finished job at the end of its log is up to date')
  } finally {
    done()
  }
})

test('jobs-local: stop kills the whole process GROUP and reports the terminal state', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    const info = await jobs.start({ argv: ['/bin/sh', '-c', 'sleep 60 & echo $!; sleep 60'], timeoutMs: 0 })
    const pid = info.pid
    assert.equal(typeof pid, 'number')
    const stopped = await jobs.stop({ id: info.id })
    assert.equal(stopped.state, 'killed')
    assert.equal(await until(() => !alive(pid as number)), true)
    // Stopping an already finished job is a normal answer.
    const again = await jobs.stop({ id: info.id })
    assert.equal(again.state, 'killed')
  } finally {
    done()
  }
})

test('jobs-local: a command STRING without shell:true is refused', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    await assert.rejects(
      () => jobs.start({ command: 'echo hi' }),
      (error: unknown) => error instanceof JobsError,
    )
  } finally {
    done()
  }
})

test('jobs-local: an unknown job id is a structured error', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    await assert.rejects(
      () => jobs.status('job_ffffffffffff'),
      (error: unknown) => error instanceof JobsError,
    )
  } finally {
    done()
  }
})

test('jobs-local: cleanup removes finished jobs and their log files', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, context(), dir)
    const info = await jobs.start({ argv: ['/bin/sh', '-c', 'echo done'] })
    await until(async () => (await jobs.status(info.id)).state !== 'running')
    const dry = await jobs.cleanup({ dryRun: true })
    assert.deepEqual(dry.removed, [info.id])
    assert.equal(existsSync(info.logPath), true, 'a dry run must not delete anything')
    const real = await jobs.cleanup()
    assert.deepEqual(real.removed, [info.id])
    assert.equal(existsSync(info.logPath), false)
    assert.deepEqual(await jobs.list(), [])
  } finally {
    done()
  }
})

test('jobs-local: unloading the plugin stops its jobs and cleans the logs', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir, stopOnUnload: true }, context(), dir)
    const info = await jobs.start({ argv: ['/bin/sh', '-c', 'sleep 60'] })
    const pid = info.pid as number
    assert.equal(alive(pid), true)
    await jobs.dispose()
    assert.equal(await until(() => !alive(pid)), true)
    assert.equal(existsSync(info.logPath), false)
    assert.deepEqual(await jobs.list(), [])
  } finally {
    done()
  }
})

test('jobs-local: the provider reports the id its manifest declares', () => {
  assert.equal(providerId, 'local-registry')
})
