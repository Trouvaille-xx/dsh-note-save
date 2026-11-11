/**
 * Feishu (Lark) adapter — 云文档 docx, through the official OpenAPI.
 *
 * Paths and body fields are taken from larksuite/oapi-sdk-python's generated
 * models (fetched 2026-11), not guessed:
 *
 *   token   POST /open-apis/auth/v3/tenant_access_token/internal { app_id, app_secret }
 *   upload  POST /open-apis/drive/v1/medias/upload_all
 *           multipart: file_name, parent_type=ccm_import_open, parent_node, size, file
 *   create  POST /open-apis/drive/v1/import_tasks
 *           { file_extension:'md', file_token, type:'docx', file_name,
 *             point:{ mount_type:1, mount_key:<folder token> } }
 *   poll    GET  /open-apis/drive/v1/import_tasks/:ticket
 *   probe   GET  /open-apis/drive/v1/files?folder_token=…      (read-only)
 *
 * The envelope is `{ code, msg, data }` with `code === 0` meaning ok. Probed
 * live without credentials: the two GET routes answer 99991663 (invalid access
 * token), which is exactly what `test()` and `options()` build on.
 *
 * Identity: v1 uses the app's own `tenant_access_token`. The imported document
 * belongs to the app, so **the app must be a collaborator of the target
 * folder** (or the folder was created by the app). A user-identity (OAuth)
 * variant that writes into the user's own space is a separate change.
 *
 * Zero npm dependencies; all HTTP goes through the injected `env.fetch`.
 */

import { safeFileName } from '../render.js'

const TIMEOUT_MS = 60_000
const DEFAULT_BASE_URL = 'https://open.feishu.cn'
const IMPORT_POLL_MS = 1_000
const IMPORT_POLL_TRIES = 45
const TOKEN_SKEW_MS = 60_000
const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024
const MAX_LOCATIONS = 50

/** tenant tokens live ~2h; cache them per credential pair instead of per call. */
const TOKEN_CACHE = new Map()

function cfgOf(config) {
  const target = config?.targets?.feishu
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
    throw new Error('飞书适配器缺少注入的 env.fetch，无法发起请求。')
  }
  return env.fetch
}

function snippet(text, max = 240) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Which required settings are still empty. */
function missingKeys(cfg) {
  const missing = []
  if (str(cfg.appId) === '') missing.push('App ID')
  if (str(cfg.appSecret) === '') missing.push('App Secret')
  if (str(cfg.folderToken) === '') missing.push('目标文件夹 token')
  return missing
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
    return '飞书拒绝了请求：App ID / App Secret 无效，或应用没有被授权访问这个文件夹（HTTP ' + status + '）。'
  }
  if (status === 429) return '飞书触发速率限制（HTTP 429），请稍后再试。'
  if (status >= 500) return `飞书服务端出错（HTTP ${status}），请稍后重试。`
  return `飞书请求失败（HTTP ${status}）。`
}

/**
 * One call against open.feishu.cn. Returns the `data` field of the envelope.
 *
 * Feishu reports business failures inside a 200 response, so `code !== 0` is a
 * failure even when the HTTP status is fine.
 */
async function request(cfg, env, pathname, { method = 'GET', headers = {}, body, opts } = {}) {
  const base = resolveBaseUrl(cfg.baseUrl)
  const fetchFn = fetchOf(env)
  let res
  try {
    res = await fetchFn(`${base}${pathname}`, { method, headers, body, signal: signalFor(opts) })
  } catch (error) {
    throw new Error(`无法连接飞书开放平台（${base}）：${snippet(error?.message ?? error) || '网络错误'}`)
  }
  const { text, json } = await readBody(res)
  if (!res.ok) {
    const upstream = snippet(text)
    throw new Error(`${describeStatus(res.status)}${upstream === '' ? '' : ` 上游返回：${upstream}`}`)
  }
  if (json === undefined || typeof json !== 'object') {
    throw new Error(`飞书返回了无法解析的响应（HTTP ${res.status}）：${snippet(text) || '空响应'}`)
  }
  const code = json.code
  if (code !== 0 && code !== '0' && code !== undefined && code !== null) {
    throw new Error(`飞书返回错误：${json.msg ?? json.message ?? '未给出原因'}（code=${code}）`)
  }
  return json.data ?? json
}

/** tenant_access_token for this App ID / App Secret pair, cached until near expiry. */
async function accessToken(cfg, env, opts) {
  const appId = str(cfg.appId)
  const appSecret = str(cfg.appSecret)
  if (appId === '' || appSecret === '') {
    throw new Error('飞书未配置：需要 App ID 与 App Secret（飞书开放平台 → 开发者后台 → 自建应用）。')
  }
  const cacheKey = `${appId}\u0000${appSecret}`
  const cached = TOKEN_CACHE.get(cacheKey)
  const now = Date.now()
  if (cached !== undefined && cached.expiresAt > now) return cached.token

  const data = await request(cfg, env, '/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    opts,
  })
  const token = str(data?.tenant_access_token)
  if (token === '') {
    throw new Error('飞书没有返回 tenant_access_token：请确认 App ID / App Secret 正确，且应用已启用。')
  }
  const expire = Number(data?.expire)
  const ttl = Number.isFinite(expire) && expire > 0 ? expire * 1000 : 7_200_000
  TOKEN_CACHE.set(cacheKey, { token, expiresAt: now + Math.max(ttl - TOKEN_SKEW_MS, 60_000) })
  return token
}

function jsonHeaders(token) {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }
}

/** Upload the rendered Markdown as a temporary import source; returns file_token. */
async function uploadMarkdown(cfg, env, { fileName, markdown, folderToken, opts }) {
  const token = await accessToken(cfg, env, opts)
  const size = new TextEncoder().encode(markdown).length
  if (size > MAX_MARKDOWN_BYTES) {
    throw new Error(`正文 ${Math.round(size / 1024)} KB 超过飞书导入上限（${MAX_MARKDOWN_BYTES / 1024 / 1024} MiB），已拒绝发送。`)
  }
  const form = new FormData()
  form.append('file_name', fileName)
  form.append('parent_type', 'ccm_import_open')
  form.append('parent_node', folderToken)
  form.append('size', String(size))
  form.append('file', new Blob([markdown], { type: 'text/markdown' }), fileName)

  // No content-type header here on purpose: FormData must set its own boundary.
  const data = await request(cfg, env, '/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
    opts,
  })
  const fileToken = str(data?.file_token)
  if (fileToken === '') throw new Error('飞书上传没有返回 file_token，无法继续导入。')
  return fileToken
}

/** Ask Feishu to turn the uploaded Markdown into a docx; returns the ticket. */
async function createImportTask(cfg, env, { fileName, fileToken, folderToken, opts }) {
  const token = await accessToken(cfg, env, opts)
  const data = await request(cfg, env, '/open-apis/drive/v1/import_tasks', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify({
      file_extension: 'md',
      file_token: fileToken,
      type: 'docx',
      file_name: fileName,
      point: { mount_type: 1, mount_key: folderToken },
    }),
    opts,
  })
  const ticket = str(data?.ticket)
  if (ticket === '') throw new Error('飞书创建导入任务后没有返回 ticket。')
  return ticket
}

/** Poll the import task until it succeeds, fails or times out. */
async function waitForImport(cfg, env, ticket, opts) {
  const token = await accessToken(cfg, env, opts)
  for (let attempt = 0; attempt < IMPORT_POLL_TRIES; attempt += 1) {
    const data = await request(
      cfg,
      env,
      `/open-apis/drive/v1/import_tasks/${encodeURIComponent(ticket)}`,
      { method: 'GET', headers: { authorization: `Bearer ${token}` }, opts },
    )
    const result = data?.result ?? data ?? {}
    const error = str(result.job_error_msg)
    if (error !== '') throw new Error(`飞书导入失败：${error}`)
    const docToken = str(result.token)
    const url = str(result.url)
    // `job_status === 0` means done; a returned token+url means the same thing,
    // so accept either rather than depending on one numeric convention.
    if (Number(result.job_status) === 0 || (docToken !== '' && url !== '')) {
      return { token: docToken, url }
    }
    await new Promise((resolve) => setTimeout(resolve, IMPORT_POLL_MS))
  }
  throw new Error(`飞书导入超时（${IMPORT_POLL_TRIES} 秒内未完成），文档可能稍后才出现在目标文件夹。`)
}

/** Sub-folders of the configured folder, as save locations. */
async function listFolders(cfg, env, opts) {
  const token = await accessToken(cfg, env, opts)
  const data = await request(
    cfg,
    env,
    `/open-apis/drive/v1/files?page_size=${MAX_LOCATIONS}&folder_token=${encodeURIComponent(str(cfg.folderToken))}`,
    { method: 'GET', headers: { authorization: `Bearer ${token}` }, opts },
  )
  const files = Array.isArray(data?.files) ? data.files : Array.isArray(data) ? data : []
  const locations = []
  for (const file of files) {
    if (str(file?.type) !== 'folder') continue
    const id = str(file?.token)
    if (id === '') continue
    const label = str(file?.name) || id
    locations.push({ id, label: `${label}／` })
  }
  return locations
}

export default {
  id: 'feishu',
  label: 'Feishu',

  fields: [
    {
      key: 'appId',
      label: 'App ID',
      type: 'text',
      placeholder: 'cli_a1b2c3d4e5f6g7h8',
      required: true,
      secret: false,
      help: '飞书开放平台 → 开发者后台 → 自建应用 → 凭证与基础信息',
    },
    {
      key: 'appSecret',
      label: 'App Secret',
      type: 'password',
      placeholder: '应用密钥',
      required: true,
      secret: true,
      help: '与 App ID 同一页面获取。插件用它换 tenant_access_token，不会写进日志。',
    },
    {
      key: 'folderToken',
      label: '目标文件夹 token',
      type: 'text',
      placeholder: 'fldcnxxxxxxxx',
      required: true,
      secret: false,
      help: '云空间里打开目标文件夹，地址栏 /drive/folder/<token> 末段就是；离开该文件夹则存到根目录。',
    },
  ],

  async status(config) {
    const cfg = cfgOf(config)
    const missing = missingKeys(cfg)
    if (missing.length > 0) {
      return {
        configured: false,
        detail: `未配置飞书：缺少 ${missing.join(' / ')}（飞书开放平台 → 开发者后台 → 自建应用）`,
      }
    }
    return { configured: true, detail: `飞书云文档 · 文件夹 ${str(cfg.folderToken)}` }
  },

  /** Sub-folders of the configured folder; a failure here must not block saving. */
  async options(config, env) {
    const cfg = cfgOf(config)
    if (missingKeys(cfg).length > 0) {
      return { locations: [], note: '未配置飞书凭据，笔记会存到目标文件夹本身。' }
    }
    try {
      const locations = await listFolders(cfg, env)
      return locations.length === 0
        ? { locations, note: '目标文件夹下没有子文件夹，笔记会存到它本身。' }
        : { locations }
    } catch (error) {
      return { locations: [], note: `读取飞书文件夹失败：${error?.message ?? String(error)}` }
    }
  },

  /** Read-only probe: list one row of the target folder. Never writes. */
  async test(config, env) {
    const cfg = cfgOf(config)
    const missing = missingKeys(cfg)
    if (missing.length > 0) {
      return { ok: false, detail: `未配置飞书：缺少 ${missing.join(' / ')}（飞书开放平台 → 开发者后台 → 自建应用）` }
    }
    try {
      await listFolders(cfg, env)
      return { ok: true, detail: '凭据有效：可以读取目标文件夹，笔记会以 docx 导入进去。' }
    } catch (error) {
      return { ok: false, detail: error?.message ?? String(error) }
    }
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config)
    const missing = missingKeys(cfg)
    if (missing.length > 0) {
      throw new Error(`飞书未配置：缺少 ${missing.join(' / ')}。`)
    }
    const markdown = String(note?.markdown ?? '')
    if (markdown.trim() === '') throw new Error('没有可保存的内容（markdown 为空）。')

    const title = str(note?.title) || '未命名笔记'
    // Feishu takes the document title from the imported file name, so it must
    // survive as a file name: reuse the plugin's own sanitiser.
    const fileName = `${safeFileName(title, 'note')}.md`
    const folderToken = str(opts?.location) || str(cfg.folderToken)

    const fileToken = await uploadMarkdown(cfg, env, { fileName, markdown, folderToken, opts })
    const ticket = await createImportTask(cfg, env, { fileName, fileToken, folderToken, opts })
    const created = await waitForImport(cfg, env, ticket, opts)

    return {
      ref: created.token === '' ? ticket : created.token,
      url: created.url === '' ? null : created.url,
      created: true,
    }
  },
}
