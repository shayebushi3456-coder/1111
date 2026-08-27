import { escapeHtml } from './ui';

// CheckpointDraft 单条校验点的编辑态：文本描述 + 已有文件 ID（编辑已有用例时）+ 本次新选中的文件
// （提交时才真正上传，与用例级关联文件的既有交互一致）。
export interface CheckpointDraft {
  description: string;
  existingFileIds: string[];
  newFiles: File[];
}

export interface CheckpointEditorRow {
  card: HTMLElement;
  checkpoints: CheckpointDraft[];
}

// ============================================================
// Markdown 源码编辑器：源码 textarea + 实时预览，替代旧的
// contentEditable + document.execCommand 方案。
//
// 设计取舍（见 DESIGN.md 第 5 节）：
// - 用户输入即最终提交值，不存在"渲染态 → 反解析回 Markdown"的有损转换环节。
// - 工具栏按钮只做「在光标处插入/包裹 Markdown 语法字符串」，用标准
//   selectionStart/selectionEnd + setRangeText，不依赖已废弃的 execCommand。
// - 预览是只读渲染，覆盖任务描述场景常用的语法子集（标题/粗斜体/行内代码/
//   代码块/列表/引用/分割线/链接），不追求 CommonMark 完整实现。
// ============================================================

// mdToHtml 把 Markdown 源码转换成用于预览的 HTML 片段。逐行状态机 + 少量行内正则，
// 覆盖任务描述场景的常用子集；未覆盖的语法原样保留为文本，不会报错或丢内容。
export function mdToHtml(src: string): string {
  if (!src.trim()) return '';
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) { out.push(listType === 'ul' ? '</ul>' : '</ol>'); listType = null; }
  };
  const inline = (text: string): string => {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
    s = s.replace(/\[([^\]]*)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      closeList();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++; // 跳过收尾 ```
      out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      closeList();
      out.push('<hr>');
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      closeList();
      const level = Math.min(h[1].length, 3); // 任务描述场景不需要 h4-h6，统一收敛到 h3
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      i++;
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      i++;
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      i++;
      continue;
    }
    if (!trimmed) {
      closeList();
      i++;
      continue;
    }
    closeList();
    out.push(`<p>${inline(trimmed)}</p>`);
    i++;
  }
  closeList();
  return out.join('');
}

// wrapSelection 包裹/插入语法片段。有选中内容时包裹选中文本；无选中则插入占位文本并选中它，
// 方便用户直接开始输入替换占位（例如点"加粗"后插入 **粗体** 并自动选中"粗体"两字）。
function wrapSelection(ta: HTMLTextAreaElement, before: string, after: string, placeholder: string): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const selected = ta.value.slice(start, end) || placeholder;
  ta.focus();
  ta.setRangeText(before + selected + after, start, end, 'select');
  // setRangeText 的 'select' 模式选中整段替换文本（含 before/after），
  // 这里再收窄到只选中中间内容，方便用户立刻输入覆盖。
  ta.setSelectionRange(start + before.length, start + before.length + selected.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

// prefixLines 给选中的每一行行首插入前缀；用于列表/引用/标题按钮。
// getPrefix 支持有序列表这种"前缀随行号递增"的场景。
function prefixLines(ta: HTMLTextAreaElement, getPrefix: (lineIndex: number) => string): void {
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const value = ta.value;
  let lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', end);
  if (lineEnd === -1) lineEnd = value.length;
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const prefixed = lines.map((l, idx) => getPrefix(idx) + l).join('\n');
  ta.focus();
  ta.setRangeText(prefixed, lineStart, lineEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function toggleHeading(ta: HTMLTextAreaElement): void {
  const start = ta.selectionStart;
  const value = ta.value;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = value.indexOf('\n', start);
  if (lineEnd === -1) lineEnd = value.length;
  const line = value.slice(lineStart, lineEnd);
  const m = /^(#{1,3})\s+(.*)$/.exec(line);
  const nextLine = m ? (m[1].length < 3 ? '#'.repeat(m[1].length + 1) + ' ' + m[2] : m[2]) : '### ' + line;
  ta.focus();
  ta.setRangeText(nextLine, lineStart, lineEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

export function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart;
  ta.focus();
  ta.setRangeText(text, start, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

let mdPreviewDebounce: number | undefined;

export function setupRichEditor(card: HTMLElement, initialText: string): void {
  const source = card.querySelector('.cs-case-description') as HTMLTextAreaElement;
  const preview = card.querySelector('.cs-case-description-preview') as HTMLElement;
  source.value = initialText;

  const renderPreview = () => {
    const html = mdToHtml(source.value);
    preview.innerHTML = html || '<span class="muted">开始输入以查看预览…</span>';
  };
  renderPreview();

  source.addEventListener('input', () => {
    window.clearTimeout(mdPreviewDebounce);
    mdPreviewDebounce = window.setTimeout(renderPreview, 120);
  });

  // Tab 键在源码区里插入两个空格，而不是把焦点切到下一个可聚焦元素——
  // 编辑 Markdown（尤其是嵌套列表/代码块缩进）时 Tab 应该是编辑操作。
  source.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      insertAtCursor(source, '  ');
    }
  });

  card.querySelectorAll<HTMLElement>('[data-md-cmd]').forEach(btn => btn.addEventListener('click', () => {
    const cmd = btn.getAttribute('data-md-cmd');
    if (cmd === 'bold') wrapSelection(source, '**', '**', '粗体');
    else if (cmd === 'italic') wrapSelection(source, '*', '*', '斜体');
    else if (cmd === 'code') wrapSelection(source, '`', '`', '代码');
    else if (cmd === 'codeblock') wrapSelection(source, '```\n', '\n```', '代码块内容');
    else if (cmd === 'link') wrapSelection(source, '[', '](url)', '链接文字');
    else if (cmd === 'heading') toggleHeading(source);
    else if (cmd === 'quote') prefixLines(source, () => '> ');
    else if (cmd === 'ul') prefixLines(source, () => '- ');
    else if (cmd === 'ol') prefixLines(source, (idx) => `${idx + 1}. `);
  }));
  card.querySelectorAll<HTMLElement>('[data-md-template]').forEach(btn => btn.addEventListener('click', () => {
    const tpl = btn.getAttribute('data-md-template');
    if (tpl === 'goal') insertAtCursor(source, '### 任务目标\n请基于输入文件完成...\n\n### 输出要求\n- 结果需要可核验\n- 保留关键计算过程\n');
    if (tpl === 'steps') insertAtCursor(source, '### 执行步骤\n1. 读取并理解输入文件\n2. 完成分析或生成任务\n3. 输出最终结果并说明依据\n');
  }));

  // 仅源码 / 源码+预览 切换：双栏是默认体验，切换态只影响这张卡片自身。
  const toggle = card.querySelector('.cs-md-toggle-preview') as HTMLElement;
  const editor = card.querySelector('.cs-md-editor') as HTMLElement;
  toggle?.addEventListener('click', () => {
    const collapsed = editor.classList.toggle('cs-md-editor-source-only');
    toggle.classList.toggle('active', collapsed);
    toggle.title = collapsed ? '显示预览' : '仅源码';
  });
}

function checkpointFileChipsHtml(cp: CheckpointDraft, idx: number): string {
  const chips: string[] = [];
  cp.existingFileIds.forEach((fid, fidx) => {
    chips.push(`<span class="chip" style="font-size:11px;"><span class="mono">▢</span> ${escapeHtml(fid)} <span style="cursor:pointer;color:var(--err);margin-left:4px;" data-ckpt-remove-existing-file="${idx}:${fidx}">✕</span></span>`);
  });
  cp.newFiles.forEach((f, fidx) => {
    chips.push(`<span class="chip" style="font-size:11px;"><span class="mono">▢</span> ${escapeHtml(f.name)} <span style="cursor:pointer;color:var(--err);margin-left:4px;" data-ckpt-remove-new-file="${idx}:${fidx}">✕</span></span>`);
  });
  return chips.join('');
}

// renderCheckpointEditor 渲染校验点列表：每条校验点是一个可展开的小卡片（文本 + 参考文件 chip +
// 单文件选择入口），而非单纯的只读 pill——校验点参考文件（标准答案/评分参考图/规范文档等）
// 仅供评测阶段使用，与用例级关联文件的隔离语义不同，因此用独立的 UI 区块承载，不复用 cs-case-files。
export function renderCheckpointEditor(row: CheckpointEditorRow): void {
  const list = row.card.querySelector('.cs-checkpoint-list') as HTMLElement;
  list.innerHTML = row.checkpoints.map((cp, idx) => `
    <div class="checkpoint-item" data-ckpt-idx="${idx}" style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px;">
      <div style="display:flex;align-items:flex-start;gap:8px;">
        <span class="mono" style="font-size:11px;color:var(--quiet);flex:0 0 auto;margin-top:2px;">#${idx + 1}</span>
        <span style="flex:1;font-size:12.5px;line-height:1.5;">${escapeHtml(cp.description)}</span>
        <button type="button" data-remove-checkpoint="${idx}" title="移除" style="flex:0 0 auto;border:none;background:none;cursor:pointer;color:var(--err);">×</button>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px 20px;">${checkpointFileChipsHtml(cp, idx) || '<span class="muted" style="font-size:11px;">未关联参考文件</span>'}</div>
      <label style="margin-left:20px;font-size:11px;color:var(--accent);cursor:pointer;">
        <input type="file" multiple data-ckpt-file-input="${idx}" style="display:none;">＋ 添加参考文件（标准答案/评分参考图/规范文档，仅评测阶段可见）
      </label>
    </div>`).join('') || '<span class="muted" style="font-size:12px;">尚未添加校验点</span>';

  list.querySelectorAll('[data-remove-checkpoint]').forEach(el => el.addEventListener('click', () => {
    row.checkpoints.splice(Number(el.getAttribute('data-remove-checkpoint')), 1);
    renderCheckpointEditor(row);
  }));
  list.querySelectorAll('[data-ckpt-remove-existing-file]').forEach(el => el.addEventListener('click', () => {
    const [idx, fidx] = el.getAttribute('data-ckpt-remove-existing-file')!.split(':').map(Number);
    row.checkpoints[idx].existingFileIds.splice(fidx, 1);
    renderCheckpointEditor(row);
  }));
  list.querySelectorAll('[data-ckpt-remove-new-file]').forEach(el => el.addEventListener('click', () => {
    const [idx, fidx] = el.getAttribute('data-ckpt-remove-new-file')!.split(':').map(Number);
    row.checkpoints[idx].newFiles.splice(fidx, 1);
    renderCheckpointEditor(row);
  }));
  list.querySelectorAll<HTMLInputElement>('[data-ckpt-file-input]').forEach(input => input.addEventListener('change', () => {
    const idx = Number(input.getAttribute('data-ckpt-file-input'));
    if (input.files) row.checkpoints[idx].newFiles.push(...Array.from(input.files));
    input.value = '';
    renderCheckpointEditor(row);
  }));
}

export function addCheckpointFromInput(row: CheckpointEditorRow): void {
  const input = row.card.querySelector('.cs-checkpoint-input') as HTMLInputElement;
  const value = input.value.trim();
  if (!value) return;
  row.checkpoints.push({ description: value, existingFileIds: [], newFiles: [] });
  input.value = '';
  renderCheckpointEditor(row);
}
