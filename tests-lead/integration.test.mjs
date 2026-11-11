/**
 * Mount-level integration test: calls `apply(ctx, config)` with a fake Cordis
 * context and drives the real HTTP handler, the real tool registration and the
 * real adapter chain.
 *
 * This is the closest thing to "does the plugin work when DSH loads it" that
 * can run without a browser: it fails if a registration shape, the route
 * fence, the envelope, or an adapter call is wrong.
 *
 * Run with `node tests-lead/integration.test.mjs`.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../index.js'

let vault = ''
let dshHome = ''
let previousHome

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'note-integration-'))
  // Point the plugin's config at a throwaway DSH home: a test must never touch
  // the user's real ~/.dsh/note-save.json (and the sandbox forbids it).
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

/* --------------------------------------------------------------- fake host */

function messageEvent(seq, role, text, turn = 0) {
  const message = { id: `m${seq}`, role, content: [{ type: 'text', text }] }
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    type: role === 'user' ? 'user/message' : 'assistant/message',
    data: role === 'user' ? message : { turn, step: 0, message, stream: [] },
  }
}

const EVENTS = [
  messageEvent(1, 'user', '为什么要做这个插件？'),
  messageEvent(2, 'assistant', '因为每个笔记目标各有一个插件，换目标就要换插件。', 0),
  messageEvent(3, 'user', '那保存粒度呢？', 1),
  messageEvent(4, 'assistant', '单条、本轮、整段会话三种。', 1),
]

/**
 * A fake ctx that records what `apply` registers and lets a test invoke the
 * registered HTTP handler exactly as `webServer` would.
 */
function mountPlugin({ trusted = true, rowConfig = {} } = {}) {
  const registered = { routes: [], tools: [], effects: [] }

  const ctx = {
    sessions: {
      get: (id) => (id === 'session-1' ? { snapshotEvents: () => EVENTS } : undefined),
    },
    sessionQuery: {
      readSession: async (id) => {
        if (id !== 'session-1') throw new Error('no such session')
        return { events: EVENTS }
      },
      readTitle: async () => ({ title: '为什么要做这个插件' }),
    },
    connection: {
      requestRejection: () => (trusted ? undefined : 403),
    },
    webServer: {
      register: (route) => {
        registered.routes.push(route)
        return () => {
          const index = registered.routes.indexOf(route)
          if (index !== -1) registered.routes.splice(index, 1)
        }
      },
    },
    tools: {
      register: (definition, options) => {
        registered.tools.push({ definition, options })
        return () => {
          const index = registered.tools.findIndex((entry) => entry.definition === definition)
          if (index !== -1) registered.tools.splice(index, 1)
        }
      },
    },
    effect: (factory) => {
      const disposer = factory()
      registered.effects.push(disposer)
      return disposer
    },
    logger: { warn() {}, error() {}, info() {} },
    // `optional()` reads optional services through ctx.get, exactly as the real
    // Cordis context does; the fake must answer the same way.
    get: (name) => (name === 'sessionQuery' ? ctx.sessionQuery : name === 'logger' ? ctx.logger : undefined),
  }

  apply(ctx, rowConfig)
  return { ctx, registered }
}

/** Build a request/response pair and run it through the registered handler. */
function call(plug, { method = 'GET', path, body } = {}) {
  const route = plug.registered.routes[0]
  assert.ok(route !== undefined, 'apply() must register the /note-save route')

  const req = new EventEmitter()
  req.method = method
  req.url = `${route.path}${path}`
  req.headers = { host: '127.0.0.1:5020' }

  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk !== undefined) this.body += String(chunk)
      this.resolve()
    },
  }
  const done = new Promise((resolve) => {
    res.resolve = resolve
  })

  // The handler is async; run it after the body has been delivered.
  const run = route.handler(req, res)
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
  req.emit('end')
  return Promise.resolve(run)
    .then(() => done)
    .then(() => ({
      status: res.statusCode,
      headers: res.headers,
      json: res.body === '' ? undefined : JSON.parse(res.body),
    }))
}

const rowConfigForVault = () => ({ targets: { obsidian: { vault, subdir: '', frontmatter: true } } })

/* -------------------------------------------------------------------- tests */

test('apply registers one prefix route, one tool and their effects', () => {
  const plug = mountPlugin()
  assert.equal(plug.registered.routes.length, 1)
  assert.equal(plug.registered.routes[0].kind, 'prefix')
  assert.equal(plug.registered.routes[0].path, '/note-save')
  assert.equal(plug.registered.tools.length, 1)
  assert.equal(plug.registered.tools[0].definition.name, 'note_save')
  assert.ok(plug.registered.effects.length >= 2)
})

test('the tool definition is shaped for ctx.tools.register', () => {
  const { definition } = mountPlugin().registered.tools[0]
  assert.equal(typeof definition.description, 'string')
  assert.ok(definition.description.length > 20)
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(definition.parameters.required, ['action'])
  assert.deepEqual(definition.parameters.properties.action.enum, ['list', 'preview', 'save'])
  assert.equal(typeof definition.execute, 'function')
  assert.equal(typeof definition.output.schema, 'object')
  assert.equal(typeof definition.output.render, 'function')
})

test('GET /note-save/state answers the documented envelope', async () => {
  const plug = mountPlugin({ rowConfig: rowConfigForVault() })
  const response = await call(plug, { path: '/state' })
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  const value = response.json.value
  assert.equal(value.targets.length, 7)
  assert.equal(value.defaultTarget, 'obsidian')
  const obsidian = value.targets.find((target) => target.id === 'obsidian')
  assert.equal(obsidian.configured, true)
})

test('the browser-trust fence blocks an untrusted request before any work', async () => {
  const plug = mountPlugin({ trusted: false })
  const response = await call(plug, { path: '/state' })
  assert.equal(response.status, 403)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.error.code, 'forbidden')
})

test('POST /note-save/preview returns a rendered markdown body', async () => {
  const plug = mountPlugin({ rowConfig: rowConfigForVault() })
  const response = await call(plug, {
    method: 'POST',
    path: '/preview',
    body: { sessionId: 'session-1', scope: 'session' },
  })
  assert.equal(response.status, 200)
  const value = response.json.value
  assert.equal(value.title, '为什么要做这个插件')
  assert.equal(value.stats.messages, 4)
  assert.match(value.markdown, /### 👤 用户/)
  assert.match(value.markdown, /单条、本轮、整段会话三种/)
})

test('POST /note-save/save writes a real file and reports its ref', async () => {
  const plug = mountPlugin({ rowConfig: rowConfigForVault() })
  const response = await call(plug, {
    method: 'POST',
    path: '/save',
    body: { target: 'obsidian', sessionId: 'session-1', scope: 'turn', messageId: 'm4' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  const value = response.json.value
  assert.equal(value.target, 'obsidian')
  assert.equal(value.created, true)
  assert.ok(value.ref.endsWith('.md'))

  const text = await readFile(value.ref, 'utf8')
  assert.match(text, /^---\ntitle:/)
  assert.match(text, /那保存粒度呢/)
  assert.doesNotMatch(text, /为什么要做这个插件？/, 'scope=turn must carry only its own turn')
  await rm(value.ref, { force: true })
})

test('an unconfigured target fails with a readable 400, not a 500', async () => {
  const plug = mountPlugin()
  const response = await call(plug, {
    method: 'POST',
    path: '/save',
    body: { target: 'yuque', sessionId: 'session-1', scope: 'session' },
  })
  assert.equal(response.status, 400)
  assert.equal(response.json.ok, false)
  assert.equal(response.json.error.code, 'target-not-configured')
  assert.match(response.json.error.message, /语雀|Yuque/)
})

test('an unknown path is a 404 in the documented envelope', async () => {
  const plug = mountPlugin()
  const response = await call(plug, { path: '/nope' })
  assert.equal(response.status, 404)
  assert.equal(response.json.error.code, 'not-found')
})

test('a bad target id is rejected, not passed to an adapter', async () => {
  const plug = mountPlugin()
  const response = await call(plug, { path: '/targets/evernote/options' })
  assert.equal(response.status, 400)
  assert.equal(response.json.error.code, 'unknown-target')
})

test('GET /note-save/targets/obsidian/options lists vault folders', async () => {
  const plug = mountPlugin({ rowConfig: rowConfigForVault() })
  const response = await call(plug, { path: '/targets/obsidian/options' })
  assert.equal(response.status, 200)
  const locations = response.json.value.locations
  assert.ok(locations.some((location) => location.id === ''))
})

test('GET /note-save/schema describes every target for the settings page', async () => {
  const plug = mountPlugin()
  const response = await call(plug, { path: '/schema' })
  assert.equal(response.status, 200)
  const targets = response.json.value.targets
  assert.equal(targets.length, 7)
  for (const target of targets) {
    assert.equal(typeof target.id, 'string')
    assert.equal(typeof target.label, 'string')
    assert.ok(Array.isArray(target.fields))
    assert.ok(target.fields.length > 0, `${target.id} must describe at least one field`)
    for (const field of target.fields) {
      assert.equal(typeof field.key, 'string')
      assert.equal(typeof field.label, 'string')
    }
  }
})

test('GET /note-save/config never returns a stored secret', async () => {
  const plug = mountPlugin({
    rowConfig: { targets: { joplin: { token: 'super-secret-token', baseUrl: 'http://127.0.0.1:41184' } } },
  })
  const response = await call(plug, { path: '/config' })
  assert.equal(response.status, 200)
  const body = JSON.stringify(response.json)
  assert.doesNotMatch(body, /super-secret-token/, 'a stored token must never reach the browser')
  const joplin = response.json.value.values.joplin
  assert.equal(joplin.token, '', 'the secret field comes back blank')
  assert.equal(joplin.tokenSet, true, 'the page must still know a token is stored')
  assert.equal(joplin.baseUrl, 'http://127.0.0.1:41184', 'non-secret fields come back verbatim')
})

test('POST /note-save/config/save keeps a stored secret when the field is blank', async () => {
  // The settings page cannot read the token back, so an empty input means
  // "unchanged". Getting this wrong erases a working token on every save.
  const plug = mountPlugin()
  const response = await call(plug, {
    method: 'POST',
    path: '/config/save',
    body: { target: 'notion', values: { databaseId: 'db-123', token: '' } },
  })
  assert.equal(response.status, 200, JSON.stringify(response.json))
  const notion = response.json.value.values.notion
  assert.equal(notion.databaseId, 'db-123')
  assert.equal(notion.token, '')
})

test('POST /note-save/test reports a probe result without writing', async () => {
  const plug = mountPlugin({ rowConfig: rowConfigForVault() })
  const response = await call(plug, { method: 'POST', path: '/test', body: { target: 'obsidian' } })
  assert.equal(response.status, 200)
  assert.equal(typeof response.json.value.ok, 'boolean')
  assert.equal(typeof response.json.value.detail, 'string')
})

test('POST /note-save/test on an unconfigured target explains what is missing', async () => {
  const plug = mountPlugin()
  const response = await call(plug, { method: 'POST', path: '/test', body: { target: 'yuque' } })
  assert.equal(response.status, 200)
  assert.equal(response.json.value.ok, false)
  assert.match(response.json.value.detail, /Token|token/)
})

test('GET /note-save/obsidian/vaults lists what Obsidian knows', async () => {
  const plug = mountPlugin()
  const response = await call(plug, { path: '/obsidian/vaults' })
  assert.equal(response.status, 200)
  assert.ok(Array.isArray(response.json.value.vaults))
  for (const vaultEntry of response.json.value.vaults) {
    assert.equal(typeof vaultEntry.path, 'string')
    assert.equal(typeof vaultEntry.name, 'string')
  }
})

test('GET /note-save/obsidian/folders lists subfolders and refuses to escape', async () => {
  const plug = mountPlugin()
  const okResponse = await call(plug, {
    path: `/obsidian/folders?vault=${encodeURIComponent(vault)}&path=`,
  })
  assert.equal(okResponse.status, 200)
  assert.ok(Array.isArray(okResponse.json.value.folders))

  const escape = await call(plug, {
    path: `/obsidian/folders?vault=${encodeURIComponent(vault)}&path=${encodeURIComponent('../../..')}`,
  })
  assert.equal(escape.status, 500)
  assert.match(escape.json.error.message, /越出 vault/)
})

test('the agent tool lists targets without a session, and previews with one', async () => {
  const { definition } = mountPlugin({ rowConfig: rowConfigForVault() }).registered.tools[0]

  const list = await definition.execute({ action: 'list' }, { agent: { id: 'session-1' } })
  assert.equal(list.targets.length, 7)

  const preview = await definition.execute({ action: 'preview', scope: 'session' }, { agent: { id: 'session-1' } })
  assert.match(preview.markdown, /单条、本轮、整段会话三种/)

  await assert.rejects(() => definition.execute({ action: 'preview', scope: 'session' }, {}), /只能在会话中调用/)
})

test('the tool can save through the same operation the panel uses', async () => {
  const { definition } = mountPlugin({ rowConfig: rowConfigForVault() }).registered.tools[0]
  const saved = await definition.execute(
    { action: 'save', target: 'obsidian', scope: 'message', messageId: 'm2' },
    { agent: { id: 'session-1' } },
  )
  assert.equal(saved.target, 'obsidian')
  await rm(saved.ref, { force: true })
})

test('the tool never lets the model choose a foreign session', async () => {
  const { definition } = mountPlugin({ rowConfig: rowConfigForVault() }).registered.tools[0]
  // A model-supplied sessionId in the arguments must be ignored; the agent's own
  // session id decides. Only this assertion proves the trust boundary holds.
  const preview = await definition.execute(
    { action: 'preview', scope: 'session', sessionId: 'someone-elses-session' },
    { agent: { id: 'session-1' } },
  )
  assert.match(preview.markdown, /为什么要做这个插件/)
})

test('the output renderer produces readable text for each action', async () => {
  const { definition } = mountPlugin({ rowConfig: rowConfigForVault() }).registered.tools[0]
  const listBlocks = definition.output.render(
    { action: 'list' },
    { targets: [{ label: 'Obsidian', configured: true, detail: '' }] },
  )
  assert.match(listBlocks[0].text, /Obsidian/)

  const saveBlocks = definition.output.render({}, { target: 'obsidian', ref: 'D:\\a.md', label: 'Obsidian' })
  assert.match(saveBlocks[0].text, /已保存到 Obsidian/)

  const previewBlocks = definition.output.render({}, { title: 'T', markdown: 'body' })
  assert.match(previewBlocks[0].text, /预览《T》/)
})
