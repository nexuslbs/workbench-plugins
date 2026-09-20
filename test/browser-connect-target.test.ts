// The `browserService.endpoint` RESOLUTION of the playwright provider.
//
// A deployment names the browser service by its DNS name (`http://browser:9222`,
// a compose service on the shared network), but chromium's DevTools server
// rejects any request whose `Host` header is neither an IP nor `localhost` (its
// DNS-rebinding guard), and the browser service image is a plain TCP forwarder,
// so it passes the Host header through untouched:
//
//   $ curl -s http://browser:9222/json/version
//   Host header is specified and is not an IP address or localhost.
//
// `connectTarget` resolves the NAME to its ADDRESS for the attach (chromium also
// builds the `webSocketDebuggerUrl` from the Host header, so the websocket that
// follows works too) while the CONFIGURED string stays the one reported in
// results and typed errors. The resolver is INJECTED here, so the URL rewriting
// is proven deterministically, without DNS and without a browser.
import assert from 'node:assert/strict'
import test from 'node:test'

import { connectTarget } from '../core/browser-use-playwright/index.ts'

const resolver = (addresses: Record<string, string>) => async (name: string) => addresses[name]

test('connectTarget dials an endpoint that already names an IP as written', async () => {
  assert.equal(await connectTarget('http://127.0.0.1:9222', resolver({})), 'http://127.0.0.1:9222')
  assert.equal(await connectTarget('http://192.168.144.11:9222', resolver({})), 'http://192.168.144.11:9222')
})

test('connectTarget dials localhost as written', async () => {
  assert.equal(await connectTarget('http://localhost:9222', resolver({})), 'http://localhost:9222')
})

test('connectTarget rewrites a service NAME to its address, keeping port and path', async () => {
  assert.equal(await connectTarget('http://browser:9222', resolver({ browser: '192.168.144.11' })), 'http://192.168.144.11:9222')
  assert.equal(
    await connectTarget('ws://browser:3000/devtools/browser/abc?x=1', resolver({ browser: '10.0.0.5' })),
    'ws://10.0.0.5:3000/devtools/browser/abc?x=1',
  )
})

test('connectTarget re-brackets an IPv6 answer', async () => {
  assert.equal(await connectTarget('http://browser:9222', resolver({ browser: 'fe80::1' })), 'http://[fe80::1]:9222')
})

test('connectTarget leaves an unresolvable NAME alone (the typed error path names it)', async () => {
  assert.equal(await connectTarget('http://browser:9222', resolver({})), 'http://browser:9222')
})

test('connectTarget returns a non-URL endpoint unchanged', async () => {
  assert.equal(await connectTarget('not a url', resolver({})), 'not a url')
})
