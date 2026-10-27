import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../store.mjs';
import { createApp } from '../server.mjs';
import { createZotero } from '../zotero.mjs';
import { normalizeZotero, normalizeDiscussion, normalizeGaps, parseZoteroLink, zoteroLinks, contextFields, restoreDraft, learningIndex, buildRequest, newDiscussionUrl } from '../dist/context.mjs';
import { tryCopy } from '../dist/clipboard.mjs';
import { draftMarkdown } from '../dist/categories.mjs';

const discussionUrl = 'codex://threads/00000000-0000-4000-8000-000000000001';
const gap = { id: '00000000-0000-4000-8000-000000000002', text: 'rollout 和 GPU 是什么关系？', done: false };
const zotero = normalizeZotero({ library: 'user', itemKey: 'PAPER001', attachmentKey: 'PDF00001', title: 'TrEnv', authors: 'Huang 等', year: '2024', page: 4 });
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reading-connections-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = path.join(root, 'template.md'), directory = path.join(root, 'notes');
  const body = '## 它在解决什么问题？\n\n我自己写的理解。\n\n## 作者怎么分析这个问题？\n\n## 大概怎么做？\n\n## 我卡在哪里？\n';
  await writeFile(template, body);
  return { root, template, directory, body, store: createStore(directory, template) };
}
test('all optional associations persist across reload/export and old clients preserve them byte-for-byte in body', async t => {
  const f = await fixture(t), note = await f.store.create();
  const saved = await f.store.save(note.id, { ...note, zotero, discussionUrl, learningGaps: [gap] });
  const fresh = await createStore(f.directory, f.template).get(note.id);
  assert.deepEqual(contextFields(fresh), { zotero, discussionUrl, learningGaps: [gap] });
  assert.equal(fresh.body, f.body);
  const oldClient = await f.store.save(note.id, { title: saved.title, body: f.body, version: saved.version });
  assert.deepEqual(contextFields(oldClient), contextFields(saved));
  for (const raw of [(await f.store.download(note.id)).raw, draftMarkdown(saved)]) {
    assert.match(raw, /"attachmentKey":"PDF00001"/); assert.match(raw, /discussionUrl: "codex:\/\/threads\//); assert.match(raw, /learningGaps:.*rollout/); assert.ok(raw.endsWith(f.body));
  }
  const cleared = await f.store.save(note.id, { ...oldClient, zotero: null, discussionUrl: '', learningGaps: [] });
  assert.deepEqual(contextFields(cleared), contextFields({})); assert.equal(cleared.body, f.body);
});
test('reading legacy metadata does not migrate files', async t => {
  const f = await fixture(t), note = await f.store.create();
  const file = path.join(f.directory, note.filename), before = await readFile(file, 'utf8');
  assert.deepEqual(contextFields(await f.store.get(note.id)), { zotero: null, discussionUrl: '', learningGaps: [] });
  await f.store.all(); assert.equal(await readFile(file, 'utf8'), before);
});
test('metadata saves enforce versions; invalid links and fields never write', async t => {
  const f = await fixture(t), note = await f.store.create();
  for (const fields of [{ discussionUrl: 'https://chatgpt.com/share/secret' }, { zotero: { ...zotero, itemKey: '../../etc' } }, { zotero: { ...zotero, page: -3 } }, { learningGaps: [gap, gap] }, { learningGaps: [{ ...gap, done: 'yes' }] }]) {
    await assert.rejects(f.store.save(note.id, { ...note, ...fields }), { status: 400 });
    assert.equal((await f.store.get(note.id)).version, note.version);
  }
  const saved = await f.store.save(note.id, { ...note, discussionUrl });
  await assert.rejects(f.store.save(note.id, { ...note, learningGaps: [gap] }), { status: 409 });
  assert.equal((await f.store.get(note.id)).version, saved.version);
});
test('strict local conversation link allowlist rejects credentials, queries and spoofed protocols', () => {
  assert.equal(normalizeDiscussion(` ${discussionUrl} `), discussionUrl);
  assert.equal(normalizeDiscussion(''), '');
  for (const bad of ['javascript:alert(1)', 'codex://threads/new', `${discussionUrl}?prompt=send`, `${discussionUrl}#hash`, `${discussionUrl}/`, 'codex://user@threads/1234', 'codex://threads/not-a-thread', 'https://example.com', 42]) assert.throws(() => normalizeDiscussion(bad));
});
test('Zotero item/PDF IDs are distinct and only allowed native links can be constructed', () => {
  assert.deepEqual(zoteroLinks(zotero), { item: 'zotero://select/library/items/PAPER001', pdf: 'zotero://open-pdf/library/items/PDF00001?page=4' });
  const manual = parseZoteroLink('zotero://open-pdf/library/items/PDF00001?page=2');
  assert.equal(manual.itemKey, ''); assert.equal(manual.attachmentKey, 'PDF00001'); assert.equal(manual.page, 2);
  assert.equal(zoteroLinks(parseZoteroLink('zotero://select/groups/123/items/PAPER001')).item, 'zotero://select/groups/123/items/PAPER001');
  assert.equal(zoteroLinks({ ...zotero, page: null }).pdf, 'zotero://open-pdf/library/items/PDF00001');
  assert.equal(zoteroLinks({ ...zotero, attachmentKey: '' }).pdf, '');
  for (const bad of ['https://zotero.org', 'zotero://select/library/items/PAPER001?x=1', 'zotero://open-pdf/library/items/PDF00001?page=0', 'zotero://open-pdf/library/items/PDF00001?page=2&url=https://evil', 'zotero://select/library/items/../etc', 'zotero://open-pdf/library/items/PDF00001#x']) assert.throws(() => parseZoteroLink(bad));
  assert.throws(() => normalizeZotero({ ...zotero, attachmentKey: zotero.itemKey }));
});
test('gaps aggregate across cards, default to pending, retain sources, and are manually marked', () => {
  const notes = [{ id: 'one', title: 'TrEnv', learningGaps: [gap] }, { id: 'two', title: 'DSec', learningGaps: [{ ...gap, done: true }] }, { id: 'legacy' }];
  assert.deepEqual(learningIndex(notes).map(g => g.noteId), ['one']);
  assert.equal(learningIndex(notes, true).length, 2); assert.equal(learningIndex(notes, true)[1].title, 'DSec');
  assert.equal(normalizeGaps([gap])[0].done, false);
  assert.throws(() => normalizeGaps([{ ...gap, text: '' }]));
});
test('review request has grounded read-only guidance and source paths, not the paper or body', () => {
  const note = { title: 'TrEnv', filename: '我的泛读.md', version: 'saved-version', zotero, discussionUrl, body: 'PRIVATE_BODY_MARKER' };
  const prompt = buildRequest(note, '/example/workspace/handmade', '请补 rollout');
  for (const expected of ['我的泛读.md', 'saved-version', 'PAPER001', 'PDF00001?page=4', '理解正确', '表达不清或不完整', '与原文矛盾', '证据不足', '最多', '三个', '章节、页码或图号', '不能把没写到', '最少背景', '一个例子', '一个自检问题', '不改笔记', '不创建知识点笔记', '请补 rollout']) assert.ok(prompt.includes(expected), expected);
  assert.ok(!prompt.includes(note.body));
  const url = new URL(newDiscussionUrl(prompt, '/example/workspace'));
  assert.equal(url.protocol, 'codex:'); assert.equal(url.host, 'threads'); assert.equal(url.pathname, '/new');
  assert.equal(url.searchParams.get('prompt'), prompt); assert.equal(url.searchParams.get('path'), '/example/workspace');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['path', 'prompt']);
  assert.match(buildRequest({ ...note, zotero: null }, '/notes'), /无法取得原文时请明确说明/);
});
const paper = { key: 'PAPER001', data: { itemType: 'conferencePaper', title: 'TrEnv', creators: [{ firstName: 'A', lastName: 'Huang' }], date: '2024-11-04' } };
const pdf = key => ({ key, data: { itemType: 'attachment', parentItem: 'PAPER001', contentType: 'application/pdf', title: 'Full Text PDF' } });
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
test('draft recovery preserves new fields and old drafts do not erase associations', () => {
  const note = { title: 'TrEnv', body: '正文', version: 'disk', zotero, discussionUrl, learningGaps: [gap] };
  const oldDraft = { title: '草稿', body: '未保存输入', version: 'older' };
  assert.deepEqual(contextFields(restoreDraft(note, oldDraft)), contextFields(note));
  const newDraft = { ...oldDraft, zotero: { ...zotero, page: 9 }, discussionUrl: '', learningGaps: [{ ...gap, done: true }] };
  const restored = restoreDraft(note, newDraft);
  assert.equal(restored.version, 'older'); assert.equal(restored.body, '未保存输入');
  assert.deepEqual(contextFields(restored), contextFields(newDraft));
});
test('clipboard rejection returns failure without claiming that anything was copied', async () => {
  assert.equal(await tryCopy(async () => { throw new Error('Permission denied'); }, 'request'), false);
  assert.equal(await tryCopy(() => { throw new TypeError('clipboard unavailable'); }, 'request'), false);
  let copied = ''; assert.equal(await tryCopy(async text => { copied = text; }, 'request'), true); assert.equal(copied, 'request');
});
test('malformed external metadata cannot turn into executable links or be silently rewritten', async t => {
  const f = await fixture(t), note = await f.store.create();
  const file = path.join(f.directory, note.filename);
  const raw = (await readFile(file, 'utf8')).replace('type: "reading-card"', 'type: "reading-card"\ndiscussionUrl: "javascript:alert(1)"');
  await writeFile(file, raw);
  await assert.rejects(f.store.get(note.id), { status: 422 }); assert.equal(await readFile(file, 'utf8'), raw);
});
test('Zotero adapter only makes bounded read-only requests to the fixed localhost personal library', async () => {
  const calls = [];
  const client = createZotero(async (url, options) => { calls.push({ url, options }); return reply(url.includes('/children') ? [pdf('PDF00001'), pdf('ABCD1234'), { ...pdf('NOHTML12'), data: { ...pdf('NOHTML12').data, contentType: 'text/html' } }] : url.includes('/top?') ? [paper] : paper); });
  const found = await client.search('TrEnv & CXL'); assert.equal(found[0].authors, 'A Huang'); assert.equal(found[0].year, '2024');
  assert.equal((await client.item('PAPER001')).itemKey, 'PAPER001'); assert.equal((await client.attachments('PAPER001')).length, 2);
  for (const call of calls) { assert.ok(call.url.startsWith('http://127.0.0.1:23119/api/users/0/')); assert.equal(call.options.method, 'GET'); assert.equal(call.options.redirect, 'error'); assert.ok(call.options.signal); }
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'TrEnv & CXL');
  assert.equal(new URL(calls[0].url).searchParams.get('limit'), '30');
  await assert.rejects(client.item('../../evil'), { status: 400 }); await assert.rejects(client.search(''), { status: 400 });
  assert.equal(calls.length, 3);
});
test('Zotero offline, permission disabled, deleted item, malformed data and no PDFs have explicit outcomes', async () => {
  await assert.rejects(createZotero(async () => { throw new TypeError('offline'); }).search('TrEnv'), error => error.status === 503 && error.message.includes('不会丢失'));
  await assert.rejects(createZotero(async () => reply({}, 403)).item('PAPER001'), error => error.status === 503 && error.message.includes('允许'));
  await assert.rejects(createZotero(async () => reply({}, 404)).item('PAPER001'), { status: 404 });
  await assert.rejects(createZotero(async () => reply({ nope: 1 })).search('TrEnv'), { status: 502 });
  assert.deepEqual(await createZotero(async () => reply([])).attachments('PAPER001'), []);
});
test('HTTP Zotero routes do not accept arbitrary proxies, writes or cross-origin requests', async t => {
  const f = await fixture(t), calls = [];
  const server = createApp({ directory: f.directory, template: f.template, zotero: {
    search: async q => { calls.push(q); return [paper]; }, item: async key => ({ key }), attachments: async key => [pdf(key)],
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/zotero/search?q=TrEnv`)).status, 200);
  assert.equal((await fetch(`${base}/api/zotero/items/PAPER001`)).status, 200);
  assert.equal((await fetch(`${base}/api/zotero/items/PAPER001/attachments`)).status, 200);
  assert.equal((await fetch(`${base}/api/zotero/search?q=TrEnv&url=https://evil.example`)).status, 400);
  assert.equal((await fetch(`${base}/api/zotero/items/PAPER001?url=http://evil.example`)).status, 400);
  assert.equal((await fetch(`${base}/api/zotero/search?q=TrEnv`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/zotero/items/PAPER001`, { method: 'DELETE' })).status, 404);
  assert.deepEqual(calls, ['TrEnv']);
  for (const asset of ['context.mjs', 'connections.mjs']) assert.equal((await fetch(`${base}/${asset}`)).status, 200);
});
