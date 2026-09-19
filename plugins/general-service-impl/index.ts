// plugins/general-service-impl - the `general-service@1` PROVIDER
// (`config-dispatch`): ONE service whose CONFIG chooses the transport.
//
// The operator's design (telegram thread 2440): there must NOT be one plugin per
// transport, and the implementation must NOT hard-inject the transports - a
// `ssh` config must work while no docker/container service is loaded, and vice
// versa. So this provider:
//
//   1. resolves the transport SERVICE named by the config TYPE at call time,
//      through the non-strict, config-driven lookup (`ctx.get(name, false)`);
//   2. NEVER imports a transport provider, only its Definition;
//   3. fails LOUDLY when the type's service is not loaded (`missing-service`,
//      naming the service) or when the type is unknown (`unsupported-type`),
//      BEFORE any command runs - `create()` validates, so a consumer such as
//      plugins/himalaya-impl fails to load instead of failing per call;
//   4. never falls back to another transport, and never to the host.
//
//   local         -> ctx.shell
//   container     -> ctx.docker
//   ssh           -> ctx.ssh
//   ssh+container -> ctx.ssh + ctx.docker (the docker launcher runs on the
//                    REMOTE machine; the remote shell is the only evaluator)
//   http          -> ctx.http (the input is the request body; no shell)
//
// LOAD ORDERING: `apply()` waits (SOFT and BOUNDED, `waitForServices`) for the
// transports that COULD be used, then provides the service. The wait is an
// ordering hint: a transport that never loads does not block this plugin, it
// only makes the configs that need it fail with a named error.
import {
  GENERAL_SERVICE,
  GENERAL_SERVICE_CONTRACT,
  GENERAL_SERVICE_TYPES,
  TRANSPORT_SERVICES,
  generalResultFromCommand,
  generalResultFromHttp,
  normalizeGeneralServiceConfig,
  type GeneralCallOptions,
  type GeneralCallResult,
  type GeneralService,
  type GeneralServiceConfig,
  type GeneralServiceInstance,
  type GeneralServiceType,
} from '../../definitions/general-service.ts'
import {
  DOCKER,
  planRemoteDocker,
  validateDockerConfig,
  type DockerConfig,
  type DockerService,
} from '../../definitions/docker.ts'
import { HTTP, validateHttpConfig, type HttpConfig, type HttpService } from '../../definitions/http.ts'
import { SHELL, validateShellConfig, type ShellConfig, type ShellService } from '../../definitions/shell.ts'
import { SSH, validateSshConfig, type SshConfig, type SshService } from '../../definitions/ssh.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  messageOf,
  provideService,
  serviceOf,
  waitForServices,
  type ServiceContext,
} from '../../definitions/support.ts'

export const name = 'general-service-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'config-dispatch'

export const contract = GENERAL_SERVICE_CONTRACT

/** Default bound of the soft "load after" wait (ms). */
export const DEFAULT_LOAD_AFTER_MS = 500

export interface GeneralServiceImplConfig {
  /** Bound of the soft, non-required load-after wait for the transports (ms). */
  loadAfterTimeoutMs?: number
}

/** All transport service names this provider can possibly dispatch to. */
export const POSSIBLE_SERVICES: readonly string[] = [
  ...new Set(GENERAL_SERVICE_TYPES.flatMap((type) => [...TRANSPORT_SERVICES[type]])),
]

/** The params of a type, validated eagerly (a bad config fails at create()). */
function validateParams(type: GeneralServiceType, params: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'local':
      validateShellConfig(params)
      return params
    case 'container':
      validateDockerConfig(params)
      return params
    case 'ssh':
      validateSshConfig(params)
      return params
    case 'ssh+container': {
      const ssh = params.ssh
      const container = params.container
      if (ssh === undefined || container === undefined) {
        throw new ServiceError(
          'invalid-config',
          "general-service: the 'ssh+container' type needs 'params.ssh' and 'params.container'",
          { stage: 'general-service.validate' },
        )
      }
      validateSshConfig(ssh)
      // The remote docker must be compose capable: project_dir + service.
      const docker = container as Record<string, unknown>
      const composeLike = { ...docker, engine: docker.engine ?? 'docker-compose' }
      validateDockerConfig(composeLike)
      return params
    }
    case 'http':
      validateHttpConfig(params)
      return params
    default:
      throw new ServiceError('unsupported-type', `general-service: unsupported type '${String(type)}'`, {
        stage: 'general-service.validate',
      })
  }
}

/** Asserts that every service the type needs is loaded (never a silent fallback). */
function assertServicesLoaded(ctx: ServiceContext, type: GeneralServiceType): void {
  for (const service of TRANSPORT_SERVICES[type]) {
    if (serviceOf(ctx, service) === undefined) {
      throw new ServiceError(
        'missing-service',
        `general-service: the config type '${type}' needs the '${service}' service, which is not loaded ` +
          `(enable a plugin providing ${service}@1); no other transport is used as a fallback`,
        { stage: 'general-service.create', details: { type, missing: service } },
      )
    }
  }
}

/** Dispatches ONE command string to the transport the type names. */
async function dispatch(
  ctx: ServiceContext,
  type: GeneralServiceType,
  params: Record<string, unknown>,
  input: string,
  options: GeneralCallOptions | undefined,
): Promise<GeneralCallResult> {
  switch (type) {
    case 'local': {
      const shell = serviceOf<ShellService>(ctx, SHELL) as ShellService
      return generalResultFromCommand(await shell.run(input, options), type)
    }
    case 'container': {
      const docker = serviceOf<DockerService>(ctx, DOCKER) as DockerService
      return generalResultFromCommand(await docker.run(input, options), type)
    }
    case 'ssh': {
      const ssh = serviceOf<SshService>(ctx, SSH) as SshService
      return generalResultFromCommand(await ssh.run(input, options), type)
    }
    case 'ssh+container': {
      const ssh = serviceOf<SshService>(ctx, SSH) as SshService
      const sshConfig = validateSshConfig(params.ssh)
      const dockerConfig = validateDockerConfig({ ...(params.container as Record<string, unknown>) })
      // The docker launcher is assembled HERE, as a string, and handed to the
      // ssh service as its command: it is evaluated on the REMOTE machine only.
      const remoteCommand = planRemoteDocker(
        { ...dockerConfig, engine: 'docker-compose' },
        input,
      )
      void sshConfig
      return generalResultFromCommand(await ssh.run(remoteCommand, options), type)
    }
    case 'http': {
      const http = serviceOf<HttpService>(ctx, HTTP) as HttpService
      return generalResultFromHttp(await http.call(input, options), type)
    }
    default:
      throw new ServiceError('unsupported-type', `general-service: unsupported type '${String(type)}'`, {
        stage: 'general-service.dispatch',
      })
  }
}

/** A transport-level failure carries the command output: keep it, structured. */
function failure(
  error: unknown,
  type: GeneralServiceType,
  stage: string,
): never {
  if (error instanceof ServiceError) {
    throw new ServiceError(error.code, error.message, { stage, details: { ...error.details, type } })
  }
  throw new ServiceError('non-zero-exit', messageOf(error), { stage, details: { type } })
}

/** Builds the service of this provider. */
export function createGeneralService(ctx: ServiceContext, config: GeneralServiceImplConfig = {}): GeneralService {
  void config

  const createInstance = (raw: GeneralServiceConfig): GeneralServiceInstance => {
    const { type, params } = normalizeGeneralServiceConfig(raw)
    assertServicesLoaded(ctx, type)
    const validated = validateParams(type, params)
    return {
      contract: GENERAL_SERVICE_CONTRACT,
      provider: providerId,
      type,
      call: async (input, options) => {
        if (typeof input !== 'string') {
          throw new ServiceError('invalid-input', 'general-service: the command input must be a string', {
            stage: 'general-service.call',
          })
        }
        try {
          const result = await dispatch(ctx, type, validated, input, options)
          return result
        } catch (error) {
          if (error instanceof ServiceError && (error.code === 'missing-service' || error.code === 'unsupported-type')) throw error
          failure(error, type, 'general-service.call')
        }
      },
    }
  }

  return {
    contract: GENERAL_SERVICE_CONTRACT,
    provider: providerId,
    describe: () =>
      `config-dispatch (${POSSIBLE_SERVICES.map((service) => (serviceOf(ctx, service) === undefined ? `-${service}` : `+${service}`)).join(' ')})`,
    create: createInstance,
    call: (input, config, options) => createInstance(config).call(input, options),
  }
}

export async function apply(ctx: ServiceContext, config: GeneralServiceImplConfig = {}): Promise<void> {
  assertPolicyDeclared(import.meta.url, { execution: 'remote', capabilities: [GENERAL_SERVICE] })
  const timeoutMs = config.loadAfterTimeoutMs ?? DEFAULT_LOAD_AFTER_MS
  const report = await waitForServices(ctx, POSSIBLE_SERVICES, { timeoutMs, pollMs: 25 })
  const service = createGeneralService(ctx, config)
  provideService(ctx, GENERAL_SERVICE, service)
  // The report is informational: transports that are not loaded are NOT an error
  // here - only a config that NEEDS them fails, with the missing service named.
  if (report.missing.length > 0) {
    // The CLI context carries no `logger` service (the core ships none), so the
    // load-order report must ALSO reach stderr: the boot log is what operators
    // and the gates read. It stays INFORMATIONAL - a missing transport is not a
    // failure here, only a config that NEEDS it fails (with the service named).
    const line =
      `general-service-impl: loaded after ${report.loaded.length}/${POSSIBLE_SERVICES.length} transports ` +
      `(missing: ${report.missing.join(', ')}); configs needing a missing transport fail with a named error`
    console.error(line)
  }
}

export default { name, inject: [], apply }
