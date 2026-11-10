/**
 * Adapter contract tests for dsh-note-save HTTP targets.
 *
 * Run from D:\DemandOS\dsh-note-save (the DSH sandbox forbids subprocess spawning,
 * so `node --test` fails with `spawn EPERM` — execute the file directly):
 *   node tests/adapters.test.mjs
 *
 * No npm dependencies: node:test + node:assert/strict + a hand-rolled mock fetch.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { readConfig } from '../lib/config.js';
import siyuan from '../lib/adapters/siyuan.js';
import joplin from '../lib/adapters/joplin.js';
import notion, { markdownToBlocks } from '../lib/adapters/notion.js';
import yuque from '../lib/adapters/yuque.js';

/* --------------------------------------------------------------- utilities */

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Build a fake `env` whose fetch records every request and defers the response to
 * `handler(req, index)`. `handler` returns { status?, json? } or { status?, text? }.
 */
function makeEnv(handler) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const rawBody = init.body;
    const req = {
      url: String(url),
      method: (init.method || 'GET').toUpperCase(),
      headers: { ...(init.headers || {}) },
      rawBody,
      body: typeof rawBody === 'string' ? tryParse(rawBody) : undefined,
      signal: init.signal,
    };
    requests.push(req);
    const reply = (await handler(req, requests.length - 1)) || {};
    const status = reply.status == null ? 200 : reply.status;
    const text = reply.text !== undefined ? reply.text : JSON.stringify(reply.json ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
      headers: { get: () => null },
    };
  };
  return { fetch, requests };
}

function headerValue(req, name) {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function jsonResponse(json, status = 200) {
  return { status, json };
}

const config = (targets) => ({ targets });

const NOTE = {
  title: 'My Note',
  markdown: '### 👤 用户\n\nhello\n',
};

/** Shared: every adapter must expose the SPEC.md surface. */
test('all adapters expose the SPEC.md module shape', () => {
  const adapters = { siyuan, joplin, notion, yuque };
  for (const [name, adapter] of Object.entries(adapters)) {
    assert.equal(adapter.id, name, `${name}: id`);
    assert.equal(typeof adapter.label, 'string', `${name}: label`);
    assert.ok(adapter.label.length > 0, `${name}: label non-empty`);
    assert.equal(typeof adapter.status, 'function', `${name}: status`);
    assert.equal(typeof adapter.options, 'function', `${name}: options`);
    assert.equal(typeof adapter.write, 'function', `${name}: write`);
  }
});

/* ---------------------------------------------------------------- unconfigured */

const UNCONFIGURED = [
  ['siyuan', siyuan],
  ['joplin', joplin],
  ['notion', notion],
  ['yuque', yuque],
];

for (const [name, adapter] of UNCONFIGURED) {
  test(`${name}: unconfigured status/options do not throw and explain what is missing`, async () => {
    const env = makeEnv(() => {
      throw new Error('unconfigured adapters must not make requests');
    });
    for (const cfg of [undefined, {}, { targets: {} }, { targets: { [name]: {} } }]) {
      const status = await adapter.status(cfg, env);
      assert.equal(status.configured, false, `${name}: configured false`);
      assert.equal(typeof status.detail, 'string');
      assert.ok(status.detail.length > 0, `${name}: detail must explain the gap`);

      const options = await adapter.options(cfg, env);
      assert.deepEqual(options.locations, [], `${name}: no locations`);
      assert.equal(typeof options.note, 'string');
      assert.ok(options.note.length > 0, `${name}: note must explain the gap`);
    }
    assert.equal(env.requests.length, 0);
  });

  test(`${name}: write without config throws a readable Error`, async () => {
    const env = makeEnv(() => jsonResponse({}));
    await assert.rejects(
      () => adapter.write(NOTE, {}, undefined, env),
      (err) => {
        assert.ok(err instanceof Error, `${name}: Error instance`);
        assert.ok(err.message.length > 10, `${name}: message must be human readable`);
        return true;
      },
    );
    assert.equal(env.requests.length, 0, `${name}: no request before validation`);
  });
}

/* -------------------------------------------------------------------- SiYuan */

const SIYUAN_CONFIG = config({
  siyuan: { token: 'syt-token', baseUrl: 'http://127.0.0.1:6806/', notebook: 'box-1' },
});

test('siyuan: status reports configured with token + notebook', async () => {
  const env = makeEnv(() => jsonResponse({}));
  const status = await siyuan.status(SIYUAN_CONFIG, env);
  assert.equal(status.configured, true);
  assert.match(status.detail, /127\.0\.0\.1:6806/);
  assert.match(status.detail, /box-1/);
});

test('siyuan: options lists notebooks via lsNotebooks', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'http://127.0.0.1:6806/api/notebook/lsNotebooks');
    assert.equal(req.method, 'POST');
    assert.equal(headerValue(req, 'authorization'), 'Token syt-token');
    return jsonResponse({ code: 0, data: { notebooks: [{ id: 'box-1', name: '工作' }, { id: 'box-2', name: '生活' }] } });
  });
  const options = await siyuan.options(SIYUAN_CONFIG, env);
  assert.deepEqual(options.locations, [
    { id: 'box-1', label: '工作' },
    { id: 'box-2', label: '生活' },
  ]);
});

test('siyuan: successful write posts createDocWithMd with token header', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'http://127.0.0.1:6806/api/filetree/createDocWithMd');
    assert.equal(req.method, 'POST');
    assert.equal(headerValue(req, 'authorization'), 'Token syt-token');
    assert.equal(headerValue(req, 'content-type'), 'application/json');
    assert.deepEqual(req.body, {
      notebook: 'box-1',
      path: '/My Note',
      markdown: NOTE.markdown,
    });
    assert.ok(req.signal, 'timeout signal attached');
    return jsonResponse({ code: 0, data: '20240101120000-abc1234' });
  });
  const result = await siyuan.write(NOTE, {}, SIYUAN_CONFIG, env);
  assert.equal(result.created, true);
  assert.equal(result.ref, '20240101120000-abc1234');
  assert.match(result.url, /20240101120000-abc1234/);
  assert.equal(env.requests.length, 1);
});

test('siyuan: location option overrides the configured notebook', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.body.notebook, 'box-from-panel');
    return jsonResponse({ code: 0, data: 'doc-1' });
  });
  await siyuan.write(NOTE, { location: 'box-from-panel' }, SIYUAN_CONFIG, env);
});

test('siyuan: code !== 0 fails even with HTTP 200 and surfaces upstream msg', async () => {
  const env = makeEnv(() => jsonResponse({ code: 440, msg: '笔记本不存在', data: null }));
  await assert.rejects(
    () => siyuan.write(NOTE, {}, SIYUAN_CONFIG, env),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /笔记本不存在/);
      assert.match(err.message, /440/);
      return true;
    },
  );
});

test('siyuan: HTTP 429 is translated into a rate-limit message', async () => {
  const env = makeEnv(() => jsonResponse({ code: 1, msg: 'rate limited' }, 429));
  await assert.rejects(
    () => siyuan.write(NOTE, {}, SIYUAN_CONFIG, env),
    (err) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /速率限制|限流|配额/);
      return true;
    },
  );
});

/* -------------------------------------------------------------------- Joplin */

const JOPLIN_CONFIG = config({ joplin: { token: 'jp-token', baseUrl: 'http://127.0.0.1:41184' } });

test('joplin: status configured with token alone (parent notebook is optional)', async () => {
  const env = makeEnv(() => jsonResponse({}));
  const status = await joplin.status(JOPLIN_CONFIG, env);
  assert.equal(status.configured, true);
  assert.match(status.detail, /41184/);
});

test('joplin: options lists folders with token in the query string', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'http://127.0.0.1:41184/folders?token=jp-token');
    assert.equal(req.method, 'GET');
    assert.equal(headerValue(req, 'authorization'), undefined, 'token must not be a header');
    return jsonResponse({ items: [{ id: 'f1', title: 'Inbox' }] });
  });
  const options = await joplin.options(JOPLIN_CONFIG, env);
  assert.deepEqual(options.locations, [{ id: 'f1', label: 'Inbox' }]);
});

test('joplin: write uses token query parameter and omits parent_id when no location', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'http://127.0.0.1:41184/notes?token=jp-token');
    assert.equal(req.method, 'POST');
    assert.equal(headerValue(req, 'authorization'), undefined, 'token must not be a header');
    assert.equal(headerValue(req, 'x-auth-token'), undefined);
    assert.deepEqual(Object.keys(req.body).sort(), ['body', 'source', 'title']);
    assert.equal(req.body.title, 'My Note');
    assert.equal(req.body.body, NOTE.markdown);
    assert.equal(req.body.source, 'dsh-note-save');
    return jsonResponse({ id: 'note-1', title: 'My Note' });
  });
  const result = await joplin.write(NOTE, {}, JOPLIN_CONFIG, env);
  assert.equal(result.created, true);
  assert.equal(result.ref, 'note-1');
  assert.equal(env.requests.length, 1);
});

test('joplin: parent_id is sent only when a location is chosen', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.body.parent_id, 'folder-9');
    return jsonResponse({ id: 'note-2' });
  });
  await joplin.write(NOTE, { location: 'folder-9' }, JOPLIN_CONFIG, env);
});

test('joplin: body over 1 MiB throws before making any request', async () => {
  const env = makeEnv(() => jsonResponse({ id: 'never' }));
  const big = { title: 'big', markdown: 'a'.repeat(1024 * 1024 + 1) };
  await assert.rejects(
    () => joplin.write(big, {}, JOPLIN_CONFIG, env),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /1 ?MiB|1048576/);
      return true;
    },
  );
  assert.equal(env.requests.length, 0, 'must fail before the network call');
});

test('joplin: HTTP 429 is translated into a rate-limit message', async () => {
  const env = makeEnv(() => jsonResponse({ error: 'too many requests' }, 429));
  await assert.rejects(
    () => joplin.write(NOTE, {}, JOPLIN_CONFIG, env),
    (err) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /速率限制|限流|配额/);
      return true;
    },
  );
});

/* -------------------------------------------------------------------- Notion */

const NOTION_DB_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const NOTION_DB_HEX = NOTION_DB_ID.replace(/-/g, '');

const NOTION_CONFIG = config({
  notion: { token: 'secret_x', databaseId: NOTION_DB_ID, titleProperty: 'Name' },
});

test('notion: status requires both token and database id', async () => {
  const env = makeEnv(() => jsonResponse({}));
  const noToken = await notion.status(config({ notion: { databaseId: 'db' } }), env);
  assert.equal(noToken.configured, false);
  assert.match(noToken.detail, /Token/);

  const noDb = await notion.status(config({ notion: { token: 'secret_x' } }), env);
  assert.equal(noDb.configured, false);
  assert.match(noDb.detail, /databaseId/);

  const ok = await notion.status(NOTION_CONFIG, env);
  assert.equal(ok.configured, true);
});

test('notion: options searches databases with Notion-Version header', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'https://api.notion.com/v1/search');
    assert.equal(req.method, 'POST');
    assert.equal(headerValue(req, 'authorization'), 'Bearer secret_x');
    assert.equal(headerValue(req, 'notion-version'), '2022-06-28');
    assert.deepEqual(req.body, {
      filter: { value: 'database', property: 'object' },
      page_size: 100,
    });
    return jsonResponse({ results: [{ object: 'database', id: 'db-1', title: [{ plain_text: 'Notes' }] }] });
  });
  const options = await notion.options(NOTION_CONFIG, env);
  assert.deepEqual(options.locations, [{ id: 'db-1', label: 'Notes' }]);
});

test('notion: successful write creates a page under the database', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'https://api.notion.com/v1/pages');
    assert.equal(req.method, 'POST');
    assert.equal(headerValue(req, 'authorization'), 'Bearer secret_x');
    assert.equal(headerValue(req, 'notion-version'), '2022-06-28');
    assert.equal(headerValue(req, 'content-type'), 'application/json');

    assert.deepEqual(req.body.parent, { database_id: NOTION_DB_HEX });
    assert.deepEqual(req.body.properties, {
      Name: { title: [{ text: { content: 'My Note' } }] },
    });
    assert.equal(req.body.children.length, 2, '### heading + paragraph');
    assert.equal(req.body.children[0].type, 'heading_3');
    assert.equal(req.body.children[1].type, 'paragraph');
    return jsonResponse({ id: 'page-1', url: 'https://www.notion.so/page-1' });
  });
  const result = await notion.write(NOTE, {}, NOTION_CONFIG, env);
  assert.equal(result.created, true);
  assert.equal(result.ref, 'page-1');
  assert.equal(result.url, 'https://www.notion.so/page-1');
  assert.equal(env.requests.length, 1);
});

test('notion: title is hard-truncated to 32 characters', async () => {
  const longTitle = 'A'.repeat(80);
  const env = makeEnv((req) => {
    const content = req.body.properties.Name.title[0].text.content;
    assert.equal(content.length, 32);
    assert.equal(content, 'A'.repeat(32));
    return jsonResponse({ id: 'page-1' });
  });
  await notion.write({ title: longTitle, markdown: 'hello' }, {}, NOTION_CONFIG, env);
});

test('notion: 150 blocks become pages.create(100) then one children PATCH(50)', async () => {
  const markdown = Array.from({ length: 150 }, (_, i) => `paragraph ${i + 1}`).join('\n\n');
  const env = makeEnv((req) => {
    if (req.method === 'POST') {
      assert.equal(req.url, 'https://api.notion.com/v1/pages');
      assert.equal(req.body.children.length, 100);
      return jsonResponse({ id: 'page-1' });
    }
    assert.equal(req.url, 'https://api.notion.com/v1/blocks/page-1/children');
    assert.equal(req.body.children.length, 50);
    return jsonResponse({ results: [] });
  });
  const result = await notion.write({ title: 'Big', markdown }, {}, NOTION_CONFIG, env);
  assert.equal(result.ref, 'page-1');
  assert.equal(env.requests.length, 2, 'exactly one batch call for the remaining 50');
  assert.deepEqual(
    env.requests.map((r) => r.method),
    ['POST', 'PATCH'],
  );
});

test('notion: location overrides the configured database id', async () => {
  const overrideId = 'bbbbbbbbccccccccddddeeeeeeeeeeee';
  const env = makeEnv((req) => {
    assert.deepEqual(req.body.parent, { database_id: overrideId });
    return jsonResponse({ id: 'page-9' });
  });
  await notion.write({ title: 'x', markdown: 'y' }, { location: overrideId }, NOTION_CONFIG, env);
});

test('notion: HTTP 429 is translated into a rate-limit message', async () => {
  const env = makeEnv(() => jsonResponse({ object: 'error', message: 'rate limited' }, 429));
  await assert.rejects(
    () => notion.write(NOTE, {}, NOTION_CONFIG, env),
    (err) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /速率限制|限流|配额/);
      return true;
    },
  );
});

/* ------------------------------------------------------- markdownToBlocks unit */

test('markdownToBlocks: headings 1-3 are native, deeper headings degrade to paragraph', () => {
  const blocks = markdownToBlocks('# One\n## Two\n### Three\n#### Four');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['heading_1', 'heading_2', 'heading_3', 'paragraph'],
  );
  assert.equal(blocks[0].heading_1.rich_text[0].text.content, 'One');
  assert.equal(blocks[2].heading_3.rich_text[0].text.content, 'Three');
  assert.equal(blocks[3].paragraph.rich_text[0].text.content, '#### Four', 'raw text is preserved');
});

test('markdownToBlocks: bulleted list keeps one nesting level', () => {
  const blocks = markdownToBlocks('- one\n  - nested\n- two');
  assert.deepEqual(blocks.map((b) => b.type), ['bulleted_list_item', 'bulleted_list_item']);
  assert.equal(blocks[0].bulleted_list_item.rich_text[0].text.content, 'one');
  assert.equal(blocks[0].children.length, 1);
  assert.equal(blocks[0].children[0].bulleted_list_item.rich_text[0].text.content, 'nested');
  assert.equal(blocks[1].bulleted_list_item.rich_text[0].text.content, 'two');
  assert.equal(blocks[1].children, undefined);
});

test('markdownToBlocks: numbered list items are separate blocks', () => {
  const blocks = markdownToBlocks('1. first\n2. second');
  assert.deepEqual(blocks.map((b) => b.type), ['numbered_list_item', 'numbered_list_item']);
  assert.equal(blocks[1].numbered_list_item.rich_text[0].text.content, 'second');
});

test('markdownToBlocks: fenced code blocks keep raw content and map the language', () => {
  const NL = String.fromCharCode(10);
  const md = ['```js', 'const a = 1;', '', 'const b = 2;', '```'].join(NL);
  const blocks = markdownToBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'code');
  assert.equal(blocks[0].code.language, 'javascript');
  assert.equal(blocks[0].code.rich_text[0].text.content, ['const a = 1;', '', 'const b = 2;'].join(NL));
});

test('markdownToBlocks: blockquote, divider and inline styles', () => {
  const blocks = markdownToBlocks('> quoted **bold**\n\n---\n\nplain *it* and `code`');
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['quote', 'divider', 'paragraph'],
  );
  const quoteRuns = blocks[0].quote.rich_text;
  assert.equal(quoteRuns.map((r) => r.text.content).join(''), 'quoted bold');
  const quoteBold = quoteRuns.find((r) => r.text.content === 'bold');
  assert.equal(quoteBold.annotations.bold, true);
  const quotePlain = quoteRuns.find((r) => r.text.content === 'quoted ');
  assert.equal(quotePlain.annotations, undefined, 'plain runs carry no annotations');
  const inlineRuns = blocks[2].paragraph.rich_text;
  const italic = inlineRuns.find((r) => r.text.content === 'it');
  assert.equal(italic.annotations.italic, true);
  const code = inlineRuns.find((r) => r.text.content === 'code');
  assert.equal(code.annotations.code, true);
});

test('markdownToBlocks: long paragraph splits under the 2000-char rich-text limit', () => {
  const long = 'x'.repeat(2500);
  const blocks = markdownToBlocks(long);
  assert.equal(blocks.length, 1);
  const runs = blocks[0].paragraph.rich_text;
  assert.equal(runs.length, 2);
  assert.equal(runs[0].text.content.length, 2000);
  assert.equal(runs[1].text.content.length, 500);
  assert.equal(runs.map((r) => r.text.content).join(''), long);
});

test('markdownToBlocks: unsupported markdown degrades to paragraphs (never dropped)', () => {
  const md = '| a | b |\n| - | - |\n| 1 | 2 |';
  const blocks = markdownToBlocks(md);
  const text = blocks
    .map((b) => (b.paragraph ? b.paragraph.rich_text.map((r) => r.text.content).join('') : ''))
    .join('\n');
  assert.ok(blocks.length >= 1);
  assert.match(text, /\| a \| b \|/, 'table source text survives');
  assert.match(text, /\| 1 \| 2 \|/);

  const empty = markdownToBlocks('');
  assert.deepEqual(empty, []);
});

/* --------------------------------------------------------------------- Yuque */

const YUQUE_CONFIG = config({
  yuque: { token: 'yq-token', repoId: 'repo-1', repoName: '知识库', login: 'alice', repoSlug: 'kb' },
});

test('yuque: status requires token and repo id', async () => {
  const env = makeEnv(() => jsonResponse({}));
  const noToken = await yuque.status(config({ yuque: { repoId: 'repo-1' } }), env);
  assert.equal(noToken.configured, false);
  assert.match(noToken.detail, /Token/);

  const noRepo = await yuque.status(config({ yuque: { token: 'yq-token' } }), env);
  assert.equal(noRepo.configured, false);

  const ok = await yuque.status(YUQUE_CONFIG, env);
  assert.equal(ok.configured, true);
  assert.match(ok.detail, /知识库/);
});

test('yuque: options returns the configured repo without a network call', async () => {
  const env = makeEnv(() => jsonResponse({}));
  const options = await yuque.options(YUQUE_CONFIG, env);
  assert.deepEqual(options.locations, [{ id: 'repo-1', label: '知识库' }]);
  assert.equal(env.requests.length, 0);
});

test('yuque: successful write creates the doc THEN appends it to the TOC', async () => {
  const env = makeEnv((req, index) => {
    if (index === 0) {
      assert.equal(req.method, 'POST');
      assert.equal(req.url, 'https://www.yuque.com/api/v2/repos/repo-1/docs');
      assert.equal(headerValue(req, 'x-auth-token'), 'yq-token');
      assert.equal(headerValue(req, 'content-type'), 'application/json');
      assert.equal(req.body.title, 'My Note');
      assert.equal(req.body.format, 'markdown');
      assert.equal(req.body.body, NOTE.markdown);
      assert.equal(typeof req.body.slug, 'string');
      assert.match(req.body.slug, /^\d+$/);
      return jsonResponse({ data: { id: 42, slug: 'abc123', title: 'My Note' } });
    }
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, 'https://www.yuque.com/api/v2/repos/repo-1/toc');
    assert.equal(headerValue(req, 'x-auth-token'), 'yq-token');
    assert.deepEqual(req.body, { action: 'appendNode', action_mode: 'append', doc_ids: [42] });
    return jsonResponse({ data: { id: 7 } });
  });

  const result = await yuque.write(NOTE, {}, YUQUE_CONFIG, env);
  assert.deepEqual(
    env.requests.map((r) => `${r.method} ${r.url.replace('https://www.yuque.com', '')}`),
    ['POST /api/v2/repos/repo-1/docs', 'PUT /api/v2/repos/repo-1/toc'],
    'create-doc must happen before toc append',
  );
  assert.equal(result.created, true);
  assert.equal(result.ref, '42');
  assert.equal(result.url, 'https://www.yuque.com/alice/kb/abc123');
});

test('yuque: TOC failure is reported as a partial failure naming the created doc', async () => {
  const env = makeEnv((req, index) => {
    if (index === 0) return jsonResponse({ data: { id: 42, slug: 'abc123', title: 'My Note' } });
    return jsonResponse({ message: '目录操作失败' }, 500);
  });
  await assert.rejects(
    () => yuque.write(NOTE, {}, YUQUE_CONFIG, env),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /部分失败/);
      assert.match(err.message, /42/, 'names the created doc id');
      assert.match(err.message, /abc123/, 'names the created doc url/slug');
      assert.match(err.message, /目录操作失败/, 'carries the upstream reason');
      return true;
    },
  );
  assert.equal(env.requests.length, 2, 'both steps were attempted');
});

test('yuque: HTTP 429 mentions the quota in human terms', async () => {
  const env = makeEnv(() => jsonResponse({ message: 'rate limited' }, 429));
  await assert.rejects(
    () => yuque.write(NOTE, {}, YUQUE_CONFIG, env),
    (err) => {
      assert.match(err.message, /429/);
      assert.match(err.message, /配额|限流|速率限制/);
      return true;
    },
  );
});

test('notion: exactly 100 blocks needs no follow-up children call', async () => {
  const markdown = Array.from({ length: 100 }, (_, i) => `p ${i + 1}`).join('\n\n');
  const env = makeEnv(() => jsonResponse({ id: 'page-100' }));
  await notion.write({ title: 'Exact', markdown }, {}, NOTION_CONFIG, env);
  assert.equal(env.requests.length, 1, 'no empty PATCH for an exact multiple');
  assert.equal(env.requests[0].body.children.length, 100);
});

/* ---------------------------------------------------------------- misc guards */

test('all adapters reject empty markdown without making a request', async () => {
  for (const [adapter, cfg] of [
    [siyuan, SIYUAN_CONFIG],
    [joplin, JOPLIN_CONFIG],
    [notion, NOTION_CONFIG],
    [yuque, YUQUE_CONFIG],
  ]) {
    const env = makeEnv(() => jsonResponse({}));
    await assert.rejects(
      () => adapter.write({ title: 't', markdown: '   ' }, {}, cfg, env),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /markdown|内容/);
        return true;
      },
    );
    assert.equal(env.requests.length, 0, `${adapter.id}: no request for empty content`);
  }
});

test('every adapter attaches an abort signal to its write request', async () => {
  const cases = [
    [siyuan, SIYUAN_CONFIG, jsonResponse({ code: 0, data: 'doc-1' })],
    [joplin, JOPLIN_CONFIG, jsonResponse({ id: 'note-1' })],
    [notion, NOTION_CONFIG, jsonResponse({ id: 'page-1' })],
    [
      yuque,
      YUQUE_CONFIG,
      (req) =>
        req.method === 'POST'
          ? jsonResponse({ data: { id: 1, slug: 's1' } })
          : jsonResponse({ data: { id: 2 } }),
    ],
  ];
  for (const [adapter, cfg, reply] of cases) {
    const env = makeEnv((req) => (typeof reply === 'function' ? reply(req) : reply));
    await adapter.write(NOTE, {}, cfg, env);
    assert.ok(env.requests.length >= 1, `${adapter.id}: made a request`);
    for (const req of env.requests) {
      assert.ok(req.signal, `${adapter.id}: request carries an AbortSignal (timeout)`);
    }
  }
});

test('network failures surface as readable Errors, not raw TypeError', async () => {
  const boom = { fetch: async () => { throw new TypeError('fetch failed'); } };
  for (const [adapter, cfg] of [
    [siyuan, SIYUAN_CONFIG],
    [joplin, JOPLIN_CONFIG],
    [notion, NOTION_CONFIG],
    [yuque, YUQUE_CONFIG],
  ]) {
    await assert.rejects(
      () => adapter.write(NOTE, {}, cfg, boom),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /无法连接|网络/);
        return true;
      },
    );
  }
});

/* ------------------------------------- fields metadata + read-only test() probe */

const ALL_ADAPTERS = { siyuan, joplin, notion, yuque };

/** Must stay identical to the keys of `config.targets.<id>` (lib/config.js). */
const EXPECTED_FIELD_KEYS = {
  siyuan: ['baseUrl', 'token', 'notebook'],
  joplin: ['baseUrl', 'token', 'folder'],
  notion: ['token', 'databaseId', 'titleProperty'],
  yuque: ['token', 'repoId', 'login', 'repoSlug'],
};

const FIELD_TYPES = ['text', 'password', 'url'];
const FIELD_SHAPE = ['help', 'key', 'label', 'placeholder', 'required', 'secret', 'type'];
const CJK = /[\u4e00-\u9fff]/;

/**
 * `test()` must be strictly read-only. Only GETs are expected, plus SiYuan's
 * notebook listing — `POST /api/notebook/lsNotebooks` is a read endpoint and is
 * the single POST these adapters are allowed to make while probing.
 */
const WRITE_URL_MARKERS = [
  '/api/filetree/createDocWithMd',
  '/notes?',
  '/v1/pages',
  '/blocks/',
  '/docs',
  '/toc',
];

function assertReadOnlyProbe(name, requests) {
  for (const req of requests) {
    assert.ok(['GET', 'POST'].includes(req.method), `${name}: unexpected method ${req.method}`);
    if (req.method === 'POST') {
      assert.equal(
        req.url,
        'http://127.0.0.1:6806/api/notebook/lsNotebooks',
        `${name}: the only POST allowed in test() is SiYuan lsNotebooks (got ${req.url})`,
      );
    }
    for (const marker of WRITE_URL_MARKERS) {
      assert.ok(
        !req.url.includes(marker),
        `${name}: test() touched a write endpoint (${marker}) at ${req.url}`,
      );
    }
  }
}

test('fields: every adapter exposes a plain array with the documented shape', () => {
  for (const [name, adapter] of Object.entries(ALL_ADAPTERS)) {
    assert.equal(
      typeof adapter.fields,
      'object',
      `${name}: fields must be a plain array property, not a function`,
    );
    assert.ok(Array.isArray(adapter.fields), `${name}: fields is an array`);
    assert.ok(adapter.fields.length > 0, `${name}: fields is non-empty`);
    assert.deepEqual(
      adapter.fields.map((field) => field.key),
      EXPECTED_FIELD_KEYS[name],
      `${name}: field keys must match config.targets.${name}`,
    );

    const seen = new Set();
    for (const field of adapter.fields) {
      assert.deepEqual(
        Object.keys(field).sort(),
        FIELD_SHAPE,
        `${name}/${field.key}: entry shape is { key, label, type, placeholder, required, secret, help }`,
      );
      assert.equal(typeof field.key, 'string', `${name}: key is a string`);
      assert.ok(field.key.length > 0, `${name}: key is non-empty`);
      assert.ok(!seen.has(field.key), `${name}: duplicate field key ${field.key}`);
      seen.add(field.key);
      assert.ok(
        FIELD_TYPES.includes(field.type),
        `${name}/${field.key}: type "${field.type}" is one of ${FIELD_TYPES.join(' | ')}`,
      );
      for (const property of ['label', 'placeholder', 'help']) {
        assert.equal(typeof field[property], 'string', `${name}/${field.key}: ${property} is a string`);
        assert.ok(field[property].trim().length > 0, `${name}/${field.key}: ${property} is non-empty`);
        assert.match(field[property], CJK, `${name}/${field.key}: ${property} is user-facing Chinese`);
      }
      assert.equal(typeof field.required, 'boolean', `${name}/${field.key}: required is a boolean`);
      assert.equal(typeof field.secret, 'boolean', `${name}/${field.key}: secret is a boolean`);
      assert.equal(field.secret, field.key === 'token', `${name}/${field.key}: only token is secret`);
    }
  }
});

test('fields: every key really exists in the resolved config defaults', async () => {
  const resolved = await readConfig({});
  for (const [name, adapter] of Object.entries(ALL_ADAPTERS)) {
    const defaults = resolved.targets && resolved.targets[name];
    assert.ok(defaults && typeof defaults === 'object', `${name}: config.targets.${name} defaults exist`);
    for (const field of adapter.fields) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(defaults, field.key),
        `${name}: config.targets.${name} has no "${field.key}" key`,
      );
    }
  }
});

test('test(): unconfigured adapters return ok=false without any request', async () => {
  for (const [name, adapter] of Object.entries(ALL_ADAPTERS)) {
    const env = makeEnv(() => {
      throw new Error(`${name}: unconfigured test() must not make requests`);
    });
    for (const cfg of [undefined, {}, { targets: {} }, { targets: { [name]: {} } }]) {
      const result = await adapter.test(cfg, env);
      assert.equal(result.ok, false, `${name}: ok is false`);
      assert.equal(typeof result.detail, 'string', `${name}: detail is a string`);
      assert.ok(result.detail.length > 0, `${name}: detail explains the gap`);
      assert.match(result.detail, /未配置/, `${name}: detail says what is missing`);
    }
    assert.equal(env.requests.length, 0, `${name}: no request before validation`);
  }
});

test('test(): a token alone is not enough — partial config makes no request', async () => {
  const cases = [
    ['siyuan', siyuan, { targets: { siyuan: { token: 'syt-token' } } }, /笔记本/],
    ['notion', notion, { targets: { notion: { token: 'secret_x' } } }, /databaseId/],
    ['yuque', yuque, { targets: { yuque: { token: 'yq-token' } } }, /repoId/],
  ];
  for (const [name, adapter, cfg, expected] of cases) {
    const env = makeEnv(() => {
      throw new Error(`${name}: partial config must not make requests`);
    });
    const result = await adapter.test(cfg, env);
    assert.equal(result.ok, false, `${name}: ok is false`);
    assert.match(result.detail, expected, `${name}: detail names the missing field`);
    assert.equal(env.requests.length, 0, `${name}: no request`);
  }
});

test('siyuan: test() probes only lsNotebooks and reports the notebook count', async () => {
  const env = makeEnv((req) => {
    assert.equal(req.url, 'http://127.0.0.1:6806/api/notebook/lsNotebooks');
    assert.equal(req.method, 'POST');
    assert.equal(headerValue(req, 'authorization'), 'Token syt-token');
    assert.ok(req.signal, 'probe carries the 20s abort signal');
    return jsonResponse({
      code: 0,
      data: { notebooks: [{ id: 'box-1', name: '工作' }, { id: 'box-2', name: '生活' }] },
    });
  });
  const result = await siyuan.test(SIYUAN_CONFIG, env);
  assert.equal(result.ok, true);
  assert.match(result.detail, /2/, 'reports the notebook count');
  assert.equal(env.requests.length, 1, 'exactly one read-only request');
  assertReadOnlyProbe('siyuan', env.requests);
});

test('siyuan: test() is ok but warns when the configured notebook is missing', async () => {
  const env = makeEnv(() => jsonResponse({ code: 0, data: { notebooks: [{ id: 'other', name: '别的' }] } }));
  const result = await siyuan.test(SIYUAN_CONFIG, env); // configured notebook box-1 is absent
  assert.equal(result.ok, true, 'the kernel is reachable, so connectivity is ok');
  assert.match(result.detail, /找不到该笔记本/);
});

test('siyuan: test() maps code !== 0 to ok=false with the upstream reason', async () => {
  const env = makeEnv(() => jsonResponse({ code: 401, msg: 'token invalid' }));
  const result = await siyuan.test(SIYUAN_CONFIG, env);
  assert.equal(result.ok, false);
  assert.match(result.detail, /token invalid/);
  assert.match(result.detail, /401/);
});

test('joplin: test() pings then validates the token via folders', async () => {
  const env = makeEnv((req) => {
    if (req.url === 'http://127.0.0.1:41184/ping') {
      assert.equal(req.method, 'GET');
      assert.equal(headerValue(req, 'authorization'), undefined, 'ping must not need a token');
      return { status: 200, text: 'JoplinClipperServer' };
    }
    assert.equal(req.url, 'http://127.0.0.1:41184/folders?token=jp-token');
    assert.equal(req.method, 'GET');
    return jsonResponse({ items: [{ id: 'f1', title: 'Inbox' }] });
  });
  const result = await joplin.test(JOPLIN_CONFIG, env);
  assert.equal(result.ok, true);
  assert.match(result.detail, /Token 有效/);
  assert.match(result.detail, /1 个笔记本/);
  assert.deepEqual(env.requests.map((r) => r.method), ['GET', 'GET']);
  assertReadOnlyProbe('joplin', env.requests);
});

test('joplin: test() distinguishes a down Web Clipper from a bad token', async () => {
  const down = makeEnv(() => ({ status: 500, text: 'boom' }));
  const downResult = await joplin.test(JOPLIN_CONFIG, down);
  assert.equal(downResult.ok, false);
  assert.match(downResult.detail, /Web Clipper/, 'names the Web Clipper');
  assert.match(downResult.detail, /500/, 'keeps the HTTP status');
  assert.equal(down.requests.length, 1, 'stops after the failed ping');

  const badToken = makeEnv((req) =>
    req.url.endsWith('/ping')
      ? { status: 200, text: 'JoplinClipperServer' }
      : jsonResponse({ error: 'Invalid token' }, 403),
  );
  const badResult = await joplin.test(JOPLIN_CONFIG, badToken);
  assert.equal(badResult.ok, false);
  assert.match(badResult.detail, /Token/);
  assert.match(badResult.detail, /403/);
  assert.match(badResult.detail, /Invalid token/);
});

test('notion: test() validates the token with users/me then the database', async () => {
  const env = makeEnv((req) => {
    if (req.url === 'https://api.notion.com/v1/users/me') {
      assert.equal(req.method, 'GET');
      assert.equal(headerValue(req, 'authorization'), 'Bearer secret_x');
      assert.equal(headerValue(req, 'notion-version'), '2022-06-28');
      return jsonResponse({ object: 'user', name: 'DSH Bot' });
    }
    assert.equal(req.url, `https://api.notion.com/v1/databases/${NOTION_DB_HEX}`);
    assert.equal(req.method, 'GET');
    assert.equal(headerValue(req, 'authorization'), 'Bearer secret_x');
    assert.equal(headerValue(req, 'notion-version'), '2022-06-28');
    return jsonResponse({ object: 'database', id: NOTION_DB_HEX, title: [{ plain_text: '我的笔记库' }] });
  });
  const result = await notion.test(NOTION_CONFIG, env);
  assert.equal(result.ok, true);
  assert.match(result.detail, /DSH Bot/);
  assert.match(result.detail, /我的笔记库/);
  assert.equal(env.requests.length, 2);
  assertReadOnlyProbe('notion', env.requests);
});

test('notion: test() separates token failure from database access failure', async () => {
  const dbDenied = makeEnv((req) =>
    req.url.endsWith('/v1/users/me')
      ? jsonResponse({ name: 'bot' })
      : jsonResponse({ object: 'error', message: 'Could not find database' }, 404),
  );
  const result = await notion.test(NOTION_CONFIG, dbDenied);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Token 已通过校验/, 'the token itself was fine');
  assert.match(result.detail, /404/);
  assert.match(result.detail, /databaseId|数据库/);
});

test('yuque: test() validates the token with /user then the repo', async () => {
  const env = makeEnv((req) => {
    if (req.url === 'https://www.yuque.com/api/v2/user') {
      assert.equal(req.method, 'GET');
      assert.equal(headerValue(req, 'x-auth-token'), 'yq-token');
      return jsonResponse({ data: { id: 1, login: 'alice', name: 'Alice' } });
    }
    assert.equal(req.url, 'https://www.yuque.com/api/v2/repos/repo-1');
    assert.equal(req.method, 'GET');
    assert.equal(headerValue(req, 'x-auth-token'), 'yq-token');
    return jsonResponse({ data: { id: 'repo-1', name: '知识库' } });
  });
  const result = await yuque.test(YUQUE_CONFIG, env);
  assert.equal(result.ok, true);
  assert.match(result.detail, /alice/);
  assert.match(result.detail, /知识库/);
  assert.equal(env.requests.length, 2);
  assertReadOnlyProbe('yuque', env.requests);
});

test('yuque: test() separates token failure from repo access failure', async () => {
  const repoDenied = makeEnv((req) =>
    req.url.endsWith('/api/v2/user')
      ? jsonResponse({ data: { login: 'alice' } })
      : jsonResponse({ message: '没有权限' }, 403),
  );
  const result = await yuque.test(YUQUE_CONFIG, repoDenied);
  assert.equal(result.ok, false);
  assert.match(result.detail, /Token 已通过校验/, 'the token itself was fine');
  assert.match(result.detail, /403/);
  assert.match(result.detail, /repoId|知识库/);
});

test('test(): a 401 from the token probe becomes ok=false naming the token', async () => {
  const cases = [
    ['siyuan', siyuan, SIYUAN_CONFIG, () => jsonResponse({ code: 401, msg: 'token invalid' }, 401)],
    [
      'joplin',
      joplin,
      JOPLIN_CONFIG,
      (req) =>
        req.url.endsWith('/ping')
          ? { status: 200, text: 'JoplinClipperServer' }
          : jsonResponse({ error: 'Invalid token' }, 401),
    ],
    ['notion', notion, NOTION_CONFIG, () => jsonResponse({ object: 'error', message: 'unauthorized' }, 401)],
    ['yuque', yuque, YUQUE_CONFIG, () => jsonResponse({ message: 'unauthorized' }, 401)],
  ];
  for (const [name, adapter, cfg, reply] of cases) {
    const env = makeEnv((req) => reply(req));
    const result = await adapter.test(cfg, env);
    assert.equal(result.ok, false, `${name}: ok is false`);
    assert.match(result.detail, /Token/, `${name}: names the token`);
    assert.match(result.detail, /401/, `${name}: keeps the HTTP status`);
  }
});

test('test(): network failures return ok=false instead of throwing a raw TypeError', async () => {
  const boom = {
    fetch: async () => {
      throw new TypeError('fetch failed');
    },
  };
  const cases = [
    ['siyuan', siyuan, SIYUAN_CONFIG],
    ['joplin', joplin, JOPLIN_CONFIG],
    ['notion', notion, NOTION_CONFIG],
    ['yuque', yuque, YUQUE_CONFIG],
  ];
  for (const [name, adapter, cfg] of cases) {
    const result = await adapter.test(cfg, boom);
    assert.equal(result.ok, false, `${name}: ok is false`);
    assert.equal(typeof result.detail, 'string', `${name}: detail is a string`);
    assert.match(result.detail, /无法连接|网络/, `${name}: translated into human language`);
    assert.doesNotMatch(result.detail, /^TypeError/, `${name}: not a raw TypeError message`);
  }
});

test('test(): every probe stays read-only (GETs + SiYuan lsNotebooks only)', async () => {
  const cases = [
    [
      'siyuan',
      siyuan,
      SIYUAN_CONFIG,
      () => jsonResponse({ code: 0, data: { notebooks: [{ id: 'box-1', name: '工作' }] } }),
    ],
    [
      'joplin',
      joplin,
      JOPLIN_CONFIG,
      (req) =>
        req.url.endsWith('/ping') ? { status: 200, text: 'JoplinClipperServer' } : jsonResponse({ items: [] }),
    ],
    [
      'notion',
      notion,
      NOTION_CONFIG,
      (req) =>
        req.url.endsWith('/users/me')
          ? jsonResponse({ name: 'bot' })
          : jsonResponse({ id: NOTION_DB_HEX, title: [] }),
    ],
    [
      'yuque',
      yuque,
      YUQUE_CONFIG,
      (req) =>
        req.url.endsWith('/api/v2/user')
          ? jsonResponse({ data: { login: 'alice' } })
          : jsonResponse({ data: { name: '知识库' } }),
    ],
  ];
  for (const [name, adapter, cfg, reply] of cases) {
    const env = makeEnv((req) => reply(req));
    const result = await adapter.test(cfg, env);
    assert.equal(result.ok, true, `${name}: probe succeeds against a permissive mock`);
    assert.ok(env.requests.length >= 1, `${name}: probe made at least one request`);
    assertReadOnlyProbe(name, env.requests);
  }
});
