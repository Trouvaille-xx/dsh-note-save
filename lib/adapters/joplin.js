/**
 * Joplin adapter (Web Clipper API).
 *
 * Create semantics (per SPEC.md):
 *   POST {baseUrl}/notes?token={token}
 *   body { title, body, source } (+ parent_id when a notebook is chosen)
 *   -> { id, ... }
 *
 * Notes:
 * - The token is a QUERY parameter, never a header.
 * - Joplin 3.7.x corrupts UTF-8 on very large bodies: refuse > 1 MiB before any request.
 *
 * Zero npm dependencies; all HTTP goes through the injected env.fetch.
 */

const TIMEOUT_MS = 20_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:41184';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
const SOURCE = 'dsh-note-save';

function cfgOf(config) {
  const target = config && config.targets && config.targets.joplin;
  return target && typeof target === 'object' ? target : {};
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveBaseUrl(raw) {
  const value = str(raw) || DEFAULT_BASE_URL;
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
    throw new Error('Joplin 适配器缺少注入的 env.fetch，无法发起请求。');
  }
  return env.fetch;
}

function snippet(text, max = 240) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeStatus(status) {
  if (status === 401) return 'Joplin 拒绝了请求：Web Clipper Token 无效或已失效（HTTP 401），请在 工具 → 选项 → Web Clipper 里重新授权。';
  if (status === 403) return 'Joplin 拒绝访问：当前 Token 没有写入权限（HTTP 403）。';
  if (status === 404) return 'Joplin 接口不存在（HTTP 404）：请确认 baseUrl 与 Web Clipper 端口（默认 http://127.0.0.1:41184）以及 Joplin 版本。';
  if (status === 429) return 'Joplin 触发速率限制：请求过于频繁（HTTP 429），请稍后再试。';
  if (status >= 500) return `Joplin 服务端出错（HTTP ${status}），请稍后重试。`;
  return `Joplin 请求失败（HTTP ${status}）。`;
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

function upstreamMessage(json, text) {
  if (json && typeof json === 'object') {
    if (typeof json.error === 'string' && json.error) return json.error;
    if (typeof json.message === 'string' && json.message) return json.message;
  }
  return snippet(text);
}

function tokenQuery(token) {
  return `token=${encodeURIComponent(token)}`;
}

const adapter = {
  id: 'joplin',
  label: 'Joplin',

  /**
   * Plain array (not a function): the save panel can read the form description
   * without a config object. Keys must stay identical to `config.targets.joplin`.
   */
  fields: [
    {
      key: 'baseUrl',
      label: 'Web Clipper 地址',
      type: 'url',
      placeholder: 'http://127.0.0.1:41184（Web Clipper 地址）',
      required: false,
      secret: false,
      help: 'Joplin Web Clipper 的地址。默认 http://127.0.0.1:41184，只有改过端口才需要改。',
    },
    {
      key: 'token',
      label: 'Web Clipper 令牌',
      type: 'password',
      placeholder: '在 Joplin 的 Web Clipper 设置里复制授权 token',
      required: true,
      secret: true,
      help: 'Joplin 工具 → 选项 → Web Clipper 里启用并复制授权 token。缺失时无法保存。',
    },
    {
      key: 'folder',
      label: '笔记本',
      type: 'text',
      placeholder: '笔记本 id（在面板「选位置」里可以看到）',
      required: false,
      secret: false,
      help: '可选：笔记写进哪个笔记本。留空则写进 Joplin 的默认收件箱。',
    },
  ],

  async status(config) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      return {
        configured: false,
        detail: '未配置 Joplin Token：请在 Joplin 工具 → 选项 → Web Clipper 里启用并复制授权 token，填到 config.targets.joplin.token。',
      };
    }
    return { configured: true, detail: `${base} · Token 已配置` };
  },

  /**
   * Read-only connectivity probe:
   *   1. GET {baseUrl}/ping  — no token; proves the Web Clipper server is up.
   *   2. GET {baseUrl}/folders?token=… — proves the token is valid.
   * A failure of step 1 (server down) is reported differently from step 2 (bad token).
   */
  async test(config, env) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      return {
        ok: false,
        detail: '未配置 Joplin Token：请在 Joplin 工具 → 选项 → Web Clipper 里启用并复制授权 token，填到 config.targets.joplin.token。',
      };
    }
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { ok: false, detail: err.message };
    }

    // Step 1 — is the Web Clipper HTTP server reachable at all? (`/ping` needs no token)
    let ping;
    try {
      ping = await fetchFn(`${base}/ping`, { method: 'GET', signal: signalFor(undefined) });
    } catch (err) {
      return {
        ok: false,
        detail: `无法连接 Joplin（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}。请确认 Joplin 已启动并开启了 Web Clipper。`,
      };
    }
    const pingBody = await readBody(ping);
    if (!ping.ok) {
      return {
        ok: false,
        detail: `Joplin Web Clipper 未正常响应（HTTP ${ping.status}）：${snippet(pingBody.text) || '无响应内容'}。请确认 Joplin 已启动，且 工具 → 选项 → Web Clipper 已启用（默认端口 41184）。`,
      };
    }

    // Step 2 — validate the token by listing notebooks (read-only).
    let res;
    try {
      res = await fetchFn(`${base}/folders?${tokenQuery(token)}`, {
        method: 'GET',
        signal: signalFor(undefined),
      });
    } catch (err) {
      return {
        ok: false,
        detail: `已连通 Joplin Web Clipper（${base}/ping），但读取笔记本时断线：${snippet(err && err.message ? err.message : err) || '网络错误'}。`,
      };
    }
    const { text, json } = await readBody(res);
    if (res.status === 401 || res.status === 403) {
      const upstream = upstreamMessage(json, text);
      return {
        ok: false,
        detail: `已连通 Joplin Web Clipper（${base}/ping），但 Token 校验失败：${describeStatus(res.status)}${upstream ? ` 上游返回：${upstream}` : ''}`,
      };
    }
    if (!res.ok) {
      const upstream = upstreamMessage(json, text);
      return {
        ok: false,
        detail: `Joplin 已连通但读取笔记本失败（HTTP ${res.status}）：${upstream || '无响应内容'}`,
      };
    }
    if (json && typeof json === 'object' && json.error) {
      return {
        ok: false,
        detail: `已连通 Joplin Web Clipper（${base}/ping），但 Token 校验失败：${json.error}。请在 工具 → 选项 → Web Clipper 里重新授权。`,
      };
    }
    const items = (json && Array.isArray(json.items) && json.items) || [];
    return {
      ok: true,
      detail: `已连通 Joplin（${base}）：Web Clipper 正常，Token 有效，共 ${items.length} 个笔记本。`,
    };
  },

  async options(config, env) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      return {
        locations: [],
        note: '未配置 Joplin Token：请在 Joplin 工具 → 选项 → Web Clipper 里启用并复制授权 token，填到 config.targets.joplin.token。',
      };
    }
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { locations: [], note: err.message };
    }
    try {
      const res = await fetchFn(`${base}/folders?${tokenQuery(token)}`, {
        method: 'GET',
        signal: signalFor(undefined),
      });
      const { text, json } = await readBody(res);
      if (!res.ok) {
        return {
          locations: [],
          note: `读取 Joplin 笔记本失败（HTTP ${res.status}）：${upstreamMessage(json, text) || '无响应内容'}`,
        };
      }
      const items = (json && json.items) || [];
      const locations = items
        .filter((f) => f && f.id)
        .map((f) => ({ id: String(f.id), label: String(f.title || '(未命名笔记本)') }));
      if (!locations.length) {
        return { locations: [], note: 'Joplin 里还没有笔记本，请先在 Joplin 里新建一个笔记本。' };
      }
      return { locations };
    } catch (err) {
      return {
        locations: [],
        note: `无法连接 Joplin（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`,
      };
    }
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      throw new Error('Joplin 未配置：缺少 Web Clipper Token，请填写 config.targets.joplin.token。');
    }
    const fetchFn = fetchOf(env);
    const title = String((note && note.title) || '') || '未命名笔记';
    const body = String((note && note.markdown) || '');
    if (!body.trim()) {
      throw new Error('没有可保存的内容（markdown 为空）。');
    }
    const size = Buffer.byteLength(body, 'utf8');
    if (size > MAX_BODY_BYTES) {
      throw new Error(
        `Joplin 正文过大（${size} 字节，上限 1 MiB / ${MAX_BODY_BYTES} 字节）：Joplin Web Clipper 在超大正文下会写坏 UTF-8，已中止保存。请缩短内容或改用其他目标。`,
      );
    }
    const payload = { title, body, source: SOURCE };
    const location = str(opts && opts.location) || str(cfg.folder) || str(cfg.notebook) || '';
    if (location) payload.parent_id = location;

    let res;
    try {
      res = await fetchFn(`${base}/notes?${tokenQuery(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signalFor(opts),
      });
    } catch (err) {
      throw new Error(`无法连接 Joplin（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`);
    }
    const { text, json } = await readBody(res);
    if (!res.ok) {
      const upstream = upstreamMessage(json, text);
      throw new Error(`${describeStatus(res.status)}${upstream ? ` 上游返回：${upstream}` : ''}`);
    }
    if (!json || typeof json !== 'object') {
      throw new Error(`Joplin 返回了无法解析的响应（HTTP ${res.status}）：${snippet(text) || '空响应'}`);
    }
    if (json.error) {
      throw new Error(`Joplin 拒绝创建笔记：${json.error}`);
    }
    const id = typeof json.id === 'string' ? json.id : '';
    if (!id) {
      throw new Error('Joplin 创建笔记成功但响应里没有 note id，无法定位新建的笔记。');
    }
    return { ref: id, url: `joplin://x-callback-url/openNote?id=${encodeURIComponent(id)}`, created: true };
  },
};

export default adapter;
