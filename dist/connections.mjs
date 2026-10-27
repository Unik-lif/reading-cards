import { normalizeDiscussion, normalizeZotero, normalizeGaps, parseZoteroLink, zoteroLinks, learningIndex, buildRequest, newDiscussionUrl } from './context.mjs';
import { tryCopy } from './clipboard.mjs';

const $ = selector => document.querySelector(selector);
const node = (tag, value, className = '') => { const element = document.createElement(tag); element.textContent = value; element.className = className; return element; };
const message = (selector, error = '') => { $(selector).textContent = error.message || error; };
export function setupConnections({ state, api, save, changed, showError, selectNote, renderList, chat }) {
  const manualCopied = node('button', '我已手动复制'); manualCopied.id = 'manual-copied'; manualCopied.hidden = true;
  $('#copy-request').after(manualCopied);
  const fallbackLink = document.createElement('textarea'); fallbackLink.id = 'fallback-link'; fallbackLink.readOnly = true; fallbackLink.hidden = true; fallbackLink.setAttribute('aria-label', '可手动复制的跳转链接');
  $('#request-message').after(fallbackLink);
  let selectedPaper = null, searchEpoch = 0, attachmentEpoch = 0, requestTarget = null, requestIsNew = false, copied = false;
  let renderedId = null;
  const gapDraftKey = id => `reading-gap-input:${id}`;
  function rememberGapInput() { try { localStorage.setItem(gapDraftKey(state.active.id), $('#gap-input').value); } catch {} }
  async function commit(fields, feedback = '#connection-message') {
    Object.assign(state.active, fields); changed(); render();
    const success = await save();
    message(feedback, success ? '' : '尚未保存。输入仍保留，请先解决页面上方的保存问题。');
    return success;
  }
  function link(selector, href) { const element = $(selector); element.hidden = !href; if (href) element.href = href; else element.removeAttribute('href'); }
  function render() {
    const note = state.active;
    if (!note) return;
    chat?.render();
    if (renderedId !== note.id) {
      renderedId = note.id;
      try { $('#gap-input').value = localStorage.getItem(gapDraftKey(note.id)) || ''; } catch { $('#gap-input').value = ''; }
      message('#connection-message');
    }
    const z = note.zotero;
    $('#paper-binding-title').textContent = z ? z.title || '已保存 Zotero 链接' : '还没有绑定论文';
    $('#paper-binding-meta').textContent = z ? [z.authors, z.year, z.itemKey ? `条目 ${z.itemKey}` : '未绑定论文条目', z.attachmentKey ? `PDF ${z.attachmentKey}` : '未选择 PDF'].filter(Boolean).join(' · ') : '从本机文库选一篇，或粘贴 Zotero 链接。';
    $('#bind-paper').textContent = z ? '更换 / 选择 PDF' : '绑定论文';
    $('#unbind-paper').hidden = !z;
    try { const links = zoteroLinks(z); link('#open-item', links.item); link('#open-pdf', links.pdf); }
    catch (error) { link('#open-item', ''); link('#open-pdf', ''); message('#connection-message', error); }
    $('#page-field').hidden = !z?.attachmentKey;
    $('#pdf-page').value = z?.page || '';
    $('#pdf-hint').textContent = z ? z.attachmentKey ? '页码为 PDF 文件页序号；留空打开整篇。链接打不开时请启动 Zotero，或重新选择附件。' : '尚无 PDF 关联。可重新读取附件，或手动补充 PDF 链接。' : '';
    try { link('#continue-discussion', normalizeDiscussion(note.discussionUrl || '')); }
    catch (error) { link('#continue-discussion', ''); message('#connection-message', error); }
    $('#discussion-status').textContent = '直接在下方交流，记录随卡片保存。旧 Codex 对话可另留入口，不会自动导入。';
    $('#bind-discussion').textContent = note.discussionUrl ? '更换 / 解除旧入口' : '关联旧对话（可选）';
    $('#start-discussion').hidden = true;
    renderGaps($('#card-gaps'), (note.learningGaps || []).map(gap => ({ ...gap, noteId: note.id, title: note.title })), false);
  }
  function renderOverview() {
    $('#gap-count').textContent = learningIndex(state.notes).length;
    $('#show-learning').setAttribute('aria-pressed', String(!!state.learningView));
    if (state.learningView) renderGaps($('#learning-list'), learningIndex(state.notes, $('#include-done').checked), true);
  }
  function displayView() {
    $('#learning-view').hidden = !state.learningView;
    $('#workspace').hidden = state.learningView || !state.active;
    $('#empty').hidden = state.learningView || !!state.active;
    renderOverview();
  }
  async function refreshOverview() {
    if (!(await save())) return;
    try { state.notes = await api('/api/notes'); renderList(); renderOverview(); message('#learning-message'); }
    catch (error) { message('#learning-message', error); }
  }
  async function mutateGap(noteId, transform) {
    if (!(await save())) return false;
    try {
      if (state.active?.id === noteId) {
        const gaps = normalizeGaps(transform(state.active.learningGaps || []));
        return await commit({ learningGaps: gaps });
      }
      // Read a fresh version; never overwrite another card using a cached overview snapshot.
      const note = await api(`/api/notes/${noteId}`);
      const learningGaps = normalizeGaps(transform(note.learningGaps || []));
      const saved = await api(`/api/notes/${noteId}`, { method: 'PUT', body: JSON.stringify({ title: note.title, body: note.body, version: note.version, learningGaps }) });
      state.notes = state.notes.map(item => item.id === noteId ? saved : item);
      renderList(); renderOverview(); message('#learning-message'); return true;
    } catch (error) { message('#learning-message', `${error.message} 请刷新清单后重试。`); message('#connection-message', error); return false; }
  }
  function renderGaps(container, gaps, overview) {
    container.replaceChildren();
    if (!gaps.length) { container.append(node('p', overview ? '这里暂时没有待补问题。读到卡住的地方，再从卡片底部加入。' : '不用现在全部弄懂，先记下一个问题就好。', 'gap-empty')); return; }
    for (const gap of gaps) {
      const row = node('div', '', `gap-row${gap.done ? ' is-done' : ''}`);
      const label = node('label', '', 'gap-check'), check = document.createElement('input'); check.type = 'checkbox'; check.checked = gap.done; check.setAttribute('aria-label', `已补：${gap.text}`);
      label.append(check, node('span', gap.done ? '已补' : '未补'));
      check.addEventListener('change', async () => { const done = check.checked; check.disabled = true; await mutateGap(gap.noteId, gaps => gaps.map(g => g.id === gap.id ? { ...g, done } : g)); render(); renderOverview(); });
      const content = node('div', '', 'gap-content'); content.append(node('p', gap.text));
      if (overview) {
        const source = node('button', `来源：${gap.title || '未命名阅读卡片'}`, 'gap-source');
        source.addEventListener('click', async () => { if (await selectNote(gap.noteId)) { state.learningView = false; displayView(); } }); content.append(source);
      }
      const actions = node('div', '', 'gap-actions');
      const learn = node('button', '补这一点'); learn.addEventListener('click', () => prepare(gap.noteId, `我想补这一点：${gap.text}`));
      const remove = node('button', '移除'); remove.setAttribute('aria-label', `移除问题：${gap.text}`);
      remove.addEventListener('click', async () => { if (confirm('从清单移除这个问题？不会改动正文。')) { await mutateGap(gap.noteId, gaps => gaps.filter(g => g.id !== gap.id)); render(); renderOverview(); } });
      actions.append(learn, remove); row.append(label, content, actions); container.append(row);
    }
  }
  async function prepare(id, question = '', forceNew = false) {
    if (chat) return chat.prepare(id, question);
    if (id === state.active?.id && !$('#page-field').hidden && !$('#pdf-page').validity.valid) {
      message('#connection-message', '请先修正 PDF 页码，或留空打开整篇。'); $('#pdf-page').reportValidity(); return;
    }
    if (state.busy || !(await save())) return;
    try {
      const note = await api(`/api/notes/${id}`);
      if (state.active?.id === id && (state.dirty || note.version !== state.active.version)) {
        throw Object.assign(new Error('笔记刚刚有变化。请先保存或重新载入后，再准备讨论请求。'), { status: 409 });
      }
      requestTarget = note; requestIsNew = forceNew || !note.discussionUrl; copied = false;
      $('#review-request').value = buildRequest(note, state.info.directory, question);
      $('#request-instructions').textContent = requestIsNew ? '笔记已保存。确认下方文字后打开新对话：请求仅预填，由你确认发送。' : '笔记已保存。先复制请求，再打开已绑定的对话，由你粘贴并发送。';
      $('#request-open').textContent = requestIsNew ? '打开新对话（预填，不发送）↗' : '2. 打开已绑定对话 ↗';
      message('#request-message'); $('#manual-copied').hidden = true; updateRequestLink(); $('#request-dialog').showModal();
    } catch (error) { showError(error); }
  }
  function updateRequestLink() {
    if (!requestTarget) return;
    $('#request-open').href = requestIsNew ? newDiscussionUrl($('#review-request').value, state.info.workspace) : normalizeDiscussion(requestTarget.discussionUrl);
    $('#request-open').setAttribute('aria-disabled', String(!requestIsNew && !copied));
  }
  async function copy(value, feedback, field) {
    if (await tryCopy(text => navigator.clipboard.writeText(text), value)) { message(feedback, '已复制；尚未发送。'); return true; }
    if (field) { field.focus(); field.select(); }
    message(feedback, '自动复制失败。请选中文字后按 ⌘C / Ctrl+C 手动复制。'); return false;
  }
  $('#copy-request').addEventListener('click', async () => { copied = await copy($('#review-request').value, '#request-message', $('#review-request')); $('#manual-copied').hidden = copied; updateRequestLink(); });
  $('#manual-copied').addEventListener('click', () => { copied = true; updateRequestLink(); message('#request-message', '请打开对话，再粘贴发送。'); });
  $('#review-request').addEventListener('input', () => { copied = false; updateRequestLink(); message('#request-message', '请求已编辑，尚未发送。'); });
  $('#request-open').addEventListener('click', event => {
    if (!requestIsNew && !copied) { event.preventDefault(); message('#request-message', '请先复制请求。跳转不会把请求发送给对话。'); }
    else message('#request-message', '已请求跳转；网页无法确认应用是否打开。请在 Codex 中确认并发送。');
  });
  $('#copy-discussion-link').addEventListener('click', async () => {
    if (!(await copy($('#request-open').href, '#request-message'))) {
      $('#fallback-link').hidden = false; $('#fallback-link').value = $('#request-open').href; $('#fallback-link').focus(); $('#fallback-link').select();
    }
  });
  $('#check-understanding').addEventListener('click', () => chat ? chat.review() : prepare(state.active.id));
  $('#start-discussion').addEventListener('click', () => prepare(state.active.id, '', true));
  $('#show-learning').addEventListener('click', async () => { if (!(await save())) return; state.learningView = true; displayView(); await refreshOverview(); });
  $('#back-to-note').addEventListener('click', () => { state.learningView = false; displayView(); });
  $('#include-done').addEventListener('change', renderOverview);
  $('#refresh-learning').addEventListener('click', refreshOverview);
  $('#gap-input').addEventListener('input', rememberGapInput);
  $('#gap-form').addEventListener('submit', async event => {
    event.preventDefault(); const input = $('#gap-input'), question = input.value.trim(); if (!question || !state.active) return;
    try {
      const gaps = normalizeGaps([...(state.active.learningGaps || []), { id: crypto.randomUUID(), text: question, done: false }]);
      // Once added, the ordinary note draft retains it even when saving fails.
      input.value = ''; rememberGapInput(); await commit({ learningGaps: gaps });
    } catch (error) { message('#connection-message', error); }
  });
  $('#bind-discussion').addEventListener('click', () => { $('#discussion-url').value = state.active.discussionUrl || ''; message('#discussion-message'); $('#discussion-dialog').showModal(); });
  $('#discussion-form').addEventListener('submit', async event => {
    event.preventDefault();
    try { if (await commit({ discussionUrl: normalizeDiscussion($('#discussion-url').value) }, '#discussion-message')) $('#discussion-dialog').close(); }
    catch (error) { message('#discussion-message', error); }
  });
  $('#unbind-discussion').addEventListener('click', async () => { if (await commit({ discussionUrl: '' }, '#discussion-message')) $('#discussion-dialog').close(); });
  $('#pdf-page').addEventListener('input', () => {
    try {
      if ($('#pdf-page').validity.badInput) throw new Error('请填写有效的 PDF 页码。');
      const zotero = normalizeZotero({ ...state.active.zotero, page: $('#pdf-page').value === '' ? null : Number($('#pdf-page').value) });
      state.active.zotero = zotero; changed(); link('#open-pdf', zoteroLinks(zotero).pdf); message('#connection-message');
    } catch (error) { message('#connection-message', error); }
  });
  $('#unbind-paper').addEventListener('click', () => commit({ zotero: null }));
  async function choosePaper(paper, preferred = '') {
    const epoch = ++attachmentEpoch; selectedPaper = paper;
    $('#paper-selection').hidden = false; $('#selected-paper-title').textContent = paper.title || 'Zotero 条目';
    $('#selected-paper-meta').textContent = [paper.authors, paper.year, `条目 ${paper.itemKey}`].filter(Boolean).join(' · ');
    $('#pdf-choice').replaceChildren(new Option('仅绑定论文条目（不选 PDF）', 'none'));
    $('#confirm-paper').disabled = true; $('#retry-attachments').hidden = true; message('#attachment-message', '正在读取 PDF 附件…');
    try {
      const attachments = await api(`/api/zotero/items/${paper.itemKey}/attachments`);
      if (epoch !== attachmentEpoch || !$('#paper-dialog').open) return;
      for (const pdf of attachments) $('#pdf-choice').add(new Option(`${pdf.title} · ${pdf.key}`, pdf.key));
      if (attachments.length > 1) { $('#pdf-choice').add(new Option('请选择一份 PDF，或仅绑定条目', ''), 0); $('#pdf-choice').value = attachments.some(a => a.key === preferred) ? preferred : ''; }
      else if (attachments.length === 1) $('#pdf-choice').value = attachments[0].key;
      message('#attachment-message', attachments.length ? `${attachments.length} 份 PDF。确认下方选择后再绑定。` : '这篇条目下没有 PDF。可以先绑定条目，稍后再添加附件链接。');
    } catch (error) {
      if (epoch !== attachmentEpoch) return;
      message('#attachment-message', error); $('#retry-attachments').hidden = false;
      if (preferred) { $('#pdf-choice').add(new Option(`保留已绑定 PDF · ${preferred}（暂未核验）`, preferred)); $('#pdf-choice').value = preferred; }
    } finally { if (epoch === attachmentEpoch) $('#confirm-paper').disabled = false; }
  }
  $('#bind-paper').addEventListener('click', () => {
    ++searchEpoch; ++attachmentEpoch; selectedPaper = null;
    $('#paper-query').value = state.active.title === '未命名阅读卡片' ? '' : state.active.title;
    $('#paper-results').replaceChildren(); $('#paper-selection').hidden = true; message('#paper-message'); message('#manual-message');
    let links = { item: '', pdf: '' }; try { links = zoteroLinks(state.active.zotero); } catch {}
    $('#manual-item').value = links.item; $('#manual-pdf').value = links.pdf;
    $('#paper-dialog').showModal();
    if (state.active.zotero?.library === 'user' && state.active.zotero.itemKey) choosePaper(state.active.zotero, state.active.zotero.attachmentKey);
  });
  $('#paper-search-form').addEventListener('submit', async event => {
    event.preventDefault(); const epoch = ++searchEpoch; ++attachmentEpoch; selectedPaper = null;
    $('#paper-selection').hidden = true; $('#paper-results').replaceChildren(); message('#paper-message', '正在搜索本机文库…');
    try {
      const results = await api(`/api/zotero/search?q=${encodeURIComponent($('#paper-query').value.trim())}`);
      if (epoch !== searchEpoch || !$('#paper-dialog').open) return;
      message('#paper-message', results.length ? `找到 ${results.length} 篇${results.length === 30 ? '（最多显示 30 篇，可缩小搜索范围）' : ''}。请先选择，再确认绑定。` : '没有找到。可缩短题目、改用作者或粘贴链接。');
      for (const paper of results) { const button = node('button', '', 'paper-result'); button.append(node('strong', paper.title || '无题目'), node('span', [paper.authors, paper.year].filter(Boolean).join(' · '))); button.addEventListener('click', () => choosePaper(paper)); $('#paper-results').append(button); }
    } catch (error) { if (epoch === searchEpoch) message('#paper-message', error); }
  });
  $('#retry-attachments').addEventListener('click', () => { if (selectedPaper) choosePaper(selectedPaper, state.active.zotero?.itemKey === selectedPaper.itemKey ? state.active.zotero.attachmentKey : ''); });
  $('#confirm-paper').addEventListener('click', async () => {
    if (!selectedPaper) return;
    if (!$('#pdf-choice').value) { message('#attachment-message', '请选择一份 PDF，或明确选择「仅绑定论文条目」。'); return; }
    try {
      const attachmentKey = $('#pdf-choice').value === 'none' ? '' : $('#pdf-choice').value;
      const zotero = normalizeZotero({ ...selectedPaper, attachmentKey, page: attachmentKey === state.active.zotero?.attachmentKey ? state.active.zotero.page : null });
      if (await commit({ zotero }, '#attachment-message')) $('#paper-dialog').close();
    } catch (error) { message('#attachment-message', error); }
  });
  $('#manual-paper-form').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const item = $('#manual-item').value.trim() ? parseZoteroLink($('#manual-item').value) : null;
      const pdf = $('#manual-pdf').value.trim() ? parseZoteroLink($('#manual-pdf').value) : null;
      if ((!item && !pdf) || (item && !item.itemKey) || (pdf && !pdf.attachmentKey)) throw new Error('请将条目链接和 PDF 链接分别填入对应输入框，至少填写一个。');
      if (item && pdf && (item.library !== pdf.library || item.libraryId !== pdf.libraryId)) throw new Error('条目和 PDF 必须来自同一个 Zotero 文库。');
      const same = item?.itemKey && item.itemKey === state.active.zotero?.itemKey;
      const zotero = normalizeZotero({ ...(same ? state.active.zotero : {}), ...(item || pdf), attachmentKey: pdf?.attachmentKey || '', page: pdf?.page || null, ...(same ? { title: state.active.zotero.title, authors: state.active.zotero.authors, year: state.active.zotero.year } : {}) });
      if (await commit({ zotero }, '#manual-message')) $('#paper-dialog').close();
    } catch (error) { message('#manual-message', error); }
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
  $('#request-dialog').addEventListener('close', () => { $('#fallback-link').hidden = true; });
  function saved() { if ($('#connection-message').textContent.startsWith('尚未保存。')) message('#connection-message'); }
  return { render, renderOverview, displayView, saved };
}
