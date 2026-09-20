// Unit tests for the `spill@1` seam: the PURE paging/retention math and the
// `local-disk` provider (definitions/spill.ts + core/spill-local/index.ts).
//
// Every test uses a throwaway directory under os.tmpdir() and removes it after.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  SPILL,
  SPILL_CONTRACT,
  clampRange,
  previewOf,
  sanitizeLabel,
  selectForPurge,
  sha256Of,
  spillFileName,
  SpillError,
} from '../definitions/spill.ts'
import { createSpillService, providerId, validateSpillConfig } from '../core/spill-local/index.ts'

/** A throwaway directory plus its cleanup. */
function space(): { dir: string; done: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wb-spill-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const payload = Array.from({ length: 300 }, (_, index) => `line ${String(index).padStart(3, '0')}`).join('\n') + '\n'

test('spill: the contract id of the definition', () => {
  assert.equal(SPILL, 'spill')
  assert.equal(SPILL_CONTRACT, 'spill@1')
})

test('spill: clampRange clamps to the file and never returns more than the cap', () => {
  // The clamp returns the window that can actually be served plus the paging
  // metadata: `limit` is the bytes RETURNED, `nextOffset` is where the next
  // window starts and `eof` tells a pager it is done.
  assert.deepEqual(clampRange(1000, undefined, undefined), { offset: 0, limit: 1000, nextOffset: 1000, eof: true, truncated: false })
  assert.deepEqual(clampRange(1000, 900, 200), { offset: 900, limit: 100, nextOffset: 1000, eof: true, truncated: false })
  assert.deepEqual(clampRange(1000, 5000, 10), { offset: 1000, limit: 0, nextOffset: 1000, eof: true, truncated: false })
  assert.deepEqual(clampRange(10, -5, 10), { offset: 0, limit: 10, nextOffset: 10, eof: true, truncated: false })
  assert.deepEqual(clampRange(10_000, 0, 100), { offset: 0, limit: 100, nextOffset: 100, eof: false, truncated: true })
})

test('spill: sanitizeLabel and spillFileName keep a stable, path-safe name', () => {
  assert.equal(sanitizeLabel('../../etc/passwd'), '..-..-etc-passwd')
  assert.equal(sanitizeLabel(''), 'spill')
  const name = spillFileName('subprocess-stdout', sha256Of('x'))
  assert.match(name, /^subprocess-stdout-[0-9a-f]{8,}\.txt$/)
  assert.equal(name.includes('/'), false)
})

test('spill: previewOf never cuts a multi-byte character in half', () => {
  const text = 'a'.repeat(10) + 'é'.repeat(5)
  const preview = previewOf(text, 11)
  assert.equal(preview.startsWith('a'.repeat(10)), true)
  assert.equal(preview.endsWith('\uFFFD'), false)
})

test('spill: selectForPurge removes by age and by total size, oldest first', () => {
  const files = [
    { path: '/s/old.txt', bytes: 100, ageSeconds: 900 },
    { path: '/s/mid.txt', bytes: 100, ageSeconds: 500 },
    { path: '/s/new.txt', bytes: 100, ageSeconds: 10 },
  ]
  assert.deepEqual(selectForPurge(files, { maxAgeSeconds: 600, maxTotalBytes: 1_000_000 }), ['/s/old.txt'])
  // `maxAgeSeconds: 0` means no age purge, so the size ceiling trims the OLDEST
  // first until the remaining total fits (300 -> 200 -> 100 <= 150).
  assert.deepEqual(selectForPurge(files, { maxAgeSeconds: 0, maxTotalBytes: 150 }), ['/s/old.txt', '/s/mid.txt'])
})

test('spill: validateSpillConfig normalises the deployment knobs', () => {
  const config = validateSpillConfig({ dir: '/tmp/x', maxAgeSeconds: 60, previewBytes: 16 }, '/tmp')
  assert.equal(config.dir, '/tmp/x')
  assert.equal(config.maxAgeSeconds, 60)
  assert.equal(config.previewBytes, 16)
})

test('spill-local: write returns a content-addressed reference with a preview', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir, previewBytes: 32 }, dir)
    assert.equal(spill.policy().dir, dir)
    const ref = await spill.write({ content: payload, label: 'test-payload', source: 'unit-test' })
    assert.equal(ref.bytes, Buffer.byteLength(payload))
    assert.equal(ref.sha256, sha256Of(payload))
    assert.equal(ref.previewBytes <= 64, true)
    assert.equal(ref.preview.startsWith('line 000'), true)
    assert.equal(ref.source, 'unit-test')
    assert.equal(path.dirname(ref.path), dir)

    const info = await spill.info(ref.path)
    assert.equal(info.bytes, ref.bytes)
    assert.equal(info.sha256, ref.sha256)
    assert.equal(info.expired, false)

    const listed = await spill.list()
    assert.deepEqual(
      listed.map((entry) => entry.path),
      [ref.path],
    )
  } finally {
    done()
  }
})

test('spill-local: read pages by RANGE and reports the next offset', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir }, dir)
    const ref = await spill.write({ content: payload })
    const first = await spill.read({ path: ref.path, offset: 0, limit: 100, align: 'byte' })
    assert.equal(first.offset, 0)
    assert.equal(first.returnedBytes, 100)
    assert.equal(first.bytes, ref.bytes)
    assert.equal(first.nextOffset, 100)
    assert.equal(first.eof, false)
    assert.equal(first.truncated, true)
    assert.equal(first.sha256, ref.sha256)

    const second = await spill.read({ path: ref.path, offset: first.nextOffset, limit: 100, align: 'byte' })
    assert.equal(second.offset, 100)
    assert.equal(second.text, payload.slice(100, 200))

    const tail = await spill.read({ path: ref.path, offset: ref.bytes - 10, limit: 4096 })
    assert.equal(tail.nextOffset, ref.bytes)
    assert.equal(tail.eof, true)
  } finally {
    done()
  }
})

test('spill-local: the default window is LINE-aligned so a page never ends mid-line', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir }, dir)
    const ref = await spill.write({ content: payload })
    const page = await spill.read({ path: ref.path, offset: 5, limit: 40 })
    assert.equal(page.text.endsWith('\n'), true)
    assert.equal(page.text.startsWith('line'), true)
  } finally {
    done()
  }
})

test('spill-local: a read outside the provider directory is refused', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir }, dir)
    await assert.rejects(
      () => spill.read({ path: '/etc/passwd' }),
      (error: unknown) => error instanceof SpillError,
    )
  } finally {
    done()
  }
})

test('spill-local: purge removes by age, trims by size and honours dryRun', async () => {
  const { dir, done } = space()
  try {
    const spill = createSpillService({ dir, maxAgeSeconds: 3600, purgeOnWrite: false }, dir)
    await spill.write({ content: 'a'.repeat(200), label: 'first' })
    await spill.write({ content: 'b'.repeat(400), label: 'second' })
    await spill.write({ content: 'c'.repeat(600), label: 'third' })

    // A dry run decides (trims the total to the ceiling) and deletes NOTHING.
    const dry = await spill.purge({ maxAgeSeconds: 0, maxTotalBytes: 1000, dryRun: true })
    assert.equal(dry.dryRun, true)
    assert.equal(dry.removed.length >= 1, true)
    assert.equal(dry.freedBytes >= 200, true)
    assert.equal((await spill.list()).length, 3)

    // The real run takes the SAME decision and the files are gone.
    const size = await spill.purge({ maxAgeSeconds: 0, maxTotalBytes: 1000 })
    assert.deepEqual([...size.removed].sort(), [...dry.removed].sort())
    const afterSize = await spill.list()
    assert.equal(afterSize.length, 3 - size.removed.length)
    assert.equal(
      afterSize.reduce((sum, entry) => sum + entry.bytes, 0) <= 1000,
      true,
      'the remaining spill files fit the size ceiling',
    )

    // `maxAgeSeconds: 0` is an explicit "no age purge" (nothing is removed).
    const keepForever = await spill.purge({ maxAgeSeconds: 0 })
    assert.equal(keepForever.removed.length, 0)

    // Backdate ONE survivor: an age purge removes exactly it.
    const victim = (await spill.list())[0]!
    const stale = new Date(Date.now() - 7_200_000)
    utimesSync(victim.path, stale, stale)
    const age = await spill.purge({ maxAgeSeconds: 3600 })
    assert.equal(age.removed.includes(victim.path), true, 'the stale file is purged by age')
    const remaining = await spill.list()
    assert.equal(remaining.length, afterSize.length - 1)
    assert.equal(remaining.some((entry) => entry.path === victim.path), false)
  } finally {
    done()
  }
})

test('spill-local: the provider reports the id its manifest declares', () => {
  assert.equal(providerId, 'local-disk')
})
