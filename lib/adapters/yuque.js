/**
 * Yuque (语雀) adapter.
 *
 * Create semantics (per SPEC.md) — BOTH steps are mandatory, in this order:
 * 1. POST {apiBase}/api/v2/repos/{repoId}/docs
 *    headers X-Auth-Token: <token>, content-type: application/json
 *    body { title, slug: String(Date.now()), format:'markdown', body: markdown }
 *    -> { data: { id, slug, title } }
 * 2. PUT {apiBase}/api/v2/repos/{repoId}/toc
 *    body { action:'appendNode', action_mode:'append', doc_ids:[docId] }
 *    Without step 2 the document is invisible (not in the TOC).
 *
 * If step 2 fails the error is a PARTIAL failure that names the created document so
 * the user can still find/fix it manually.
 *
 * Zero npm dependencies; all HTTP goes through the injected env.fetch.
 */

const TIMEOUT_MS = 20_000;
const DEFAULT_API_BASE = 'https://www.yuque.com';

function cfgOf(config) {
  const target = config && config.targets && config.targets.yuque;
  return target && typeof target === 'object' ? target : {};
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveApiBase(raw) {
  const value = str(raw) || DEFAULT_API_BASE;
  return value.replace(/\/+$/, '');
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
    throw new Error('语雀适配器缺少注入的 env.fetch，无法发起请求。');
  }
  return env.fetch;
}

function snippet(text, max = 240) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeStatus(status) {
  if (status === 401) return '语雀拒绝了请求：X-Auth-Token 无效或已过期（HTTP 401）。请在 语雀 → 设置 → 账户 → Token 里重新生成。';
  if (status === 403) return '语雀拒绝访问：当前 Token 没有该知识库的写入权限（HTTP 403，Token 需要超级会员权益）。';
  if (status === 404) return '语雀找不到该知识库或接口（HTTP 404）：请检查 repoId 是否正确、Token 是否有访问该仓库的权限。';
  if (status === 429) return '语雀触发配额限制（HTTP 429）：接口每小时约 5000 次额度已用完，请稍后再试。';
  if (status >= 500) return `语雀服务端出错（HTTP ${status}），请稍后重试。`;
  return `语雀请求失败（HTTP ${status}）。`;
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

/** Yuque errors look like { message, status, code } or { errors:[{ message }] }. */
function upstreamMessage(json, text) {
  if (json && typeof json === 'object') {
    if (typeof json.message === 'string' && json.message) return json.message;
    if (Array.isArray(json.errors) && json.errors.length) {
      const joined = json.errors
        .map((e) => (e && (e.message || e.code)) || '')
        .filter(Boolean)
        .join('; ');
      if (joined) return joined;
    }
    if (typeof json.error === 'string' && json.error) return json.error;
  }
  return snippet(text);
}

function headers(token) {
  return { 'X-Auth-Token': token, 'content-type': 'application/json' };
}

function repoIdOf(cfg, opts) {
  return str((opts && opts.location) || cfg.repoId || cfg.repo || cfg.bookId);
}

function docUrl(cfg, slug) {
  const login = str(cfg.login);
  const repoSlug = str(cfg.repoSlug || cfg.slug);
  if (!login || !repoSlug || !slug) return null;
  return `https://www.yuque.com/${encodeURIComponent(login)}/${encodeURIComponent(repoSlug)}/${encodeURIComponent(slug)}`;
}

function missingReason(cfg) {
  const token = str(cfg.token);
  const repoId = repoIdOf(cfg, undefined);
  if (!token) return '未配置语雀 Token：请填写 config.targets.yuque.token（语雀 → 设置 → 账户 → Token，需要超级会员）。';
  if (!repoId) return '未配置语雀知识库：请填写 config.targets.yuque.repoId（知识库 id，可在知识库设置里查到）。';
  return '';
}

async function callJson(fetchFn, url, init, label) {
  let res;
  try {
    res = await fetchFn(url, init);
  } catch (err) {
    throw new Error(`无法连接语雀（${label}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`);
  }
  const { text, json } = await readBody(res);
  if (!res.ok) {
    const upstream = upstreamMessage(json, text);
    throw new Error(`${describeStatus(res.status)}${upstream ? ` 上游返回：${upstream}` : ''}`);
  }
  if (!json || typeof json !== 'object') {
    throw new Error(`语雀返回了无法解析的响应（HTTP ${res.status}，${label}）：${snippet(text) || '空响应'}`);
  }
  return json;
}

const adapter = {
  id: 'yuque',
  label: 'Yuque',

  /**
   * Plain array (not a function): the save panel can read the form description
   * without a config object. Keys must stay identical to `config.targets.yuque`.
   */
  fields: [
    {
      key: 'token',
      label: 'API 令牌',
      type: 'password',
      placeholder: '在语雀里生成的 X-Auth-Token',
      required: true,
      secret: true,
      help: '语雀 → 设置 → 账户 → Token 里生成并复制（该接口需要超级会员权益）。',
    },
    {
      key: 'repoId',
      label: '知识库 ID',
      type: 'text',
      placeholder: '知识库 id（知识库设置页可以查到）',
      required: true,
      secret: false,
      help: '文档会创建在这个知识库里，并自动加入目录末尾。',
    },
    {
      key: 'login',
      label: '账号路径',
      type: 'text',
      placeholder: 'alice（语雀个人路径 / 团队路径）',
      required: false,
      secret: false,
      help: '可选：用于拼出文档链接 https://www.yuque.com/<账号路径>/<知识库路径>/<文档 slug>。留空时保存结果没有链接。',
    },
    {
      key: 'repoSlug',
      label: '知识库路径',
      type: 'text',
      placeholder: 'kb（知识库 URL 里的那一段）',
      required: false,
      secret: false,
      help: '可选：知识库 URL 里的路径段，和「账号路径」一起用来拼文档链接。',
    },
  ],

  async status(config) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) return { configured: false, detail: missing };
    const repoName = str(cfg.repoName) || str(cfg.repoId || cfg.repo || cfg.bookId);
    return { configured: true, detail: `知识库 ${repoName}` };
  },

  /**
   * Read-only connectivity probe (two GETs, nothing is written):
   *   1. GET {apiBase}/api/v2/user              — validates the X-Auth-Token.
   *   2. GET {apiBase}/api/v2/repos/{repoId}    — validates the repo id / token access.
   */
  async test(config, env) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) return { ok: false, detail: missing };

    const token = str(cfg.token);
    const apiBase = resolveApiBase(cfg.apiBase);
    const repoId = repoIdOf(cfg, undefined);
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { ok: false, detail: err.message };
    }

    // Step 1 — token check.
    let user;
    try {
      user = await fetchFn(`${apiBase}/api/v2/user`, {
        method: 'GET',
        headers: headers(token),
        signal: signalFor(undefined),
      });
    } catch (err) {
      return {
        ok: false,
        detail: `无法连接语雀（${apiBase}）：${snippet(err && err.message ? err.message : err) || '网络错误'}。请检查网络或代理设置。`,
      };
    }
    const userBody = await readBody(user);
    if (!user.ok) {
      const upstream = upstreamMessage(userBody.json, userBody.text);
      return {
        ok: false,
        detail: `${describeStatus(user.status)}${upstream ? ` 上游返回：${upstream}` : ''}（Token 校验未通过）`,
      };
    }
    const login =
      str(userBody.json && userBody.json.data && userBody.json.data.login) || str(cfg.login);

    // Step 2 — repo access check.
    let repo;
    try {
      repo = await fetchFn(`${apiBase}/api/v2/repos/${encodeURIComponent(repoId)}`, {
        method: 'GET',
        headers: headers(token),
        signal: signalFor(undefined),
      });
    } catch (err) {
      return {
        ok: false,
        detail: `语雀 Token 校验通过，但读取知识库时断线：${snippet(err && err.message ? err.message : err) || '网络错误'}。`,
      };
    }
    const repoBody = await readBody(repo);
    if (!repo.ok) {
      const upstream = upstreamMessage(repoBody.json, repoBody.text);
      const hint =
        repo.status === 403 || repo.status === 404
          ? ' Token 已通过校验，但访问不到这个知识库：请检查 repoId 是否正确，以及该 Token 是否有该知识库的权限。'
          : '';
      return {
        ok: false,
        detail: `${describeStatus(repo.status)}${hint}${upstream ? ` 上游返回：${upstream}` : ''}`,
      };
    }
    const repoData = repoBody.json && repoBody.json.data;
    const repoName = str(repoData && repoData.name) || str(cfg.repoName) || repoId;
    return {
      ok: true,
      detail: `已连通语雀：Token 有效${login ? `（${login}）` : ''}，知识库「${repoName}」可访问。`,
    };
  },

  async options(config) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) return { locations: [], note: missing };
    const repoId = repoIdOf(cfg, undefined);
    const repoName = str(cfg.repoName) || repoId;
    return {
      locations: [{ id: repoId, label: repoName }],
      note: '文档会创建在该知识库并自动加入目录末尾。',
    };
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config);
    const missing = missingReason(cfg);
    if (missing) throw new Error(`语雀未配置：${missing}`);

    const token = str(cfg.token);
    const apiBase = resolveApiBase(cfg.apiBase);
    const repoId = repoIdOf(cfg, opts);
    const fetchFn = fetchOf(env);

    const markdown = String((note && note.markdown) || '');
    if (!markdown.trim()) {
      throw new Error('没有可保存的内容（markdown 为空）。');
    }
    const title = String((note && note.title) || '') || '未命名笔记';
    const slug = String(Date.now());

    // Step 1 — create the document.
    const created = await callJson(
      fetchFn,
      `${apiBase}/api/v2/repos/${encodeURIComponent(repoId)}/docs`,
      {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ title, slug, format: 'markdown', body: markdown }),
        signal: signalFor(opts),
      },
      '创建文档',
    );

    const data = created.data && typeof created.data === 'object' ? created.data : created;
    const docId = data && (data.id ?? data.doc_id);
    if (docId === undefined || docId === null || docId === '') {
      throw new Error('语雀创建文档成功但响应里没有文档 id，无法加入目录，请到语雀手动检查该文档。');
    }
    const finalSlug = str(data.slug) || slug;
    const finalTitle = str(data.title) || title;
    const url = docUrl(cfg, finalSlug);

    // Step 2 — append the document to the TOC. Without it the doc is invisible.
    try {
      await callJson(
        fetchFn,
        `${apiBase}/api/v2/repos/${encodeURIComponent(repoId)}/toc`,
        {
          method: 'PUT',
          headers: headers(token),
          body: JSON.stringify({ action: 'appendNode', action_mode: 'append', doc_ids: [docId] }),
          signal: signalFor(opts),
        },
        '加入目录',
      );
    } catch (err) {
      const urlPart = url ? `，文档链接：${url}` : '';
      throw new Error(
        `语雀文档已创建但加入目录失败（部分失败）：《${finalTitle}》(docId=${docId})${urlPart}。` +
          `该文档未出现在知识库目录中，可能看不见。原因：${err.message}。` +
          '请到语雀手动把这篇文档拖进目录（或重试保存）。',
      );
    }

    return { ref: String(docId), url, created: true };
  },
};

export default adapter;
