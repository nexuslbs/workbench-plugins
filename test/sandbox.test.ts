// test/sandbox.test.ts - the `sandbox@1` seam.
//
// Three layers are covered, in the order the contract defines them:
//   1. the DECISION MATRIX of the pure engine (`definitions/sandbox.ts`),
//      exercised through the declarative provider the rest of the stack uses,
//   2. the ENFORCEMENT PLAN (`buildEnforcementPlan`) against an INJECTED
//      availability report, so every branch (bwrap / unshare / rlimit / gap) is
//      asserted without depending on the machine running the test,
//   3. REAL runs through the enforcing provider (`core/sandbox-enforce`): an
//      allowed command, a denied command (nothing is started), an env that is
//      filtered, a wall-time kill, a CPU rlimit and the output cap - plus the
//      consistency assertion that the MEASURED enforcement matrix matches what
//      the host probe really found (no claim that is not backed by the probe).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_LIMITS,
  SANDBOX_CONTRACT,
  buildEnforcementPlan,
  constraintView,
  describeDecision,
  evaluateSandbox,
  filterSandboxEnv,
  normalizeNetworkRule,
  normalizeSandboxPolicyConfig,
  pathInside,
  policyViews,
  ulimitScript,
} from '../definitions/sandbox.ts'
import type {
  SandboxCommandVerdict,
  SandboxDecision,
  SandboxDecisionOptions,
  SandboxMechanismAvailability,
  SandboxPolicyConfig,
  SandboxRequest,
  SandboxService,
} from '../definitions/sandbox.ts'
import { createSandboxPolicyService, providerId as DECLARATIVE } from '../core/sandbox-policy/index.ts'
import {
  createSandboxEnforceService,
  enforcementRows,
  probeMechanisms,
  providerId as LOCAL_OS,
} from '../core/sandbox-enforce/index.ts'
import { apply as applyFsLocal } from '../core/fs-local/index.ts'
import { FsError, fsOf, sandboxPolicyFrom } from '../definitions/fs.ts'
import { sandboxOf } from '../definitions/subprocess.ts'
import type { ServiceContext } from '../definitions/support.ts'

/** A policy the tests reuse: `/work` is writable, `/work/read` readable, no network. */
const POLICY: SandboxPolicyConfig = {
  source: 'test-policy',
  unconfigured: 'deny',
  defaults: { mode: 'workspace-write', readRoots: ['/work'], network: 'none', env: ['PATH', 'HOME'] },
  resources: {
    fs: { writeRoots: ['/work'], readRoots: ['/work/read'] },
    subprocess: {
      writeRoots: ['/work'],
      allowCommands: ['echo', 'sleep', 'sh'],
      denyCommands: ['rm'],
      limits: { wallTimeMs: 500, maxOutputBytes: 4096 },
    },
    'browser-use': { network: { mode: 'allow-list', hosts: ['example.com'] } },
    'computer-use': { approvalRequired: true },
  },
}

/**
 * The declarative provider, with the SYNCHRONOUS calls these tests make: the
 * contract allows a provider to answer with a promise (the enforcing one
 * does), while the pure engine never does.
 */
type SyncSandbox = Omit<SandboxService, 'check' | 'checkCommand'> & {
  check(request: SandboxRequest, options?: SandboxDecisionOptions): SandboxDecision
  checkCommand(plan: { argv: readonly string[]; shell?: boolean; cwd?: string }): SandboxCommandVerdict
}

const service = (config: SandboxPolicyConfig = POLICY): SyncSandbox => {
  const raw = createSandboxPolicyService(config)
  return {
    ...raw,
    check: (request, options) => raw.check(request, options) as SandboxDecision,
    checkCommand: (plan) => raw.checkCommand!(plan) as SandboxCommandVerdict,
  }
}

test('sandbox: the declarative provider answers the contract and reports its source', () => {
  const sandbox = service()
  assert.equal(sandbox.contract, SANDBOX_CONTRACT)
  assert.equal(sandbox.provider, DECLARATIVE)
  assert.equal(sandbox.activePolicy().source, 'test-policy')
  assert.deepEqual(
    sandbox.activePolicy().resources.map((view) => view.resource),
    ['browser-use', 'computer-use', 'fs', 'subprocess', 'defaults'],
  )
  // No `exec` on a declarative provider: the seam is optional for it.
  assert.equal(sandbox.exec, undefined)
  // `checkCommand` IS implemented by every provider (the subprocess/jobs hook).
  assert.equal(typeof sandbox.checkCommand, 'function')
})

test('sandbox: constraint views narrow the defaults and never widen them', () => {
  const policy = normalizeSandboxPolicyConfig(POLICY, 'unit')
  const fs = constraintView(policy, 'fs')
  assert.equal(fs.from, 'resource')
  assert.equal(fs.mode, 'workspace-write')
  assert.deepEqual([...fs.writeRoots], ['/work'])
  assert.deepEqual([...fs.readRoots], ['/work/read'])
  assert.deepEqual([...fs.env], ['PATH', 'HOME'])
  const other = constraintView(policy, 'jobs')
  assert.equal(other.from, 'defaults', 'a resource without a rule falls back to the defaults')
  assert.deepEqual([...other.readRoots], ['/work'], 'the read roots of the defaults apply to it')
  assert.deepEqual([...other.writeRoots], [], 'the defaults name no write root, so a jobs call may not write')
  const none = constraintView(normalizeSandboxPolicyConfig({}, 'unit'), 'fs')
  assert.equal(none.from, 'unconfigured')
  // A read-only mode removes the write roots entirely (fail-closed by construction).
  const readOnly = constraintView(normalizeSandboxPolicyConfig({ resources: { fs: { mode: 'read-only', writeRoots: ['/work'] } } }), 'fs')
  assert.equal(readOnly.readOnly, true)
  assert.deepEqual([...readOnly.writeRoots], [])
})

test('sandbox: the decision matrix allows inside the roots and denies outside them', () => {
  const sandbox = service()
  const allowed = sandbox.check({ resource: 'fs', operation: 'write', path: '/work/out.txt' })
  assert.equal(allowed.allowed, true)
  const outside = sandbox.check({ resource: 'fs', operation: 'write', path: '/etc/passwd' })
  assert.equal(outside.allowed, false)
  if (outside.allowed) throw new Error('unreachable')
  assert.equal(outside.reason, 'sandbox.outside-roots')
  assert.deepEqual(outside.details['writeRoots'], ['/work'])
  // A read is confined to the (narrower) read roots.
  assert.equal(sandbox.check({ resource: 'fs', operation: 'read', path: '/work/read/a.txt' }).allowed, true)
  const readDenied = sandbox.check({ resource: 'fs', operation: 'read', path: '/work/other.txt' })
  assert.equal(readDenied.allowed, false)
  if (readDenied.allowed) throw new Error('unreachable')
  assert.equal(readDenied.reason, 'sandbox.outside-roots')
  // An fs request WITHOUT an operation counts as a WRITE (fail-closed).
  const noOperation = sandbox.check({ resource: 'fs', path: '/work/read/a.txt' })
  assert.equal(noOperation.allowed, true, '/work/read/a.txt is inside the write root too')
  assert.equal(sandbox.check({ resource: 'fs', path: '/work/read' }).allowed, true)
  // A relative path resolves against `cwd` before it is checked.
  assert.equal(sandbox.check({ resource: 'fs', operation: 'write', path: 'out.txt' }).allowed, false)
  assert.equal(sandbox.check({ resource: 'fs', operation: 'write', path: 'out.txt', cwd: '/work' }).allowed, true)
})

test('sandbox: read-only and deny rules refuse before any path is looked at', () => {
  const readOnly = service({ resources: { fs: { mode: 'read-only' } } })
  const deniedWrite = readOnly.check({ resource: 'fs', operation: 'write', path: '/work/x' })
  assert.equal(deniedWrite.allowed, false)
  if (deniedWrite.allowed) throw new Error('unreachable')
  assert.equal(deniedWrite.reason, 'sandbox.read-only')

  // DENY PRECEDENCE: an explicit `deny` rule wins over a permissive path,
  // and the reason reports the rule, not the path.
  const denied = service({
    resources: { fs: { deny: true, mode: 'danger-full-access', writeRoots: ['/'] } },
  })
  const decision = denied.check({ resource: 'fs', operation: 'write', path: '/tmp/x' })
  assert.equal(decision.allowed, false)
  if (decision.allowed) throw new Error('unreachable')
  assert.equal(decision.reason, 'sandbox.resource-denied')
})

test('sandbox: limits, env, commands, network and approval all deny with a code', () => {
  const sandbox = service()
  const expectReason = (request: Parameters<SandboxService['check']>[0], reason: string, options = {}): void => {
    const decision = evaluateSandbox(request, constraintView(normalizeSandboxPolicyConfig(POLICY), request.resource), options)
    assert.equal(decision.allowed, false, `expected a deny for ${reason}`)
    if (decision.allowed) return
    assert.equal(decision.reason, reason)
    assert.ok(decision.message.length > 0, 'every deny carries a human message')
  }

  expectReason({ resource: 'subprocess', argv: ['echo', 'hi'], wallTimeMs: 10_000 }, 'sandbox.limit-exceeded')
  expectReason({ resource: 'subprocess', argv: ['echo', 'hi'], bytes: 10_000_000 }, 'sandbox.limit-exceeded')
  expectReason({ resource: 'subprocess', argv: ['echo', 'hi'], envNames: ['AWS_SECRET_ACCESS_KEY'] }, 'sandbox.env-denied')
  expectReason({ resource: 'subprocess', argv: ['rm', '-rf', '/'] }, 'sandbox.command-denied')
  expectReason({ resource: 'subprocess', argv: ['curl', 'https://example.com'] }, 'sandbox.command-denied')
  expectReason({ resource: 'browser-use', operation: 'open', network: { host: 'evil.test' } }, 'sandbox.network-denied')
  expectReason({ resource: 'browser-use', operation: 'open', network: true }, 'sandbox.network-denied', {
    approvalGranted: true,
  })
  expectReason({ resource: 'computer-use', operation: 'act' }, 'sandbox.approval-required')
  expectReason({ resource: 'jobs', argv: ['echo', 'x'], cwd: '/etc' }, 'sandbox.outside-roots')
  expectReason({ resource: 'fs', operation: 'read' }, 'sandbox.invalid-request')
  expectReason({ resource: 'subprocess', operation: 'spawn' }, 'sandbox.invalid-request')

  // The approving caller and the allow-listed host both go through.
  assert.equal(sandbox.check({ resource: 'computer-use', operation: 'act' }, { approvalGranted: true }).allowed, true)
  assert.equal(sandbox.check({ resource: 'browser-use', operation: 'open', network: { host: 'api.example.com' } }).allowed, true)
  assert.equal(sandbox.check({ resource: 'subprocess', argv: ['echo', 'hi'], envNames: ['PATH'] }).allowed, true)
  // A subdomain of an allow-listed host is allowed; a look-alike is not.
  assert.equal(sandbox.check({ resource: 'browser-use', operation: 'open', network: { host: 'example.com.evil.test' } }).allowed, false)
})

test('sandbox: the no-policy default is fail-closed and can be configured open', () => {
  const closed = service({})
  const denied = closed.check({ resource: 'fs', operation: 'read', path: '/etc/hosts' })
  assert.equal(denied.allowed, false)
  if (denied.allowed) throw new Error('unreachable')
  assert.equal(denied.reason, 'sandbox.no-policy')
  assert.match(describeDecision(denied), /^DENY fs: sandbox\.no-policy/)

  const open = service({ unconfigured: 'allow' })
  const allowed = open.check({ resource: 'anything', operation: 'do' })
  assert.equal(allowed.allowed, true)
  assert.match(describeDecision(allowed), /^ALLOW anything/)

  // The evaluation-level override exists for a caller that knows its own default.
  const view = constraintView(normalizeSandboxPolicyConfig({}), 'fs')
  assert.equal(evaluateSandbox({ resource: 'fs', operation: 'read', path: '/x' }, view).allowed, false)
  assert.equal(
    evaluateSandbox({ resource: 'fs', operation: 'read', path: '/x' }, view, { unconfigured: 'allow' }).allowed,
    true,
  )
})

test('sandbox: the enforcement plan reflects the MEASURED availability, gaps included', () => {
  const full: SandboxMechanismAvailability = { bwrap: true, unshareNet: true, prlimit: true, shUlimit: true, setpriv: true }
  const bare: SandboxMechanismAvailability = { bwrap: false, unshareNet: false, prlimit: false, shUlimit: false, setpriv: false }
  const constraints = constraintView(
    normalizeSandboxPolicyConfig({ resources: { subprocess: { writeRoots: ['/work'], env: ['PATH'], limits: { cpuSeconds: 5, memoryBytes: 268435456 } } } }),
    'subprocess',
  )
  const planned = buildEnforcementPlan({
    argv: ['echo', 'hi'],
    cwd: '/work',
    env: { PATH: '/usr/bin' },
    constraints,
    availability: full,
  })
  assert.ok(planned.mechanisms.includes('bwrap'))
  assert.ok(planned.argv.includes('bwrap'), 'the mount-namespace mechanism is part of the plan')
  assert.ok(planned.argv.includes('/work'), 'the namespace exposes the granted write root')
  assert.equal(planned.cwd, '/work')
  assert.deepEqual(planned.env, { PATH: '/usr/bin' })
  assert.deepEqual([...planned.gaps], [], 'everything is enforced when the full set is available')

  const degraded = buildEnforcementPlan({
    argv: ['echo', 'hi'],
    cwd: '/work',
    env: { PATH: '/usr/bin' },
    constraints,
    availability: bare,
  })
  assert.ok(degraded.gaps.length > 0, 'a host without any mechanism must REPORT the gap, never hide it')
  assert.ok(!degraded.mechanisms.includes('bwrap'))
})

test('sandbox: env filtering and the ulimit prologue are pure and total', () => {
  assert.deepEqual(filterSandboxEnv({ PATH: '/bin', SECRET: 'x' }, ['PATH']), { PATH: '/bin' })
  // `['*']` means "inherit everything", an empty list means "inherit nothing".
  assert.deepEqual(filterSandboxEnv({ A: '1' }, ['*']), { A: '1' })
  assert.deepEqual(filterSandboxEnv({ A: '1' }, []), {})
  const script = ulimitScript({ cpuSeconds: 2, memoryBytes: 1048576, nofile: 32, maxProcesses: 8 })
  assert.match(script, /ulimit -t 2/)
  assert.match(script, /ulimit -v 1024/)
  assert.match(script, /ulimit -n 32/)
  assert.match(script, /ulimit -u 8/)
  assert.match(script, /exec "\$@"/)
  assert.equal(normalizeNetworkRule('none').mode, 'none')
  assert.deepEqual(normalizeNetworkRule({ hosts: ['a.test'] }), { mode: 'allow-list', hosts: ['a.test'] })
  assert.equal(normalizeNetworkRule(true).mode, 'unrestricted')
  assert.equal(pathInside('/work/a', '/work'), true)
  assert.equal(pathInside('/work/../etc', '/work'), false)
  assert.deepEqual(policyViews(normalizeSandboxPolicyConfig(POLICY)).map((view) => view.resource).pop(), 'defaults')
})

// ---------------------------------------------------------------------------
// The ENFORCING provider: real child processes, real evidence.
// ---------------------------------------------------------------------------

/** The report of the machine running the tests (used for the consistency check). */
const HOST = probeMechanisms()

function enforcing(): SandboxService {
  return createSandboxEnforceService(
    {
      source: 'enforce-test',
      unconfigured: 'deny',
      resources: {
        fs: { mode: 'workspace-write', writeRoots: ['/tmp'], readRoots: ['/tmp/read'] },
        subprocess: {
          writeRoots: ['/tmp'],
          env: ['PATH'],
          allowCommands: ['echo', 'sh', 'sleep'],
          denyCommands: ['rm'],
          limits: { wallTimeMs: 800, cpuSeconds: 2, maxOutputBytes: 256 },
        },
      },
    },
    HOST,
  )
}

test('sandbox-enforce: an ALLOWED run really starts the command under the plan', async () => {
  const sandbox = enforcing()
  assert.equal(sandbox.provider, LOCAL_OS)
  const result = await sandbox.exec!({ argv: ['/bin/echo', 'sandbox-ok'], cwd: '/tmp' })
  assert.equal(result.allowed, true)
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'sandbox-ok')
  assert.equal(result.timedOut, false)
  assert.ok(result.mechanisms.length > 0, 'the result names the mechanisms the run used')
  assert.ok(result.effectiveArgv.length >= 2)
})

test('sandbox-enforce: a DENIED command starts NOTHING and the deny is the answer', async () => {
  const sandbox = enforcing()
  const result = await sandbox.exec!({ argv: ['rm', '-rf', '/tmp/does-not-matter'], cwd: '/tmp' })
  assert.equal(result.allowed, false)
  assert.equal(result.stdout, '')
  assert.equal(result.exitCode, null)
  assert.deepEqual([...result.mechanisms], [])
  assert.ok(result.decision && result.decision.allowed === false)
  if (!result.decision || result.decision.allowed) throw new Error('unreachable')
  assert.equal(result.decision.reason, 'sandbox.command-denied')
  assert.match(result.note ?? '', /nothing was started/)
  // The same deny through the subprocess/jobs hook shape.
  const verdict = await sandbox.checkCommand!({ argv: ['rm', '-rf', '/'] })
  assert.equal(verdict.allowed, false)
  assert.ok((verdict.reason ?? '').length > 0)
  // ... and an allowed command through the same hook.
  const okVerdict = await sandbox.checkCommand!({ argv: ['echo', 'hi'] })
  assert.equal(okVerdict.allowed, true)
})

test('sandbox-enforce: the env allow-list reaches the child (only the NAMES listed)', async () => {
  const sandbox = enforcing()
  const result = await sandbox.exec!({
    argv: ['/bin/sh', '-c', 'echo "[$SECRET][$PATH]"; echo "$SECRET"'],
    cwd: '/tmp',
    env: { SECRET: 'leaked-value', PATH: '/usr/local/bin:/usr/bin:/bin' },
  })
  assert.equal(result.allowed, true)
  assert.ok(!result.stdout.includes('leaked-value'), `the denied NAME must not reach the child: ${result.stdout}`)
  assert.match(result.stdout, /\[\]\[/)
})

test('sandbox-enforce: the wall-time ceiling kills the process GROUP', async () => {
  const sandbox = enforcing()
  const started = Date.now()
  const result = await sandbox.exec!({ argv: ['/bin/sleep', '5'], cwd: '/tmp' })
  const elapsed = Date.now() - started
  assert.equal(result.allowed, true)
  assert.equal(result.timedOut, true, 'the provider applies its own wall-time ceiling')
  assert.equal(result.killed, true)
  assert.ok(elapsed < 4000, `the run must be cut short (took ${elapsed} ms)`)
})

test('sandbox-enforce: the output cap truncates in place and never buffers more', async () => {
  const sandbox = enforcing()
  const result = await sandbox.exec!({
    argv: ['/bin/sh', '-c', 'i=0; while [ $i -lt 2000 ]; do echo "0123456789"; i=$((i+1)); done'],
    cwd: '/tmp',
  })
  assert.equal(result.allowed, true)
  assert.equal(result.truncated, true)
  assert.ok(result.stdout.length <= 300, `the INLINE payload is capped (kept ${result.stdout.length} bytes)`)
  assert.ok(result.stdoutBytes >= result.stdout.length, 'the reported byte count covers what arrived')
})

test('sandbox-enforce: CPU is bounded by an rlimit (prlimit or the shell fallback)', async () => {
  const sandbox = enforcing()
  const started = Date.now()
  const result = await sandbox.exec!({ argv: ['/bin/sh', '-c', 'while :; do :; done'], cwd: '/tmp', timeoutMs: 10_000 })
  const elapsed = Date.now() - started
  const mechanism = (result.mechanisms ?? []).find((id) => id === 'prlimit' || id === 'sh-ulimit')
  if (mechanism === undefined) {
    // No rlimit mechanism on this host: the provider must say so, not pretend.
    const row = (sandbox.enforcement?.()?.constraints ?? []).find((entry) => entry.constraint === 'cpu')
    assert.equal(row?.enforced, 'no')
    assert.ok((sandbox.enforcement?.()?.gaps ?? []).length > 0)
    return
  }
  assert.ok(
    result.timedOut || result.exitCode !== 0 || result.signal !== null,
    `the infinite loop must be stopped (exit=${result.exitCode} signal=${result.signal} timedOut=${result.timedOut})`,
  )
  assert.ok(elapsed < 9000, `the loop must not run for 9 s (took ${elapsed} ms)`)
})

test('sandbox-enforce: the reported matrix matches what the host probe REALLY found', () => {
  const report = probeMechanisms()
  const rows = enforcementRows(report)
  const byId = new Map(rows.map((row) => [row.constraint, row]))
  assert.ok(rows.length >= 8)
  // Every row states an enforcement level; a non-`yes` row MUST cite a gap.
  for (const row of rows) {
    assert.ok(['yes', 'partial', 'no'].includes(row.enforced), `${row.constraint} has an enforcement level`)
    assert.ok((row.note ?? '').length > 0, `${row.constraint} explains itself`)
  }
  const network = byId.get('network')
  assert.equal(network?.enforced === 'yes', report.availability.bwrap || report.availability.unshareNet)
  const cpu = byId.get('cpu')
  assert.equal(cpu?.enforced, report.availability.prlimit || report.availability.shUlimit ? 'yes' : 'no')
  // `shUlimit` is the floor: if even that is absent, the provider reports a gap.
  const report2 = { availability: { bwrap: false, unshareNet: false, prlimit: false, shUlimit: false, setpriv: false }, evidence: {}, output: '' }
  const bare = enforcementRows(report2)
  assert.equal(bare.find((row) => row.constraint === 'cpu')?.mechanism, null)
  assert.equal(bare.find((row) => row.constraint === 'network')?.enforced, 'no')
})

test('sandbox: a provider mounted on `ctx.sandbox` is consumed by the fs and subprocess seams', async () => {
  const sandbox = enforcing()
  // A minimal STRUCTURAL context: `get(name, false)` is the non-strict lookup
  // every seam helper uses, so no cordis host is needed to prove the wiring.
  const ctx = { get: (name: string) => (name === 'sandbox' ? sandbox : undefined) } as unknown as ServiceContext

  // fs@1 hook: the policy narrows the fs roots (FsSandboxPolicy is a subset).
  const fsPolicy = sandboxPolicyFrom(ctx)
  assert.ok(fsPolicy !== undefined)
  assert.deepEqual([...(fsPolicy?.writeRoots ?? [])], ['/tmp'])
  assert.equal(fsPolicy?.readOnly, false)

  // subprocess@1 hook: the verdict this seam returns is honoured (deny = no run).
  const like = sandboxOf(ctx)
  assert.ok(like !== undefined)
  const denied = await like?.checkCommand?.({ argv: ['rm', '-rf', '/'], shell: false, cwd: '/tmp' })
  assert.equal(denied?.allowed, false)
  const allowed = await like?.checkCommand?.({ argv: ['echo', 'hi'], shell: false, cwd: '/tmp' })
  assert.equal(allowed?.allowed, true)

  // A deployment without the provider: the seam is OPTIONAL, the hook is absent.
  assert.equal(sandboxOf({} as unknown as ServiceContext), undefined)
  assert.equal(sandboxPolicyFrom({} as unknown as ServiceContext), undefined)
})

test('sandbox: a policy published AFTER fs-local applied still confines the fs seam (boot order)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sandbox-order-'))
  try {
    const root = path.join(dir, 'root')
    const inside = path.join(root, 'allowed')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(inside, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })

    // A boot-shaped context: `provide` arrives as the loader mounts a plugin,
    // `get(name, false)` is the non-strict lookup every seam helper uses.
    const services = new Map<string, unknown>()
    const ctx = {
      provide: (name: string, value: unknown) => {
        services.set(name, value)
      },
      get: (name: string) => services.get(name),
    } as unknown as ServiceContext

    // 1. fs-local applies FIRST (discovery order: `fs-local` sorts before every
    //    `sandbox-*` directory), while NO sandbox provider is loaded yet.
    applyFsLocal(ctx, { cwd: root, roots: [root] })
    const service = fsOf(ctx)
    assert.ok(service !== undefined, 'fs-local registered its service')
    const before = await service.write({ path: path.join(outside, 'before.txt'), content: 'x' })
    assert.equal(before.created, true, 'with no policy loaded, the configured roots are the only confinement')

    // 2. ONLY NOW the sandbox provider is provided, exactly like a plugin that
    //    applies later in the boot.
    services.set('sandbox', {
      contract: SANDBOX_CONTRACT,
      policyFor: (capability: string) =>
        capability === 'fs' ? { writeRoots: [inside], source: 'late-provider' } : undefined,
    })
    assert.deepEqual(
      [...(sandboxPolicyFrom(ctx)?.writeRoots ?? [])],
      [inside],
      'the late provider is visible on the context',
    )

    // 3. The deny is HONORED: the seam must REFUSE, never silently write.
    await assert.rejects(
      () => service.write({ path: path.join(outside, 'after.txt'), content: 'x' }),
      (error: unknown) => error instanceof FsError && error.reason === 'fs.outside-root',
      'a policy published after apply must still deny the write',
    )
    assert.equal(fs.existsSync(path.join(outside, 'after.txt')), false, 'nothing reached the disk')
    const late = await service.write({ path: path.join(inside, 'ok.txt'), content: 'ok\n' })
    assert.equal(late.created, true, 'a write inside the provider roots still works')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sandbox: a DENY is HONOURED by the fs seam (deny rule, fail-closed, empty writeRoots)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-sandbox-deny-'))
  try {
    const root = path.join(dir, 'root')
    const inside = path.join(root, 'inside')
    const outside = path.join(root, 'outside')
    fs.mkdirSync(inside, { recursive: true })
    fs.mkdirSync(outside, { recursive: true })
    const isOutsideRoot = (error: unknown): boolean => error instanceof FsError && error.reason === 'fs.outside-root'

    // A boot-shaped context: `fs-local` applies FIRST (discovery order), the
    // sandbox provider is provided LATER, exactly like a real boot.
    const boot = (policy?: SandboxPolicyConfig) => {
      const services = new Map<string, unknown>()
      const ctx = {
        provide: (serviceName: string, value: unknown) => {
          services.set(serviceName, value)
        },
        get: (serviceName: string) => services.get(serviceName),
      } as unknown as ServiceContext
      applyFsLocal(ctx, { cwd: root, roots: [root] })
      const service = fsOf(ctx)
      assert.ok(service !== undefined, 'fs-local registered its service')
      if (policy !== undefined) services.set('sandbox', createSandboxPolicyService(policy))
      return { ctx, services, service }
    }

    // 1. `resources.fs: { deny: true, writeRoots: [root] }`: the provider DECIDES
    //    deny (sandbox.resource-denied) and the seam must refuse the READ as well
    //    as the WRITE, never write around it (thread 2556, hole 1).
    {
      const { ctx, services, service } = boot()
      assert.equal((await service.write({ path: 'seed.txt', content: 'seed\n' })).created, true)
      const policy: SandboxPolicyConfig = {
        source: 'deny-rule',
        unconfigured: 'deny',
        resources: { fs: { deny: true, writeRoots: [root], readRoots: [root] } },
      }
      services.set('sandbox', createSandboxPolicyService(policy))
      const decision = await createSandboxPolicyService(policy).check({
        resource: 'fs',
        operation: 'write',
        path: path.join(root, 'e1.txt'),
      })
      assert.equal(decision.allowed, false, 'the provider denies the fs resource outright')
      assert.equal(sandboxPolicyFrom(ctx)?.denied, true, 'the deny is expressible to the fs seam')
      await assert.rejects(() => service.write({ path: 'e1.txt', content: 'x' }), isOutsideRoot)
      assert.equal(fs.existsSync(path.join(root, 'e1.txt')), false, 'a denied write reaches no disk')
      await assert.rejects(() => service.read({ path: 'seed.txt' }), isOutsideRoot)
    }

    // 2. `unconfigured: 'deny'` with no defaults and no fs rule: the fail-closed
    //    shape (sandbox.no-policy) must refuse BOTH operations too (hole 2).
    {
      const { ctx, services, service } = boot()
      assert.equal((await service.write({ path: 'seed2.txt', content: 'seed\n' })).created, true)
      services.set('sandbox', createSandboxPolicyService({ source: 'fail-closed', unconfigured: 'deny' }))
      assert.equal(sandboxPolicyFrom(ctx)?.denied, true, 'unconfigured: deny is a deny for the fs seam')
      await assert.rejects(() => service.write({ path: 'e3.txt', content: 'x' }), isOutsideRoot)
      assert.equal(fs.existsSync(path.join(root, 'e3.txt')), false, 'a fail-closed policy writes nothing')
      await assert.rejects(() => service.read({ path: 'seed2.txt' }), isOutsideRoot)
    }

    // 3. An EXPLICITLY empty `writeRoots` DECLARES "no write is allowed" (the
    //    contract), while `readRoots` keeps confining reads and `[]` there still
    //    means "no read confinement" (the two sides are NOT overloaded).
    {
      const { ctx, service } = boot({
        source: 'empty-write-roots',
        resources: { fs: { writeRoots: [], readRoots: [inside] } },
      })
      assert.equal(sandboxPolicyFrom(ctx)?.denied, undefined, 'an empty writeRoots is not a resource deny')
      fs.writeFileSync(path.join(inside, 'ok.txt'), 'ok\n')
      fs.writeFileSync(path.join(root, 'outside-read.txt'), 'nope\n')
      await assert.rejects(() => service.write({ path: 'e2.txt', content: 'x' }), isOutsideRoot)
      assert.equal(fs.existsSync(path.join(root, 'e2.txt')), false, 'an empty write root set writes nothing')
      const allowed = await service.read({ path: path.join(inside, 'ok.txt') })
      assert.ok(allowed.text.includes('ok'), 'a read INSIDE the declared read roots still works')
      await assert.rejects(() => service.read({ path: path.join(root, 'outside-read.txt') }), isOutsideRoot)
    }

    // 4. A non-deny NARROWING still works: the fix must not refuse everything.
    {
      const { service } = boot({ source: 'narrowing', resources: { fs: { writeRoots: [inside] } } })
      assert.equal((await service.write({ path: path.join(inside, 'ok4.txt'), content: 'ok\n' })).created, true)
      await assert.rejects(
        () => service.write({ path: path.join(outside, 'nope.txt'), content: 'x' }),
        isOutsideRoot,
      )
      assert.equal(fs.existsSync(path.join(outside, 'nope.txt')), false)
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sandbox: the enforcing provider carries the measured mechanisms and the contract', () => {
  const sandbox = enforcing()
  assert.equal(sandbox.contract, SANDBOX_CONTRACT)
  const report = sandbox.enforcement?.()
  assert.equal(report?.provider, LOCAL_OS)
  assert.ok((report?.mechanisms ?? []).some((mechanism) => mechanism.id === 'timeout-pgroup' && mechanism.available))
  assert.ok((report?.mechanisms ?? []).some((mechanism) => mechanism.id === 'env-allow-list' && mechanism.available))
  // DEFAULT_LIMITS is the documented floor of every constraint view.
  assert.ok(DEFAULT_LIMITS.maxOutputBytes !== undefined)
})
