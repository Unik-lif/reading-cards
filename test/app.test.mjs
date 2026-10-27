import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rename, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createStore } from '../store.mjs';
import { createApp } from '../server.mjs';
import { renderMarkdown, sections } from '../dist/markdown.mjs';
import { categoryIndex, filterNotes, draftMarkdown } from '../dist/categories.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reading-cards-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = path.join(root, 'template.md');
  const directory = path.join(root, 'notes');
  const body = '## 问题\n\n## 分析\n\n## 疑问\n';
  await writeFile(template, body);
  return { root, template, directory, body, store: createStore(directory, template) };
}
test('new note copies only blank template, persists exact Chinese and Markdown, survives reload', async t => {
  const f = await fixture(t), note = await f.store.create();
  assert.equal(note.body, f.body);
  const text = '## 问题\n\n这是我自己的理解。\n\n- **不是 AI 总结**\n';
  const saved = await f.store.save(note.id, { title: 'TrEnv: 我的泛读', body: text, version: note.version });
  const fresh = createStore(f.directory, f.template);
  assert.equal((await fresh.get(note.id)).body, text);
  assert.equal(saved.title, 'TrEnv: 我的泛读');
  assert.notEqual(saved.version, note.version);
  assert.match(await readFile(path.join(f.directory, saved.filename), 'utf8'), /title: "TrEnv: 我的泛读"/);
  assert.equal((await readdir(f.directory)).filter(name => name.endsWith('.tmp')).length, 0);
});
test('optimistic conflict protection, including simultaneous tabs', async t => {
  const f = await fixture(t), note = await f.store.create();
  const attempts = await Promise.allSettled(['甲', '乙'].map(title => f.store.save(note.id, { title, body: title, version: note.version })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.status, 409);
});
test('external file edits are not overwritten; renamed files remain usable', async t => {
  const f = await fixture(t), note = await f.store.create();
  const file = path.join(f.directory, note.filename);
  const raw = await readFile(file, 'utf8');
  await writeFile(file, raw + '\n外部新增的内容\n');
  await assert.rejects(f.store.save(note.id, { title: '不覆盖', body: '', version: note.version }), { status: 409 });
  assert.match(await readFile(file, 'utf8'), /外部新增/);
  await rename(file, path.join(f.directory, '我自己改的文件名.md'));
  assert.equal((await f.store.get(note.id)).filename, '我自己改的文件名.md');
});
test('unknown files and symlinks are ignored, unsafe IDs rejected', async t => {
  const f = await fixture(t); await f.store.create();
  await writeFile(path.join(f.directory, '已有笔记.md'), '# 不属于此应用');
  await symlink(f.template, path.join(f.directory, 'link.md'));
  assert.equal((await f.store.all()).length, 1);
  await assert.rejects(f.store.get('../../README.md'), { status: 400 });
});
test('oversized title is rejected without writing', async t => {
  const f = await fixture(t), note = await f.store.create();
  await assert.rejects(f.store.save(note.id, { title: '字'.repeat(201), body: '', version: note.version }), { status: 400 });
  assert.equal((await f.store.get(note.id)).version, note.version);
});
test('legacy notes read as unclassified without migration or content changes', async t => {
  const f = await fixture(t), note = await f.store.create();
  const file = path.join(f.directory, note.filename);
  const legacy = (await readFile(file, 'utf8')).replace(/^category:.*\n/m, '');
  await writeFile(file, legacy);
  const loaded = await f.store.get(note.id);
  assert.equal(loaded.category, '');
  assert.equal(loaded.body, f.body);
  assert.equal(await readFile(file, 'utf8'), legacy);
});
test('categories persist, can be reassigned or cleared, and old clients preserve them', async t => {
  const f = await fixture(t), note = await f.store.create({ category: '  Agent Sandbox  ' });
  assert.equal(note.category, 'Agent Sandbox');
  const saved = await f.store.save(note.id, { title: '分类测试', body: f.body, category: 'Serverless', version: note.version });
  assert.equal((await createStore(f.directory, f.template).get(note.id)).category, 'Serverless');
  assert.equal((await f.store.get(note.id)).body, f.body);
  assert.match((await f.store.download(note.id)).raw, /category: "Serverless"/);
  const oldClient = await f.store.save(note.id, { title: saved.title, body: f.body, version: saved.version });
  assert.equal(oldClient.category, 'Serverless');
  const cleared = await f.store.save(note.id, { title: saved.title, body: f.body, category: '', version: oldClient.version });
  assert.equal(cleared.category, '');
});
test('invalid categories are rejected, and category saves use version protection', async t => {
  const f = await fixture(t), note = await f.store.create();
  for (const category of [42, ['领域'], '字'.repeat(41), '含\n换行', '未分类']) {
    await assert.rejects(f.store.save(note.id, { title: note.title, body: f.body, category, version: note.version }), { status: 400 });
    await assert.rejects(f.store.create({ category }), { status: 400 });
  }
  assert.equal((await f.store.all()).length, 1);
  const saved = await f.store.save(note.id, { title: note.title, body: f.body, category: '操作系统', version: note.version });
  await assert.rejects(f.store.save(note.id, { title: note.title, body: f.body, category: '网络', version: note.version }), { status: 409 });
  assert.equal((await f.store.get(note.id)).category, saved.category);
});
test('category index counts unique labels, combines filtering and search, exports metadata safely', () => {
  const notes = [
    { title: 'DSec', body: '内存弹性', category: 'Agent Sandbox' },
    { title: 'TrEnv', body: 'CXL 内存', category: 'Serverless' },
    { title: '第三篇', body: '隔离', category: 'Agent Sandbox' },
    { title: '旧笔记', body: '未归档' },
  ];
  const index = categoryIndex(notes);
  assert.equal(index[0].count, 4);
  assert.equal(index[1].count, 1);
  assert.equal(index.find(item => item.value === 'Agent Sandbox').count, 2);
  assert.equal(filterNotes(notes, 'Agent Sandbox').length, 2);
  assert.deepEqual(filterNotes(notes, 'Agent Sandbox', '内存').map(note => note.title), ['DSec']);
  assert.equal(filterNotes(notes, '', '').length, 1);
  assert.equal(filterNotes(notes, null, 'serverless').length, 1);
  assert.equal(filterNotes(notes, 'Serverless', '隔离').length, 0);
  assert.match(draftMarkdown(notes[0]), /category: "Agent Sandbox"/);
  assert.match(draftMarkdown({ title: '测试', body: '', category: '带"引号' }), /category: "带\\"引号"/);
});
test('section mode round-trips custom headings, preamble, fenced code, and CRLF exactly', () => {
  for (const body of ['自由内容', '## 空标题', '说明\n\n## 一\n\n内容\n\n## 二\n', '## 一\r\n\r\n正文\r\n', '## 真标题\n\n```markdown\n## 代码中的假标题\n```\n\n## 真二\n']) {
    assert.equal(sections(body).map(part => part.prefix + part.content).join(''), body);
  }
  assert.equal(sections('## 真\n```\n## 假\n```\n').length, 1);
});
test('preview renders common Markdown and never raw HTML or executable links', () => {
  assert.match(renderMarkdown('## 问题\n\n**重点**\n- 条目\n```js\nconst a = 1;\n```'), /<h2>问题<\/h2>/);
  assert.match(renderMarkdown('**重点**'), /<strong>重点<\/strong>/);
  const malicious = renderMarkdown('<img src=x onerror=alert(1)>\n\n[坏](javascript:alert(1))\n\n[好](https://example.com)');
  assert.ok(!malicious.includes('<img'));
  assert.ok(!malicious.includes('href="javascript:'));
  assert.match(malicious, /rel="noopener noreferrer"/);
});
test('HTTP routes, static readiness, durable writes, origin/host checks, missing route', async t => {
  const f = await fixture(t);
  const server = createApp({ directory: f.directory, template: f.template });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = route => fetch(base + route);
  assert.equal((await get('/')).status, 200);
  assert.equal((await (await get('/api/info')).json()).app, 'reading-cards');
  assert.deepEqual((await (await get('/api/info')).json()).features, ['categories', 'connections-v1', 'rename-v1', 'chat-v1']);
  assert.equal((await get('/categories.mjs')).status, 200);
  const create = await fetch(base + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ category: 'Agent Sandbox' }) });
  assert.equal(create.status, 201);
  const note = await create.json();
  assert.equal(note.category, 'Agent Sandbox');
  const save = await fetch(base + `/api/notes/${note.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '中文标题 📝', body: '我的思考', category: 'Serverless', version: note.version }) });
  assert.equal(save.status, 200);
  const saved = await save.json();
  assert.equal(saved.body, '我的思考');
  assert.equal(saved.category, 'Serverless');
  assert.equal((await (await get('/api/notes')).json()).length, 1);
  assert.equal((await fetch(base + '/api/notes', { headers: { Origin: 'https://evil.example' } })).status, 403);
  // fetch normalizes Host; use a raw HTTP request to actually exercise rebinding protection.
  const badHost = await new Promise((resolve, reject) => {
    http.get(base + '/api/notes', { headers: { Host: 'evil.example' } }, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(base + '/api/notes', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await get('/api/not-a-route')).status, 404);
  assert.match(await (await get(`/api/notes/${note.id}/download`)).text(), /中文标题 📝/);
});
