/**
 * Lead-owned tests: Markdown rendering, config handling, the Obsidian adapter,
 * and message selection. Run with `node --test tests-lead/`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import obsidian from '../lib/adapters/obsidian.js'
import { configPath, readConfig } from '../lib/config.js'
import { blocksToMarkdown, renderNote, safeFileName, stamp, summarize } from '../lib/render.js'

/* ------------------------------------------------------------------ render */

test('blocksToMarkdown keeps text and drops tool blocks', () => {
  const md = blocksToMarkdown([
    { type: 'text', text: 'hello' },
    { type: 'tool-call', id: 'x', name: 'bash', arguments: '{}' },
    { type: 'text', text: 'world' },
  ])
  assert.equal(md, 'hello\n\nworld')
})

test('blocksToMarkdown includes reasoning only when asked', () => {
  const blocks = [
    { type: 'text', text: 'answer' },
    { type: 'reasoning', text: 'thinking hard' },
  ]
  assert.equal(blocksToMarkdown(blocks), 'answer')
  assert.match(blocksToMarkdown(blocks, { includeReasoning: true }), /思考过程[\s\S]*thinking hard/)
})

test('renderNote separates roles and shields inner headings', () => {
  const md = renderNote({
    messages: [
      { role: 'user', blocks: [{ type: 'text', text: '问一个问题' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: '# 内部标题\n正文' }] },
    ],
  })
  assert.match(md, /### 👤 用户/)
  assert.match(md, /### 🤖 助手/)
  assert.match(md, /\n\n---\n\n/)
  assert.match(md, /^ {4}# 内部标题/m, 'inner heading must not compete with the role heading')
})

test('renderNote without language uses English headings', () => {
  const md = renderNote({ messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }], lang: 'en' })
  assert.match(md, /### User/)
})

test('renderNote skips messages with no text', () => {
  const md = renderNote({
    messages: [
      { role: 'user', blocks: [{ type: 'tool-call', id: 'a', name: 'x', arguments: '' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: 'real' }] },
    ],
  })
  assert.doesNotMatch(md, /### 👤 用户/)
  assert.match(md, /real/)
})

test('summarize collapses whitespace and truncates by character', () => {
  assert.equal(summarize([{ role: 'user', blocks: [{ type: 'text', text: '  a \n\n b  ' }] }]), 'a b')
  const long = summarize([{ role: 'user', blocks: [{ type: 'text', text: '一'.repeat(80) }] }], 10)
  assert.equal([...long].length, 11)
  assert.ok(long.endsWith('…'))
})

test('safeFileName strips Windows-illegal characters and reserved names', () => {
  assert.equal(safeFileName('a/b:c*d?e"f<g>h|i'), 'a b c d e f g h i')
  assert.equal(safeFileName('CON'), '_CON')
  assert.equal(safeFileName('   '), 'note')
  assert.equal(safeFileName('...hidden'), 'hidden')
  assert.ok([...safeFileName('字'.repeat(200))].length <= 80)
})

test('stamp is filename friendly', () => {
  assert.match(stamp(new Date(2026, 10, 10, 13, 30, 5)), /^20261110-133005$/)
})

/* ------------------------------------------------------------------ config */

test('readConfig merges defaults, file and row config without throwing', async () => {
  const config = await readConfig({ defaultTarget: 'joplin', targets: { joplin: { token: 'row-token' } } })
  assert.equal(config.defaultTarget, 'joplin')
  assert.equal(config.targets.joplin.token, 'row-token')
  assert.equal(config.targets.joplin.baseUrl, 'http://127.0.0.1:41184', 'defaults survive the merge')
  assert.equal(config.targets.obsidian.subdir, '', 'no folder is preset: the user picks one')
  assert.equal(config.targets.obsidian.frontmatter, true)
  assert.equal(config.configPath, configPath())
})

/* ---------------------------------------------------------------- obsidian */

let vault = ''

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'note-save-'))
  await rm(join(vault, 'existing.md'), { force: true })
})

after(async () => {
  await rm(vault, { recursive: true, force: true })
})

/** Adapters take the whole plugin config; this builds one for Obsidian. */
const obsidianConfig = (settings) => ({ targets: { obsidian: settings } })

test('obsidian status auto-detects the vault Obsidian has open when none is configured', async () => {
  // No vault configured: the adapter reads Obsidian's own vault registry.
  const status = await obsidian.status(obsidianConfig({ vault: '' }))
  // On a machine with Obsidian installed this resolves; on one without, it
  // reports the reason instead. Either way it must not throw and must explain.
  assert.equal(typeof status.configured, 'boolean')
  assert.equal(typeof status.detail, 'string')
  if (status.configured) {
    assert.match(status.detail, /自动发现|\\|\//)
  } else {
    assert.match(status.detail, /vault/)
  }
})

test('obsidian status rejects a missing directory', async () => {
  const status = await obsidian.status(obsidianConfig({ vault: join(vault, 'nope') }))
  assert.equal(status.configured, false)
  assert.match(status.detail, /不存在/)
})

test('obsidian status accepts a real directory', async () => {
  const status = await obsidian.status(obsidianConfig({ vault }))
  assert.equal(status.configured, true)
})

test('obsidian write creates markdown with frontmatter and a safe name', async () => {
  const result = await obsidian.write(
    { title: 'a/b: c', markdown: '# 标题\n\n正文' },
    {},
    obsidianConfig({ vault, subdir: '', frontmatter: true }),
  )
  assert.equal(result.created, true)
  assert.ok(result.ref.startsWith(vault))
  assert.match(result.ref, /a b c\.md$/)
  const text = await readFile(result.ref, 'utf8')
  assert.match(text, /^---\ntitle: "a\/b: c"/)
  assert.match(text, /source: deepseek-harness/)
  assert.match(text, /# 标题/)
})

test('obsidian write never overwrites: a second save gets a numbered name', async () => {
  const config = obsidianConfig({ vault, subdir: '', frontmatter: false })
  const first = await obsidian.write({ title: 'dup', markdown: 'one' }, {}, config)
  const second = await obsidian.write({ title: 'dup', markdown: 'two' }, {}, config)
  assert.notEqual(first.ref, second.ref)
  assert.match(second.ref, /dup 2\.md$/)
  assert.match(await readFile(second.ref, 'utf8'), /two/)
})

test('obsidian write writes into a chosen subdirectory', async () => {
  const result = await obsidian.write(
    { title: 'sub', markdown: 'x' },
    { location: 'nested' },
    obsidianConfig({ vault, frontmatter: false }),
  )
  assert.ok(result.ref.includes('nested'))
  const entries = await readdir(join(vault, 'nested'))
  assert.ok(entries.includes('sub.md'))
})

test('obsidian write refuses to escape the vault', async () => {
  await assert.rejects(
    () => obsidian.write({ title: 'x', markdown: 'y' }, { location: '../../etc' }, obsidianConfig({ vault })),
    /越出 vault/,
  )
})

test('obsidian options lists the root plus subdirectories', async () => {
  const options = await obsidian.options(obsidianConfig({ vault, subdir: 'DSH' }))
  const ids = options.locations.map((location) => location.id)
  assert.ok(ids.includes(''))
  assert.ok(ids.includes('DSH'))
  assert.ok(ids.includes('nested'))
})

/* --------------------------------------------------------------- selection */

test('selectMessages honours message / turn / session scopes', async () => {
  const { internals } = await import('../index.js')
  const messages = [
    { id: 'u1', role: 'user', turn: 0, blocks: [] },
    { id: 'a1', role: 'assistant', turn: 0, blocks: [] },
    { id: 'u2', role: 'user', turn: 1, blocks: [] },
    { id: 'a2', role: 'assistant', turn: 1, blocks: [] },
  ]
  assert.deepEqual(internals.selectMessages(messages, 'session', 'a2').map((m) => m.id), ['u1', 'a1', 'u2', 'a2'])
  assert.deepEqual(internals.selectMessages(messages, 'turn', 'a2').map((m) => m.id), ['u2', 'a2'])
  assert.deepEqual(internals.selectMessages(messages, 'message', 'a2').map((m) => m.id), ['u2', 'a2'])
  assert.deepEqual(internals.selectMessages(messages, 'message', 'u1').map((m) => m.id), ['u1', 'a1'])
})

test('selectMessages falls back to the last assistant message for an unknown anchor', async () => {
  const { internals } = await import('../index.js')
  const messages = [
    { id: 'u1', role: 'user', turn: 0, blocks: [] },
    { id: 'a1', role: 'assistant', turn: 0, blocks: [] },
  ]
  assert.deepEqual(internals.selectMessages(messages, 'message', 'streaming').map((m) => m.id), ['a1'])
})
