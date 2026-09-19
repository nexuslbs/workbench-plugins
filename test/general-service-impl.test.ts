// Unit tests for plugins/general-service-impl (the `general-service@1`
// PROVIDER): the PARAMS of a config row MUST REACH the transport the type names.
//
// The regression this file pins: `dispatch` used to call the PROVIDER-ROW handle
// (`shell.run` / `docker.run` / `ssh.run` / `http.call`) and dropped the validated
// params, so a config naming a different/unreachable target silently ran against
// the provider's own row - the silent fallback R2-5 / R12-30 forbid.
//
// Two ends of the seam are faked here: a transport whose `create(config)` records
// the config it received (the INSTANCE API of the Definition) and the provider's
// OWN row handle. A params-carrying config must go through `create()` and NEVER
// through the row handle; a config with no params has nothing to bind and may use
// the row; a provider WITHOUT an instance API must fail loudly, at create() time.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createGeneralService, providerId } from '../plugins/general-service-impl/index.ts'
import { GENERAL_SERVICE_CONTRACT } from '../definitions/general-service.ts'
import { ServiceError, type CommandResult, type ServiceContext } from '../definitions/support.ts'

interface Call {
  input: string
  options: Record<string, unknown> | undefined
}

interface HttpAnswer {
  status: number
  body: string
  headers: Record<string, string>
  durationMs: number
}

/** What a fake transport observed: the create() configs, the row calls, the bound calls. */
interface Recorder {
  created: unknown[]
  row: Call[]
  bound: Call[]
  result: CommandResult
  http: HttpAnswer
}

function recorder(): Recorder {
  return {
    created: [],
    row: [],
    bound: [],
    result: { output: 'ok', code: 0, durationMs: 1 },
    http: { status: 200, body: 'row', headers: {}, durationMs: 1 },
  }
}

/** A shape-compatible transport service: a row handle plus the instance API. */
function transport(contract: string, provider: string, rec: Recorder, withCreate = true): Record<string, unknown> {
  const service: Record<string, unknown> = {
    contract,
    provider,
    run: async (input: string, options?: Record<string, unknown>) => {
      rec.row.push({ input, options })
      return rec.result
    },
    call: async (input: string, options?: Record<string, unknown>) => {
      rec.row.push({ input, options })
      return rec.http
    },
  }
  if (withCreate) {
    service.create = (config: unknown) => {
      rec.created.push(config)
      return {
        contract,
        provider,
        run: async (input: string, options?: Record<string, unknown>) => {
          rec.bound.push({ input, options })
          return rec.result
        },
        call: async (input: string, options?: Record<string, unknown>) => {
          rec.bound.push({ input, options })
          return rec.http
        },
      }
    }
  }
  return service
}

/** A structural cordis context holding exactly the services under test. */
function context(services: Record<string, unknown>): ServiceContext {
  return {
    get: (name: string) => services[name],
    provide: (name: string, value: unknown) => {
      services[name] = value
      return value
    },
  }
}

function isCode(error: unknown, code: string): error is ServiceError {
  return error instanceof ServiceError && error.code === code
}

test('container: params.compose binds the docker INSTANCE (create), never the provider row', async () => {
  const rec = recorder()
  const general = createGeneralService(context({ docker: transport('docker@1', 'fake-docker', rec) }))
  assert.equal(general.provider, providerId)
  assert.equal(general.contract, GENERAL_SERVICE_CONTRACT)

  const params = { engine: 'docker-compose', compose: { project_dir: '/opt/omni', service: 'toolbox' } }
  const instance = general.create({ type: 'container', params })
  // The params are APPLIED at creation: the transport's own instance API sees them.
  assert.deepEqual(rec.created, [params])
  assert.equal(rec.bound.length, 0)

  const result = await instance.call('himalaya --version')
  assert.equal(result.type, 'container')
  assert.equal(result.output, 'ok')
  assert.deepEqual(rec.bound.map((call) => call.input), ['himalaya --version'])
  // A params-carrying config NEVER runs against the provider's own target.
  assert.deepEqual(rec.row, [])
})

test('container: a config naming an unusable service reaches the transport as-is (it decides, not us)', async () => {
  const rec = recorder()
  const general = createGeneralService(context({ docker: transport('docker@1', 'fake-docker', rec) }))
  const params = { engine: 'docker-compose', compose: { project_dir: '/opt/omni', service: 'gsi-nope' } }
  const instance = general.create({ type: 'container', params })
  assert.deepEqual(rec.created, [params])
  await instance.call('true')
  assert.deepEqual(rec.row, [])
  assert.deepEqual(rec.bound.map((call) => call.input), ['true'])
})

test('local: params.binary/timeoutMs/maxOutputBytes bind the shell instance and per-call options win', async () => {
  const rec = recorder()
  const general = createGeneralService(context({ shell: transport('shell@1', 'fake-local', rec) }))
  const params = { binary: '/bin/zsh', timeoutMs: 900, maxOutputBytes: 128 }
  const instance = general.create({ type: 'local', params })
  assert.deepEqual(rec.created, [params])

  await instance.call('sleep 3', { timeoutMs: 250 })
  // The bound config is created ONCE; the per-call options travel verbatim, so the
  // provider's own precedence (`options.timeoutMs ?? config.timeoutMs`) applies.
  assert.deepEqual(rec.bound, [{ input: 'sleep 3', options: { timeoutMs: 250 } }])
  await instance.call('echo hi')
  assert.equal(rec.created.length, 1)
  assert.deepEqual(rec.bound.map((call) => call.input), ['sleep 3', 'echo hi'])
  assert.deepEqual(rec.row, [])
})

test('a config with NO params has nothing to bind: the provider row serves the call', async () => {
  const rec = recorder()
  const instance = createGeneralService(context({ shell: transport('shell@1', 'fake-local', rec) })).create({
    type: 'local',
    params: {},
  })
  assert.deepEqual(rec.created, [])
  await instance.call('echo hi')
  assert.deepEqual(rec.row.map((call) => call.input), ['echo hi'])
})

test('a params-carrying config whose provider has NO instance API fails LOUDLY at create()', () => {
  const rec = recorder()
  const general = createGeneralService(context({ shell: transport('shell@1', 'no-instance', rec, false) }))
  assert.throws(
    () => general.create({ type: 'local', params: { binary: '/bin/zsh' } }),
    (error: unknown) => isCode(error, 'unsupported-provider') && /no instance API/.test(error.message),
  )
  // Nothing ran, and nothing was bound: the failure is BEFORE any call.
  assert.deepEqual(rec.row, [])
  assert.deepEqual(rec.created, [])
})

test('ssh: params.host binds the ssh instance (the config row names the machine)', async () => {
  const rec = recorder()
  const general = createGeneralService(context({ ssh: transport('ssh@1', 'fake-ssh', rec) }))
  const params = { host: 'root@127.0.0.1:2223', binary: 'ssh' }
  const instance = general.create({ type: 'ssh', params })
  assert.deepEqual(rec.created, [params])
  await instance.call('hostname')
  assert.deepEqual(rec.bound.map((call) => call.input), ['hostname'])
  assert.deepEqual(rec.row, [])
})

test('ssh+container: the ssh params bind the ssh instance and the container params build the remote launcher', async () => {
  const rec = recorder()
  const dockerRec = recorder()
  const general = createGeneralService(
    context({ ssh: transport('ssh@1', 'fake-ssh', rec), docker: transport('docker@1', 'fake-docker', dockerRec) }),
  )
  const params = {
    ssh: { host: 'root@jump.test:2222' },
    container: { engine: 'docker-compose', compose: { project_dir: '/opt/omni', service: 'toolbox' } },
  }
  const instance = general.create({ type: 'ssh+container', params })
  // The ssh half reaches the ssh transport's instance API verbatim; the LOCAL
  // docker service is loaded (TRANSPORT_SERVICES maps ssh+container to ssh+docker)
  // but is NOT used for the call: the launcher comes from params.container and is
  // evaluated on the REMOTE machine.
  assert.deepEqual(rec.created, [params.ssh])
  assert.deepEqual(dockerRec.created, [])

  await instance.call('echo hi > /tmp/gsi-probe && cat /tmp/gsi-probe')
  assert.equal(rec.bound.length, 1)
  const remote = rec.bound[0]?.input ?? ''
  // The remote machine receives the docker launcher as ONE string, built from
  // params.container (never from a provider row), and the container's shell gets
  // the caller's input ONCE.
  assert.ok(remote.startsWith("'docker' 'compose' '--project-directory' '/opt/omni'"), remote)
  assert.ok(remote.includes("'exec' '-T' 'toolbox' 'sh' '-c' 'echo hi > /tmp/gsi-probe && cat /tmp/gsi-probe'"), remote)
  assert.deepEqual(rec.row, [])
  // The local docker provider row was never reached (the remote docker runs remotely).
  assert.deepEqual(dockerRec.row, [])
})

test('http: params.url/method/headers bind the http instance; the input is the request body', async () => {
  const rec = recorder()
  rec.http = { status: 201, body: 'pong', headers: { 'x-answer': '1' }, durationMs: 2 }
  const general = createGeneralService(context({ http: transport('http@1', 'fake-fetch', rec) }))
  const params = { url: 'http://127.0.0.1:12549/echo', method: 'PUT', headers: { 'x-test': 'yes' } }
  const instance = general.create({ type: 'http', params })
  assert.deepEqual(rec.created, [params])

  const result = await instance.call('BODY-TEXT')
  assert.deepEqual(rec.bound, [{ input: 'BODY-TEXT', options: undefined }])
  assert.equal(result.type, 'http')
  assert.equal(result.output, 'pong')
  assert.equal(result.code, 201)
  assert.equal(result.status, 201)
  assert.deepEqual(result.headers, { 'x-answer': '1' })
  assert.deepEqual(rec.row, [])
})

test('a missing transport service and an unknown type keep their named, pre-call failures', () => {
  const general = createGeneralService(context({}))
  assert.throws(
    () =>
      general.create({
        type: 'container',
        params: { engine: 'docker-compose', compose: { project_dir: '/opt/omni', service: 'toolbox' } },
      }),
    (error: unknown) => isCode(error, 'missing-service') && /'docker' service/.test(error.message),
  )
  assert.throws(
    () => general.create({ type: 'docker', params: {} }),
    (error: unknown) => isCode(error, 'unsupported-type'),
  )
})

test('the one-shot service.call() applies the params exactly like create().call()', async () => {
  const rec = recorder()
  const general = createGeneralService(context({ shell: transport('shell@1', 'fake-local', rec) }))
  const result = await general.call('echo hi', { type: 'local', params: { binary: '/bin/zsh' } })
  assert.deepEqual(rec.created, [{ binary: '/bin/zsh' }])
  assert.deepEqual(rec.bound.map((call) => call.input), ['echo hi'])
  assert.deepEqual(rec.row, [])
  assert.equal(result.output, 'ok')
})
