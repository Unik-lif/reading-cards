import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStore } from '../store.mjs';
import { createApp } from '../server.mjs';
import { normalizeFilename, suggestedFilename } from '../dist/filenames.mjs';
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'reading-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = path.join(root, 'template.md'), directory = path.join(root, 'notes');
  await writeFile(template, '## 自己的理解\n\n原文 **不变**。\n');
  return { root, directory, template, store: createStore(directory, template) };
}
test('filename validation and title suggestion are local, bounded and editable', () => {
  assert.equal(normalizeFilename(' 2026-10-23 TrEnv 泛读 '), '2026-10-23 TrEnv 泛读.md');
  assert.equal(normalizeFilename('My Note.MD'), 'My Note.md');
  for (const bad of ['', ' ', '../note', '.hidden', '/tmp/a.md', 'a\\b', 'a\nb', 'a:b', 'bad.', '字'.repeat(81)]) assert.throws(() => normalizeFilename(bad));
  assert.equal(suggestedFilename({ created: '2026-10-23', title: 'TrEnv: 泛读' }), '2026-10-23 TrEnv 泛读.md');
  assert.ok(Buffer.byteLength(suggestedFilename({ title: '字'.repeat(200) })) <= 240);
});
test('rename preserves every byte, ID and associations and remains editable by ID', async t => {
  const f = await fixture(t); let note = await f.store.create();
  note = await f.store.save(note.id, { ...note, title: 'TrEnv', zotero: { library: 'user', itemKey: 'PAPER001', attachmentKey: 'PDF00001' }, discussionUrl: 'codex://threads/00000000-0000-4000-8000-000000000001', learningGaps: [{ id: '00000000-0000-4000-8000-000000000002', text: 'CRIU?', done: false }] });
  const before = await readFile(path.join(f.directory, note.filename));
  const renamed = await f.store.rename(note.id, { ...note, newFilename: '2026-10-23 TrEnv 泛读.md' });
  assert.deepEqual(await readFile(path.join(f.directory, renamed.filename)), before);
  assert.equal(renamed.version, note.version); assert.equal(renamed.id, note.id);
  assert.deepEqual(renamed.zotero, note.zotero); assert.deepEqual(renamed.learningGaps, note.learningGaps);
  assert.equal(renamed.discussionUrl, note.discussionUrl);
  assert.deepEqual(await readdir(f.directory), [renamed.filename]);
  const saved = await f.store.save(note.id, { ...renamed, body: renamed.body + '后续手写\n' });
  assert.equal(saved.filename, renamed.filename); assert.match(saved.body, /后续手写/);
});
test('existing files and symlinks are never overwritten', async t => {
  const f = await fixture(t), note = await f.store.create();
  await writeFile(path.join(f.directory, '已有.md'), '不能覆盖');
  await symlink(f.template, path.join(f.directory, '链接.md'));
  for (const newFilename of ['已有.md', '链接.md']) await assert.rejects(f.store.rename(note.id, { ...note, newFilename }), { status: 409 });
  assert.equal(await readFile(path.join(f.directory, '已有.md'), 'utf8'), '不能覆盖');
  assert.equal((await f.store.get(note.id)).filename, note.filename);
});
test('stale contents or filenames are rejected; unchanged filename is a no-op', async t => {
  const f = await fixture(t), note = await f.store.create();
  assert.equal((await f.store.rename(note.id, { ...note, newFilename: note.filename })).version, note.version);
  const renamed = await f.store.rename(note.id, { ...note, newFilename: '一.md' });
  await assert.rejects(f.store.rename(note.id, { ...note, newFilename: '二.md' }), { status: 409 });
  await f.store.save(note.id, { ...renamed, body: '外部内容' });
  await assert.rejects(f.store.rename(note.id, { ...renamed, newFilename: '二.md' }), { status: 409 });
});
test('HTTP rename uses JSON, version checking and origin protection', async t => {
  const f = await fixture(t), note = await f.store.create();
  const server = createApp(f);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/notes/${note.id}/rename`;
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...note, newFilename: '我的笔记' }) };
  assert.equal((await fetch(url, { ...options, headers: { ...options.headers, Origin: 'https://evil.example' } })).status, 403);
  const response = await fetch(url, options); assert.equal(response.status, 200); assert.equal((await response.json()).filename, '我的笔记.md');
  assert.equal((await fetch(url, options)).status, 409);
});
