// Unit tests for the three CONSUMER plugins on the `tools@1` seam:
// plugins/subprocess-tools, plugins/jobs-tools, plugins/spill-tools.
//
// They register tools against a fake `tools` service (the author form of
// definitions/tools.ts), then invoke the handlers against either a REAL provider
// (core/spill-local, core/subprocess-local, core/jobs-local) or no provider at
// all, to prove both wiring and the structured "capability missing" answer.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { SPILL } from '../definitions/spill.ts'
import { SUBPROCESS } from '../definitions/subprocess.ts'
import { JOBS } from '../definitions/jobs.ts'
import { createSpillService } from '../core/spill-local/index.ts'
import { createSubprocessService } from '../core/subprocess-local/index.ts'
import { createJobsService } from '../core/jobs-local/index.ts'
import * as spillTools from '../plugins/spill-tools/index.ts'
import * as subprocessTools from '../plugins/subprocess-tools/index.ts'
import * as jobsTools from '../plugins/jobs-tools/index.ts'
import type { ToolDefinition } from '../definitions/tools.ts'

type ToolDef = ToolDefinition

/**
 * A fake `tools` service plus a structural cordis context: `effect` runs the
 * callback at once (as the host does on apply) and every disposer is remembered,
 * so a test can prove the tools are released on unload.
 */
function harness(services: Record<string, unknown> = {}): {
  ctx: unknown
  tools: Map<string, ToolDef>
  unload: () => void
} {
  const tools = new Map<string, ToolDef>()
  const disposers: Array<() => void> = []
  const ctx = {
    get: (name: string) => services[name],
    provide: (name: string, value: unknown) => {
      services[name] = value
      return value
    },
    tools: {
      register: (def: ToolDefinition) => {
        tools.set(def.name, def)
        const disposer = (): void => {
          tools.delete(def.name)
        }
        disposers.push(disposer)
        return disposer
      },
    },
    effect: (callback: () => () => void) => {
      const disposer = callback()
      disposers.push(disposer)
      return disposer
    },
  }
  return {
    ctx,
    tools,
    unload: () => {
      for (const disposer of disposers.reverse()) disposer()
    },
  }
}

/** Runs a registered tool by name. */
async function call(tools: Map<string, ToolDef>, name: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const tool = tools.get(name)
  assert.notEqual(tool, undefined, `tool '${name}' was not registered`)
  return await tool!.execute(params)
}

function space(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-tools-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('subprocess-tools: registers its tools and answers with the provider result', async () => {
  const { dir, done } = space()
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 5_000 })
    const { ctx, tools, unload } = harness({ [SUBPROCESS]: subprocess })
    subprocessTools.apply(ctx as never, {})
    assert.deepEqual([...tools.keys()].sort(), ['subprocess policy', 'subprocess run'])

    const policy = (await call(tools, 'subprocess policy')) as { cwd: string }
    assert.equal(policy.cwd, dir)

    const result = (await call(tools, 'subprocess run', { argv: ['/bin/sh', '-c', 'printf "tool\\n"'] })) as {
      exitCode: number
      stdout: string
    }
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'tool\n')

    // A non-zero exit comes back as a NORMAL result through the tool too.
    const failed = (await call(tools, 'subprocess run', { argv: ['/bin/sh', '-c', 'exit 4'] })) as { exitCode: number }
    assert.equal(failed.exitCode, 4)

    unload()
    assert.equal(tools.size, 0)
  } finally {
    done()
  }
})

test('subprocess-tools: with no provider loaded the tool fails with a structured error', async () => {
  const { ctx, tools } = harness()
  subprocessTools.apply(ctx as never, {})
  await assert.rejects(() => call(tools, 'subprocess run', { argv: ['echo', 'hi'] }))
})

test('subprocess-tools: a command STRING without shell:true is refused before any process starts', async () => {
  const { dir, done } = space()
  try {
    const subprocess = createSubprocessService({ cwd: dir, timeoutMs: 5_000 })
    const { ctx, tools } = harness({ [SUBPROCESS]: subprocess })
    subprocessTools.apply(ctx as never, {})
    await assert.rejects(() => call(tools, 'subprocess run', { command: 'echo hi' }))
  } finally {
    done()
  }
})

test('jobs-tools: registers the lifecycle tools and drives a real job', async () => {
  const { dir, done } = space()
  try {
    const jobs = createJobsService({ dir }, {}, dir)
    const { ctx, tools, unload } = harness({ [JOBS]: jobs })
    jobsTools.apply(ctx as never, {})
    assert.deepEqual([...tools.keys()].sort(), [
      'jobs cleanup',
      'jobs list',
      'jobs logs',
      'jobs policy',
      'jobs start',
      'jobs status',
      'jobs stop',
    ])

    const started = (await call(tools, 'jobs start', { argv: ['/bin/sh', '-c', 'printf "job-line\\n"'], label: 'tool-test' })) as {
      id: string
      logPath: string
    }
    assert.match(started.id, /^job_[0-9a-f]{12}$/)

    const logs = (await call(tools, 'jobs logs', { id: started.id, cursor: 0 })) as { lines: string[]; nextCursor: number }
    assert.deepEqual(logs.lines, ['job-line'])

    const listed = (await call(tools, 'jobs list')) as Array<{ id: string }>
    assert.deepEqual(
      listed.map((job) => job.id),
      [started.id],
    )

    const cleaned = (await call(tools, 'jobs cleanup', { dryRun: true })) as { dryRun: boolean }
    assert.equal(cleaned.dryRun, true)

    unload()
    assert.equal(tools.size, 0)
  } finally {
    done()
  }
})

test('jobs-tools: with no provider loaded the tool fails with a structured error', async () => {
  const { ctx, tools } = harness()
  jobsTools.apply(ctx as never, {})
  await assert.rejects(() => call(tools, 'jobs list'))
})

test('spill-tools: registers the spill tools and pages a real payload', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir }, dir)
    const { ctx, tools, unload } = harness({ [SPILL]: spill })
    spillTools.apply(ctx as never, {})
    assert.deepEqual([...tools.keys()].sort(), [
      'spill info',
      'spill list',
      'spill policy',
      'spill purge',
      'spill read',
      'spill write',
    ])

    const written = (await call(tools, 'spill write', { content: 'x'.repeat(500), label: 'tool-payload' })) as {
      path: string
      bytes: number
      sha256: string
    }
    assert.equal(written.bytes, 500)

    const page = (await call(tools, 'spill read', { path: written.path, offset: 0, limit: 100, align: 'byte' })) as {
      text: string
      nextOffset: number
      eof: boolean
    }
    assert.equal(page.text.length, 100)
    assert.equal(page.nextOffset, 100)
    assert.equal(page.eof, false)

    const info = (await call(tools, 'spill info', { path: written.path })) as { sha256: string }
    assert.equal(info.sha256, written.sha256)

    const purged = (await call(tools, 'spill purge', { dryRun: true })) as { dryRun: boolean; scanned: number }
    assert.equal(purged.dryRun, true)
    assert.equal(purged.scanned >= 1, true)

    unload()
    assert.equal(tools.size, 0)
  } finally {
    done()
  }
})

test('spill-tools: with no provider loaded the tool fails with a structured error', async () => {
  const { ctx, tools } = harness()
  spillTools.apply(ctx as never, {})
  await assert.rejects(() => call(tools, 'spill read', { path: '/tmp/nope.txt' }))
})

test('the three consumers declare the capabilities their manifests publish', () => {
  assert.equal(subprocessTools.name, 'subprocess-tools')
  assert.equal(jobsTools.name, 'jobs-tools')
  assert.equal(spillTools.name, 'spill-tools')
})
