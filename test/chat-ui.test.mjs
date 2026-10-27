import test from 'node:test';
import assert from 'node:assert/strict';
import { setupChat } from '../dist/chat.mjs';
function fixture(t, save) {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  t.after(() => { if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage; });
  const elements = new Map();
  const element = s => { if (!elements.has(s)) elements.set(s, { value: '', textContent: '', scrollHeight: 0, scrollTop: 0, clientHeight: 0, addEventListener() {}, replaceChildren() {}, scrollIntoView() {}, focus() {} }); return elements.get(s); };
  const previous = globalThis.document;
  globalThis.document = { querySelector: element };
  t.after(() => { globalThis.document = previous; });
  t.mock.method(globalThis, 'setTimeout', () => 0);
  const calls = [], state = { active: { id: 'note-id', version: 'latest' } };
  const chat = setupChat({ state, save, selectNote: async () => true, api: async (route, options) => { if (options) calls.push({ route, ...JSON.parse(options.body) }); return { messages: [] }; } });
  chat.render(); element('#chat-input').value = '另一个还没发出的问题';
  return { chat, state, calls, element };
}
test('one-click review saves first, sends latest version and preserves composer draft', async t => {
  let f; f = fixture(t, async () => { assert.equal(f.calls.length, 0); f.state.active.version = 'after-save'; return true; });
  await f.chat.review();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].version, 'after-save');
  assert.match(f.calls[0].text, /作者怎么分析这个问题/);
  assert.equal(f.element('#chat-input').value, '另一个还没发出的问题');
});
test('one-click review does not send when saving fails', async t => {
  const f = fixture(t, async () => false); await f.chat.review();
  assert.equal(f.calls.length, 0); assert.match(f.element('#chat-feedback').textContent, /尚未保存/);
});
test('rapid double-click sends only once', async t => {
  let resolve; const f = fixture(t, () => new Promise(r => { resolve = r; }));
  const first = f.chat.review(); await f.chat.review(); resolve(true); await first;
  assert.equal(f.calls.length, 1);
});
test('finish discussion saves first and leaves unsent question untouched', async t => {
  const f = fixture(t, async () => true); await f.chat.finishDiscussion();
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].route, /discussion\/recap$/);
  assert.equal(f.element('#chat-input').value, '另一个还没发出的问题');
});
