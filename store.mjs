import { mkdir, readFile, readdir, lstat, writeFile, rename, unlink, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { normalizeZotero, normalizeDiscussion, normalizeGaps, contextFields } from './dist/context.mjs';
import { normalizeFilename } from './dist/filenames.mjs';

export class NoteError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const digest = text => createHash('sha256').update(text).digest('hex');
const date = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
const slug = title => title.replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 70) || '未命名阅读卡片';
const validId = id => /^[0-9a-f-]{36}$/.test(id);

function normalizeCategory(value) {
  if (typeof value !== 'string') throw new NoteError('领域名称必须是文字。');
  const category = value.trim();
  if (category.length > 40 || /\p{Cc}/u.test(category)) throw new NoteError('领域名称最多 40 字，不能包含换行等控制字符。');
  if (category === '未分类') throw new NoteError('「未分类」是保留名称。清空领域即可取消分类。');
  return category;
}

export function createStore(directory, template) {
  // Serialize all writes in this process so two browser tabs cannot both pass a version check.
  let queue = Promise.resolve();
  const serial = operation => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  async function entries() {
    await mkdir(directory, { recursive: true });
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith('.md'));
  }
  function decode(raw, filename) {
    const header = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!header) return null;
    const fields = {};
    for (const line of header[1].split(/\r?\n/)) {
      const match = line.match(/^(id|title|category|created|updated|type|zotero|discussionUrl|learningGaps):\s*(.*)$/);
      if (!match) continue;
      try { fields[match[1]] = JSON.parse(match[2]); } catch { fields[match[1]] = match[2]; }
    }
    if (fields.type !== 'reading-card' || !validId(fields.id || '')) return null;
    try {
      if (fields.zotero !== undefined) fields.zotero = normalizeZotero(fields.zotero);
      if (fields.discussionUrl !== undefined) fields.discussionUrl = normalizeDiscussion(fields.discussionUrl);
      if (fields.learningGaps !== undefined) fields.learningGaps = normalizeGaps(fields.learningGaps);
    } catch (error) { throw new NoteError(`${filename} 的关联元数据格式不正确：${error.message} 请在文件中修正后重试；文件未被改写。`, 422); }
    const body = raw.slice(header[0].length).replace(/^\r?\n/, '');
    return { ...fields, ...contextFields(fields), title: String(fields.title || '未命名阅读卡片'), category: typeof fields.category === 'string' ? fields.category.trim() : '', body, filename, version: digest(raw) };
  }
  function encode(note) {
    return '---\n' + ['type', 'id', 'title', 'category', 'created', 'updated', 'zotero', 'discussionUrl', 'learningGaps']
      .filter(key => note[key] !== undefined).map(key => `${key}: ${JSON.stringify(note[key])}`).join('\n') + '\n---\n\n' + note.body;
  }
  async function all() {
    const notes = [];
    for (const entry of await entries()) {
      const file = path.join(directory, entry.name);
      if (!(await lstat(file)).isFile()) continue;
      const note = decode(await readFile(file, 'utf8'), entry.name);
      if (note) notes.push(note);
    }
    return notes.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  }
  async function get(id) {
    if (!validId(id)) throw new NoteError('无效的卡片编号。');
    const matches = (await all()).filter(note => note.id === id);
    if (matches.length > 1) throw new NoteError('发现重复编号的文件，请先在文件夹中检查副本。', 409);
    if (!matches.length) throw new NoteError('找不到这张卡片，文件可能已被移动。', 404);
    return matches[0];
  }
  function validate(title, body) {
    if (typeof title !== 'string' || typeof body !== 'string') throw new NoteError('题目与正文必须是文字。');
    if (title.length > 200 || body.length > 500_000) throw new NoteError('题目最多 200 字，单张卡片最多 50 万字符。');
  }
  async function atomic(file, raw) {
    const temp = path.join(directory, `.reading-${randomUUID()}.tmp`);
    try {
      await writeFile(temp, raw, { flag: 'wx', mode: 0o600 });
      await rename(temp, file);
    } finally { await unlink(temp).catch(() => {}); }
  }
  return {
    directory, all, get,
    create: (input = {}) => serial(async () => {
      const category = normalizeCategory(input.category ?? '');
      await mkdir(directory, { recursive: true });
      const note = {
        type: 'reading-card', id: randomUUID(), title: '', category,
        created: date(), updated: new Date().toISOString(), body: await readFile(template, 'utf8'),
      };
      const filename = `${note.created} 未命名阅读卡片 ${note.id.slice(0, 8)}.md`;
      const raw = encode(note);
      await writeFile(path.join(directory, filename), raw, { flag: 'wx', mode: 0o600 });
      return decode(raw, filename);
    }),
    save: (id, input) => serial(async () => {
      validate(input.title, input.body);
      const note = await get(id);
      if (input.version !== note.version) throw new NoteError('文件已在别处改动。你的输入已保留，请先下载草稿，再重新载入文件核对。', 409);
      // Older open browser tabs omit category: keep the current field instead of silently clearing it.
      const category = input.category === undefined ? note.category : normalizeCategory(input.category);
      const extra = {};
      try {
        for (const [key, normalize] of Object.entries({ zotero: normalizeZotero, discussionUrl: normalizeDiscussion, learningGaps: normalizeGaps })) {
          extra[key] = input[key] === undefined ? note[key] : normalize(input[key]);
        }
      } catch (error) { throw new NoteError(error.message); }
      const next = { ...note, ...extra, title: input.title.trim(), category, body: input.body, updated: new Date().toISOString() };
      const raw = encode(next);
      // Keep the original filename after creation. Title lives in frontmatter; renaming outside the app is safe.
      // Recheck immediately before replacing to catch ordinary external-editor changes.
      const file = path.join(directory, note.filename);
      if (!(await lstat(file)).isFile() || digest(await readFile(file, 'utf8')) !== note.version)
        throw new NoteError('文件刚刚在别处改动，未覆盖。请下载草稿并重新载入。', 409);
      await atomic(file, raw);
      return decode(raw, note.filename);
    }),
    rename: (id, input) => serial(async () => {
      const note = await get(id);
      if (input.version !== note.version || input.filename !== note.filename) throw new NoteError('文件内容或名称已在别处改变。未重命名，请重新载入卡片后再试。', 409);
      let filename;
      try { filename = normalizeFilename(input.newFilename); } catch (error) { throw new NoteError(error.message); }
      if (filename === note.filename) return note;
      const source = path.join(directory, note.filename), destination = path.join(directory, filename);
      const sourceStat = await lstat(source), raw = await readFile(source, 'utf8');
      if (!sourceStat.isFile() || digest(raw) !== note.version) throw new NoteError('文件刚刚有改动。未重命名，请重新载入后再试。', 409);
      // link is exclusive: unlike rename(), it cannot replace an existing file or symlink.
      // Both names briefly point to the same bytes; no frontmatter/body reserialization.
      try { await link(source, destination); }
      catch (error) {
        if (error.code === 'EEXIST') throw new NoteError('这个文件名已存在，请换一个名称；没有覆盖任何文件。', 409);
        throw error;
      }
      try {
        const current = await lstat(source);
        if (current.ino !== sourceStat.ino || current.dev !== sourceStat.dev || digest(await readFile(source, 'utf8')) !== note.version)
          throw new NoteError('文件刚刚有改动。未重命名，请重新载入后再试。', 409);
        await unlink(source);
      } catch (error) {
        const created = await lstat(destination).catch(() => null);
        if (created?.ino === sourceStat.ino && created?.dev === sourceStat.dev) await unlink(destination);
        throw error;
      }
      return decode(raw, filename);
    }),
    download: async id => { const note = await get(id); return { name: `${slug(note.title)}.md`, raw: encode(note) }; },
  };
}
