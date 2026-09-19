// Unit tests for the config-watch plugin: an EXTERNAL edit of the active config
// file must trigger the HOST's reconcile (and nothing else), with debounce,
// atomic-rename handling, content-equality suppression, a re-entrancy guard, an
// error state that recovers, and a dispose that releases every handle.
//
// The watcher is driven against a REAL temporary config file and the REAL
// `fs.watch`; only the host surface is faked (the fake `reconcile()` reads the
// file, so an "invalid" edit is a file whose text the fake rejects - exactly the
// shape the core produces: ok:false + message, nothing applied).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { API_BASE, ConfigWatcher, apply, default as plugin, name as pluginName, resolveSettings } from '../plugins/config-watch/index.ts'

const VALID = 'plugins:\n  hello-world: {}\n'
const VALID_TWO = 'plugins:\n  hello-world: {}\n  hello-otherworld: {}\n'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits until `predicate` holds (or the timeout expires). */
async function waitFor(predicate: () => boolean, timeoutMs = 4000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(stepMs)
  }
}

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-watch-'))
  return path.join(dir, 'workbench.config.yml')
}

interface FakeHostOptions {
  /** The content prefix the fake accepts; anything else is an "invalid config". */
  accept?: string
  /** Artificial reconcile duration (drives the re-entrancy guard). */
  delayMs?: number
  /** Make every reconcile throw (the impossible case: the host itself broke). */
  throwMessage?: string
}

function makeHarness(file: string | undefined, options: FakeHostOptions = {}) {
  const accept = options.accept ?? 'plugins:'
  const calls: number[] = []
  const logs: string[] = []
  const routes: { method: string; path: string; handler: (request: unknown) => unknown }[] = []
  const disposers: (() => void)[] = []

  const host = {
    configFilePath: (): string | undefined => file,
    reconcile: async () => {
      calls.push(Date.now())
      if (options.delayMs !== undefined) await sleep(options.delayMs)
      if (options.throwMessage !== undefined) throw new Error(options.throwMessage)
      if (file === undefined) {
        return { ok: true, action: 'reconcile', target: '(inline)', message: 'inline', changes: [], deferred: [], errors: [], loaded: 0 }
      }
      const text = fs.readFileSync(file, 'utf8')
      if (!text.includes(accept)) {
        return {
          ok: false,
          action: 'reconcile',
          target: file,
          message: `reconcile failed: ${file}: invalid YAML (${accept} not found)`,
          changes: [],
          deferred: [],
          errors: [],
          loaded: 0,
        }
      }
      return {
        ok: true,
        action: 'reconcile',
        target: file,
        message: 'reconciled',
        changes: [{ name: 'hello-world', desired: true, loaded: false, action: 'load', reason: 'roster row added' }],
        deferred: [],
        errors: [],
        loaded: 1,
      }
    },
  }

  const ctx = {
    workbench: { host: () => host, log: (message: string) => logs.push(message) },
    effect: (callback: () => void | (() => void)): void => {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    web: {
      route: (spec: { method: string; path: string; handler: (request: unknown) => unknown }): (() => void) => {
        routes.push(spec)
        return () => {
          const index = routes.indexOf(spec)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }

  const settings = resolveSettings({ debounceMs: 25, minIntervalMs: 0, retryDelayMs: 5, readRetries: 2 })
  const watcher = new ConfigWatcher(ctx as unknown as never, settings)
  const dispose = watcher.start()
  return { watcher, ctx, host, calls, logs, routes, disposers, dispose }
}

test('resolveSettings applies the documented defaults', () => {
  const settings = resolveSettings()
  assert.equal(settings.debounceMs, 300)
  assert.equal(settings.minIntervalMs, 1000)
  assert.equal(settings.pollMs, 0)
  assert.equal(settings.readRetries, 4)
  assert.equal(settings.file, undefined)
  assert.equal(resolveSettings({ debounceMs: 0, file: '/tmp/x.yml' }).debounceMs, 0)
  assert.equal(resolveSettings({ debounceMs: -5 }).debounceMs, 300, 'a negative value falls back to the default')
})

test('debounce: a burst of edits triggers exactly ONE host reconcile', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file, { delayMs: 0 })
  try {
    fs.writeFileSync(file, VALID)
    for (const text of [VALID, `${VALID}# one\n`, `${VALID}# two\n`, `${VALID}# three\n`]) {
      fs.writeFileSync(file, text)
      await sleep(5)
    }
    await waitFor(() => h.calls.length >= 1)
    await sleep(150)
    assert.equal(h.calls.length, 1, `a burst must coalesce into one reconcile (saw ${h.calls.length})`)
    assert.ok(h.watcher.state().counters as Record<string, number>, 'state exposes counters')
    const counters = h.watcher.state().counters as Record<string, number>
    assert.ok((counters.coalesced ?? 0) >= 1, 'the coalesced events are counted')
  } finally {
    h.dispose()
  }
})

test('atomic rename (write temp + rename over the target) is observed', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  try {
    const tmp = `${file}.tmp-1234`
    fs.writeFileSync(tmp, VALID_TWO)
    fs.renameSync(tmp, file)
    await waitFor(() => h.calls.length >= 1)
    assert.equal(h.calls.length, 1, 'the replace-over-target must trigger exactly one reconcile')
    const lastApply = h.watcher.state().lastApply as Record<string, unknown>
    assert.equal(lastApply.ok, true)
    assert.equal(lastApply.changed, 1)
  } finally {
    h.dispose()
  }
})

test('an in-place write is observed too (no atomic rename involved)', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  try {
    fs.appendFileSync(file, '# in place\n')
    await waitFor(() => h.calls.length >= 1)
    assert.equal(h.calls.length, 1)
  } finally {
    h.dispose()
  }
})

test('identical content is suppressed: zero host calls, counted', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  try {
    fs.writeFileSync(file, VALID_TWO)
    await waitFor(() => h.calls.length === 1)
    const callsAfterFirst = h.calls.length
    // The same bytes again (what a self-write that changed nothing looks like,
    // and what a `touch` + editor save pair produces).
    fs.writeFileSync(file, VALID_TWO)
    await sleep(250)
    assert.equal(h.calls.length, callsAfterFirst, 'identical content must not reach the host')
    const counters = h.watcher.state().counters as Record<string, number>
    assert.ok((counters.suppressedIdentical ?? 0) >= 1, `suppression is counted (${JSON.stringify(counters)})`)
    const lastSuppressed = h.watcher.state().lastSuppressed as Record<string, unknown>
    assert.equal(typeof lastSuppressed.hash, 'string', 'the suppressed event records the content hash')
    assert.ok(String(lastSuppressed.reason).length > 0, 'the suppressed event records why it fired')
  } finally {
    h.dispose()
  }
})

test('rate limit defers a second apply until minIntervalMs has elapsed', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const accept = 'plugins:'
  const calls: number[] = []
  const ctx = {
    workbench: {
      host: () => ({
        configFilePath: () => file,
        reconcile: async () => {
          calls.push(Date.now())
          void accept
          return { ok: true, action: 'reconcile', target: file, message: 'reconciled', changes: [], deferred: [], errors: [], loaded: 0 }
        },
      }),
      log: () => {},
    },
    effect: (callback: () => void | (() => void)): void => {
      callback()
    },
  }
  const watcher = new ConfigWatcher(ctx as unknown as never, resolveSettings({ debounceMs: 20, minIntervalMs: 600, retryDelayMs: 5, readRetries: 2 }))
  const dispose = watcher.start()
  try {
    fs.writeFileSync(file, `${VALID}# a\n`)
    await waitFor(() => calls.length === 1)
    fs.writeFileSync(file, `${VALID}# b\n`)
    await sleep(300)
    assert.equal(calls.length, 1, 'the second apply is rate limited')
    await waitFor(() => calls.length === 2, 3000)
    assert.equal(calls.length, 2, 'the deferred apply happens once the interval elapsed')
    const counters = watcher.state().counters as Record<string, number>
    assert.ok((counters.rateLimited ?? 0) >= 1, 'the deferral is counted')
  } finally {
    dispose()
  }
})

test('re-entrancy guard: edits during an apply coalesce into ONE follow-up', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file, { delayMs: 350 })
  try {
    fs.writeFileSync(file, `${VALID}# first\n`)
    await waitFor(() => h.calls.length === 1)
    // These land while the first (slow) reconcile is still running.
    fs.writeFileSync(file, `${VALID}# second\n`)
    await sleep(30)
    fs.writeFileSync(file, `${VALID}# third\n`)
    await waitFor(() => h.calls.length === 2, 4000)
    await sleep(400)
    assert.equal(h.calls.length, 2, `one in-flight apply + exactly one coalesced follow-up (saw ${h.calls.length})`)
    const state = h.watcher.state()
    assert.equal(state.applying, false, 'the guard is released')
    assert.equal(state.pending, false, 'the pending flag is cleared')
  } finally {
    h.dispose()
  }
})

test('an invalid edit keeps the running configuration, reports the error and recovers', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  try {
    fs.writeFileSync(file, 'this: is: not: valid\n')
    await waitFor(() => {
      const state = h.watcher.state()
      return state.lastError !== null && state.lastError !== undefined
    })
    const state = h.watcher.state()
    const lastError = state.lastError as Record<string, unknown>
    assert.equal(lastError.kind, 'invalid-config')
    assert.ok(String(lastError.message).includes('invalid YAML'), `the host message is kept (${String(lastError.message)})`)
    assert.equal((state.lastApply as Record<string, unknown>).ok, false)
    assert.equal((state.counters as Record<string, number>).failures, 1)

    // The next VALID write recovers: the error is cleared and the apply succeeds.
    fs.writeFileSync(file, VALID_TWO)
    await waitFor(() => h.watcher.state().lastError === null || h.watcher.state().lastError === undefined)
    const recovered = h.watcher.state()
    assert.equal(recovered.lastError, null)
    assert.equal((recovered.lastApply as Record<string, unknown>).ok, true)
    assert.equal((recovered.lastApply as Record<string, unknown>).changed, 1)
  } finally {
    h.dispose()
  }
})

test('a missing config file is a reported error, never a crash', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  try {
    fs.rmSync(file)
    const state = await h.watcher.trigger(true)
    const lastError = state.lastError as Record<string, unknown>
    assert.equal(lastError.kind, 'file-missing')
    assert.equal(state.disposed, false, 'the watcher survives an unreadable file')
  } finally {
    h.dispose()
  }
})

test('a host reconcile that throws is reported, the watcher keeps running', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file, { throwMessage: 'boom' })
  try {
    fs.writeFileSync(file, VALID_TWO)
    await waitFor(() => h.watcher.state().lastError !== null)
    const lastError = h.watcher.state().lastError as Record<string, unknown>
    assert.equal(lastError.kind, 'reconcile-failed')
    assert.equal(lastError.message, 'boom')
  } finally {
    h.dispose()
  }
})

test('dispose releases the handles and refuses further events', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  fs.writeFileSync(file, VALID_TWO)
  await waitFor(() => h.calls.length === 1)
  h.dispose()
  h.dispose() // idempotent
  const callsAfterDispose = h.calls.length
  fs.writeFileSync(file, `${VALID_TWO}# after dispose\n`)
  await sleep(300)
  assert.equal(h.calls.length, callsAfterDispose, 'no apply after dispose')
  const state = h.watcher.state()
  assert.equal(state.disposed, true)
  assert.equal(state.active, false)
  assert.equal(state.watching, false)
})

test('the plugin registers the web seams (state + apply) and they answer', async () => {
  const file = tempFile()
  fs.writeFileSync(file, VALID)
  const h = makeHarness(file)
  try {
    // `apply` is what wires the routes; drive it with the same fake context.
    const routes: { method: string; path: string; handler: (request: unknown) => unknown }[] = []
    const ctx = {
      workbench: { host: () => ({ configFilePath: () => file, reconcile: async () => ({ ok: true, action: 'reconcile', target: file, message: 'ok', changes: [], deferred: [], errors: [], loaded: 0 }) }), log: () => {} },
      effect: (callback: () => void | (() => void)): void => {
        const dispose = callback()
        if (typeof dispose === 'function') dispose()
      },
      web: {
        route: (spec: { method: string; path: string; handler: (request: unknown) => unknown }) => {
          routes.push(spec)
          return () => {}
        },
      },
    }
    apply(ctx as never, { debounceMs: 20, minIntervalMs: 0 })
    const stateRoute = routes.find((route) => route.method === 'GET' && route.path === `${API_BASE}/state`)
    const applyRoute = routes.find((route) => route.method === 'POST' && route.path === `${API_BASE}/apply`)
    assert.ok(stateRoute, `GET ${API_BASE}/state must be registered`)
    assert.ok(applyRoute, `POST ${API_BASE}/apply must be registered`)
    const response = stateRoute.handler({}) as { status?: number; body?: string }
    const body = JSON.parse(String(response.body)) as Record<string, unknown>
    assert.equal(body.contract, 'config-watch@1')
    assert.equal(body.file, file)
    const forced = (await applyRoute.handler({ readJson: async () => ({}) })) as { body?: string }
    assert.ok(String(forced.body).includes('"triggered": true'))
  } finally {
    h.dispose()
  }
})

test('an inline config leaves the watcher inactive with a reason (no crash)', async () => {
  const h = makeHarness(undefined)
  try {
    const state = h.watcher.state()
    assert.equal(state.active, false)
    assert.match(String(state.reason), /inline config/)
    assert.equal(h.calls.length, 0)
  } finally {
    h.dispose()
  }
})

test('entry export and manifest agree on the plugin name', async () => {
  assert.equal(plugin.name, pluginName)
  assert.deepEqual((plugin as { inject?: string[] }).inject, ['workbench'])
  const manifest = JSON.parse(fs.readFileSync(new URL('../plugins/config-watch/workbench.plugin.json', import.meta.url), 'utf8')) as {
    name: string
    entry: string
    config: { properties: Record<string, { default?: unknown }> }
  }
  assert.equal(manifest.name, pluginName)
  assert.equal(manifest.entry, 'index.ts')
  assert.equal(manifest.config.properties.debounceMs?.default, 300)
  assert.equal(manifest.config.properties.minIntervalMs?.default, 1000)
})
