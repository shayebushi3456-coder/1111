import { escapeAttr, escapeHtml, fmtSize } from './ui';
import { renderMarkdown } from './renderers';

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
  renderCheckpointFileHtml?: (cp: CheckpointDraft, idx: number) => string;
  onCheckpointChange?: () => void;
  onCheckpointRender?: () => void;
}

// ============================================================
// Markdown 源码编辑器：源码 textarea + 实时预览，替代旧的
// contentEditable + document.execCommand 方案。
//
// 设计取舍（见 DESIGN.md 第 5 节）：
// - 用户输入即最终提交值，不存在"渲染态 → 反解析回 Markdown"的有损转换环节。
// - 工具栏按钮只做「在光标处插入/包裹 Markdown 语法字符串」，用标准
//   selectionStart/selectionEnd + setRangeText，不依赖已废弃的 execCommand。
// - 预览是只读渲染，底层使用 markdown-it，支持表格/代码块/列表/引用/链接等成熟 Markdown 能力。
// ============================================================

// mdToHtml 使用成熟开源 markdown-it 渲染 Markdown，避免维护手写 Markdown 子集。
// html=false/linkify 等安全与兼容配置集中在 renderers.ts 中。
export function mdToHtml(src: string): string {
  return renderMarkdown(src);
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

function insertAtCursor(ta: HTMLTextAreaElement, text: string): void {
  const start = ta.selectionStart;
  ta.focus();
  ta.setRangeText(text, start, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

let mdPreviewDebounce: number | undefined;

export interface MarkdownEditorOptions {
  root: HTMLElement;
  sourceSelector: string;
  previewSelector: string;
  toggleSelector?: string;
  editorSelector?: string;
  initialText?: string;
  statsSelector?: string;
}

export function setupMarkdownEditor(options: MarkdownEditorOptions): void {
  const source = options.root.querySelector(options.sourceSelector) as HTMLTextAreaElement;
  const preview = options.root.querySelector(options.previewSelector) as HTMLElement;
  if (!source || !preview) return;
  if (options.initialText !== undefined) source.value = options.initialText;

  const renderPreview = () => {
    const html = mdToHtml(source.value);
    preview.innerHTML = html || '<span class="muted">开始输入以查看预览…</span>';
    if (options.statsSelector) {
      const stats = options.root.querySelector(options.statsSelector) as HTMLElement | null;
      if (stats) {
        const text = source.value;
        stats.textContent = `${text ? text.split('\n').length : 0} 行 · ${text.length} 字`;
      }
    }
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

  options.root.querySelectorAll<HTMLElement>('[data-md-cmd]').forEach(btn => btn.addEventListener('click', () => {
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
  options.root.querySelectorAll<HTMLElement>('[data-md-template]').forEach(btn => btn.addEventListener('click', () => {
    const tpl = btn.getAttribute('data-md-template');
    if (tpl === 'goal') insertAtCursor(source, '### 任务目标\n请基于输入文件完成...\n\n### 输出要求\n- 结果需要可核验\n- 保留关键计算过程\n');
    if (tpl === 'steps') insertAtCursor(source, '### 执行步骤\n1. 读取并理解输入文件\n2. 完成分析或生成任务\n3. 输出最终结果并说明依据\n');
    if (tpl === 'table') insertAtCursor(source, '| 指标 | 要求 | 说明 |\n| --- | --- | --- |\n| 准确性 | 必须满足 | 结论与输入一致 |\n| 完整性 | 必须满足 | 覆盖全部校验点 |\n');
  }));

  // 仅源码 / 源码+预览 切换：双栏是默认体验，切换态只影响当前编辑器自身。
  const toggle = options.toggleSelector ? options.root.querySelector(options.toggleSelector) as HTMLElement : null;
  const editor = options.editorSelector ? options.root.querySelector(options.editorSelector) as HTMLElement : null;
  if (toggle && editor?.classList.contains('cs-md-editor-source-only')) {
    toggle.classList.add('active');
    toggle.title = '显示预览';
  }
  toggle?.addEventListener('click', () => {
    if (!editor) return;
    const collapsed = editor.classList.toggle('cs-md-editor-source-only');
    toggle.classList.toggle('active', collapsed);
    toggle.title = collapsed ? '显示预览' : '仅源码';
  });
}

export function setupRichEditor(card: HTMLElement, initialText: string): void {
  setupMarkdownEditor({
    root: card,
    sourceSelector: '.cs-case-description',
    previewSelector: '.cs-case-description-preview',
    toggleSelector: '.cs-md-toggle-preview',
    editorSelector: '.cs-md-editor',
    initialText,
  });
}

function checkpointFileChipsHtml(cp: CheckpointDraft, idx: number): string {
  const chips: string[] = [];
  cp.existingFileIds.forEach((fid, fidx) => {
    chips.push(`<span class="chip" style="font-size:11px;"><span class="mono">▢</span> ${escapeHtml(fid)} <button type="button" style="cursor:pointer;color:var(--err);margin-left:4px;border:none;background:none;padding:0;" data-ckpt-remove-existing-file="${idx}:${fidx}" aria-label="解绑参考文件 ${escapeAttr(fid)}">✕</button></span>`);
  });
  cp.newFiles.forEach((f, fidx) => {
    chips.push(`<span class="chip" style="font-size:11px;"><span class="mono">▢</span> ${escapeHtml(f.name)} <button type="button" style="cursor:pointer;color:var(--err);margin-left:4px;border:none;background:none;padding:0;" data-ckpt-remove-new-file="${idx}:${fidx}" aria-label="移除参考文件 ${escapeAttr(f.name)}">✕</button></span>`);
  });
  return chips.join('');
}

function defaultCheckpointFileAssetsHtml(cp: CheckpointDraft, idx: number): string {
  const rows: string[] = [];
  cp.existingFileIds.forEach((fid, fidx) => rows.push(`
    <div class="file-asset-row compact" data-ckpt-existing-file="${idx}:${fidx}">
      <div class="file-asset-icon mono">REF</div>
      <div class="file-asset-meta"><b>${escapeHtml(fid)}</b><span>已绑定 · 仅评测可见</span></div>
      <div class="file-asset-actions"><button type="button" data-ckpt-remove-existing-file="${idx}:${fidx}">解绑</button></div>
    </div>`));
  cp.newFiles.forEach((f, fidx) => rows.push(`
    <div class="file-asset-row compact" data-ckpt-new-file="${idx}:${fidx}">
      <div class="file-asset-icon mono">NEW</div>
      <div class="file-asset-meta"><b>${escapeHtml(f.name)}</b><span>${fmtSize(f.size)} · 待保存 · 仅评测可见</span></div>
      <div class="file-asset-actions"><button type="button" data-ckpt-remove-new-file="${idx}:${fidx}">移除</button></div>
    </div>`));
  return rows.join('') || '<div class="file-empty-hint">暂无参考文件</div>';
}

// renderCheckpointEditor 渲染校验点列表：每条校验点是一个可展开的小卡片（文本 + 参考文件 chip +
// 单文件选择入口），而非单纯的只读 pill——校验点参考文件（标准答案/评分参考图/规范文档等）
// 仅供评测阶段使用，与用例级关联文件的隔离语义不同，因此用独立的 UI 区块承载，不复用 cs-case-files。
export function renderCheckpointEditor(row: CheckpointEditorRow): void {
  const list = row.card.querySelector('.cs-checkpoint-list') as HTMLElement;
  const fileHtml = row.renderCheckpointFileHtml || defaultCheckpointFileAssetsHtml;
  list.innerHTML = row.checkpoints.map((cp, idx) => `
    <div class="checkpoint-item" data-ckpt-idx="${idx}">
      <div class="checkpoint-item-head">
        <div><span class="mono">#${String(idx + 1).padStart(2, '0')}</span><strong>校验点</strong></div>
        <div class="checkpoint-actions">
          <button type="button" data-duplicate-checkpoint="${idx}">复制</button>
          <button type="button" data-move-checkpoint-up="${idx}" ${idx === 0 ? 'disabled' : ''}>上移</button>
          <button type="button" data-move-checkpoint-down="${idx}" ${idx === row.checkpoints.length - 1 ? 'disabled' : ''}>下移</button>
          <button type="button" class="danger" data-remove-checkpoint="${idx}">删除</button>
        </div>
      </div>
      <textarea class="checkpoint-edit-textarea" data-ckpt-desc="${idx}" placeholder="输入详细校验标准，支持换行、编号和复杂符号。">${escapeHtml(cp.description)}</textarea>
      <div class="checkpoint-files-head">
        <span>参考文件 · 仅评测阶段可见</span>
        <label>
          <input type="file" multiple data-ckpt-file-input="${idx}">绑定参考文件
        </label>
      </div>
      <div class="checkpoint-file-list">${fileHtml(cp, idx)}</div>
    </div>`).join('') || '<div class="checkpoint-empty"><b>还没有校验点</b><span>在上方输入详细判定标准，然后点击“添加校验点”。</span></div>';

  const notifyChange = () => row.onCheckpointChange?.();
  list.querySelectorAll<HTMLTextAreaElement>('[data-ckpt-desc]').forEach(input => input.addEventListener('input', () => {
    const idx = Number(input.getAttribute('data-ckpt-desc'));
    row.checkpoints[idx].description = input.value;
    notifyChange();
  }));
  list.querySelectorAll('[data-duplicate-checkpoint]').forEach(el => el.addEventListener('click', () => {
    const idx = Number(el.getAttribute('data-duplicate-checkpoint'));
    const cp = row.checkpoints[idx];
    row.checkpoints.splice(idx + 1, 0, { description: `${cp.description}\n（副本）`, existingFileIds: [...cp.existingFileIds], newFiles: [...cp.newFiles] });
    renderCheckpointEditor(row);
    notifyChange();
  }));
  list.querySelectorAll('[data-move-checkpoint-up]').forEach(el => el.addEventListener('click', () => {
    const idx = Number(el.getAttribute('data-move-checkpoint-up'));
    if (idx <= 0) return;
    [row.checkpoints[idx - 1], row.checkpoints[idx]] = [row.checkpoints[idx], row.checkpoints[idx - 1]];
    renderCheckpointEditor(row);
    notifyChange();
  }));
  list.querySelectorAll('[data-move-checkpoint-down]').forEach(el => el.addEventListener('click', () => {
    const idx = Number(el.getAttribute('data-move-checkpoint-down'));
    if (idx >= row.checkpoints.length - 1) return;
    [row.checkpoints[idx + 1], row.checkpoints[idx]] = [row.checkpoints[idx], row.checkpoints[idx + 1]];
    renderCheckpointEditor(row);
    notifyChange();
  }));
  list.querySelectorAll('[data-remove-checkpoint]').forEach(el => el.addEventListener('click', () => {
    row.checkpoints.splice(Number(el.getAttribute('data-remove-checkpoint')), 1);
    renderCheckpointEditor(row);
    notifyChange();
  }));
  list.querySelectorAll('[data-ckpt-remove-existing-file]').forEach(el => el.addEventListener('click', () => {
    const [idx, fidx] = el.getAttribute('data-ckpt-remove-existing-file')!.split(':').map(Number);
    row.checkpoints[idx].existingFileIds.splice(fidx, 1);
    renderCheckpointEditor(row);
    notifyChange();
  }));
  list.querySelectorAll('[data-ckpt-remove-new-file]').forEach(el => el.addEventListener('click', () => {
    const [idx, fidx] = el.getAttribute('data-ckpt-remove-new-file')!.split(':').map(Number);
    row.checkpoints[idx].newFiles.splice(fidx, 1);
    renderCheckpointEditor(row);
    notifyChange();
  }));
  list.querySelectorAll<HTMLInputElement>('[data-ckpt-file-input]').forEach(input => input.addEventListener('change', () => {
    const idx = Number(input.getAttribute('data-ckpt-file-input'));
    if (input.files) row.checkpoints[idx].newFiles.push(...Array.from(input.files));
    input.value = '';
    renderCheckpointEditor(row);
    notifyChange();
  }));
  row.onCheckpointRender?.();
}

export function addCheckpointFromInput(row: CheckpointEditorRow): void {
  const input = row.card.querySelector('.cs-checkpoint-input') as HTMLTextAreaElement;
  const value = input.value.trim();
  if (!value) return;
  row.checkpoints.push({ description: value, existingFileIds: [], newFiles: [] });
  input.value = '';
  renderCheckpointEditor(row);
  row.onCheckpointChange?.();
}
