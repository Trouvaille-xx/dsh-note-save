/**
 * Note rendering: session messages -> portable Markdown.
 *
 * Kept deliberately dumb: every target accepts Markdown, so nothing here may
 * depend on a target's block model. Frontmatter is the adapter's business.
 */

const ROLE_HEADING = {
  user: '### 👤 用户',
  assistant: '### 🤖 助手',
  tool: '### 🔧 工具',
  system: '### ⚙️ 系统',
  developer: '### ⚙️ 系统',
}

const ROLE_PLAIN = {
  user: '### User',
  assistant: '### Assistant',
  tool: '### Tool',
  system: '### System',
  developer: '### System',
}

/** Flatten one message's content blocks into markdown text. */
export function blocksToMarkdown(blocks, { includeReasoning = false } = {}) {
  const parts = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (block.type === 'reasoning') {
      if (includeReasoning && typeof block.text === 'string') {
        parts.push(`> [!note] 思考过程\n${block.text.trim().split('\n').map((l) => `> ${l}`).join('\n')}`)
      }
    } else if (block.type === 'image') {
      const name = block.attachment?.name ?? '图片'
      parts.push(`*[${name}]*`)
    } else if (block.type === 'file') {
      const name = block.attachment?.name ?? '文件'
      parts.push(`*[附件：${name}]*`)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * Render a note body.
 *
 * @param {object} input
 * @param {Array<{role: string, blocks: unknown[], time?: number}>} input.messages
 * @param {boolean} [input.includeReasoning]
 * @param {string} [input.lang] `zh` (default) or anything else for English headings.
 * @returns {string} markdown without frontmatter
 */
export function renderNote({ messages, includeReasoning = false, lang = 'zh' } = {}) {
  const headings = lang === 'zh' ? ROLE_HEADING : ROLE_PLAIN
  const list = Array.isArray(messages) ? messages : []
  const sections = []
  for (const message of list) {
    const body = blocksToMarkdown(message.blocks, { includeReasoning })
    if (body === '') continue
    // A leading heading inside the body would collide with ours; indent it.
    const safe = body.replace(/^(#{1,6})\s/gm, '    $1 ')
    sections.push(`${headings[message.role] ?? `### ${message.role}`}\n\n${safe}`)
  }
  return sections.join('\n\n---\n\n')
}

/** First non-empty text of a message, collapsed to one line, for titles. */
export function summarize(messages, limit = 30) {
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = blocksToMarkdown(message.blocks).replace(/\s+/g, ' ').trim()
    if (text !== '') {
      const chars = [...text]
      return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text
    }
  }
  return ''
}

/** `20261110-133000` in local time — stable, sortable, filename-safe. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** Shared filename hygiene for targets that create files. */
export function safeFileName(input, fallback = 'note') {
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
  let name = String(input ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
  if (name === '') name = fallback
  if (reserved.test(name)) name = `_${name}`
  const chars = [...name]
  if (chars.length > 80) name = chars.slice(0, 80).join('').trim()
  return name === '' ? fallback : name
}
