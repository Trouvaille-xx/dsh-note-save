/**
 * Feishu adapter tests.
 *
 * The request shapes are pinned against larksuite/oapi-sdk-python's generated
 * models (the `*_request.py` / `*_request_body.py` files carry `uri`, `paths`
 * and the body field names). Probed live without credentials too: the two GET
 * routes answer `{"code":99991663,"msg":"Invalid access token…"}`, so `test()`
 * and `options()` are read-only calls to a route that really exists.
 *
 * Every test uses its own appId so the module-level tenant-token cache cannot
 * leak between cases.
 *
 * Run with `node tests-lead/feishu.test.mjs`.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import feishu from '../lib/adapters/feishu.js'

const configured = (appId, extra = {}) => ({
  targets: { feishu: { appId, appSecret: `${appId}-secret`, folderToken: 'fld-root', ...extra } },
})

/** A recording fetch: returns one canned response and keeps every request. */
function makeEnv(handler) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const raw = init.body
    const record = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} }
    if (raw instanceof FormData) {
      const form = {}
      for (const [key, value] of raw.entries()) {
        form[key] = value !== null && typeof value === 'object'
          ? { name: value.name, size: value.size, type: value.type }
          : value
      }
      record.form = form
    } else if (typeof raw === 'string') {
      try {
        record.body = JSON.parse(raw)
      } catch {
        record.body = raw
      }
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

/** Routes the four calls a successful save makes. Overridable per test. */
function happyHandler(overrides = {}) {
  return (call) => {
    if (call.url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 't-cache-me', expire: 7200 } }
    }
    if (call.url.includes('/medias/upload_all')) {
      return { json: { code: 0, data: { file_token: 'box-1' } } }
    }
    if (call.url.endsWith('/import_tasks') && call.method === 'POST') {
      return { json: { code: 0, data: { ticket: 'ticket-1' } } }
    }
    if (call.url.includes('/import_tasks/')) {
      return { json: { code: 0, data: { result: { job_status: 0, token: 'dox-1', url: 'https://acme.feishu.cn/docx/dox-1' } } } }
    }
    if (call.url.includes('/open-apis/drive/v1/files')) {
      return { json: { code: 0, data: { files: [] } } }
    }
    return overrides(call)
  }
}

test('feishu is an app-credential target with a folder token', () => {
  const keys = feishu.fields.map((field) => field.key)
  assert.deepEqual(keys, ['appId', 'appSecret', 'folderToken'])
  assert.equal(feishu.fields.find((field) => field.key === 'appSecret').secret, true)
  assert.equal(feishu.fields.find((field) => field.key === 'folderToken').required, true)
  for (const field of feishu.fields) {
    assert.equal(typeof field.required, 'boolean')
    assert.equal(typeof field.secret, 'boolean')
  }
})

test('status: unconfigured, partially configured, and configured', async () => {
  assert.equal((await feishu.status({ targets: { feishu: {} } })).configured, false)
  assert.equal((await feishu.status(configured(''), {})).configured, false)
  const partial = await feishu.status({ targets: { feishu: { appId: 'cli_x', appSecret: '', folderToken: 'fld' } } })
  assert.equal(partial.configured, false)
  assert.match(partial.detail, /App Secret/)

  const ready = await feishu.status(configured('cli_status_ok'))
  assert.equal(ready.configured, true)
  assert.match(ready.detail, /fld-root/)
})

test('test() sends no request at all while unconfigured', async () => {
  const { env, calls } = makeEnv(happyHandler())
  const result = await feishu.test({ targets: { feishu: { appId: 'cli_x' } } }, env)
  assert.equal(result.ok, false)
  assert.equal(calls.length, 0, 'an unconfigured target must not hit the network')
})

test('test() is a read-only probe of the target folder', async () => {
  const { env, calls } = makeEnv(happyHandler())
  const result = await feishu.test(configured('cli_probe'), env)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 2, 'token + one GET')
  assert.equal(calls[0].method, 'POST')
  assert.match(calls[0].url, /tenant_access_token\/internal$/)
  assert.equal(calls[1].method, 'GET', 'the credential probe must not write')
  assert.match(calls[1].url, /\/open-apis\/drive\/v1\/files\?/)
  assert.match(calls[1].url, /folder_token=fld-root/)
  assert.equal(calls[1].headers.authorization, 'Bearer t-cache-me')
})

test('write() uploads, imports and polls, then returns the docx ref', async () => {
  const { env, calls } = makeEnv(happyHandler())
  const saved = await feishu.write(
    { title: '部署与回滚', markdown: '# 部署与回滚\n\n分三步。' },
    {},
    configured('cli_write'),
    env,
  )

  assert.deepEqual(calls.map((call) => call.method), ['POST', 'POST', 'POST', 'GET'])
  assert.match(calls[0].url, /tenant_access_token\/internal$/)

  const upload = calls[1]
  assert.match(upload.url, /\/open-apis\/drive\/v1\/medias\/upload_all$/)
  assert.equal(upload.form.parent_type, 'ccm_import_open')
  assert.equal(upload.form.parent_node, 'fld-root')
  assert.match(upload.form.file_name, /\.md$/)
  assert.ok(Number(upload.form.size) > 0, 'size must be the utf-8 byte length')
  assert.equal(upload.headers['content-type'], undefined, 'FormData must set its own boundary')
  assert.equal(upload.headers.authorization, 'Bearer t-cache-me')

  const create = calls[2]
  assert.match(create.url, /\/open-apis\/drive\/v1\/import_tasks$/)
  assert.equal(create.body.file_extension, 'md')
  assert.equal(create.body.type, 'docx')
  assert.equal(create.body.file_token, 'box-1')
  assert.match(create.body.file_name, /\.md$/)
  assert.deepEqual(create.body.point, { mount_type: 1, mount_key: 'fld-root' })

  assert.match(calls[3].url, /\/open-apis\/drive\/v1\/import_tasks\/ticket-1$/)
  assert.deepEqual(saved, { ref: 'dox-1', url: 'https://acme.feishu.cn/docx/dox-1', created: true })
})

test('write() honors the panel-selected sub-folder over the configured root', async () => {
  const { env, calls } = makeEnv(happyHandler())
  await feishu.write({ title: 'T', markdown: 'body' }, { location: 'fld-sub' }, configured('cli_sub'), env)
  const upload = calls.find((call) => call.url.includes('/medias/upload_all'))
  const create = calls.find((call) => call.url.includes('/import_tasks') && call.method === 'POST')
  assert.equal(upload.form.parent_node, 'fld-sub')
  assert.equal(create.body.point.mount_key, 'fld-sub')
})

test('write() refuses an empty body before touching the network', async () => {
  const { env, calls } = makeEnv(happyHandler())
  await assert.rejects(
    () => feishu.write({ title: 'T', markdown: '   ' }, {}, configured('cli_empty'), env),
    /markdown 为空/,
  )
  assert.equal(calls.length, 0)
})

test('write() refuses a missing credential before touching the network', async () => {
  const { env, calls } = makeEnv(happyHandler())
  await assert.rejects(
    () => feishu.write({ title: 'T', markdown: 'body' }, {}, { targets: { feishu: { appId: 'cli_x' } } }, env),
    /飞书未配置/,
  )
  assert.equal(calls.length, 0)
})

test('a business error inside a 200 response is a failure, not a silent success', async () => {
  const { env } = makeEnv((call) => {
    if (call.url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 't-err', expire: 7200 } }
    }
    if (call.url.includes('/medias/upload_all')) {
      return { json: { code: 1061004, msg: 'forbidden' } }
    }
    return { json: { code: 0 } }
  })
  await assert.rejects(
    () => feishu.write({ title: 'T', markdown: 'body' }, {}, configured('cli_berr'), env),
    /1061004/,
  )
})

test('an import task that fails reports the upstream reason', async () => {
  const { env } = makeEnv((call) => {
    if (call.url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 't-imp', expire: 7200 } }
    }
    if (call.url.includes('/medias/upload_all')) return { json: { code: 0, data: { file_token: 'box-2' } } }
    if (call.url.endsWith('/import_tasks') && call.method === 'POST') {
      return { json: { code: 0, data: { ticket: 'ticket-2' } } }
    }
    return { json: { code: 0, data: { result: { job_status: 3, job_error_msg: 'file too large' } } } }
  })
  await assert.rejects(
    () => feishu.write({ title: 'T', markdown: 'body' }, {}, configured('cli_impfail'), env),
    /导入失败.*file too large/,
  )
})

test('the tenant token is cached across saves with the same credentials', async () => {
  const { env, calls } = makeEnv(happyHandler())
  const config = configured('cli_cache')
  await feishu.write({ title: 'A', markdown: 'a' }, {}, config, env)
  await feishu.write({ title: 'B', markdown: 'b' }, {}, config, env)
  const tokenCalls = calls.filter((call) => call.url.endsWith('/tenant_access_token/internal'))
  assert.equal(tokenCalls.length, 1, 'the second save must reuse the cached tenant token')
})

test('options() lists sub-folders as save locations, folders only', async () => {
  const { env } = makeEnv((call) => {
    if (call.url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 't-opt', expire: 7200 } }
    }
    return {
      json: {
        code: 0,
        data: {
          files: [
            { token: 'fld-a', name: 'DSH 笔记', type: 'folder' },
            { token: 'dox-b', name: '某篇文档', type: 'docx' },
          ],
        },
      },
    }
  })
  const options = await feishu.options(configured('cli_opt'), env)
  assert.deepEqual(options.locations, [{ id: 'fld-a', label: 'DSH 笔记／' }])
})

test('options() degrades to a note instead of throwing when the folder is unreadable', async () => {
  const { env } = makeEnv((call) => {
    if (call.url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) {
      return { json: { code: 0, tenant_access_token: 't-opt2', expire: 7200 } }
    }
    return { status: 403, json: { code: 1061004, msg: 'forbidden' } }
  })
  const options = await feishu.options(configured('cli_opt2'), env)
  assert.deepEqual(options.locations, [])
  assert.match(options.note, /读取飞书文件夹失败/)
})
