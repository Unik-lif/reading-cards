import { renderMarkdown } from './markdown.mjs';
const $ = s => document.querySelector(s);
export function setupChat({ state, api, save, selectNote }) {
  let current = null, timer, epoch = 0, submitting = false, signature = '';
  const key = id => `reading-chat-draft:${id}`;
  function remember() { if (current) { try { localStorage.setItem(key(current), $('#chat-input').value); } catch {} } }
  $('#chat-input').addEventListener('input', remember);
  function feedback(text) { $('#chat-feedback').textContent = text; }
  async function refresh() {
    clearTimeout(timer);
    if (!current) return;
    const id = current, generation = epoch;
    try {
      const data = await api(`/api/notes/${id}/discussion`);
      if (current !== id || epoch !== generation) return;
      const nextSignature = JSON.stringify(data);
      if (nextSignature !== signature) {
        signature = nextSignature;
        const recap = data.recaps?.at(-1) || data.messages.findLast(m => m.kind === 'recap');
        $('#recap-panel').hidden = !recap;
        $('#recap-date').textContent = recap ? `整理于 ${new Date(recap.at).toLocaleString()} · AI 整理稿，不代表你已掌握` : '';
        $('#recap-body').innerHTML = recap ? renderMarkdown(recap.text) : '';
        const log = $('#chat-log'), nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.replaceChildren();
        for (const m of data.messages) {
          if (m === recap) continue;
          const article = document.createElement('article'); article.className = `chat-message chat-${m.role}`;
          const heading = document.createElement('strong'); heading.textContent = `${m.kind === 'recap' ? '历史讨论回顾（整理稿）' : m.role === 'user' ? '我' : 'Codex'} · ${new Date(m.at).toLocaleString()}`;
          const body = document.createElement('div'); body.className = 'prose'; body.innerHTML = renderMarkdown(m.text || '正在准备回答…');
          article.append(heading, body);
          if (m.source || m.status || m.error) { const meta = document.createElement('small'); meta.textContent = [({ generating: '回答中', completed: '已完成', failed: '未完成', interrupted: '已中断' })[m.status], m.source, m.error].filter(Boolean).join(' · '); article.append(meta); }
          log.append(article);
        }
        if (!data.messages.length) log.textContent = '先写自己的理解，再从一个疑问开始。讨论会留在这张卡片下方。';
        if (nearEnd && !(data.messages.length === 1 && data.messages[0].kind === 'recap')) log.scrollTop = log.scrollHeight;
      }
      const running = data.busy || data.messages.some(m => m.status === 'generating') || data.recapJob?.status === 'generating';
      $('#chat-send').disabled = submitting || running;
      $('#check-understanding').disabled = submitting || running;
      $('#finish-discussion').disabled = submitting || running || !data.messages.length;
      $('#chat-stop').hidden = !running;
      $('#chat-stop').textContent = data.recapJob?.status === 'generating' ? '停止整理' : '停止回答';
      const latest = data.recaps?.at(-1), recapState = data.recapJob;
      $('#recap-status').textContent = recapState?.status === 'generating' ? '正在整理，请暂时不要关机；旧回顾仍保留。' : ['failed', 'interrupted'].includes(recapState?.status) ? recapState.error : latest?.coveredCount === data.messages.length ? (state.dirty ? '回顾已保存，但正文还有未保存修改，请先保存。' : '本次回顾已保存，可以关闭。下次打开会保留。') : latest ? '上次回顾后有新讨论，结束时可再次更新。' : '讨论结束后点上方按钮，等到显示已保存再关闭。';
      $('#chat-download').href = `/api/notes/${id}/discussion/download`;
      timer = setTimeout(refresh, running ? 900 : 5000);
    } catch (error) { if (current === id) { feedback(`无法读取讨论：${error.message}`); timer = setTimeout(refresh, 5000); } }
  }
  function render() {
    if (current === state.active?.id) return;
    remember(); current = state.active?.id; epoch++; signature = '';
    $('#chat-log').replaceChildren(); feedback('');
    try { $('#chat-input').value = localStorage.getItem(key(current)) || ''; } catch { $('#chat-input').value = ''; }
    refresh();
  }
  async function prepare(id, question) {
    if (!(await save()) || !(await selectNote(id))) return;
    state.learningView = false; $('#learning-view').hidden = true; $('#workspace').hidden = false;
    render();
    if (!$('#chat-input').value.trim()) $('#chat-input').value = question || '请核对我目前的理解，先指出最多三个关键疑点，再给一个提示让我自己修正。';
    remember(); $('#inline-chat').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#chat-input').focus();
    feedback('问题已准备好，可以修改。点击发送后才会调用 Codex。');
  }
  async function send(text, clearDraft = false) {
    if (submitting || !state.active || !text.trim()) return;
    const id = current, draft = $('#chat-input').value;
    submitting = true; $('#chat-send').disabled = true; $('#check-understanding').disabled = true; feedback('正在保存笔记并准备发送…');
    try {
      if (!(await save())) throw new Error('笔记尚未保存，请先解决上方的保存问题；本次未发送。');
      if (current !== id || state.active.id !== id) throw new Error('卡片已切换，本次未发送。');
      await api(`/api/notes/${id}/discussion`, { method: 'POST', body: JSON.stringify({ text, version: state.active.version }) });
      if (current === id) {
        if (clearDraft && $('#chat-input').value === draft) { $('#chat-input').value = ''; remember(); }
        feedback('已发送，已附上当前笔记内容。回答和讨论记录会留在此处，不会改正文。');
      }
    } catch (error) { if (current === id) feedback(error.name === 'TimeoutError' ? '发送状态不确定，先查看下方记录，避免重复发送。输入已保留。' : error.message); }
    finally { submitting = false; refresh(); }
  }
  $('#chat-form').addEventListener('submit', event => { event.preventDefault(); send($('#chat-input').value.trim(), true); });
  async function review() {
    if (submitting || state.busy || !state.active) return;
    $('#inline-chat').scrollIntoView({ behavior: 'smooth', block: 'center' });
    await send('请检查随本次请求附上的最新阅读卡片，包括「它在解决什么问题」「作者怎么分析这个问题」「大概怎么做」「我卡在哪里」及其他手写内容。对照提供的论文依据，区分理解正确、表达不清或不完整、与原文矛盾、证据不足；不能把留空或没写到当成错误。最多优先指出三个关键疑点，给章节或图号依据，再给一个提示让我自己修正。历史讨论仅供参考，不是已核实结论；未取得原文或缺少图像时请明确说明。不要改正文或代写总结。');
  }
  $('#chat-stop').addEventListener('click', async () => {
    try { await api(`/api/notes/${current}/discussion/stop`, { method: 'POST', body: '{}' }); feedback('已请求停止，已收到的文字会保留。'); refresh(); }
    catch (error) { feedback(error.message); }
  });
  async function finishDiscussion() {
    if (submitting || state.busy || !state.active) return;
    const id = current;
    submitting = true; $('#finish-discussion').disabled = true;
    $('#recap-status').textContent = '正在保存笔记并开始整理…';
    try {
      if (!(await save())) throw new Error('笔记尚未保存，本次未开始整理。');
      if (current !== id || state.active.id !== id) throw new Error('卡片已切换，本次未开始整理。');
      await api(`/api/notes/${id}/discussion/recap`, { method: 'POST', body: JSON.stringify({ version: state.active.version }) });
      feedback('已提交回顾整理。以回顾区域的保存状态为准，未发送的问题仍留在输入框。');
    } catch (error) { if (current === id) feedback(`回顾未确认完成：${error.message}`); }
    finally { submitting = false; refresh(); }
  }
  $('#finish-discussion').addEventListener('click', finishDiscussion);
  return { render, prepare, review, finishDiscussion };
}
