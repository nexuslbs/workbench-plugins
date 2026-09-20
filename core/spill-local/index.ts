// core/spill-local - the `spill@1` PROVIDER: LOCAL disk (node:fs + sha256).
//
// It is the durable half of every capped answer of this repository: a payload too
// large for an inline reply is written ONCE to a stable, CONTENT-ADDRESSED file
// under a configured directory, and the caller reads it back in bounded RANGES.
//
// The provider owns the disk and the policy; the paging math, the file naming and
// the retention DECISION are pure functions of `definitions/spill.ts`, so they are
// unit-tested without a filesystem and this file only does I/O.
//
// SAFETY / BOUNDS:
//   * every path a call names is RESOLVED and checked to live inside the spill
//     directory: a `..`-escape or an absolute path elsewhere is a typed
//     `spill.outside-dir` error, never a read/write elsewhere on the host;
//   * a payload beyond the per-payload ceiling is refused (`spill.too-large`)
//     instead of filling the disk;
//   * writes are ATOMIC (temp file + rename) so a reader never sees a half file;
//   * the retention policy (max age, max total bytes) runs on every write when
//     configured, and `purge` is the only call that deletes anything.
//
// It reaches the host filesystem, so its manifest declares `"execution": "host"`
// and the `spill@1` policy, and `apply` verifies that declaration.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  clampRange,
  normalizeSpillConfig,
  previewOf,
  selectForPurge,
  sha256Of,
  spillFileName,
  SPILL,
  SPILL_CONTRACT,
  SpillError,
} from '../../definitions/spill.ts'
import type {
  NormalizedSpillConfig,
  SpillCandidate,
  SpillConfig,
  SpillInfo,
  SpillPolicy,
  SpillPurgeInput,
  SpillPurgeResult,
  SpillReadInput,
  SpillReadResult,
  SpillRef,
  SpillService,
  SpillWriteInput,
} from '../../definitions/spill.ts'
import { assertPolicyDeclared, messageOf, provideService } from '../../definitions/support.ts'
import type { ServiceContext } from '../../definitions/support.ts'

export const name = 'spill-local'

/** Provider id this plugin registers; it must match the manifest capability. */
export const providerId = 'local-disk'

export const contract = SPILL_CONTRACT

/** Bytes of the preceding window a line-aligned read looks back for a newline. */
const LINE_LOOKBACK_BYTES = 64 * 1024

/** Default number of files `list` answers with. */
const LIST_LIMIT = 200

/** Normalises a spill config (the testable entry point of the provider). */
export function validateSpillConfig(config: SpillConfig = {}, tmpdir = os.tmpdir()): NormalizedSpillConfig {
  return normalizeSpillConfig(config, tmpdir)
}

/** SHA-256 (hex) of a file, streamed so a large file never lands in memory. */
async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk as Buffer))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/** Resolves a caller path and refuses anything outside the spill directory. */
function insideDir(dir: string, candidate: string): string {
  const root = path.resolve(dir)
  const resolved = path.resolve(candidate)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new SpillError('spill.outside-dir', `'${candidate}' is outside the spill directory of this provider`, {
      stage: 'spill.path',
      details: { dir: root },
    })
  }
  return resolved
}

/**
 * Builds the service of this provider for a validated config. The service is a
 * plain object: a test can drive it without a cordis context.
 */
export function createSpillService(config: SpillConfig = {}, tmpdir = os.tmpdir()): SpillService {
  const cfg = validateSpillConfig(config, tmpdir)

  const filesOf = async (): Promise<Array<{ path: string; bytes: number; mtimeMs: number }>> => {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(cfg.dir, { withFileTypes: true })
    } catch {
      return []
    }
    const files: Array<{ path: string; bytes: number; mtimeMs: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith('.tmp')) continue
      const file = path.join(cfg.dir, entry.name)
      try {
        const stat = await fs.promises.stat(file)
        files.push({ path: file, bytes: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        // A file that vanished between readdir and stat is simply not reported.
      }
    }
    return files
  }

  const describe = async (file: string, bytes: number, mtimeMs: number): Promise<SpillInfo> => {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000))
    return {
      path: file,
      bytes,
      sha256: await sha256File(file),
      modifiedAt: new Date(mtimeMs).toISOString(),
      ageSeconds,
      expired: cfg.maxAgeSeconds > 0 && ageSeconds > cfg.maxAgeSeconds,
    }
  }

  const purge = async (input: SpillPurgeInput = {}): Promise<SpillPurgeResult> => {
    const maxAgeSeconds = typeof input.maxAgeSeconds === 'number' && input.maxAgeSeconds >= 0 ? input.maxAgeSeconds : cfg.maxAgeSeconds
    const maxTotalBytes = typeof input.maxTotalBytes === 'number' && input.maxTotalBytes >= 0 ? input.maxTotalBytes : cfg.maxTotalBytes
    const dryRun = input.dryRun === true
    const files = await filesOf()
    const now = Date.now()
    const candidates: SpillCandidate[] = files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      ageSeconds: Math.max(0, Math.floor((now - file.mtimeMs) / 1000)),
    }))
    const doomed = selectForPurge(candidates, { maxAgeSeconds, maxTotalBytes })
    const byPath = new Map(candidates.map((entry) => [entry.path, entry]))
    let freedBytes = 0
    const removed: string[] = []
    for (const file of doomed) {
      if (dryRun) {
        removed.push(file)
        freedBytes += byPath.get(file)?.bytes ?? 0
        continue
      }
      try {
        await fs.promises.unlink(file)
        removed.push(file)
        freedBytes += byPath.get(file)?.bytes ?? 0
      } catch (error) {
        throw new SpillError('spill.io', `cannot remove the spill file ${file}: ${messageOf(error)}`, {
          stage: 'spill.purge',
          details: { path: file },
        })
      }
    }
    return {
      removed,
      freedBytes,
      scanned: candidates.length,
      dryRun,
      note: dryRun
        ? `would remove ${removed.length} of ${candidates.length} file(s), freeing ${freedBytes} bytes`
        : `removed ${removed.length} of ${candidates.length} file(s), freeing ${freedBytes} bytes`,
    }
  }

  const service: SpillService = {
    async write(input: SpillWriteInput): Promise<SpillRef> {
      if (typeof input?.content !== 'string') {
        throw new SpillError('spill.invalid-input', "a spill write needs a string 'content'", { stage: 'spill.write' })
      }
      const payload = Buffer.from(input.content, 'utf8')
      if (payload.byteLength > cfg.maxBytes) {
        throw new SpillError('spill.too-large', `the payload (${payload.byteLength} bytes) exceeds the per-payload ceiling of ${cfg.maxBytes} bytes`, {
          stage: 'spill.write',
          details: { bytes: payload.byteLength, maxBytes: cfg.maxBytes },
        })
      }
      const sha256 = sha256Of(payload)
      const file = path.join(cfg.dir, spillFileName(input.label, sha256, input.extension))
      try {
        await fs.promises.mkdir(cfg.dir, { recursive: true })
      } catch (error) {
        throw new SpillError('spill.io', `cannot create the spill directory ${cfg.dir}: ${messageOf(error)}`, {
          stage: 'spill.write',
          details: { dir: cfg.dir },
        })
      }
      // CONTENT ADDRESSED: an identical payload that is already on disk is reused.
      let exists = false
      try {
        exists = (await fs.promises.stat(file)).size === payload.byteLength
      } catch {
        exists = false
      }
      if (!exists) {
        const temp = `${file}.${process.pid}.tmp`
        try {
          await fs.promises.writeFile(temp, payload)
          await fs.promises.rename(temp, file)
        } catch (error) {
          await fs.promises.rm(temp, { force: true }).catch(() => undefined)
          throw new SpillError('spill.io', `cannot write the spill file ${file}: ${messageOf(error)}`, {
            stage: 'spill.write',
            details: { path: file },
          })
        }
      }
      if (cfg.purgeOnWrite) {
        // The retention policy is BEST EFFORT on write: a purge failure must not
        // fail the write that just succeeded.
        await purge({}).catch(() => undefined)
      }
      return {
        path: file,
        bytes: payload.byteLength,
        sha256,
        preview: previewOf(input.content, cfg.previewBytes),
        previewBytes: Math.min(cfg.previewBytes, payload.byteLength),
        wroteAt: new Date().toISOString(),
        ...(input.source === undefined ? {} : { source: input.source }),
      }
    },

    async read(input: SpillReadInput): Promise<SpillReadResult> {
      const file = insideDir(cfg.dir, input?.path)
      let total = 0
      try {
        const stat = await fs.promises.stat(file)
        if (!stat.isFile()) throw new Error('not a regular file')
        total = stat.size
      } catch {
        throw new SpillError('spill.not-found', `no spill file at ${file}`, { stage: 'spill.read', details: { path: file } })
      }
      const window = clampRange(total, input.offset, input.limit)
      // Read the requested window PLUS a bounded lookback, so a line-aligned read
      // can start at the beginning of the line containing `offset` without ever
      // reading the whole (possibly large) file.
      const lookback = Math.min(window.offset, LINE_LOOKBACK_BYTES)
      const from = window.offset - lookback
      const to = Math.min(total, window.offset + window.limit)
      const length = Math.max(0, to - from)
      const buffer = Buffer.alloc(length)
      if (length > 0) {
        let handle: fs.promises.FileHandle | undefined
        try {
          handle = await fs.promises.open(file, 'r')
          await handle.read(buffer, 0, length, from)
        } catch (error) {
          throw new SpillError('spill.io', `cannot read the spill file ${file}: ${messageOf(error)}`, {
            stage: 'spill.read',
            details: { path: file },
          })
        } finally {
          await handle?.close().catch(() => undefined)
        }
      }
      let offset = window.offset
      let returnedBytes = 0
      let text = ''
      if (input.align === 'byte') {
        returnedBytes = Math.max(0, Math.min(window.limit, to - window.offset))
        text = buffer.subarray(window.offset - from, window.offset - from + returnedBytes).toString('utf8')
      } else if (length > 0) {
        const sliceStart = window.offset - from
        // Start at the beginning of the line that CONTAINS `offset`: the byte
        // after the last newline of the lookback window. No newline in the
        // lookback means the line began before the window, so byte 0 of the
        // buffer is the closest line start this bounded read can offer.
        let startRel = 0
        if (window.offset > 0) {
          const newline = buffer.lastIndexOf(0x0a, Math.max(0, sliceStart - 1))
          startRel = newline >= 0 ? newline + 1 : 0
        }
        const lastNewline = buffer.lastIndexOf(0x0a, Math.max(0, Math.min(buffer.length, sliceStart + window.limit) - 1))
        const endRel = lastNewline >= startRel ? lastNewline + 1 : Math.min(buffer.length, sliceStart + window.limit)
        offset = from + startRel
        returnedBytes = Math.max(0, endRel - startRel)
        text = buffer.subarray(startRel, endRel).toString('utf8')
      }
      const nextOffset = offset + returnedBytes
      return {
        path: file,
        bytes: total,
        offset,
        returnedBytes,
        text,
        nextOffset,
        eof: nextOffset >= total,
        truncated: nextOffset < total,
        sha256: await sha256File(file),
        note: `bytes ${offset}-${nextOffset} of ${total}${nextOffset >= total ? ' (end of file)' : ''}`,
      }
    },

    async info(filePath: string): Promise<SpillInfo> {
      const file = insideDir(cfg.dir, filePath)
      try {
        const stat = await fs.promises.stat(file)
        if (!stat.isFile()) throw new Error('not a regular file')
        return await describe(file, stat.size, stat.mtimeMs)
      } catch (error) {
        if (error instanceof SpillError) throw error
        throw new SpillError('spill.not-found', `no spill file at ${file}`, { stage: 'spill.info', details: { path: file } })
      }
    },

    async list(limit = LIST_LIMIT): Promise<SpillInfo[]> {
      const files = await filesOf()
      files.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const capped = files.slice(0, Math.max(1, Math.floor(limit)))
      const infos: SpillInfo[] = []
      for (const file of capped) infos.push(await describe(file.path, file.bytes, file.mtimeMs))
      return infos
    },

    purge,

    policy(): SpillPolicy {
      return {
        dir: cfg.dir,
        maxBytes: cfg.maxBytes,
        maxTotalBytes: cfg.maxTotalBytes,
        maxAgeSeconds: cfg.maxAgeSeconds,
        previewBytes: cfg.previewBytes,
      }
    },
  }

  return service
}

/**
 * Registers the spill provider. The manifest gate runs FIRST: a plugin that
 * writes to the host filesystem without declaring `"execution": "host"` and the
 * `spill@1` policy in its own manifest does not load at all.
 */
export function apply(ctx: ServiceContext, config: SpillConfig = {}): void {
  assertPolicyDeclared(import.meta.url, { execution: 'host', capabilities: [SPILL] })
  provideService(ctx, SPILL, createSpillService(config))
}

export default { name, inject: [], apply }
