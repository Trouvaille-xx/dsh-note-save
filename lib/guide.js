/**
 * The operations guide, served at GET /note-save/guide and linked from the
 * bottom of the settings page.
 *
 * Why a page and not inline hints: the settings form should be a form. A field
 * label plus a value is what a user acts on; the "where do I find this token"
 * paragraphs belong in one place they can read once, not repeated under every target
 * forms. The per-field `help` strings adapters already declare are the source
 * for this page, so the explanation cannot drift from the field it describes.
 */

import { listAdapters } from './adapters/index.js'

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch])
}

/**
 * Escape first, then turn `backticks` into <code>. Only tags from this fixed
 * set are introduced, so no input byte can become markup.
 */
function inline(text) {
  return escapeHtml(text).replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

/** Extra, target-level notes that are not field-specific. */
const TARGET_NOTES = {
  obsidian: [
    'Obsidian 的 vault 就是一个普通文件夹，插件直接在里面写 `.md` 文件，不需要 token、不需要 Obsidian 开着。',
    '同名文件不会覆盖：第二次保存会自动变成 `标题 2.md`。',
    '写进去的文件带 frontmatter（title / created / source）。',
  ],
  siyuan: [
    '思源原生接受 Markdown，公式和 mermaid 由思源自己转成原生块。',
    '`createDocWithMd` 的路径末段就是文档标题，父文档不存在会自动创建。',
    '同一个标题重复保存会各自新建文档，不会覆盖。',
  ],
  joplin: [
    '必须先打开 Joplin 的 Web Clipper（工具 → 选项 → 网页剪辑器），端口默认 41184。',
    'token 走查询参数，不是 header —— 这是 Joplin 的接口要求。',
    'Joplin 3.7.x 有超大正文写坏 UTF-8 的已知 bug，所以正文超过 1 MiB 时插件直接拒绝而不是写坏。',
  ],
  notion: [
    '笔记会建在你指定的 Database 下，不是独立页面，所以 Database 必须已经存在。',
    'Integration 必须先被授权访问那个 Database（Notion 页面右上角 … → 连接 → 添加你的 Integration），否则检测会报「访问不到」。',
    '标题字段名要填 Database 里那个标题属性的名字，默认是 `Name`；Notion 的标题会被截断到 32 字符。',
    '正文会被转成 Notion blocks，单次请求上限 100 块，超出自动分批。',
  ],
  yuque: [
    '语雀 Token 是超级会员权益，且有每小时 5000 次配额，超了会返回 429。',
    '写入是两步：先建文档，再追加到目录。少了第二步文档在语雀里等于看不见，插件两步都做。',
    '`知识库 ID` 是 repoId，不是知识库名字。',
  ],
  ima: [
    'ima 有开放的 OpenAPI，笔记是**直接创建进 ima** 的，不需要手动导入，也不是写文件夹。',
    '凭据在 https://ima.qq.com/agent-interface 获取，是一对 Client ID + API Key；填到本页 ima 那一栏，点「检测」验证。',
    '插件调用的是 `openapi/note/v1/import_doc`，把 Markdown 直接建成一条 ima 笔记；标题取正文首个标题行。',
    '「笔记本 ID」可以不填；填了就把笔记放进那个笔记本（folder_id）。',
  ],
  feishu: [
    '飞书走的是**自建应用的 tenant_access_token**：App ID / App Secret 在飞书开放平台 → 开发者后台 → 自建应用 → 凭证与基础信息。',
    '写入路径是「上传 Markdown → 建导入任务 → 轮询结果」，飞书自己把 md 转成 docx，所以格式由飞书解析，插件不手工拼 blocks。',
    '产物归**应用**所有：必须把应用加成目标文件夹的协作者（或让应用自己建这个文件夹），否则会 403。',
    '「目标文件夹 token」在云空间打开文件夹，地址栏 `/drive/folder/<token>` 末段就是；插件会把那个文件夹的子文件夹列出来当可选位置。',
  ],
}

const QUICK_START = [
  '在消息下方点保存图标，选择目标系统，确认位置后保存。',
  '要接新目标：在本页对应 Tab 里填好地址和令牌，先点「检测」确认连通，再点「保存」。',
  '令牌存过之后不会回显，输入框留空表示「保持不变」；要删就勾上「清除」再保存。',
]

function renderFieldRows(adapter) {
  const fields = Array.isArray(adapter.fields) ? adapter.fields : []
  if (fields.length === 0) return '<p class="muted">（这个目标暂时没有可配置项）</p>'
  const rows = fields
    .map((field) => {
      const required = field.required === true ? '<span class="req">*</span>' : ''
      const secret = field.secret === true ? '<span class="tag">密钥</span>' : ''
      return [
        '<tr>',
        `<th>${escapeHtml(field.label)}${required} ${secret}</th>`,
        `<td>${field.help === undefined || field.help === '' ? '<span class="muted">—</span>' : inline(field.help)}</td>`,
        '</tr>',
      ].join('')
    })
    .join('')
  return `<table class="fields"><tbody>${rows}</tbody></table>`
}

function renderTargetSection(adapter) {
  const notes = TARGET_NOTES[adapter.id] ?? []
  const list = notes.length === 0 ? '' : `<ul class="notes">${notes.map((note) => `<li>${inline(note)}</li>`).join('')}</ul>`
  return [
    `<section class="target" id="target-${escapeHtml(adapter.id)}">`,
    `<h2>${escapeHtml(adapter.label)}</h2>`,
    renderFieldRows(adapter),
    list,
    '</section>',
  ].join('')
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1f2328;background:#fff}
main{max-width:760px;margin:0 auto}
h1{font-size:20px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 10px;padding-bottom:8px;border-bottom:1px solid #e6e8eb}
p.lead{color:#57606a;margin:0 0 24px}
section.target{margin:0 0 28px}
ol,ul{margin:0 0 12px;padding-left:22px}
ol li,ul.notes li{margin:0 0 6px}
ul.notes{color:#57606a}
table.fields{border-collapse:collapse;width:100%;margin:0 0 12px;font-size:13px}
table.fields th{text-align:left;vertical-align:top;width:190px;padding:7px 12px 7px 0;font-weight:600;border-bottom:1px solid #eef0f2}
table.fields td{vertical-align:top;padding:7px 0;border-bottom:1px solid #eef0f2;color:#57606a}
.req{color:#cf222e;margin-left:2px}
.tag{display:inline-block;font-size:11px;font-weight:400;color:#57606a;border:1px solid #d0d7de;border-radius:999px;padding:0 6px;margin-left:4px}
.muted{color:#8b949e}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;background:#f6f8fa;border-radius:4px;padding:1px 5px}
.toc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 24px}
.toc a{color:#0969da;text-decoration:none;border:1px solid #d0d7de;border-radius:999px;padding:2px 10px;font-size:12.5px}
footer{margin-top:32px;padding-top:16px;border-top:1px solid #e6e8eb;color:#8b949e;font-size:12px}
@media (prefers-color-scheme:dark){
body{background:#0d1117;color:#e6edf3}
h2{border-bottom-color:#30363d}
p.lead,ul.notes,table.fields td,.tag{color:#9198a1}
table.fields th,table.fields td{border-bottom-color:#21262d}
code{background:#161b22}
.toc a{color:#4493f8;border-color:#30363d}
footer{border-top-color:#30363d}
.req{color:#f85149}
}
`

/**
 * The full guide document.
 *
 * @param {{ configPath?: string }} [options]
 * @returns {string} a complete, self-contained HTML document
 */
export function renderGuide(options = {}) {
  const adapters = listAdapters()
  const toc = adapters
    .map((adapter) => `<a href="#target-${escapeHtml(adapter.id)}">${escapeHtml(adapter.label)}</a>`)
    .join('')
  const sections = adapters.map(renderTargetSection).join('')
  const configPath = String(options.configPath ?? '').trim()

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>笔记保存 · 操作指引</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>笔记保存 · 操作指引</h1>
<p class="lead">把 DSH 里的一段对话保存成笔记，写进你已经在用的笔记系统。只做保存（创建），不做笔记编辑。</p>

<h2>三步上手</h2>
<ol>${QUICK_START.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>

<h2>保存粒度</h2>
<ul class="notes">
<li><strong>单条消息</strong>：那条回答 + 它对应的提问（点消息图标的默认值）。</li>
<li><strong>本轮</strong>：同一个 turn 的全部消息。</li>
<li><strong>整个会话</strong>：会话里所有用户/助手消息正文。</li>
<li>工具输出默认不进正文；思考过程可以按次勾选包含。</li>
</ul>

<h2>各目标怎么配</h2>
<div class="toc">${toc}</div>
${sections}

<h2>配置文件</h2>
<p class="lead">${configPath === '' ? '设置页底部会显示实际路径。' : `当前路径：<code>${escapeHtml(configPath)}</code>`}</p>
<ul class="notes">
<li>默认在 <code>%USERPROFILE%\\.dsh\\note-save.json</code>（设了 <code>DSH_HOME</code> 就在它下面），首次保存时创建，权限 0600。</li>
<li>令牌存在这个文件里，<strong>不放</strong> profile 的 <code>cordis.patch.yml</code>。</li>
<li>从设置页改比手改安全：写盘是原子的，且不会把没改的字段覆盖掉。</li>
</ul>

<footer>这个页面由插件自己提供（<code>/note-save/guide</code>），随插件版本更新。</footer>
</main>
</body>
</html>`
}
