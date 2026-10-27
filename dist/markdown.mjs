// Small offline preview. Raw HTML, images, and executable URL schemes are deliberately disabled.
export const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function inline(text) {
  const tokens = [];
  const token = html => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let value = escape(text.replace(/\u0000/g, ''));
  value = value.replace(/`([^`]+)`/g, (_, code) => token(`<code>${code}</code>`));
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|zotero:\/\/[^\s)]+)\)/g, (_, label, url) => token(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return value.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}
export function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const result = [];
  let code = null, paragraph = [], list = null;
  const flushParagraph = () => { if (paragraph.length) { result.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const closeList = () => { if (list) { result.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph(); closeList();
      if (code !== null) { result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const item = line.match(/^\s*([-+*]|\d+[.)])\s+(.*)$/);
    if (heading) { flushParagraph(); closeList(); result.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
    else if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushParagraph(); closeList(); result.push('<hr>'); }
    else if (item) {
      flushParagraph(); const type = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== type) { closeList(); result.push(`<${type}>`); list = type; }
      result.push(`<li>${inline(item[2].replace(/^\[ \] /, '☐ ').replace(/^\[[xX]\] /, '☑ '))}</li>`);
    } else if (/^>\s?/.test(line)) { flushParagraph(); closeList(); result.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); }
    else if (!line.trim()) { flushParagraph(); closeList(); }
    else { closeList(); paragraph.push(line); }
  }
  flushParagraph(); closeList();
  if (code !== null) result.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
  return result.join('\n');
}

// Preserve exact raw Markdown between headings, including edits to the template.
export function sections(body) {
  const matches = [];
  let fence = null;
  for (const match of body.matchAll(/^(.*)(?:\r?\n|$)/gm)) {
    const line = match[1];
    const code = line.match(/^\s*(`{3,}|~{3,})/);
    if (code) {
      if (!fence) fence = code[1];
      else if (code[1][0] === fence[0] && code[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence && /^## .+/.test(line)) {
      matches.push({ 0: match[0], 1: line.slice(3).replace(/\r$/, ''), index: match.index });
    }
  }
  const parts = [];
  if (!matches.length) return [{ heading: '', prefix: '', content: body }];
  if (matches[0].index > 0) parts.push({ heading: '', prefix: '', content: body.slice(0, matches[0].index) });
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    parts.push({ heading: match[1], prefix: match[0], content: body.slice(match.index + match[0].length, matches[i + 1]?.index ?? body.length) });
  }
  return parts;
}
