/**
 * SiYuan (思源笔记) adapter.
 *
 * Create semantics (per SPEC.md):
 *   POST {baseUrl}/api/filetree/createDocWithMd
 *   header  Authorization: Token <token>
 *   body    { notebook: <boxId>, path: "/父文档/子文档", markdown }
 *   -> { code: 0, data: "<docId>" } ; code !== 0 is a failure even with HTTP 200.
 *
 * Location list: POST {baseUrl}/api/notebook/lsNotebooks -> { code:0, data:{ notebooks:[{id,name}] } }
 *
 * Zero npm dependencies; all HTTP goes through the injected env.fetch.
 */

import { safeFileName } from '../render.js';

const TIMEOUT_MS = 20_000;
const DEFAULT_BASE_URL = 'http://127.0.0.1:6806';

function cfgOf(config) {
  const target = config && config.targets && config.targets.siyuan;
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
    throw new Error('SiYuan 适配器缺少注入的 env.fetch，无法发起请求。');
  }
  return env.fetch;
}

function snippet(text, max = 240) {
  const flat = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function describeStatus(status) {
  if (status === 401) return 'SiYuan 拒绝了请求：Token 无效或已过期（HTTP 401）。请在思源 设置 → 关于 → API token 里重新复制。';
  if (status === 403) return 'SiYuan 拒绝访问：当前 Token 没有执行该操作的权限（HTTP 403）。';
  if (status === 404) return 'SiYuan 接口不存在（HTTP 404）：请检查 baseUrl 是否指向思源内核，以及版本是否支持 createDocWithMd。';
  if (status === 429) return 'SiYuan 触发速率限制：请求过于频繁（HTTP 429），请稍后再试。';
  if (status >= 500) return `SiYuan 内核出错（HTTP ${status}），请稍后重试。`;
  return `SiYuan 请求失败（HTTP ${status}）。`;
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

/**
 * Last path segment == document title. SiYuan rejects `/` and control chars in
 * `path`, so reuse the shared filename hygiene rather than a local copy.
 */
function pathSegment(rawTitle) {
  return safeFileName(rawTitle, '未命名笔记');
}

const adapter = {
  id: 'siyuan',
  label: 'SiYuan',

  /**
   * Plain array (not a function): the save panel can read the form description
   * without a config object. Keys must stay identical to `config.targets.siyuan`.
   */
  fields: [
    {
      key: 'baseUrl',
      label: 'API 地址',
      type: 'url',
      placeholder: 'http://127.0.0.1:6806（思源内核地址）',
      required: false,
      secret: false,
      help: '思源内核的地址。默认 http://127.0.0.1:6806，只有改过端口或从别的机器访问时才需要改。',
    },
    {
      key: 'token',
      label: 'API 令牌',
      type: 'password',
      placeholder: '在思源里复制 API token',
      required: true,
      secret: true,
      help: '思源 设置 → 关于 → API token 里复制。缺失时无法保存。',
    },
    {
      key: 'notebook',
      label: '笔记本',
      type: 'text',
      placeholder: '笔记本 id（在面板「选位置」里可以看到）',
      required: true,
      secret: false,
      help: '新文档写入哪个笔记本。保存面板的「选位置」下拉里能看到可选笔记本，选中后回到这里填它的 id。',
    },
  ],

  async status(config) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const notebook = str(cfg.notebook || cfg.box);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      return {
        configured: false,
        detail: '未配置 SiYuan Token：请填写 config.targets.siyuan.token（思源 设置 → 关于 → API token）。',
      };
    }
    if (!notebook) {
      return {
        configured: false,
        detail: '未配置 SiYuan 笔记本：请填写 config.targets.siyuan.notebook（思源笔记本 id，可在面板「选位置」里查看）。',
      };
    }
    return { configured: true, detail: `${base} · 笔记本 ${notebook}` };
  },

  /**
   * Read-only connectivity probe: `POST /api/notebook/lsNotebooks` is SiYuan's
   * notebook listing endpoint (read-only despite the POST verb) and is the ONLY
   * POST this adapter is allowed to make here — never createDocWithMd.
   */
  async test(config, env) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const notebook = str(cfg.notebook || cfg.box);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      return {
        ok: false,
        detail: '未配置 SiYuan Token：请填写 config.targets.siyuan.token（思源 设置 → 关于 → API token）。',
      };
    }
    if (!notebook) {
      return {
        ok: false,
        detail: '未配置 SiYuan 笔记本：请填写 config.targets.siyuan.notebook（思源笔记本 id，可在面板「选位置」里查看）。',
      };
    }
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { ok: false, detail: err.message };
    }
    let res;
    try {
      res = await fetchFn(`${base}/api/notebook/lsNotebooks`, {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: signalFor(undefined),
      });
    } catch (err) {
      return {
        ok: false,
        detail: `无法连接 SiYuan（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}。请确认思源已启动且地址正确。`,
      };
    }
    const { text, json } = await readBody(res);
    if (!res.ok) {
      const upstream = snippet(text);
      return {
        ok: false,
        detail: `${describeStatus(res.status)}${upstream ? ` 上游返回：${upstream}` : ''}`,
      };
    }
    if (!json || typeof json !== 'object') {
      return {
        ok: false,
        detail: `SiYuan 返回了无法解析的响应（HTTP ${res.status}）：${snippet(text) || '空响应'}。请确认 baseUrl 指向的是思源内核。`,
      };
    }
    if (json.code !== 0) {
      return {
        ok: false,
        detail: `SiYuan 连通性检测失败：${json.msg || '上游未给出原因'}（code=${json.code}）。`,
      };
    }
    const notebooks = (json.data && json.data.notebooks) || [];
    const ids = notebooks.map((n) => str(n && n.id)).filter(Boolean);
    if (!ids.includes(notebook)) {
      return {
        ok: true,
        detail: `已连通 SiYuan（${base}），但找不到该笔记本：配置的 notebook=${notebook} 不在当前 ${ids.length} 个笔记本里，请重新选择。`,
      };
    }
    return {
      ok: true,
      detail: `已连通 SiYuan（${base}）：共 ${ids.length} 个笔记本，目标笔记本 ${notebook} 可用。`,
    };
  },

  async options(config, env) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    if (!token) {
      return {
        locations: [],
        note: '未配置 SiYuan Token：请填写 config.targets.siyuan.token（思源 设置 → 关于 → API token）。',
      };
    }
    let fetchFn;
    try {
      fetchFn = fetchOf(env);
    } catch (err) {
      return { locations: [], note: err.message };
    }
    try {
      const res = await fetchFn(`${base}/api/notebook/lsNotebooks`, {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal: signalFor(undefined),
      });
      const { text, json } = await readBody(res);
      if (!res.ok) {
        return {
          locations: [],
          note: `读取 SiYuan 笔记本失败（HTTP ${res.status}）：${snippet(text) || '无响应内容'}`,
        };
      }
      if (!json || json.code !== 0) {
        return {
          locations: [],
          note: `读取 SiYuan 笔记本失败：${(json && json.msg) || `code=${json && json.code}`}`,
        };
      }
      const notebooks = (json.data && json.data.notebooks) || [];
      const locations = notebooks
        .filter((n) => n && n.id)
        .map((n) => ({ id: String(n.id), label: String(n.name || n.id) }));
      if (!locations.length) {
        return { locations: [], note: 'SiYuan 里还没有笔记本，请先在思源里新建一个笔记本。' };
      }
      return { locations };
    } catch (err) {
      return {
        locations: [],
        note: `无法连接 SiYuan（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`,
      };
    }
  },

  async write(note, opts, config, env) {
    const cfg = cfgOf(config);
    const token = str(cfg.token);
    const base = resolveBaseUrl(cfg.baseUrl);
    const notebook = str((opts && opts.location) || cfg.notebook || cfg.box);
    if (!token) {
      throw new Error('SiYuan 未配置：缺少 Token，请填写 config.targets.siyuan.token。');
    }
    if (!notebook) {
      throw new Error('SiYuan 未配置：请先在面板里选择一个笔记本（或填写 config.targets.siyuan.notebook）。');
    }
    const fetchFn = fetchOf(env);
    const title = String((note && note.title) || '');
    const markdown = String((note && note.markdown) || '');
    if (!markdown.trim()) {
      throw new Error('没有可保存的内容（markdown 为空）。');
    }
    const body = {
      notebook,
      path: `/${pathSegment(title)}`,
      markdown,
    };
    let res;
    try {
      res = await fetchFn(`${base}/api/filetree/createDocWithMd`, {
        method: 'POST',
        headers: { Authorization: `Token ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signalFor(opts),
      });
    } catch (err) {
      throw new Error(`无法连接 SiYuan（${base}）：${snippet(err && err.message ? err.message : err) || '网络错误'}`);
    }
    const { text, json } = await readBody(res);
    if (!res.ok) {
      const upstream = snippet(text);
      throw new Error(`${describeStatus(res.status)}${upstream ? ` 上游返回：${upstream}` : ''}`);
    }
    if (!json || typeof json !== 'object') {
      throw new Error(`SiYuan 返回了无法解析的响应（HTTP ${res.status}）：${snippet(text) || '空响应'}`);
    }
    if (json.code !== 0) {
      throw new Error(`SiYuan 创建文档失败：${json.msg || '上游未给出原因'}（code=${json.code}）`);
    }
    const docId = typeof json.data === 'string' ? json.data : (json.data && json.data.id) || '';
    if (!docId) {
      throw new Error('SiYuan 创建文档成功但响应里没有文档 id，无法定位新建的文档。');
    }
    return { ref: docId, url: `${base}/?id=${encodeURIComponent(docId)}`, created: true };
  },
};

export default adapter;
