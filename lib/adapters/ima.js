/**
 * ima adapter — the real OpenAPI, not a file drop.
 *
 * Verified against Tencent's own code (TencentCloud/Octop,
 * `infra/connectors/gateway/adapters/tencent_ima.py`, fetched 2026-11):
 *
 *   base    https://ima.qq.com/
 *   auth    headers `ima-openapi-clientid` + `ima-openapi-apikey`
 *   create  POST openapi/note/v1/import_doc   { content_format: 1, content, folder_id? }
 *   append  POST openapi/note/v1/append_doc   { note_id, content_format: 1, content }
 *   probe   POST openapi/wiki/v1/search_knowledge_base { query: '', cursor: '', limit: 1 }
 *   notes   POST openapi/note/v1/list_notebook { cursor: '0', limit }
 *
 * The response envelope is `{ code, msg, data }` with `code === 0` meaning ok.
 * Credentials are issued at https://ima.qq.com/agent-interface.
 *
 * An earlier version of this adapter wrote a `.md` into a local folder for
 * manual import, because no API was known. That was wrong: ima has an API and
 * is not a folder. The file-drop path is gone.
 */

const TIMEOUT_MS = 60_000
const DEFAULT_BASE_URL = 'https://ima.qq.com'
const MAX_LIMIT = 20

function cfgOf(config) {
  const target = config?.targets?.ima
  return target !== null && typeof target === 'object' ? target : {}
}

function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function resolveBaseUrl(raw) {
  const value = str(raw) || DEFAULT_BASE_URL
  return value.replace(/\/+$/, '')
}

function signalFor(opts) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const external = opts?.signal
  if (!external) return timeout
  try {
    return AbortSignal.any([timeout, external])
  } catch {
    return external
  }
}

function fetchOf(env) {
  if (!env || typeof env.fetch !== 'function') {
    throw new Error('ima 适配器缺少注入的 env.fetch，无法发起请求。')
  }
  return env.fetch
}

function snippet(text, max = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** The first array found under one of `keys`, else `data` itself if it is one. */
function pickList(data, keys) {
  if (Array.isArray(data)) return data
  if (data === null || typeof data !== 'object') return []
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key]
  }
  return []
}

function headers(cfg) {
  const clientId = str(cfg.clientId)
  const apiKey = str(cfg.apiKey)
  if (clientId === '' || apiKey === '') {
    throw new Error('ima 未配置：需要 ima 的 Client ID 与 API Key（在 https://ima.qq.com/agent-interface 获取）。')
  }
  return {
    'ima-openapi-clientid': clientId,
    'ima-openapi-apikey': apiKey,
    'content-type': 'application/json',
  }
}

async function readBody(res) {
  let text = ''
  try {
    text = await res.text()
  } catch {
    text = ''
  }
  if (text === '') return { text: '', json: undefined }
  try {
    return { text, json: JSON.parse(text) }
  } catch {
    return { text, json: undefined }
  }
}

function describeStatus(status) {
  if (status === 401 || status === 403) {
    return 'ima 拒绝了请求：Client ID 或 API Key 无效 / 无权限（HTTP ' + status + '）。请在 https://ima.qq.com/agent-interface 重新确认凭据。'
  }
  if (status === 429) return 'ima 触发速率限制（HTTP 429），请稍后再试。'
  if (status >= 500) return `ima 服务端出错（HTTP ${status}），请稍后重试。`
  return `ima 请求失败（HTTP ${status}）。`
}

/**
 * One OpenAPI call. Returns the parsed `data` field.
 *
 * ima reports business failures inside a 200 response, so `code !== 0` is a
 * failure even when the HTTP status is fine.
 */
async function call(cfg, path, body, env, opts) {
  const base = resolveBaseUrl(cfg.baseUrl)
  const fetchFn = fetchOf(env)
  let res
  try {
    res = await fetchFn(`${base}/${path.replace(/^\/+/, '')}`, {
      method: 'POST',
      headers: headers(cfg),
      body: JSON.stringify(body ?? {}),
      signal: signalFor(opts),
    })
  } catch (error) {
    throw new Error(`无法连接 ima（${base}）：${snippet(error?.message ?? error) || '网络错误'}`)
  }
  const { text, json } = await readBody(res)
  if (!res.ok) {
    const upstream = snippet(text)
    throw new Error(`${describeStatus(res.status)}${upstream === '' ? '' : ` 上游返回：${upstream}`}`)
  }
  if (json === undefined || typeof json !== 'object') {
    throw new Error(`ima 返回了无法解析的响应（HTTP ${res.status}）：${snippet(text) || '空响应'}`)
  }
  const code = json.code
  if (code !== 0 && code !== '0' && code !== undefined && code !== null) {
    throw new Error(`ima 返回错误：${json.msg ?? json.message ?? '未给出原因'}（code=${code}）`)
  }
  return json.data ?? json
}

export default {
  id: 'ima',
  label: 'ima',

  fields: [
    {
      key: 'clientId',
      label: 'Client ID',
      type: 'text',
      placeholder: 'ima OpenAPI 的 client id',
      required: true,
      secret: false,
      help: '在 ima 的开放接口页面获取：https://ima.qq.com/agent-interface',
    },
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      placeholder: 'ima OpenAPI 的 api key',
      required: true,
      secret: true,
      help: '与 Client ID 配套的密钥，同一页面获取。',
    },
    {
      key: 'notebook',
      label: '笔记本 ID',
      type: 'text',
      placeholder: '留空则存到默认位置',
      required: false,
      secret: false,
      // The list comes from this target's options(), so the user picks a
      // notebook by name instead of hunting for an id.
      pick: 'location',
      help: '把笔记放进哪个笔记本（folder_id）。点旁边的下拉直接选，不用记 ID。',
    },
  ],

  async status(config) {
    const cfg = cfgOf(config)
    if (str(cfg.clientId) === '' || str(cfg.apiKey) === '') {
      return {
        configured: false,
        detail: '未配置 ima 的 Client ID / API Key（在 https://ima.qq.com/agent-interface 获取）',
      }
    }
    return { configured: true, detail: resolveBaseUrl(cfg.baseUrl) }
  },

  /** Notebooks as save locations. A failure here must not block saving. */
  async options(config, env) {
    const cfg = cfgOf(config)
    if (str(cfg.clientId) === '' || str(cfg.apiKey) === '') {
      return { locations: [], note: '未配置 Client ID / API Key，笔记会存到 ima 的默认位置。' }
    }
    try {
      const data = await call(cfg, 'openapi/note/v1/list_notebook', { cursor: '0', limit: MAX_LIMIT }, env)
      // Verified live against the real API: `data.note_folder_infos` is the
      // container, each entry carrying `folder_id` + `name`. The other keys are
      // kept as tolerant fallbacks in case the payload is ever reshaped.
      const list = pickList(data, ['note_folder_infos', 'notebooks', 'notebook_list', 'list', 'items'])
      const locations = []
      for (const item of list) {
        const id = str(item?.folder_id ?? item?.id ?? item?.notebook_id ?? item?.book_id)
        if (id === '') continue
        const name = str(item?.name ?? item?.title ?? item?.book_name) || id
        const count = str(item?.note_number)
        locations.push({ id, label: count === '' ? name : `${name}（${count} 条笔记）` })
      }
      return locations.length === 0
        ? { locations, note: 'ima 里还没有笔记本，笔记会存到默认位置。' }
        : { locations }
    } catch (error) {
      return { locations: [], note: `读取笔记本失败：${error?.message ?? String(error)}` }
    }
  },

  /** Read-only credential probe: a one-row knowledge-base search. */
  async test(config, env) {
    const cfg = cfgOf(config)
    if (str(cfg.clientId) === '' || str(cfg.apiKey) === '') {
      return { ok: false, detail: '未配置 ima 的 Client ID / API Key（在 https://ima.qq.com/agent-interface 获取）' }
    }
    try {
      await call(cfg, 'openapi/wiki/v1/search_knowledge_base', { query: '', cursor: '', limit: 1 }, env)
      return { ok: true, detail: '凭据有效：ima OpenAPI 可访问。' }
    } catch (error) {
      return { ok: false, detail: error?.message ?? String(error) }
    }
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config)
    const markdown = String(note?.markdown ?? '')
    if (markdown.trim() === '') throw new Error('没有可保存的内容（markdown 为空）。')
    const title = str(note?.title)

    // `import_doc` takes a body, not a title: the note's title comes from the
    // content, so the title is prepended as an H1 when it is not already there.
    const body = markdown.trimStart().startsWith('# ')
      ? markdown
      : `# ${title === '' ? '未命名笔记' : title}\n\n${markdown}`

    const payload = { content_format: 1, content: body }
    const folderId = str(opts?.location) || str(cfg.notebook)
    if (folderId !== '') payload.folder_id = folderId

    const data = await call(cfg, 'openapi/note/v1/import_doc', payload, env, opts)
    const noteId = str(data?.note_id ?? data?.id ?? data?.doc_id)
    const url = noteId === '' ? null : `https://ima.qq.com/note/${encodeURIComponent(noteId)}`
    return {
      ref: noteId === '' ? 'ima 笔记' : noteId,
      url,
      created: true,
    }
  },
}
