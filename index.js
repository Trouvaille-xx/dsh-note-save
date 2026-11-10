/**
 * dsh-note-save — host half.
 *
 * One job: take a conversation (or one turn, or one message), render it as
 * Markdown, and create a note in one of five target systems. Nothing here
 * edits notes, syncs them, or keeps client state.
 *
 * The browser half calls the `/note-save/*` prefix route registered below; the
 * agent calls the same operations through the `note_save` tool. Both paths run
 * the one implementation in this file.
 */

import { adapterOf, listAdapters, makeEnv } from './lib/adapters/index.js'
import { readConfig, TARGET_IDS, writeTargetConfig } from './lib/config.js'
import { renderNote, stamp, summarize } from './lib/render.js'

export const name = 'dsh-note-save'

export const inject = ['webServer', 'connection', 'sessions', 'tools']

const ROUTE_PREFIX = '/note-save'
const MAX_BODY_BYTES = 1024 * 1024

/* ------------------------------------------------------------------ errors */

class NoteSaveError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'NoteSaveError'
    this.code = code
    this.status = status
  }
}

/* --------------------------------------------------------------- http glue */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new NoteSaveError('body-too-large', '请求体过大', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw.toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new NoteSaveError('bad-json', '请求体不是合法 JSON')
  }
}

function sendJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

const ok = (res, value) => sendJson(res, 200, { ok: true, value })
const fail = (res, error) => {
  const status = error instanceof NoteSaveError ? error.status : 500
  const code = error instanceof NoteSaveError ? error.code : 'internal'
  sendJson(res, status, { ok: false, error: { code, message: error?.message ?? String(error) } })
}

/* ------------------------------------------------------------ session read */

const SURFACE_MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** Optional services are read through `ctx.get`, never as bare properties. */
function optional(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
  } catch {
    return undefined
  }
}

/**
 * Every model-visible message of one session, oldest first.
 *
 * Reads the live session when it exists (it is authoritative) and otherwise
 * replays the persisted log through `sessionQuery`. Only flat shapes are
 * interpreted: a `user/message` event's data IS the message, an
 * `assistant/message` event carries it under `message`.
 */
async function readMessages(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new NoteSaveError('missing-session', '缺少 sessionId')
  }

  let events = null
  const live = ctx.sessions?.get?.(sessionId)
  if (live !== undefined && live !== null) {
    try {
      events = live.snapshotEvents()
    } catch {
      events = null
    }
  }
  if (events === null) {
    const sessionQuery = optional(ctx, 'sessionQuery')
    if (typeof sessionQuery?.readSession !== 'function') {
      throw new NoteSaveError('session-unavailable', '无法读取该会话（会话不在内存中且没有持久化查询服务）', 404)
    }
    try {
      const snapshot = await sessionQuery.readSession(sessionId)
      events = snapshot?.events ?? null
    } catch (error) {
      throw new NoteSaveError('session-unavailable', `无法读取会话：${error?.message ?? String(error)}`, 404)
    }
  }
  if (!Array.isArray(events) || events.length === 0) {
    throw new NoteSaveError('session-empty', '这个会话还没有可保存的消息', 404)
  }

  // Drop events a later surface replace superseded, then keep the messages.
  const replaced = new Set()
  for (const event of events) {
    const op = event?.surfaceOp
    if (op !== null && typeof op === 'object' && op.op === 'replace') {
      for (let seq = op.startSeq; seq <= op.endSeq; seq += 1) replaced.add(seq)
    }
  }

  const messages = []
  // Turn numbers come from three places, in decreasing authority: an
  // assistant event's own `data.turn`, the enclosing `turn/start`, and finally
  // the position of the user prompt (one prompt opens one turn). Only grouping
  // matters here, so the positional fallback keeps older or seeded logs — which
  // may carry no `turn/start` at all — selecting the same messages. Without it,
  // "this turn" returned only the assistant reply and silently dropped the
  // prompt that produced it.
  let currentTurn = null
  let positionalTurn = -1
  for (const event of events) {
    if (replaced.has(event?.seq)) continue
    if (event?.type === 'turn/start') {
      const turn = event.data?.turn
      currentTurn = typeof turn === 'number' ? turn : currentTurn
      continue
    }
    if (!SURFACE_MESSAGE_TYPES.has(event?.type)) continue
    const data = event.data ?? {}
    const message = event.type === 'user/message' ? data : data.message
    if (message === null || typeof message !== 'object') continue
    if (event.type === 'user/message') positionalTurn += 1
    const blocks = Array.isArray(message.content)
      ? message.content
      : typeof message.content === 'string'
        ? [{ type: 'text', text: message.content }]
        : []
    const ownTurn =
      typeof data.turn === 'number'
        ? data.turn
        : typeof currentTurn === 'number'
          ? currentTurn
          : Math.max(positionalTurn, 0)
    messages.push({
      role: message.role ?? (event.type === 'user/message' ? 'user' : 'assistant'),
      id: typeof message.id === 'string' ? message.id : String(event.seq),
      turn: ownTurn,
      time: typeof event.time === 'number' ? event.time : null,
      blocks,
    })
  }
  if (messages.length === 0) {
    throw new NoteSaveError('session-empty', '这个会话没有可保存的正文消息', 404)
  }
  return messages
}

/** Select the messages a scope covers, anchored on one message id. */
function selectMessages(messages, scope, messageId) {
  if (scope === 'session') return messages

  const anchorIndex = messages.findIndex((message) => message.id === messageId)
  if (anchorIndex === -1) {
    // The anchor can be missing for a message that is still streaming; falling
    // back to the last assistant message keeps the common case working.
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') {
        return scope === 'turn' ? turnOf(messages, index) : [messages[index]]
      }
    }
    throw new NoteSaveError('message-not-found', '找不到这条消息（它可能还在生成中）', 404)
  }

  if (scope === 'message') {
    const anchor = messages[anchorIndex]
    // A turn is what a reader means by "this answer": the user prompt plus the
    // assistant reply that followed it.
    if (anchor.role !== 'assistant') {
      const reply = messages.slice(anchorIndex + 1).find((message) => message.role === 'assistant')
      return reply === undefined ? [anchor] : [anchor, reply]
    }
    const prompt = [...messages.slice(0, anchorIndex)].reverse().find((message) => message.role === 'user')
    return prompt === undefined ? [anchor] : [prompt, anchor]
  }

  return turnOf(messages, anchorIndex)
}

function turnOf(messages, index) {
  const anchor = messages[index]
  if (anchor.turn === null || anchor.turn === undefined) {
    // Older logs carry no turn number: take the enclosing prompt..reply pair.
    let start = index
    while (start > 0 && messages[start].role !== 'user') start -= 1
    let end = index
    while (end + 1 < messages.length && messages[end + 1].role !== 'user') end += 1
    return messages.slice(start, end + 1)
  }
  return messages.filter((message) => message.turn === anchor.turn)
}

/** A stable, readable document title for the selected messages. */
async function makeTitle(ctx, sessionId, messages, provided) {
  if (typeof provided === 'string' && provided.trim() !== '') return provided.trim()
  const sessionQuery = optional(ctx, 'sessionQuery')
  if (typeof sessionQuery?.readTitle === 'function') {
    try {
      const snapshot = await sessionQuery.readTitle(sessionId)
      const title = snapshot?.title ?? snapshot?.value?.title
      if (typeof title === 'string' && title.trim() !== '') return title.trim()
    } catch {
      /* a missing title is normal */
    }
  }
  return summarize(messages) || `对话 ${stamp()}`
}

/* ---------------------------------------------------------------- services */

function requireTarget(targetId) {
  if (typeof targetId !== 'string' || targetId === '') {
    throw new NoteSaveError('missing-target', '缺少目标系统')
  }
  if (!TARGET_IDS.includes(targetId)) {
    throw new NoteSaveError('unknown-target', `未知目标系统：${targetId}`)
  }
  return targetId
}

function targetConfig(config, targetId) {
  const targets = config?.targets ?? {}
  return targets[targetId] ?? {}
}

/** One preview shared by the panel and the tool. */
async function previewOperation(ctx, rowConfig, request) {
  const scope = normalizeScope(request.scope)
  const messages = await readMessages(ctx, request.sessionId)
  const selected = selectMessages(messages, scope, request.messageId)
  const title = await makeTitle(ctx, request.sessionId, selected, request.title)
  const markdown = renderNote({
    messages: selected,
    includeReasoning: request.includeReasoning === true,
    lang: 'zh',
  })
  if (markdown.trim() === '') {
    throw new NoteSaveError('empty-note', '选中的内容没有可保存的正文', 400)
  }
  return { title, markdown, stats: { messages: selected.length, chars: markdown.length } }
}

function normalizeScope(scope) {
  return scope === 'session' || scope === 'turn' || scope === 'message' ? scope : 'message'
}

/** One save shared by the panel and the tool. */
async function saveOperation(ctx, rowConfig, request, env) {
  const targetId = requireTarget(request.target)
  const adapter = adapterOf(targetId)
  // Adapters receive the WHOLE config: each one reads its own
  // `config.targets.<id>` slice (see SPEC.md), so the shape stays identical
  // whether a target is called for status, options or write.
  const config = await readConfig(rowConfig)
  const preview = await previewOperation(ctx, rowConfig, request)

  const status = await adapter.status(config, env)
  if (status?.configured !== true) {
    throw new NoteSaveError('target-not-configured', `${adapter.label} 未配置：${status?.detail ?? '缺少必要设置'}`, 400)
  }

  try {
    const written = await adapter.write(
      { title: preview.title, markdown: preview.markdown },
      { location: typeof request.location === 'string' ? request.location : undefined },
      config,
      env,
    )
    return {
      target: targetId,
      label: adapter.label,
      title: preview.title,
      ref: written?.ref ?? '',
      url: written?.url ?? null,
      created: written?.created !== false,
      stats: preview.stats,
    }
  } catch (error) {
    if (error instanceof NoteSaveError) throw error
    throw new NoteSaveError('write-failed', error?.message ?? String(error), 502)
  }
}

async function stateOperation(rowConfig, env) {
  const config = await readConfig(rowConfig)
  const targets = []
  for (const adapter of listAdapters()) {
    let status
    try {
      status = await adapter.status(config, env)
    } catch (error) {
      status = { configured: false, detail: error?.message ?? String(error) }
    }
    targets.push({
      id: adapter.id,
      label: adapter.label,
      configured: status?.configured === true,
      detail: status?.detail ?? '',
    })
  }
  const preferred = config.defaultTarget
  const fallback = targets.find((target) => target.configured)?.id ?? targets[0]?.id ?? 'obsidian'
  return {
    version: '0.1.0',
    targets,
    defaultTarget: targets.some((target) => target.id === preferred) ? preferred : fallback,
    configPath: config.configPath,
  }
}

/**
 * The settings page renders itself from this: one descriptor list per target,
 * so adding a target needs no client change.
 */
function schemaOperation() {
  return {
    targets: listAdapters().map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      fields: Array.isArray(adapter.fields) ? adapter.fields : [],
    })),
  }
}

/**
 * Current settings, with secrets redacted.
 *
 * A stored token never travels back to the browser: the page shows
 * `hasValue: true` and an empty input, and an unchanged empty input means
 * "keep the stored secret". This is the difference between a settings page and
 * a secret leak into browser memory and devtools.
 */
async function configOperation(rowConfig) {
  const config = await readConfig(rowConfig)
  const values = {}
  for (const adapter of listAdapters()) {
    const settings = config?.targets?.[adapter.id] ?? {}
    const fields = Array.isArray(adapter.fields) ? adapter.fields : []
    const view = {}
    for (const [key, value] of Object.entries(settings)) {
      const field = fields.find((candidate) => candidate.key === key)
      if (field?.secret === true) {
        view[key] = ''
        view[`${key}Set`] = typeof value === 'string' && value !== ''
      } else {
        view[key] = value
      }
    }
    values[adapter.id] = view
  }
  return { values, configPath: config.configPath, defaultTarget: config.defaultTarget }
}

/**
 * Merge one target's submitted values into its stored settings.
 *
 * Secret fields that arrive empty are treated as "unchanged" so a page that
 * cannot read the token back never erases it; an explicit `clear<Field>` flag
 * is how a user removes one.
 */
async function saveConfigOperation(rowConfig, request) {
  const targetId = requireTarget(request.target)
  const adapter = adapterOf(targetId)
  const fields = Array.isArray(adapter.fields) ? adapter.fields : []
  const submitted = request.values !== null && typeof request.values === 'object' ? request.values : {}
  const patch = {}
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(submitted, field.key)) continue
    const raw = submitted[field.key]
    const text = typeof raw === 'string' ? raw.trim() : raw
    if (field.secret === true) {
      if (submitted[`clear_${field.key}`] === true) {
        patch[field.key] = ''
        continue
      }
      if (text === '' || text === undefined) continue
      patch[field.key] = text
      continue
    }
    patch[field.key] = text === undefined || text === null ? '' : String(text)
  }
  if (Object.keys(patch).length === 0) {
    throw new NoteSaveError('nothing-to-save', '没有可保存的修改')
  }
  await writeTargetConfig(targetId, patch)
  return await configOperation(rowConfig)
}

/** Read-only connectivity probe for one target, optionally with unsaved values. */
async function testOperation(rowConfig, request, env) {
  const targetId = requireTarget(request.target)
  const adapter = adapterOf(targetId)
  if (typeof adapter.test !== 'function') {
    throw new NoteSaveError('no-test', `${adapter.label} 不支持连通性检测`, 400)
  }
  const stored = await readConfig(rowConfig)
  const config = structuredClone(stored)
  const fields = Array.isArray(adapter.fields) ? adapter.fields : []
  const submitted = request.values !== null && typeof request.values === 'object' ? request.values : {}
  // Probe with what the user is about to save, falling back to what is stored.
  config.targets = config.targets ?? {}
  config.targets[targetId] = { ...(config.targets[targetId] ?? {}) }
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(submitted, field.key)) continue
    const raw = submitted[field.key]
    const text = typeof raw === 'string' ? raw.trim() : ''
    if (text === '') continue
    config.targets[targetId][field.key] = text
  }
  try {
    const result = await adapter.test(config, env)
    return { ok: result?.ok === true, detail: result?.detail ?? '' }
  } catch (error) {
    return { ok: false, detail: error?.message ?? String(error) }
  }
}

/** Obsidian vaults Obsidian itself knows about, for the picker. */
async function obsidianVaultsOperation(env) {
  const mod = await import('./lib/adapters/obsidian.js')
  const vaults = await mod.listVaults(env)
  return { vaults }
}

/** Subfolders of one vault path, for the folder picker. */
async function obsidianFoldersOperation(env, url) {
  const vault = url.searchParams.get('vault') ?? ''
  const path = url.searchParams.get('path') ?? ''
  const mod = await import('./lib/adapters/obsidian.js')
  return await mod.listFolders(vault, path, env)
}

/* --------------------------------------------------------------- http layer */

function routePath(req) {
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const path = url.pathname
  if (!path.startsWith(ROUTE_PREFIX)) return null
  return path.slice(ROUTE_PREFIX.length) || '/'
}

export function apply(ctx, config = {}) {
  const env = makeEnv(optional(ctx, 'logger') ?? console)

  const dispatch = async (req, res, path) => {
    if (req.method === 'GET' && path === '/state') {
      ok(res, await stateOperation(config, env))
      return
    }

    const optionsMatch = /^\/targets\/([a-z]+)\/options$/.exec(path)
    if (req.method === 'GET' && optionsMatch !== null) {
      const targetId = requireTarget(optionsMatch[1])
      const adapter = adapterOf(targetId)
      let result
      try {
        result = await adapter.options(await readConfig(config), env)
      } catch (error) {
        throw new NoteSaveError('options-failed', error?.message ?? String(error), 502)
      }
      ok(res, { locations: result?.locations ?? [], note: result?.note ?? '' })
      return
    }

    if (req.method === 'POST' && path === '/preview') {
      const body = await readJson(req)
      ok(res, await previewOperation(ctx, config, body))
      return
    }

    if (req.method === 'POST' && path === '/save') {
      const body = await readJson(req)
      ok(res, await saveOperation(ctx, config, body, env))
      return
    }

    if (req.method === 'POST' && path === '/config') {
      const body = await readJson(req)
      const targetId = requireTarget(body.target)
      await writeTargetConfig(targetId, body.values ?? {})
      ok(res, await stateOperation(config, env))
      return
    }

    if (req.method === 'GET' && path === '/schema') {
      ok(res, schemaOperation())
      return
    }

    if (req.method === 'GET' && path === '/config') {
      ok(res, await configOperation(config))
      return
    }

    if (req.method === 'POST' && path === '/config/save') {
      const body = await readJson(req)
      ok(res, await saveConfigOperation(config, body))
      return
    }

    if (req.method === 'POST' && path === '/test') {
      const body = await readJson(req)
      ok(res, await testOperation(config, body, env))
      return
    }

    if (req.method === 'GET' && path === '/obsidian/vaults') {
      ok(res, await obsidianVaultsOperation(env))
      return
    }

    if (req.method === 'GET' && path === '/obsidian/folders') {
      const url = new URL(req.url ?? '/', 'http://dsh.internal')
      ok(res, await obsidianFoldersOperation(env, url))
      return
    }

    // The operations guide is an HTML page, not JSON: it is written straight to
    // the response, bypassing the envelope.
    if (req.method === 'GET' && path === '/guide') {
      const { renderGuide } = await import('./lib/guide.js')
      const stored = await readConfig(config)
      const html = renderGuide({ configPath: stored.configPath })
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // Self-contained page: no scripts, no external loads.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
      })
      res.end(html)
      return
    }

    throw new NoteSaveError('not-found', `未知接口：${req.method} ${path}`, 404)
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          // Same browser-trust fence the shipped routes use: a request that
          // fails it must never reach plugin code.
          const rejection = ctx.connection.requestRejection(req)
          if (rejection !== undefined) {
            sendJson(res, rejection, {
              ok: false,
              error: { code: 'forbidden', message: '浏览器信任校验未通过' },
            })
            return
          }
          const path = routePath(req)
          if (path === null) {
            sendJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知接口' } })
            return
          }
          try {
            await dispatch(req, res, path)
          } catch (error) {
            fail(res, error)
          }
        },
      }),
    'dsh-note-save: /note-save route',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'note_save',
        description:
          'Save the current conversation, one turn, or one message as a note in Obsidian, SiYuan, Joplin, Notion or Yuque, ' +
          'or drop it as a Markdown file for manual import into ima. ' +
          'Use action "list" to see which targets are configured, action "preview" to get the Markdown without writing, ' +
          'and action "save" to create the note. Only creates notes; it never edits or deletes existing ones.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'preview', 'save'],
              description: 'list configured targets, preview the Markdown, or save it.',
            },
            target: {
              type: 'string',
              enum: TARGET_IDS,
              description: 'Target system for action=save.',
            },
            scope: {
              type: 'string',
              enum: ['message', 'turn', 'session'],
              description: 'How much of the conversation to save. Defaults to "message".',
            },
            messageId: {
              type: 'string',
              description: 'Anchor message id; required for scope=message and used as the turn anchor for scope=turn.',
            },
            title: { type: 'string', description: 'Note title. Generated from the conversation when omitted.' },
            location: {
              type: 'string',
              description: 'Target location id (vault folder, notebook id, Joplin folder id, Notion database id, Yuque repo id).',
            },
            includeReasoning: {
              type: 'boolean',
              description: 'Include the assistant reasoning blocks in the note body. Off by default.',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: true,
            properties: {
              targets: { type: 'array', items: { type: 'object', additionalProperties: true } },
              title: { type: 'string' },
              markdown: { type: 'string' },
              target: { type: 'string' },
              ref: { type: 'string' },
              url: { type: 'string' },
            },
          },
          render: (_args, value) => {
            if (typeof value?.ref === 'string' && value.ref !== '') {
              return [
                {
                  type: 'text',
                  text: `已保存到 ${value.label ?? value.target}：${value.ref}${value.url ? `\n${value.url}` : ''}`,
                },
              ]
            }
            if (typeof value?.markdown === 'string') {
              return [
                {
                  type: 'text',
                  text: `预览《${value.title ?? ''}》 — ${value.markdown.length} 字符\n\n${value.markdown}`,
                },
              ]
            }
            const rows = Array.isArray(value?.targets) ? value.targets : []
            return [
              {
                type: 'text',
                text:
                  rows.length === 0
                    ? '没有可用目标系统'
                    : rows
                        .map((target) => `${target.configured ? '✅' : '⛔'} ${target.label}${target.detail ? ` — ${target.detail}` : ''}`)
                        .join('\n'),
              },
            ]
          },
        },
        execute: async (args, exec) => {
          const action = args?.action
          if (action === 'list') {
            const state = await stateOperation(config, env)
            return { targets: state.targets, defaultTarget: state.defaultTarget }
          }

          // The tool speaks for the calling agent's own session: never trust a
          // model-supplied session id, and never read a session it does not own.
          const sessionId = exec?.agent?.id
          if (typeof sessionId !== 'string' || sessionId === '') {
            throw new NoteSaveError('missing-session', '这个工具只能在会话中调用（拿不到会话 id）')
          }

          const request = {
            sessionId,
            scope: args?.scope,
            messageId: args?.messageId,
            title: args?.title,
            includeReasoning: args?.includeReasoning,
            location: args?.location,
            target: args?.target,
          }

          if (action === 'preview') {
            const preview = await previewOperation(ctx, config, request)
            return { title: preview.title, markdown: preview.markdown, stats: preview.stats }
          }
          if (action === 'save') {
            if (request.target === undefined) {
              throw new NoteSaveError('missing-target', 'action=save 需要 target（先跑 action=list 看哪些已配置）')
            }
            return await saveOperation(ctx, config, request, env)
          }
          throw new NoteSaveError('unknown-action', `未知 action：${String(action)}`)
        },
        presentCall: (args) => ({ card: 'generic', title: 'note_save', rawInput: args }),
      }),
    'dsh-note-save: note_save tool',
  )
}

/** Exposed for tests and for the panel's development mode. */
export const internals = { readMessages, selectMessages, previewOperation, saveOperation, stateOperation }
