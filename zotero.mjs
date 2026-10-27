import { NoteError } from './store.mjs';
const base = 'http://127.0.0.1:23119/api/users/0/';
const validKey = key => /^[A-Z0-9]{8}$/.test(key);
const clean = (value, max = 1000) => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
export function createZotero(fetcher = fetch) {
  async function read(relative) {
    try {
      const response = await fetcher(base + relative, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Zotero-API-Version': '3', Accept: 'application/json' } });
      if (response.status === 403) throw new NoteError('Zotero 未允许本机访问。请在设置 → 高级中开启「允许此计算机上的其他应用与 Zotero 通信」，然后重试。', 503);
      if (response.status === 404) throw new NoteError('Zotero 中找不到这个条目，可能已被移动或删除。原有绑定仍保留，可重新选择。', 404);
      if (!response.ok) throw new Error('Zotero response');
      let size = 0; const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 4_000_000) throw new Error('Zotero response too large');
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      if (error instanceof NoteError) throw error;
      throw new NoteError('暂时连接不到 Zotero 本机接口。请启动 Zotero 后重试，也可以粘贴 Zotero 链接；已绑定的信息不会丢失。', 503);
    }
  }
  function summarize(item) {
    if (!validKey(item?.key) || !item.data) throw new NoteError('Zotero 返回了无法识别的条目。', 502);
    return { library: 'user', libraryId: '0', itemKey: item.key, title: clean(item.data.title),
      authors: clean(item.meta?.creatorSummary || (item.data.creators || []).map(c => c.name || `${c.firstName || ''} ${c.lastName || ''}`.trim()).join(', ')),
      year: clean(item.meta?.parsedDate || item.data.date, 40).match(/\d{4}/)?.[0] || '',
      itemType: clean(item.data.itemType, 50), parentItem: item.data.parentItem || '', contentType: clean(item.data.contentType, 100) };
  }
  return {
    async fulltext(binding) {
      if (binding?.library !== 'user' || !validKey(binding?.attachmentKey) || !validKey(binding?.itemKey)) throw new NoteError('未绑定本机个人文库的 PDF。');
      const attachment = summarize(await read(`items/${binding.attachmentKey}?format=json`));
      if (attachment.itemType !== 'attachment' || attachment.contentType !== 'application/pdf' || attachment.parentItem !== binding.itemKey) throw new NoteError('PDF 与论文条目不匹配。');
      const result = await read(`items/${binding.attachmentKey}/fulltext`);
      if (typeof result.content !== 'string' || !result.content.trim()) throw new NoteError('Zotero 尚未索引 PDF 文本。');
      return { text: result.content.slice(0, 150000), truncated: result.content.length > 150000 };
    },
    async search(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > 200 || /[\u0000-\u001f]/.test(query)) throw new NoteError('搜索词需要 1–200 字。');
      const params = new URLSearchParams({ q: query.trim(), qmode: 'titleCreatorYear', itemType: '-attachment || note', limit: '30', format: 'json' });
      const results = await read(`items/top?${params}`);
      if (!Array.isArray(results)) throw new NoteError('Zotero 返回了无法识别的搜索结果。', 502);
      return results.filter(item => !['attachment', 'note'].includes(item.data?.itemType)).map(summarize);
    },
    async item(key) {
      if (!validKey(key)) throw new NoteError('无效的 Zotero 编号。');
      return summarize(await read(`items/${key}?format=json`));
    },
    async attachments(key) {
      if (!validKey(key)) throw new NoteError('无效的 Zotero 编号。');
      const results = await read(`items/${key}/children?format=json`);
      if (!Array.isArray(results)) throw new NoteError('Zotero 返回了无法识别的附件。', 502);
      return results.filter(item => item.data?.itemType === 'attachment' && item.data?.contentType === 'application/pdf' && item.data?.parentItem === key)
        .map(item => ({ key: summarize(item).itemKey, title: clean(item.data.title || item.data.filename || 'PDF') }));
    },
  };
}
