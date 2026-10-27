export function normalizeFilename(value) {
  if (typeof value !== 'string') throw new Error('请填写文件名。');
  let name = value.trim().normalize('NFC');
  if (!name || name.startsWith('.') || /[\\/:*?"<>|\p{Cc}]/u.test(name)) throw new Error('文件名不能为空，不能以点开头，也不能包含路径、换行或 \\ / : * ? " < > |。');
  name = name.replace(/\.md$/i, '').trim();
  if (!name || /[. ]$/.test(name)) throw new Error('请填写有效文件名，结尾不能是点。');
  const result = `${name}.md`;
  if (new TextEncoder().encode(result).length > 240) throw new Error('文件名太长，请缩短一些（中文建议不超过 75 字）。');
  return result;
}

export function suggestedFilename(note) {
  const title = (note.title || '未命名阅读卡片').replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').replace(/^[. ]+|[. ]+$/g, '') || '未命名阅读卡片';
  const prefix = /^\d{4}-\d{2}-\d{2}$/.test(note.created) ? `${note.created} ` : '';
  let name = `${prefix}${title}`;
  while (new TextEncoder().encode(`${name}.md`).length > 240) name = [...name].slice(0, -1).join('');
  return normalizeFilename(name);
}
