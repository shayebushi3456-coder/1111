import { filesApi } from '@/api/files';
import { decodeText, extractTarGz, findMember } from '@/lib/tarball';
import { downloadZip } from '@/lib/minizip';
import { downloadConfigForMember, iconTypeOf, isInternalArtifactMember, looksBinary, sanitizeFolderName } from '@/lib/filePreview';
import { escapeAttr, escapeHtml, emptyStateHtml, errorStateHtml, fmtSize, skeletonRows } from '@/lib/ui';
import { renderJSON, renderMarkdown } from '@/lib/renderers';
import { errMsg, toast } from '@/core/feedback';
import type { CaseExecution, EvalRun, FileResponse, TarMember, TraceEvent, TraceItem, TraceItemKind, TraceUsage } from '@/types';

export async function fetchTaskMembers(taskId: string): Promise<{ artifact: FileResponse; members: TarMember[] } | null> {
  const artifacts = await filesApi.listArtifacts(taskId);
  if (artifacts.length === 0) return null;
  const artifact = artifacts[0];
  const blob = await filesApi.downloadBlob(artifact.file_id);
  const members = await extractTarGz(blob);
  return { artifact, members };
}

// ================= DRAWER: 通用文件预览 =================
const overlay = document.getElementById('drawer-overlay')!;
const drawer = document.getElementById('preview-drawer') as HTMLElement;
const drawerBackBtn = document.getElementById('drawer-back-btn') as HTMLButtonElement;
const drawerResizer = document.getElementById('drawer-resizer') as HTMLElement;
document.getElementById('drawer-close-btn')!.addEventListener('click', closeDrawer);
drawerBackBtn.addEventListener('click', () => {
  const prev = drawerHistory.pop();
  if (prev) restoreDrawerSnapshot(prev);
});
overlay.addEventListener('click', closeDrawer);
export type DrawerDownload = { url: string; filename?: string; revoke?: boolean } | null;
interface DrawerSnapshot {
  title: string;
  sub: string;
  bodyHtml: string;
  bodyClass: string;
  iconClass: string;
  iconText: string;
  download: DrawerDownload;
  onRestore?: () => void;
}
let currentDownload: DrawerDownload = null;
let drawerHistory: DrawerSnapshot[] = [];
document.getElementById('drawer-download-btn')!.addEventListener('click', () => {
  if (!currentDownload) { toast('当前内容不支持直接下载'); return; }
  const a = document.createElement('a');
  a.href = currentDownload.url;
  if (currentDownload.filename) a.download = currentDownload.filename;
  a.target = '_blank';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
});
function revokeDrawerDownload(download: DrawerDownload): void {
  if (download?.revoke) URL.revokeObjectURL(download.url);
}
function refreshDrawerBackButton(): void {
  drawerBackBtn.style.display = drawerHistory.length > 0 ? 'inline-flex' : 'none';
}
function snapshotDrawer(onRestore?: () => void): DrawerSnapshot {
  const body = document.getElementById('drawer-body')!;
  const icon = document.getElementById('drawer-file-icon')!;
  return {
    title: document.getElementById('drawer-title')!.textContent || '',
    sub: document.getElementById('drawer-sub')!.textContent || '',
    bodyHtml: body.innerHTML,
    bodyClass: body.className,
    iconClass: icon.className,
    iconText: icon.textContent || '',
    download: currentDownload,
    onRestore,
  };
}
function restoreDrawerSnapshot(s: DrawerSnapshot): void {
  if (currentDownload !== s.download) revokeDrawerDownload(currentDownload);
  document.getElementById('drawer-title')!.textContent = s.title;
  document.getElementById('drawer-sub')!.textContent = s.sub;
  const body = document.getElementById('drawer-body')!;
  body.innerHTML = s.bodyHtml;
  body.className = s.bodyClass;
  const icon = document.getElementById('drawer-file-icon')!;
  icon.className = s.iconClass;
  icon.textContent = s.iconText;
  currentDownload = s.download;
  s.onRestore?.();
  refreshDrawerBackButton();
}
export function openDrawer(title: string, sub: string, bodyHtml: string, iconType?: string, download?: string | DrawerDownload, options?: { pushHistory?: boolean; onRestoreCurrent?: () => void; preserveHistory?: boolean }): void {
  if (options?.pushHistory) {
    drawerHistory.push(snapshotDrawer(options.onRestoreCurrent));
  } else if (!options?.preserveHistory) {
    drawerHistory.forEach(s => revokeDrawerDownload(s.download));
    drawerHistory = [];
  }
  if (!options?.pushHistory) revokeDrawerDownload(currentDownload);
  document.getElementById('drawer-title')!.textContent = title;
  document.getElementById('drawer-sub')!.textContent = sub;
  document.getElementById('drawer-body')!.innerHTML = bodyHtml;
  document.getElementById('drawer-body')!.className = 'drawer-body';
  const icon = document.getElementById('drawer-file-icon')!;
  icon.className = 'file-icon ' + (iconType || '');
  icon.textContent = (iconType || '?').slice(0, 4).toUpperCase();
  currentDownload = typeof download === 'string'
    ? { url: download }
    : (download ?? null);
  overlay.classList.add('open'); drawer.classList.add('open');
  refreshDrawerBackButton();
}
export function closeDrawer(): void {
  overlay.classList.remove('open'); drawer.classList.remove('open');
  revokeDrawerDownload(currentDownload);
  drawerHistory.forEach(s => revokeDrawerDownload(s.download));
  currentDownload = null;
  drawerHistory = [];
  refreshDrawerBackButton();
}
export function loadingDrawerBody(): string {
  return `<div class="drawer-body pad">${skeletonRows(4, 40)}</div>`;
}

const savedDrawerWidth = Number(localStorage.getItem('we-drawer-width') || 0);
if (savedDrawerWidth) drawer.style.width = `${Math.min(Math.max(savedDrawerWidth, 520), Math.floor(window.innerWidth * 0.96))}px`;
drawerResizer.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  drawerResizer.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing-drawer');
  const onMove = (ev: PointerEvent) => {
    const min = 420;
    const max = Math.max(min, Math.floor(window.innerWidth * 0.96));
    const width = Math.min(Math.max(window.innerWidth - ev.clientX, min), max);
    drawer.style.width = `${width}px`;
  };
  const onUp = (ev: PointerEvent) => {
    drawerResizer.releasePointerCapture(ev.pointerId);
    document.body.classList.remove('resizing-drawer');
    localStorage.setItem('we-drawer-width', String(Math.round(drawer.getBoundingClientRect().width)));
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

function directDownloadHtml(title: string, desc: string, buttonText: string): string {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
    <h4>${escapeHtml(title)}</h4><p>${escapeHtml(desc)}</p>
    <button class="btn btn-primary" id="drawer-inline-download" style="margin-top:12px;">${escapeHtml(buttonText)}</button>
  </div>`;
}

function bindInlineDownloadButton(): void {
  document.getElementById('drawer-inline-download')?.addEventListener('click', () => {
    document.getElementById('drawer-download-btn')?.dispatchEvent(new MouseEvent('click'));
  });
}

interface ArtifactStageView {
  key: string;
  label: string;
  taskId: string;
  artifact?: FileResponse;
  members: TarMember[];
  visibleMembers: TarMember[];
  error?: string;
}

// ---- Artifacts drawer: 直接解压 output.tar.gz 并展示内部产物文件，而不是先展示压缩包本身 ----
export async function openArtifactsDrawer(run: EvalRun, ceId: string): Promise<void> {
  const ce = (run.case_executions || []).find(c => c.id === ceId);
  if (!ce) return;
  openDrawer('产物', ce.case_name, loadingDrawerBody(), 'json');

  const rawStages: { key: string; label: string; taskId?: string }[] = [
    { key: 'test', label: '测试阶段（被测系统执行结果）', taskId: ce.test_task_id },
    { key: 'eval', label: '评测阶段（评测 LLM 分析报告）', taskId: ce.eval_task_id },
  ];
  const stages = rawStages.filter((s): s is { key: string; label: string; taskId: string } => !!s.taskId);

  if (stages.length === 0) {
    document.getElementById('drawer-body')!.innerHTML = emptyStateHtml('暂无关联任务', '该用例尚未派发测试任务。');
    return;
  }

  const stageViews: ArtifactStageView[] = [];
  for (const stage of stages) {
    try {
      const result = await fetchTaskMembers(stage.taskId);
      if (!result) {
        stageViews.push({ ...stage, members: [], visibleMembers: [] });
        continue;
      }
      const visibleMembers = result.members.filter(m => !isInternalArtifactMember(m.name));
      stageViews.push({ ...stage, artifact: result.artifact, members: result.members, visibleMembers });
    } catch (e) {
      stageViews.push({ ...stage, members: [], visibleMembers: [], error: errMsg(e) });
    }
  }

  renderArtifactStages(ce.case_name, stageViews);
}

function renderArtifactStages(caseName: string, stages: ArtifactStageView[]): void {
  const body = document.getElementById('drawer-body')!;
  const totalVisible = stages.reduce((sum, s) => sum + s.visibleMembers.length, 0);
  const totalHidden = stages.reduce((sum, s) => sum + (s.members.length - s.visibleMembers.length), 0);
  document.getElementById('drawer-sub')!.textContent = totalHidden > 0
    ? `${caseName} · ${totalVisible} 个文件 · 已隐藏 ${totalHidden} 个内部文件`
    : `${caseName} · ${totalVisible} 个文件`;

  const sections = stages.map(stage => artifactStageHtml(stage)).join('');
  body.innerHTML = sections || emptyStateHtml('暂无产物文件', '任务可能仍在执行或没有生成 output 内容。');

  body.querySelectorAll<HTMLElement>('[data-stage-export]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const stage = stages.find(s => s.key === el.getAttribute('data-stage-export'));
      if (stage) exportArtifactStageZip(caseName, stage);
    });
  });
  body.querySelectorAll<HTMLElement>('[data-member-download]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const stage = stages.find(s => s.key === el.getAttribute('data-stage'));
      const member = stage?.visibleMembers[Number(el.getAttribute('data-member-download'))];
      if (member) triggerMemberDownload(member);
    });
  });
  body.querySelectorAll<HTMLElement>('[data-member-preview]').forEach(el => {
    el.addEventListener('click', () => {
      const stage = stages.find(s => s.key === el.getAttribute('data-stage'));
      const member = stage?.visibleMembers[Number(el.getAttribute('data-member-preview'))];
      if (!stage || !member) return;
      previewTarMember(member, stage.artifact?.filename || 'output.tar.gz', () => renderArtifactStages(caseName, stages));
    });
  });
}

function artifactStageHtml(stage: ArtifactStageView): string {
  const hiddenCount = stage.members.length - stage.visibleMembers.length;
  if (stage.error) {
    return `<div class="section-title">${escapeHtml(stage.label)}</div><p style="padding:0 18px 10px;font-size:12.5px;color:var(--err);">加载失败：${escapeHtml(stage.error)}</p>`;
  }
  if (!stage.artifact) {
    return `<div class="section-title">${escapeHtml(stage.label)}</div><p class="muted" style="padding:0 18px 10px;font-size:12.5px;">尚未上传产物（任务可能仍在执行或未产出任何文件）。</p>`;
  }
  if (stage.visibleMembers.length === 0) {
    const reason = stage.members.length === 0 ? '压缩包为空。' : `已隐藏 ${hiddenCount} 个内部文件。`;
    return `<div class="section-title">${escapeHtml(stage.label)}</div><p class="muted" style="padding:0 18px 10px;font-size:12.5px;">无可展示文件，${reason}</p>`;
  }
  return `<div class="section-title artifact-section-title">
      <span>${escapeHtml(stage.label)}</span>
      <button class="btn btn-ghost btn-sm" data-stage-export="${escapeAttr(stage.key)}">打包导出</button>
    </div>
    <div class="file-tree">
      ${stage.visibleMembers.map((m, i) => `<div class="file-row artifact-file-row" data-stage="${escapeAttr(stage.key)}" data-member-preview="${i}">
        ${fileRowIcon(iconTypeOf(m.name))}
        <span class="fname">${escapeHtml(m.name)}</span>
        <span class="fsize mono">${fmtSize(m.size)}</span>
        <button class="icon-btn artifact-download-btn" title="下载单文件" data-stage="${escapeAttr(stage.key)}" data-member-download="${i}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v12m0 0l-4-4m4 4l4-4M4 21h16"/></svg>
        </button>
      </div>`).join('')}
    </div>`;
}

function exportArtifactStageZip(caseName: string, stage: ArtifactStageView): void {
  if (stage.visibleMembers.length === 0) { toast('该阶段暂无可导出的产物文件'); return; }
  const files = stage.visibleMembers.map(m => ({ name: m.name, data: m.data }));
  downloadZip(files, `${sanitizeFolderName(caseName)}-${stage.key}-产物.zip`);
  toast(`已导出 ${stage.visibleMembers.length} 个文件`);
}

function triggerMemberDownload(member: TarMember): void {
  const download = downloadConfigForMember(member);
  const a = document.createElement('a');
  a.href = download.url;
  a.download = download.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (download.revoke) setTimeout(() => URL.revokeObjectURL(download.url), 1000);
}

function fileRowIcon(type: string): string {
  const paths: Record<string, string> = {
    jsonl: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
    json: '<path d="M4 4h16v16H4z"/><path d="M9 9h6M9 13h6M9 17h3"/>',
    md: '<path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/>',
    html: '<path d="M4 4h16v16H4z"/><path d="M9 8l-2 4 2 4M15 8l2 4-2 4"/>',
    pptx: '<rect x="3" y="4" width="18" height="14" rx="1"/><path d="M8 21h8"/>',
    image: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="10" r="1.5"/><path d="M21 16l-5-5L5 19"/>',
    docx: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
    xlsx: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 12l6 6M15 12l-6 6"/>',
    pdf: '<path d="M6 3h9l3 3v15H6z"/><path d="M14 3v4h4M9 16h6M9 12h2"/>',
    zip: '<path d="M7 3h10v18H7z"/><path d="M10 3v4h2v2h-2v2h2v2h-2"/>',
    text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${paths[type] || paths.json}</svg>`;
}

function previewTarMember(member: TarMember, tarFilename: string, onBack?: () => void): void {
  const iconType = iconTypeOf(member.name);
  const ext = member.name.split('.').pop()?.toLowerCase() || '';
  const historyOptions = { pushHistory: true, onRestoreCurrent: onBack };
  if (ext === 'jsonl' && /trace\.jsonl$/.test(member.name)) {
    renderTraceFromText(member.name, decodeText(member), historyOptions);
    return;
  }
  if (ext === 'md') {
    openDrawer(member.name, `Markdown · ${fmtSize(member.size)}`, `<div class="drawer-body pad"><div class="md-preview">${renderMarkdown(decodeText(member))}</div></div>`, iconType, downloadConfigForMember(member), historyOptions);
    return;
  }
  if (ext === 'json') {
    try {
      openDrawer(member.name, `JSON · ${fmtSize(member.size)}`, `<div class="json-viewer">${renderJSON(JSON.parse(decodeText(member)))}</div>`, iconType, downloadConfigForMember(member), historyOptions);
    } catch {
      openDrawer(member.name, `JSON（解析失败，原文展示） · ${fmtSize(member.size)}`, `<pre style="padding:18px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(decodeText(member))}</pre>`, iconType, downloadConfigForMember(member), historyOptions);
    }
    return;
  }
  if (ext === 'html' || ext === 'htm') {
    openDrawer(member.name, `HTML · 沙盒渲染预览`, `<iframe class="html-preview-frame" srcdoc="${escapeAttr(decodeText(member))}"></iframe>`, iconType, downloadConfigForMember(member), historyOptions);
    return;
  }
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'gif' || ext === 'webp') {
    const download = downloadConfigForMember(member);
    openDrawer(member.name, `图片 · ${fmtSize(member.size)}`, `<div style="padding:18px;"><img src="${download.url}" style="max-width:100%;border-radius:8px;border:1px solid var(--line);"></div>`, iconType, download, historyOptions);
    return;
  }
  if (ext === 'pdf') {
    const download = downloadConfigForMember(member);
    openDrawer(member.name, `PDF · ${fmtSize(member.size)}`, `<iframe class="html-preview-frame" src="${download.url}"></iframe>`, iconType, download, historyOptions);
    return;
  }
  if (['pptx', 'docx', 'xlsx'].includes(ext)) {
    const label = ext.toUpperCase();
    openDrawer(member.name, `${label} · ${fmtSize(member.size)}`, directDownloadHtml(`${label} 文件已解压`, '浏览器无法可靠内嵌预览 Office 文件，请下载后用本地应用查看。', `下载 ${label} 文件`), iconType, downloadConfigForMember(member), historyOptions);
    bindInlineDownloadButton();
    return;
  }
  if (ext === 'jsonl') {
    openDrawer(member.name, `JSONL · ${fmtSize(member.size)}（未识别为 trace，按纯文本展示）`, `<pre style="padding:18px;white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:12px;">${escapeHtml(decodeText(member))}</pre>`, 'jsonl', downloadConfigForMember(member), historyOptions);
    return;
  }
  // 其它文本类文件按纯文本尝试展示；含空字节或大量不可打印字符判定为二进制内容
  if (looksBinary(member.data)) {
    openDrawer(member.name, `二进制文件 · ${fmtSize(member.size)}`, directDownloadHtml('该文件为二进制内容', `来自 ${tarFilename}，可下载后使用本地应用查看。`, '下载文件'), 'json', downloadConfigForMember(member), historyOptions);
    bindInlineDownloadButton();
    return;
  }
  openDrawer(member.name, `文本 · ${fmtSize(member.size)}`, `<pre style="padding:18px;white-space:pre-wrap;word-break:break-word;">${escapeHtml(decodeText(member))}</pre>`, 'text', downloadConfigForMember(member), historyOptions);
}

// ---- Report drawer ----
export function canOpenCaseReport(ce: CaseExecution): boolean {
  return Boolean(ce.report || ce.status === 'ERROR' || ce.message);
}
export function openReportDrawer(run: EvalRun, ceId: string): void {
  const ce = (run.case_executions || []).find(c => c.id === ceId);
  if (!ce || !canOpenCaseReport(ce)) return;
  const content = ce.report || `# 用例执行失败\n\n- 用例：${ce.case_name}\n- 状态：${ce.status}\n${ce.exit_code != null ? `- Exit Code：${ce.exit_code}\n` : ''}${ce.message ? `\n## 失败信息\n\n${ce.message}` : '\n暂无更详细的失败信息，请查看产物或 trace。'}`;
  const title = ce.report ? 'report.md' : 'failure.md';
  const sub = ce.report ? `评测分析报告 · ${ce.case_name}` : `失败详情 · ${ce.case_name}`;
  openDrawer(title, sub, `<div class="drawer-body pad"><div class="md-preview">${renderMarkdown(content)}</div></div>`, 'md');
}

/* ---- Trace 可视化 ----
   trace.jsonl 是 executor 内 `claude -p ... --output-format stream-json --verbose`
   的直接产物（已用 2747 行真实样本核对格式）：事件 type 只有 system/assistant/user/result 四种。
   - system.thinking_tokens 是思考过程逐 token 心跳，真实样本中占比可达 98%，必须聚合为一条摘要；
   - assistant.message.content[] 混含 thinking / tool_use / text 三种块；
   - user.message.content[] 装 tool_result，按 tool_use_id 与对应 tool_use 配对；
   - system.task_started + task_notification 是后台任务生命周期，成对出现；
   - result 事件收尾给出 total_cost_usd / duration_ms / num_turns / usage 聚合。 */
function normalizeTrace(rawEvents: TraceEvent[]): TraceItem[] {
  const items: TraceItem[] = [];
  const toolUseIndex: Record<string, Extract<TraceItem, { kind: 'tool_use' }>> = {};
  let thinkingBurst: Extract<TraceItem, { kind: 'thinking_burst' }> | null = null;

  function flushBurst(): void {
    if (thinkingBurst) { items.push(thinkingBurst); thinkingBurst = null; }
  }

  rawEvents.forEach(ev => {
    if (ev.type === 'system' && ev.subtype === 'thinking_tokens') {
      if (!thinkingBurst) thinkingBurst = { kind: 'thinking_burst', count: 0, startTok: ev.estimated_tokens, endTok: ev.estimated_tokens };
      thinkingBurst.count++;
      thinkingBurst.endTok = ev.estimated_tokens;
      return;
    }
    flushBurst();

    if (ev.type === 'system' && ev.subtype === 'init') {
      items.push({ kind: 'init', model: ev.model, cwd: ev.cwd, tools: ev.tools || [] });
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'task_started') {
      items.push({ kind: 'bg_task', taskId: ev.task_id, description: ev.description, taskType: ev.task_type, status: 'running' });
      return;
    }
    if (ev.type === 'system' && ev.subtype === 'task_notification') {
      const existing = items.find(it => it.kind === 'bg_task' && it.taskId === ev.task_id) as Extract<TraceItem, { kind: 'bg_task' }> | undefined;
      if (existing) { existing.status = ev.status; existing.summary = ev.summary; }
      return;
    }
    if (ev.type === 'assistant') {
      const content = ev.message?.content || [];
      const usage: TraceUsage = ev.message?.usage || { input_tokens: 0, output_tokens: 0 };
      content.forEach(block => {
        if (block.type === 'thinking') {
          items.push({ kind: 'thinking_text', text: block.thinking, tokens: usage });
        } else if (block.type === 'tool_use') {
          const item: Extract<TraceItem, { kind: 'tool_use' }> = { kind: 'tool_use', id: block.id, name: block.name, input: block.input, tokens: usage, result: null };
          items.push(item);
          toolUseIndex[block.id] = item;
        } else if (block.type === 'text') {
          items.push({ kind: 'text', text: block.text, tokens: usage });
        }
      });
      return;
    }
    if (ev.type === 'user') {
      const content = ev.message?.content || [];
      content.forEach(block => {
        if (block.type === 'tool_result') {
          const target = toolUseIndex[block.tool_use_id];
          const resultPayload = { content: block.content, meta: ev.tool_use_result };
          if (target) target.result = resultPayload;
          else items.push({ kind: 'orphan_result', toolUseId: block.tool_use_id, ...resultPayload });
        }
      });
      return;
    }
    if (ev.type === 'result') {
      items.push({
        kind: 'result', text: ev.result, isError: ev.is_error, costUsd: ev.total_cost_usd,
        durationMs: ev.duration_ms, numTurns: ev.num_turns, usage: ev.usage || { input_tokens: 0, output_tokens: 0 },
      });
      return;
    }
  });
  flushBurst();
  return items;
}

const TRACE_FACETS: { key: TraceItemKind | 'all'; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'thinking_burst', label: '思考中' },
  { key: 'thinking_text', label: '思考内容' },
  { key: 'tool_use', label: '工具调用' },
  { key: 'bg_task', label: '后台任务' },
  { key: 'text', label: '模型输出' },
  { key: 'result', label: '结果摘要' },
];

/** trace 抽屉入口：拉取测试任务产物 tar.gz，解压找出 trace.jsonl，解析为事件流后可视化。 */
export async function openTraceDrawer(run: EvalRun, ceId: string): Promise<void> {
  const ce = (run.case_executions || []).find(c => c.id === ceId);
  if (!ce || !ce.test_task_id) return;
  openDrawer('trace.jsonl', `${ce.case_name} · 拉取中…`, loadingDrawerBody(), 'jsonl');
  try {
    const result = await fetchTaskMembers(ce.test_task_id);
    if (!result) {
      document.getElementById('drawer-body')!.innerHTML = emptyStateHtml('尚未产出产物', '测试任务可能仍在执行中。');
      return;
    }
    const traceMember = findMember(result.members, 'trace.jsonl');
    if (!traceMember) {
      document.getElementById('drawer-body')!.innerHTML = emptyStateHtml('未找到 trace.jsonl', '该测试任务产物包内没有 trace.jsonl 文件。');
      return;
    }
    renderTraceFromText('trace.jsonl', decodeText(traceMember));
  } catch (e) {
    document.getElementById('drawer-body')!.innerHTML = errorStateHtml(errMsg(e));
  }
}

export function renderTraceFromText(filename: string, text: string, drawerOptions?: { pushHistory?: boolean; onRestoreCurrent?: () => void; preserveHistory?: boolean }): void {
  const rawEvents: TraceEvent[] = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    try { return JSON.parse(l) as TraceEvent; } catch { return null; }
  }).filter((e): e is TraceEvent => e !== null);
  const items = normalizeTrace(rawEvents);

  const toolCalls = items.filter(it => it.kind === 'tool_use').length;
  const bgTasks = items.filter(it => it.kind === 'bg_task').length;
  const resultItem = items.find(it => it.kind === 'result') as Extract<TraceItem, { kind: 'result' }> | undefined;
  const totalThinkingTicks = items.filter((it): it is Extract<TraceItem, { kind: 'thinking_burst' }> => it.kind === 'thinking_burst').reduce((s, it) => s + it.count, 0);
  const durStr = resultItem ? (resultItem.durationMs / 1000).toFixed(1) + 's' : '进行中';
  const costStr = resultItem ? '$' + resultItem.costUsd.toFixed(3) : '--';
  const finalInTok = resultItem ? resultItem.usage.input_tokens : items.reduce((m, it) => 'tokens' in it ? Math.max(m, it.tokens.input_tokens || 0) : m, 0);
  const finalOutTok = resultItem ? resultItem.usage.output_tokens : items.reduce((s, it) => 'tokens' in it ? s + (it.tokens.output_tokens || 0) : s, 0);

  const counts: Record<string, number> = {};
  items.forEach(it => counts[it.kind] = (counts[it.kind] || 0) + 1);
  const facets = TRACE_FACETS.filter(f => f.key === 'all' || counts[f.key]);

  const html = `
    <div class="trace-toolbar">
      <div class="trace-filters" id="trace-filter-chips">
        ${facets.map(f => `<span class="chip ${f.key === 'all' ? 'active' : ''}" data-filter="${f.key}">${f.label}${f.key !== 'all' ? ` <span class="n">${counts[f.key]}</span>` : ''}</span>`).join('')}
      </div>
      <span class="muted mono" style="font-size:11.5px;">原始 ${rawEvents.length} 行 · 聚合 ${items.length} 项</span>
    </div>
    <div class="trace-stats">
      <div class="trace-stat"><span class="v">${durStr}</span><span class="l">执行耗时</span></div>
      <div class="trace-stat"><span class="v">${toolCalls}</span><span class="l">工具调用</span></div>
      <div class="trace-stat"><span class="v">${bgTasks}</span><span class="l">后台任务</span></div>
      <div class="trace-stat"><span class="v mono">${totalThinkingTicks}</span><span class="l">思考心跳</span></div>
      <div class="trace-stat"><span class="v mono">${finalInTok || 0} / ${finalOutTok || 0}</span><span class="l">输入/输出 tokens</span></div>
      <div class="trace-stat"><span class="v mono">${costStr}</span><span class="l">本次花费</span></div>
    </div>
    <div class="trace-list" id="trace-event-list"></div>
  `;
  const download: DrawerDownload = {
    url: URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' })),
    filename: filename.endsWith('.jsonl') ? filename : `${filename}.jsonl`,
    revoke: true,
  };
  openDrawer(filename, `Agent 执行轨迹 · 原始 ${rawEvents.length} 行`, html, 'jsonl', download, drawerOptions);
  renderTraceItems(items, 'all');
  document.querySelectorAll('#trace-filter-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#trace-filter-chips .chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderTraceItems(items, chip.getAttribute('data-filter')!);
    });
  });
}

function renderTraceItems(items: TraceItem[], filter: string): void {
  const wrap = document.getElementById('trace-event-list')!;
  const filtered = filter === 'all' ? items : items.filter(it => it.kind === filter);
  if (filtered.length === 0) { wrap.innerHTML = emptyStateHtml('没有匹配的事件', '试试切换其他筛选条件。'); return; }
  wrap.innerHTML = filtered.map((it, i) => traceItemHtml(it, i)).join('');
}

function traceItemHtml(it: TraceItem, i: number): string {
  const delay = Math.min(i * 20, 400);
  if (it.kind === 'thinking_burst') {
    return `<div class="trace-event type-assistant" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head">
          <span class="event-type-tag assistant">思考中</span>
          <span class="event-time muted">${it.count} 次心跳 · token 估算 ${it.startTok} → ${it.endTok}</span>
        </div>
        <div class="event-body muted" style="font-size:12px;">模型正在思考（未产出可见内容），已折叠 ${it.count} 条心跳事件以保持时间线可读。</div>
      </div>
    </div>`;
  }
  if (it.kind === 'init') {
    return `<div class="trace-event type-assistant" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head"><span class="event-type-tag assistant">会话初始化</span><span class="token-pill">${escapeHtml(it.model)}</span></div>
        <div class="event-body">工作目录：<span class="mono">${escapeHtml(it.cwd)}</span></div>
        <div class="event-body" style="margin-top:4px;">可用工具（${it.tools.length}）：<span class="mono muted">${it.tools.slice(0, 8).map(escapeHtml).join(', ')}${it.tools.length > 8 ? ' …' : ''}</span></div>
      </div>
    </div>`;
  }
  if (it.kind === 'thinking_text') {
    return `<div class="trace-event type-assistant" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head">
          <span class="event-type-tag assistant">思考内容</span>
          ${tokenPillOf(it.tokens)}
        </div>
        <div class="event-body">${escapeHtml(it.text)}</div>
      </div>
    </div>`;
  }
  if (it.kind === 'tool_use') {
    const resultHtml = it.result
      ? `<div class="event-body" style="margin-top:8px;"><span class="muted" style="font-size:11.5px;">返回结果${it.result.meta && it.result.meta.success === false ? '（失败）' : ''}：</span><pre>${escapeHtml(typeof it.result.content === 'string' ? it.result.content : JSON.stringify(it.result.content, null, 2))}</pre></div>`
      : `<div class="event-body muted" style="margin-top:8px;font-size:11.5px;">等待返回…</div>`;
    return `<div class="trace-event type-tool_use" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head">
          <span class="event-type-tag tool_use">工具调用</span>
          <span class="event-title mono" style="font-size:12.5px;margin:0;">${escapeHtml(it.name)}</span>
          ${tokenPillOf(it.tokens)}
        </div>
        <div class="event-body"><pre>${escapeHtml(JSON.stringify(it.input, null, 2))}</pre></div>
        ${resultHtml}
      </div>
    </div>`;
  }
  if (it.kind === 'orphan_result') {
    return `<div class="trace-event type-tool_result" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head"><span class="event-type-tag tool_result">工具结果</span></div>
        <div class="event-body"><pre>${escapeHtml(typeof it.content === 'string' ? it.content : JSON.stringify(it.content, null, 2))}</pre></div>
      </div>
    </div>`;
  }
  if (it.kind === 'text') {
    return `<div class="trace-event type-assistant" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head"><span class="event-type-tag assistant">模型输出</span>${tokenPillOf(it.tokens)}</div>
        <div class="event-body">${escapeHtml(it.text)}</div>
      </div>
    </div>`;
  }
  if (it.kind === 'bg_task') {
    const st = it.status === 'completed' ? 'ok' : it.status === 'failed' ? 'err' : 'run';
    const stLabel = it.status === 'completed' ? '已完成' : it.status === 'failed' ? '失败' : '执行中';
    return `<div class="trace-event type-tool_use" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head">
          <span class="event-type-tag tool_use">后台任务</span>
          <span class="badge ${st}" style="margin-left:0;"><span class="pulse"></span>${stLabel}</span>
        </div>
        <div class="event-body">${escapeHtml(it.description || it.summary || it.taskId)}</div>
      </div>
    </div>`;
  }
  if (it.kind === 'result') {
    return `<div class="trace-event type-${it.isError ? 'error' : 'tool_result'}" style="animation-delay:${delay}ms">
      <div class="event-card">
        <div class="event-head">
          <span class="event-type-tag ${it.isError ? 'error' : 'tool_result'}">${it.isError ? '执行异常' : '结果摘要'}</span>
          <span class="event-time">${(it.durationMs / 1000).toFixed(1)}s</span>
          <span class="event-time">${it.numTurns} 轮对话</span>
          <span class="event-dur mono">$${it.costUsd.toFixed(3)}</span>
        </div>
        <div class="event-body md-preview">${renderMarkdown(it.text || '')}</div>
        <div class="event-body muted" style="font-size:11.5px;margin-top:6px;">tokens：输入 ${it.usage.input_tokens || 0} / 输出 ${it.usage.output_tokens || 0}${it.usage.cache_read_input_tokens ? ` / 缓存命中 ${it.usage.cache_read_input_tokens}` : ''}</div>
      </div>
    </div>`;
  }
  return '';
}

function tokenPillOf(tokens?: TraceUsage): string {
  if (!tokens || (!tokens.input_tokens && !tokens.output_tokens)) return '';
  return `<span class="token-pill">in ${tokens.input_tokens || 0} / out ${tokens.output_tokens || 0}</span>`;
}

