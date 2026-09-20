// The SHARED chromium launcher (`shared/browser.ts`) is what makes ONE browser
// serve `browser-use-playwright`, `web-page` and `web-session`. Its refcount has
// a failure mode that only a browser-capable host can see: when the LAST holder
// released the process, the launcher kept the SETTLED launch promise, so the
// next `acquireSharedBrowser` handed out the CLOSED browser and the caller died
// with `browser.newContext: Target page, context or browser has been closed`.
//
// That is a BUG, not a contract: a fresh acquire after the last release must
// return a LIVE process (a new launch). This test pins it - it SKIPS (naming the
// prerequisite) when the host has no chromium, `BROWSER_USE_REQUIRE_BROWSER=1`
// turns the skip into a FAILURE, and it never leaves a browser running.
import test from 'node:test'
import assert from 'node:assert/strict'
import { acquireSharedBrowser, closeSharedBrowser, releaseSharedBrowser, sharedBrowserStats } from '../shared/browser.ts'

test('e2e shared launcher: after the last holder releases, the next acquire LAUNCHES a fresh browser (never a closed handle)', async (t) => {
  const executablePath = process.env.BROWSER_USE_CHROMIUM
  if (executablePath === undefined || executablePath.length === 0) {
    const requirement = 'set BROWSER_USE_CHROMIUM=<chrome binary> (the browser is a deployment input) to run this'
    if (process.env.BROWSER_USE_REQUIRE_BROWSER === '1') {
      assert.fail(`no browser available and BROWSER_USE_REQUIRE_BROWSER=1: ${requirement}`)
    }
    t.skip(`no browser available: ${requirement}`)
    return
  }
  const options = { args: [], timeoutMs: 30_000, headless: true, executablePath }
  await closeSharedBrowser()
  try {
    const first = await acquireSharedBrowser(options)
    const launchesBefore = sharedBrowserStats().launches
    assert.equal(sharedBrowserStats().holders, 1)
    await releaseSharedBrowser()
    assert.equal(sharedBrowserStats().connected, false, 'the last release CLOSED the process')

    const second = await acquireSharedBrowser(options)
    assert.notEqual(second, first, 'the closed handle must never be handed out again')
    assert.equal(second.isConnected(), true, 'the second holder gets a LIVE browser')
    assert.equal(sharedBrowserStats().launches, launchesBefore + 1, 'the second acquire LAUNCHED a fresh process')
    // The exact call that used to throw on the stale handle.
    const context = await second.newContext()
    assert.equal(second.contexts().length, 1)
    await context.close()
  } finally {
    await closeSharedBrowser()
  }
})
