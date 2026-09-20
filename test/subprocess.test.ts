// Unit tests for the `subprocess@1` seam (definitions/subprocess.ts +
// core/subprocess-local/index.ts): the argv/no-shell rule, a non-zero exit as a
// NORMAL result, the cap -> SPILL handoff, and the deadline that kills the whole
// process GROUP (no orphan).
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SUBPROCESS_CONTRACT, SubprocessError, classifyEnvRef, planSubprocess, normalizeSubprocessConfig } from '../definitions/subprocess.ts'
import type { ServiceContext } from '../definitions/support.ts'
import { createSpillService } from '../core/spill-local/index.ts'
import { createSubprocessService, providerId } from '../core/subprocess-local/index.ts'

/** A throwaway directory plus its cleanup. */
function space(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-subprocess-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A structural cordis context holding exactly the named services. */
function context(services: Record<string, unknown>): ServiceContext {
  return {
    get: (name: string) => services[name],
    provide: (name: string, value: unknown) => {
      services[name] = value
      return value
    },
  }
}

test('subprocess: contract id and the argv/no-shell plan', () => {
  assert.equal(SUBPROCESS_CONTRACT, 'subprocess@1')
  const config = normalizeSubprocessConfig({ cwd: '/tmp', timeoutMs: 1000, maxOutputBytes: 128 })
  const plan = planSubprocess({ argv: ['git', 'status', '--short'] }, config)
  assert.deepEqual(plan.argv, ['git', 'status', '--short'])
  assert.equal(plan.shell, false)
})

test('subprocess: a command STRING without shell:true is refused', () => {
  const config = normalizeSubprocessConfig({ cwd: '/tmp' })
  assert.throws(
    () => planSubprocess({ command: 'echo hi' }, config),
    (error: unknown) => error instanceof SubprocessError,
  )
})

test('subprocess: classifyEnvRef recognises credential/environment references', () => {
  assert.deepEqual(classifyEnvRef('${cred:MY_TOKEN}'), { kind: 'credential', name: 'MY_TOKEN' })
  assert.deepEqual(classifyEnvRef('${env:HOME}'), { kind: 'environment', name: 'HOME' })
  assert.deepEqual(classifyEnvRef('literal'), { kind: 'literal' })
})

test('subprocess-local: a successful argv run answers exit code + stdout', async () => {
  const { dir, done } = space()
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 5_000 })
    const result = await subprocess.run({ argv: ['/bin/sh', '-c', 'printf "hello\\n"'] })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'hello\n')
    assert.equal(result.timedOut, false)
    assert.equal(result.truncated, false)
    assert.equal(result.spill, undefined)
    assert.equal(typeof result.durationMs, 'number')
  } finally {
    done()
  }
})

test('subprocess-local: a NON-ZERO exit is a normal result, not an exception', async () => {
  const { dir, done } = space()
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 5_000 })
    const result = await subprocess.run({ argv: ['/bin/sh', '-c', 'echo out; echo err >&2; exit 3'] })
    assert.equal(result.exitCode, 3)
    assert.equal(result.stdout.trim(), 'out')
    assert.equal(result.stderr.trim(), 'err')
  } finally {
    done()
  }
})

test('subprocess-local: stdin is written to the child and closed', async () => {
  const { dir, done } = space()
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 5_000 })
    const result = await subprocess.run({ argv: ['/bin/sh', '-c', 'cat'], stdin: 'piped-through' })
    assert.equal(result.stdout, 'piped-through')
  } finally {
    done()
  }
})

test('subprocess-local: output beyond the cap is SPILLED, not silently truncated', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir: path.join(dir, 'spill') }, dir)
    const ctx = context({ spill })
    const subprocess = createSubprocessService(
      { cwd: dir, timeoutMs: 5_000, maxOutputBytes: 64, overflowBytes: 65_536, spillLabel: 'subprocess-stdout' },
      ctx,
    )
    const result = await subprocess.run({ argv: ['/bin/sh', '-c', 'seq 1 500'] })
    assert.equal(result.exitCode, 0)
    assert.equal(result.truncated, true)
    assert.equal(result.stdoutBytes > 64, true)
    assert.notEqual(result.spill, undefined)
    assert.equal(result.note.includes('spill'), true)

    const spilled = await spill.read({ path: result.spill!.path, offset: 0, limit: 65536 })
    assert.equal(spilled.text.includes('# subprocess output spill'), true)
    // The spill carries the FULL output of the command: the stdout SECTION of
    // the file holds every line, so nothing beyond the inline cap was lost.
    const start = spilled.text.indexOf('===== stdout =====')
    const end = spilled.text.indexOf('===== stderr =====')
    const stdoutSection = spilled.text.slice(start, end).replace('===== stdout =====', '')
    assert.equal(stdoutSection.split('\n').filter((line) => line.length > 0).length, 500)
  } finally {
    done()
  }
})

test('subprocess-local: the deadline kills the whole process GROUP (no orphan)', async () => {
  const { dir, done } = space()
  const marker = path.join(dir, 'child.pid')
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 400, graceMs: 200 })
    // The shell starts a LONG child in the background, records its pid, then waits:
    // only a PROCESS-GROUP kill reaches the grandchild.
    const result = await subprocess.run({
      argv: ['/bin/sh', '-c', `sleep 120 & echo $! > ${marker}; wait`],
      timeoutMs: 400,
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.killed, true)
    assert.equal(result.exitCode, null)

    const childPid = Number.parseInt(readFileSync(marker, 'utf8').trim(), 10)
    assert.equal(Number.isInteger(childPid), true)
    // The grandchild must be DEAD. `kill -0` is NOT the test: a process killed
    // while its own parent (the `sh`) died with it is reparented and lingers as
    // a ZOMBIE (`Z`) until the container's PID 1 reaps it, and a zombie still
    // answers `kill -0`. The state field of /proc/<pid>/stat is the honest
    // check: `gone`, or `Z` (dead, only its exit status is not reaped yet).
    const procState = (pid: number): string => {
      try {
        // field 3 of /proc/<pid>/stat, after the `(comm)` field
        return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.split(' ')[0] ?? 'gone'
      } catch {
        return 'gone'
      }
    }
    let state = procState(childPid)
    for (let attempt = 0; attempt < 20 && state !== 'gone' && state !== 'Z'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      state = procState(childPid)
    }
    assert.ok(
      state === 'gone' || state === 'Z',
      `the grandchild ${childPid} is still RUNNING after the process-group kill (proc state '${state}')`,
    )
  } finally {
    done()
  }
})

test('subprocess-local: shell:true is an explicit escape hatch and a disabled shell is a structured error', async () => {
  const { dir, done } = space()
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 5_000 })
    const viaShell = await subprocess.run({ command: 'echo $((2 + 3))', shell: true })
    assert.equal(viaShell.shell, true)
    assert.equal(viaShell.stdout.trim(), '5')
    assert.deepEqual(viaShell.argv.slice(0, 2), ['/bin/sh', '-c'])

    const noShell = createSubprocessService({ cwd: dir, allowShell: false, timeoutMs: 5_000 })
    await assert.rejects(
      () => noShell.run({ command: 'echo hi', shell: true }),
      (error: unknown) => error instanceof SubprocessError && error.reason === 'subprocess.shell-disabled',
    )
  } finally {
    done()
  }
})

test('subprocess-local: the provider reports the id its manifest declares', () => {
  assert.equal(providerId, 'local-process')
})
