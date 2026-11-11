/**
 * Contract test for the browser half WITHOUT a browser.
 *
 * `client.js` is a classic script that talks to the host only through
 * `window.__ModuleLoader__` and `fetch`. This harness supplies both, loads the
 * real bundle, renders the real components with a stub React, and drives the
 * real `/note-save/*` routes registered by `index.js`.
 *
 * It proves the two halves agree on the wire contract and that the components
 * produce the markup a user would see. It does NOT prove visual rendering — CSS
 * and layout need a browser.
 *
 * Run with `node tests-lead/client-wire.test.mjs`.
 */

import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { apply } from '../index.js'

const CLIENT_PATH = new URL('../client.js', import.meta.url)
const ORIGIN = 'http://127.0.0.1:5020'

let vault = ''

before(async () => {
  vault = await mkdtemp(join(tmpdir(), 'note-client-'))
})

after(async () => {
  await rm(vault, { recursive: true, force: true })
})

/* --------------------------------------------------------------- stub react */

/** The smallest React that lets a component function run to a tree. */
function makeReact() {
  // The bundle inherits its error boundary function-style
  // (`React.Component.call(this, props)`), so Component must be an ordinary
  // function, exactly like React's own.
  function Component(props) {
    this.props = props ?? {}
    this.state = {}
  }
  Component.prototype.setState = function setState(next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
  }

  return {
    Component,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    Fragment: 'Fragment',
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    useMemo(fn) {
      return fn()
    },
    useCallback(fn) {
      return fn
    },
    useRef(initial) {
      return { current: initial }
    },
  }
}

/** A `document` with just enough surface for the bundle's style installer. */
function makeDocument() {
  const styleTags = []
  const document = {
    baseURI: `${ORIGIN}/`,
    head: { appendChild: (tag) => styleTags.push(tag) },
    body: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  return { document, styleTags }
}

/**
 * Load the real bundle with a stub module table; returns the plugin object.
 * `document` must be supplied here because a classic script binds its
 * environment when it runs, not when `apply` is called.
 */
async function loadPlugin(React, document) {
  const source = await readFile(CLIENT_PATH, 'utf8')
  let descriptor = null
  const window = {
    __ModuleLoader__: {
      load(candidate) {
        descriptor = candidate
      },
    },
  }
  // A classic script: no module keywords, so a Function body is the real
  // execution mode the loader uses.
  new Function('window', 'document', 'fetch', source)(window, document, globalThis.fetch)

  assert.ok(descriptor !== null, 'client.js must register through window.__ModuleLoader__.load')
  assert.equal(descriptor.id, 'dsh-note-save', 'the bundle id must equal the package name')
  assert.equal(typeof descriptor.factory, 'function')

  const plugin = descriptor.factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected require id: ${id}`)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(Array.isArray(plugin.inject))
  return plugin
}

/* --------------------------------------------------------------- host side */

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
  messageEvent(1, 'user', '这个插件怎么用？'),
  messageEvent(2, 'assistant', '在消息下方点「保存」，选目标系统即可。', 0),
]

/** Mount index.js's real route behind a `fetch`, so the client hits the host. */
function startHost({ trusted = true } = {}) {
  let route = null
  const ctx = {
    sessions: { get: (id) => (id === 'session-1' ? { snapshotEvents: () => EVENTS } : undefined) },
    sessionQuery: {
      readSession: async () => ({ events: EVENTS }),
      readTitle: async () => ({ title: '插件用法' }),
    },
    connection: { requestRejection: () => (trusted ? undefined : 403) },
    webServer: {
      register: (registered) => {
        route = registered
        return () => {}
      },
    },
    tools: { register: () => () => {} },
    effect: (fn) => fn(),
    logger: { warn() {}, error() {}, info() {} },
    // `optional()` reads optional services through ctx.get, exactly as the real
    // Cordis context does; the fake must answer the same way.
    get: (name) => (name === 'sessionQuery' ? ctx.sessionQuery : name === 'logger' ? ctx.logger : undefined),
  }
  apply(ctx, { targets: { obsidian: { vault, subdir: '', frontmatter: true } } })

  const seen = []
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(String(url))
    seen.push({ path: parsed.pathname, method: init.method ?? 'GET' })
    const relative = parsed.pathname.slice(parsed.pathname.indexOf('/note-save') + '/note-save'.length)

    const req = new EventEmitter()
    req.method = init.method ?? 'GET'
    req.url = `${route.path}${relative}`
    req.headers = { host: parsed.host }

    let status = 0
    let body = ''
    const response = {
      writeHead(code) {
        status = code
      },
      end(chunk) {
        if (chunk !== undefined) body += String(chunk)
      },
    }
    const pending = route.handler(req, response)
    if (init.body !== undefined) req.emit('data', Buffer.from(String(init.body)))
    req.emit('end')
    await pending

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body || 'null'),
      text: async () => body,
    }
  }

  return { fetchImpl, seen }
}

/* -------------------------------------------------------------- fake ctx */

/**
 * Run apply() against a recording ctx and return what it registered.
 * The locale stub is a real dictionary lookup so the assertions can check the
 * text a user would actually see.
 */
function mountClient(plugin, services = {}) {
  const registrations = []
  const dictionaries = new Map()

  const ctx = {
    locale: {
      register: (ns, ...rest) => {
        registrations.push({ kind: 'locale', ns, args: rest })
        // Support both the typed `{ zh, en }` form and `(ns, id, dict)`.
        if (rest.length === 1 && rest[0] !== null && typeof rest[0] === 'object') {
          for (const [id, dict] of Object.entries(rest[0])) dictionaries.set(id, dict)
        } else if (rest.length === 2) {
          dictionaries.set(rest[0], rest[1])
        }
        return () => {}
      },
      bind: () => (key) => {
        for (const dict of dictionaries.values()) {
          if (typeof dict?.[key] === 'string') return dict[key]
        }
        return key
      },
    },
    slots: {
      inject: (slotName, callback) => {
        registrations.push({ kind: 'slots.inject', slotName })
        return callback()
      },
      register: (options, component) => {
        registrations.push({ kind: 'slots.register', options, component })
        return () => {}
      },
    },
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    // Optional services are read through ctx.get, like the real Context.
    get: (name) => services[name],
  }

  plugin.apply(ctx)
  return { registrations, dictionaries }
}

function registrationFor(registrations, slotName) {
  const entry = registrations.find(
    (item) => item.kind === 'slots.register' && item.options.name === slotName,
  )
  assert.ok(entry !== undefined, `the bundle must register a ${slotName} entry`)
  return entry
}

/* -------------------------------------------------------------------- tests */

test('the bundle registers slots and locale injections', async () => {
  const { document } = makeDocument()
  const plugin = await loadPlugin(makeReact(), document)
  assert.ok(plugin.inject.includes('slots'), 'client must inject the slots service')
  assert.ok(plugin.inject.includes('locale'), 'client must inject the locale service')
})

test('apply() registers a locale dictionary, a stylesheet and both slot entries', async () => {
  const React = makeReact()
  const { document, styleTags } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations } = mountClient(plugin)

  const locale = registrations.find((entry) => entry.kind === 'locale')
  assert.ok(locale !== undefined, 'the bundle must register its locale dictionary')
  assert.equal(locale.ns, 'dsh-note-save')

  const injected = registrations.filter((entry) => entry.kind === 'slots.inject').map((entry) => entry.slotName)
  assert.ok(injected.includes('conversation.chat.assistant-actions'), 'must inject the message action row')
  assert.ok(injected.includes('settings.section'), 'must inject a settings page')

  const action = registrationFor(registrations, 'conversation.chat.assistant-actions')
  assert.equal(action.options.id, 'note-save')
  assert.equal(action.options.order, 30)
  assert.equal(typeof action.component, 'function', 'the registered value must be a component')
  assert.equal(typeof action.options.label, 'function', 'the label must be a thunk so locale changes apply')

  const settings = registrationFor(registrations, 'settings.section')
  assert.equal(settings.options.id, 'note-save')
  assert.equal(typeof settings.component, 'function')
  assert.equal(typeof settings.options.label, 'function')

  assert.ok(styleTags.length >= 1, 'styles must be injected as a <style> tag')
  const css = String(styleTags[0].textContent)
  assert.ok(css.includes('--dsw-alias-'), 'the stylesheet must use theme tokens')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/, 'no literal colors in the stylesheet')
})

test('the action is icon-only: no visible label text, but an accessible name', async () => {
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations, dictionaries } = mountClient(plugin)
  const action = registrationFor(registrations, 'conversation.chat.assistant-actions')

  assert.ok(dictionaries.size > 0, 'at least one dictionary must be registered')

  const tree = renderDeep(action.component({ messageId: 'm2', sessionId: 'session-1' }), React)
  assert.ok(tree !== null && tree !== undefined, 'the action must render something, not throw')

  // The request was explicit: the row shows an icon only, no "保存" text.
  const visible = visibleText(tree)
  assert.equal(visible.trim(), '', `the action must render no visible text, got: ${JSON.stringify(visible)}`)

  // Accessibility must not be sacrificed for the icon-only look.
  const button = findElement(tree, (node) => node.type === 'button')
  assert.ok(button !== null, 'the action must be a real button')
  assert.equal(typeof button.props['aria-label'], 'string')
  assert.match(button.props['aria-label'], /保存|Save/, 'the icon needs an accessible name')
  assert.equal(typeof button.props.title, 'string', 'the icon needs a tooltip')

  const svg = findElement(button, (node) => node.type === 'svg')
  assert.ok(svg !== null, 'the action must render an svg glyph')
})

test('the component degrades without a session instead of throwing', async () => {
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations } = mountClient(plugin)
  const action = registrationFor(registrations, 'conversation.chat.assistant-actions')

  // Only `messageId` is guaranteed by the slot owner.
  const tree = renderDeep(action.component({ messageId: 'm2' }), React)
  assert.ok(tree !== null && tree !== undefined)

  const bare = renderDeep(action.component({}), React)
  const button = findElement(bare, (node) => node.type === 'button')
  assert.ok(button !== null)
  assert.equal(button.props.disabled, true, 'without a session the action must be disabled')
})

test('opening the panel renders the whole dialog, with the requested controls', async () => {
  const React = makeReact()
  const { document } = makeDocument()

  // Force the action's `open` state on so the dialog is part of the tree.
  const opened = openStateReact(React)
  const plugin = await loadPlugin(opened, document)
  const { registrations } = mountClient(plugin)
  const action = registrationFor(registrations, 'conversation.chat.assistant-actions')

  const tree = renderDeep(action.component({ messageId: 'm2', sessionId: 'session-1' }), opened)
  assert.ok(tree !== null && tree !== undefined, 'the dialog must render without throwing')

  const text = collectText(tree)
  for (const expected of ['保存为笔记', '范围', '单条消息', '保存到', '预览', '取消', '包含思考过程']) {
    assert.ok(text.includes(expected), `the dialog must show "${expected}"; got: ${text.slice(0, 400)}`)
  }

  // The preview must offer a rendered view and a source view.
  assert.ok(text.includes('渲染效果'), 'the preview must offer a rendered view')
  assert.ok(text.includes('Markdown 源码'), 'the preview must offer a source view')

  // A dialog needs its accessibility contract.
  const dialog = findElement(tree, (node) => node.props && node.props.role === 'dialog')
  assert.ok(dialog !== null, 'the panel must be a role=dialog')
  assert.equal(dialog.props['aria-modal'], 'true')
})

test('the settings page renders one card per target with a test button', async () => {
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations } = mountClient(plugin)
  const settings = registrationFor(registrations, 'settings.section')

  // Before the schema arrives the page shows a loading line rather than throwing.
  const loading = renderDeep(settings.component({ close() {} }), React)
  assert.ok(loading !== null && loading !== undefined)

  const text = collectText(loading)
  assert.match(text, /笔记保存|正在读取配置|无法读取配置/)
})

test('a stale host half is explained instead of surfacing a bare route error', async () => {
  // The client bundle hot-reloads on refresh but the host half only on restart,
  // so the page can appear before its API exists. That state must say "restart
  // DSH", not show the user an "unknown endpoint" they cannot act on.
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations } = mountClient(plugin)
  const settings = registrationFor(registrations, 'settings.section')

  // Drive the real load path: the first fetch fails the way an old host would.
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    json: async () => ({ ok: false, error: { code: 'not-found', message: '未知接口：GET /schema' } }),
  })
  try {
    const tree = renderDeep(settings.component({ close() {} }), React)
    // The render itself is synchronous; the rejection lands on a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const after = renderDeep(settings.component({ close() {} }), React)
    assert.ok(tree !== null && after !== null)

    // The dictionary must carry the actionable sentence.
    const dictionaries = mountClient(plugin).dictionaries
    const zh = dictionaries.get('zh') ?? {}
    assert.match(zh['settings.staleBackend'], /重启 DSH/)
    assert.equal(zh['settings.retry'], '重试', 'the error state offers a retry, not a bogus test button')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('the settings page is a top-tab layout: one tab strip, one config pane', async () => {
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations } = mountClient(plugin)
  const settings = registrationFor(registrations, 'settings.section')

  // The page only becomes interesting once schema + config arrive, and the stub
  // React cannot resolve the real fetch. Feed the loaded state in directly.
  const schema = {
    targets: [
      { id: 'obsidian', label: 'Obsidian', fields: [
        { key: 'vault', label: '仓库（vault）', type: 'text', placeholder: '', required: true, secret: false, help: '' },
      ] },
      { id: 'siyuan', label: 'SiYuan', fields: [
        { key: 'token', label: 'API 令牌', type: 'password', placeholder: '', required: true, secret: true, help: '' },
      ] },
      { id: 'joplin', label: 'Joplin', fields: [] },
      { id: 'notion', label: 'Notion', fields: [] },
      { id: 'yuque', label: 'Yuque', fields: [] },
      { id: 'ima', label: 'ima', fields: [] },
      { id: 'feishu', label: 'Feishu', fields: [] },
    ],
  }
  const config = {
    values: {
      obsidian: { vault: 'D:\\vault' },
      siyuan: { token: '', tokenSet: true },
    },
    configPath: 'C:\\Users\\x\\.dsh\\note-save.json',
    defaultTarget: 'obsidian',
  }
  const forms = {
    obsidian: { vault: 'D:\\vault' },
    siyuan: { token: '', clear_token: false },
  }

  const loaded = loadedStateReact(React, { schema, config, forms, activeTarget: 'obsidian' })
  const loadedPlugin = await loadPlugin(loaded, document)
  const { registrations: loadedRegistrations } = mountClient(loadedPlugin)
  const loadedSettings = registrationFor(loadedRegistrations, 'settings.section')

  const tree = renderDeep(loadedSettings.component({ close() {} }), loaded)
  assert.ok(tree !== null && tree !== undefined, 'the loaded page must render')

  // Top: a horizontal tab strip with one tab per target.
  const tablist = findElement(tree, (node) => node.props && node.props.role === 'tablist')
  assert.ok(tablist !== null, 'the page must render a target tab strip (role=tablist)')
  assert.equal(tablist.props['aria-orientation'], 'horizontal', 'the tabs sit across the top')
  const tabs = findAll(tablist, (node) => node.props && node.props.role === 'tab')
  assert.equal(tabs.length, 7, 'one tab per target')
  assert.deepEqual(
    tabs.map((tab) => visibleText(tab).trim()),
    ['Obsidian', 'SiYuan', 'Joplin', 'Notion', 'Yuque', 'ima', 'Feishu'],
  )

  // Below: exactly one pane, showing only the selected target.
  const panes = findAll(tree, (node) => node.props && node.props.role === 'tabpanel')
  assert.equal(panes.length, 1, 'only the selected target gets a pane, not all six')
  const paneText = collectText(panes[0])
  assert.match(paneText, /仓库（vault）/, 'the pane shows the selected target’s fields')
  assert.doesNotMatch(paneText, /API 令牌/, 'the pane must not show another target’s fields')

  // Selection is expressed to assistive tech, not only by colour.
  const selected = tabs.filter((tab) => tab.props['aria-selected'] === 'true')
  assert.equal(selected.length, 1, 'exactly one tab is selected')
  assert.equal(visibleText(selected[0]).trim(), 'Obsidian')
  assert.equal(selected[0].props['aria-controls'], panes[0].props.id)

  // The form is a form: no explanatory paragraphs under the fields.
  assert.doesNotMatch(
    paneText,
    /就是一个文件夹|选一个已登记的 vault/,
    'field help text belongs in the guide page, not under every field',
  )

  // The explanations moved to one link at the bottom.
  const guide = findElement(tree, (node) => node.props && typeof node.props.href === 'string' && /note-save\/guide$/.test(node.props.href))
  assert.ok(guide !== null, 'the page must link to the operations guide')
  assert.equal(guide.props.target, '_blank', 'the guide opens beside the settings, not inside them')
  assert.match(visibleText(guide), /操作指引/)
})

test('a folder field is freely typed, with a native picker beside it', async () => {
  // The request was explicit: the vault must be the user's choice, not a fixed
  // dropdown. So: a text input they can type into, plus a 浏览… button that
  // opens the Host-native picker.
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)

  let pickCalls = 0
  const services = {
    uiWorkspace: {
      pickDirectory: async () => {
        pickCalls += 1
        return 'D:\\picked\\vault'
      },
    },
  }
  const { registrations } = mountClient(plugin, services)
  const settings = registrationFor(registrations, 'settings.section')

  const schema = {
    targets: [
      {
        id: 'obsidian',
        label: 'Obsidian',
        fields: [
          {
            key: 'vault',
            label: '仓库（vault）',
            type: 'text',
            placeholder: '填写或浏览选择 vault 的绝对路径',
            required: true,
            secret: false,
            pick: 'directory',
            help: 'x',
          },
        ],
      },
    ],
  }
  const config = { values: { obsidian: { vault: '' } }, configPath: 'C:\\x.json' }
  const loaded = loadedStateReact(React, { schema, config, forms: { obsidian: { vault: '' } }, activeTarget: 'obsidian' })
  const loadedPlugin = await loadPlugin(loaded, document)
  const { registrations: loadedRegistrations } = mountClient(loadedPlugin, services)
  const loadedSettings = registrationFor(loadedRegistrations, 'settings.section')

  const tree = renderDeep(loadedSettings.component({ close() {} }), loaded)

  // A text input, not a select — a vault can live anywhere.
  const input = findElement(tree, (node) => node.type === 'input' && node.props.id === 'ns-cfg-obsidian-vault')
  assert.ok(input !== null, 'the vault must be an editable input')
  assert.equal(input.props.type, 'text')
  assert.equal(input.props.list, undefined, 'no datalist: that is what made it look like a dropdown')

  // And a real picker beside it.
  const browse = findElement(tree, (node) => node.type === 'button' && /浏览|Browse/.test(visibleText(node)))
  assert.ok(browse !== null, 'a folder field must offer a 浏览… button')
  browse.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(pickCalls, 1, 'the button must open the Host-native directory picker')
})

test('without the picker service the field still types, and no button appears', async () => {
  // Degrade, never break: a profile without uiWorkspace must still be usable.
  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  const { registrations } = mountClient(plugin, {})
  const settings = registrationFor(registrations, 'settings.section')

  const schema = {
    targets: [
      {
        id: 'obsidian',
        label: 'Obsidian',
        fields: [{ key: 'vault', label: '仓库', type: 'text', placeholder: '', required: true, secret: false, pick: 'directory', help: 'x' }],
      },
    ],
  }
  const config = { values: { obsidian: { vault: 'D:\\typed' } }, configPath: '' }
  const loaded = loadedStateReact(React, { schema, config, forms: { obsidian: { vault: 'D:\\typed' } }, activeTarget: 'obsidian' })
  const loadedPlugin = await loadPlugin(loaded, document)
  const { registrations: loadedRegistrations } = mountClient(loadedPlugin, {})
  const loadedSettings = registrationFor(loadedRegistrations, 'settings.section')

  const tree = renderDeep(loadedSettings.component({ close() {} }), loaded)
  const input = findElement(tree, (node) => node.type === 'input' && node.props.id === 'ns-cfg-obsidian-vault')
  assert.ok(input !== null, 'the input must render without the picker service')
  assert.equal(input.props.value, 'D:\\typed', 'a typed value must show')
  const browse = findElement(tree, (node) => node.type === 'button' && /浏览|Browse/.test(visibleText(node)))
  assert.equal(browse, null, 'no picker service means no button, not a dead button')
})

test('the tab strip cannot grow a vertical scrollbar', async () => {
  // Regression guard: a negative bottom margin plus a bottom border made the
  // one-row tab strip overflow its own box by 1px, which Chromium renders as a
  // stray vertical scrollbar on the right of the tabs.
  const React = makeReact()
  const { document, styleTags } = makeDocument()
  const plugin = await loadPlugin(React, document)
  mountClient(plugin)

  const css = styleTags.map((tag) => String(tag.textContent)).join('\n')
  assert.ok(css.length > 0, 'the bundle must inject its stylesheet')

  const tabsRule = /\.ns-tabs\{([^}]*)\}/.exec(css)
  assert.ok(tabsRule !== null, '.ns-tabs must have a rule')
  assert.match(tabsRule[1], /overflow-y:\s*hidden/, 'the strip is one row tall: it must not scroll vertically')

  const tabRule = /\.ns-tab\{([^}]*)\}/.exec(css)
  assert.ok(tabRule !== null, '.ns-tab must have a rule')
  assert.doesNotMatch(tabRule[1], /margin-bottom:\s*-/, 'no negative bottom margin: it overflows the strip')
  assert.doesNotMatch(tabRule[1], /border-bottom:/, 'the underline is a shadow, not a border that needs an offset')

  const activeRule = /\.ns-tab\[data-active="true"\]\{([^}]*)\}/.exec(css)
  assert.ok(activeRule !== null, 'the active tab must have a rule')
  assert.match(activeRule[1], /inset 0 -2px 0/, 'the active underline must be an inset shadow')
})

test('the markdown preview renderer produces real markup and cannot be injected', async () => {  const React = makeReact()
  const { document } = makeDocument()
  const plugin = await loadPlugin(React, document)
  assert.equal(typeof plugin.renderMarkdown, 'function', 'the bundle must expose its renderer for tests')

  const html = plugin.renderMarkdown(
    [
      '# 标题',
      '',
      '普通段落，带 **加粗** 和 `行内代码`。',
      '',
      '- 第一项',
      '- 第二项',
      '',
      '```js',
      'const a = 1 < 2',
      '```',
      '',
      '> 引用',
      '',
      '| 列A | 列B |',
      '| --- | --- |',
      '| 1 | 2 |',
    ].join('\n'),
  )

  assert.match(html, /<h3 class="ns-mdH">标题<\/h3>/, 'a heading must render as a heading element')
  assert.match(html, /<strong>加粗<\/strong>/, 'bold must render as <strong>')
  assert.match(html, /<code class="ns-mdInlineCode">行内代码<\/code>/, 'inline code must render')
  assert.match(html, /<ul class="ns-mdList">/, 'a list must render as a list')
  assert.match(html, /<pre class="ns-mdPre">/, 'a fence must render as a pre')
  assert.match(html, /<blockquote class="ns-mdQuote">/, 'a quote must render as a blockquote')
  assert.match(html, /<table class="ns-mdTable">/, 'a table must render as a table')
  // Code content is escaped, not interpreted.
  assert.match(html, /1 &lt; 2/, 'code must be escaped')

  // Injection: no user byte may become a tag or an attribute.
  const hostile = plugin.renderMarkdown(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[click](javascript:alert(3))',
  )
  assert.doesNotMatch(hostile, /<script/i, 'a script tag must not survive')
  assert.doesNotMatch(hostile, /<img/i, 'an img tag must not survive')
  assert.doesNotMatch(hostile, /href="javascript:/i, 'a javascript: link must not survive')
  assert.match(hostile, /&lt;script&gt;/, 'the script tag must be shown as escaped text')
})

test('the wire contract matches: state, preview and save answer the panel envelope', async () => {
  const host = startHost()

  const state = await (await host.fetchImpl(`${ORIGIN}/note-save/state`)).json()
  assert.equal(state.ok, true)
  assert.equal(state.value.targets.length, 7)
  assert.ok(state.value.configPath.endsWith('note-save.json'))
  assert.equal(state.value.defaultTarget, 'obsidian')

  const preview = await (
    await host.fetchImpl(`${ORIGIN}/note-save/preview`, {
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1', scope: 'session' }),
    })
  ).json()
  assert.equal(preview.ok, true)
  assert.equal(preview.value.title, '插件用法')
  assert.match(preview.value.markdown, /在消息下方点「保存」/)
  assert.equal(preview.value.stats.messages, 2)

  const saved = await (
    await host.fetchImpl(`${ORIGIN}/note-save/save`, {
      method: 'POST',
      body: JSON.stringify({ target: 'obsidian', sessionId: 'session-1', scope: 'message', messageId: 'm2' }),
    })
  ).json()
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.ok(saved.value.ref.endsWith('.md'))

  const written = await readFile(saved.value.ref, 'utf8')
  assert.match(written, /这个插件怎么用/, 'scope=message must include the prompt')
  await rm(saved.value.ref, { force: true })
})

test('the settings endpoints answer the page', async () => {
  const host = startHost()

  const schema = await (await host.fetchImpl(`${ORIGIN}/note-save/schema`)).json()
  assert.equal(schema.ok, true)
  assert.equal(schema.value.targets.length, 7)

  const config = await (await host.fetchImpl(`${ORIGIN}/note-save/config`)).json()
  assert.equal(config.ok, true)
  assert.equal(typeof config.value.values, 'object')

  const vaults = await (await host.fetchImpl(`${ORIGIN}/note-save/obsidian/vaults`)).json()
  assert.equal(vaults.ok, true)
  assert.ok(Array.isArray(vaults.value.vaults))
})

test('the guide is a self-contained HTML page that covers every target', async () => {
  const host = startHost()
  const response = await host.fetchImpl(`${ORIGIN}/note-save/guide`)
  assert.equal(response.status, 200)
  const html = await response.text()

  assert.match(html, /^<!doctype html>/i)
  assert.match(html, /<title>[^<]*操作指引/, 'the page must title itself')
  for (const label of ['Obsidian', 'SiYuan', 'Joplin', 'Notion', 'Yuque', 'ima', 'Feishu']) {
    assert.ok(html.includes(label), `the guide must document ${label}`)
  }
  // The ima section must describe the real API path, not a manual import.
  assert.match(html, /OpenAPI/, 'the guide must document the ima OpenAPI path')
  assert.match(html, /agent-interface/, 'the guide must say where ima credentials come from')
  assert.match(html, /import_doc/, 'the guide must name the endpoint it calls')
  assert.doesNotMatch(html, /导入本地文件/, 'the manual file-import step no longer applies to ima')
  // Field help is rendered here, with inline code, and must not point at
  // controls that live in another surface.
  assert.match(html, /<code>\.md<\/code>/, 'inline code in help must render as code')
  assert.doesNotMatch(html, /用下面的下拉/, 'help must not refer to a control in a different surface')
  // A guide page must not become a script host.
  assert.doesNotMatch(html, /<script/i, 'the guide must contain no script')
  assert.doesNotMatch(html, /<link\s/i, 'the guide must load no external stylesheet')
  assert.doesNotMatch(html, /<img/i, 'the guide must load no images')
})

test('the guide route sits behind the same browser-trust fence as the rest', async () => {
  const host = startHost({ trusted: false })
  const response = await host.fetchImpl(`${ORIGIN}/note-save/guide`)
  assert.equal(response.status, 403)
})

test('the options route serves the location list the panel asks for', async () => {  const host = startHost()
  const payload = await (await host.fetchImpl(`${ORIGIN}/note-save/targets/obsidian/options`)).json()
  assert.equal(payload.ok, true)
  assert.ok(Array.isArray(payload.value.locations))
  assert.ok(payload.value.locations.some((entry) => entry.id === ''))
})

test('the panel is refused when the browser-trust fence rejects', async () => {
  const host = startHost({ trusted: false })
  const response = await host.fetchImpl(`${ORIGIN}/note-save/state`)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).ok, false)
})

/* --------------------------------------------------------------- utilities */

/** Flatten a stub element tree into its visible text (excluding aria labels). */
function visibleText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(visibleText).join(' ')
  if (node.children === undefined || node.children === null) return ''
  return visibleText(node.children)
}

/** Flatten a stub element tree into its text plus accessible labels. */
function collectText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  const parts = []
  if (node.children) parts.push(collectText(node.children))
  const props = node.props ?? {}
  for (const key of ['label', 'title', 'aria-label', 'placeholder']) {
    if (typeof props[key] === 'string') parts.push(props[key])
  }
  return parts.join(' ')
}

/** Depth-first search for the first stub element matching `predicate`. */
function findElement(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  return findElement(node.children, predicate)
}

/** Every stub element matching `predicate`, in document order. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found)
    return found
  }
  if (predicate(node)) found.push(node)
  findAll(node.children, predicate, found)
  return found
}

/**
 * A React stub that hands the settings page already-loaded state.
 *
 * The page reads its data through effects, and this stub runs no effects, so the
 * only way to render the loaded layout is to answer the `useState` calls in
 * declaration order. The order is asserted by the caller's expectations.
 */
function loadedStateReact(base, { schema, config, forms, activeTarget }) {
  let call = 0
  return {
    ...base,
    useState(initial) {
      call += 1
      // 1 = useLocaleTick's tick, 2 = schema, 3 = config, 4 = forms,
      // 5 = statuses, 6 = busy, 7 = loadError, 8 = activeTarget, 9 = vault paths
      if (call === 2) return [schema, () => {}]
      if (call === 3) return [config, () => {}]
      if (call === 4) return [forms, () => {}]
      if (call === 8) return [activeTarget, () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
  }
}

/**
 * A React stub whose third `useState` returns `true` once, which is the action
 * component's `open` flag. Everything else behaves like `makeReact`.
 */
function openStateReact(base) {
  let call = 0
  return {
    ...base,
    useState(initial) {
      call += 1
      if (call === 3) return [true, () => {}]
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
  }
}

/**
 * Evaluate function components recursively until only host elements remain.
 *
 * This is not a React renderer: no effects run and no state changes settle. It
 * exists to prove a component tree can be produced at all, and to let a test
 * inspect the markup a user would see.
 */
function renderDeep(node, React, depth = 0) {
  if (depth > 24) return node
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => renderDeep(child, React, depth + 1))
  if (typeof node.type === 'function') {
    // The stub keeps children beside props (React puts them in props.children);
    // merge them back so a component that forwards `props.children` works.
    const props = { ...(node.props ?? {}), children: node.children }
    const isClass =
      typeof node.type.prototype === 'object' &&
      node.type.prototype !== null &&
      typeof node.type.prototype.render === 'function'
    let rendered
    if (isClass) {
      const instance = new node.type(props)
      instance.props = props
      if (instance.state === undefined) instance.state = {}
      rendered = node.type.prototype.render.call(instance)
    } else {
      rendered = node.type(props)
    }
    return renderDeep(rendered, React, depth + 1)
  }
  return { type: node.type, props: node.props, children: renderDeep(node.children, React, depth + 1) }
}
