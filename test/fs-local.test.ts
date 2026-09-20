// Unit tests for the `fs@1` PROVIDER `core/fs-local`: the local filesystem
// behind the contract. Every test works inside a throwaway temp directory, so
// the confinement rule (reads unrestricted, WRITES confined to `roots`) is
// exercised on a real disk - including the NEGATIVE controls: a write outside
// the roots and a `..`-escape must FAIL with reason `fs.outside-root`.
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFsService, validateFsLocalConfig } from '../core/fs-local/index.ts'
import { FsError } from '../definitions/fs.ts'
import { ServiceError } from '../definitions/support.ts'

interface Workspace {
  dir: string
  root: string
  outside: string
  spill: string
}

/** A throwaway workspace: `root` (the only allowed root) + `outside` (denied). */
function workspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-fs-local-'))
  const root = path.join(dir, 'root')
  const outside = path.join(dir, 'outside')
  const spill = path.join(dir, 'spill')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  return { dir, root, outside, spill }
}

function cleanup(space: Workspace): void {
  fs.rmSync(space.dir, { recursive: true, force: true })
}

function serviceFor(space: Workspace, config: Record<string, unknown> = {}) {
  return createFsService({ cwd: space.root, roots: [space.root], spillDir: space.spill, ...config })
}

/** The reason of a thrown FsError, or a readable failure. */
async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof FsError) return error.reason
    return `not-an-fs-error: ${String(error)}`
  }
  return 'no-error-thrown'
}

test('config: the roots default to the cwd and the ripgrep engine requires a binary', () => {
  const space = workspace()
  try {
    const normalized = validateFsLocalConfig({ cwd: space.root })
    assert.deepEqual(normalized.roots, [space.root], 'with no roots configured, writes are confined to the cwd')
    assert.equal(normalized.grep.engine, 'node', 'the pure-Node engine is the default (no binary needed)')
    assert.throws(
      () => validateFsLocalConfig({ cwd: space.root, grep: { engine: 'ripgrep' } }),
      (error: unknown) => error instanceof ServiceError && error.code === 'invalid-config',
      'ripgrep without a binary is a config error, never a silent fallback',
    )
  } finally {
    cleanup(space)
  }
})

test('read: line-numbered, paged, and the answer ends with an explicit note', async () => {
  const space = workspace()
  try {
    const service = serviceFor(space)
    await service.write({ path: 'log.txt', content: 'one\ntwo\nthree\n' })

    const first = await service.read({ path: 'log.txt', offset: 1, limit: 2 })
    assert.deepEqual(first.lines.map((line) => line.number), [1, 2])
    assert.deepEqual(first.lines.map((line) => line.text), ['one', 'two'])
    assert.equal(first.totalLines, 3)
    assert.equal(first.nextOffset, 3)
    assert.equal(first.eof, false)
    assert.equal(first.stat.type, 'file')
    assert.match(first.text, /^1:one\n2:two$/)
    assert.match(first.note, /offset 3/, 'the note pages the caller deterministically')

    const second = await service.read({ path: 'log.txt', offset: first.nextOffset })
    assert.deepEqual(second.lines.map((line) => line.text), ['three'])
    assert.equal(second.eof, true)
    assert.match(second.note, /end of file/)

    const page = await service.read({ path: 'log.txt', offset: 9 })
    assert.deepEqual(page.lines, [], 'an offset past the end is an empty window, not an error')
  } finally {
    cleanup(space)
  }
})

test('write + append + read-back: the outcome reports bytes/created/version, append flags itself', async () => {
  const space = workspace()
  try {
    const service = serviceFor(space)
    const created = await service.write({ path: 'nested/dir/note.txt', content: 'first\n' })
    assert.equal(created.created, true, 'write creates missing parents and reports the file as created')
    assert.equal(created.appended, false)
    assert.equal(created.bytes, Buffer.byteLength('first\n'))
    assert.ok(created.stat.size === created.bytes)
    assert.ok(created.stat.version.length > 0, 'the stat carries the freshness token')

    const appended = await service.append({ path: 'nested/dir/note.txt', content: 'second\n' })
    assert.equal(appended.created, false)
    assert.equal(appended.appended, true)
    assert.equal(fs.readFileSync(path.join(space.root, 'nested/dir/note.txt'), 'utf8'), 'first\nsecond\n')

    const overwritten = await service.write({
      path: 'nested/dir/note.txt',
      content: 'only\n',
      expectedVersion: appended.stat.version,
    })
    assert.equal(overwritten.created, false, 'the version matched, so the overwrite is allowed')
    assert.equal(fs.readFileSync(path.join(space.root, 'nested/dir/note.txt'), 'utf8'), 'only\n')
  } finally {
    cleanup(space)
  }
})

test('edits: str_replace / insert / an atomic batch, each reporting where it landed', async () => {
  const space = workspace()
  try {
    const service = serviceFor(space)
    await service.write({ path: 'src.txt', content: 'alpha\nbeta\ngamma\n' })

    const replaced = await service.edit({
      path: 'src.txt',
      edits: [{ kind: 'str_replace', oldText: 'beta', newText: 'BETA' }],
    })
    assert.equal(replaced.applied.length, 1)
    assert.equal(replaced.applied[0]?.kind, 'str_replace')
    assert.equal(replaced.applied[0]?.line, 2)
    assert.equal(replaced.applied[0]?.occurrences, 1)
    assert.equal(replaced.bytes, Buffer.byteLength('alpha\nBETA\ngamma\n'))

    const inserted = await service.edit({ path: 'src.txt', edits: [{ kind: 'insert', line: 1, content: 'header' }] })
    assert.equal(inserted.applied[0]?.insertedLines, 1)

    const batch = await service.edit({
      path: 'src.txt',
      edits: [
        { kind: 'str_replace', oldText: 'gamma', newText: 'GAMMA' },
        { kind: 'insert', line: 5, content: 'footer' },
      ],
    })
    assert.deepEqual(batch.applied.map((report) => report.index), [0, 1])
    assert.equal(fs.readFileSync(path.join(space.root, 'src.txt'), 'utf8'), 'header\nalpha\nBETA\nGAMMA\nfooter\n')

    assert.equal(
      await refusalOf(() => service.edit({ path: 'src.txt', edits: [{ kind: 'str_replace', oldText: 'nope', newText: 'x' }] })),
      'fs.edit-not-found',
    )
    assert.equal(
      await refusalOf(() => service.edit({ path: 'src.txt', edits: [{ kind: 'insert', line: 99, content: 'x' }] })),
      'fs.edit-invalid',
    )
  } finally {
    cleanup(space)
  }
})

test('NEGATIVE control: a write outside the roots, and a ..-escape, are TYPED refusals', async () => {
  const space = workspace()
  try {
    const service = serviceFor(space)
    const absolute = path.join(space.outside, 'evil.txt')

    const outsideReason = await refusalOf(() => service.write({ path: absolute, content: 'nope' }))
    assert.equal(outsideReason, 'fs.outside-root')
    assert.equal(fs.existsSync(absolute), false, 'nothing was written outside the root')

    const escape = path.join(space.root, '..', 'escape.txt')
    assert.equal(
      await refusalOf(() => service.write({ path: escape, content: 'nope' })),
      'fs.outside-root',
      '.. is resolved BEFORE the check, so it cannot escape the root',
    )
    assert.equal(fs.existsSync(path.join(space.dir, 'escape.txt')), false)

    assert.equal(await refusalOf(() => service.append({ path: absolute, content: 'nope' })), 'fs.outside-root')
    assert.equal(
      await refusalOf(() => service.edit({ path: absolute, edits: [{ kind: 'insert', line: 1, content: 'x' }] })),
      'fs.outside-root',
    )

    const denied = await service.write({ path: 'ok.txt', content: 'inside\n' })
    assert.equal(denied.created, true, 'the same call INSIDE the root succeeds (the check is not a blanket refusal)')

    try {
      await service.write({ path: absolute, content: 'nope' })
      assert.fail('the write must be refused')
    } catch (error) {
      assert.equal((error as FsError).code, 'policy', 'the shared code of a confinement refusal is policy')
      assert.deepEqual((error as FsError).details.roots, [space.root], 'the refusal names the allowed roots')
    }
  } finally {
    cleanup(space)
  }
})

test('sandbox extension point: a policy NARROWS the roots and can make the seam read-only', async () => {
  const space = workspace()
  try {
    const narrow = path.join(space.root, 'allowed')
    fs.mkdirSync(narrow, { recursive: true })
    const service = serviceFor(space, {
      sandbox: { writeRoots: [narrow], source: 'test-policy' },
    })

    const inside = await service.write({ path: path.join(narrow, 'ok.txt'), content: 'ok\n' })
    assert.equal(inside.created, true, 'a write inside the policy root still works')

    assert.equal(
      await refusalOf(() => service.write({ path: path.join(space.root, 'sibling.txt'), content: 'x' })),
      'fs.outside-root',
      'a policy root INSIDE the configured root narrows the seam (it is an intersection, never a union)',
    )

    service.setSandboxPolicy({ readOnly: true, source: 'test-policy' })
    assert.equal(
      await refusalOf(() => service.write({ path: path.join(narrow, 'later.txt'), content: 'x' })),
      'fs.outside-root',
      'a read-only policy refuses every write',
    )
    const readable = await service.read({ path: path.join(narrow, 'ok.txt') })
    assert.equal(readable.lines[0]?.text, 'ok', 'reads keep working under a read-only policy')

    service.setSandboxPolicy(undefined)
    const after = await service.write({ path: path.join(space.root, 'sibling.txt'), content: 'back\n' })
    assert.equal(after.created, true, 'clearing the policy restores the configured roots')
  } finally {
    cleanup(space)
  }
})

test('list / info / glob: entries, metadata and a name search', async () => {
  const space = workspace()
  try {
    const service = serviceFor(space)
    await service.write({ path: 'docs/a.md', content: '# a\n' })
    await service.write({ path: 'docs/b.txt', content: 'b\n' })
    await service.write({ path: 'src/c.ts', content: 'export {}\n' })

    const info = await service.stat(path.join(space.root, 'docs/a.md'))
    assert.equal(info.type, 'file')
    assert.equal(info.size, Buffer.byteLength('# a\n'))
    assert.match(info.mode, /^0[0-7]{3}$/)
    assert.equal(info.permissions.readable, true)

    const listed = await service.list('docs')
    assert.deepEqual(listed.entries.map((entry) => entry.name).sort(), ['a.md', 'b.txt'])
    assert.equal(listed.entries[0]?.type, 'file')
    assert.equal(listed.truncated, false)
    assert.equal(listed.total, 2)

    const capped = await service.list('docs', { limit: 1 })
    assert.equal(capped.entries.length, 1)
    assert.equal(capped.truncated, true)
    assert.equal(capped.total, 2, 'the total is reported even when the list is cut')

    const globbed = await service.glob({ pattern: '**/*.txt' })
    assert.deepEqual(globbed.matches, ['docs/b.txt'])
    assert.equal(globbed.truncated, false)

    const byName = await service.glob({ pattern: '*.ts' })
    assert.deepEqual(byName.matches, ['src/c.ts'], 'a bare name pattern matches at any depth')

    assert.equal(await refusalOf(() => service.stat('docs/missing.md')), 'fs.not-found')
    assert.equal(await refusalOf(() => service.list('src/c.ts')), 'fs.not-a-directory')
  } finally {
    cleanup(space)
  }
})

test('grep: the inline cap SPILLS the full match list (nothing is lost) and the walk has a ceiling', async () => {
  const space = workspace()
  try {
    const service = serviceFor(space, { grep: { maxResults: 3, maxTotal: 100 } })
    const content = `${Array.from({ length: 10 }, (_, index) => `needle ${index}`).join('\n')}\n`
    await service.write({ path: 'haystack.txt', content })

    const capped = await service.grep({ pattern: 'needle' })
    assert.equal(capped.matches.length, 3, 'the inline window respects maxResults')
    assert.equal(capped.total, 10, 'the total counts every match, inline and spilled')
    assert.equal(capped.files, 1)
    assert.equal(capped.truncated, true)
    assert.ok(capped.spill, 'an overflowing result MUST carry the spill reference')
    const spillPath = path.join(space.dir, 'spill', path.basename(String(capped.spill?.path ?? '')))
    assert.ok(fs.existsSync(String(capped.spill?.path)), `the spill file exists at ${String(capped.spill?.path)}`)
    const spilled = fs.readFileSync(String(capped.spill?.path), 'utf8').trimEnd().split('\n')
    assert.equal(spilled.length, 10, 'the spill file holds the FULL match list')
    assert.equal(capped.spill?.matches, 10)
    assert.match(spilled[0] ?? '', /haystack\.txt:1: needle 0/, 'a spill record is path:line: text')
    assert.ok(/spill/i.test(capped.note ?? ''), `the note points at the spill (${String(capped.note)})`)
    assert.ok(spillPath.startsWith(space.spill), 'the spill lives under the configured spillDir')

    const filtered = await service.grep({ pattern: 'needle', glob: '**/*.md', maxResults: 3 })
    assert.deepEqual(filtered.matches, [], 'the glob filter narrows the walk')
    assert.equal(filtered.total, 0)

    const insensitive = await service.grep({ pattern: 'NEEDLE', ignoreCase: true, maxResults: 1 })
    assert.equal(insensitive.matches.length, 1)
    assert.equal(insensitive.total, 10)

    const ceiling = serviceFor(space, { grep: { maxResults: 2, maxTotal: 5 } })
    const bounded = await ceiling.grep({ pattern: 'needle' })
    assert.equal(bounded.matches.length, 2)
    assert.ok((bounded.total ?? 0) >= 2 && (bounded.total ?? 0) <= 6, `the hard ceiling bounds the walk (total=${bounded.total})`)
    assert.equal(bounded.truncated, true, 'hitting the ceiling is reported as truncation')

    assert.equal(await refusalOf(() => service.grep({ pattern: '([' })), 'fs.invalid-pattern')
  } finally {
    cleanup(space)
  }
})
