// core/http-impl - the `http@1` PROVIDER (`fetch`): HTTP calls, NO SHELL.
//
// The input is the request BODY; the answer is the response. There is no argv,
// no quoting and no shell of any kind - which is what makes the `http` type of
// `general-service@1` the transport a caller uses when it must not reach a
// command line at all.
//
// A credential NAME (`credential`) is resolved at call time through the
// credentials capability and sent as `Authorization: Bearer <value>`; the value
// is never logged, never returned and never put in an error (a network failure
// reports the URL only).
import {
  HTTP,
  HTTP_CONTRACT,
  validateHttpConfig,
  type HttpCallOptions,
  type HttpConfig,
  type HttpInstance,
  type HttpResult,
  type HttpService,
  type NormalizedHttpConfig,
} from '../../definitions/http.ts'
import {
  ServiceError,
  assertPolicyDeclared,
  capText,
  credentialsOf,
  messageOf,
  provideService,
  type ServiceContext,
} from '../../definitions/support.ts'

export const name = 'http-impl'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'fetch'

export const contract = HTTP_CONTRACT

/** Builds the service of this provider for a validated config. */
export function createHttpService(config: HttpConfig, ctx?: ServiceContext): HttpService {
  const normalized = validateHttpConfig(config)

  const callWith = async (
    body: string,
    options: HttpCallOptions = {},
    bound: NormalizedHttpConfig = normalized,
  ): Promise<HttpResult> => {
    const headers: Record<string, string> = { ...bound.headers, ...(options.headers ?? {}) }
    if (bound.credential !== undefined) {
      const credentials = ctx === undefined ? undefined : credentialsOf(ctx)
      if (credentials === undefined) {
        throw new ServiceError(
          'credential-unsupported',
          `http: '${bound.credential}' is a credential NAME but this deployment has no credentials capability`,
          { stage: 'http.credentials', details: { credential: bound.credential } },
        )
      }
      const resolution = await credentials.resolve({ name: bound.credential })
      if (resolution?.value === undefined) {
        throw new ServiceError('credential-unsupported', `http: credential '${bound.credential}' resolved to no value`, {
          stage: 'http.credentials',
          details: { credential: bound.credential },
        })
      }
      headers.Authorization = `Bearer ${resolution.value}`
    }
    const timeoutMs = options.timeoutMs ?? bound.timeoutMs
    const maxBodyBytes = options.maxBodyBytes ?? bound.maxBodyBytes
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(bound.url, {
        method: (options.method ?? bound.method).toUpperCase(),
        headers,
        body,
        signal: controller.signal,
      })
      const text = await response.text()
      const capped = capText(text, maxBodyBytes)
      const flat: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        flat[key] = value
      })
      return {
        status: response.status,
        body: capped.text,
        headers: flat,
        durationMs: Date.now() - started,
        ...(capped.truncated ? { truncated: true } : {}),
      }
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new ServiceError('timeout', `http: '${bound.url}' exceeded its ${timeoutMs}ms timeout`, {
          stage: 'http.call',
          details: { url: bound.url, timeoutMs },
        })
      }
      throw new ServiceError('unreachable', `http: cannot reach '${bound.url}': ${messageOf(error)}`, {
        stage: 'http.call',
        details: { url: bound.url },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  const create = (raw: HttpConfig): HttpInstance => {
    const child = validateHttpConfig(raw)
    return {
      contract: HTTP_CONTRACT,
      provider: providerId,
      call: (body, options) => callWith(body, options, child),
    }
  }

  return {
    contract: HTTP_CONTRACT,
    provider: providerId,
    describe: () => `${normalized.method} ${normalized.url}`,
    call: callWith,
    create,
  }
}

export function apply(ctx: ServiceContext, config: HttpConfig): void {
  assertPolicyDeclared(import.meta.url, { execution: 'none', capabilities: [HTTP] })
  const service = createHttpService(config, ctx)
  provideService(ctx, HTTP, service)
}

export default { name, inject: [], apply }
