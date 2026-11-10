# dsh-note-save — 内部接口契约（Lead 维护，勿改）

一个 DSH 插件：把对话「保存」为笔记，写进 6 个目标系统之一。
**只做保存/创建，不做笔记编辑。**

## 目录与写作用域（互不重叠）

| 文件 | 归属 | 作用 |
| --- | --- | --- |
| `package.json` `cordis.patch.yml` `index.js` `lib/render.js` `lib/config.js` `lib/adapters/obsidian.js` `lib/adapters/index.js` `SPEC.md` | **lead** | 插件主行、Markdown 渲染、配置、Obsidian 适配器、适配器注册表 |
| `lib/adapters/siyuan.js` `lib/adapters/joplin.js` `lib/adapters/notion.js` `lib/adapters/yuque.js` `tests/adapters.test.mjs` | **host-adapters** | 四个 HTTP 目标适配器 + 自测 |
| `client.js` `locale/en.json` `locale/zh.json` `icon.svg` | **panel-ui** | 浏览器半边：操作按钮 + 保存面板 |

## 环境事实（已验证）

- 插件目录：`D:\DemandOS\dsh-note-save`（工作区内，可自由写）。
- 装进本机 profile 的唯一方式是 `plugin_manager` `install_bundle`（Lead 执行），**不要**自己写 `~/.dsh/profiles/desktop/**`。
- 本机有 Obsidian vault：`D:\文档\obsidian\workspace`（`%APPDATA%\obsidian\obsidian.json` 可读）。
- 本机 **没有**运行 SiYuan(6806) / Joplin(41184)，也没有 Notion / 语雀 token → 这四个只能做「按文档实现的模块 + 本地 mock 自测」，不能声称真机验证过。
- node v24。插件是 ESM（`"type": "module"`），host 半边**只能**用 node 内置模块 + 相对路径 import，不能依赖任何 npm 包。

## Host 半边：给浏览器半边的 HTTP API

所有路由挂在 **prefix `/note-save`** 下，由 `index.js` 用
`ctx.webServer.register({ kind:'prefix', path:'/note-save', handler })` 注册，
每个请求先过 `ctx.connection.requestRejection(req) === undefined` 这道浏览器信任闸
（与 `dsh-better-sidebar` / `dsh-univer-office` 完全一致的写法）。请求体 JSON，响应 JSON。

统一错误体：`{ ok:false, error:{ code, message } }`，HTTP 状态 400/403/500。

### `GET /note-save/state`
```json
{ "ok": true, "value": {
  "version": "0.1.0",
  "targets": [
    { "id":"obsidian", "label":"Obsidian", "configured":true,  "detail":"D:\\文档\\obsidian\\workspace" },
    { "id":"siyuan",   "label":"SiYuan",   "configured":false, "detail":"未配置 Token" }
  ],
  "defaultTarget": "obsidian"
} }
```

### `GET /note-save/targets/:id/options`
目标系统的可写位置列表（面板的「选位置」下拉）。
```json
{ "ok": true, "value": { "locations": [ { "id":"workspace", "label":"workspace" } ], "note":"可选说明" } }
```
未配置时 `locations: []` 且 `note` 说明缺什么。

### `POST /note-save/preview`
请求 `{ "scope":"message"|"turn"|"session", "sessionId":"...", "messageId":"...", "includeReasoning":false }`
→ `{ "ok":true, "value":{ "title":"…", "markdown":"…", "stats":{ "messages":3, "chars":1234 } } }`

### `POST /note-save/save`
请求 `{ "target":"obsidian", "scope":"message", "sessionId":"…", "messageId":"…", "includeReasoning":false, "title":"…", "location":"…" }`
→ `{ "ok":true, "value":{ "target":"obsidian", "title":"…", "ref":"D:\\…\\x.md", "url":null, "created":true } }`

### `GET /note-save/schema`
设置页靠它渲染，**新增目标不需要改客户端**。
```json
{ "ok": true, "value": { "targets": [ { "id":"obsidian", "label":"Obsidian",
  "fields": [ { "key":"vault", "label":"仓库（vault）", "type":"text", "placeholder":"…",
                "required":true, "secret":false, "help":"…" } ] } ] } }
```

### `GET /note-save/config`
当前设置，**秘密字段永不回传**：`token` 回来是空字符串 + `tokenSet:true`。
```json
{ "ok": true, "value": { "values": { "siyuan": { "baseUrl":"http://127.0.0.1:6806", "token":"", "tokenSet":true } },
  "configPath":"C:\\Users\\…\\.dsh\\note-save.json", "defaultTarget":"obsidian" } }
```

### `POST /note-save/config/save`
请求 `{ "target":"siyuan", "values":{ "baseUrl":"…", "token":"" } }`
→ 与 `GET /config` 同形状。
空白的秘密字段 = 「保持不变」，不是「清空」；要清空传 `clear_token:true`。

### `POST /note-save/test`
请求 `{ "target":"notion", "values":{ …未保存的值，可省略… } }`
→ `{ "ok":true, "value":{ "ok":true, "detail":"已连通：…" } }`
用未保存的值探测，所以用户可以先「检测」再「保存」。

### `GET /note-save/obsidian/vaults`
→ `{ "ok":true, "value":{ "vaults":[ { "id":"…", "path":"D:\\…\\workspace", "name":"workspace", "open":true } ] } }`

### `GET /note-save/obsidian/folders?vault=<绝对路径>&path=<相对子路径>`
→ `{ "ok":true, "value":{ "path":"DSH/2026", "folders":[ { "name":"sub", "path":"DSH/2026/sub" } ] } }`
越出 vault 的路径直接报错。

## 适配器契约（所有 adapter 模块必须满足）

`lib/adapters/<id>.js` 默认导出一个对象：

```js
export default {
  id: 'siyuan',
  label: 'SiYuan',            // 英文名，UI 用 locale 覆盖
  /** 设置页的字段描述；纯数据，不需要 config 就能读。 */
  fields: [
    { key: 'token', label: 'API 令牌', type: 'password', placeholder: '…', required: true, secret: true, help: '思源 设置 → 关于 → API token' },
  ],
  /** 是否已配置好（token/端口/路径齐全）。同步 or async 都可以。 */
  async status(config, env) -> { configured: boolean, detail: string },
  /** 可选位置列表。 */
  async options(config, env) -> { locations: [{ id, label }], note?: string },
  /** 只读连通性探测，绝不写数据。 */
  async test(config, env) -> { ok: boolean, detail: string },
  /**
   * 写入一条笔记。
   * @param {{ title:string, markdown:string }} note
   * @param {{ location?:string, signal?:AbortSignal }} opts
   * @returns {Promise<{ ref:string, url?:string|null, created:boolean }>}
   * 失败必须 throw Error，message 是给人看的中文/英文原因。
   */
  async write(note, opts, config, env) -> { ref, url, created },
}
```

- `fields`：`key` 必须与 `config.targets.<id>` 里真正读的键一致；`type` ∈ `text|password|url`；`secret:true` 只给真正的秘密；可选 `pick:'directory'` 表示这是个文件夹路径，设置页会在输入框旁给一个「浏览…」按钮（调用 Host 原生目录选择器），输入框本身永远可自由输入。设置页靠它渲染，所以新增目标**不需要改客户端**。
- `test()`：只读探测，不能 POST 到写端点（思源的 `lsNotebooks` 是只读的，允许）。未配置必需字段时直接返回 `ok:false` 且**不发请求**。
- `config`：**整份插件配置**，不是某目标的切片。adapter 自己读 `config.targets.<自己的 id>`。
  （一开始写成传切片，结果四个 adapter 全读不到设置、永远显示「未配置」——`tests-lead/contract.test.mjs` 里有一条专门防它复发的回归测试。）
- `env`：`{ fetch, logger }`，由 `lib/adapters/index.js` 的 `makeEnv()` 注入。**adapter 不要自己 import node:fs 之外的全局**；需要 `homedir()` 就自己从 `node:os` 取（Obsidian 适配器就是这么做的）。
- 网络请求一律用 `env.fetch`（就是全局 fetch 的引用，便于自测时替换）。
- 所有 adapter 必须能被纯 node 直接 import 自测：不依赖 DSH 运行时。
- 文件名/时间戳复用 `lib/render.js` 的 `safeFileName` / `stamp`，不要各写一份。

## 测试怎么跑（重要）

本机 DSH 沙箱禁止子进程，`node --test` 会以 `spawn EPERM` 失败。用直接执行：

```
node tests-lead/all.test.mjs     # 全部 6 个套件，单进程，144 条
node tests/adapters.test.mjs     # 只跑四个 HTTP 适配器
```

## 各目标的「创建文件」语义（必须照此实现）

### Obsidian（lead 实现，已可跑）
vault 是一个文件夹 → 直接写 `.md`。文件名清洗 Windows 保留名；带 frontmatter。

### SiYuan
`POST {baseUrl}/api/filetree/createDocWithMd`，header `Authorization: Token <token>`，
body `{ notebook: <boxId>, path: "/父文档/子文档", markdown }`。
- 原生接收 Markdown，公式/mermaid 由思源自己转换。
- `path` 以 `/` 开头，末段即文档标题；父文档不存在会自动建。
- 成功响应 `{ code: 0, data: "<docId>" }`，`code !== 0` 视为失败并抛 `msg`。
- 位置列表用 `POST /api/notebook/lsNotebooks`（`{code:0,data:{notebooks:[{id,name}]}}`）。

### Joplin
开 Web Clipper 后：`POST {baseUrl}/notes?token={token}`，body `{ title, body, source }`；
`parent_id`（笔记本）可选，有就带上。
- 位置列表 `GET {baseUrl}/folders?token={token}` → `{ items:[{id,title}] }`。
- token 是**查询参数**，不是 header。
- 已知坑：Joplin 3.7.x 超大正文会写坏 UTF-8 —— 正文超过 1 MiB 时抛错提示用户。
- baseUrl 默认 `http://127.0.0.1:41184`。

### Notion
必须挂在 Database 下（不能建独立页）。
1. `markdownToBlocks(markdown)`：自己实现一个够用的 Markdown → Notion blocks 转换（标题/段落/列表/代码块/引用/分割线/表格可降级为段落代码块）。
2. `POST https://api.notion.com/v1/pages`，
   `{ parent:{database_id}, properties:{ <titleProp>: { title:[{ text:{content:title} }] } }, children: blocks.slice(0,100) }`
3. 剩余块 `PATCH /v1/blocks/{pageId}/children`，`{ children }`，**每次最多 100 块**分批。
- header：`Authorization: Bearer <token>`、`Notion-Version: 2022-06-28`、`content-type: application/json`。
- 标题属性名可配置（默认 `Name`），标题长度硬截断 32 字符。
- 位置列表：`POST /v1/search`，`{ filter:{value:'database',property:'object'}, page_size:100 }` → 取 `results[].id/title`。若返回不了（Integration 未授权），返回 `locations: []` + `note` 让用户手填 database id。

### 语雀
两步都做完才算成功：
1. `POST https://www.yuque.com/api/v2/repos/{repoId}/docs`
   `{ title, slug: String(Date.now()), format:'markdown', body: markdown }`
   header `X-Auth-Token: <token>`、`content-type: application/json`。
2. `PUT https://www.yuque.com/api/v2/repos/{repoId}/toc`
   `{ action:'appendNode', action_mode:'append', doc_ids:[docId] }` —— **不做这步文档不在目录里，等于看不见。**
- 返回 `{ data:{ id, slug, title } }`；`url` 拼 `https://www.yuque.com/{login}/{repoSlug}/{slug}`（login/repoSlug 从 config 取，缺就返回 null）。
- 位置列表：`GET /api/v2/repos/{repoId}/toc`，或直接返回配置里的那个知识库 `[{id: repoId, label: repoId}]`（`config.targets.yuque` 没有 `repoName` 键，label 回落到 repoId）。
- 语雀 Token 是超级会员权益 + 每小时 5000 次配额；429 要转成人话错误。

### ima（官方 OpenAPI）
**已修正**：早期版本以为 ima 没有写入接口，只做「投递 .md 文件」。这是错的 —— ima 有官方 OpenAPI。

接口来自腾讯自己的 `TencentCloud/Octop` 连接器（`infra/connectors/gateway/adapters/tencent_ima.py`），并已实测路由存在：

- base `https://ima.qq.com/`；鉴权 header `ima-openapi-clientid` + `ima-openapi-apikey`（凭据在 https://ima.qq.com/agent-interface 获取）。
- 建笔记：`POST openapi/note/v1/import_doc`，body `{ content_format: 1, content: "<Markdown>", folder_id? }`（`content_format:1` = Markdown）。
- 追加：`POST openapi/note/v1/append_doc`，body `{ note_id, content_format:1, content }`。
- 列笔记本：`POST openapi/note/v1/list_notebook`，body `{ cursor: '0', limit: 1..20 }`。
- 验凭据（只读）：`POST openapi/wiki/v1/search_knowledge_base`，body `{ query:'', cursor:'', limit:1 }`。
- 响应信封 `{ code, msg, data, request_id }`，`code === 0` 才算成功 —— **HTTP 200 也可能是失败**。
- 无凭据实测：`HTTP 401 {"code":200002,"msg":"clientID or apiKey is empty"}`；假凭据 → `"skill auth failed"`（证明 header 名正确）。

实现要点：
- `import_doc` 不收标题，标题作为 `# 标题` 拼在正文开头；正文已以 `# ` 开头则不重复加。
- `ref` = 返回的 `note_id`，`url` 拼 `https://ima.qq.com/note/<id>`。
- `options()` 列笔记本失败时降级成「默认位置」，不能因为列不出位置就不让保存。
- 没有 delete / 整体替换 / 移动接口，所以只做 create（与插件定位一致）。

## 渲染契约（lead 实现，所有人依赖其输出）

`lib/render.js` 导出 `renderNote({ messages, scope, title })` → markdown 字符串：
- 每条消息：`### 👤 用户` / `### 🤖 助手` 分节；工具输出与 tool-call 默认**不进正文**（可关）。
- 保留代码块、表格、引用、公式原文（不解析），供各目标自行渲染。
- 不含 frontmatter（frontmatter 由各 adapter 按目标需要加）。
