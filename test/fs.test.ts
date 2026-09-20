// Unit tests for the `fs@1` CONTRACT (definitions/fs.ts): the pure algorithms a
// provider and a consumer share. No disk, no plugin, no cordis: this is the
// paging math, the edit engine (exact match / occurrence / atomicity), the glob
// compiler, the line helpers and the error taxonomy.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FS_CONTRACT,
  FsError,
  applyFsEdits,
  applyInsert,
  applyStrReplace,
  fsErrorReason,
  globMatches,
  globToRegExp,
  joinTextLines,
  lineOfIndex,
  paginateLines,
  parseFsEdits,
  renderNumberedLines,
  splitTextLines,
  type FsEdit,
} from '../definitions/fs.ts'

/** The reason of a thrown FsError, or a readable failure. */
function reasonOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return fsErrorReason(error) ?? `not-an-fs-error: ${String(error)}`
  }
  return 'no-error-thrown'
}

test('contract id is fs@1', () => {
  assert.equal(FS_CONTRACT, 'fs@1')
})

test('read paging: a mid-file window reports its lines, the total, nextOffset and EOF=false', () => {
  const page = paginateLines('a\nb\nc\nd\n', { offset: 2, limit: 2 })
  assert.deepEqual(
    page.lines.map((line) => line.number),
    [2, 3],
    'lines carry their 1-based FILE number, not the window position',
  )
  assert.deepEqual(
    page.lines.map((line) => line.text),
    ['b', 'c'],
  )
  assert.equal(page.text, '2:b\n3:c', 'the rendered text is <number>:<text>')
  assert.equal(page.totalLines, 4)
  assert.equal(page.offset, 2)
  assert.equal(page.limit, 2)
  assert.equal(page.nextOffset, 4, 'the next page starts at the line after the window')
  assert.equal(page.eof, false)
  assert.match(page.note, /offset 4/, 'the note names the offset to continue with')
})

test('read paging: the last window says so in words (end-of-file note) and flags eof', () => {
  const page = paginateLines('a\nb\nc\n', { offset: 3 })
  assert.deepEqual(
    page.lines.map((line) => line.text),
    ['c'],
  )
  assert.equal(page.eof, true)
  assert.match(page.note, /end of file/)
  assert.ok(page.nextOffset > page.totalLines, 'an exhausted file points past the last line')
})

test('read paging: an offset past the end is an EMPTY window, not an error', () => {
  const page = paginateLines('a\nb\n', { offset: 9 })
  assert.deepEqual(page.lines, [])
  assert.equal(page.eof, true)
  assert.equal(page.totalLines, 2)
})

test('read paging: limit is clamped to the contract maximum (2000 lines)', () => {
  const page = paginateLines('a\n', { limit: 99_999 })
  assert.equal(page.limit, 2000)
  assert.equal(paginateLines('a\n', {}).limit, 2000, 'the default limit is the same cap')
})

test('read caps are TWO dimensional: a per-line cap and an overall byte budget', () => {
  const long = `${'x'.repeat(500)}\n`
  const perLine = paginateLines(long, { maxLineBytes: 10 })
  assert.equal(perLine.lines[0]?.truncated, true, 'the long line is flagged truncated')
  assert.ok((perLine.lines[0]?.text.length ?? 0) <= 10, 'the per-line cap bounds the text')
  assert.equal(perLine.truncated, true)

  const many = `${Array.from({ length: 20 }, (_, index) => `line-${index}`).join('\n')}\n`
  const budget = paginateLines(many, { maxBytes: 25 })
  assert.equal(budget.truncated, true, 'the overall byte budget cuts the window')
  assert.ok(budget.lines.length >= 1 && budget.lines.length < 20, `window held ${budget.lines.length} of 20 lines`)
})

test('line helpers: split/join keep the trailing-newline convention, lineOfIndex is 1-based', () => {
  assert.deepEqual(splitTextLines('a\nb'), { lines: ['a', 'b'], trailingNewline: false })
  assert.deepEqual(splitTextLines('a\nb\n'), { lines: ['a', 'b'], trailingNewline: true })
  assert.equal(joinTextLines(['a', 'b'], true), 'a\nb\n')
  assert.equal(joinTextLines(['a', 'b'], false), 'a\nb')
  assert.equal(lineOfIndex('a\nbb\nc', 0), 1)
  assert.equal(lineOfIndex('a\nbb\nc', 2), 2, 'index 2 is the first byte of line 2')
  assert.equal(renderNumberedLines([
    { number: 1, text: 'x', bytes: 1 },
    { number: 2, text: 'y', bytes: 1 },
  ]), '1:x\n2:y')
})

test('str_replace: one occurrence is replaced unconditionally, several need an explicit occurrence', () => {
  const single = applyStrReplace('hello world', { oldText: 'world', newText: 'there' })
  assert.equal(single.text, 'hello there')
  assert.equal(single.occurrences, 1)
  assert.equal(single.line, 1)

  const second = applyStrReplace('a a a', { oldText: 'a', newText: 'b', occurrence: 2 })
  assert.equal(second.text, 'a b a', 'occurrence is 1-based and picks exactly one match')
  assert.equal(second.occurrences, 3, 'the report counts every non-overlapping occurrence')
})

test('str_replace: ambiguity, no match and a bad occurrence are TYPED, distinct refusals', () => {
  assert.equal(
    reasonOf(() => applyStrReplace('a a', { oldText: 'a', newText: 'b' })),
    'fs.edit-ambiguous',
  )
  assert.equal(
    reasonOf(() => applyStrReplace('abc', { oldText: 'zz', newText: 'b' })),
    'fs.edit-not-found',
  )
  assert.equal(
    reasonOf(() => applyStrReplace('a a', { oldText: 'a', newText: 'b', occurrence: 5 })),
    'fs.edit-invalid',
  )
  assert.equal(
    reasonOf(() => applyStrReplace('abc', { oldText: '', newText: 'b' })),
    'fs.edit-invalid',
    'an empty needle matches everywhere and is refused',
  )
})

test('insert: whole lines BEFORE the 1-based line, totalLines + 1 appends', () => {
  const atTop = applyInsert('b\n', { line: 1, content: 'a' })
  assert.equal(atTop.text, 'a\nb\n', 'the file keeps its trailing-newline convention')
  assert.equal(atTop.insertedLines, 1)

  const atEnd = applyInsert('b\n', { line: 2, content: 'c' })
  assert.equal(atEnd.text, 'b\nc\n')

  const block = applyInsert('b\n', { line: 1, content: 'x\ny' })
  assert.equal(block.text, 'x\ny\nb\n')
  assert.equal(block.insertedLines, 2)

  assert.equal(reasonOf(() => applyInsert('b\n', { line: 99, content: 'c' })), 'fs.edit-invalid')
  assert.equal(reasonOf(() => applyInsert('b\n', { line: 1, content: '' })), 'fs.edit-invalid')
})

test('apply_patch is ATOMIC: the edits are applied in order and one failure writes nothing', () => {
  const edits: FsEdit[] = [
    { kind: 'str_replace', oldText: 'a', newText: 'A' },
    { kind: 'insert', line: 2, content: 'NEW' },
  ]
  const ok = applyFsEdits('a\nb\n', edits)
  assert.equal(ok.text, 'A\nNEW\nb\n')
  assert.deepEqual(ok.applied.map((report) => report.index), [0, 1])
  assert.equal(ok.applied[0]?.kind, 'str_replace')
  assert.equal(ok.applied[0]?.line, 1)
  assert.equal(ok.applied[1]?.insertedLines, 1)

  const failing: FsEdit[] = [
    { kind: 'str_replace', oldText: 'a', newText: 'A' },
    { kind: 'insert', line: 99, content: 'x' },
  ]
  try {
    applyFsEdits('a\nb\n', failing)
    assert.fail('the batch must not succeed')
  } catch (error) {
    assert.equal(fsErrorReason(error), 'fs.edit-invalid')
    assert.equal((error as FsError).details.index, 1, 'the failing edit is named by its batch index')
  }
  assert.equal(reasonOf(() => applyFsEdits('a\n', [])), 'fs.edit-invalid', 'an empty batch is refused')
})

test('parseFsEdits rejects a malformed apply_patch payload BEFORE anything is written', () => {
  const parsed = parseFsEdits([{ kind: 'str_replace', oldText: 'a', newText: 'b' }])
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]?.kind, 'str_replace')

  assert.equal(reasonOf(() => parseFsEdits('not-an-array')), 'fs.edit-invalid')
  assert.equal(reasonOf(() => parseFsEdits([])), 'fs.edit-invalid')
  assert.equal(reasonOf(() => parseFsEdits([{ kind: 'nope' }])), 'fs.edit-invalid')
  assert.equal(reasonOf(() => parseFsEdits([{ kind: 'insert', line: 0, content: 'x' }])), 'fs.edit-invalid')
})

test('glob: a pattern without "/" matches a basename at any depth, with "/" a path', () => {
  assert.equal(globMatches('**/*.ts', 'src/a.ts'), true)
  assert.equal(globMatches('**/*.ts', 'src/a.js'), false)
  assert.equal(globMatches('*README*', 'docs/README.md'), true)
  assert.equal(globMatches('*.ts', 'src/a.ts'), true, 'a bare name pattern is applied to the basename')
  assert.equal(globMatches('*.ts', 'src/a.js'), false)
  assert.ok(globToRegExp('**/*.ts') instanceof RegExp)
})

test('the error taxonomy is stable: reason -> shared ServiceError code', () => {
  const error = new FsError('fs.outside-root', 'refused')
  assert.equal(error.code, 'policy', 'a confinement refusal is a POLICY failure')
  assert.equal(error.reason, 'fs.outside-root')
  assert.equal(error.details.reason, 'fs.outside-root')
  assert.equal(fsErrorReason(error), 'fs.outside-root')
  assert.equal(fsErrorReason(new Error('plain')), undefined)
  assert.equal(new FsError('fs.not-found', 'x').code, 'unreachable')
  assert.equal(new FsError('fs.too-large', 'x').code, 'unsupported')
})
