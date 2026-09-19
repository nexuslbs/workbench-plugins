// Unit test for the `himalaya@1` PROVIDER driver (plugins/himalaya-impl).
//
// REGRESSION GUARD 1: the command line handed to the general service MUST be
// complete, i.e. it MUST start with the himalaya binary. The general service
// hands the input to the shell of the TARGET (container / ssh'd machine)
// exactly once (`sh -c <input>`), so a bare `account list -o json` is not a
// command there - the live gate failed with `sh: account: not found` /
// `sh: -a: not found` before this was fixed.
//
// REGRESSION GUARD 2: himalaya v1.2 declares `-a/--account` on the SUBCOMMANDS,
// not globally: the live gate failed with
// `envelope list -o json --page-size 5 ... unexpected argument '-a' found`
// while the flag sat before the command. It belongs in the subcommand option
// list, before the positional query.
//
// The general service is a FAKE here: every assertion is about the argv the
// driver BUILDS and the output it PARSES, never about a binary or a transport.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_BINARY,
  buildArgv,
  buildRunArgv,
  createHimalayaService,
  himalayaBinary,
  parseJson,
  toEnvelope,
  withAccount,
} from '../plugins/himalaya-impl/index.ts'
import type { GeneralServiceInstance } from '../definitions/general-service.ts'
import { ServiceError } from '../definitions/support.ts'

interface FakeGeneral {
  calls: string[]
  instance: GeneralServiceInstance
}

/** A recording FAKE general service: it answers canned output and records the input. */
function fakeGeneral(
  reply: (input: string) => { output: string; code: number | null; stderr?: string } = () => ({ output: '', code: 0 }),
): FakeGeneral {
  const calls: string[] = []
  const instance = {
    call: async (input: string) => {
      calls.push(input)
      return reply(input)
    },
  } as unknown as GeneralServiceInstance
  return { calls, instance }
}

function isStructured(error: unknown, code: string): boolean {
  return error instanceof ServiceError && error.code === code
}

test('withAccount inserts the flag in the SUBCOMMAND option list, never globally', () => {
  assert.deepEqual(withAccount(['envelope', 'list', '-o', 'json'], 'hostinger'), [
    'envelope',
    'list',
    '-a',
    'hostinger',
    '-o',
    'json',
  ])
  // No account -> the list is untouched.
  assert.deepEqual(withAccount(['account', 'list', '-o', 'json'], undefined), ['account', 'list', '-o', 'json'])
})

test('buildArgv builds a COMPLETE command line: the himalaya binary comes first', () => {
  assert.equal(DEFAULT_BINARY, 'himalaya')
  assert.equal(buildArgv({ args: ['account', 'list', '-o', 'json'] }), 'himalaya account list -o json')
  const withAcct = buildArgv({ account: 'hostinger', args: ['envelope', 'list', '-o', 'json', '--page-size', '5'] })
  assert.equal(withAcct, 'himalaya envelope list -a hostinger -o json --page-size 5')
  // REGRESSION: `himalaya -a x envelope list` is rejected by himalaya v1.2.
  assert.equal(withAcct.startsWith('himalaya -a'), false, 'the account flag is NOT a global option')
  assert.equal(withAcct.includes('envelope list -a'), true, 'the flag rides in the subcommand option list')
  // A configured binary (e.g. one outside the target PATH) replaces the name.
  assert.equal(
    buildArgv({ binary: '/usr/local/bin/himalaya', args: ['folder', 'list', '-o', 'json'] }),
    '/usr/local/bin/himalaya folder list -o json',
  )
  // Values with spaces / quotes survive as ONE argument.
  assert.equal(
    buildArgv({ args: ['envelope', 'list', '-o', 'json', 'from acme'] }),
    "himalaya envelope list -o json 'from acme'",
  )
})

test('buildRunArgv appends an already-built fragment verbatim after binary + subcommand flag', () => {
  const argv = buildRunArgv({ account: 'hostinger', args: "message send 'MESSAGE BODY'" })
  assert.equal(argv, "himalaya message send -a hostinger 'MESSAGE BODY'")
  assert.equal(argv.startsWith('himalaya -a'), false, 'the binary is NOT part of the fragment, nor is a global -a')
  // Without an account the fragment travels untouched, binary first.
  assert.equal(buildRunArgv({ args: "message send 'x'" }), "himalaya message send 'x'")
})

test('himalayaBinary: a plain name or path is accepted, anything shell-active is rejected', () => {
  assert.equal(himalayaBinary(undefined), 'himalaya')
  assert.equal(himalayaBinary('  '), 'himalaya')
  assert.equal(himalayaBinary('/opt/bin/himalaya'), '/opt/bin/himalaya')
  for (const bad of ['himalaya; rm -rf /', 'himalaya | cat', '$(id)', 'a b']) {
    assert.throws(
      () => himalayaBinary(bad),
      (error: unknown) => isStructured(error, 'invalid-config'),
      `'${bad}' must be rejected`,
    )
  }
})

test('the typed actions send the binary + account + options, and parse the JSON answer', async () => {
  const general = fakeGeneral((input) => {
    if (input.includes('account list')) {
      return { output: JSON.stringify([{ name: 'hostinger', backend: 'imap', default: true }]), code: 0 }
    }
    if (input.includes('envelope list')) {
      return {
        output: JSON.stringify([
          { id: '42', flags: ['Seen'], subject: 'Hi', from: { addr: 'a@b.test' }, to: [{ addr: 'c@d.test' }], date: '2026-09-19T09:00:00Z' },
        ]),
        code: 0,
      }
    }
    // `message read -o json` answers a JSON STRING containing a JSON document.
    return { output: JSON.stringify(JSON.stringify({ text: 'Your code is 123456' })), code: 0 }
  })
  const service = createHimalayaService(general.instance)

  assert.deepEqual(await service.accounts(), [{ name: 'hostinger', backend: 'imap', default: true }])
  assert.equal(general.calls[0], 'himalaya account list -o json')

  const envelopes = await service.envelopeList({ account: 'hostinger', pageSize: 5 })
  assert.equal(general.calls[1], 'himalaya envelope list -a hostinger -o json --page-size 5')
  assert.equal(envelopes[0]?.id, '42')
  assert.equal(envelopes[0]?.from, 'a@b.test')
  assert.equal(envelopes[0]?.to, 'c@d.test')

  const message = await service.messageRead({ account: 'hostinger', id: '42' })
  assert.equal(general.calls[2], 'himalaya message read -a hostinger -o json 42')
  assert.equal(message.text, 'Your code is 123456')
})

test('run() prepends the binary to the caller fragment: the account travels as a field', async () => {
  const general = fakeGeneral(() => ({ output: 'message sent', code: 0 }))
  const service = createHimalayaService(general.instance)
  const result = await service.run({ account: 'hostinger', args: "message send 'To: hermes@nexuslbs.org'" })
  assert.equal(result.output, 'message sent')
  assert.equal(general.calls[0], "himalaya message send -a hostinger 'To: hermes@nexuslbs.org'")
})

test('a non-zero exit is a structured error naming the command, never a crash', async () => {
  const general = fakeGeneral(() => ({ output: '', code: 127, stderr: 'sh: account: not found' }))
  const service = createHimalayaService(general.instance)
  await assert.rejects(
    () => service.accounts(),
    (error: unknown) =>
      isStructured(error, 'non-zero-exit') && (error as ServiceError).message.includes('sh: account: not found'),
  )
})

test('parseJson honours the message-read JSON-string quirk and rejects malformed output', () => {
  assert.deepEqual(parseJson('{"a":1}', 'x'), { a: 1 })
  assert.deepEqual(parseJson('"{\\"b\\":2}"', 'x'), { b: 2 })
  assert.throws(() => parseJson('', 'x'), (error: unknown) => isStructured(error, 'malformed-output'))
  assert.throws(() => parseJson('not json at all', 'x'), (error: unknown) => isStructured(error, 'malformed-output'))
})

test('toEnvelope maps the CLI JSON shape (the wrapper is a named field: has_attachment)', () => {
  const envelope = toEnvelope({
    id: '159',
    flags: ['Seen'],
    subject: 'Log in via link',
    from: { name: 'Discourse Meta', addr: 'notifications@meta.discoursemail.com' },
    to: { name: null, addr: 'hermes@nexuslbs.org' },
    date: '2026-09-17 20:20+00:00',
    has_attachment: false,
  })
  assert.equal(envelope.id, '159')
  assert.equal(envelope.from, 'notifications@meta.discoursemail.com')
  assert.equal(envelope.to, 'hermes@nexuslbs.org')
  assert.deepEqual(envelope.flags, ['Seen'])
  assert.equal(envelope.hasAttachment, false)
})
