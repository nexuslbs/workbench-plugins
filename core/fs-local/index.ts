// core/fs-local - the `fs@1` PROVIDER: LOCAL filesystem access (node:fs).
//
// It is the filesystem backend a consumer reaches as `ctx.fs`. Unlike
// `shell-impl` it does NOT run a command, but it does reach the host: it reads
// and writes files of the workbench host process, so it declares
// `"execution": "host"` in its manifest (verified at apply time through
// `assertPolicyDeclared`) exactly like the shell transport.
//
// SAFETY MODEL (requirement 4/7):
//   * READS are unrestricted (a caller with the URL is already an operator; a
//     read cannot damage anything) unless a sandbox policy narrows them;
//   * WRITES are CONFINED to the configured `roots`: a write outside them is a
//     typed `fs.outside-root` error and NEVER a silent success. The check uses
//     the REAL path of the deepest existing ancestor, so a symlinked directory
//     cannot be used to escape a root (`..` is normalized by `path.resolve`);
//   * the payload caps (`maxReadBytes`, `maxWriteBytes`) and the grep caps keep
//     one call from returning an unbounded answer;
//   * no credential is ever read, resolved or logged here: this provider has no
//     dependency on `credentials@1`;
//   * an OPTIONAL sandbox policy (when a `sandbox@1` provider is present, or via
//     config) can only make the seam STRICTER (narrower roots / read-only), never
//     wider: see `setSandboxPolicy`.
//
// The pure algorithms (paging, edits, globs, ripgrep parsing) live in
// `definitions/fs.ts` and are unit-tested without a filesystem; this file is the
// part that touches the host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  applyFsEdits,
  buildRipgrepArgv,
  globToRegExp,
  paginateLines,
  parseRipgrepJson,
  splitTextLines,
  sandboxPolicyFrom,
  DEFAULT_GLOB_LIMIT,
  DEFAULT_GREP_MAX_FILE_BYTES,
  DEFAULT_GREP_MAX_LINE_BYTES,
  DEFAULT_GREP_MAX_RESULTS,
  DEFAULT_GREP_MAX_TOTAL,
  DEFAULT_MAX_READ_BYTES,
  DEFAULT_MAX_WRITE_BYTES,
  FS,
  FS_CONTRACT,
  FsError,
} from '../../definitions/fs.ts'
import type {
  FsEditOutcome,
  FsEditReport,
  FsEntry,
  FsEntryType,
  FsGlobInput,
  FsGlobResult,
  FsGrepInput,
  FsGrepMatch,
  FsGrepResult,
  FsListResult,
  FsReadInput,
  FsReadResult,
  FsSandboxPolicy,
  FsService,
  FsSpillRef,
  FsStat,
  FsVersion,
  FsWriteInput,
  FsAppendInput,
  FsWriteOutcome,
} from '../../definitions/fs.ts'
import { assertPolicyDeclared, capText, positiveInt, provideService, str, ServiceError } from '../../definitions/support.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'fs-local'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'local-fs'

export const contract = FS_CONTRACT

/** The optional `grep` sub-config of this provider. */
export interface FsLocalGrepConfig {
  /**
   * `node` (default): a pure-Node `RegExp` walker - no binary, identical answers
   * on every deployment. `ripgrep`: spawn the configured `rg` binary and parse
   * its `--json` stream (the DSH approach), which is faster on huge trees and
   * honours `.gitignore`.
   */
  engine?: 'node' | 'ripgrep'
  /** Absolute `rg` path (required for the `ripgrep` engine). */
  binary?: string
  /** Default inline match cap (default 250). */
  maxResults?: number
  /** Files larger than this are skipped (default 4 MiB). */
  maxFileBytes?: number
  /** Hard ceiling on collected matches before the walk stops (default 20000). */
  maxTotal?: number
}

/** The config of the local filesystem provider. */
export interface FsLocalConfig {
  /** The roots WRITES are confined to (default: `cwd`). */
  roots?: readonly string[]
  /** The directory relative paths resolve against (default: the process cwd). */
  cwd?: string
  /** Follow a symlink to its target in `stat`/`read` (default true). */
  followSymlinks?: boolean
  /** Overall byte cap of one `read` reply (default 4 MiB). */
  maxReadBytes?: number
  /** Byte cap of one `write`/`append`/`edit` payload (default 16 MiB). */
  maxWriteBytes?: number
  /** Directory entries one `list` returns (default 1000). */
  listLimit?: number
  /** Matches one `glob` returns (default 200). */
  globLimit?: number
  /** Where `grep` writes its overflow (default `<tmpdir>/workbench-fs-spill`). */
  spillDir?: string
  /** Directory names the glob/grep walk never descends into (default `.git`, `node_modules`). */
  ignore?: readonly string[]
  /** The optional `grep` engine config (see {@link FsLocalGrepConfig}). */
  grep?: FsLocalGrepConfig
  /** An explicit sandbox policy (an extension point; see `definitions/fs.ts`). */
  sandbox?: FsSandboxPolicy
}

/** {@link FsLocalConfig} after validation and defaulting. */
export interface NormalizedFsLocalConfig {
  roots: string[]
  cwd: string
  followSymlinks: boolean
  maxReadBytes: number
  maxWriteBytes: number
  listLimit: number
  globLimit: number
  spillDir: string
  ignore: string[]
  grep: {
    engine: 'node' | 'ripgrep'
    binary?: string
    maxResults: number
    maxFileBytes: number
    maxTotal: number
  }
}

/** Absolute, POSIX-ish view of a path, for diagnostics only. */
function displayPath(value: string): string {
  return value.split(path.sep).join('/')
}

/**
 * Validate the provider config ONCE, so every call afterwards works on a
 * normalized value: absolute `cwd`/`roots`, defaults for every cap, and a
 * `grep` engine that actually exists (`ripgrep` without a binary is a config
 * error, never a silent fallback to another engine).
 */
export function validateFsLocalConfig(config: FsLocalConfig = {}): NormalizedFsLocalConfig {
  const cwd = path.resolve(str(config.cwd) ?? process.cwd())
  const roots = (Array.isArray(config.roots) ? config.roots : [])
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => path.resolve(cwd, root))
  if (roots.length === 0) roots.push(cwd)
  const engine = config.grep?.engine ?? 'node'
  if (engine !== 'node' && engine !== 'ripgrep') {
    throw new ServiceError('invalid-config', `grep.engine must be 'node' or 'ripgrep' (got ${JSON.stringify(engine)})`, {
      stage: 'fs.config',
      details: { engine },
    })
  }
  const binary = str(config.grep?.binary)
  if (engine === 'ripgrep' && (binary === undefined || binary.length === 0)) {
    throw new ServiceError('invalid-config', "grep.engine 'ripgrep' needs grep.binary (the absolute path of rg)", {
      stage: 'fs.config',
      details: { engine },
    })
  }
  return {
    roots,
    cwd,
    followSymlinks: config.followSymlinks !== false,
    maxReadBytes: positiveInt(config.maxReadBytes, DEFAULT_MAX_READ_BYTES),
    maxWriteBytes: positiveInt(config.maxWriteBytes, DEFAULT_MAX_WRITE_BYTES),
    listLimit: positiveInt(config.listLimit, 1000),
    globLimit: positiveInt(config.globLimit, DEFAULT_GLOB_LIMIT),
    spillDir: path.resolve(str(config.spillDir) ?? path.join(os.tmpdir(), 'workbench-fs-spill')),
    ignore: (Array.isArray(config.ignore) ? config.ignore : ['.git', 'node_modules']).filter(
      (entry): entry is string => typeof entry === 'string' && entry.length > 0,
    ),
    grep: {
      engine,
      ...(binary !== undefined ? { binary } : {}),
      maxResults: positiveInt(config.grep?.maxResults, DEFAULT_GREP_MAX_RESULTS),
      maxFileBytes: positiveInt(config.grep?.maxFileBytes, DEFAULT_GREP_MAX_FILE_BYTES),
      maxTotal: positiveInt(config.grep?.maxTotal, DEFAULT_GREP_MAX_TOTAL),
    },
  }
}

/** True when `target` is `root` itself or lives under it. */
function within(root: string, target: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/** `realpath` of anything, falling back to the path itself (a path may not exist yet). */
function realpathOr(value: string): string {
  try {
    return fs.realpathSync.native(value)
  } catch {
    return value
  }
}

/** The deepest existing ancestor of `value` (itself when it exists). */
function nearestExisting(value: string): string {
  let current = value
  for (;;) {
    if (fs.existsSync(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return current
    current = parent
  }
}

/**
 * The REAL path `value` will have as far as it exists: the realpath of its
 * deepest existing ancestor plus the not-yet-existing remainder. This is what
 * makes a symlinked parent directory unable to smuggle a write out of a root.
 */
function realish(value: string): string {
  const anchor = nearestExisting(value)
  return path.join(realpathOr(anchor), path.relative(anchor, value))
}

/** The opaque freshness token of a target. */
function versionOf(stat: fs.Stats): FsVersion {
  return `${stat.mtimeMs}:${stat.size}`
}

/** Map a host I/O failure onto the error taxonomy (`ENOENT` is a 404, not an I/O error). */
function ioError(error: unknown, target: string): FsError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ENOENT') {
    return new FsError('fs.not-found', `no such file or directory: ${target}`, { stage: 'fs.io', details: { path: target, code } })
  }
  return new FsError('fs.io', `filesystem error on ${target}: ${message}`, { stage: 'fs.io', details: { path: target, code } })
}

/** A cheap binary sniff: a NUL byte in the first 8 KiB (what grep/rg treat as binary). */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0)
}

/**
 * Builds the service of this provider for a validated config. Exported (not just
 * used by `apply`) so a test can drive the provider without a cordis context,
 * exactly like `createShellService` in `shell-impl`.
 */
export function createFsService(config: FsLocalConfig = {}): FsService {
  const cfg = validateFsLocalConfig(config)
  let sandbox: FsSandboxPolicy | undefined = config.sandbox
  let spillCounter = 0

  /**
   * The configured roots, narrowed by the sandbox policy when one is set.
   * INTERSECTION (never a union): only the policy roots that lie inside a
   * configured root survive, so a policy can only make the seam STRICTER. An
   * empty intersection denies every write.
   */
  const writeRoots = (): string[] => {
    const policy = sandbox?.writeRoots
    if (policy === undefined || policy.length === 0) return cfg.roots
    const resolved = policy.map((root) => path.resolve(cfg.cwd, root))
    return resolved.filter((narrow) => cfg.roots.some((root) => within(realpathOr(root), realpathOr(narrow))))
  }
  /** The read roots, when a policy narrows them. */
  const readRoots = (): string[] | undefined => {
    const policy = sandbox?.readRoots
    if (policy === undefined || policy.length === 0) return undefined
    return policy.map((root) => path.resolve(cfg.cwd, root))
  }

  const resolveTarget = (input: string | undefined): string => {
    const raw = str(input)
    if (raw === undefined || raw.length === 0) {
      throw new FsError('fs.invalid-input', 'a path is required', { stage: 'fs.path' })
    }
    return path.resolve(cfg.cwd, raw)
  }

  const assertReadable = (abs: string): void => {
    const roots = readRoots()
    if (roots === undefined) return
    const real = realish(abs)
    if (roots.map(realpathOr).some((root) => within(root, real))) return
    throw new FsError('fs.outside-root', `read denied: ${displayPath(abs)} is outside the sandbox read roots`, {
      stage: 'fs.read',
      details: { path: abs, roots: roots.map(displayPath) },
    })
  }

  const assertWritable = (abs: string): void => {
    if (sandbox?.readOnly === true) {
      throw new FsError('fs.outside-root', `write denied: the sandbox policy makes this capability read-only${sandbox.source ? ` (${sandbox.source})` : ''}`, {
        stage: 'fs.write',
        details: { path: abs, readOnly: true },
      })
    }
    const roots = writeRoots()
    const real = realish(abs)
    if (roots.map(realpathOr).some((root) => within(root, real))) return
    throw new FsError('fs.outside-root', `write denied: ${displayPath(abs)} is outside the allowed roots (${roots.map(displayPath).join(', ')})`, {
      stage: 'fs.write',
      details: { path: abs, roots: roots.map(displayPath) },
    })
  }

  const statOf = (abs: string, requested: string): FsStat => {
    let link: fs.Stats
    try {
      link = fs.lstatSync(abs)
    } catch (error) {
      throw ioError(error, abs)
    }
    const isLink = link.isSymbolicLink()
    let target = link
    let symlink: string | undefined
    if (isLink) {
      try {
        symlink = fs.readlinkSync(abs)
      } catch {
        symlink = undefined
      }
      if (cfg.followSymlinks) {
        try {
          target = fs.statSync(abs)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw ioError(error, abs)
        }
      }
    }
    const type: FsEntryType = isLink && !cfg.followSymlinks
      ? 'symlink'
      : target.isFile()
        ? 'file'
        : target.isDirectory()
          ? 'dir'
          : target.isSymbolicLink()
            ? 'symlink'
            : 'other'
    return {
      target: realpathOr(abs),
      path: requested,
      name: path.basename(abs),
      type,
      size: target.size,
      mtimeMs: target.mtimeMs,
      mode: `0${(target.mode & 0o777).toString(8)}`,
      permissions: {
        readable: (target.mode & 0o400) !== 0,
        writable: (target.mode & 0o200) !== 0,
        executable: (target.mode & 0o100) !== 0,
      },
      version: versionOf(target),
      ...(symlink !== undefined ? { symlink } : {}),
    }
  }

  /** Guarded write of a full payload, shared by `write`, `append` and `edit`. */
  const put = (
    abs: string,
    requested: string,
    content: string,
    options: { appended: boolean; createParents?: boolean; expectedVersion?: FsVersion },
  ): FsWriteOutcome => {
    assertWritable(abs)
    const bytes = Buffer.byteLength(content)
    if (bytes > cfg.maxWriteBytes) {
      throw new FsError('fs.too-large', `payload is ${bytes} bytes, above the ${cfg.maxWriteBytes}-byte write cap`, {
        stage: 'fs.write',
        details: { path: abs, bytes, maxWriteBytes: cfg.maxWriteBytes },
      })
    }
    const existed = fs.existsSync(abs)
    if (options.expectedVersion !== undefined) {
      if (!existed) {
        throw new FsError('fs.edit-conflict', `expected version ${options.expectedVersion} but ${displayPath(abs)} does not exist`, {
          stage: 'fs.write',
          details: { path: abs, expectedVersion: options.expectedVersion },
        })
      }
      const current = statOf(abs, requested)
      if (current.version !== options.expectedVersion) {
        throw new FsError('fs.edit-conflict', `the file changed since version ${options.expectedVersion} (now ${current.version}): re-read and retry`, {
          stage: 'fs.write',
          details: { path: abs, expectedVersion: options.expectedVersion, version: current.version },
        })
      }
    }
    const parent = path.dirname(abs)
    if (!fs.existsSync(parent)) {
      if (options.createParents === false) {
        throw new FsError('fs.not-found', `parent directory does not exist: ${displayPath(parent)}`, {
          stage: 'fs.write',
          details: { path: parent },
        })
      }
      try {
        fs.mkdirSync(parent, { recursive: true })
      } catch (error) {
        throw ioError(error, parent)
      }
    }
    try {
      if (options.appended) fs.appendFileSync(abs, content)
      else fs.writeFileSync(abs, content)
    } catch (error) {
      throw ioError(error, abs)
    }
    const stat = statOf(abs, requested)
    return { path: requested, target: stat.target, bytes, created: !existed, appended: options.appended, stat }
  }

  /**
   * Walk a directory tree (never descending into an ignored name, never through
   * a symlink: that is the cycle escape). `visit` returns `true` to STOP the walk.
   */
  const walk = (base: string, visit: (entry: { abs: string; rel: string; type: FsEntryType; size: number }) => boolean | void): void => {
    const stack: string[] = ['']
    while (stack.length > 0) {
      const rel = stack.pop() as string
      const abs = rel === '' ? base : path.join(base, rel)
      let dirents: fs.Dirent[]
      try {
        dirents = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of dirents) {
        if (cfg.ignore.includes(dirent.name)) continue
        const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
        const childAbs = path.join(abs, dirent.name)
        const isDir = dirent.isDirectory()
        const type: FsEntryType = dirent.isSymbolicLink() ? 'symlink' : isDir ? 'dir' : dirent.isFile() ? 'file' : 'other'
        let size = 0
        if (type === 'file') {
          try {
            size = fs.statSync(childAbs).size
          } catch {
            size = 0
          }
        }
        if (visit({ abs: childAbs, rel: childRel, type, size }) === true) return
        if (isDir) stack.push(childRel)
      }
    }
  }

  /** Write the FULL match list to a spill file, one `path:line: text` record per line. */
  const spillMatches = (matches: readonly FsGrepMatch[]): FsSpillRef | undefined => {
    if (matches.length === 0) return undefined
    try {
      fs.mkdirSync(cfg.spillDir, { recursive: true })
      spillCounter += 1
      const file = path.join(cfg.spillDir, `grep-${Date.now().toString(36)}-${process.pid}-${spillCounter}.txt`)
      const fd = fs.openSync(file, 'w')
      let bytes = 0
      try {
        for (const match of matches) {
          const line = `${match.path}:${match.line}: ${match.text}\n`
          fs.writeSync(fd, line)
          bytes += Buffer.byteLength(line)
        }
      } finally {
        fs.closeSync(fd)
      }
      return { path: file, bytes, matches: matches.length }
    } catch (error) {
      throw ioError(error, cfg.spillDir)
    }
  }

  /** The pure-Node grep engine (default): walk, read, regex per line, collect. */
  const grepWithNode = (
    input: FsGrepInput,
    pattern: RegExp,
    base: string,
    caps: { limit: number; maxLineBytes: number; maxFileBytes: number; maxTotal: number },
  ): { all: FsGrepMatch[]; files: number; skipped: number; stopped: boolean } => {
    const all: FsGrepMatch[] = []
    const globRe = typeof input.glob === 'string' && input.glob.length > 0 ? globToRegExp(input.glob) : undefined
    let files = 0
    let skipped = 0
    let stopped = false
    walk(base, (entry) => {
      if (entry.type !== 'file') return
      if (globRe !== undefined && !globRe.test(entry.rel)) return
      if (entry.size > caps.maxFileBytes) {
        skipped += 1
        return
      }
      let buffer: Buffer
      try {
        buffer = fs.readFileSync(entry.abs)
      } catch {
        skipped += 1
        return
      }
      if (looksBinary(buffer)) {
        skipped += 1
        return
      }
      const { lines } = splitTextLines(buffer.toString('utf8'))
      let matched = 0
      for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] as string
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (!pattern.test(line)) continue
        matched += 1
        const cut = capText(line, caps.maxLineBytes)
        all.push({ path: entry.rel, line: i + 1, text: cut.text, ...(cut.truncated ? { truncated: true } : {}) })
        if (all.length >= caps.maxTotal) {
          stopped = true
          return true
        }
      }
      if (matched > 0) files += 1
    })
    return { all, files, skipped, stopped }
  }

  /** The optional ripgrep engine: spawn `rg --json` (argv, never a shell) and parse it. */
  const grepWithRipgrep = async (
    input: FsGrepInput,
    base: string,
    caps: { limit: number; maxLineBytes: number; maxTotal: number },
  ): Promise<{ all: FsGrepMatch[]; files: number; skipped: number; stopped: boolean }> => {
    const binary = cfg.grep.binary as string
    const argv = buildRipgrepArgv(input.pattern, {
      base,
      ...(typeof input.glob === 'string' && input.glob.length > 0 ? { glob: input.glob } : {}),
      ...(input.ignoreCase === true ? { ignoreCase: true } : {}),
    })
    const child = spawn(binary, argv, { cwd: cfg.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const exitCode = await new Promise<number | null>((resolve) => child.on('close', resolve))
    const parsed = parseRipgrepJson(stdout, { maxLineBytes: caps.maxLineBytes, limit: caps.maxTotal })
    if (exitCode === 2 || (exitCode !== 0 && exitCode !== 1 && parsed.matches.length === 0)) {
      throw new FsError('fs.io', `ripgrep failed (exit ${exitCode}): ${stderr.trim().split('\n')[0] ?? 'no stderr'}`, {
        stage: 'fs.grep',
        details: { binary, exitCode },
      })
    }
    const all = parsed.matches.slice(0, caps.maxTotal)
    return { all, files: parsed.files, skipped: 0, stopped: parsed.total > all.length }
  }

  const service: FsService = {
    contract: FS_CONTRACT,
    roots: cfg.roots,
    cwd: cfg.cwd,

    setSandboxPolicy(policy?: FsSandboxPolicy): void {
      // A policy replaces the previous one; `undefined` clears it. It can only
      // ever NARROW the roots (see writeRoots) and never widen them.
      sandbox = policy
    },

    async stat(input: string): Promise<FsStat> {
      const abs = resolveTarget(input)
      assertReadable(abs)
      return statOf(abs, input)
    },

    async read(input: FsReadInput): Promise<FsReadResult> {
      const abs = resolveTarget(input?.path)
      assertReadable(abs)
      const stat = statOf(abs, String(input?.path ?? ''))
      if (stat.type === 'dir') {
        throw new FsError('fs.not-a-file', `cannot read a directory as a file: ${stat.path}`, {
          stage: 'fs.read',
          details: { path: abs, type: stat.type },
        })
      }
      if (stat.size > cfg.maxReadBytes * 16) {
        throw new FsError('fs.too-large', `${stat.path} is ${stat.size} bytes, too large to page line by line (cap ${cfg.maxReadBytes * 16}); use grep instead`, {
          stage: 'fs.read',
          details: { path: abs, size: stat.size },
        })
      }
      let content: string
      try {
        content = fs.readFileSync(abs, 'utf8')
      } catch (error) {
        throw ioError(error, abs)
      }
      const page = paginateLines(content, {
        offset: input?.offset,
        limit: input?.limit,
        maxLineBytes: input?.maxLineBytes,
        maxBytes: cfg.maxReadBytes,
      })
      return {
        path: stat.path,
        target: stat.target,
        stat,
        offset: page.offset,
        limit: page.limit,
        lines: page.lines,
        text: page.text,
        totalLines: page.totalLines,
        nextOffset: page.nextOffset,
        eof: page.eof,
        truncated: page.truncated,
        note: page.note,
      }
    },

    async write(input: FsWriteInput): Promise<FsWriteOutcome> {
      const abs = resolveTarget(input?.path)
      const content = typeof input?.content === 'string' ? input.content : undefined
      if (content === undefined) {
        throw new FsError('fs.invalid-input', 'write needs a string content', { stage: 'fs.write' })
      }
      return put(abs, String(input.path), content, {
        appended: false,
        ...(input.createParents !== undefined ? { createParents: input.createParents } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
      })
    },

    async append(input: FsAppendInput): Promise<FsWriteOutcome> {
      const abs = resolveTarget(input?.path)
      const content = typeof input?.content === 'string' ? input.content : undefined
      if (content === undefined) {
        throw new FsError('fs.invalid-input', 'append needs a string content', { stage: 'fs.write' })
      }
      return put(abs, String(input.path), content, {
        appended: true,
        ...(input.createParents !== undefined ? { createParents: input.createParents } : {}),
      })
    },

    async edit(input): Promise<FsEditOutcome> {
      const abs = resolveTarget(input?.path)
      assertWritable(abs)
      const requested = String(input?.path ?? '')
      const before = statOf(abs, requested)
      if (before.type !== 'file') {
        throw new FsError('fs.not-a-file', `cannot edit ${before.type === 'dir' ? 'a directory' : before.type}: ${requested}`, {
          stage: 'fs.edit',
          details: { path: abs, type: before.type },
        })
      }
      if (input.expectedVersion !== undefined && before.version !== input.expectedVersion) {
        throw new FsError('fs.edit-conflict', `the file changed since version ${input.expectedVersion} (now ${before.version}): re-read and retry`, {
          stage: 'fs.edit',
          details: { path: abs, expectedVersion: input.expectedVersion, version: before.version },
        })
      }
      let text: string
      try {
        text = fs.readFileSync(abs, 'utf8')
      } catch (error) {
        throw ioError(error, abs)
      }
      // ATOMIC: the batch runs entirely in memory; a failure throws BEFORE the
      // write below, so a rejected batch leaves the file untouched.
      const result = applyFsEdits(text, input.edits)
      const bytes = Buffer.byteLength(result.text)
      if (bytes > cfg.maxWriteBytes) {
        throw new FsError('fs.too-large', `the edited file would be ${bytes} bytes, above the ${cfg.maxWriteBytes}-byte write cap`, {
          stage: 'fs.edit',
          details: { path: abs, bytes, maxWriteBytes: cfg.maxWriteBytes },
        })
      }
      try {
        fs.writeFileSync(abs, result.text)
      } catch (error) {
        throw ioError(error, abs)
      }
      const after = statOf(abs, requested)
      const applied: FsEditReport[] = result.applied
      return { path: requested, target: after.target, applied, before, after, bytes }
    },

    async list(input = '.', options = {}): Promise<FsListResult> {
      const abs = resolveTarget(input)
      assertReadable(abs)
      const stat = statOf(abs, input)
      if (stat.type !== 'dir') {
        throw new FsError('fs.not-a-directory', `cannot list ${stat.path}: it is a ${stat.type}`, {
          stage: 'fs.list',
          details: { path: abs, type: stat.type },
        })
      }
      const limit = positiveInt(options.limit, cfg.listLimit)
      let names: string[]
      try {
        names = fs.readdirSync(abs)
      } catch (error) {
        throw ioError(error, abs)
      }
      names.sort()
      const entries: FsEntry[] = []
      for (const entryName of names) {
        if (entries.length >= limit) break
        const child = statOf(path.join(abs, entryName), entryName)
        entries.push({
          name: child.name,
          path: entryName,
          type: child.type,
          size: child.size,
          mtimeMs: child.mtimeMs,
          ...(child.symlink !== undefined ? { symlink: child.symlink } : {}),
        })
      }
      return { path: input, target: stat.target, entries, truncated: entries.length < names.length, total: names.length }
    },

    async glob(input: FsGlobInput): Promise<FsGlobResult> {
      const pattern = str(input?.pattern)
      if (pattern === undefined || pattern.length === 0) {
        throw new FsError('fs.invalid-glob', 'a glob pattern is required', { stage: 'fs.glob' })
      }
      const regexp = globToRegExp(pattern)
      const base = resolveTarget(input?.path ?? '.')
      assertReadable(base)
      const limit = positiveInt(input?.limit, cfg.globLimit)
      const matches: string[] = []
      let total = 0
      walk(base, (entry) => {
        if (entry.type === 'dir' && input?.includeDirs !== true) return
        if (!regexp.test(entry.rel)) return
        total += 1
        if (matches.length < limit) matches.push(entry.rel)
      })
      return { path: input?.path ?? '.', pattern, matches, total, truncated: total > matches.length }
    },

    async grep(input: FsGrepInput): Promise<FsGrepResult> {
      const pattern = str(input?.pattern)
      if (pattern === undefined || pattern.length === 0) {
        throw new FsError('fs.invalid-pattern', 'a search pattern is required', { stage: 'fs.grep' })
      }
      let flags = ''
      if (input?.ignoreCase === true) flags = 'i'
      if (flags !== 'i' || cfg.grep.engine === 'node') {
        try {
          new RegExp(pattern, `m${flags}`)
        } catch (error) {
          throw new FsError('fs.invalid-pattern', `the pattern is not a valid regular expression: ${(error as Error).message}`, {
            stage: 'fs.grep',
            details: { pattern },
          })
        }
      }
      const base = resolveTarget(input?.path ?? '.')
      assertReadable(base)
      const limit = positiveInt(input?.maxResults, cfg.grep.maxResults)
      const maxLineBytes = positiveInt(input?.maxLineBytes, DEFAULT_GREP_MAX_LINE_BYTES)
      const maxFileBytes = positiveInt(input?.maxFileBytes, cfg.grep.maxFileBytes)
      const outcome = cfg.grep.engine === 'ripgrep'
        ? await grepWithRipgrep(input, base, { limit, maxLineBytes, maxTotal: cfg.grep.maxTotal })
        : grepWithNode(input, new RegExp(pattern, flags), base, { limit, maxLineBytes, maxFileBytes, maxTotal: cfg.grep.maxTotal })
      const matches = outcome.all.slice(0, limit)
      const truncated = outcome.all.length > matches.length || outcome.stopped
      const spill = outcome.all.length > matches.length ? spillMatches(outcome.all) : undefined
      return {
        pattern,
        path: input?.path ?? '.',
        matches,
        total: outcome.all.length,
        files: outcome.files,
        truncated,
        maxResults: limit,
        ...(spill !== undefined ? { spill } : {}),
        ...(outcome.skipped > 0 ? { skipped: outcome.skipped } : {}),
        note: outcome.stopped
          ? `stopped at the hard ceiling of ${cfg.grep.maxTotal} matches; narrow the pattern or the path to see the rest`
          : truncated
            ? `showing ${matches.length} of ${outcome.all.length} matches inline; the full list is in ${spill?.path ?? 'the spill file'}`
            : `${outcome.all.length} match(es) in ${outcome.files} file(s)`,
      }
    },
  }

  return service
}

/**
 * Registers the filesystem provider. The manifest gate runs FIRST: a plugin that
 * reaches the host filesystem without declaring `"execution": "host"` and the
 * `fs@1` policy in its own manifest does not load at all.
 */
export function apply(ctx: ServiceContext, config: FsLocalConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [FS] })
  const service = createFsService(config)
  const policy = config.sandbox ?? sandboxPolicyFrom(ctx)
  if (policy !== undefined) service.setSandboxPolicy(policy)
  provideService(ctx, FS, service)
}

export default { name, inject: [], apply }
