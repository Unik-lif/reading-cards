import { renderMarkdown, sections } from './markdown.mjs';
import { categoryOf, categoryIndex, filterNotes, draftMarkdown } from './categories.mjs';
import { contextFields, restoreDraft } from './context.mjs';
import { setupConnections } from './connections.mjs';
import { normalizeFilename, suggestedFilename } from './filenames.mjs';
import { setupChat } from './chat.mjs';

const $ = selector => document.querySelector(selector);
const state = { notes: [], active: null, categoryFilter: null, mode: 'card', dirty: false, sequence: 0, timer: null, saving: null, busy: false, error: null };
let connections, chat;
const hints = {
  '它在解决什么问题？': '哪个场景里，什么事情做不好？',
  '作者怎么分析这个问题？': '观察到了什么 → 为什么会这样 → 现有办法为什么不够。可以记图号。',
  '大概怎么做？': '先用一两句话说清大意，不急着钻实现细节。',
  '我卡在哪里？': '术语、看不懂的图、说不清的因果……先记着，继续读。',
};
const backupKey = id => `reading-room-draft:${id}`;
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Disk saving remains authoritative. */ } },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
async function api(route, options = {}) {
  const response = await fetch(route, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}
function status(message, kind = '') { $('#save-status').textContent = message; $('#save-status').className = `save-status ${kind}`; }
function showError(error) {
  state.error = error;
  status('尚未保存', 'error');
  $('#notice-text').textContent = error.message || '无法连接本机服务。输入已保留在页面，请启动服务后重试，或下载草稿。';
  if (error.name === 'TypeError' || error.name === 'TimeoutError') $('#notice-text').textContent = '连接不到本机服务。输入仍在页面中，请重新启动服务后重试，或下载草稿。';
  $('#notice').hidden = false;
  $('#retry').hidden = error.status === 409;
  $('#download-draft').hidden = !state.active;
  $('#reload-note').hidden = !state.active;
}
function clearError() { state.error = null; $('#notice').hidden = true; }
function backup() {
  if (state.active && state.dirty) storage.set(backupKey(state.active.id), JSON.stringify({ title: state.active.title, category: categoryOf(state.active), body: state.active.body, version: state.active.version, ...contextFields(state.active) }));
}
function changed() {
  state.dirty = true; state.sequence++;
  document.title = `${state.active.title || '新卡片'} · 泛读`;
  backup(); status('等待保存…', 'saving');
  clearTimeout(state.timer);
  if (state.error?.status !== 409) state.timer = setTimeout(() => save(), 700);
  updateCount();
  const index = state.notes.findIndex(note => note.id === state.active.id);
  if (index >= 0) state.notes[index] = { ...state.active };
  renderList();
}
function save() {
  clearTimeout(state.timer);
  if (state.saving) return state.saving;
  state.saving = (async () => {
   while (state.dirty && state.active) {
    if (state.error?.status === 409) return false;
    const note = { ...state.active }, sequence = state.sequence;
    status('保存中…', 'saving');
    try {
      const saved = await api(`/api/notes/${note.id}`, { method: 'PUT', body: JSON.stringify({ title: note.title, category: categoryOf(note), body: note.body, version: note.version, ...contextFields(note) }) });
      if (state.active?.id === note.id) {
        state.active.version = saved.version; state.active.updated = saved.updated;
        state.active.filename = saved.filename; $('#filename').textContent = saved.filename; $('#filename').title = saved.filename;
        if (state.sequence === sequence) {
          state.dirty = false; storage.remove(backupKey(note.id));
          status('已保存', 'saved');
          connections?.saved();
        } else { backup(); status('等待保存…', 'saving'); }
        clearError();
        state.notes = state.notes.filter(item => item.id !== note.id);
        state.notes.unshift({ ...state.active }); renderList();
      }
    } catch (error) { backup(); showError(error); return false; }
   }
   return !state.error;
  })().finally(() => { state.saving = null; });
  return state.saving;
}
function snippet(body) {
  return body.split('\n').filter(line => line.trim() && !line.startsWith('#')).join(' ').replace(/[*`>\[\]]/g, '').slice(0, 100) || '空白也没关系，读到哪里写到哪里。';
}
function setOptions(select, options, value) {
  const signature = JSON.stringify(options);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map(option => {
      const node = document.createElement('option'); node.value = option.value; node.textContent = option.label; return node;
    }));
    select.dataset.options = signature;
  }
  if (select.value !== value) select.value = value;
}
function renderCategories() {
  const index = categoryIndex(state.notes);
  setOptions($('#category-filter'), index.map(item => ({ value: JSON.stringify(item.value), label: `${item.label} · ${item.count}` })), JSON.stringify(state.categoryFilter));
  setOptions($('#note-category'), index.filter(item => item.value !== null).map(item => ({ value: item.value, label: item.label })), state.active ? categoryOf(state.active) : '');
  $('#current-domain').textContent = state.categoryFilter === null ? '全部领域' : state.categoryFilter || '未分类';
}
function setCategory(value) {
  if (!state.active) return;
  state.active.category = value;
  // If assigning the open card elsewhere, follow it so it does not vanish from the current index.
  if (state.categoryFilter !== null && state.categoryFilter !== value) {
    state.categoryFilter = value;
    storage.set('reading-room-category', JSON.stringify(value));
  }
  changed();
}
function renderList() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const notes = filterNotes(state.notes, state.categoryFilter, query);
  renderCategories();
  $('#note-count').textContent = notes.length === state.notes.length ? state.notes.length : `${notes.length} / ${state.notes.length}`;
  const list = $('#note-list'); list.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement('p'); empty.className = 'no-notes';
    empty.textContent = query ? '当前领域没有找到，试试另一个词或「全部领域」。' : state.categoryFilter !== null ? '这个领域还没有卡片。' : '还没有卡片。\n从正在读的那篇开始吧。'; list.append(empty);
  }
  for (const note of notes) {
    const button = document.createElement('button');
    button.className = `note-item${state.active?.id === note.id ? ' selected' : ''}`;
    button.setAttribute('aria-current', state.active?.id === note.id ? 'page' : 'false');
    const title = document.createElement('strong'); title.textContent = note.title || '未命名阅读卡片';
    const summary = document.createElement('p'); summary.textContent = snippet(note.body);
    const time = document.createElement('time'); time.textContent = note.created; time.dateTime = note.created;
    const meta = document.createElement('div'); meta.className = 'note-item-meta';
    const badge = document.createElement('span'); badge.className = 'category-badge'; badge.textContent = categoryOf(note) || '未分类'; badge.title = badge.textContent;
    meta.append(time, badge);
    button.append(title, summary, meta); button.addEventListener('click', () => selectNote(note.id)); list.append(button);
  }
  connections?.renderOverview();
}
function autoHeight(input) { input.style.height = 'auto'; input.style.height = `${Math.max(input.scrollHeight, 78)}px`; }
function renderBody() {
  $('#card-editor').hidden = state.mode !== 'card';
  $('#markdown-editor').hidden = state.mode !== 'markdown';
  $('#preview').hidden = state.mode !== 'preview';
  document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
  if (!state.active) return;
  if (state.mode === 'preview') { $('#preview').innerHTML = renderMarkdown(state.active.body); return; }
  if (state.mode === 'markdown') { $('#markdown-editor').value = state.active.body; return; }
  const parts = sections(state.active.body);
  const editor = $('#card-editor'); editor.replaceChildren();
  let number = 0;
  parts.forEach((part, index) => {
    const section = document.createElement('section'); section.className = 'card-section';
    if (part.heading) {
      const header = document.createElement('div'); header.className = 'section-heading';
      const label = document.createElement('span'); label.className = 'section-number'; label.textContent = String(++number).padStart(2, '0'); label.setAttribute('aria-hidden', 'true');
      const heading = document.createElement('h2'); heading.textContent = part.heading; heading.id = `section-label-${index}`;
      header.append(label, heading); section.append(header);
    }
    const input = document.createElement('textarea');
    input.value = part.content.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, ''); input.spellcheck = false;
    input.setAttribute('aria-label', part.heading || '自由笔记');
    input.placeholder = hints[part.heading] || '写一点自己的理解……';
    input.addEventListener('input', () => {
      part.content = `\n${input.value}\n\n`;
      state.active.body = parts.map(item => item.prefix + item.content).join('');
      autoHeight(input); changed();
    });
    section.append(input); editor.append(section); autoHeight(input);
  });
}
function updateCount() {
  const body = state.active?.body || '';
  const count = body.replace(/^#{1,6} .*$/gm, '').replace(/\s/g, '').length;
  $('#word-count').textContent = `${count} 字`;
}
function renderNote() {
  $('#empty').hidden = !!state.active; $('#workspace').hidden = !state.active;
  connections?.displayView();
  if (!state.active) return;
  $('#title').value = state.active.title === '未命名阅读卡片' ? '' : state.active.title;
  $('#note-date').textContent = state.active.created.replaceAll('-', ' / ');
  $('#filename').textContent = state.active.filename;
  $('#filename').title = state.active.filename;
  renderBody(); updateCount(); renderList(); connections?.render();
  document.title = `${state.active.title || '新卡片'} · 泛读`;
}
async function selectNote(id) {
  if (state.busy) return false;
  if (state.active?.id === id && !state.error) { state.learningView = false; renderNote(); return true; }
  state.busy = true;
  try {
    if (!(await save())) return false;
    const note = await api(`/api/notes/${id}`);
    let draft; try { draft = JSON.parse(storage.get(backupKey(id))); } catch {}
    state.active = note; state.dirty = false; state.sequence = 0; clearError();
    if (draft && typeof draft.body === 'string' && typeof draft.title === 'string') {
      state.active = restoreDraft(note, draft);
      state.notes = state.notes.map(item => item.id === id ? { ...state.active } : item);
      state.dirty = true;
      if (draft.version !== note.version) showError(Object.assign(new Error('恢复了上次未保存的草稿，但磁盘文件也有改动。请先下载草稿，再重新载入并核对。'), { status: 409 }));
      else { status('已恢复草稿，正在保存…', 'saving'); state.timer = setTimeout(() => save(), 700); }
    } else status('已保存', 'saved');
    state.learningView = false; storage.set('reading-room-active', id); renderNote(); return true;
  } catch (error) { showError(error); }
  finally { state.busy = false; }
}
async function newNote() {
  if (state.busy) return;
  state.busy = true; $('#new-note').disabled = true; $('#first-note').disabled = true;
  try {
    if (!(await save())) return;
    const note = await api('/api/notes', { method: 'POST', body: JSON.stringify({ category: state.categoryFilter || '' }) });
    state.notes.unshift(note); state.active = note; state.dirty = false; state.sequence = 0;
    state.mode = 'card'; state.learningView = false; clearError(); status('已保存', 'saved'); storage.set('reading-room-active', note.id);
    $('#search').value = ''; renderNote(); $('#title').focus();
  } catch (error) { showError(error); }
  finally { state.busy = false; $('#new-note').disabled = false; $('#first-note').disabled = false; }
}
function downloadDraft() {
  if (!state.active) return;
  const blob = new Blob([draftMarkdown(state.active)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${(state.active.title || '阅读草稿').replace(/[\\/:*?"<>|]/g, '-')}.md`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#new-note').addEventListener('click', newNote); $('#first-note').addEventListener('click', newNote);
$('#rename-note').addEventListener('click', async () => {
  if (state.busy || !state.active) return;
  if (!(await save())) return;
  $('#new-filename').value = state.active.filename;
  $('#rename-message').textContent = '';
  $('#rename-dialog').showModal(); $('#new-filename').focus();
});
$('#generate-filename').addEventListener('click', () => {
  $('#new-filename').value = suggestedFilename(state.active); $('#rename-message').textContent = '已根据题目生成，可继续修改后确认。';
});
$('#cancel-rename').addEventListener('click', () => $('#rename-dialog').close());
$('#rename-dialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
$('#rename-form').addEventListener('submit', async event => {
  event.preventDefault(); if (state.busy || !state.active) return;
  let newFilename;
  try { newFilename = normalizeFilename($('#new-filename').value); }
  catch (error) { $('#rename-message').textContent = error.message; return; }
  state.busy = true;
  for (const id of ['confirm-rename', 'cancel-rename', 'generate-filename', 'new-filename']) $(`#${id}`).disabled = true;
  try {
    if (!(await save())) { $('#rename-message').textContent = '请先解决保存问题；文件名输入仍保留。'; return; }
    const note = state.active;
    const saved = await api(`/api/notes/${note.id}/rename`, { method: 'POST', body: JSON.stringify({ newFilename, filename: note.filename, version: note.version }) });
    state.active = saved; state.notes = state.notes.map(item => item.id === saved.id ? saved : item);
    clearError(); status('已重命名', 'saved'); renderNote(); $('#rename-dialog').close();
  } catch (error) { $('#rename-message').textContent = `${error.message || '连接失败。'} 文件名输入仍保留；如结果不确定，请关闭此框后刷新核对。`; }
  finally {
    state.busy = false;
    for (const id of ['confirm-rename', 'cancel-rename', 'generate-filename', 'new-filename']) $(`#${id}`).disabled = false;
  }
});
$('#search').addEventListener('input', renderList);
$('#category-filter').addEventListener('change', () => {
  state.categoryFilter = JSON.parse($('#category-filter').value);
  storage.set('reading-room-category', JSON.stringify(state.categoryFilter));
  renderList();
});
$('#note-category').addEventListener('change', () => setCategory($('#note-category').value));
$('#new-category').addEventListener('click', () => {
  $('#category-name').value = ''; $('#category-name').setCustomValidity('');
  $('#category-dialog').showModal(); $('#category-name').focus();
});
$('#cancel-category').addEventListener('click', () => $('#category-dialog').close());
$('#category-name').addEventListener('input', () => $('#category-name').setCustomValidity(''));
$('#category-form').addEventListener('submit', event => {
  event.preventDefault();
  const field = $('#category-name'), value = field.value.trim();
  if (!value || value === '未分类') {
    field.setCustomValidity(!value ? '请写一个领域名称。' : '「未分类」是保留名称，可直接在下拉框选择。');
    field.reportValidity(); return;
  }
  setCategory(value); $('#category-dialog').close(); $('#note-category').focus();
});
$('#title').addEventListener('input', () => { state.active.title = $('#title').value; changed(); });
$('#markdown-editor').addEventListener('input', () => { state.active.body = $('#markdown-editor').value; changed(); });
document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => { state.mode = button.dataset.mode; renderBody(); }));
$('#retry').addEventListener('click', async () => { if (state.active && state.dirty) await save(); else { clearError(); await initialize(); } });
$('#download-draft').addEventListener('click', downloadDraft);
$('#download').addEventListener('click', downloadDraft);
$('#reload-note').addEventListener('click', async () => {
  if (!state.active) return;
  if (state.dirty && !confirm('重新载入会放弃页面里的未保存输入。建议先「下载草稿」。确定重新载入吗？')) return;
  const id = state.active.id;
  try {
    const note = await api(`/api/notes/${id}`);
    storage.remove(backupKey(id)); clearTimeout(state.timer); state.active = note; state.dirty = false;
    state.notes = state.notes.map(item => item.id === id ? note : item);
    clearError(); status('已保存', 'saved'); renderNote();
  } catch (error) { showError(error); }
});
$('#help').addEventListener('click', () => $('#help-dialog').showModal());
$('#close-help').addEventListener('click', () => $('#help-dialog').close());
$('#help-dialog').addEventListener('click', event => { if (event.target === $('#help-dialog')) { const rect = event.target.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) event.target.close(); } });
window.addEventListener('keydown', event => {
  if (event.isComposing) return;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !document.querySelector('dialog[open]')) { event.preventDefault(); newNote(); }
});
window.addEventListener('beforeunload', event => { if (state.dirty) { backup(); event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && state.dirty) { backup(); save(); } });
window.addEventListener('online', () => { if (state.dirty && state.error?.status !== 409) save(); });

async function initialize() {
  try {
    const [info, notes] = await Promise.all([api('/api/info'), api('/api/notes')]);
    if (!info.features?.includes('chat-v1')) throw new Error('应用已更新，请重启「打开阅读卡片.command」后刷新，以启用重命名和网页讨论。');
    state.info = info;
    $('#storage-path').textContent = info.directory; $('#template-path').textContent = info.template;
    state.notes = notes;
    try { state.categoryFilter = JSON.parse(storage.get('reading-room-category')); } catch { state.categoryFilter = null; }
    if (!categoryIndex(notes).some(item => item.value === state.categoryFilter)) state.categoryFilter = null;
    renderList();
    const last = storage.get('reading-room-active');
    const id = notes.find(note => note.id === last)?.id || notes[0]?.id;
    if (id) await selectNote(id);
  } catch (error) { showError(error); }
}
chat = setupChat({ state, api, save, selectNote });
connections = setupConnections({ state, api, save, changed, showError, selectNote, renderList, chat });
initialize();
