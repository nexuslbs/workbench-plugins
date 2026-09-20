// Unit tests for the transport/service DEFINITIONS of this repository.
//
// The launcher argv of every transport is a PURE function of (config, input)
// (`planLocal` / `planSsh` / `planSshCommand` / `planContainer` /
// `planDockerCommand` / `planRemoteDocker`), so the SHELL-SAFETY INVARIANT is
// asserted here WITHOUT spawning anything: the caller's command string is one
// argv ELEMENT handed to the TARGET shell (`sh -c <input>` inside the container
// or on the remote machine), never a host-side `sh -c` over a split string.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  GENERAL_SERVICE_TYPES,
  TRANSPORT_SERVICES,
  isGeneralServiceType,
  normalizeGeneralServiceConfig,
  transportServicesFor,
} from '../definitions/general-service.ts'
import { containerCommandArgv, validateDockerConfig, planContainer, planDockerCommand, planRemoteDocker } from '../definitions/docker.ts'
import { validateHttpConfig } from '../definitions/http.ts'
import { planLocal, validateShellConfig } from '../definitions/shell.ts'
import { planRemoteCommand, planSsh, planSshCommand, validateSshConfig } from '../definitions/ssh.ts'
import { ServiceError, shellQuote } from '../definitions/support.ts'

/** A command with pipes, redirections, quotes, `$`, `;`, `&&` and globs. */
const HOSTILE = `echo "hi $USER" | tr a-z A-Z > /tmp/gsi-probe && cat /tmp/gsi-probe; rm -f /tmp/*probe`

/** The argv slice that runs INSIDE the target: the container's `sh -c <input>`. */
const CONTAINER_ARGV = ['sh', '-c', HOSTILE]

function isStructured(error: unknown, code: string): boolean {
  return error instanceof ServiceError && error.code === code
}

test('local: `<shell> -c <input>` is the ONLY host-evaluating transport, documented as such', () => {
  const { argv, display } = planLocal({ shell: 'bash' }, HOSTILE)
  assert.deepEqual(argv, ['/bin/bash', '-c', HOSTILE])
  // The input is a single element: the host shell evaluates it exactly once.
  assert.equal(argv[argv.length - 1], HOSTILE)
  assert.ok(display.includes('/bin/bash'))
})

test('container (docker-compose): `docker compose ... exec -T <service> sh -c <input>`', () => {
  const config = validateDockerConfig({
    engine: 'docker-compose',
    compose: { project_dir: '/opt/omni', env_file: '/opt/omni/.env', service: 'toolbox' },
  })
  const { argv, display } = planContainer(config, HOSTILE)
  assert.deepEqual(argv, [
    'docker',
    'compose',
    '--project-directory',
    '/opt/omni',
    '--env-file',
    '/opt/omni/.env',
    'exec',
    '-T',
    'toolbox',
    ...CONTAINER_ARGV,
  ])
  // The container's shell gets the RAW input as ONE element: no host shell ran,
  // and the pipes/quotes/globs are evaluated inside the container.
  assert.deepEqual(argv.slice(-3), CONTAINER_ARGV)
  assert.ok(display.includes('toolbox'))
})

test('container (plain docker engine): `docker exec -i <container> sh -c <input>`', () => {
  const config = validateDockerConfig({ engine: 'docker', container: 'omnidev-toolbox-1' })
  const { argv } = planContainer(config, HOSTILE)
  // `-i` and NOT `-T`: `-T` is a `docker compose exec` flag and plain
  // `docker exec -T` makes the CLI exit 125 before the command runs (regression
  // observed on 2026-09-20 while starting the browser service).
  assert.deepEqual(argv, ['docker', 'exec', '-i', 'omnidev-toolbox-1', ...CONTAINER_ARGV])
  assert.equal(argv.includes('-T'), false)
  const run = planDockerCommand(validateDockerConfig({ engine: 'docker', image: 'alpine' }), CONTAINER_ARGV)
  assert.deepEqual(run.argv, ['docker', 'run', '--rm', '-i', 'alpine', ...CONTAINER_ARGV])
  assert.equal(run.argv.includes('-T'), false)
})

test('ssh: ONE remote command argument, `sh -c <quoted input>`, executed remotely only', () => {
  const config = validateSshConfig({ host: 'deploy@example.test:2222', binary: 'ssh' })
  const { argv } = planSsh(config, HOSTILE)
  assert.equal(argv[0], 'ssh')
  assert.ok(argv.includes('-p') && argv.includes('2222'))
  assert.equal(argv[argv.length - 2], 'deploy@example.test')
  assert.equal(argv[argv.length - 1], planRemoteCommand(HOSTILE))
  assert.equal(argv[argv.length - 1], 'sh -c ' + shellQuote(HOSTILE))
  // No element carries the raw input: the remote shell re-parses the quoting.
  assert.equal(argv.includes(HOSTILE), false)
})

test('ssh: the remote command is a SINGLE argv element (the remote shell must not see it split)', () => {
  const config = validateSshConfig({ host: 'jump.test', privateKeyName: 'DEPLOY_KEY', configFilePath: '/etc/ssh/conf' })
  const { argv } = planSshCommand(config, planRemoteCommand(HOSTILE))
  // Exactly one element after the target carries the command.
  assert.equal(argv.filter((entry) => entry.includes('|')).length, 1)
  assert.equal(argv[argv.length - 1], 'sh -c ' + shellQuote(HOSTILE))
})

test('ssh+container: the remote machine receives the docker launcher as ONE argument', () => {
  const docker = validateDockerConfig({ engine: 'docker-compose', compose: { project_dir: '/opt/omni', service: 'toolbox' } })
  const remote = planRemoteDocker(docker, HOSTILE)
  // Every argv element of the container launcher is single-quoted, so the remote
  // shell rebuilds it verbatim, and the container's `sh -c` gets the caller string.
  assert.deepEqual(
    remote.split(' ').slice(0, 3),
    ["'docker'", "'compose'", "'--project-directory'"],
  )
  assert.ok(remote.endsWith("'-T' 'toolbox' 'sh' '-c' " + shellQuote(HOSTILE)))
  const ssh = validateSshConfig({ host: 'jump.test' })
  const { argv } = planSshCommand(ssh, remote)
  assert.equal(argv[argv.length - 1], remote)
  assert.equal(argv.includes(HOSTILE), false)
})

test('a hostile input NEVER becomes several argv elements, whatever the transport', () => {
  const plans = [
    planLocal({ shell: 'sh' }, HOSTILE).argv,
    planContainer(validateDockerConfig({ engine: 'docker', container: 'c1' }), HOSTILE).argv,
    planSsh(validateSshConfig({ host: 'h.test' }), HOSTILE).argv,
    planDockerCommand(validateDockerConfig({ engine: 'docker', image: 'alpine' }), CONTAINER_ARGV).argv,
  ]
  for (const argv of plans) {
    assert.ok(argv.every((entry) => typeof entry === 'string'))
    // Word splitting would have produced one element per word; the pipes,
    // quotes, `$` and globs all live INSIDE a single element.
    assert.equal(argv.filter((entry) => entry.includes('|')).length, 1)
    assert.equal(argv.filter((entry) => entry.includes('$USER')).length, 1)
  }
  assert.deepEqual(containerCommandArgv(HOSTILE), CONTAINER_ARGV)
})

test('validators reject a structurally invalid config with a structured error', () => {
  assert.throws(() => validateShellConfig(42), (error) => isStructured(error, 'invalid-config'))
  assert.throws(() => validateSshConfig({}), (error) => isStructured(error, 'invalid-config'))
  assert.throws(() => validateSshConfig('nope'), (error) => isStructured(error, 'invalid-config'))
  assert.throws(() => validateDockerConfig({}), (error) => isStructured(error, 'invalid-config'))
  assert.throws(() => validateHttpConfig({}), (error) => isStructured(error, 'invalid-config'))
  assert.throws(
    () => validateSshConfig({ host: 'h.test:0' }),
    (error) => isStructured(error, 'invalid-config'),
  )
})

test('general-service: five types, each mapped to the transport service(s) it needs', () => {
  assert.deepEqual([...GENERAL_SERVICE_TYPES], ['local', 'container', 'ssh', 'ssh+container', 'http'])
  assert.deepEqual(TRANSPORT_SERVICES.local, ['shell'])
  assert.deepEqual(TRANSPORT_SERVICES.container, ['docker'])
  assert.deepEqual(TRANSPORT_SERVICES.ssh, ['ssh'])
  assert.deepEqual([...TRANSPORT_SERVICES['ssh+container']].sort(), ['docker', 'ssh'])
  assert.deepEqual(TRANSPORT_SERVICES.http, ['http'])
  assert.equal(isGeneralServiceType('container'), true)
  assert.equal(isGeneralServiceType('docker'), false)
})

test('general-service: an unknown type is `unsupported-type` BEFORE anything can run', () => {
  assert.throws(() => transportServicesFor('docker'), (error) => isStructured(error, 'unsupported-type'))
  assert.throws(() => transportServicesFor(undefined), (error) => isStructured(error, 'unsupported-type'))
  const normalized = normalizeGeneralServiceConfig({ type: 'ssh', params: { host: 'h.test' } })
  assert.equal(normalized.type, 'ssh')
  assert.deepEqual(normalized.params, { host: 'h.test' })
  assert.throws(
    () => normalizeGeneralServiceConfig({ params: {} }),
    (error) => isStructured(error, 'invalid-config'),
  )
  assert.throws(
    () => normalizeGeneralServiceConfig({ type: 'local', params: 'nope' }),
    (error) => isStructured(error, 'invalid-config'),
  )
})
