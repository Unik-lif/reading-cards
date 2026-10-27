import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore, NoteError } from './store.mjs';
import { createZotero } from './zotero.mjs';
import { createDiscussions, discussionMarkdown } from './discussions.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export const defaultNotes = path.resolve(root, 'data/notes');
const defaultTemplate = path.resolve(root, 'templates/泛读卡片.md');
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/markdown.mjs': ['markdown.mjs', 'text/javascript; charset=utf-8'],
  '/categories.mjs': ['categories.mjs', 'text/javascript; charset=utf-8'],
  '/context.mjs': ['context.mjs', 'text/javascript; charset=utf-8'],
  '/connections.mjs': ['connections.mjs', 'text/javascript; charset=utf-8'],
  '/clipboard.mjs': ['clipboard.mjs', 'text/javascript; charset=utf-8'],
  '/filenames.mjs': ['filenames.mjs', 'text/javascript; charset=utf-8'],
  '/chat.mjs': ['chat.mjs', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
export function createApp({ directory = defaultNotes, template = defaultTemplate, zotero = createZotero(), runner } = {}) {
  const store = createStore(directory, template);
  const discussions = createDiscussions({ directory, store, zotero, runner });
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const host = `127.0.0.1:${port}`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      // No network exposure, DNS rebinding, cross-origin reads, or form-based writes.
      if (req.headers.host !== host) throw new NoteError('请用 127.0.0.1 地址访问。', 403);
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw new NoteError('不允许跨站访问。', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new NoteError('不允许跨站访问。', 403);
      const url = new URL(req.url, `http://${host}`);
      const route = url.pathname;
      const write = ['POST', 'PUT'].includes(req.method);
      let input;
      if (write) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new NoteError('需要 JSON 格式。', 415);
        const chunks = []; let bytes = 0;
        for await (const part of req) {
          bytes += part.length;
          if (bytes > 2_500_000) throw new NoteError('单次保存内容过大。', 413);
          chunks.push(part);
        }
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new NoteError('数据格式不正确。'); }
        if (!input || typeof input !== 'object') throw new NoteError('数据格式不正确。');
      }
      if (req.method === 'GET' && route === '/api/info') return json({ app: 'reading-cards', features: ['categories', 'connections-v1', 'rename-v1', 'chat-v1'], directory, template, workspace: root });
      if (req.method === 'GET' && route === '/api/zotero/search') {
        if ([...url.searchParams.keys()].some(key => key !== 'q')) throw new NoteError('不支持的搜索参数。');
        return json(await zotero.search(url.searchParams.get('q')));
      }
      const zoteroRoute = route.match(/^\/api\/zotero\/items\/([A-Z0-9]{8})(\/attachments)?$/);
      if (req.method === 'GET' && zoteroRoute) {
        if (url.search) throw new NoteError('不支持的条目参数。');
        return json(await (zoteroRoute[2] ? zotero.attachments(zoteroRoute[1]) : zotero.item(zoteroRoute[1])));
      }
      if (req.method === 'GET' && route === '/api/notes') return json(await store.all());
      const chatRoute = route.match(/^\/api\/notes\/([0-9a-f-]{36})\/discussion(\/stop|\/download|\/recap)?$/);
      if (chatRoute) {
        const [, id, action] = chatRoute;
        if (req.method === 'GET') {
          const data = await discussions.get(id);
          if (action === '/download') {
            res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="discussion-${id}.md"` });
            return res.end(discussionMarkdown(await store.get(id), data));
          }
          if (!action) return json(data);
        }
        if (req.method === 'POST' && action === '/stop') return json(await discussions.stop(id));
        if (req.method === 'POST' && action === '/recap') return json(await discussions.recap(id, input), 202);
        if (req.method === 'POST' && !action) return json(await discussions.start(id, input), 202);
      }
      if (req.method === 'POST' && route === '/api/notes') return json(await store.create(input), 201);
      const renameRoute = route.match(/^\/api\/notes\/([0-9a-f-]{36})\/rename$/);
      if (renameRoute && req.method === 'POST') return json(await store.rename(renameRoute[1], input));
      const match = route.match(/^\/api\/notes\/([0-9a-f-]{36})(\/download)?$/);
      if (match && req.method === 'GET') {
        if (match[2]) {
          const file = await store.download(match[1]);
          res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` });
          return res.end(file.raw);
        }
        return json(await store.get(match[1]));
      }
      if (match && !match[2] && req.method === 'PUT') return json(await store.save(match[1], input));
      if (req.method === 'GET' && assets[route]) {
        const [file, type] = assets[route];
        const content = await readFile(path.join(root, 'dist', file));
        res.writeHead(200, { 'Content-Type': type }); return res.end(content);
      }
      return json({ error: '未找到。' }, 404);
    } catch (error) {
      if (!(error instanceof NoteError)) console.error('Reading cards:', error.message);
      return json({ error: error instanceof NoteError ? error.message : '文件暂时无法读取或保存。请确认文件夹可访问，下载草稿以保留输入。' }, error.status || 500);
    }
  });
  server.on('close', () => discussions.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.READING_CARDS_PORT || 4317);
  const server = createApp({ directory: process.env.READING_CARDS_DIR ? path.resolve(process.env.READING_CARDS_DIR) : defaultNotes });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用；若已启动阅读卡片，直接打开网页即可。` : error.message);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`泛读 · 阅读卡片\nLocal: http://127.0.0.1:${port}\nMarkdown: ${process.env.READING_CARDS_DIR || defaultNotes}\n仅在本机运行。按 Control+C 停止。`);
  });
}
