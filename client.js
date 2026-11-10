/**
 * dsh-note-save — browser half.
 *
 * Two surfaces, one bundle:
 *   1. an icon-only action in the assistant message action row, which opens a
 *      save dialog (scope / target / location / rendered preview);
 *   2. a Settings → 笔记保存 page that configures every target (fields come from
 *      the host's /schema, so a new target needs no change here).
 *
 * Plain classic script: no JSX, no module keywords. `require` resolves only the
 * page's fixed seed table, so only `react` and `react-dom` are requested.
 */

window.__ModuleLoader__.load({
  id: 'dsh-note-save',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    var React = require('react')
    var ReactDOM = null
    try {
      ReactDOM = require('react-dom')
    } catch (reactDomMissing) {
      ReactDOM = null
    }

    var NS = 'dsh-note-save'
    var SLOT = 'conversation.chat.assistant-actions'
    var SETTINGS_SLOT = 'settings.section'
    var ENTRY_ID = 'note-save'
    var ENTRY_ORDER = 30
    var SETTINGS_ORDER = 60
    var ROUTE = 'note-save/'
    var PREVIEW_DEBOUNCE_MS = 250
    var NOTICE_MS = 2600

    /* ------------------------------------------------------------------ copy */

    var zh = {
      'meta.title': '笔记保存',
      'meta.description':
        '把对话、本轮或单条消息一键保存为 Obsidian / 思源 / Joplin / Notion / 语雀 笔记，或直接写入 ima 笔记。',
      'action.save': '保存为笔记',
      'action.saveHint': '把这条消息保存为笔记',
      'action.busy': '正在保存上一份笔记，请稍候…',
      'panel.title': '保存为笔记',
      'panel.titleLabel': '标题',
      'panel.titlePlaceholder': '笔记标题',
      'panel.scopeLabel': '范围',
      'panel.scope.message': '单条消息',
      'panel.scope.turn': '本轮',
      'panel.scope.session': '整个会话',
      'panel.targetLabel': '保存到',
      'panel.targetUnconfigured': '未配置',
      'panel.locationLabel': '位置',
      'panel.locationLoading': '正在加载位置…',
      'panel.locationNone': '该目标没有可选位置',
      'panel.locationDefault': '（默认位置）',
      'panel.vaultLabel': '仓库',
      'panel.vaultLoading': '正在读取 Obsidian 仓库…',
      'panel.vaultNone': '没有找到 Obsidian 仓库，请先在 Obsidian 里打开一个 vault',
      'panel.folderLabel': '文件夹',
      'panel.folderRoot': '（仓库根目录）',
      'panel.folderCustom': '子文件夹路径',
      'panel.folderPlaceholder': '例如 DSH 或 DSH/2026',
      'panel.includeReasoning': '包含思考过程',
      'panel.previewLabel': '预览',
      'panel.previewRendered': '渲染效果',
      'panel.previewSource': 'Markdown 源码',
      'panel.loading': '正在读取保存配置…',
      'panel.previewLoading': '正在生成预览…',
      'panel.previewEmpty': '还没有预览内容',
      'panel.chars': '字符',
      'panel.messages': '条消息',
      'panel.cancel': '取消',
      'panel.save': '保存',
      'panel.saving': '保存中…',
      'panel.close': '关闭',
      'panel.saved': '已保存',
      'panel.refLabel': '位置',
      'panel.urlLabel': '链接',
      'panel.loadError': '无法读取保存配置',
      'panel.previewError': '预览生成失败',
      'panel.saveError': '保存失败',
      'panel.missingContext': '缺少会话信息，暂时无法保存',
      'settings.title': '笔记保存',
      'settings.description':
        '配置每个笔记目标的地址与令牌。保存时在消息下方的图标里选择目标即可。',
      'settings.configPath': '配置文件',
      'settings.test': '检测',
      'settings.testing': '检测中…',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.saved': '已保存',
      'settings.loading': '正在读取配置…',
      'settings.loadError': '无法读取配置',
      'settings.staleBackend':
        '插件后端还是旧版本（新接口未加载）。重启 DSH 后这个页面就能用；前端已经是最新的，所以页面本身会先出现。',
      'settings.retry': '重试',
      'settings.guide': '操作指引',
      'settings.browse': '浏览…',
      'settings.pickFromList': '从列表选择',
      'settings.locationLoading': '正在读取…',
      'settings.locationNone': '没有可选项',
      'settings.saveError': '保存失败',
      'settings.nothing': '没有可保存的修改',
      'settings.secretSet': '已保存（留空表示不修改）',
      'settings.secretUnset': '未设置',
      'settings.clear': '清除',
      'settings.clearHint': '勾选后保存将清除该项',
      'settings.statusOk': '已配置',
      'settings.statusNo': '未配置',
      'settings.fieldsMissing': '该目标暂时没有可配置项',
    }

    var en = {
      'meta.title': 'Note save',
      'meta.description':
        'Save a conversation, a turn or one message as a note in Obsidian, SiYuan, Joplin, Notion or Yuque, or create an ima note.',
      'action.save': 'Save as note',
      'action.saveHint': 'Save this message as a note',
      'action.busy': 'A save is already running. Please wait…',
      'panel.title': 'Save as note',
      'panel.titleLabel': 'Title',
      'panel.titlePlaceholder': 'Note title',
      'panel.scopeLabel': 'Scope',
      'panel.scope.message': 'This message',
      'panel.scope.turn': 'This turn',
      'panel.scope.session': 'Whole session',
      'panel.targetLabel': 'Save to',
      'panel.targetUnconfigured': 'Not configured',
      'panel.locationLabel': 'Location',
      'panel.locationLoading': 'Loading locations…',
      'panel.locationNone': 'This target has no locations',
      'panel.locationDefault': '(default location)',
      'panel.vaultLabel': 'Vault',
      'panel.vaultLoading': 'Reading Obsidian vaults…',
      'panel.vaultNone': 'No Obsidian vault found; open a vault in Obsidian first',
      'panel.folderLabel': 'Folder',
      'panel.folderRoot': '(vault root)',
      'panel.folderCustom': 'Folder path',
      'panel.folderPlaceholder': 'e.g. DSH or DSH/2026',
      'panel.includeReasoning': 'Include reasoning',
      'panel.previewLabel': 'Preview',
      'panel.previewRendered': 'Rendered',
      'panel.previewSource': 'Markdown source',
      'panel.loading': 'Reading save settings…',
      'panel.previewLoading': 'Building the preview…',
      'panel.previewEmpty': 'No preview yet',
      'panel.chars': 'chars',
      'panel.messages': 'messages',
      'panel.cancel': 'Cancel',
      'panel.save': 'Save',
      'panel.saving': 'Saving…',
      'panel.close': 'Close',
      'panel.saved': 'Saved',
      'panel.refLabel': 'Location',
      'panel.urlLabel': 'Link',
      'panel.loadError': 'Could not read the save settings',
      'panel.previewError': 'Could not build the preview',
      'panel.saveError': 'Save failed',
      'panel.missingContext': 'Session context is missing; saving is unavailable',
      'settings.title': 'Note save',
      'settings.description':
        'Configure the address and token of each note target, then use the icon under a message to save.',
      'settings.configPath': 'Config file',
      'settings.test': 'Test',
      'settings.testing': 'Testing…',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.saved': 'Saved',
      'settings.loading': 'Reading configuration…',
      'settings.loadError': 'Could not read the configuration',
      'settings.staleBackend':
        'The plugin backend is still the old version (the new endpoints are not loaded). Restart DSH and this page will work; the frontend is already current, which is why the page shows up first.',
      'settings.retry': 'Retry',
      'settings.guide': 'Guide',
      'settings.browse': 'Browse…',
      'settings.pickFromList': 'Pick from list',
      'settings.locationLoading': 'Loading…',
      'settings.locationNone': 'Nothing to pick',
      'settings.saveError': 'Save failed',
      'settings.nothing': 'Nothing to save',
      'settings.secretSet': 'Saved (leave blank to keep)',
      'settings.secretUnset': 'Not set',
      'settings.clear': 'Clear',
      'settings.clearHint': 'Check to remove this value on save',
      'settings.statusOk': 'Configured',
      'settings.statusNo': 'Not configured',
      'settings.fieldsMissing': 'This target has no configurable fields yet',
    }

    /* ------------------------------------------------------------------- css */

    var CSS = [
      /* action: icon only, sized like the shipped row actions */
      '.ns-root{display:inline-flex;align-items:center;gap:6px;min-width:0;position:relative}',
      '.ns-action{align-items:center;background:none;border:0;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;height:28px;justify-content:center;padding:0;width:28px}',
      '.ns-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ns-action:active:not(:disabled){color:var(--dsw-alias-brand-primary)}',
      '.ns-action:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed;opacity:.45}',
      '.ns-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.ns-actionGlyph{display:inline-flex;line-height:0}',
      '.ns-notice{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-secondary);font-size:12px;left:0;padding:3px 8px;position:absolute;top:calc(100% + 6px);white-space:nowrap;z-index:60}',
      /* dialog */
      '.ns-backdrop{align-items:center;background:var(--dsw-alias-bg-mask-1,var(--dsw-alias-bg-mask-2));display:flex;inset:0;justify-content:center;position:fixed;z-index:1000}',
      '.ns-card{background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;box-shadow:0 12px 40px var(--dsw-alias-bg-mask-2);display:flex;flex-direction:column;max-height:86vh;max-width:720px;overflow:hidden;width:min(92vw,720px)}',
      '.ns-head{align-items:center;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;padding:12px 16px}',
      '.ns-headGlyph{color:var(--dsw-alias-brand-primary);display:inline-flex}',
      '.ns-headTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;margin:0}',
      '.ns-iconBtn{background:none;border:0;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;height:26px;line-height:1;margin-left:auto;padding:0 7px}',
      '.ns-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ns-body{display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding:14px 16px}',
      '.ns-field{display:flex;flex-direction:column;gap:5px}',
      '.ns-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}',
      '.ns-input,.ns-select{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:6px 9px;width:100%}',
      '.ns-inputRow{align-items:center;display:flex;gap:8px}',
      '.ns-btnPick{flex:0 0 auto;white-space:nowrap}',
      '.ns-input:focus,.ns-select:focus{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.ns-row{display:flex;gap:10px}',
      '.ns-row>*{flex:1;min-width:0}',
      '.ns-seg{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;display:inline-flex;padding:2px}',
      '.ns-segBtn{background:none;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;font-size:12px;padding:4px 10px}',
      '.ns-segBtn[data-on="true"]{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}',
      '.ns-check{align-items:center;color:var(--dsw-alias-label-secondary);display:inline-flex;font-size:12px;gap:6px}',
      '.ns-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}',
      '.ns-previewHead{align-items:center;display:flex;gap:8px}',
      '.ns-previewBox{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;max-height:300px;overflow:auto;padding:12px 14px}',
      '.ns-mdP{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.65;margin:0 0 8px}',
      '.ns-mdH{color:var(--dsw-alias-label-primary);font-weight:600;line-height:1.4;margin:12px 0 6px}',
      '.ns-mdH:first-child{margin-top:0}',
      '.ns-mdList{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;margin:0 0 8px;padding-left:20px}',
      '.ns-mdQuote{border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;margin:0 0 8px;padding:2px 0 2px 10px}',
      '.ns-mdPre{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;margin:0 0 8px;overflow-x:auto;padding:9px 11px}',
      '.ns-mdPre code{color:var(--dsw-alias-label-primary);font-family:var(--dsh-mono-font,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.55;white-space:pre}',
      '.ns-mdInlineCode{background:var(--dsw-alias-bg-layer-2);border-radius:4px;font-family:var(--dsh-mono-font,ui-monospace,monospace);font-size:12px;padding:1px 4px}',
      '.ns-mdHr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}',
      '.ns-mdTable{border-collapse:collapse;font-size:12px;margin:0 0 8px;width:100%}',
      '.ns-mdTable th,.ns-mdTable td{border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);padding:4px 7px;text-align:left}',
      '.ns-mdTable th{background:var(--dsw-alias-menu-group-header-fill);font-weight:600}',
      '.ns-mdLink{color:var(--dsw-alias-brand-primary);text-decoration:underline}',
      '.ns-source{color:var(--dsw-alias-label-secondary);font-family:var(--dsh-mono-font,ui-monospace,monospace);font-size:11.5px;line-height:1.6;margin:0;white-space:pre-wrap;word-break:break-word}',
      '.ns-meta{color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.ns-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:10px 0;text-align:center}',
      '.ns-errorLine{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-state-error-primary);border-radius:7px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.5;padding:7px 9px;word-break:break-word}',
      '.ns-foot{align-items:center;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;justify-content:flex-end;padding:11px 16px}',
      '.ns-btn{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:13px;padding:6px 14px}',
      '.ns-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.ns-btn:disabled{cursor:not-allowed;opacity:.5}',
      '.ns-btnPrim{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}',
      '.ns-btnPrim:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.ns-success{align-items:center;display:flex;flex-direction:column;gap:8px;padding:22px 16px;text-align:center}',
      '.ns-successTitle{color:var(--dsw-alias-state-success-primary);font-size:13px;font-weight:600}',
      '.ns-kv{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;max-width:100%;word-break:break-all}',
      '.ns-kvKey{color:var(--dsw-alias-label-tertiary);margin-right:6px}',
      '.ns-ref{color:var(--dsw-alias-label-primary);font-family:var(--dsh-mono-font,ui-monospace,monospace);font-size:11.5px}',
      '.ns-link{color:var(--dsw-alias-brand-primary);font-size:12px;text-decoration:underline}',
      /* settings page */
      '.ns-page{display:flex;flex-direction:column;gap:12px;padding:4px 2px 24px}',
      '.ns-pageDesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;margin:0}',
      /* top tab strip + one pane underneath.
         No vertical scrollbar: the strip is one row tall, so it must only ever
         scroll horizontally. The active underline is an inset box-shadow rather
         than a border with a negative margin — that trick is what pushed the
         strip 1px past its box and produced a stray vertical scrollbar. */
      '.ns-tabs{border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:2px;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin}',
      '.ns-tab{align-items:center;background:none;border:0;box-shadow:none;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;flex:0 0 auto;font:inherit;font-size:13px;gap:6px;padding:8px 12px;white-space:nowrap}',
      '.ns-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.ns-tab[data-active="true"]{box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.ns-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.ns-tabDot{background:var(--dsw-alias-border-l2);border-radius:999px;flex:0 0 auto;height:6px;width:6px}',
      '.ns-tabDotOn{background:var(--dsw-alias-state-success-primary)}',
      '.ns-pageFoot{align-items:center;color:var(--dsw-alias-label-tertiary);display:flex;flex-wrap:wrap;font-size:10.5px;gap:10px;line-height:1.5;margin:0;word-break:break-all}',
      '.ns-guideLink{color:var(--dsw-alias-brand-primary);flex:0 0 auto;font-size:12px;margin-left:auto;text-decoration:none}',
      '.ns-guideLink:hover{text-decoration:underline}',
      '.ns-pane{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l1);border-radius:10px;display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px 16px}',
      '.ns-cardS{background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));border:1px solid var(--dsw-alias-border-l1);border-radius:10px;display:flex;flex-direction:column;gap:12px;padding:14px 16px}',
      '.ns-cardHead{align-items:center;display:flex;gap:8px}',
      '.ns-cardTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;margin:0}',
      '.ns-badge{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;padding:1px 8px}',
      '.ns-badgeOk{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.ns-badgeNo{color:var(--dsw-alias-label-tertiary)}',
      '.ns-cardFoot{align-items:center;display:flex;gap:8px;justify-content:flex-end}',
      '.ns-statusLine{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;margin-right:auto;word-break:break-word}',
      '.ns-statusOk{color:var(--dsw-alias-state-success-primary)}',
      '.ns-statusErr{color:var(--dsw-alias-state-error-primary)}',
      '.ns-secretRow{align-items:center;display:flex;gap:8px}',
      '@media (prefers-reduced-motion:reduce){.ns-action,.ns-btn,.ns-segBtn,.ns-iconBtn{transition:none}}',
    ].join('')

    function installStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return function () {}
        var existing = document.querySelector('style[data-plugin="dsh-note-save"]')
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing)
        var tag = document.createElement('style')
        tag.setAttribute('data-plugin', 'dsh-note-save')
        tag.textContent = CSS
        document.head.appendChild(tag)
        return function () {
          if (tag.parentNode) tag.parentNode.removeChild(tag)
        }
      } catch (styleError) {
        return function () {}
      }
    }

    /* ------------------------------------------------------------- transport */

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      if (typeof error === 'string' && error !== '') return error
      return 'request failed'
    }

    function baseUrl() {
      try {
        if (typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== '') {
          return document.baseURI
        }
      } catch (baseError) {
        /* fall through */
      }
      try {
        if (typeof window !== 'undefined' && window.location && window.location.href) return window.location.href
      } catch (hrefError) {
        /* fall through */
      }
      return ''
    }

    function routeUrl(path) {
      var relative = ROUTE + path
      try {
        return new URL(relative, baseUrl()).toString()
      } catch (urlError) {
        return relative
      }
    }

    function request(target, init) {
      return new Promise(function (resolve, reject) {
        if (typeof fetch !== 'function') {
          reject(new Error('fetch is unavailable in this page'))
          return
        }
        var pending
        try {
          pending = fetch(target, init)
        } catch (thrown) {
          reject(new Error(messageOf(thrown)))
          return
        }
        Promise.resolve(pending)
          .then(function (response) {
            return response
              .json()
              .then(function (parsed) {
                return { ok: response.ok, status: response.status, parsed: parsed }
              })
              .catch(function () {
                return { ok: response.ok, status: response.status, parsed: null }
              })
          })
          .then(function (result) {
            var parsed = result.parsed
            if (parsed && typeof parsed === 'object' && parsed.ok === true) {
              resolve(parsed.value === undefined ? {} : parsed.value)
              return
            }
            if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.message === 'string') {
              reject(new Error(parsed.error.message))
              return
            }
            reject(new Error('request failed (HTTP ' + String(result.status) + ')'))
          })
          .catch(reject)
      })
    }

    function getJSON(path) {
      return request(routeUrl(path), { method: 'GET', headers: { accept: 'application/json' } })
    }

    function postJSON(path, body) {
      return request(routeUrl(path), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
    }

    /* --------------------------------------------------------------- helpers */

    function asString(value) {
      return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
    }

    function recordOf(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function isConfigured(entry) {
      return recordOf(entry).configured === true
    }

    /* ---------------------------------------------------------- markdown view */

    var HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

    function escapeHtml(text) {
      return asString(text).replace(/[&<>"']/g, function (ch) {
        return HTML_ESCAPES[ch]
      })
    }

    /**
     * Inline formatting on ALREADY-ESCAPED text. Every replacement introduces
     * only tags from this fixed set, so the result is safe to inject: no input
     * byte can become a tag.
     */
    function inlineFormat(escaped) {
      return escaped
        .replace(/`([^`\n]+)`/g, '<code class="ns-mdInlineCode">$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
        .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
        .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a class="ns-mdLink" href="$2" target="_blank" rel="noreferrer noopener">$1</a>')
    }

    /**
     * Markdown → HTML for the preview pane.
     *
     * Deliberately small: the preview exists to show what the note will look
     * like, so it covers the constructs the renderer emits (headings, lists,
     * code fences, quotes, rules, tables, emphasis). Anything else stays
     * visible as escaped text rather than disappearing.
     */
    function renderMarkdown(markdown) {
      var lines = asString(markdown).replace(/\r\n?/g, '\n').split('\n')
      var out = []
      var listType = null
      var i = 0

      function closeList() {
        if (listType !== null) {
          out.push('</' + listType + '>')
          listType = null
        }
      }

      function isBlockStart(line) {
        return (
          /^\s*$/.test(line) ||
          /^\s*```/.test(line) ||
          /^#{1,6}\s/.test(line) ||
          /^\s*[-*+]\s+/.test(line) ||
          /^\s*\d+[.)]\s+/.test(line) ||
          /^\s*>/.test(line) ||
          /^\s*\|/.test(line) ||
          /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
        )
      }

      while (i < lines.length) {
        var line = lines[i]

        var fence = /^\s*```([^\s`]*)\s*$/.exec(line)
        if (fence !== null) {
          closeList()
          var language = fence[1] || ''
          var body = []
          i += 1
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
            body.push(lines[i])
            i += 1
          }
          i += 1
          out.push(
            '<pre class="ns-mdPre"><code' +
              (language === '' ? '' : ' data-lang="' + escapeHtml(language) + '"') +
              '>' +
              escapeHtml(body.join('\n')) +
              '</code></pre>',
          )
          continue
        }

        if (/^\s*$/.test(line)) {
          closeList()
          i += 1
          continue
        }

        var heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading !== null) {
          closeList()
          // Offset by 2 so a note's `#` nests under the dialog title.
          var level = Math.min(heading[1].length + 2, 6)
          out.push(
            '<h' + level + ' class="ns-mdH">' + inlineFormat(escapeHtml(heading[2])) + '</h' + level + '>',
          )
          i += 1
          continue
        }

        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          closeList()
          out.push('<hr class="ns-mdHr"/>')
          i += 1
          continue
        }

        if (/^\s*>/.test(line)) {
          closeList()
          var quoted = []
          while (i < lines.length && /^\s*>/.test(lines[i])) {
            quoted.push(lines[i].replace(/^\s*>\s?/, ''))
            i += 1
          }
          out.push(
            '<blockquote class="ns-mdQuote">' +
              inlineFormat(escapeHtml(quoted.join('\n'))).replace(/\n/g, '<br/>') +
              '</blockquote>',
          )
          continue
        }

        var bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
        var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (bullet !== null || ordered !== null) {
          var want = bullet !== null ? 'ul' : 'ol'
          if (listType !== want) {
            closeList()
            out.push('<' + want + ' class="ns-mdList">')
            listType = want
          }
          out.push('<li>' + inlineFormat(escapeHtml((bullet || ordered)[1])) + '</li>')
          i += 1
          continue
        }

        if (/^\s*\|/.test(line)) {
          closeList()
          var rows = []
          while (i < lines.length && /^\s*\|/.test(lines[i])) {
            rows.push(lines[i])
            i += 1
          }
          var cells = rows.map(function (row) {
            return row
              .trim()
              .replace(/^\|/, '')
              .replace(/\|$/, '')
              .split('|')
              .map(function (cell) {
                return cell.trim()
              })
          })
          var data = cells.filter(function (row) {
            return !row.every(function (cell) {
              return /^:?-{2,}:?$/.test(cell)
            })
          })
          if (data.length > 0) {
            var head = data[0]
            var rest = data.slice(1)
            out.push(
              '<table class="ns-mdTable"><thead><tr>' +
                head
                  .map(function (cell) {
                    return '<th>' + inlineFormat(escapeHtml(cell)) + '</th>'
                  })
                  .join('') +
                '</tr></thead><tbody>' +
                rest
                  .map(function (row) {
                    return (
                      '<tr>' +
                      row
                        .map(function (cell) {
                          return '<td>' + inlineFormat(escapeHtml(cell)) + '</td>'
                        })
                        .join('') +
                      '</tr>'
                    )
                  })
                  .join('') +
                '</tbody></table>',
            )
          }
          continue
        }

        closeList()
        var paragraph = []
        while (i < lines.length && !isBlockStart(lines[i])) {
          paragraph.push(lines[i])
          i += 1
        }
        if (paragraph.length === 0) {
          // A line that opened a block but matched nothing: keep it visible.
          paragraph.push(lines[i])
          i += 1
        }
        out.push(
          '<p class="ns-mdP">' + inlineFormat(escapeHtml(paragraph.join('\n'))).replace(/\n/g, '<br/>') + '</p>',
        )
      }

      closeList()
      return out.join('')
    }

    /* ---------------------------------------------------------------- glyphs */

    /**
     * Icon-only action glyph: one note sheet with a folded corner.
     *
     * Two strokes, no interior detail — at 16px the earlier document-plus-arrow
     * drawing turned into noise. A single recognizable outline reads better next
     * to the shipped row actions.
     */
    function saveGlyph(size) {
      var s = typeof size === 'number' && size > 0 ? size : 16
      return React.createElement(
        'svg',
        {
          'aria-hidden': 'true',
          focusable: 'false',
          height: s,
          viewBox: '0 0 20 20',
          width: s,
          style: { display: 'block' },
        },
        React.createElement('path', {
          d: 'M5.1 3.4h5.9l3.9 3.9v8.6a1.5 1.5 0 0 1-1.5 1.5H6.6a1.5 1.5 0 0 1-1.5-1.5z',
          fill: 'none',
          stroke: 'currentColor',
          strokeLinejoin: 'round',
          strokeWidth: '1.6',
        }),
        React.createElement('path', {
          d: 'M10.9 3.6v3.5a.5.5 0 0 0 .5.5h3.4',
          fill: 'none',
          stroke: 'currentColor',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          strokeWidth: '1.6',
        }),
      )
    }

    /* --------------------------------------------------------- single flight */

    var flight = { saving: false, listeners: [] }

    function setSaving(value) {
      flight.saving = value
      for (var at = 0; at < flight.listeners.length; at += 1) {
        try {
          flight.listeners[at](value)
        } catch (listenerError) {
          /* a broken listener must not block a save */
        }
      }
    }

    /* ------------------------------------------------------------ components */

    function makeBoundary(fallbackText) {
      function PanelBoundary(props) {
        React.Component.call(this, props)
        this.state = { failed: false }
      }
      PanelBoundary.prototype = Object.create(React.Component.prototype)
      PanelBoundary.prototype.constructor = PanelBoundary
      PanelBoundary.getDerivedStateFromError = function () {
        return { failed: true }
      }
      PanelBoundary.prototype.componentDidCatch = function (error) {
        try {
          if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
            console.error('[dsh-note-save] render failed:', error)
          }
        } catch (reportError) {
          /* diagnostics must never throw */
        }
      }
      PanelBoundary.prototype.render = function () {
        if (this.state.failed === true) {
          return React.createElement('div', { className: 'ns-empty' }, fallbackText())
        }
        return this.props.children
      }
      return PanelBoundary
    }

    function createSurfaces(ctx, t) {
      var h = React.createElement
      var locale = ctx && ctx.locale ? ctx.locale : null
      var Boundary = makeBoundary(function () {
        return t('panel.loadError')
      })
      var SettingsBoundary = makeBoundary(function () {
        return t('settings.loadError')
      })

      function useLocaleTick() {
        var pair = React.useState(0)
        var bump = pair[1]
        React.useEffect(function () {
          if (!locale || typeof locale.subscribe !== 'function') return function () {}
          var off = null
          try {
            off = locale.subscribe(function () {
              bump(function (value) {
                return value + 1
              })
            })
          } catch (subscribeError) {
            off = null
          }
          return function () {
            if (typeof off === 'function') {
              try {
                off()
              } catch (offError) {
                /* ignore */
              }
            }
          }
        }, [])
        return pair[0]
      }

      function useSavingLock() {
        var pair = React.useState(flight.saving)
        var setLocal = pair[1]
        React.useEffect(function () {
          var listener = function (value) {
            try {
              setLocal(value)
            } catch (setError) {
              /* ignore */
            }
          }
          flight.listeners.push(listener)
          listener(flight.saving)
          return function () {
            var at = flight.listeners.indexOf(listener)
            if (at >= 0) flight.listeners.splice(at, 1)
          }
        }, [])
        return pair[0]
      }

      /* ------------------------------------------------------- save dialog */

      function NoteSaveDialog(props) {
        useLocaleTick()

        var onClose = props.onClose
        var sessionId = asString(props.sessionId)
        var messageId = asString(props.messageId)

        var statePair = React.useState(null)
        var remoteState = statePair[0]
        var setRemoteState = statePair[1]

        var loadErrorPair = React.useState('')
        var loadError = loadErrorPair[0]
        var setLoadError = loadErrorPair[1]

        var targetPair = React.useState('')
        var target = targetPair[0]
        var setTarget = targetPair[1]

        var locationsPair = React.useState({ locations: [], note: '' })
        var locationsState = locationsPair[0]
        var setLocationsState = locationsPair[1]

        var locationsLoadingPair = React.useState(false)
        var locationsLoading = locationsLoadingPair[0]
        var setLocationsLoading = locationsLoadingPair[1]

        var locationPair = React.useState('')
        var location = locationPair[0]
        var setLocation = locationPair[1]

        var vaultsPair = React.useState({ vaults: [], error: '' })
        var vaultsState = vaultsPair[0]
        var setVaultsState = vaultsPair[1]

        var vaultPair = React.useState('')
        var vault = vaultPair[0]
        var setVault = vaultPair[1]

        var foldersPair = React.useState([])
        var folders = foldersPair[0]
        var setFolders = foldersPair[1]

        var scopePair = React.useState('message')
        var scope = scopePair[0]
        var setScope = scopePair[1]

        var reasoningPair = React.useState(false)
        var includeReasoning = reasoningPair[0]
        var setIncludeReasoning = reasoningPair[1]

        var titlePair = React.useState('')
        var title = titlePair[0]
        var setTitle = titlePair[1]

        var previewPair = React.useState({ status: 'idle', markdown: '', stats: null, error: '' })
        var preview = previewPair[0]
        var setPreview = previewPair[1]

        var viewPair = React.useState('rendered')
        var previewView = viewPair[0]
        var setPreviewView = viewPair[1]

        var savePair = React.useState({ busy: false, error: '', result: null })
        var saveState = savePair[0]
        var setSaveState = savePair[1]

        var previewToken = React.useRef(0)
        var mounted = React.useRef(true)
        var titleRef = React.useRef(null)
        var onCloseRef = React.useRef(onClose)

        onCloseRef.current = onClose

        React.useEffect(function () {
          mounted.current = true
          titleRef.current = null
          return function () {
            mounted.current = false
          }
        }, [])

        // Escape closes; focus moves to the title input on open.
        React.useEffect(function () {
          function onKeyDown(event) {
            if (event && (event.key === 'Escape' || event.keyCode === 27)) {
              event.preventDefault()
              if (typeof onCloseRef.current === 'function') onCloseRef.current()
            }
          }
          try {
            document.addEventListener('keydown', onKeyDown)
          } catch (listenError) {
            /* no document: nothing to bind */
          }
          return function () {
            try {
              document.removeEventListener('keydown', onKeyDown)
            } catch (offError) {
              /* ignore */
            }
          }
        }, [])

        // Target list, then the host's preferred configured default.
        React.useEffect(function () {
          var alive = true
          setLoadError('')
          getJSON('state')
            .then(function (value) {
              if (!alive) return
              var record = recordOf(value)
              var targets = asArray(record.targets)
              setRemoteState({ targets: targets, defaultTarget: asString(record.defaultTarget) })
              var preferred = asString(record.defaultTarget)
              var picked = ''
              var index
              for (index = 0; index < targets.length; index += 1) {
                if (isConfigured(targets[index]) && asString(recordOf(targets[index]).id) === preferred) {
                  picked = preferred
                  break
                }
              }
              if (picked === '') {
                for (index = 0; index < targets.length; index += 1) {
                  if (isConfigured(targets[index])) {
                    picked = asString(recordOf(targets[index]).id)
                    break
                  }
                }
              }
              setTarget(picked)
            })
            .catch(function (error) {
              if (!alive) return
              setLoadError(messageOf(error))
            })
          return function () {
            alive = false
          }
        }, [])

        // Obsidian: the user picks the vault, never a preset.
        React.useEffect(function () {
          if (target !== 'obsidian') return function () {}
          var alive = true
          getJSON('obsidian/vaults')
            .then(function (value) {
              if (!alive) return
              var list = asArray(recordOf(value).vaults)
              setVaultsState({ vaults: list, error: '' })
              setVault(function (current) {
                if (current !== '') return current
                var open = null
                for (var at = 0; at < list.length; at += 1) {
                  if (recordOf(list[at]).open === true) {
                    open = asString(recordOf(list[at]).path)
                    break
                  }
                }
                if (open !== null) return open
                return list.length > 0 ? asString(recordOf(list[0]).path) : ''
              })
            })
            .catch(function (error) {
              if (!alive) return
              setVaultsState({ vaults: [], error: messageOf(error) })
            })
          return function () {
            alive = false
          }
        }, [target])

        // Folder list for the chosen vault (one level; deeper paths are typed).
        React.useEffect(function () {
          if (target !== 'obsidian' || vault === '') {
            setFolders([])
            return function () {}
          }
          var alive = true
          getJSON('obsidian/folders?vault=' + encodeURIComponent(vault) + '&path=')
            .then(function (value) {
              if (!alive) return
              setFolders(asArray(recordOf(value).folders))
            })
            .catch(function () {
              if (!alive) return
              setFolders([])
            })
          return function () {
            alive = false
          }
        }, [target, vault])

        // Non-Obsidian targets: the host's location list.
        React.useEffect(function () {
          if (target === '' || target === 'obsidian') {
            setLocationsState({ locations: [], note: '' })
            setLocationsLoading(false)
            return function () {}
          }
          var alive = true
          setLocationsLoading(true)
          getJSON('targets/' + encodeURIComponent(target) + '/options')
            .then(function (value) {
              if (!alive) return
              var record = recordOf(value)
              var locations = asArray(record.locations)
              setLocationsState({ locations: locations, note: asString(record.note) })
              setLocation(locations.length > 0 ? asString(recordOf(locations[0]).id) : '')
              setLocationsLoading(false)
            })
            .catch(function (error) {
              if (!alive) return
              setLocationsState({ locations: [], note: messageOf(error) })
              setLocation('')
              setLocationsLoading(false)
            })
          return function () {
            alive = false
          }
        }, [target])

        // Debounced preview. The title only matters once the user typed one.
        React.useEffect(function () {
          var token = previewToken.current + 1
          previewToken.current = token
          setPreview(function (previous) {
            return {
              status: 'loading',
              markdown: previous && typeof previous.markdown === 'string' ? previous.markdown : '',
              stats: previous ? previous.stats : null,
              error: '',
            }
          })
          var timer = setTimeout(function () {
            postJSON('preview', {
              sessionId: sessionId,
              messageId: messageId,
              scope: scope,
              includeReasoning: includeReasoning,
            })
              .then(function (value) {
                if (!mounted.current || previewToken.current !== token) return
                var record = recordOf(value)
                setPreview({ status: 'ready', markdown: asString(record.markdown), stats: recordOf(record.stats), error: '' })
                setTitle(function (current) {
                  if (current !== '') return current
                  return asString(record.title)
                })
              })
              .catch(function (error) {
                if (!mounted.current || previewToken.current !== token) return
                setPreview({ status: 'error', markdown: '', stats: null, error: messageOf(error) })
              })
          }, PREVIEW_DEBOUNCE_MS)
          return function () {
            clearTimeout(timer)
          }
        }, [scope, includeReasoning, messageId])

        function effectiveLocation() {
          if (target === 'obsidian') return location
          return location
        }

        function onSave() {
          if (saveState.busy === true || flight.saving === true) return
          setSaveState({ busy: true, error: '', result: null })
          setSaving(true)
          postJSON('save', {
            target: target,
            sessionId: sessionId,
            messageId: messageId,
            scope: scope,
            title: title,
            includeReasoning: includeReasoning,
            location: effectiveLocation(),
            vault: target === 'obsidian' ? vault : undefined,
          })
            .then(function (value) {
              setSaving(false)
              if (!mounted.current) return
              setSaveState({ busy: false, error: '', result: recordOf(value) })
            })
            .catch(function (error) {
              setSaving(false)
              if (!mounted.current) return
              setSaveState({ busy: false, error: messageOf(error), result: null })
            })
        }

        var targets = remoteState === null ? [] : asArray(remoteState.targets)
        var result = saveState.result

        var body
        if (result !== null) {
          body = h(
            'div',
            { className: 'ns-success' },
            h('div', { className: 'ns-successTitle' }, t('panel.saved')),
            h(
              'div',
              { className: 'ns-kv' },
              h('span', { className: 'ns-kvKey' }, t('panel.refLabel')),
              h('span', { className: 'ns-ref' }, asString(result.ref)),
            ),
            asString(result.url) === ''
              ? null
              : h(
                  'a',
                  { className: 'ns-link', href: asString(result.url), target: '_blank', rel: 'noreferrer noopener' },
                  asString(result.url),
                ),
          )
        } else {
          body = h(
            'div',
            { className: 'ns-body' },
            loadError === ''
              ? null
              : h('div', { className: 'ns-errorLine' }, t('panel.loadError') + '：' + loadError),

            h(
              'div',
              { className: 'ns-field' },
              h('label', { className: 'ns-label', htmlFor: 'ns-title' }, t('panel.titleLabel')),
              h('input', {
                id: 'ns-title',
                className: 'ns-input',
                onChange: function (event) {
                  setTitle(event.target.value)
                },
                placeholder: t('panel.titlePlaceholder'),
                ref: function (node) {
                  if (node !== null && titleRef.current === null) {
                    titleRef.current = node
                    try {
                      node.focus()
                      node.select()
                    } catch (focusError) {
                      /* focus is best effort */
                    }
                  }
                },
                type: 'text',
                value: title,
              }),
            ),

            h(
              'div',
              { className: 'ns-field' },
              h('span', { className: 'ns-label' }, t('panel.scopeLabel')),
              h(
                'div',
                { className: 'ns-seg', role: 'group', 'aria-label': t('panel.scopeLabel') },
                ['message', 'turn', 'session'].map(function (option) {
                  return h(
                    'button',
                    {
                      key: option,
                      type: 'button',
                      className: 'ns-segBtn',
                      'data-on': scope === option ? 'true' : 'false',
                      'aria-pressed': scope === option ? 'true' : 'false',
                      onClick: function () {
                        setScope(option)
                      },
                    },
                    t('panel.scope.' + option),
                  )
                }),
              ),
            ),

            h(
              'div',
              { className: 'ns-row' },
              h(
                'div',
                { className: 'ns-field' },
                h('label', { className: 'ns-label', htmlFor: 'ns-target' }, t('panel.targetLabel')),
                h(
                  'select',
                  {
                    id: 'ns-target',
                    className: 'ns-select',
                    onChange: function (event) {
                      setTarget(event.target.value)
                      setLocation('')
                    },
                    value: target,
                  },
                  targets.length === 0 ? h('option', { value: '' }, t('panel.loading')) : null,
                  targets.map(function (entry) {
                    var record = recordOf(entry)
                    var id = asString(record.id)
                    var configured = isConfigured(entry)
                    return h(
                      'option',
                      { key: id, value: id, disabled: configured !== true },
                      asString(record.label) +
                        (configured === true ? '' : ' — ' + t('panel.targetUnconfigured') + '：' + asString(record.detail)),
                    )
                  }),
                ),
              ),
            ),

            target === 'obsidian'
              ? h(
                  'div',
                  { className: 'ns-row' },
                  h(
                    'div',
                    { className: 'ns-field' },
                    h('label', { className: 'ns-label', htmlFor: 'ns-vault' }, t('panel.vaultLabel')),
                    h(
                      'select',
                      {
                        id: 'ns-vault',
                        className: 'ns-select',
                        onChange: function (event) {
                          setVault(event.target.value)
                          setLocation('')
                        },
                        value: vault,
                      },
                      vaultsState.vaults.length === 0
                        ? h('option', { value: '' }, vaultsState.error === '' ? t('panel.vaultNone') : vaultsState.error)
                        : null,
                      vaultsState.vaults.map(function (entry) {
                        var record = recordOf(entry)
                        var path = asString(record.path)
                        return h('option', { key: path, value: path }, asString(record.name) + ' — ' + path)
                      }),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'ns-field' },
                    h('label', { className: 'ns-label', htmlFor: 'ns-folder' }, t('panel.folderLabel')),
                    h(
                      'select',
                      {
                        id: 'ns-folder',
                        className: 'ns-select',
                        onChange: function (event) {
                          setLocation(event.target.value)
                        },
                        value: location,
                      },
                      h('option', { value: '' }, t('panel.folderRoot')),
                      folders.map(function (entry) {
                        var record = recordOf(entry)
                        var path = asString(record.path)
                        return h('option', { key: path, value: path }, asString(record.name))
                      }),
                    ),
                  ),
                )
              : h(
                  'div',
                  { className: 'ns-field' },
                  h('label', { className: 'ns-label', htmlFor: 'ns-location' }, t('panel.locationLabel')),
                  h(
                    'select',
                    {
                      id: 'ns-location',
                      className: 'ns-select',
                      disabled: locationsLoading === true,
                      onChange: function (event) {
                        setLocation(event.target.value)
                      },
                      value: location,
                    },
                    locationsLoading === true
                      ? h('option', { value: '' }, t('panel.locationLoading'))
                      : null,
                    locationsLoading !== true && locationsState.locations.length === 0
                      ? h('option', { value: '' }, locationsState.note === '' ? t('panel.locationNone') : locationsState.note)
                      : null,
                    // Adapters list real destinations only; "default" is the
                    // empty value the API leaves optional.
                    locationsLoading !== true && locationsState.locations.length > 0
                      ? h('option', { value: '' }, t('panel.locationDefault'))
                      : null,
                    locationsState.locations.map(function (entry) {
                      var record = recordOf(entry)
                      var id = asString(record.id)
                      return h('option', { key: id, value: id }, asString(record.label) || id)
                    }),
                  ),
                ),

            target === 'obsidian'
              ? h(
                  'div',
                  { className: 'ns-field' },
                  h('label', { className: 'ns-label', htmlFor: 'ns-folderPath' }, t('panel.folderCustom')),
                  h('input', {
                    id: 'ns-folderPath',
                    className: 'ns-input',
                    onChange: function (event) {
                      setLocation(event.target.value)
                    },
                    placeholder: t('panel.folderPlaceholder'),
                    type: 'text',
                    value: location,
                  }),
                  h('span', { className: 'ns-hint' }, t('panel.folderPlaceholder')),
                )
              : null,

            h(
              'label',
              { className: 'ns-check' },
              h('input', {
                type: 'checkbox',
                checked: includeReasoning,
                onChange: function (event) {
                  setIncludeReasoning(event.target.checked === true)
                },
              }),
              t('panel.includeReasoning'),
            ),

            h(
              'div',
              { className: 'ns-field' },
              h(
                'div',
                { className: 'ns-previewHead' },
                h('span', { className: 'ns-label' }, t('panel.previewLabel')),
                h(
                  'div',
                  { className: 'ns-seg', role: 'group', 'aria-label': t('panel.previewLabel') },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ns-segBtn',
                      'data-on': previewView === 'rendered' ? 'true' : 'false',
                      'aria-pressed': previewView === 'rendered' ? 'true' : 'false',
                      onClick: function () {
                        setPreviewView('rendered')
                      },
                    },
                    t('panel.previewRendered'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ns-segBtn',
                      'data-on': previewView === 'source' ? 'true' : 'false',
                      'aria-pressed': previewView === 'source' ? 'true' : 'false',
                      onClick: function () {
                        setPreviewView('source')
                      },
                    },
                    t('panel.previewSource'),
                  ),
                ),
                preview.stats !== null
                  ? h(
                      'span',
                      { className: 'ns-meta' },
                      asString(preview.stats.messages) +
                        ' ' +
                        t('panel.messages') +
                        ' · ' +
                        asString(preview.stats.chars) +
                        ' ' +
                        t('panel.chars'),
                    )
                  : null,
              ),
              h(
                'div',
                { className: 'ns-previewBox' },
                preview.status === 'error'
                  ? h('div', { className: 'ns-errorLine' }, t('panel.previewError') + '：' + preview.error)
                  : preview.status === 'loading' && preview.markdown === ''
                    ? h('div', { className: 'ns-empty' }, t('panel.previewLoading'))
                    : preview.markdown === ''
                      ? h('div', { className: 'ns-empty' }, t('panel.previewEmpty'))
                      : previewView === 'source'
                        ? h('pre', { className: 'ns-source' }, preview.markdown)
                        : h('div', {
                            // Safe: renderMarkdown escapes every input byte before
                            // introducing tags from its own fixed set.
                            dangerouslySetInnerHTML: { __html: renderMarkdown(preview.markdown) },
                          }),
              ),
            ),

            saveState.error === '' ? null : h('div', { className: 'ns-errorLine' }, saveState.error),
          )
        }

        var dialog = h(
          'div',
          { className: 'ns-backdrop', onMouseDown: function (event) {
              if (event.target === event.currentTarget && typeof onClose === 'function') onClose()
            } },
          h(
            'div',
            {
              className: 'ns-card',
              role: 'dialog',
              'aria-modal': 'true',
              'aria-label': t('panel.title'),
            },
            h(
              'div',
              { className: 'ns-head' },
              h('span', { className: 'ns-headGlyph' }, saveGlyph(17)),
              h('h2', { className: 'ns-headTitle' }, t('panel.title')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ns-iconBtn',
                  onClick: typeof onClose === 'function' ? onClose : function () {},
                  'aria-label': t('panel.close'),
                },
                t('panel.close'),
              ),
            ),
            body,
            h(
              'div',
              { className: 'ns-foot' },
              result !== null
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ns-btn ns-btnPrim',
                      onClick: typeof onClose === 'function' ? onClose : function () {},
                    },
                    t('panel.close'),
                  )
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'ns-btn',
                      onClick: typeof onClose === 'function' ? onClose : function () {},
                    },
                    t('panel.cancel'),
                  ),
              result !== null
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'ns-btn ns-btnPrim',
                      disabled: saveState.busy === true || target === '',
                      onClick: onSave,
                    },
                    saveState.busy === true ? t('panel.saving') : t('panel.save'),
                  ),
            ),
          ),
        )

        // Portal to <body>: the chat column has transform ancestors, so a fixed
        // overlay inside it would be clipped.
        if (ReactDOM !== null && typeof ReactDOM.createPortal === 'function' && typeof document !== 'undefined' && document.body) {
          try {
            return ReactDOM.createPortal(dialog, document.body)
          } catch (portalError) {
            return dialog
          }
        }
        return dialog
      }

      /* ---------------------------------------------------------- the action */

      function NoteSaveAction(props) {
        useLocaleTick()
        var saving = useSavingLock()
        var openPair = React.useState(false)
        var open = openPair[0]
        var setOpen = openPair[1]
        var noticePair = React.useState('')
        var notice = noticePair[0]
        var setNotice = noticePair[1]
        var timerRef = React.useRef(null)
        var mountedRef = React.useRef(true)

        React.useEffect(function () {
          mountedRef.current = true
          return function () {
            mountedRef.current = false
            if (timerRef.current !== null) {
              clearTimeout(timerRef.current)
              timerRef.current = null
            }
          }
        }, [])

        var safeProps = props && typeof props === 'object' ? props : {}
        var sessionId = asString(safeProps.sessionId)
        var messageId = asString(safeProps.messageId)
        var contextReady = sessionId !== '' && messageId !== ''

        function flash(text) {
          setNotice(text)
          if (timerRef.current !== null) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(function () {
            timerRef.current = null
            if (mountedRef.current) setNotice('')
          }, NOTICE_MS)
        }

        function onClick() {
          if (contextReady !== true) {
            flash(t('panel.missingContext'))
            return
          }
          if (saving || flight.saving) {
            flash(t('action.busy'))
            return
          }
          if (open === true) return
          setNotice('')
          setOpen(true)
        }

        var label = t('action.save')

        return h(
          'span',
          { className: 'ns-root' },
          h(
            'button',
            {
              type: 'button',
              className: 'ns-action',
              disabled: contextReady !== true,
              title: contextReady === true ? t('action.saveHint') : t('panel.missingContext'),
              'aria-label': label,
              'aria-haspopup': 'dialog',
              'aria-expanded': open === true ? 'true' : 'false',
              onClick: onClick,
            },
            h('span', { className: 'ns-actionGlyph' }, saveGlyph(16)),
          ),
          notice !== '' ? h('span', { className: 'ns-notice', role: 'status' }, notice) : null,
          open === true && contextReady === true
            ? h(NoteSaveDialog, { sessionId: sessionId, messageId: messageId, onClose: function () {
                setOpen(false)
              } })
            : null,
        )
      }

      /* ---------------------------------------------------- settings page */

      function NoteSaveSettings() {
        useLocaleTick()

        var schemaPair = React.useState(null)
        var schema = schemaPair[0]
        var setSchema = schemaPair[1]

        var configPair = React.useState(null)
        var config = configPair[0]
        var setConfig = configPair[1]

        var formsPair = React.useState({})
        var forms = formsPair[0]
        var setForms = formsPair[1]

        var statusPair = React.useState({})
        var statuses = statusPair[0]
        var setStatuses = statusPair[1]

        var busyPair = React.useState({})
        var busy = busyPair[0]
        var setBusy = busyPair[1]

        var errorPair = React.useState('')
        var loadError = errorPair[0]
        var setLoadError = errorPair[1]

        // Which target the right-hand pane is showing. Empty means "not chosen
        // yet"; the load path selects the first one.
        var activePair = React.useState('')
        var activeTarget = activePair[0]
        var setActiveTarget = activePair[1]

        var mounted = React.useRef(true)

        React.useEffect(function () {
          mounted.current = true
          return function () {
            mounted.current = false
          }
        }, [])

        /**
         * The Host-native directory picker, when this page has it.
         *
         * A path field must accept free typing (a vault can live anywhere) and
         * ALSO offer a real picker — a dropdown of known vaults cannot express
         * either. When the service is absent the button simply does not render;
         * typing still works.
         */
        var directoryPicker = null
        try {
          var picked = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : null
          directoryPicker = picked === undefined ? null : picked
        } catch (pickerLookupError) {
          directoryPicker = null
        }
        var canPick = directoryPicker !== null && typeof directoryPicker.pickDirectory === 'function'

        // Location lists for fields that declare `pick: 'location'` (an ima
        // notebook, for example). Loaded once per target, on demand.
        var locationListsPair = React.useState({})
        var locationLists = locationListsPair[0]
        var setLocationLists = locationListsPair[1]
        var locationLoadPair = React.useState({})
        var locationLoading = locationLoadPair[0]
        var setLocationLoading = locationLoadPair[1]

        function loadLocations(targetId) {
          if (locationLists[targetId] !== undefined || locationLoading[targetId] === true) return
          setLocationLoading(function (previous) {
            var next = Object.assign({}, previous)
            next[targetId] = true
            return next
          })
          getJSON('targets/' + encodeURIComponent(targetId) + '/options')
            .then(function (value) {
              if (!mounted.current) return
              var record = recordOf(value)
              setLocationLists(function (previous) {
                var next = Object.assign({}, previous)
                next[targetId] = { locations: asArray(record.locations), note: asString(record.note) }
                return next
              })
              setLocationLoading(function (previous) {
                var next = Object.assign({}, previous)
                next[targetId] = false
                return next
              })
            })
            .catch(function (error) {
              if (!mounted.current) return
              setLocationLists(function (previous) {
                var next = Object.assign({}, previous)
                next[targetId] = { locations: [], note: messageOf(error) }
                return next
              })
              setLocationLoading(function (previous) {
                var next = Object.assign({}, previous)
                next[targetId] = false
                return next
              })
            })
        }

        function pickDirectory(targetId, key) {
          if (!canPick) return
          var pending
          try {
            pending = directoryPicker.pickDirectory()
          } catch (pickError) {
            return
          }
          Promise.resolve(pending)
            .then(function (picked) {
              if (!mounted.current) return
              if (typeof picked === 'string' && picked !== '') setField(targetId, key, picked)
            })
            .catch(function () {
              /* a cancelled or failed pick leaves the field as typed */
            })
        }

        function hydrate(schemaValue, configValue) {
          var targets = asArray(recordOf(schemaValue).targets)
          var values = recordOf(recordOf(configValue).values)
          var next = {}
          for (var at = 0; at < targets.length; at += 1) {
            var target = recordOf(targets[at])
            var id = asString(target.id)
            var stored = recordOf(values[id])
            var fields = asArray(target.fields)
            var form = {}
            for (var index = 0; index < fields.length; index += 1) {
              var field = recordOf(fields[index])
              var key = asString(field.key)
              form[key] = field.secret === true ? '' : asString(stored[key])
              if (field.secret === true) form['clear_' + key] = false
            }
            next[id] = form
          }
          setForms(next)
          // Keep the current selection if it still exists, else pick the first.
          setActiveTarget(function (current) {
            if (current !== '') {
              for (var probe = 0; probe < targets.length; probe += 1) {
                if (asString(recordOf(targets[probe]).id) === current) return current
              }
            }
            return targets.length > 0 ? asString(recordOf(targets[0]).id) : ''
          })
        }

        function load() {
          setLoadError('')
          Promise.all([getJSON('schema'), getJSON('config')])
            .then(function (results) {
              if (!mounted.current) return
              setSchema(results[0])
              setConfig(results[1])
              hydrate(results[0], results[1])
            })
            .catch(function (error) {
              if (!mounted.current) return
              setLoadError(messageOf(error))
            })
        }

        React.useEffect(function () {
          load()
          return function () {
            mounted.current = false
          }
        }, [])

        function setField(targetId, key, value) {
          setForms(function (previous) {
            var next = {}
            for (var name in previous) {
              if (Object.prototype.hasOwnProperty.call(previous, name)) next[name] = previous[name]
            }
            next[targetId] = next[targetId] ? Object.assign({}, next[targetId]) : {}
            next[targetId][key] = value
            return next
          })
        }

        function markBusy(targetId, key, value) {
          setBusy(function (previous) {
            var next = {}
            for (var name in previous) {
              if (Object.prototype.hasOwnProperty.call(previous, name)) next[name] = previous[name]
            }
            next[targetId] = Object.assign({}, next[targetId] || {})
            next[targetId][key] = value
            return next
          })
        }

        function markStatus(targetId, value) {
          setStatuses(function (previous) {
            var next = {}
            for (var name in previous) {
              if (Object.prototype.hasOwnProperty.call(previous, name)) next[name] = previous[name]
            }
            next[targetId] = value
            return next
          })
        }

        function onTest(targetId) {
          var form = forms[targetId] || {}
          markBusy(targetId, 'test', true)
          markStatus(targetId, { kind: 'pending', text: t('settings.testing') })
          postJSON('test', { target: targetId, values: form })
            .then(function (value) {
              if (!mounted.current) return
              markBusy(targetId, 'test', false)
              var record = recordOf(value)
              markStatus(targetId, {
                kind: record.ok === true ? 'ok' : 'err',
                text: asString(record.detail),
              })
            })
            .catch(function (error) {
              if (!mounted.current) return
              markBusy(targetId, 'test', false)
              markStatus(targetId, { kind: 'err', text: messageOf(error) })
            })
        }

        function onSave(targetId) {
          var form = forms[targetId] || {}
          markBusy(targetId, 'save', true)
          postJSON('config/save', { target: targetId, values: form })
            .then(function (value) {
              if (!mounted.current) return
              markBusy(targetId, 'save', false)
              setConfig(value)
              hydrate(schema, value)
              markStatus(targetId, { kind: 'ok', text: t('settings.saved') })
            })
            .catch(function (error) {
              if (!mounted.current) return
              markBusy(targetId, 'save', false)
              markStatus(targetId, { kind: 'err', text: messageOf(error) })
            })
        }

        if (schema === null || config === null) {
          // "Unknown endpoint" is the signature of a stale host half: the client
          // bundle hot-reloads on refresh, the host half only on restart, so the
          // page can appear before its API exists. Say that instead of showing a
          // bare route error the user cannot act on.
          var staleBackend = loadError !== '' && /未知接口|unknown|not found|404/i.test(loadError)
          return h(
            'div',
            { className: 'ns-page' },
            loadError === ''
              ? h('p', { className: 'ns-pageDesc' }, t('settings.loading'))
              : h('div', { className: 'ns-errorLine' }, t('settings.loadError') + '：' + loadError),
            staleBackend ? h('p', { className: 'ns-pageDesc' }, t('settings.staleBackend')) : null,
            loadError === ''
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'ns-btn',
                    onClick: load,
                  },
                  t('settings.retry'),
                ),
          )
        }

        var targets = asArray(recordOf(schema).targets)
        var configValues = recordOf(recordOf(config).values)
        var configPath = asString(recordOf(config).configPath)

        /** Whether a target has every required field filled. */
        function isTargetConfigured(id) {
          var entry = null
          for (var scan = 0; scan < targets.length; scan += 1) {
            if (asString(recordOf(targets[scan]).id) === id) {
              entry = recordOf(targets[scan])
              break
            }
          }
          if (entry === null) return false
          var fields = asArray(entry.fields)
          // A target with no describable fields cannot claim to be configured.
          if (fields.length === 0) return false
          var form = forms[id] || {}
          var stored = recordOf(configValues[id])
          for (var at = 0; at < fields.length; at += 1) {
            var field = recordOf(fields[at])
            if (field.required !== true) continue
            var key = asString(field.key)
            var present = field.secret === true ? stored[key + 'Set'] === true : asString(form[key]) !== ''
            if (!present) return false
          }
          return true
        }

        var selectedId = activeTarget
        if (selectedId === '') selectedId = targets.length > 0 ? asString(recordOf(targets[0]).id) : ''

        var selected = null
        for (var pick = 0; pick < targets.length; pick += 1) {
          if (asString(recordOf(targets[pick]).id) === selectedId) {
            selected = recordOf(targets[pick])
            break
          }
        }

        /** The right pane: one target's form. */
        function renderPane(target) {
          var id = asString(target.id)
          var fields = asArray(target.fields)
          var form = forms[id] || {}
          var stored = recordOf(configValues[id])
          var busyFor = busy[id] || {}
          var status = statuses[id]
          var configured = isTargetConfigured(id)

          return h(
            'section',
            {
              className: 'ns-pane',
              role: 'tabpanel',
              id: 'ns-pane-' + id,
              'aria-labelledby': 'ns-tab-' + id,
            },
            h(
              'div',
              { className: 'ns-cardHead' },
              h('h3', { className: 'ns-cardTitle' }, asString(target.label)),
              h(
                'span',
                { className: 'ns-badge ' + (configured ? 'ns-badgeOk' : 'ns-badgeNo') },
                configured ? t('settings.statusOk') : t('settings.statusNo'),
              ),
            ),
            fields.length === 0
              ? h('span', { className: 'ns-hint' }, t('settings.fieldsMissing'))
              : fields.map(function (fieldEntry) {
                  var field = recordOf(fieldEntry)
                  var key = asString(field.key)
                  var secret = field.secret === true
                  var isSet = secret && stored[key + 'Set'] === true
                  var inputId = 'ns-cfg-' + id + '-' + key
                  var wantsPicker = asString(field.pick) === 'directory' && canPick
                  var wantsLocation = asString(field.pick) === 'location'
                  if (wantsLocation && locationLists[id] === undefined) loadLocations(id)
                  var locationList = locationLists[id]
                  var locations = locationList === undefined ? [] : asArray(locationList.locations)
                  var locationBusy = locationLoading[id] === true
                  var locationNote = locationList === undefined ? '' : asString(locationList.note)
                  var locationPlaceholder = locationBusy
                    ? t('settings.locationLoading')
                    : locations.length === 0
                      ? locationNote === ''
                        ? t('settings.locationNone')
                        : locationNote
                      : t('settings.pickFromList')
                  return h(
                    'div',
                    { className: 'ns-field', key: key },
                    h(
                      'label',
                      { className: 'ns-label', htmlFor: inputId },
                      asString(field.label),
                      field.required === true ? ' *' : '',
                    ),
                    h(
                      'div',
                      { className: 'ns-inputRow' },
                      h('input', {
                        id: inputId,
                        className: 'ns-input',
                        type: secret ? 'password' : 'text',
                        inputMode: asString(field.type) === 'url' ? 'url' : undefined,
                        placeholder: secret && isSet ? t('settings.secretSet') : asString(field.placeholder),
                        value: asString(form[key]),
                        onChange: function (event) {
                          setField(id, key, event.target.value)
                        },
                      }),
                      wantsLocation
                        ? h(
                            'select',
                            {
                              className: 'ns-select ns-selectPick',
                              'aria-label': asString(field.label),
                              disabled: locationBusy === true || locations.length === 0,
                              title: locations.length === 0 ? locationPlaceholder : undefined,
                              value: locations.some(function (entry) {
                                return asString(recordOf(entry).id) === asString(form[key])
                              })
                                ? asString(form[key])
                                : '',
                              onChange: function (event) {
                                setField(id, key, event.target.value)
                              },
                            },
                            h('option', { value: '' }, locationPlaceholder),
                            locations.map(function (entry) {
                              var option = recordOf(entry)
                              var optionId = asString(option.id)
                              if (optionId === '') return null
                              return h('option', { key: optionId, value: optionId }, asString(option.label) || optionId)
                            }),
                          )
                        : null,
                      wantsPicker
                        ? h(
                            'button',
                            {
                              type: 'button',
                              className: 'ns-btn ns-btnPick',
                              onClick: function () {
                                pickDirectory(id, key)
                              },
                            },
                            t('settings.browse'),
                          )
                        : null,
                    ),
                    secret
                      ? h(
                          'label',
                          { className: 'ns-check' },
                          h('input', {
                            type: 'checkbox',
                            checked: form['clear_' + key] === true,
                            onChange: function (event) {
                              setField(id, 'clear_' + key, event.target.checked === true)
                            },
                          }),
                          t('settings.clearHint'),
                        )
                      : null,
                  )
                }),
            h(
              'div',
              { className: 'ns-cardFoot' },
              status === undefined || status === null
                ? null
                : h(
                    'span',
                    {
                      className:
                        'ns-statusLine ' +
                        (status.kind === 'ok' ? 'ns-statusOk' : status.kind === 'err' ? 'ns-statusErr' : ''),
                    },
                    asString(status.text),
                  ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ns-btn',
                  disabled: busyFor.test === true,
                  onClick: function () {
                    onTest(id)
                  },
                },
                busyFor.test === true ? t('settings.testing') : t('settings.test'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ns-btn ns-btnPrim',
                  disabled: busyFor.save === true,
                  onClick: function () {
                    onSave(id)
                  },
                },
                busyFor.save === true ? t('settings.saving') : t('settings.save'),
              ),
            ),
          )
        }

        // Top tabs: one strip picks a target, one pane below shows its form.
        // Stacked cards meant scrolling past five unrelated configurations to
        // reach the one you came for.
        return h(
          'div',
          { className: 'ns-page' },
          h('p', { className: 'ns-pageDesc' }, t('settings.description')),
          h(
            'div',
            {
              className: 'ns-tabs',
              role: 'tablist',
              'aria-orientation': 'horizontal',
              'aria-label': t('settings.title'),
            },
            targets.map(function (entry) {
              var target = recordOf(entry)
              var id = asString(target.id)
              var configured = isTargetConfigured(id)
              return h(
                'button',
                {
                  key: id,
                  id: 'ns-tab-' + id,
                  type: 'button',
                  role: 'tab',
                  className: 'ns-tab',
                  'data-active': id === selectedId ? 'true' : 'false',
                  'aria-selected': id === selectedId ? 'true' : 'false',
                  'aria-controls': 'ns-pane-' + id,
                  onClick: function () {
                    setActiveTarget(id)
                  },
                },
                h('span', { className: 'ns-tabLabel' }, asString(target.label)),
                h('span', {
                  className: 'ns-tabDot' + (configured ? ' ns-tabDotOn' : ''),
                  'aria-hidden': 'true',
                  title: configured ? t('settings.statusOk') : t('settings.statusNo'),
                }),
              )
            }),
          ),
          selected === null ? h('div', { className: 'ns-empty' }, t('settings.loading')) : renderPane(selected),
          // The explanations live in one guide page instead of under every
          // field: the form stays a form, and the "where do I get this token"
          // text is read once rather than repeated six times.
          h(
            'p',
            { className: 'ns-pageFoot' },
            configPath === '' ? null : h('span', null, t('settings.configPath') + '：' + configPath),
            h(
              'a',
              {
                className: 'ns-guideLink',
                href: routeUrl('guide'),
                target: '_blank',
                rel: 'noreferrer noopener',
              },
              t('settings.guide'),
            ),
          ),
        )
      }

      return {
        Action: function ActionWithBoundary(props) {
          return h(Boundary, null, h(NoteSaveAction, props))
        },
        Settings: function SettingsWithBoundary() {
          return h(SettingsBoundary, null, h(NoteSaveSettings))
        },
      }
    }

    /* ---------------------------------------------------------- plugin entry */

    var inject = ['slots', 'locale']

    function apply(ctx) {
      var t = function (key) {
        return key
      }

      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(function () {
          var disposers = []
          var registered = false
          try {
            var dispose = ctx.locale.register(NS, { zh: zh, en: en })
            if (typeof dispose === 'function') disposers.push(dispose)
            registered = true
          } catch (objectFormError) {
            registered = false
          }
          if (registered !== true) {
            var locales = [
              { id: 'zh', dict: zh },
              { id: 'en', dict: en },
            ]
            for (var index = 0; index < locales.length; index += 1) {
              try {
                var off = ctx.locale.register(NS, locales[index].id, locales[index].dict)
                if (typeof off === 'function') disposers.push(off)
              } catch (localeFormError) {
                /* this locale stays untranslated */
              }
            }
          }
          return function () {
            for (var at = 0; at < disposers.length; at += 1) {
              try {
                disposers[at]()
              } catch (disposeError) {
                /* ignore */
              }
            }
          }
        }, 'dsh-note-save: dictionaries')
      }

      if (ctx.locale && typeof ctx.locale.bind === 'function') {
        try {
          t = ctx.locale.bind(NS)
        } catch (bindError) {
          t = function (key) {
            return key
          }
        }
      }

      ctx.effect(installStyles, 'dsh-note-save: styles')

      var surfaces = createSurfaces(ctx, t)

      ctx.effect(function () {
        return ctx.slots.inject(SLOT, function () {
          return ctx.slots.register(
            {
              name: SLOT,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              locale: NS,
              label: function () {
                return t('action.save')
              },
            },
            surfaces.Action,
          )
        })
      }, 'dsh-note-save: assistant action')

      ctx.effect(function () {
        return ctx.slots.inject(SETTINGS_SLOT, function () {
          return ctx.slots.register(
            {
              name: SETTINGS_SLOT,
              id: ENTRY_ID,
              order: SETTINGS_ORDER,
              locale: NS,
              label: function () {
                return t('settings.title')
              },
            },
            surfaces.Settings,
          )
        })
      }, 'dsh-note-save: settings section')
    }

    exports.inject = inject
    exports.apply = apply
    // Exposed for the headless tests only: the preview renderer is the one piece
    // with an escaping contract worth asserting directly. Not used by the app.
    exports.renderMarkdown = renderMarkdown
    return module.exports
  },
})
