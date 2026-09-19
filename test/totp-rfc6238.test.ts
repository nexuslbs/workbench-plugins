// Unit test for the TOTP PROVIDER: RFC 4226/6238 correctness (published
// vectors), base32 decoding, the boundary behaviour of `at`/remainingSeconds,
// entry metadata without a secret, and the not-configured paths. Nothing here
// imports the core or the consumer.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apply,
  decodeBase32,
  encodeBase32,
  hotp,
  maskSecret,
  name,
  normalizeEntries,
  providerId,
  totp,
  CONTRACT_VERSION,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  type Config,
  type EntryInfo,
  type ProviderLike,
  type CodeResult,
} from '../plugins/totp-rfc6238/index.ts'

// RFC 6238 appendix B secrets, as ASCII, plus their base32 spellings.
const SHA1_SECRET_ASCII = '12345678901234567890'
const SHA256_SECRET_ASCII = '12345678901234567890123456789012'
const SHA512_SECRET_ASCII =
  '1234567890123456789012345678901234567890123456789012345678901234'

interface Credentials {
  resolve(ref: { name: string; scope?: string }): Promise<{ value?: string } | undefined> | { value?: string } | undefined
}

interface Boot {
  registered: ProviderLike[]
  provider?: ProviderLike
  logs: string[]
}

/** Boots the plugin with a fake context: records the registration and logs. */
function boot(config: Config, credentials?: Credentials): Boot {
  const registered: ProviderLike[] = []
  const logs: string[] = []
  const ctx = {
    totp: {
      register(provider: ProviderLike): () => void {
        registered.push(provider)
        return () => {
          const index = registered.indexOf(provider)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    ...(credentials === undefined ? {} : { credentials }),
    effect(callback: () => () => void): void {
      callback()
    },
  }
  const original = console.error
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '))
  }
  try {
    apply(ctx as never, config)
  } finally {
    console.error = original
  }
  return { registered, provider: registered[0], logs }
}

test('the provider declares totp@1 for the id rfc6238', () => {
  assert.equal(name, 'totp-rfc6238')
  assert.equal(providerId, 'rfc6238')
  assert.equal(CONTRACT_VERSION, 1)
  assert.equal(DEFAULT_DIGITS, 6)
  assert.equal(DEFAULT_PERIOD, 30)
})

test('base32 decoding: RFC 4648 alphabet, padding, spaces and case are tolerated', () => {
  assert.equal(encodeBase32(Buffer.from(SHA1_SECRET_ASCII)), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  assert.deepEqual(decodeBase32('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'), Buffer.from(SHA1_SECRET_ASCII))
  assert.deepEqual(decodeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq'), Buffer.from(SHA1_SECRET_ASCII))
  assert.deepEqual(decodeBase32('JBSWY3DPEHPK3PXP==='), decodeBase32('JBSWY3DPEHPK3PXP'))
  assert.deepEqual(decodeBase32('MFRGG==='), Buffer.from('abc'))
  // The message names the POSITION, never the key.
  assert.throws(() => decodeBase32('JBSWY3DP!HPK3PXP'), (error: unknown) => {
    const message = (error as Error).message
    assert.match(message, /not valid base32 \(unexpected character at position 8\)/)
    assert.equal(message.includes('JBSWY3DP!'), false, 'the key must not be echoed')
    return true
  })
  assert.throws(() => decodeBase32('   '), /must not be empty/)
})

test('RFC 6238 appendix B vectors: SHA1 at 8 digits, and the 6-digit truncation', () => {
  const secret = decodeBase32(encodeBase32(Buffer.from(SHA1_SECRET_ASCII)))
  const vectors: [number, number, string][] = [
    [59, 1, '94287082'],
    [1111111109, 37037036, '07081804'],
    [1111111111, 37037037, '14050471'],
    [1234567890, 41152263, '89005924'],
    [2000000000, 66666666, '69279037'],
    [20000000000, 666666666, '65353130'],
  ]
  for (const [at, step, expected] of vectors) {
    assert.equal(hotp(secret, Math.floor(at / 30), 8, 'SHA1'), expected, `SHA1 T=${String(at)}`)
    assert.equal(totp(secret, at, 30, 8, 'SHA1').code, expected, `totp() T=${String(at)}`)
    assert.equal(totp(secret, at, 30, 8, 'SHA1').step, step)
    // 6 digits = the same digest truncated: the LOW digits of the 8-digit code.
    assert.equal(hotp(secret, step, 6, 'SHA1'), expected.slice(-6))
  }
})

test('RFC 6238 appendix B vectors: SHA256 and SHA512 at T=59', () => {
  const sha256 = decodeBase32(encodeBase32(Buffer.from(SHA256_SECRET_ASCII)))
  const sha512 = decodeBase32(encodeBase32(Buffer.from(SHA512_SECRET_ASCII)))
  assert.equal(hotp(sha256, 1, 8, 'SHA256'), '46119246')
  assert.equal(totp(sha256, 59, 30, 8, 'SHA256').code, '46119246')
  assert.equal(hotp(sha512, 1, 8, 'SHA512'), '90693936')
  assert.equal(totp(sha512, 59, 30, 8, 'SHA512').code, '90693936')
  // The 6-digit spellings of the same T.
  assert.equal(totp(sha256, 59, 30, 6, 'SHA256').code, '119246')
  assert.equal(totp(sha512, 59, 30, 6, 'SHA512').code, '693936')
})

test('the boundary of a 30s step: T=59 and T=60 roll over and remainingSeconds is exact', () => {
  const secret = decodeBase32('JBSWY3DPEHPK3PXP')
  const before = totp(secret, 59, 30)
  const after = totp(secret, 60, 30)
  assert.equal(before.step, 1)
  assert.equal(after.step, 2)
  assert.equal(before.remainingSeconds, 1)
  assert.equal(after.remainingSeconds, 30)
  assert.notEqual(before.code, after.code)
  assert.equal(totp(secret, 0, 30).remainingSeconds, 30)
  assert.equal(totp(secret, 29, 30).remainingSeconds, 1)
  // A different period is honoured exactly (60s step: T=0 and T=59 are the same step).
  assert.equal(totp(secret, 0, 60).code, totp(secret, 59, 60).code)
  assert.equal(totp(secret, 0, 60).step, 0)
  assert.equal(totp(secret, 59, 60).remainingSeconds, 1)
})

test('entries() reports metadata only: labels, digits/period/algorithm and configured', () => {
  const { provider } = boot({
    entries: {
      github: { secret: 'JBSWY3DPEHPK3PXP', issuer: 'GitHub', account: 'me@example.com' },
      'aws-root': { secret: 'JBSWY3DPEHPK3PXP', digits: 8, period: 60, algorithm: 'SHA256' },
      broken: {},
    },
  })
  assert.ok(provider)
  const entries: EntryInfo[] = provider.entries()
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ['github', 'aws-root', 'broken'],
  )
  assert.deepEqual(entries[0], {
    label: 'github',
    issuer: 'GitHub',
    account: 'me@example.com',
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
    configured: true,
  })
  assert.equal(entries[1]?.algorithm, 'SHA256')
  assert.equal(entries[1]?.period, 60)
  assert.equal(entries[2]?.configured, false)
  const payload = JSON.stringify(entries)
  assert.equal(payload.includes('JBSWY3DPEHPK3PXP'), false, 'no key in entries()')
  assert.equal(/secret/i.test(payload), false, 'no key vocabulary either')
  assert.equal(provider.describe?.().includes('JBSWY3DPEHPK3PXP'), false)
  assert.match(provider.describe?.() ?? '', /rfc|RFC 6238/i)
  assert.match(provider.describe?.() ?? '', /github, aws-root, broken/)
})

test('code() generates for a named entry, defaults to now and honours `at`', async () => {
  const { provider } = boot({ entries: { github: { secret: 'JBSWY3DPEHPK3PXP' } } })
  const fixed = (await provider?.code('github', { at: 59 })) as CodeResult
  assert.deepEqual(fixed, {
    label: 'github',
    code: totp(decodeBase32('JBSWY3DPEHPK3PXP'), 59, 30, 6, 'SHA1').code,
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
    generatedAt: 59,
    remainingSeconds: 1,
  })
  const now = (await provider?.code('github')) as CodeResult
  assert.match(now.code, /^[0-9]{6}$/)
  assert.ok(now.generatedAt > 1_600_000_000, 'defaults to the current clock')
  assert.ok(now.remainingSeconds >= 1 && now.remainingSeconds <= 30)
})

test('an unknown label is a structured error, never a crash', async () => {
  const { provider } = boot({ entries: { github: { secret: 'JBSWY3DPEHPK3PXP' } } })
  await assert.rejects(async () => await provider?.code('nope'), (error: unknown) => {
    assert.equal((error as Error).name, 'TotpUnknownEntryError')
    assert.equal((error as { label?: string }).label, 'nope')
    assert.match((error as Error).message, /totp: unknown entry 'nope' \(configured: github\)/)
    return true
  })
  // The provider keeps answering after the error.
  assert.equal(provider?.entries().length, 1)
})

test('a credential-backed entry resolves at CALL time through ctx.credentials', async () => {
  const asked: string[] = []
  const credentials: Credentials = {
    resolve: async (ref) => {
      asked.push(ref.name)
      if (ref.name === 'TOTP_GITHUB_KEY') return { value: 'JBSWY3DPEHPK3PXP' }
      return undefined
    },
  }
  const { provider } = boot(
    {
      entries: {
        github: { credential: 'TOTP_GITHUB_KEY' },
        missing: { credential: 'TOTP_ABSENT' },
      },
    },
    credentials,
  )
  assert.deepEqual(asked, [], 'resolution happens at call time, not at load time')
  const result = (await provider?.code('github', { at: 59 })) as CodeResult
  assert.equal(result.code, totp(decodeBase32('JBSWY3DPEHPK3PXP'), 59).code)
  assert.deepEqual(asked, ['TOTP_GITHUB_KEY'])
  await assert.rejects(async () => await provider?.code('missing'), (error: unknown) => {
    assert.equal((error as Error).name, 'TotpEntryNotConfiguredError')
    assert.match((error as Error).message, /entry 'missing' is not configured: credential 'TOTP_ABSENT' did not resolve/)
    return true
  })
})

test('a credential that is not base32, and a literal key that is not base32, are NOT CONFIGURED (never echoed)', async () => {
  const credentials: Credentials = { resolve: () => ({ value: 'not base32 !!!' }) }
  const literal = 'JBSWY3DP!HPK3PXP'
  const { provider } = boot(
    {
      entries: {
        cred: { credential: 'TOTP_BAD' },
        literal: { secret: literal },
      },
    },
    credentials,
  )
  await assert.rejects(async () => await provider?.code('cred'), (error: unknown) => {
    assert.equal((error as Error).name, 'TotpEntryNotConfiguredError')
    assert.match((error as Error).message, /credential 'TOTP_BAD' is not a base32 key/)
    assert.equal((error as Error).message.includes('not base32 !!!'), false, 'the value must not be echoed')
    return true
  })
  await assert.rejects(async () => await provider?.code('literal'), (error: unknown) => {
    assert.equal((error as Error).name, 'TotpEntryNotConfiguredError')
    assert.match((error as Error).message, /is not a base32 key/)
    assert.equal((error as Error).message.includes(literal), false, 'the key must not be echoed')
    assert.match((error as Error).message, /J!|\*\*\*\*/)
    return true
  })
})

test('maskSecret redacts a key in diagnostics', () => {
  assert.equal(maskSecret('JBSWY3DPEHPK3PXP'), 'JB****XP (redacted)')
  assert.equal(maskSecret('abc'), '****')
  assert.equal(maskSecret(''), '(empty)')
})

test('with no entries the plugin LOADS, logs NOT CONFIGURED and registers nothing', () => {
  const { registered, logs } = boot({})
  assert.deepEqual(registered, [])
  assert.equal(logs.length, 1)
  assert.match(logs[0] ?? '', /totp-rfc6238: not configured/)
  assert.match(logs[0] ?? '', /no 'entries' in plugins\.totp-rfc6238/)
})

test('an invalid config row is rejected at load time (a real config error, not a missing option)', () => {
  assert.throws(() => normalizeEntries({ entries: { github: { secret: 'JBSWY3DPEHPK3PXP', digits: 3 } } }), /'digits' must be an integer in 4\.\.10/)
  assert.throws(() => normalizeEntries({ entries: { github: { secret: 'JBSWY3DPEHPK3PXP', period: 0 } } }), /'period' must be an integer in 1\.\.3600 seconds/)
  assert.throws(() => normalizeEntries({ entries: { github: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'MD5' } } }), /'algorithm' must be one of SHA1\/SHA256\/SHA512/)
  assert.throws(() => normalizeEntries({ entries: { '  ': { secret: 'X' } } }), /label must be a non-empty string/)
  assert.deepEqual(normalizeEntries({}), [])
})
