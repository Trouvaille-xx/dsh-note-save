/**
 * Cross-adapter contract test: the one thing the per-adapter suites cannot
 * prove on their own — that the registry, the config shape and the whole
 * `index.js` pipeline agree on ONE contract.
 *
 * Run with `node tests-lead/contract.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { adapterOf, listAdapters, makeEnv } from '../lib/adapters/index.js'
import { readConfig, TARGET_IDS } from '../lib/config.js'

let vault = ''
let dshHome = ''
let previousHome

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'note-contract-'))
  // Isolate the plugin's config: tests must never read or write the user's
  // real ~/.dsh/note-save.json.
  previousHome = process.env.DSH_HOME
  dshHome = await mkdtemp(join(tmpdir(), 'note-home-'))
  process.env.DSH_HOME = dshHome
})

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(vault, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
})

/** A fake ctx exposing only what index.js touches. */
function fakeCtx({ events = [], title = '测试标题' } = {}) {
  const ctx = {
    sessions: { get: () => ({ snapshotEvents: () => events }) },
    sessionQuery: { readTitle: async () => ({ title }) },
    logger: { warn() {}, error() {}, info() {} },
    get: (name) => (name === 'sessionQuery' ? ctx.sessionQuery : name === 'logger' ? ctx.logger : undefined),
  }
  return ctx
}

function messageEvent(seq, role, text, turn = 0) {
  const message = {
    id: `m${seq}`,
    role,
    content: [{ type: 'text', text }],
  }
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: role === 'user' ? 'user/message' : 'assistant/message',
    data: role === 'user' ? message : { turn, step: 0, message, stream: [] },
  }
}

test('every registered adapter satisfies the same surface', () => {
  const adapters = listAdapters()
  assert.deepEqual(adapters.map((adapter) => adapter.id), TARGET_IDS)
  for (const adapter of adapters) {
    assert.equal(typeof adapter.id, 'string')
    assert.equal(typeof adapter.label, 'string')
    for (const method of ['status', 'options', 'write', 'test']) {
      assert.equal(typeof adapter[method], 'function', `${adapter.id}.${method} must be a function`)
    }
    assert.ok(Array.isArray(adapter.fields), `${adapter.id}.fields must be an array`)
    assert.ok(adapter.fields.length > 0, `${adapter.id}.fields must not be empty`)
    for (const field of adapter.fields) {
      assert.equal(typeof field.key, 'string', `${adapter.id} field key`)
      assert.ok(field.key.length > 0)
      assert.equal(typeof field.label, 'string', `${adapter.id}.${field.key} needs a label`)
      assert.ok(field.label.length > 0)
      assert.ok(['text', 'password', 'url'].includes(field.type), `${adapter.id}.${field.key} type`)
      assert.equal(typeof field.required, 'boolean')
      assert.equal(typeof field.secret, 'boolean')
    }
    const keys = adapter.fields.map((field) => field.key)
    assert.equal(new Set(keys).size, keys.length, `${adapter.id} field keys must be unique`)
  }
})

test('every adapter field key exists in the resolved config defaults', async () => {
  // A field the settings page renders but the adapter never reads (or vice
  // versa) is the kind of mismatch that makes a saved token do nothing.
  const config = await readConfig({})
  for (const adapter of listAdapters()) {
    const settings = config.targets[adapter.id] ?? {}
    for (const field of adapter.fields) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(settings, field.key),
        `${adapter.id}.${field.key} is not in the config defaults`,
      )
    }
  }
})

test('adapterOf rejects an unknown target with a readable message', () => {
  assert.throws(() => adapterOf('evernote'), /未知目标系统：evernote/)
})

test('every adapter accepts the WHOLE config and reports itself unconfigured', async () => {
  const config = await readConfig({})
  const env = makeEnv(console)
  for (const adapter of listAdapters()) {
    if (adapter.id === 'obsidian') {
      // The shared config may carry a real vault; assert the shape instead.
      const status = await adapter.status(config, env)
      assert.equal(typeof status.configured, 'boolean')
      continue
    }
    const status = await adapter.status(config, env)
    assert.equal(status.configured, false, `${adapter.id} should be unconfigured with empty settings`)
    assert.equal(typeof status.detail, 'string')
    assert.ok(status.detail.length > 0)

    const options = await adapter.options(config, env)
    assert.deepEqual(options.locations, [], `${adapter.id} must return no locations while unconfigured`)
  }
})

test('the flat-slice bug cannot come back: a per-target slice is rejected, not silently accepted', async () => {
  // Regression guard for the defect this contract test was written after: the
  // host used to hand adapters `config.targets.<id>` instead of the whole
  // config. A slice has no `.targets`, so every adapter would read empty
  // settings — reporting "unconfigured" forever with a real token on disk.
  const env = makeEnv(console)
  const full = await readConfig({ targets: { joplin: { token: 'real-token-abc' } } })
  const fullStatus = await adapterOf('joplin').status(full, env)
  assert.equal(fullStatus.configured, true, 'whole config with a token must configure Joplin')

  const slice = full.targets.joplin
  const sliceStatus = await adapterOf('joplin').status(slice, env)
  assert.equal(sliceStatus.configured, false, 'a bare slice must NOT configure Joplin')
})

test('preview and save run end to end through the real pipeline (Obsidian)', async () => {
  const { internals } = await import('../index.js')
  const events = [
    messageEvent(1, 'user', '这个项目的部署流程是什么？'),
    messageEvent(2, 'assistant', '分三步：构建、推送镜像、滚动更新。', 0),
    messageEvent(3, 'user', '那回滚呢？', 1),
    messageEvent(4, 'assistant', '用上一个镜像 tag 重新部署。', 1),
  ]
  const ctx = fakeCtx({ events, title: '部署与回滚' })
  const rowConfig = { targets: { obsidian: { vault, subdir: '', frontmatter: true } } }
  const env = makeEnv(console)

  const preview = await internals.previewOperation(ctx, rowConfig, {
    sessionId: 'session-1',
    scope: 'session',
  })
  assert.equal(preview.title, '部署与回滚')
  assert.equal(preview.stats.messages, 4)
  assert.match(preview.markdown, /### 👤 用户/)
  assert.match(preview.markdown, /滚动更新/)

  const saved = await internals.saveOperation(
    ctx,
    rowConfig,
    { sessionId: 'session-1', scope: 'message', messageId: 'm4', target: 'obsidian' },
    env,
  )
  assert.equal(saved.target, 'obsidian')
  assert.equal(saved.created, true)
  assert.ok((await stat(saved.ref)).isFile(), 'the note must exist on disk')

  const { readFile } = await import('node:fs/promises')
  const text = await readFile(saved.ref, 'utf8')
  // scope=message on an assistant reply carries its prompt, not the whole log.
  assert.match(text, /那回滚呢/)
  assert.match(text, /上一个镜像 tag/)
  assert.doesNotMatch(text, /部署流程/, 'scope=message must not include an earlier turn')
})

test('save refuses an unconfigured target before writing anything', async () => {
  const { internals } = await import('../index.js')
  const ctx = fakeCtx({ events: [messageEvent(1, 'assistant', 'x')] })
  const rowConfig = { targets: { joplin: { token: '', baseUrl: 'http://127.0.0.1:41184' } } }
  await assert.rejects(
    () =>
      internals.saveOperation(
        ctx,
        rowConfig,
        { sessionId: 's', scope: 'message', messageId: 'm1', target: 'joplin' },
        makeEnv(console),
      ),
    /未配置/,
  )
})

test('stateOperation reports every target with a usable default', async () => {
  const { internals } = await import('../index.js')
  const state = await internals.stateOperation({ targets: { obsidian: { vault } } }, makeEnv(console))
  assert.equal(state.targets.length, TARGET_IDS.length)
  assert.deepEqual(state.targets.map((target) => target.id), TARGET_IDS)
  assert.equal(state.defaultTarget, 'obsidian')
  assert.ok(state.configPath.endsWith('note-save.json'))
})

test('stateOperation falls back to the first configured target for an unknown default', async () => {
  const { internals } = await import('../index.js')
  const state = await internals.stateOperation(
    { defaultTarget: 'evernote', targets: { obsidian: { vault } } },
    makeEnv(console),
  )
  assert.equal(state.defaultTarget, 'obsidian')
})

test('ima is an API target with a credential pair, not a folder', async () => {
  // ima exposes an official OpenAPI for note creation (verified live: the
  // routes answer 401 "clientID or apiKey is empty" without credentials), so
  // this target creates a note over HTTP. The detailed request contract lives
  // in tests-lead/ima.test.mjs; here we only pin the registry-level shape.
  const ima = adapterOf('ima')
  const config = { targets: { ima: { clientId: '', apiKey: '', notebook: '' } } }
  const env = makeEnv(console)

  const status = await ima.status(config, env)
  assert.equal(status.configured, false)
  assert.match(status.detail, /Client ID|API Key/)

  const keys = ima.fields.map((field) => field.key)
  assert.deepEqual(keys, ['clientId', 'apiKey', 'notebook'])
  assert.equal(ima.fields.some((field) => field.key === 'folder'), false, 'no file-drop field survives')
})
