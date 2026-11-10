/**
 * ima adapter tests.
 *
 * The endpoint contract comes from Tencent's own Octop adapter and was verified
 * live: every route answers 401 `{"code":200002,"msg":"clientID or apiKey is
 * empty"}` without credentials, and `"skill auth failed"` once the
 * `ima-openapi-clientid` / `ima-openapi-apikey` headers carry a bogus pair —
 * which is what pins the header names.
 *
 * Run with `node tests-lead/ima.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import ima from '../lib/adapters/ima.js'

const CONFIGURED = { targets: { ima: { clientId: 'cid-123', apiKey: 'key-456', notebook: '' } } }

/** A recording fetch: returns one canned response and keeps every request. */
function makeEnv(handler) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const record = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(record)
    const { status = 200, json } = handler(record) ?? {}
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(json ?? {}),
      json: async () => json ?? {},
    }
  }
  return { env: { fetch }, calls }
}

test('ima is an API target, not a folder', () => {
  const keys = ima.fields.map((field) => field.key)
  assert.deepEqual(keys, ['clientId', 'apiKey', 'notebook'])
  assert.equal(ima.fields.find((field) => field.key === 'apiKey').secret, true)
  assert.equal(ima.fields.some((field) => field.key === 'folder'), false, 'the file-drop model is gone')
})

test('status needs both halves of the credential pair', async () => {
  assert.equal((await ima.status({ targets: { ima: { clientId: 'x' } } })).configured, false)
  assert.equal((await ima.status({ targets: { ima: { apiKey: 'y' } } })).configured, false)
  assert.equal((await ima.status(CONFIGURED)).configured, true)
})

test('test() probes the read-only knowledge-base route with the credential headers', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: {} } }))
  const result = await ima.test(CONFIGURED, env)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.match(calls[0].url, /^https:\/\/ima\.qq\.com\/openapi\/wiki\/v1\/search_knowledge_base$/)
  assert.equal(calls[0].headers['ima-openapi-clientid'], 'cid-123')
  assert.equal(calls[0].headers['ima-openapi-apikey'], 'key-456')
  assert.deepEqual(calls[0].body, { query: '', cursor: '', limit: 1 })
})

test('test() reports a rejected credential pair', async () => {
  const { env } = makeEnv(() => ({ status: 401, json: { code: 200002, msg: 'skill auth failed' } }))
  const result = await ima.test(CONFIGURED, env)
  assert.equal(result.ok, false)
  assert.match(result.detail, /Client ID|API Key|agent-interface/)
})

test('write() creates the note with import_doc and Markdown content', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: { note_id: 'note-1' } } }))
  const written = await ima.write({ title: '部署与回滚', markdown: '### 用户\n\n正文' }, {}, CONFIGURED, env)

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.match(call.url, /openapi\/note\/v1\/import_doc$/)
  assert.equal(call.headers['ima-openapi-clientid'], 'cid-123')
  assert.equal(call.body.content_format, 1, '1 means Markdown')
  assert.equal(call.body.folder_id, undefined, 'no notebook configured means no folder_id')
  // import_doc takes no title field: the title rides in as the first heading.
  assert.match(call.body.content, /^# 部署与回滚\n\n### 用户/)
  assert.equal(written.created, true)
  assert.equal(written.ref, 'note-1')
  assert.match(written.url, /note-1$/)
})

test('write() does not double up a heading the body already has', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: { note_id: 'n' } } }))
  await ima.write({ title: '标题', markdown: '# 已有标题\n\n正文' }, {}, CONFIGURED, env)
  assert.match(calls[0].body.content, /^# 已有标题\n\n正文$/)
})

test('write() puts the note in the chosen notebook', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: { note_id: 'n' } } }))
  await ima.write({ title: 'T', markdown: 'body' }, { location: 'box-9' }, CONFIGURED, env)
  assert.equal(calls[0].body.folder_id, 'box-9')
})

test('write() falls back to the configured notebook', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: { note_id: 'n' } } }))
  const config = { targets: { ima: { clientId: 'c', apiKey: 'k', notebook: 'box-cfg' } } }
  await ima.write({ title: 'T', markdown: 'body' }, {}, config, env)
  assert.equal(calls[0].body.folder_id, 'box-cfg')
})

test('write() refuses empty content without calling the API', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: {} } }))
  await assert.rejects(() => ima.write({ title: 'T', markdown: '   ' }, {}, CONFIGURED, env), /markdown 为空/)
  assert.equal(calls.length, 0)
})

test('a business error inside HTTP 200 is still a failure', async () => {
  // ima reports failures in the body, so code !== 0 must not look like success.
  const { env } = makeEnv(() => ({ status: 200, json: { code: 400101, msg: '内容过长' } }))
  await assert.rejects(() => ima.write({ title: 'T', markdown: 'body' }, {}, CONFIGURED, env), /内容过长.*400101/)
})

test('options() lists notebooks as locations, and degrades when the call fails', async () => {
  const { env } = makeEnv(() => ({
    json: { code: 0, data: { note_folder_infos: [{ folder_id: 'nb-1', name: '工作' }, { folder_id: 'nb-2', name: '读书' }] } },
  }))
  const options = await ima.options(CONFIGURED, env)
  assert.deepEqual(
    options.locations.map((entry) => entry.id),
    ['nb-1', 'nb-2'],
  )

  const failing = makeEnv(() => ({ status: 500, json: {} }))
  const degraded = await ima.options(CONFIGURED, failing.env)
  assert.deepEqual(degraded.locations, [], 'a listing failure yields no fake destination')
  assert.match(degraded.note, /读取笔记本失败/)
})

test('options() makes no request without credentials', async () => {
  const { env, calls } = makeEnv(() => ({ json: { code: 0, data: {} } }))
  const options = await ima.options({ targets: { ima: {} } }, env)
  assert.equal(calls.length, 0)
  assert.deepEqual(options.locations, [])
})

test('options() reads the real payload shape, and tolerates plausible others', async () => {
  // Verified live against the real API: the container is `note_folder_infos`
  // and each entry carries `folder_id` + `name` (+ `note_number`). The other
  // shapes are tolerated in case the payload is ever reshaped.
  for (const payload of [
    { note_folder_infos: [{ folder_id: 'folderA', name: 'AI产品经理笔记', note_number: '1' }] },
    { notebooks: [{ id: 'a', name: '工作' }] },
    { notebook_list: [{ notebook_id: 'b', title: '读书' }] },
    { list: [{ folder_id: 'c', name: '收集' }] },
    { items: [{ id: 'd', book_name: '项目' }] },
    [{ id: 'e', name: '数组直给' }],
  ]) {
    const { env } = makeEnv(() => ({ json: { code: 0, data: payload } }))
    const options = await ima.options(CONFIGURED, env)
    assert.equal(options.locations.length, 1, `should list one notebook for ${JSON.stringify(payload).slice(0, 44)}`)
    assert.notEqual(options.locations[0].id, '')
    assert.notEqual(options.locations[0].label, options.locations[0].id, 'the label must be the name when present')
  }
})

test('the real payload keeps the note count in the label', async () => {
  const { env } = makeEnv(() => ({
    json: {
      code: 0,
      msg: 'success',
      data: {
        note_folder_infos: [
          { folder_id: 'folderdea2c48a852b4f4b', name: 'AI产品经理笔记', note_number: '1', folder_type: 0 },
          { folder_id: 'folder1d187d5842bb038b', name: '笔记本', note_number: '0', folder_type: 0 },
        ],
        is_end: true,
      },
    },
  }))
  const options = await ima.options(CONFIGURED, env)
  assert.deepEqual(
    options.locations.map((entry) => entry.id),
    ['folderdea2c48a852b4f4b', 'folder1d187d5842bb038b'],
  )
  assert.match(options.locations[0].label, /AI产品经理笔记（1 条笔记）/)
})

test('an empty notebook list is reported, not silently offered', async () => {
  const { env } = makeEnv(() => ({ json: { code: 0, data: { note_folder_infos: [], is_end: true } } }))
  const options = await ima.options(CONFIGURED, env)
  assert.deepEqual(options.locations, [])
  assert.match(options.note, /还没有笔记本/)
})

test('the notebook field is a list-backed picker, not a blind id box', () => {
  const notebook = ima.fields.find((field) => field.key === 'notebook')
  assert.equal(notebook.pick, 'location', 'the settings page needs to know to render a picker')
  assert.equal(notebook.required, false, 'leaving it empty means the default location')
})
