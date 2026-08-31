import MarkdownIt from 'markdown-it';
import { escapeHtml } from './ui';

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const targetIndex = token.attrIndex('target');
  if (targetIndex < 0) token.attrPush(['target', '_blank']);
  else token.attrs![targetIndex][1] = '_blank';

  const relIndex = token.attrIndex('rel');
  if (relIndex < 0) token.attrPush(['rel', 'noopener noreferrer']);
  else token.attrs![relIndex][1] = 'noopener noreferrer';

  return self.renderToken(tokens, idx, options);
};

export function renderMarkdown(md: string): string {
  return markdown.render(md || '');
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
