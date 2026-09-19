// Unit test for the `logger@1` SERVICE contract and the EXPORTER plugins.
//
// What it asserts (the task's minimum list, docs/LOGGING.md):
//   1. level semantics: the threshold a SINK declares filters Messages BEFORE
//      they reach `export()` (default info hides debug, debug shows it);
//   2. the Message shape a sink sees: sn / ts / name / type / level / args;
//   3. mount/unmount: `mountExporter` mounts through the host service, a dispose
//      removes the sink, and a sink mounted inside `ctx.effect` dies with it;
//   4. isolation: a THROWING exporter cannot break the emitter nor the other
//      exporters, its failures are counted and reported EXACTLY ONCE;
//   5. `loggerOf` without a service is SILENT (never console) and never throws;
//   6. the three sinks behave: console (stream split + level filter), jsonl
//      (one VALID JSON object per line, structure not prose), ring (bounded,
//      `logs` service, tail/all/clear);
//   7. the producer (logger-demo) emits NOTHING when no sink is mounted.
//
// Nothing here imports the core or cordis: the host double implements exactly
// the structural contract `definitions/logger.ts` relies on, with cordis'
// measured semantics (per-exporter `levels` filter; a throwing exporter
// propagates out of the emitter - which is WHY the Definition wraps it).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_LEVEL,
  LOG_LEVELS,
  exporterLevels,
  levelName,
  levelThreshold,
  loggerOf,
  messageToJson,
  mountExporter,
  resetReports,
  type LogExporter,
  type LogLevelName,
  type LogMessage,
} from '../definitions/logger.ts'
import { apply as applyConsole } from '../plugins/logger-console/index.ts'
import { apply as applyDemo } from '../plugins/logger-demo/index.ts'
import { apply as applyJsonl } from '../plugins/logger-jsonl/index.ts'
import { apply as applyRing } from '../plugins/logger-ring/index.ts'

// ---------------------------------------------------------------------------
// Test doubles: the host's logger SERVICE + the two stream captures.
// ---------------------------------------------------------------------------

interface TestHost {
  ctx: Record<string, unknown>
  exporters: Map<number, LogExporter>
  provided: Map<string, unknown>
  /** Runs every disposer registered through `ctx.effect` (a plugin unload). */
  disposeAll(): void
  /** Registers a plain collecting sink (bypasses the mount wrapper). */
  collect(): LogMessage[]
}

/** The host double: cordis' `LoggerService` semantics, no cordis import. */
function host(): TestHost {
  const exporters = new Map<number, LogExporter>()
  const disposed: Array<() => void> = []
  const provided = new Map<string, unknown>()
  let sn = 0
  const deliver = (message: LogMessage): void => {
    for (const exporter of [...exporters.values()]) {
      const threshold = exporter.levels?.[message.name] ?? exporter.levels?.default ?? DEFAULT_LEVEL
      if (threshold < message.level) continue
      // No try/catch: cordis PROPAGATES a throwing exporter to the emitter, and
      // the Definition's mount wrapper is what narrows it (test 4).
      exporter.export(message)
    }
  }
  const handle = (name: string | undefined, type: LogLevelName) => (...args: unknown[]): void => {
    sn += 1
    deliver({ sn, ts: Date.now(), name: name ?? 'default', type, level: LOG_LEVELS[type], args })
  }
  /** cordis' `ctx.effect`: the disposer runs when the calling fiber is disposed. */
  const effect = (callback: () => (() => void) | void): { dispose(): void } => {
    const disposer = callback()
    const close = (): void => {
      if (typeof disposer === 'function') disposer()
    }
    disposed.push(close)
    return { dispose: close }
  }
  const service = ((name?: string) => ({
    error: handle(name, 'error'),
    warn: handle(name, 'warn'),
    info: handle(name, 'info'),
    debug: handle(name, 'debug'),
  })) as unknown as Record<string, unknown>
  service.exporter = (exporter: LogExporter): unknown => {
    const id = ++sn
    exporters.set(id, exporter)
    // cordis mounts an exporter INSIDE `ctx.effect` (measured): the sink dies
    // with the plugin fiber, and the returned disposable closes it early.
    effect(() => () => exporters.delete(id))
    return { dispose: () => exporters.delete(id) }
  }
  service.exporters = exporters
  service.buffer = []
  const ctx: Record<string, unknown> = {
    logger: service,
    provide: (name: string, value: unknown) => {
      provided.set(name, value)
      return value
    },
    get: (name: string) => provided.get(name),
    on: () => undefined,
    effect,
  }
  return {
    ctx,
    exporters,
    provided,
    disposeAll: () => {
      for (const close of disposed.splice(0)) close()
    },
    collect: () => {
      const messages: LogMessage[] = []
      // A PROBE sink sees EVERY level: an exporter without a `levels` table is
      // capped at the INFO default, which test 1 already covers.
      exporters.set(10_000, { levels: exporterLevels('debug'), export: (message) => messages.push(message) })
      return messages
    },
  }
}

/** Captures process stdout/stderr (a sink writes there; nothing else may). */
function captureStreams(): { out: string[]; err: string[]; restore(): void } {
  const out: string[] = []
  const err: string[] = []
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => {
    out.push(String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    err.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = stdoutWrite
      process.stderr.write = stderrWrite
    },
  }
}

function tempFile(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-logger-'))
  return path.join(dir, name)
}

// ---------------------------------------------------------------------------
// 1. Level semantics.
// ---------------------------------------------------------------------------

test('levels: the threshold is ERROR 0 .. DEBUG 3 and INFO is the default', () => {
  assert.deepEqual(LOG_LEVELS, { error: 0, warn: 1, info: 2, debug: 3 })
  assert.equal(DEFAULT_LEVEL, 2)
  assert.equal(levelThreshold('error'), 0)
  assert.equal(levelThreshold('debug'), 3)
  // A level name the config schema never mentions is NOT a threshold: the
  // parser is defensive (a roster row is operator input).
  assert.equal(levelThreshold('nonsense' as never), undefined)
  assert.equal(levelThreshold(undefined), undefined)
  assert.equal(levelName(0), 'error')
  assert.equal(levelName(3), 'debug')
  assert.equal(levelName('x'), 'info')
  // `exporterLevels` always yields a table when asked for one, so a sink can
  // mount with a defined threshold even from an empty config.
  assert.deepEqual(exporterLevels('warn'), { default: 1 })
  assert.deepEqual(exporterLevels('info', { 'web-session': 'debug' }), { default: 2, 'web-session': 3 })
  assert.equal(exporterLevels(), undefined)
})

test('levels: a sink filters BEFORE export - info hides debug, debug shows all', () => {
  const info = host()
  const debug = host()
  const infoSeen: LogMessage[] = []
  const debugSeen: LogMessage[] = []
  info.exporters.set(1, { levels: exporterLevels('info'), export: (m) => infoSeen.push(m) })
  debug.exporters.set(1, { levels: exporterLevels('debug'), export: (m) => debugSeen.push(m) })
  const infos = loggerOf(info.ctx, 'consumer')
  const debugs = loggerOf(debug.ctx, 'consumer')
  for (const level of ['error', 'warn', 'info', 'debug'] as LogLevelName[]) {
    infos[level](`${level} message`)
    debugs[level](`${level} message`)
  }
  assert.deepEqual(infoSeen.map((m) => m.type), ['error', 'warn', 'info'])
  assert.deepEqual(debugSeen.map((m) => m.type), ['error', 'warn', 'info', 'debug'])
})

// ---------------------------------------------------------------------------
// 2. Message shape.
// ---------------------------------------------------------------------------

test('message shape: sn/ts/name/type/level/args reach the sink, named per caller', () => {
  const h = host()
  const seen = h.collect()
  loggerOf(h.ctx, 'plugin-a').warn('hello %s', 'world')
  loggerOf(h.ctx, 'plugin-b').error(new Error('boom'))
  assert.equal(seen.length, 2)
  const [first, second] = seen
  assert.equal(first.name, 'plugin-a')
  assert.equal(first.type, 'warn')
  assert.equal(first.level, 1)
  assert.equal(typeof first.sn, 'number')
  assert.equal(typeof first.ts, 'number')
  assert.ok(first.ts >= 1_600_000_000_000)
  assert.deepEqual(first.args, ['hello %s', 'world'])
  assert.equal(second.name, 'plugin-b')
  assert.equal(second.level, 0)
  // The JSONL projection is structure, not prose: fields a consumer can query.
  const json = messageToJson(second)
  assert.equal(json.name, 'plugin-b')
  assert.equal(json.type, 'error')
  assert.equal(json.level, 0)
  assert.equal(json.sn, second.sn)
  assert.equal(json.ts, second.ts)
  const error = (json.args as Array<{ name: string; message: string }>)[0]
  assert.equal(error.name, 'Error')
  assert.equal(error.message, 'boom')
})

// ---------------------------------------------------------------------------
// 3. Mount / unmount.
// ---------------------------------------------------------------------------

test('mount/unmount: mountExporter mounts, dispose removes, the fiber effect removes too', () => {
  const h = host()
  const seen: LogMessage[] = []
  const mounted = mountExporter(h.ctx as never, { levels: exporterLevels('info'), export: (m) => seen.push(m) }, 'test-sink')
  assert.equal(mounted.mounted, true)
  assert.equal(h.exporters.size, 1)
  loggerOf(h.ctx, 'consumer').info('one')
  assert.equal(seen.length, 1)
  mounted.dispose()
  assert.equal(h.exporters.size, 0)
  loggerOf(h.ctx, 'consumer').info('two')
  assert.equal(seen.length, 1, 'a disposed sink receives nothing')

  // A sink mounted INSIDE the plugin's effect dies with the fiber (unload).
  mountExporter(h.ctx as never, { export: (m) => seen.push(m) }, 'fiber-sink')
  assert.equal(h.exporters.size, 1)
  h.disposeAll()
  assert.equal(h.exporters.size, 0)
  loggerOf(h.ctx, 'consumer').info('three')
  assert.equal(seen.length, 1)
})

test('mount/unmount: a host without the service reports NOT mounted and stays silent', () => {
  resetReports()
  const captured = captureStreams()
  try {
    const mounted = mountExporter({} as never, { export: () => {} }, 'orphan')
    assert.equal(mounted.mounted, false)
    assert.equal(mounted.failures(), 0)
    mounted.dispose()
  } finally {
    captured.restore()
  }
  assert.equal(captured.out.length, 0)
  assert.equal(captured.err.length, 1)
  assert.match(captured.err[0], /could not mount/)
})

// ---------------------------------------------------------------------------
// 4. Isolation: a throwing exporter.
// ---------------------------------------------------------------------------

test('isolation: a throwing exporter cannot break the emitter or the other exporters', () => {
  resetReports()
  const h = host()
  const healthy: LogMessage[] = []
  const broken = mountExporter(
    h.ctx as never,
    {
      export: () => {
        throw new Error('sink is broken')
      },
    },
    'broken',
  )
  const good = mountExporter(h.ctx as never, { export: (m) => healthy.push(m) }, 'good')
  const captured = captureStreams()
  try {
    const log = loggerOf(h.ctx, 'consumer')
    log.info('first')
    log.info('second')
    log.info('third')
  } finally {
    captured.restore()
  }
  // The emitter never threw (we are here) and the OTHER sink saw everything.
  assert.equal(healthy.length, 3)
  assert.equal(broken.failures(), 3)
  assert.equal(good.failures(), 0)
  assert.equal(captured.out.length, 0)
  // Reported ONCE, and never with the Message args (which may carry anything).
  assert.equal(captured.err.length, 1)
  assert.match(captured.err[0], /exporter 'broken' threw/)
  assert.match(captured.err[0], /ISOLATED/)
})

test('isolation: loggerOf protects the emitter when the SERVICE itself throws', () => {
  resetReports()
  const h = host()
  const throwing = (() => {
    const method = () => () => {
      throw new Error('service blew up')
    }
    return { error: method(), warn: method(), info: method(), debug: method() }
  }) as unknown
  const ctx = { ...h.ctx, logger: Object.assign(() => throwing, { exporters: new Map() }) }
  const captured = captureStreams()
  try {
    const log = loggerOf(ctx as never, 'consumer')
    log.info('still fine')
  } finally {
    captured.restore()
  }
  assert.equal(captured.err.length, 1)
  assert.match(captured.err[0], /a sink threw while emitting 'consumer\/info'/)
})

test('silence: without a service plugin log calls print NOTHING and never throw', () => {
  const captured = captureStreams()
  try {
    const log = loggerOf({} as never, 'no-service')
    log.error('error')
    log.warn('warn')
    log.info('info')
    log.debug('debug')
  } finally {
    captured.restore()
  }
  assert.deepEqual(captured.out, [])
  assert.deepEqual(captured.err, [])
})

// ---------------------------------------------------------------------------
// 5. The console sink.
// ---------------------------------------------------------------------------

test('logger-console: info/debug -> stdout, error/warn -> stderr, level filter applies', () => {
  const h = host()
  const captured = captureStreams()
  try {
    applyConsole(h.ctx as never, { level: 'info' })
    const log = loggerOf(h.ctx, 'consumer')
    log.debug('hidden debug')
    log.info('visible info')
    log.warn('visible warn')
    log.error('visible error')
  } finally {
    captured.restore()
  }
  const out = captured.out.join('')
  const err = captured.err.join('')
  assert.ok(!out.includes('hidden debug'), 'debug is hidden at level info')
  assert.match(out, /INFO\s+consumer: visible info/)
  assert.ok(!out.includes('visible warn'), 'warn goes to stderr')
  assert.match(err, /WARN\s+consumer: visible warn/)
  assert.match(err, /ERROR\s+consumer: visible error/)
  // Remount at debug: the same calls now reach the sink.
  h.disposeAll()
  const second = captureStreams()
  try {
    applyConsole(h.ctx as never, { level: 'debug' })
    loggerOf(h.ctx, 'consumer').debug('now visible')
  } finally {
    second.restore()
  }
  assert.match(second.out.join(''), /DEBUG\s+consumer: now visible/)
})

// ---------------------------------------------------------------------------
// 6. The JSONL sink.
// ---------------------------------------------------------------------------

test('logger-jsonl: one VALID JSON object per line, then closed by the fiber effect', () => {
  const h = host()
  const file = tempFile('workbench.jsonl')
  applyJsonl(h.ctx as never, { path: file, level: 'debug' })
  const log = loggerOf(h.ctx, 'consumer')
  log.info('plain line')
  log.error(new Error('boom'))
  log.debug({ nested: { ok: true } }, 'with context')
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 3)
  const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  for (const [index, entry] of parsed.entries()) {
    assert.equal(typeof entry.sn, 'number', `line ${index} has sn`)
    assert.equal(typeof entry.ts, 'number', `line ${index} has ts`)
    assert.equal(entry.name, 'consumer')
    assert.equal(typeof entry.type, 'string')
    assert.equal(typeof entry.level, 'number')
    assert.ok(Array.isArray(entry.args))
    assert.equal(JSON.stringify(entry), lines[index], 'the line is compact JSON, one object per line')
  }
  assert.equal(parsed[1].type, 'error')
  assert.deepEqual((parsed[1].args as Array<Record<string, unknown>>)[0], {
    name: 'Error',
    message: 'boom',
    stack: (parsed[1].args as Array<Record<string, unknown>>)[0] &&
      ((parsed[1].args as Array<Record<string, unknown>>)[0] as Record<string, unknown>).stack,
  })
  assert.deepEqual((parsed[2].args as unknown[])[0], { nested: { ok: true } })
  // Unload: the effect closed the fd and removed the sink -> no further line.
  h.disposeAll()
  loggerOf(h.ctx, 'consumer').info('after unload')
  const after = fs.readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(after.length, 3, 'a disposed file sink writes nothing more')
})

// ---------------------------------------------------------------------------
// 7. The ring sink.
// ---------------------------------------------------------------------------

test('logger-ring: bounded history, published as the `logs` service, tail/all/clear', () => {
  const h = host()
  applyRing(h.ctx as never, { size: 2, level: 'info' })
  const reader = h.provided.get('logs') as {
    tail(count?: number): { messages: LogMessage[]; dropped: number; size: number }
    all(): LogMessage[]
    size(): number
    clear(): void
  }
  assert.ok(reader !== undefined, 'the ring publishes the `logs` service')
  const log = loggerOf(h.ctx, 'consumer')
  log.debug('filtered out')
  log.info('one')
  log.info('two')
  log.info('three')
  assert.equal(reader.size(), 2)
  assert.deepEqual(
    reader.all().map((m) => (m.args[0] as string)),
    ['two', 'three'],
  )
  assert.equal(reader.tail(1).messages.length, 1)
  assert.equal(reader.tail().dropped, 1)
  assert.equal(reader.tail(99).messages.length, 2)
  reader.clear()
  assert.equal(reader.size(), 0)
  h.disposeAll()
  loggerOf(h.ctx, 'consumer').info('after unload')
  assert.equal(reader.size(), 0, 'a disposed ring receives nothing more')
})

// ---------------------------------------------------------------------------
// 8. The producer + the model's core rule.
// ---------------------------------------------------------------------------

test('logger-demo: emits one Message per level, and NOTHING without a mounted sink', () => {
  const silent = host()
  const captured = captureStreams()
  try {
    applyDemo(silent.ctx as never)
  } finally {
    captured.restore()
  }
  assert.equal(silent.exporters.size, 0, 'the producer mounts no sink of its own')
  assert.deepEqual(silent.collect(), [], 'nothing was emitted while it ran')
  assert.deepEqual(captured.out, [])
  assert.deepEqual(captured.err, [])

  const h = host()
  const seen = h.collect()
  applyDemo(h.ctx as never)
  assert.deepEqual(
    seen.slice(0, 4).map((m) => m.type),
    ['error', 'warn', 'info', 'debug'],
    'one Message per level at load',
  )
  assert.ok(seen.every((m) => m.name === 'logger-demo'))
  assert.equal(seen.length, 5, 'plus the one "ready" notice the plugin logs')
  assert.match(String(seen[4]?.args[0] ?? ''), /logger-demo ready/)
})
