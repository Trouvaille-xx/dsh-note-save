/**
 * Notion adapter.
 *
 * Create semantics (per SPEC.md):
 * 1. markdownToBlocks(markdown) — a small, self-contained Markdown → Notion blocks
 *    converter (headings 1-3, paragraphs, bulleted/numbered lists with one nesting
 *    level, fenced code blocks, blockquotes, dividers, and inline **bold** / *italic*
 *    / `code`). Unsupported Markdown degrades to a paragraph carrying the raw text —
 *    content is never dropped.
 * 2. POST https://api.notion.com/v1/pages
 *    { parent:{ database_id }, properties:{ <titleProp>: { title:[{ text:{content} }] } },
 *      children: blocks.slice(0,100) }
 * 3. Remaining blocks: PATCH /v1/blocks/{pageId}/children, <= 100 blocks per call.
 *
 * Headers: Authorization: Bearer <token>, Notion-Version: 2022-06-28,
 *          content-type: application/json.
 * Title is hard-truncated to 32 characters.
 *
 * Zero npm dependencies; all HTTP goes through the injected env.fetch.
 */

const TIMEOUT_MS = 20_000;
const API_BASE = 'https://api.notion.com';
const NOTION_VERSION = '2022-06-28';
const MAX_CHILDREN_PER_CALL = 100;
const MAX_RICH_TEXT = 2000;
const MAX_TITLE = 32;
const DEFAULT_TITLE_PROPERTY = 'Name';

/* ------------------------------------------------------------------ config */

function cfgOf(config) {
  const target = config && config.targets && config.targets.notion;
  return target && typeof target === 'object' ? target : {};
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBaseUrl(raw) {
  const value = str(raw) || API_BASE;
  return value.replace(/\/+$/, '');
}

/** Accepts a raw id or a pasted Notion URL (…/abcdef0123456789abcdef0123456789?v=…). */
function normalizeDatabaseId(raw) {
  const value = str(raw);
  if (!value) return '';
  const hex = value.replace(/-/g, '');
  const match = /[0-9a-fA-F]{32}/.exec(hex);
  return match ? match[0] : value;
}

function signalFor(opts) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const external = opts && opts.signal;
  if (!external) return timeout;
  try {
    return AbortSignal.any([timeout, external]);
  } catch {
    return external;
  }
}

function fetchOf(env) {
  if (!env || typeof env.fetch !== 'function') {
    throw new Error('Notion 适配器缺少注入的 env.fetch，无法发起请求。');
  }
  return env.fetch;
}

function snippet(text, max = 240) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeStatus(status) {
  if (status === 401) return 'Notion 拒绝了请求：Integration Token 无效（HTTP 401），请检查 config.targets.notion.token。';
  if (status === 403) return 'Notion 拒绝访问：Integration 没有被授权访问该数据库（HTTP 403），请在 Notion 数据库页面的「···→ 连接」里添加该 Integration。';
  if (status === 404) return 'Notion 找不到该数据库（HTTP 404）：databaseId 不正确，或 Integration 尚未获得访问权限。';
  if (status === 429) return 'Notion 触发速率限制（HTTP 429，限制约每秒 3 次），请稍后再试。';
  if (status >= 500) return `Notion 服务端出错（HTTP ${status}），请稍后重试。`;
  return `Notion 请求失败（HTTP ${status}）。`;
}

function upstreamMessage(json, text) {
  if (json && typeof json === 'object') {
    const message = str(json.message) || str(json.error);
    if (message) return message;
  }
  return snippet(text);
}

async function readBody(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  if (!text) return { text: '', json: undefined };
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: undefined };
  }
}

/* ------------------------------------------------------- inline rich text */

function annotations(style) {
  return {
    bold: Boolean(style && style.bold),
    italic: Boolean(style && style.italic),
    strikethrough: Boolean(style && style.strikethrough),
    underline: false,
    code: Boolean(style && style.code),
    color: 'default',
  };
}

function hasStyle(style) {
  return Boolean(style && (style.bold || style.italic || style.strikethrough || style.code));
}

function textObject(content, style) {
  const item = { type: 'text', text: { content } };
  if (hasStyle(style)) item.annotations = annotations(style);
  return item;
}

/** Split one styled run into <= 2000-character rich-text objects (per Notion limits). */
function pushRun(out, content, style) {
  const chars = Array.from(content);
  if (!chars.length) {
    if (!out.length) out.push(textObject(' ', style));
    return;
  }
  for (let i = 0; i < chars.length; i += MAX_RICH_TEXT) {
    out.push(textObject(chars.slice(i, i + MAX_RICH_TEXT).join(''), style));
  }
}

const INLINE_RE = /`([^`\n]+)`|\*\*([^*]+)\*\*|\*([^*\n]+)\*|~~([^~\n]+)~~/g;

/**
 * Inline Markdown (`**bold**`, `*italic*`, `` `code` ``, `~~strike~~`) → rich text.
 * Anything unmatched stays literal plain text.
 */
function parseInline(text, style) {
  const source = String(text == null ? '' : text);
  const out = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let match;
  while ((match = INLINE_RE.exec(source)) !== null) {
    if (match.index > last) pushRun(out, source.slice(last, match.index), style);
    if (match[1] !== undefined) {
      pushRun(out, match[1], { ...style, code: true });
    } else if (match[2] !== undefined) {
      pushRun(out, match[2], { ...style, bold: true });
    } else if (match[3] !== undefined) {
      pushRun(out, match[3], { ...style, italic: true });
    } else if (match[4] !== undefined) {
      pushRun(out, match[4], { ...style, strikethrough: true });
    }
    last = match.index + match[0].length;
  }
  if (last < source.length) pushRun(out, source.slice(last), style);
  if (!out.length) pushRun(out, ' ', style);
  return out;
}

/** Plain rich text: no inline parsing (code blocks keep their raw content). */
function plainRichText(text, style) {
  const out = [];
  pushRun(out, String(text == null ? '' : text), style);
  return out;
}

/* ------------------------------------------------------------------ blocks */

const LANGUAGE_ALIASES = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  python3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  yml: 'yaml',
  md: 'markdown',
  jsonc: 'json',
  'c++': 'c++',
  cpp: 'c++',
  'c#': 'c#',
  cs: 'c#',
  rs: 'rust',
  golang: 'go',
  text: 'plain text',
  txt: 'plain text',
  plaintext: 'plain text',
  '': 'plain text',
};

const NOTION_LANGUAGES = new Set([
  'abap', 'arduino', 'bash', 'basic', 'c', 'clojure', 'coffeescript', 'c++', 'c#', 'css',
  'dart', 'diff', 'docker', 'elixir', 'elm', 'erlang', 'flow', 'fortran', 'f#', 'gherkin',
  'glsl', 'go', 'graphql', 'groovy', 'haskell', 'html', 'java', 'javascript', 'json',
  'julia', 'kotlin', 'latex', 'less', 'lisp', 'livescript', 'lua', 'makefile', 'markdown',
  'markup', 'matlab', 'mermaid', 'nix', 'objective-c', 'ocaml', 'pascal', 'perl', 'php',
  'plain text', 'powershell', 'prolog', 'protobuf', 'python', 'r', 'reason', 'ruby', 'rust',
  'sass', 'scala', 'scheme', 'scss', 'sql', 'swift', 'typescript', 'vb.net', 'verilog',
  'vhdl', 'visual basic', 'webassembly', 'xml', 'yaml',
]);

function notionLanguage(info) {
  const raw = str(info).toLowerCase().split(/\s+/)[0] || '';
  const alias = Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, raw)
    ? LANGUAGE_ALIASES[raw]
    : raw;
  return NOTION_LANGUAGES.has(alias) ? alias : 'plain text';
}

function headingBlock(level, text) {
  const type = `heading_${level}`;
  return { object: 'block', type, [type]: { rich_text: parseInline(text) } };
}

function paragraphBlock(lines) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: parseInline(lines.join('\n')) } };
}

function quoteBlock(lines) {
  return { object: 'block', type: 'quote', quote: { rich_text: parseInline(lines.join('\n')) } };
}

function codeBlock(code, info) {
  return {
    object: 'block',
    type: 'code',
    code: {
      rich_text: plainRichText(code),
      language: notionLanguage(info),
    },
  };
}

function listItemBlock(type, text) {
  const block = { object: 'block', type, [type]: { rich_text: parseInline(text) } };
  return block;
}

function dividerBlock() {
  return { object: 'block', type: 'divider', divider: {} };
}

const FENCE_RE = /^\s*(```|~~~)(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const DIVIDER_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BULLET_RE = /^([ \t]*)[-*+]\s+(.*)$/;
const NUMBERED_RE = /^([ \t]*)\d+[.)]\s+(.*)$/;

function isBlockStart(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    DIVIDER_RE.test(line) ||
    QUOTE_RE.test(line) ||
    BULLET_RE.test(line) ||
    NUMBERED_RE.test(line)
  );
}

function indentWidth(prefix) {
  const expanded = String(prefix || '').replace(/\t/g, '  ');
  return expanded.length;
}

/**
 * Markdown → Notion block array.
 * Unsupported constructs (tables, 4+ level headings, HTML, …) become paragraphs that
 * keep the original text, so nothing is silently lost.
 */
function markdownToBlocks(markdown) {
  const lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let openListItem = null; // last top-level list item, receives one nesting level
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    // fenced code block
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const info = fence[2].trim();
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence if present
      blocks.push(codeBlock(body.join('\n'), info));
      openListItem = null;
      continue;
    }

    // heading (1-3 native; deeper headings degrade to paragraphs with raw text)
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level <= 3) {
        blocks.push(headingBlock(level, heading[2].trim()));
      } else {
        blocks.push(paragraphBlock([line.trim()]));
      }
      openListItem = null;
      i += 1;
      continue;
    }

    if (DIVIDER_RE.test(line)) {
      blocks.push(dividerBlock());
      openListItem = null;
      i += 1;
      continue;
    }

    // blockquote (consecutive `>` lines merge)
    const quote = QUOTE_RE.exec(line);
    if (quote) {
      const body = [];
      let current = quote;
      while (i < lines.length && (current = QUOTE_RE.exec(lines[i])) !== null) {
        body.push(current[1]);
        i += 1;
      }
      blocks.push(quoteBlock(body));
      openListItem = null;
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    const numbered = bullet ? null : NUMBERED_RE.exec(line);
    if (bullet || numbered) {
      const match = bullet || numbered;
      const type = bullet ? 'bulleted_list_item' : 'numbered_list_item';
      const text = match[2].trim();
      const nested = indentWidth(match[1]) >= 2;
      const item = listItemBlock(type, text);
      if (nested && openListItem) {
        if (!openListItem.children) openListItem.children = [];
        openListItem.children.push(item);
      } else {
        blocks.push(item);
        openListItem = item;
      }
      i += 1;
      continue;
    }

    // paragraph: merge following non-blank, non-block-starting lines
    const body = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    if (body.length) {
      blocks.push(paragraphBlock(body));
      openListItem = null;
    } else {
      // defensive: never spin forever
      blocks.push(paragraphBlock([line]));
      i += 1;
    }
  }

  return blocks;
}

/* ----------------------------------------------------------------- helpers */

function truncateTitle(raw) {
  const chars = Array.from(String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim());
  if (!chars.length) return '未命名笔记';
  return chars.slice(0, MAX_TITLE).join('');
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'content-type': 'application/json',
  };
}

async function requestJson(fetchFn, url, init, label) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new Error(`无法连接 Notion（${label}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`);
  }
  const { text, json } = await readBody(res);
  if (!res.ok) {
    const upstream = upstreamMessage(json, text);
    throw new Error(`${describeStatus(res.status)}${upstream ? ` 上游返回：${upstream}` : ''}`);
  }
  if (!json || typeof json !== 'object') {
    throw new Error(`Notion 返回了无法解析的响应（HTTP ${res.status}，${label}）：${snippet(text) || '空响应'}`);
  }
  return json;
}

/* ----------------------------------------------------------------- adapter */

function missingReason(cfg) {
  const token = str(cfg.token);
  const databaseId = normalizeDatabaseId(cfg.databaseId || cfg.database || cfg.db);
  if (!token) return '未配置 Notion Token：请填写 config.targets.notion.token（Notion Integration 的 Internal Integration Secret）。';
  if (!databaseId) return '未选择 Notion 数据库：请填写 config.targets.notion.databaseId（数据库 URL 里那串 32 位 id）。';
  return '';
}

const adapter = {
  id: 'notion',
  label: 'Notion',

  /**
   * Plain array (not a function): the save panel can read the form description
   * without a config object. Keys must stay identical to `config.targets.notion`.
   */
  fields: [
    {
      key: 'token',
      label: 'Integration 令牌',
      type: 'password',
      placeholder: 'secret_…（Integration 内部集成密钥）',
      required: true,
      secret: true,
      help: '在 Notion 我的集成 → 新建/打开 Integration → Internal Integration Secret 里复制。复制后还要在目标数据库页面「··· → 连接」里把该 Integration 加进去。',
    },
    {
      key: 'databaseId',
      label: '数据库 ID',
      type: 'text',
      placeholder: '32 位数据库 id（粘贴数据库链接也可以）',
      required: true,
      secret: false,
      help: '打开目标数据库，从地址栏复制那串 32 位 id（可带连字符，也可直接粘贴整条链接）。',
    },
    {
      key: 'titleProperty',
      label: '标题属性名',
      type: 'text',
      placeholder: 'Name（数据库里作为标题的属性名）',
      required: false,
      secret: false,
      help: '数据库里作为标题的那个属性名，默认 Name。填错会导致 Notion 拒绝创建页面。',
    },
  ],

  async status(config) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) return { configured: false, detail: missing };
    const titleProperty = str(cfg.titleProperty) || DEFAULT_TITLE_PROPERTY;
    return {
      configured: true,
      detail: `数据库 ${normalizeDatabaseId(cfg.databaseId || cfg.database || cfg.db)} · 标题属性 ${titleProperty}`,
    };
  },

  /**
   * Read-only connectivity probe (two GETs, nothing is written):
   *   1. GET {base}/v1/users/me          — validates the Integration token.
   *   2. GET {base}/v1/databases/{id}    — validates the database id / Integration access.
   * The two failures are reported separately so the user knows which field to fix.
   */
  async test(config, env) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) return { ok: false, detail: missing };

    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    const databaseId = normalizeDatabaseId(cfg.databaseId || cfg.database || cfg.db);
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { ok: false, detail: err.message };
    }

    // Step 1 — token check.
    let me;
    try {
      me = await fetchFn(`${base}/v1/users/me`, {
        method: 'GET',
        headers: headers(token),
        signal: signalFor(undefined),
      });
    } catch (err) {
      return {
        ok: false,
        detail: `无法连接 Notion（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}。请检查网络或代理设置。`,
      };
    }
    const meBody = await readBody(me);
    if (!me.ok) {
      const upstream = upstreamMessage(meBody.json, meBody.text);
      return {
        ok: false,
        detail: `${describeStatus(me.status)}${upstream ? ` 上游返回：${upstream}` : ''}（Token 校验未通过）`,
      };
    }
    const meJson = meBody.json;
    const botName =
      str(meJson && meJson.name) ||
      str(meJson && meJson.bot && meJson.bot.owner && meJson.bot.owner.type) ||
      'Integration';

    // Step 2 — database access check.
    let db;
    try {
      db = await fetchFn(`${base}/v1/databases/${encodeURIComponent(databaseId)}`, {
        method: 'GET',
        headers: headers(token),
        signal: signalFor(undefined),
      });
    } catch (err) {
      return {
        ok: false,
        detail: `Notion Token 校验通过，但读取数据库时断线：${snippet(err && err.message ? err.message : err) || '网络错误'}。`,
      };
    }
    const dbBody = await readBody(db);
    if (!db.ok) {
      const upstream = upstreamMessage(dbBody.json, dbBody.text);
      const hint =
        db.status === 403 || db.status === 404
          ? ' Token 已通过校验，但该 Integration 访问不到这个数据库：请检查 databaseId，并在数据库页面「··· → 连接」里把该 Integration 加进去。'
          : '';
      return {
        ok: false,
        detail: `${describeStatus(db.status)}${hint}${upstream ? ` 上游返回：${upstream}` : ''}`,
      };
    }
    const dbJson = dbBody.json;
    const dbTitle = Array.isArray(dbJson && dbJson.title)
      ? dbJson.title
          .map((item) => (item && (item.plain_text || (item.text && item.text.content))) || '')
          .join('')
          .trim()
      : '';
    return {
      ok: true,
      detail: `已连通 Notion：Token 有效（${botName}），数据库「${dbTitle || databaseId}」可访问。`,
    };
  },

  async options(config, env) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) return { locations: [], note: missing };
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { locations: [], note: err.message };
    }
    const base = resolveBaseUrl(cfg.baseUrl);
    const token = str(cfg.token);
    try {
      const res = await fetchFn(`${base}/v1/search`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ filter: { value: 'database', property: 'object' }, page_size: 100 }),
        signal: signalFor(undefined),
      });
      const { text, json } = await readBody(res);
      if (!res.ok || !json || !Array.isArray(json.results)) {
        return {
          locations: [],
          note: `无法从 Notion 列出数据库（${res.ok ? '响应格式异常' : `HTTP ${res.status}`}）：${upstreamMessage(json, text) || '请手动填写 database id'}。Integration 需要先在数据库页面「···→ 连接」里授权。`,
        };
      }
      const locations = json.results
        .filter((item) => item && item.object === 'database' && item.id)
        .map((item) => {
          const label = Array.isArray(item.title)
            ? item.title.map((t) => (t && t.plain_text) || (t && t.text && t.text.content) || '').join('').trim()
            : '';
          return { id: String(item.id), label: label || String(item.id) };
        });
      if (!locations.length) {
        return {
          locations: [],
          note: 'Notion 里没有 Integration 可访问的数据库，请先把 Integration 连接到目标数据库，或手动填写 database id。',
        };
      }
      return { locations };
    } catch (err) {
      return {
        locations: [],
        note: `无法连接 Notion（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`,
      };
    }
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) throw new Error(`Notion 未配置：${missing}`);

    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    const databaseId = normalizeDatabaseId(
      str(opts && opts.location) || cfg.databaseId || cfg.database || cfg.db,
    );
    const titleProperty = str(cfg.titleProperty) || DEFAULT_TITLE_PROPERTY;
    const fetchFn = fetchOf(env);

    const markdown = String((note && note.markdown) || '');
    if (!markdown.trim()) {
      throw new Error('没有可保存的内容（markdown 为空）。');
    }

    const title = truncateTitle(note && note.title);
    const blocks = markdownToBlocks(markdown);
    const [firstChunk = [], ...restChunks] = chunk(blocks, MAX_CHILDREN_PER_CALL);

    const pageBody = {
      parent: { database_id: databaseId },
      properties: { [titleProperty]: { title: [{ text: { content: title } }] } },
    };
    if (firstChunk.length) pageBody.children = firstChunk;

    const page = await requestJson(
      fetchFn,
      `${base}/v1/pages`,
      {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify(pageBody),
        signal: signalFor(opts),
      },
      'pages.create',
    );

    const pageId = typeof page.id === 'string' ? page.id : '';
    if (!pageId) {
      throw new Error('Notion 创建页面成功但响应里没有 page id，无法继续写入剩余内容。');
    }

    for (let index = 0; index < restChunks.length; index += 1) {
      const batch = restChunks[index];
      if (!batch.length) continue;
      await requestJson(
        fetchFn,
        `${base}/v1/blocks/${encodeURIComponent(pageId)}/children`,
        {
          method: 'PATCH',
          headers: headers(token),
          body: JSON.stringify({ children: batch }),
          signal: signalFor(opts),
        },
        `blocks.children (批次 ${index + 1}/${restChunks.length})`,
      );
    }

    return {
      ref: pageId,
      url: typeof page.url === 'string' ? page.url : null,
      created: true,
    };
  },
};

export { markdownToBlocks, truncateTitle, notionLanguage };
export default adapter;
