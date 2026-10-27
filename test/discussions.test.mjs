import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../store.mjs';
import { createDiscussions, discussionMarkdown } from '../discussions.mjs';
import { createApp } from '../server.mjs';
import { createZotero } from '../zotero.mjs';
async function fixture(t, runner, zotero = { fulltext: async () => { throw Error('offline'); } }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reading-chat-test-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const template = path.join(root, 'template.md'); await writeFile(template, '## 理解\n\n原文不变\n');
  const directory = path.join(root, 'notes'), store = createStore(directory, template), note = await store.create();
  const discussions = createDiscussions({ directory, store, zotero, runner });
  t.after(() => discussions.close());
  return { root, directory, store, note, discussions };
}
async function settled(f) {
  for (let i = 0; i < 100; i++) { const data = await f.discussions.get(f.note.id); if (!data.busy && !data.messages.some(m => m.status === 'generating') && data.recapJob?.status !== 'generating') return data; await new Promise(r => setTimeout(r, 5)); }
  throw Error('did not settle');
}
test('discussion persists separately, survives rename and never changes note bytes', async t => {
  const f = await fixture(t, async ({ prompt, onText }) => { assert.match(prompt, /未获得论文全文/); assert.equal(JSON.parse(prompt).note.body, f.note.body); onText('部分'); return '一个提示'; });
  const before = await readFile(path.join(f.directory, f.note.filename));
  await f.discussions.start(f.note.id, { text: '我理解对吗？', version: f.note.version });
  const data = await settled(f); assert.equal(data.messages[1].text, '一个提示'); assert.equal(data.messages[1].status, 'completed');
  const renamed = await f.store.rename(f.note.id, { ...f.note, newFilename: 'TrEnv.md' });
  assert.deepEqual(await readFile(path.join(f.directory, renamed.filename)), before);
  const reloaded = createDiscussions({ ...f, zotero: {}, runner: async () => '' });
  assert.deepEqual(await reloaded.get(f.note.id), data);
  assert.match(discussionMarkdown(renamed, data), /TrEnv.md/);
});
test('stale note and duplicate submissions do not create extra turns', async t => {
  let resolve; const f = await fixture(t, () => new Promise(r => { resolve = r; }));
  await assert.rejects(f.discussions.start(f.note.id, { text: '问题', version: 'stale' }), { status: 409 });
  assert.equal((await f.discussions.get(f.note.id)).messages.length, 0);
  await f.discussions.start(f.note.id, { text: '问题', version: f.note.version });
  await assert.rejects(f.discussions.start(f.note.id, { text: '重复', version: f.note.version }), { status: 409 });
  while (!resolve) await new Promise(r => setTimeout(r, 5)); resolve('完成');
  assert.equal((await settled(f)).messages.length, 2);
});
test('stop preserves partial reply and does not claim successful completion', async t => {
  const f = await fixture(t, ({ onText, signal }) => new Promise((resolve, reject) => { onText('已收到的文字'); signal.addEventListener('abort', () => reject(Error('已停止'))); }));
  await f.discussions.start(f.note.id, { text: '问题', version: f.note.version });
  while (!(await f.discussions.get(f.note.id)).messages[1].text) await new Promise(r => setTimeout(r, 5));
  await f.discussions.stop(f.note.id); const data = await settled(f);
  assert.equal(data.messages[1].status, 'interrupted'); assert.equal(data.messages[1].text, '已收到的文字');
});
test('server restart marks unfinished responses interrupted without re-sending', async t => {
  const f = await fixture(t, async () => 'ok'); await f.discussions.get(f.note.id);
  await writeFile(path.join(f.directory, '.discussions', `${f.note.id}.json`), JSON.stringify({ messages: [{ role: 'assistant', status: 'generating', text: 'part' }] }));
  const data = await f.discussions.get(f.note.id); assert.equal(data.messages[0].status, 'interrupted');
});
test('paper text and source availability accompany the prompt; failures remain visible', async t => {
  const f = await fixture(t, async ({ prompt }) => { assert.match(prompt, /真实索引/); throw Error('网络失败'); }, { fulltext: async () => ({ text: '真实索引', truncated: true }) });
  await f.discussions.start(f.note.id, { text: '解释', version: f.note.version });
  const data = await settled(f); assert.equal(data.messages[1].status, 'failed'); assert.match(data.messages[1].source, /非完整全文/); assert.equal(data.messages[1].error, '网络失败');
});
test('chat HTTP routes reject cross-origin writes and export attached discussion', async t => {
  const f = await fixture(t, async () => 'unused');
  const template = path.join(f.root, 'template.md');
  const server = createApp({ directory: f.directory, template, zotero: { fulltext: async () => { throw Error('offline'); } }, runner: async () => 'HTTP 回答' });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`, route = `${base}/api/notes/${f.note.id}/discussion`;
  const body = JSON.stringify({ text: '问题', version: f.note.version });
  assert.equal((await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body })).status, 403);
  assert.equal((await fetch(route, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status, 415);
  assert.equal((await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).status, 202);
  let data;
  for (let i = 0; i < 100; i++) { data = await (await fetch(route)).json(); if (!data.busy && data.messages.at(-1)?.status === 'completed') break; await new Promise(r => setTimeout(r, 5)); }
  assert.equal(data.messages.at(-1).text, 'HTTP 回答');
  assert.match(await (await fetch(route + '/download')).text(), /HTTP 回答/);
  assert.equal((await f.store.get(f.note.id)).version, f.note.version);
});
test('fulltext validates attachment ownership and flags truncation', async () => {
  const requests = [], binding = { library: 'user', itemKey: 'PAPER001', attachmentKey: 'PDF00001' };
  const z = createZotero(async url => { requests.push(url); return Response.json(url.endsWith('/fulltext') ? { content: '字'.repeat(150001) } : { key: 'PDF00001', data: { itemType: 'attachment', parentItem: 'PAPER001', contentType: 'application/pdf' } }); });
  const result = await z.fulltext(binding); assert.equal(result.text.length, 150000); assert.equal(result.truncated, true);
  assert.ok(requests.every(url => url.startsWith('http://127.0.0.1:23119/api/users/0/')));
  await assert.rejects(z.fulltext({ ...binding, itemKey: 'ABCDEFGH' }));
  await assert.rejects(z.fulltext({ ...binding, library: 'group' }));
});
test('recap persists before success, keeps messages and versions, and avoids repeat calls', async t => {
  let count = 0;
  const f = await fixture(t, async ({ prompt }) => { count++; return prompt.startsWith('本次任务') ? '## 仍未解决的问题\nCRIU?' : '原始回复'; });
  await f.discussions.start(f.note.id, { text: '问题', version: f.note.version }); await settled(f);
  const old = await f.discussions.get(f.note.id), messages = structuredClone(old.messages);
  await f.discussions.recap(f.note.id, { version: f.note.version }); const data = await settled(f);
  assert.deepEqual(data.messages, messages); assert.equal(data.recaps.length, 1);
  assert.equal(data.recapJob.status, 'completed');
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory, '.discussions', `${f.note.id}.json`), 'utf8')), data);
  assert.deepEqual(await f.discussions.recap(f.note.id, { version: f.note.version }), { unchanged: true }); assert.equal(count, 2);
  assert.equal((await f.store.get(f.note.id)).version, f.note.version);
  await f.discussions.start(f.note.id, { text: '追问', version: f.note.version }); await settled(f);
  await f.discussions.recap(f.note.id, { version: f.note.version }); const second = await settled(f);
  assert.equal(second.recaps.length, 2); assert.deepEqual(second.recaps[0], data.recaps[0]);
  assert.match(discussionMarkdown(f.note, second), /回顾版本，覆盖 4 条记录/);
});
test('recap failure and restart preserve the previous recap', async t => {
  const f = await fixture(t, async () => { throw Error('offline'); }); await f.discussions.get(f.note.id);
  const data = { messages: [{ id: 'one', role: 'user', text: 'new' }], recaps: [{ id: 'old', text: '原回顾', coveredCount: 0 }] };
  const file = path.join(f.directory, '.discussions', `${f.note.id}.json`); await writeFile(file, JSON.stringify(data));
  await f.discussions.recap(f.note.id, { version: f.note.version }); const failed = await settled(f);
  assert.equal(failed.recapJob.status, 'failed'); assert.deepEqual(failed.recaps, data.recaps);
  await writeFile(file, JSON.stringify({ ...data, recapJob: { status: 'generating' } }));
  const restarted = await f.discussions.get(f.note.id); assert.equal(restarted.recapJob.status, 'interrupted'); assert.deepEqual(restarted.recaps, data.recaps);
});
test('recap prevents simultaneous sends, supports stopping, and does not overwrite on disk failure', async t => {
  let resolve;
  const f = await fixture(t, () => new Promise(r => { resolve = r; })); await f.discussions.get(f.note.id);
  const folder = path.join(f.directory, '.discussions'), file = path.join(folder, `${f.note.id}.json`);
  const old = { messages: [{ role: 'user', text: '问题' }], recaps: [{ text: '旧回顾', coveredCount: 0 }] };
  await writeFile(file, JSON.stringify(old));
  await f.discussions.recap(f.note.id, { version: f.note.version });
  await assert.rejects(f.discussions.recap(f.note.id, { version: f.note.version }), { status: 409 });
  await assert.rejects(f.discussions.start(f.note.id, { version: f.note.version, text: '并发' }), { status: 409 });
  await f.discussions.stop(f.note.id); resolve('不该保存的新回顾');
  assert.equal((await settled(f)).recapJob.status, 'interrupted');
  await f.discussions.recap(f.note.id, { version: f.note.version });
  await rename(folder, folder + '-backup'); await writeFile(folder, 'simulate inaccessible directory');
  resolve('保存失败的新回顾'); const failed = await settled(f);
  assert.equal(failed.recapJob.status, 'failed'); assert.deepEqual(failed.recaps, old.recaps);
  assert.deepEqual(JSON.parse(await readFile(path.join(folder + '-backup', `${f.note.id}.json`), 'utf8')).recaps, old.recaps);
});
test('empty discussions and stale notes cannot start recap', async t => {
  const f = await fixture(t, async () => { throw Error('must not run'); });
  await assert.rejects(f.discussions.recap(f.note.id, { version: 'stale' }), { status: 409 });
  await assert.rejects(f.discussions.recap(f.note.id, { version: f.note.version }), /还没有讨论/);
});
