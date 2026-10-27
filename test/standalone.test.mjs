import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, defaultNotes } from '../server.mjs';

test('fresh checkout has a working bundled template and local data default', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  assert.equal(defaultNotes, path.join(root, 'data/notes'));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'reading-standalone-'));
  const server = createApp({ directory });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const info = await (await fetch(base + '/api/info')).json();
    assert.equal(info.template, path.join(root, 'templates/泛读卡片.md'));
    const response = await fetch(base + '/api/notes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 201);
    const note = await response.json();
    for (const heading of ['它在解决什么问题', '作者怎么分析这个问题', '大概怎么做', '我卡在哪里']) assert.ok(note.body.includes(heading));
    assert.deepEqual((await (await fetch(base + '/api/notes')).json()).map(n => n.id), [note.id]);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
