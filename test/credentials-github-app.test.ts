// `core/credentials-github-app` tests: the GitHub App flow MOVED OUT OF THE
// CORE (RS256 JWT, installation token + cache, the `github-app` git auth
// strategy registration).
//
// The network is never touched: the token mint takes an injected `fetch` (and,
// for the strategy, a stubbed global fetch), so the test proves the request
// shape, the cache and the required-field errors without a credential value of
// any kind. The private key used here is a THROWAWAY key generated in the test.
import assert from 'node:assert/strict'
import { constants, generateKeyPairSync, verify } from 'node:crypto'
import test from 'node:test'
import {
  DEFAULT_API_BASE,
  DEFAULT_USERNAME,
  apply,
  clearInstallationTokenCache,
  createGitAuthHandler,
  gitAuthArgs,
  githubAppInstallationToken,
  githubAppJwt,
} from '../core/credentials-github-app/index.ts'

/** A throwaway RSA key (never a credential: generated in-process, never stored). */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()

/** A fetch stub that answers the installation-token endpoint. */
function tokenFetch(token: string, expiresAt: string, onCall?: (url: string, init: RequestInit) => void): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    onCall?.(String(url), init ?? {})
    return new Response(JSON.stringify({ token, expires_at: expiresAt }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

test('github-app: the JWT is RS256 over the documented claims', () => {
  const now = 1_700_000_000_000
  const jwt = githubAppJwt({ appId: '42', privateKey: PEM, now })
  const [header, claims, signature] = jwt.split('.')
  assert.equal(header, Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url'))
  const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { iat: number; exp: number; iss: string }
  assert.equal(decoded.iss, '42')
  assert.equal(decoded.iat, Math.floor(now / 1000) - 60)
  assert.equal(decoded.exp - decoded.iat, 600, "inside GitHub's 10 minute maximum")
  const ok = verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(signature, 'base64url'))
  assert.equal(ok, true)
  assert.throws(() => githubAppJwt({ appId: 'abc', privateKey: PEM }), /must be a numeric id/)
})

test('github-app: the installation token is minted once and cached in memory', async () => {
  clearInstallationTokenCache()
  const calls: string[] = []
  const fetchImpl = tokenFetch('ghs_token_value', new Date(Date.now() + 3_600_000).toISOString(), (url, init) => {
    calls.push(url)
    assert.equal(init.method, 'POST')
    assert.equal((init.headers as Record<string, string>).accept, 'application/vnd.github+json')
    assert.match(String((init.headers as Record<string, string>).authorization), /^Bearer eyJ/)
  })
  const first = await githubAppInstallationToken({ appId: '7', installationId: '9', privateKey: PEM, fetchImpl })
  assert.equal(first.token, 'ghs_token_value')
  const second = await githubAppInstallationToken({ appId: '7', installationId: '9', privateKey: PEM, fetchImpl })
  assert.equal(second.token, 'ghs_token_value')
  assert.equal(calls.length, 1, 'the second call is served from the in-memory cache')
  assert.deepEqual(calls, [`${DEFAULT_API_BASE}/app/installations/9/access_tokens`])
  clearInstallationTokenCache()
})

test('github-app: a non-2xx answer is reported without leaking the body token', async () => {
  clearInstallationTokenCache()
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ token: 'ghs_leaked' }), { status: 401 })) as unknown as typeof fetch
  await assert.rejects(
    () => githubAppInstallationToken({ appId: '7', installationId: '9', privateKey: PEM, fetchImpl }),
    (error: unknown) => {
      const text = String(error)
      assert.match(text, /HTTP 401/)
      assert.ok(!text.includes('ghs_leaked'), 'the echoed body is redacted')
      return true
    },
  )
})

test('github-app: gitAuthArgs disables any credential helper and passes one extraheader', () => {
  const args = gitAuthArgs('t0ken')
  assert.deepEqual(args.slice(0, 2), ['-c', 'credential.helper='])
  const header = args[3]
  assert.equal(header, `http.extraheader=Authorization: Basic ${Buffer.from(`${DEFAULT_USERNAME}:t0ken`).toString('base64')}`)
  assert.equal(gitAuthArgs('t0ken', 'someone')[3], `http.extraheader=Authorization: Basic ${Buffer.from('someone:t0ken').toString('base64')}`)
})

test('github-app: the strategy mints from the resolved value and reads the auth block', async () => {
  clearInstallationTokenCache()
  const original = globalThis.fetch
  const seen: string[] = []
  globalThis.fetch = tokenFetch('ghs_from_handler', new Date(Date.now() + 3_600_000).toISOString(), (url) => seen.push(url))
  try {
    const handler = createGitAuthHandler({ username: 'bot' })
    assert.equal(handler.type, 'github-app')
    const args = await handler.args({
      ref: { name: 'GITHUB_APP_KEY' },
      value: PEM,
      auth: { type: 'github-app', credential: 'GITHUB_APP_KEY', appId: '3967918', installationId: '138119822', apiBase: 'https://api.github.com' },
    })
    assert.deepEqual(seen, ['https://api.github.com/app/installations/138119822/access_tokens'])
    assert.equal(args[3], `http.extraheader=Authorization: Basic ${Buffer.from('bot:ghs_from_handler').toString('base64')}`)
    const scoped = await handler.args({
      ref: { scope: 'work', name: 'GITHUB_APP_KEY' },
      value: PEM,
      auth: { appId: 3967918, installationId: 138119823 },
    } as never)
    assert.equal(scoped.length, 4)
  } finally {
    globalThis.fetch = original
    clearInstallationTokenCache()
  }
})

test('github-app: a strategy needs the app ids and a service that offers registerGitAuth', async () => {
  const handler = createGitAuthHandler()
  await assert.rejects(
    async () => {
      await handler.args({ ref: { name: 'GITHUB_APP_KEY' }, value: PEM, auth: { credential: 'GITHUB_APP_KEY' } })
    },
    /needs both 'appId' and 'installationId'/,
  )
  assert.throws(() => apply({ credentials: {} as never, effect: () => () => undefined }), /does not offer registerGitAuth/)
})

test('github-app: apply registers the strategy and its disposer removes it', () => {
  const registered: string[] = []
  const disposers: Array<() => void> = []
  const ctx = {
    credentials: {
      registerGitAuth: (handler: { type: string }) => {
        registered.push(handler.type)
        return () => void registered.splice(registered.indexOf(handler.type), 1)
      },
    },
    effect: (callback: () => () => void) => void disposers.push(callback()),
  }
  apply(ctx as never, {})
  assert.deepEqual(registered, ['github-app'])
  for (const dispose of disposers) dispose()
  assert.deepEqual(registered, [])
})
