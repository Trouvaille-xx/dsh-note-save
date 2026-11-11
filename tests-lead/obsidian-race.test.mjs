/**
 * Obsidian collision policy under concurrency.
 *
 * The index maintainer flagged the original check-then-write pair: `stat` says
 * the name is free, then `writeFile` writes — two saves interleaving there both
 * pick the same file and one silently overwrites the other. The adapter now
 * creates each candidate with `wx` (O_CREAT|O_EXCL) and retries the next suffix
 * on EEXIST, which has no window between the check and the write.
 *
 * Run with `node tests-lead/obsidian-race.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import obsidian from '../lib/adapters/obsidian.js'

let vault = ''

const configFor = (path) => ({ targets: { obsidian: { vault: path, subdir: '', frontmatter: false } } })
const env = { logger: { warn() {}, error() {}, info() {} } }

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'note-race-'))
})

after(async () => {
  await rm(vault, { recursive: true, force: true })
})

test('sequential saves of the same title get numbered suffixes', async () => {
  const dir = await mkdtemp(join(vault, 'seq-'))
  const config = configFor(dir)
  const first = await obsidian.write({ title: '同名标题', markdown: 'one' }, {}, config, env)
  const second = await obsidian.write({ title: '同名标题', markdown: 'two' }, {}, config, env)

  assert.notEqual(first.ref, second.ref)
  assert.match(first.ref, /同名标题\.md$/)
  assert.match(second.ref, /同名标题 2\.md$/)
  assert.match(await readFile(first.ref, 'utf8'), /one/)
  assert.match(await readFile(second.ref, 'utf8'), /two/)
})

test('a pre-existing file is skipped instead of overwritten (the EEXIST path)', async () => {
  const dir = await mkdtemp(join(vault, 'preexist-'))
  const existing = join(dir, '占位.md')
  await writeFile(existing, 'original content', 'utf8')

  const saved = await obsidian.write({ title: '占位', markdown: 'new content' }, {}, configFor(dir), env)
  assert.notEqual(saved.ref, existing)
  assert.match(saved.ref, /占位 2\.md$/)
  assert.equal(await readFile(existing, 'utf8'), 'original content', 'the existing note must be untouched')
})

test('8 concurrent saves of the same title land in 8 distinct, intact files', async () => {
  const dir = await mkdtemp(join(vault, 'race-'))
  const config = configFor(dir)
  const COUNT = 8

  const saved = await Promise.all(
    Array.from({ length: COUNT }, (_, index) =>
      obsidian.write({ title: '并发标题', markdown: `marker-${index}` }, {}, config, env),
    ),
  )

  const refs = saved.map((entry) => entry.ref)
  assert.equal(new Set(refs).size, COUNT, `expected ${COUNT} distinct files, got ${new Set(refs).size}`)

  const files = (await readdir(dir)).filter((name) => name.endsWith('.md'))
  assert.equal(files.length, COUNT, `expected ${COUNT} files on disk, found ${files.length}`)

  // Every save's own content must survive: a lost update would leave a file
  // containing another save's marker (or none at all).
  const markers = []
  for (const ref of refs) {
    const text = await readFile(ref, 'utf8')
    const match = /marker-(\d+)/.exec(text)
    assert.ok(match !== null, `file ${ref} is missing its content`)
    markers.push(match[1])
  }
  assert.deepEqual(
    markers.map(Number).sort((left, right) => left - right),
    Array.from({ length: COUNT }, (_, index) => index),
    'every concurrent save must keep its own body',
  )
})
