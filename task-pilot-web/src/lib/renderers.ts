import { escapeHtml } from './ui';

function inlineMd(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/✅/g, '<span style="color:var(--ok)">✓</span>').replace(/❌/g, '<span style="color:var(--err)">✗</span>').replace(/⚠️/g, '<span style="color:var(--queue)">!</span>');
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (inList) { html += '</ul>'; inList = false; } continue; }
    if (line.startsWith('# ')) { html += `<h1>${inlineMd(line.slice(2))}</h1>`; continue; }
    if (line.startsWith('## ')) { html += `<h2>${inlineMd(line.slice(3))}</h2>`; continue; }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineMd(line.slice(2))}</li>`;
      continue;
    }
    if (line.startsWith('> ')) { html += `<p style="border-left:2px solid var(--line-strong);padding-left:10px;color:var(--quiet);">${inlineMd(line.slice(2))}</p>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    html += `<p>${inlineMd(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

export function renderJSON(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    const items = obj.map(v => pad + '  ' + renderJSONValue(v, indent + 1)).join(',\n');
    return `[\n${items}\n${pad}]`;
  }
  if (obj !== null && typeof obj === 'object') {
    const keys = Object.keys(obj as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const items = keys.map(k => `${pad}  <span class="k">"${escapeHtml(k)}"</span>: ${renderJSONValue((obj as Record<string, unknown>)[k], indent + 1)}`).join(',\n');
    return `{\n${items}\n${pad}}`;
  }
  return renderJSONValue(obj, indent);
}

function renderJSONValue(v: unknown, indent: number): string {
  if (typeof v === 'string') return `<span class="s">"${escapeHtml(v)}"</span>`;
  if (typeof v === 'number') return `<span class="n">${v}</span>`;
  if (typeof v === 'boolean' || v === null) return `<span class="b">${v}</span>`;
  return renderJSON(v, indent);
}
