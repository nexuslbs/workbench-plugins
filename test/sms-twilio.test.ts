// Unit test for the SMS PROVIDER: it must implement `sms@1` on the Twilio REST
// API shapes without any network. A stub `node:http` server answers the exact
// endpoint shapes Twilio publishes (Messages collection + single resource,
// `next_page_uri` pagination, Basic auth, error statuses), so pagination,
// filtering, the `To`/`PageSize` parameters, the error paths and the
// not-configured behaviour are all exercised against a real HTTP exchange.
//
// Nothing here touches the internet, a Twilio account or a credential store.
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import {
  apply,
  backendError,
  capBody,
  clampInteger,
  credentialRefName,
  isoDate,
  maskValue,
  normalizeLimit,
  normalizeNumbers,
  refLabel,
} from '../plugins/sms-twilio/index.ts'

const API_VERSION = '2010-04-01'

interface SeenRequest {
  path: string
  query: Record<string, string>
  authorization?: string
}

/** The fixture messages the stub answers with, newest first. */
function messages(): Record<string, unknown>[] {
  return [
    {
      sid: 'SM100',
      from: '+15550001111',
      to: '+15551234567',
      body: 'Your verification code is 483920. Do not share it.',
      date_created: 'Fri, 19 Sep 2026 10:00:00 +0000',
      status: 'received',
      num_segments: '1',
      direction: 'inbound',
      num_media: '0',
    },
    {
      sid: 'SM101',
      from: 'BankAlert',
      to: '+15551234567',
      body: 'No code here, just a notice.',
      date_created: 'Fri, 19 Sep 2026 09:00:00 +0000',
      status: 'received',
      num_segments: '1',
      direction: 'inbound',
      num_media: '0',
    },
    {
      sid: 'SM102',
      from: '+15550002222',
      to: '+15551234567',
      body: 'Older message with code 111111.',
      date_created: 'Thu, 18 Sep 2026 08:00:00 +0000',
      status: 'received',
      num_segments: '1',
      direction: 'inbound',
      num_media: '0',
    },
  ]
}

async function withServer(
  handler: (request: SeenRequest, response: http.ServerResponse) => void,
  run: (base: string, seen: SeenRequest[]) => Promise<void>,
): Promise<void> {
  const seen: SeenRequest[] = []
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const query: Record<string, string> = {}
    for (const [key, value] of url.searchParams) query[key] = value
    const entry: SeenRequest = {
      path: url.pathname,
      query,
      ...(request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization }),
    }
    seen.push(entry)
    handler(entry, response)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await run(`http://127.0.0.1:${String(port)}`, seen)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function json(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(body)
}

/** The default Twilio-shaped handler: two pages, a 404 sid, an error account. */
function twilioHandler(seen: SeenRequest, response: http.ServerResponse): void {
  const fixture = messages()
  if (seen.path === `/2010-04-01/Accounts/ACtest/Messages.json` && seen.query.Page === undefined) {
    const pageSize = Number(seen.query.PageSize ?? '10')
    const first = fixture.slice(0, Math.min(2, pageSize))
    json(response, 200, {
      messages: first,
      page: 0,
      page_size: pageSize,
      next_page_uri: `/2010-04-01/Accounts/ACtest/Messages.json?PageSize=${String(pageSize)}&Page=1&To=${encodeURIComponent(seen.query.To ?? '')}`,
    })
    return
  }
  if (seen.path === `/2010-04-01/Accounts/ACtest/Messages.json` && seen.query.Page === '1') {
    json(response, 200, { messages: fixture.slice(2), page: 1, page_size: 10, next_page_uri: null })
    return
  }
  if (seen.path === `/2010-04-01/Accounts/ACtest/Messages/SM100.json`) {
    json(response, 200, fixture[0])
    return
  }
  if (seen.path === `/2010-04-01/Accounts/ACtest/Messages/SM404.json`) {
    json(response, 404, { code: 20404, message: 'The requested resource was not found' })
    return
  }
  if (seen.path.startsWith('/2010-04-01/Accounts/ACbad/')) {
    json(response, 401, { code: 20003, message: 'Authenticate' })
    return
  }
  if (seen.path.startsWith('/2010-04-01/Accounts/ACslow/')) {
    return // never answers: the provider's timeout must fire
  }
  json(response, 404, { code: 20404, message: 'The requested resource was not found' })
}

interface Registered {
  id?: string
  version?: number
  numbers: () => unknown
  list: (ref: { label: string } | undefined, options: Record<string, unknown>) => Promise<unknown>
  get: (ref: { label: string } | undefined, id: string) => Promise<unknown>
}

/** The credential NAMES the tests seed, so a bare `authToken` name resolves. */
const DEFAULT_STORE: Record<string, string> = {
  TWILIO_PERSONAL_TOKEN: 'token-personal',
  TWILIO_BAD: 'token-bad',
  TWILIO_SLOW: 'token-slow',
}

/** A context with a fake `ctx.sms` and a tiny credential store (values by NAME). */
function makeContext(store: Record<string, string> = {}): {
  ctx: unknown
  registered: Registered[]
  resolveCalls: string[]
} {
  const registered: Registered[] = []
  const resolveCalls: string[] = []
  const ctx = {
    sms: { register: (provider: Registered) => { registered.push(provider); return () => undefined } },
    credentials: {
      resolve: (ref: { name: string }) => {
        resolveCalls.push(ref.name)
        const value = store[ref.name] ?? DEFAULT_STORE[ref.name]
        return value === undefined ? undefined : { value }
      },
    },
    effect: (callback: () => () => void) => { callback() },
  }
  return { ctx, registered, resolveCalls }
}

function configOf(base: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    defaultNumber: 'personal',
    numbers: {
      personal: { number: '+15551234567', accountSid: 'ACtest', authToken: 'TWILIO_PERSONAL_TOKEN', apiBase: base },
      work: { number: '+15557654321', accountSid: 'ACtest', authToken: '${cred:TWILIO_WORK_TOKEN}', apiBase: base },
      broken: { number: '+15550000000', accountSid: 'ACtest', authToken: '${cred:MISSING_TOKEN}', apiBase: base },
      bad: { number: '+15550000001', accountSid: 'ACbad', authToken: 'TWILIO_BAD', apiBase: base },
      slow: { number: '+15550000002', accountSid: 'ACslow', authToken: 'TWILIO_SLOW', apiBase: base },
    },
    ...extra,
  }
}

test('the manifest provider id and the read-only shape are stable', async () => {
  const { ctx, registered } = makeContext()
  await apply(ctx as never, {})
  assert.deepEqual(registered, [], 'no numbers configured: the plugin loads and registers NOTHING (contract rule 6)')
})

test('numbers() reports the labels, the default and the configured flag, never a credential value', async () => {
  await withServer(twilioHandler, async (base) => {
    const { ctx, registered } = makeContext({ TWILIO_WORK_TOKEN: 'resolved-work-token' })
    await apply(ctx as never, configOf(base) as never)
    assert.equal(registered.length, 1)
    const numbers = (await registered[0]?.numbers()) as Record<string, unknown>[]
    assert.deepEqual(
      numbers.map((number) => number.label),
      ['personal', 'work', 'broken', 'bad', 'slow'],
    )
    assert.equal(numbers[0]?.default, true)
    assert.equal(numbers[0]?.configured, true)
    assert.equal(numbers[1]?.configured, true, 'a resolvable reference is configured')
    assert.equal(numbers[2]?.configured, false, 'an unresolvable reference is NOT configured')
    assert.equal(numbers[3]?.configured, true, 'a NAMED credential resolves at call time (the API answers 401 later)')
    const payload = JSON.stringify(numbers)
    assert.equal(payload.includes('resolved-work-token'), false, 'a credential value never leaves the provider')
    assert.equal(payload.includes('token-personal'), false)
    assert.equal(payload.includes('ACtest'), false, 'an account sid is metadata of the row, not reported')
  })
})

test('list() filters on To, walks next_page_uri, authenticates by Basic and honours limit/since/from/unreadOnly', async () => {
  await withServer(twilioHandler, async (base, seen) => {
    const { ctx, registered } = makeContext({ TWILIO_WORK_TOKEN: 'resolved-work-token' })
    await apply(ctx as never, configOf(base) as never)
    const provider = registered[0]

    const listed = (await provider?.list({ label: 'personal' }, { limit: 10 })) as Record<string, unknown>[]
    assert.equal(listed.length, 3, 'both pages are collected')
    assert.deepEqual(
      listed.map((message) => message.id),
      ['SM100', 'SM101', 'SM102'],
    )
    assert.equal(listed[0]?.from, '+15550001111')
    assert.equal(listed[0]?.to, '+15551234567')
    assert.equal(listed[0]?.date, '2026-09-19T10:00:00.000Z', 'the RFC-2822 date is normalised to ISO-8601')
    assert.equal(listed[0]?.status, 'received')
    assert.equal(listed[0]?.unread, true)
    // The FIRST request carries To + PageSize; the second one is the page URI.
    assert.equal(seen[0]?.path, `/2010-04-01/Accounts/ACtest/Messages.json`)
    assert.equal(seen[0]?.query.To, '+15551234567')
    assert.equal(seen[0]?.query.PageSize, '10')
    assert.equal(seen[1]?.query.Page, '1')
    assert.equal(
      seen[0]?.authorization,
      `Basic ${Buffer.from('ACtest:token-personal').toString('base64')}`,
      'Twilio Basic auth: the row of the referenced label only',
    )

    const two = (await provider?.list({ label: 'personal' }, { limit: 2 })) as Record<string, unknown>[]
    assert.equal(two.length, 2, 'the limit caps the answer even when a page carries more')

    const recent = (await provider?.list({ label: 'personal' }, { limit: 10, since: '2026-09-19T00:00:00.000Z' })) as Record<string, unknown>[]
    assert.deepEqual(
      recent.map((message) => message.id),
      ['SM100', 'SM101'],
    )
    const fromBank = (await provider?.list({ label: 'personal' }, { limit: 10, from: 'bankalert' })) as Record<string, unknown>[]
    assert.deepEqual(
      fromBank.map((message) => message.id),
      ['SM101'],
    )
    const unreadOnly = (await provider?.list({ label: 'personal' }, { limit: 10, unreadOnly: true })) as Record<string, unknown>[]
    assert.equal(unreadOnly.length, 3, "Twilio's inbound final status is 'received' (see README)")

    // The default number answers when no reference is given.
    const byDefault = (await provider?.list(undefined, { limit: 1 })) as Record<string, unknown>[]
    assert.equal(byDefault.length, 1)
    assert.equal(seen.at(-1)?.query.To, '+15551234567')
  })
})

test('get() returns the full message of the referenced number', async () => {
  await withServer(twilioHandler, async (base, seen) => {
    const { ctx, registered } = makeContext({ TWILIO_WORK_TOKEN: 'resolved-work-token' })
    await apply(ctx as never, configOf(base) as never)
    const message = (await registered[0]?.get({ label: 'personal' }, 'SM100')) as Record<string, unknown>
    assert.equal(message.id, 'SM100')
    assert.equal(message.body, 'Your verification code is 483920. Do not share it.')
    assert.equal(message.segments, 1)
    assert.equal(message.direction, 'inbound')
    assert.equal(seen[0]?.path, `/2010-04-01/Accounts/ACtest/Messages/SM100.json`)
  })
})

test('a 404 becomes a SmsNotFoundError-shaped error, a 401 a backend error without the credential', async () => {
  await withServer(twilioHandler, async (base) => {
    const { ctx, registered } = makeContext({ TWILIO_WORK_TOKEN: 'resolved-work-token' })
    await apply(ctx as never, configOf(base) as never)
    const provider = registered[0]

    await assert.rejects(async () => await provider?.get({ label: 'personal' }, 'SM404'), (error: unknown) => {
      assert.equal((error as Error).name, 'SmsNotFoundError')
      assert.match((error as Error).message, /message 'SM404' was not found on number 'personal'/)
      return true
    })

    await assert.rejects(
      async () => await provider?.list({ label: 'bad' }, { limit: 1 }),
      (error: unknown) => {
        assert.equal((error as Error).name, 'SmsBackendError')
        assert.match((error as Error).message, /number 'bad': the sms backend answered HTTP 401 \(code 20003: Authenticate\)/)
        assert.equal((error as Error).message.includes('token-bad'), false, 'a credential value never reaches an error')
        return true
      },
    )
  })
})

test('a request that never answers is bounded by the timeout', async () => {
  await withServer(twilioHandler, async (base) => {
    const { ctx, registered } = makeContext()
    await apply(ctx as never, { ...configOf(base), timeoutMs: 120 } as never)
    await assert.rejects(async () => await registered[0]?.list({ label: 'slow' }, { limit: 1 }), /the request failed \(timed out after 120ms\)/)
  })
})

test('an unknown label and an unresolvable credential are structured, and another label keeps working', async () => {
  await withServer(twilioHandler, async (base) => {
    const { ctx, registered } = makeContext({ TWILIO_WORK_TOKEN: 'resolved-work-token' })
    await apply(ctx as never, configOf(base) as never)
    const provider = registered[0]

    await assert.rejects(async () => await provider?.list({ label: 'nope' }, { limit: 1 }), (error: unknown) => {
      assert.equal((error as Error).name, 'SmsUnknownNumberError')
      assert.match((error as Error).message, /unknown number 'nope' \(configured: personal, work, broken, bad, slow\)/)
      return true
    })
    await assert.rejects(async () => await provider?.list({ label: 'broken' }, { limit: 1 }), (error: unknown) => {
      assert.equal((error as Error).name, 'SmsNumberNotConfiguredError')
      assert.match((error as Error).message, /number 'broken' is not configured \(credential 'MISSING_TOKEN' did not resolve to a value\)/)
      return true
    })
    // The plugin is still healthy: the resolvable label answers.
    const ok = (await provider?.list({ label: 'work' }, { limit: 1 })) as Record<string, unknown>[]
    assert.equal(ok.length, 1)
  })
})

test('a row missing parts is reported as not configured instead of failing the load', async () => {
  await withServer(twilioHandler, async (base) => {
    const { ctx, registered } = makeContext()
    await apply(ctx as never, {
      numbers: {
        incomplete: { number: '+15551234567', apiBase: base },
        personal: { number: '+15551234567', accountSid: 'ACtest', authToken: 'TWILIO_PERSONAL_TOKEN', apiBase: base },
      },
    } as never)
    const numbers = (await registered[0]?.numbers()) as Record<string, unknown>[]
    assert.equal(numbers[0]?.configured, false)
    assert.equal(numbers[1]?.configured, true, 'the default falls back to the first usable row')
    // The call fails on the FIRST missing part, naming the reason without a value.
    await assert.rejects(
      async () => await registered[0]?.list({ label: 'incomplete' }, { limit: 1 }),
      /number 'incomplete' is not configured \(the row declares no 'accountSid'\)/,
    )
    const ok = (await registered[0]?.list({ label: 'personal' }, { limit: 1 })) as Record<string, unknown>[]
    assert.equal(ok.length, 1)
  })
})

test('the pure helpers agree with the contract', () => {
  assert.equal(credentialRefName('${cred:TWILIO_WORK_TOKEN}'), 'TWILIO_WORK_TOKEN')
  assert.equal(credentialRefName('${cred:scope/NAME}'), 'scope/NAME')
  assert.equal(credentialRefName('ACtest'), undefined)
  assert.equal(credentialRefName('${cred:}'), undefined)
  assert.equal(maskValue('ACtest123'), 'ACte**** (redacted)')
  assert.equal(maskValue('abc'), '**** (redacted)')
  assert.equal(isoDate('Fri, 19 Sep 2026 10:00:00 +0000'), '2026-09-19T10:00:00.000Z')
  assert.equal(isoDate('not a date'), '')
  assert.equal(capBody('x'.repeat(2100)).length, 2000 + '...[truncated]'.length)
  assert.equal(clampInteger(0, 8, 60), 8)
  assert.equal(clampInteger(999, 8, 60), 60)
  assert.equal(normalizeLimit(undefined), 10)
  assert.equal(normalizeLimit(1000), 100)
  assert.throws(() => normalizeLimit(0), /positive integer/)
  assert.equal(refLabel({ label: ' work ' }), 'work')
  assert.equal(refLabel(undefined), '')
  assert.deepEqual(
    normalizeNumbers({ numbers: { personal: { number: '+1555', apiBase: `${'http://x'}/` } } }).map((entry) => entry.apiBase),
    ['http://x'],
  )
  const error = backendError('personal', 500, '')
  assert.equal(error.name, 'SmsBackendError')
  assert.match(error.message, /HTTP 500$/)
})
