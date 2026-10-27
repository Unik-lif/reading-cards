import { contextFields } from './context.mjs';
export const categoryOf = note => typeof note.category === 'string' ? note.category.trim() : '';

export function categoryIndex(notes) {
  const counts = new Map();
  for (const note of notes) {
    const name = categoryOf(note);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [
    { value: null, label: '全部领域', count: notes.length },
    { value: '', label: '未分类', count: counts.get('') || 0 },
    ...[...counts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))
      .map(name => ({ value: name, label: name, count: counts.get(name) })),
  ];
}

export function filterNotes(notes, category = null, query = '') {
  const search = query.trim().toLocaleLowerCase();
  return notes.filter(note => (category === null || categoryOf(note) === category)
    && `${note.title}\n${note.body}\n${categoryOf(note)}`.toLocaleLowerCase().includes(search));
}

export function draftMarkdown(note) {
  const fields = { type: note.type, id: note.id, title: note.title || '未命名阅读卡片', category: categoryOf(note), created: note.created, updated: note.updated, ...contextFields(note) };
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n${note.body}`;
}
