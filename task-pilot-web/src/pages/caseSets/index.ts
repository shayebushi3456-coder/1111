import { caseSetsApi } from '@/api/caseSets';
import { filesApi } from '@/api/files';
import { downloadZip } from '@/lib/minizip';
import { decodeZipText, unzip, type UnzipEntry } from '@/lib/unzip';
import { escapeAttr, escapeHtml, emptyStateHtml, errorStateHtml, fmtTime, skeletonRows } from '@/lib/ui';
import { badgeHtml, RUN_STATUS_MAP } from '@/lib/status';
import { addCheckpointFromInput, renderCheckpointEditor, setupRichEditor, type CheckpointDraft } from '@/lib/richEditor';
import { blobToBytes, normalizeZipPath, safeExportFilename, sanitizeFolderName } from '@/lib/filePreview';
import { cache, loadCaseSets, loadEvalRuns, loadMCPConfigs, loadSkillConfigs } from '@/core/dataCache';
import { closeModal, confirmAction, errMsg, openModal, toast, toastError } from '@/core/feedback';
import type { AppView } from '@/core/router';
import type { CaseItem, CaseRequestInput, CaseSet, CheckpointRequestInput, EvalRun, MCPConfig, SkillConfig } from '@/types';

type RouteTo = (view: AppView, param?: string) => void;
type ShowView = (view: AppView, crumbHtml?: string) => void;
let routeTo: RouteTo = () => {};
let showView: ShowView = () => {};
let setCrumbs: (html: string) => void = () => {};
let openNewEvalRunModalFor: (caseSetId: string) => void = () => {};
let activeCaseSetId: string | null = null;

export function initCaseSetPages(deps: { routeTo: RouteTo; showView: ShowView; setCrumbs: (html: string) => void; openNewEvalRunModalFor: (caseSetId: string) => void }): void {
  routeTo = deps.routeTo;
  showView = deps.showView;
  setCrumbs = deps.setCrumbs;
  openNewEvalRunModalFor = deps.openNewEvalRunModalFor;
}

// ================= CASE SETS =================
function linkedRunsOf(caseSetId: string, runs: EvalRun[]): EvalRun[] {
  return runs.filter(r => r.case_set_id === caseSetId);
}

export async function renderCaseSetGrid(): Promise<void> {
  const wrap = document.getElementById('caseset-grid')!;
  wrap.innerHTML = skeletonRows(4, 130);
  let caseSets: CaseSet[];
  let runs: EvalRun[];
  try {
    [caseSets, runs] = await Promise.all([loadCaseSets(true), loadEvalRuns()]);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  document.getElementById('nav-count-casesets')!.textContent = String(caseSets.length);
  const selectAllBox = document.getElementById('cs-select-all') as HTMLInputElement;
  const batchDeleteBtn = document.getElementById('cs-batch-delete-btn') as HTMLButtonElement;
  const selCountEl = document.getElementById('cs-selected-count') as HTMLElement;
  selectAllBox.checked = false;
  batchDeleteBtn.disabled = true;
  selCountEl.style.display = 'none';
  if (caseSets.length === 0) { wrap.innerHTML = emptyStateHtml('还没有用例集', '点击右上角新建用例集开始配置评测用例。'); return; }
  wrap.innerHTML = caseSets.map((cs, i) => {
    const linked = linkedRunsOf(cs.id, runs).length;
    return `
    <div class="panel" style="animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 50}ms">
      <div class="panel-head" style="cursor:pointer;" data-open-cs="${cs.id}">
        <h3 style="display:flex;align-items:center;gap:10px;">
          <input type="checkbox" class="cs-row-check" data-cs-check="${cs.id}" onclick="event.stopPropagation()">
          ${escapeHtml(cs.name)}
        </h3>
        <span class="badge ash">v${cs.version}</span>
      </div>
      <div class="panel-body pad" style="cursor:pointer;" data-open-cs="${cs.id}">
        <p class="muted" style="font-size:13px;margin-bottom:14px;">${escapeHtml(cs.description)}</p>
        <div class="flex-between" style="font-size:12px;color:var(--quiet)">
          <span class="mono">${cs.cases?.length ?? 0} 条用例${linked ? ` · 关联 ${linked} 次执行` : ''}</span>
          <span>更新于 ${fmtTime(cs.updated_at).split(' ')[0]}</span>
        </div>
      </div>
      <div style="padding:10px 18px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" style="color:var(--err);border-color:var(--err-soft);" data-del-cs="${cs.id}">删除</button>
      </div>
    </div>
  `;
  }).join('');
  wrap.querySelectorAll('[data-open-cs]').forEach(el => el.addEventListener('click', () => routeTo('caseset-detail', el.getAttribute('data-open-cs')!)));
  wrap.querySelectorAll('[data-del-cs]').forEach(el => el.addEventListener('click', (e) => {
    e.stopPropagation();
    requestDeleteCaseSet(el.getAttribute('data-del-cs')!, runs, () => renderCaseSetGrid());
  }));
  function refreshCsSelection(): void {
    const checked = Array.from(wrap.querySelectorAll<HTMLInputElement>('.cs-row-check:checked'));
    batchDeleteBtn.disabled = checked.length === 0;
    selCountEl.style.display = checked.length > 0 ? 'inline' : 'none';
    selCountEl.textContent = `已选 ${checked.length} 项`;
  }
  selectAllBox.onclick = () => {
    wrap.querySelectorAll<HTMLInputElement>('.cs-row-check').forEach(cb => cb.checked = selectAllBox.checked);
    refreshCsSelection();
  };
  wrap.querySelectorAll('.cs-row-check').forEach(cb => cb.addEventListener('click', (e) => { e.stopPropagation(); refreshCsSelection(); }));
  batchDeleteBtn.onclick = () => {
    const ids = Array.from(wrap.querySelectorAll<HTMLInputElement>('.cs-row-check:checked')).map(cb => cb.getAttribute('data-cs-check')!);
    if (ids.length === 0) return;
    const linkedTotal = ids.reduce((s, id) => s + linkedRunsOf(id, runs).length, 0);
    const desc = linkedTotal > 0
      ? `将删除已选 ${ids.length} 个用例集。其中共有 ${linkedTotal} 次评测执行引用了这些用例集，由于执行创建时已快照用例集内容，历史执行记录不受影响，但删除后将无法再用它们发起新的执行。`
      : `将删除已选 ${ids.length} 个用例集，删除后不可恢复。`;
    confirmAction('批量删除用例集', desc, async () => {
      const results = await Promise.allSettled(ids.map(id => caseSetsApi.remove(id)));
      const failed = results.filter(r => r.status === 'rejected').length;
      cache.caseSets = null;
      if (failed > 0) toast(`已删除 ${ids.length - failed} 项，${failed} 项失败`);
      else toast(`已删除 ${ids.length} 项`);
      renderCaseSetGrid();
    });
  };
}

/* 删除用例集：后端为软删除，不检查引用（EvalRun 创建时已快照用例集内容到 SnapshotJSON），
   因此删除不影响历史执行记录，只是无法再用它发起新的执行——据此给出准确的二次确认文案。 */
function requestDeleteCaseSet(id: string, runs: EvalRun[], onDone?: () => void): void {
  const cs = (cache.caseSets || []).find(c => c.id === id);
  const name = cs ? cs.name : id;
  const linked = linkedRunsOf(id, runs);
  const desc = linked.length > 0
    ? `「${name}」已关联 ${linked.length} 次评测执行。由于执行创建时已快照用例集内容，这些历史执行记录不受影响，但删除后将无法再用它发起新的执行。`
    : `「${name}」尚未被任何评测执行引用，删除后不可恢复。`;
  confirmAction('删除用例集', desc, async () => {
    try {
      await caseSetsApi.remove(id);
      cache.caseSets = null;
      toast('用例集已删除');
      onDone && onDone();
    } catch (e) {
      toastError('删除失败', e);
    }
  });
}

document.getElementById('btn-new-caseset')!.addEventListener('click', () => openCaseSetModal(null));
document.getElementById('btn-import-caseset')!.addEventListener('click', importCaseSetFromZip);
document.getElementById('btn-download-caseset-template')!.addEventListener('click', downloadCaseSetImportTemplate);

interface CaseSetImportManifest {
  name?: unknown;
  description?: unknown;
  cases?: unknown;
}
interface CaseImportItem {
  name?: unknown;
  description?: unknown;
  checkpoints?: unknown;
  files?: unknown;
  file_paths?: unknown;
  enable_ppt_visual_score?: unknown;
  enable_html_visual_score?: unknown;
  skip_html_visual_score?: unknown;
}
// CheckpointImportItem 校验点条目：支持纯字符串（无参考文件，向后兼容旧模板）
// 或对象形式 {description, files}（files 是 ZIP 内相对路径数组，指向该校验点的参考文件）。
interface CheckpointImportItem {
  description: string;
  files: string[];
}

function findZipEntry(entries: UnzipEntry[], path: string): UnzipEntry | undefined {
  const normalized = normalizeZipPath(path);
  return entries.find(e => normalizeZipPath(e.name) === normalized);
}
function zipEntryFile(entry: UnzipEntry): File {
  const filename = entry.name.split('/').pop() || entry.name;
  return new File([entry.data as BlobPart], filename);
}
function asStringArray(value: unknown, fieldName: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} 必须是字符串数组`);
  return value.map(v => String(v).trim()).filter(Boolean);
}
function asCheckpointArray(value: unknown, fieldName: string): CheckpointImportItem[] {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.map((item, idx) => {
    if (typeof item === 'string') {
      const description = item.trim();
      if (!description) throw new Error(`${fieldName}[${idx}] 不能为空`);
      return { description, files: [] };
    }
    if (item && typeof item === 'object') {
      const obj = item as { description?: unknown; files?: unknown };
      const description = String(obj.description || '').trim();
      if (!description) throw new Error(`${fieldName}[${idx}].description 不能为空`);
      return { description, files: asStringArray(obj.files, `${fieldName}[${idx}].files`) };
    }
    throw new Error(`${fieldName}[${idx}] 必须是字符串或 {description, files} 对象`);
  });
}
function validateImportedManifest(raw: CaseSetImportManifest): { name: string; description: string; cases: (CaseImportItem & { name: string; description: string; checkpoints: CheckpointImportItem[]; files: string[]; enablePPTVisualScore: boolean; enableHTMLVisualScore: boolean; skipHTMLVisualScore: boolean })[] } {
  const name = String(raw.name || '').trim();
  const description = String(raw.description || '').trim();
  if (!name) throw new Error('manifest.json 缺少 name');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('manifest.json 至少需要一条 cases');
  const cases = raw.cases.map((item, idx) => {
    const c = item as CaseImportItem;
    const caseName = String(c.name || '').trim();
    const caseDesc = String(c.description || '').trim();
    const checkpoints = asCheckpointArray(c.checkpoints, `cases[${idx}].checkpoints`);
    const files = asStringArray(c.files ?? c.file_paths, `cases[${idx}].files`);
    if (!caseName || !caseDesc || checkpoints.length === 0) throw new Error(`第 ${idx + 1} 条用例缺少 name / description / checkpoints`);
    return { ...c, name: caseName, description: caseDesc, checkpoints, files, enablePPTVisualScore: c.enable_ppt_visual_score === true, enableHTMLVisualScore: c.enable_html_visual_score === true, skipHTMLVisualScore: c.skip_html_visual_score === true };
  });
  return { name, description, cases };
}
async function importCaseSetFromZip(): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    toast('正在解析用例集 ZIP…');
    try {
      const entries = await unzip(file);
      const manifestEntry = findZipEntry(entries, 'manifest.json') || findZipEntry(entries, 'caseset.json');
      if (!manifestEntry) throw new Error('ZIP 根目录缺少 manifest.json');
      const manifest = validateImportedManifest(JSON.parse(decodeZipText(manifestEntry)) as CaseSetImportManifest);
      const cases: CaseRequestInput[] = [];
      let uploadedCount = 0;
      for (const c of manifest.cases) {
        const fileIds: string[] = [];
        for (const path of c.files) {
          const entry = findZipEntry(entries, path);
          if (!entry) throw new Error(`未找到附件文件：${path}`);
          const uploaded = await filesApi.uploadInput(zipEntryFile(entry));
          fileIds.push(uploaded.file_id);
          uploadedCount++;
        }
        const checkpoints: CheckpointRequestInput[] = [];
        for (const cp of c.checkpoints) {
          const cpFileIds: string[] = [];
          for (const path of cp.files) {
            const entry = findZipEntry(entries, path);
            if (!entry) throw new Error(`未找到校验点参考文件：${path}`);
            const uploaded = await filesApi.uploadInput(zipEntryFile(entry));
            cpFileIds.push(uploaded.file_id);
            uploadedCount++;
          }
          checkpoints.push({ description: cp.description, file_ids: cpFileIds });
        }
        cases.push({ name: c.name, description: c.description, checkpoints, file_ids: fileIds, mcp_ids: [], skill_ids: [], enable_ppt_visual_score: c.enablePPTVisualScore, enable_html_visual_score: c.enableHTMLVisualScore, skip_html_visual_score: c.skipHTMLVisualScore });
      }
      const created = await caseSetsApi.create({ name: manifest.name, description: manifest.description, cases });
      cache.caseSets = null;
      toast(`已导入 ${cases.length} 条用例、${uploadedCount} 个附件`);
      routeTo('caseset-detail', created.id);
    } catch (e) {
      toastError('导入失败', e);
    }
  };
  input.click();
}
function downloadCaseSetImportTemplate(): void {
  const manifest = {
    name: '示例：电商运营报表生成',
    description: '演示用例集 ZIP 导入格式：manifest.json 描述用例，files/ 目录放本地附件。',
    cases: [
      {
        name: '生成华东区销售周报',
        description: '### 任务目标\n请读取 files/sales.csv，生成华东区本周销售周报。\n\n### 输出要求\n- 总结销售额、订单量、客单价\n- 列出 Top 3 商品\n- 给出不少于 2 条经营建议',
        checkpoints: [
          '报告中的销售额、订单量与 sales.csv 汇总结果一致',
          '包含 Top 3 商品且排序正确',
          { description: '与标准答案 files/gold_report.md 的结论一致', files: ['files/gold_report.md'] }
        ],
        files: ['files/sales.csv']
      },
      {
        name: '生成客服反馈摘要',
        description: '读取 files/feedback.txt，提炼主要问题、影响范围和优先级，并输出改进计划。',
        checkpoints: [
          '覆盖 feedback.txt 中出现频率最高的三个问题',
          '每个问题都包含影响范围和建议优先级'
        ],
        files: ['files/feedback.txt']
      }
    ]
  };
  downloadZip([
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'README.md', data: '# WorkEval 用例集导入格式\n\nZIP 根目录必须包含 `manifest.json`。\n\n`manifest.json` 字段：\n- `name`: 用例集名称\n- `description`: 用例集描述\n- `cases[]`: 用例数组\n  - `name`: 用例名称\n  - `description`: 下发给被测 agent 的任务描述，支持 Markdown 文本\n  - `checkpoints`: 数组，每项是一条评测校验点，两种写法都支持：\n    - 纯字符串：仅文本描述，无参考文件\n    - `{description, files}` 对象：`files` 为字符串数组，指向 ZIP 内该校验点的参考文件路径（如标准答案、评分参考图、规范文档），仅评测阶段可见，被测系统永远不会收到\n  - `files`: 字符串数组，指向 ZIP 内附件路径，例如 `files/sales.csv`（用例级输入文件，测试与评测阶段都可见）\n  - `skip_html_visual_score`: 布尔值，可选，默认 false。true 表示该用例测试产物中的 HTML 文件不转图片、不评测视觉美观度，仅按任务描述/校验点评估其它维度\n' },
    { name: 'files/sales.csv', data: 'region,product,orders,revenue\n华东,A商品,120,36000\n华东,B商品,86,25800\n华东,C商品,61,18300\n华东,D商品,33,9900\n' },
    { name: 'files/feedback.txt', data: '用户反馈：\n1. 导出报表速度较慢，集中在月末高峰。\n2. 部分图表字段解释不清晰。\n3. 移动端查看表格时横向滚动体验较差。\n' },
    { name: 'files/gold_report.md', data: '# 标准答案（评测参考）\n\n本周华东区销售额 90,000 元，订单量 300 单，客单价 300 元。\nTop 3 商品：A商品、B商品、C商品。\n' },
  ], 'workeval-caseset-import-template.zip');
}

async function exportCaseSetZip(cs: CaseSet): Promise<void> {
  const cases = cs.cases || [];
  if (cases.length === 0) { toast('用例集为空，暂无可导出内容'); return; }
  toast('正在打包用例集 ZIP…');
  const files: { name: string; data: Uint8Array | string }[] = [];
  const usedPaths = new Set<string>();
  const manifestCases: { name: string; description: string; checkpoints: CheckpointImportItem[]; files: string[]; enable_ppt_visual_score: boolean; enable_html_visual_score: boolean; skip_html_visual_score: boolean }[] = [];
  let attachmentCount = 0;

  for (const [caseIndex, c] of cases.entries()) {
    const exportedPaths: string[] = [];
    const caseFolder = `files/case-${String(caseIndex + 1).padStart(2, '0')}`;
    for (const [fileIndex, fid] of (c.file_ids || []).entries()) {
      try {
        const downloaded = await filesApi.downloadBlobWithName(fid);
        const filename = safeExportFilename(downloaded.filename, `${fid}.bin`);
        let exportPath = `${caseFolder}/${filename}`;
        if (usedPaths.has(exportPath)) exportPath = `${caseFolder}/${fileIndex + 1}-${filename}`;
        usedPaths.add(exportPath);
        files.push({ name: exportPath, data: await blobToBytes(downloaded.blob) });
        exportedPaths.push(exportPath);
        attachmentCount++;
      } catch (e) {
        toastError(`导出附件 ${fid} 失败`, e);
      }
    }
    const checkpointItems: CheckpointImportItem[] = [];
    for (const [cpIndex, cp] of (c.checkpoints || []).entries()) {
      const cpFolder = `${caseFolder}/checkpoint-${String(cpIndex + 1).padStart(2, '0')}`;
      const cpPaths: string[] = [];
      for (const [fileIndex, fid] of (cp.file_ids || []).entries()) {
        try {
          const downloaded = await filesApi.downloadBlobWithName(fid);
          const filename = safeExportFilename(downloaded.filename, `${fid}.bin`);
          let exportPath = `${cpFolder}/${filename}`;
          if (usedPaths.has(exportPath)) exportPath = `${cpFolder}/${fileIndex + 1}-${filename}`;
          usedPaths.add(exportPath);
          files.push({ name: exportPath, data: await blobToBytes(downloaded.blob) });
          cpPaths.push(exportPath);
          attachmentCount++;
        } catch (e) {
          toastError(`导出校验点参考文件 ${fid} 失败`, e);
        }
      }
      checkpointItems.push({ description: cp.description, files: cpPaths });
    }
    manifestCases.push({
      name: c.name,
      description: c.description,
      checkpoints: checkpointItems,
      files: exportedPaths,
      enable_ppt_visual_score: !!c.enable_ppt_visual_score,
      enable_html_visual_score: !!c.enable_html_visual_score,
      skip_html_visual_score: !!c.skip_html_visual_score,
    });
  }

  const manifest = {
    name: cs.name,
    description: cs.description,
    cases: manifestCases,
  };
  files.unshift(
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) },
    { name: 'README.md', data: '# WorkEval 用例集导出包\n\n该 ZIP 可通过 WorkEval「导入 ZIP」重新创建用例集。\n\n- `manifest.json`：用例集结构、用例描述、校验点（及其参考文件相对路径）和用例附件相对路径。\n- `files/`：导出的用例关联输入文件与校验点参考文件（标准答案/评分参考图/规范文档等，仅评测阶段可见）。\n\n导入时会重新上传附件并生成新的文件 ID，原用例集 ID 与版本不会被复用。\n' },
  );
  downloadZip(files, `${sanitizeFolderName(cs.name)}-用例集导出.zip`);
  toast(`已导出 ${cases.length} 条用例、${attachmentCount} 个附件`);
}

export async function openCaseSetDetail(id: string): Promise<void> {
  activeCaseSetId = id;
  showView('caseset-detail', `<a href="#" data-view-link="casesets" class="link-inline" style="color:var(--quiet)">用例集</a> / <b>加载中…</b>`);
  document.getElementById('csd-title')!.textContent = '加载中…';
  document.getElementById('csd-case-list')!.innerHTML = skeletonRows(3, 90);

  let cs: CaseSet;
  let runs: EvalRun[];
  try {
    [cs, runs] = await Promise.all([caseSetsApi.get(id), loadEvalRuns()]);
  } catch (e) {
    document.getElementById('csd-title')!.textContent = '加载失败';
    document.getElementById('csd-case-list')!.innerHTML = errorStateHtml(errMsg(e));
    return;
  }

  document.getElementById('csd-title')!.textContent = cs.name;
  document.getElementById('csd-version')!.textContent = 'v' + cs.version;
  document.getElementById('csd-desc')!.textContent = cs.description;
  setCrumbs(`<a href="#" data-view-link="casesets" class="link-inline" style="color:var(--quiet)">用例集</a> / <b>${escapeHtml(cs.name)}</b>`);
  document.querySelectorAll('#view-caseset-detail [data-view-link]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); routeTo('casesets'); }));

  const linked = linkedRunsOf(id, runs).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const recentLinked = linked.slice(0, 5);
  document.getElementById('csd-linked-runs-count')!.textContent = linked.length > 0 ? `最近 ${recentLinked.length} / 共 ${linked.length} 次` : '暂无执行';
  const linkedList = document.getElementById('csd-linked-runs-list')!;
  if (recentLinked.length > 0) {
    linkedList.innerHTML = recentLinked.map((r, i) => {
      const pct = r.total ? Math.round(((r.reported + r.errored) / r.total) * 100) : 0;
      return `
      <div class="caseset-run-item" style="animation-delay:${i * 30}ms" data-open-run="${r.id}">
        <div class="flex-between" style="gap:10px;margin-bottom:8px;">
          <div style="min-width:0;">
            <div class="row-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(r.name)}</div>
            <div class="row-sub mono">${fmtTime(r.created_at)}</div>
          </div>
          ${badgeHtml(RUN_STATUS_MAP, r.status)}
        </div>
        <div class="progress-bar" style="margin-bottom:6px;"><span style="width:${pct}%"></span></div>
        <div class="flex-between row-sub"><span>${r.reported} 报告 · ${r.errored} 异常</span><span>${pct}%</span></div>
      </div>`;
    }).join('');
    linkedList.querySelectorAll('[data-open-run]').forEach(el => el.addEventListener('click', () => routeTo('evalrun-detail', el.getAttribute('data-open-run')!)));
  } else {
    linkedList.innerHTML = emptyStateHtml('暂无评测执行', '点击右上角“发起评测执行”开始第一次评测。');
  }

  const cases = cs.cases || [];
  document.getElementById('csd-case-count')!.textContent = `${cases.length} 条用例`;
  const wrap = document.getElementById('csd-case-list')!;
  const [mcpConfigsForLabels, skillConfigsForLabels] = await Promise.all([loadMCPConfigs(), loadSkillConfigs()]).catch(() => [[], []] as [MCPConfig[], SkillConfig[]]);
  const mcpNameOf = (id: string) => mcpConfigsForLabels.find(m => m.id === id)?.name || id;
  const skillNameOf = (id: string) => skillConfigsForLabels.find(sk => sk.id === id)?.name || id;
  wrap.innerHTML = cases.length === 0 ? emptyStateHtml('用例集为空', '') : cases.map((c, i) => {
    const fileIds = Array.isArray(c.file_ids) ? c.file_ids : [];
    const checkpoints = Array.isArray(c.checkpoints) ? c.checkpoints : [];
    const mcpIds = Array.isArray(c.mcp_ids) ? c.mcp_ids : [];
    const skillIds = Array.isArray(c.skill_ids) ? c.skill_ids : [];
    return `
    <div style="padding:16px 18px;border-top:${i === 0 ? 'none' : '1px solid var(--line)'};animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 40}ms">
      <div class="flex-between" style="margin-bottom:8px;">
        <div class="flex gap-8" style="align-items:center;">
          <span class="case-idx mono">#${String(c.order_no).padStart(2, '0')}</span>
          <span class="case-name" style="font-size:14px;">${escapeHtml(c.name)}</span>
        </div>
        <span class="row-sub">${fileIds.length} 个关联文件</span>
      </div>
      <p style="font-size:13px;color:var(--steel);margin-bottom:10px;">${escapeHtml(c.description)}</p>
      <div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:10px;">
        ${fileIds.map(fid => `<a class="chip" href="${escapeAttr(filesApi.downloadUrl(fid))}" target="_blank" rel="noopener">
          <span class="mono">▢</span> ${escapeHtml(fid)}
        </a>`).join('')}
      </div>
      ${(mcpIds.length > 0 || skillIds.length > 0 || c.enable_ppt_visual_score || c.enable_html_visual_score) ? `<div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:10px;">
        ${mcpIds.map(id => `<span class="chip active" title="MCP 服务器">⚙ ${escapeHtml(mcpNameOf(id))}</span>`).join('')}
        ${skillIds.map(id => `<span class="chip active" title="Skill">✦ ${escapeHtml(skillNameOf(id))}</span>`).join('')}
        ${c.enable_ppt_visual_score ? `<span class="chip" title="该用例的 PPT/PPTX 产物会转图片进行视觉/排版/美观度评测">👁 PPT 视觉评测</span>` : ''}
        ${c.enable_html_visual_score ? `<span class="chip" title="该用例的 HTML 产物会转图片进行视觉/排版/美观度评测">👁 HTML 视觉评测</span>` : ''}
      </div>` : ''}
      <details>
        <summary style="cursor:pointer;font-size:12px;color:var(--quiet);font-family:var(--font-mono);">校验点（${checkpoints.length}，仅评测阶段可见）</summary>
        <ul style="margin:8px 0 0;padding-left:20px;font-size:12.5px;color:var(--steel);line-height:1.8;">
          ${checkpoints.map(cp => `<li>${escapeHtml(cp.description)}${(cp.file_ids && cp.file_ids.length > 0) ? ` <span class="muted" style="font-size:11px;">（${cp.file_ids.length} 个参考文件）</span>` : ''}</li>`).join('')}
        </ul>
      </details>
    </div>`;
  }).join('');

  (document.getElementById('csd-run-btn') as HTMLButtonElement).onclick = () => openNewEvalRunModalFor(id);
  (document.getElementById('csd-export-btn') as HTMLButtonElement).onclick = () => exportCaseSetZip(cs);
  (document.getElementById('csd-edit-btn') as HTMLButtonElement).onclick = () => openCaseSetModal(cs);
  (document.getElementById('csd-delete-btn') as HTMLButtonElement).onclick = () => requestDeleteCaseSet(id, runs, () => routeTo('casesets'));
}

/* ---- 用例集新建/编辑弹窗 ----
   file_ids 在编辑已有用例时仅有 ID（后端无 GET /files/:id 元信息接口，
   无法反查原始文件名），此处展示为文件 ID chip，允许移除或追加新文件。 */
interface CaseEditorRow {
  card: HTMLElement;
  existingFileIds: string[];
  newFiles: File[];
  checkpoints: CheckpointDraft[];
  mcpIds: string[];
  skillIds: string[];
  enablePPTVisualScore: boolean;
  enableHTMLVisualScore: boolean;
  skipHTMLVisualScore: boolean;
}
let csEditorRows: CaseEditorRow[] = [];
let csActiveIndex = 0;
let csEditingId: string | null = null;

function renderCaseCardFiles(row: CaseEditorRow): void {
  const wrap = row.card.querySelector('.cs-case-files') as HTMLElement;
  const chips: string[] = [];
  row.existingFileIds.forEach((fid, idx) => {
    chips.push(`<span class="chip" data-existing-idx="${idx}"><span class="mono">▢</span> ${escapeHtml(fid)} <span style="cursor:pointer;color:var(--err);margin-left:4px;" data-remove-existing="${idx}">✕</span></span>`);
  });
  row.newFiles.forEach((f, idx) => {
    chips.push(`<span class="chip" data-new-idx="${idx}"><span class="mono">▢</span> ${escapeHtml(f.name)} <span style="cursor:pointer;color:var(--err);margin-left:4px;" data-remove-new="${idx}">✕</span></span>`);
  });
  wrap.innerHTML = chips.join('') || '<span class="muted" style="font-size:12px;">未关联文件</span>';
  wrap.querySelectorAll('[data-remove-existing]').forEach(el => el.addEventListener('click', () => {
    row.existingFileIds.splice(Number(el.getAttribute('data-remove-existing')), 1);
    renderCaseCardFiles(row);
  }));
  wrap.querySelectorAll('[data-remove-new]').forEach(el => el.addEventListener('click', () => {
    row.newFiles.splice(Number(el.getAttribute('data-remove-new')), 1);
    renderCaseCardFiles(row);
  }));
}

// renderCaseCardBindings 渲染用例卡片里的 MCP/Skill 绑定选择器：
// 每个可选项渲染成可点击切换的 chip，选中态复用 .chip.active 样式，点击即增删 row 上的 ID 列表。
async function renderCaseCardBindings(row: CaseEditorRow): Promise<void> {
  const mcpWrap = row.card.querySelector('.cs-case-mcp-list') as HTMLElement;
  const skillWrap = row.card.querySelector('.cs-case-skill-list') as HTMLElement;
  try {
    const [mcps, skills] = await Promise.all([loadMCPConfigs(), loadSkillConfigs()]);
    mcpWrap.innerHTML = mcps.length === 0
      ? '<span class="muted" style="font-size:12px;">还没有配置 MCP 服务器</span>'
      : mcps.map(m => `<span class="chip${row.mcpIds.includes(m.id) ? ' active' : ''}" data-mcp-toggle="${m.id}" title="${escapeAttr(m.description || '')}">${escapeHtml(m.name)}</span>`).join('');
    skillWrap.innerHTML = skills.length === 0
      ? '<span class="muted" style="font-size:12px;">还没有配置 Skill</span>'
      : skills.map(sk => `<span class="chip${row.skillIds.includes(sk.id) ? ' active' : ''}" data-skill-toggle="${sk.id}" title="${escapeAttr(sk.description || '')}">${escapeHtml(sk.name)}</span>`).join('');
    mcpWrap.querySelectorAll('[data-mcp-toggle]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-mcp-toggle')!;
      const idx = row.mcpIds.indexOf(id);
      if (idx >= 0) row.mcpIds.splice(idx, 1); else row.mcpIds.push(id);
      el.classList.toggle('active');
    }));
    skillWrap.querySelectorAll('[data-skill-toggle]').forEach(el => el.addEventListener('click', () => {
      const id = el.getAttribute('data-skill-toggle')!;
      const idx = row.skillIds.indexOf(id);
      if (idx >= 0) row.skillIds.splice(idx, 1); else row.skillIds.push(id);
      el.classList.toggle('active');
    }));
  } catch (e) {
    mcpWrap.innerHTML = errorStateHtml(errMsg(e));
    skillWrap.innerHTML = errorStateHtml(errMsg(e));
  }
}

function addCaseCard(prefill?: CaseItem): void {
  const tpl = document.getElementById('cs-case-card-template') as HTMLTemplateElement;
  const frag = tpl.content.cloneNode(true) as DocumentFragment;
  const card = frag.querySelector('.cs-case-card') as HTMLElement;
  const list = document.getElementById('cs-case-editor-list')!;
  list.appendChild(card);

  const row: CaseEditorRow = {
    card,
    existingFileIds: prefill ? [...(prefill.file_ids || [])] : [],
    newFiles: [],
    checkpoints: prefill ? (prefill.checkpoints || []).map(c => ({ description: c.description, existingFileIds: [...(c.file_ids || [])], newFiles: [] })) : [],
    mcpIds: prefill ? [...(prefill.mcp_ids || [])] : [],
    skillIds: prefill ? [...(prefill.skill_ids || [])] : [],
    enablePPTVisualScore: prefill ? !!prefill.enable_ppt_visual_score : false,
    enableHTMLVisualScore: prefill ? !!prefill.enable_html_visual_score : false,
    skipHTMLVisualScore: prefill ? !!prefill.skip_html_visual_score : true,
  };
  csEditorRows.push(row);

  if (prefill) {
    (card.querySelector('.cs-case-name') as HTMLInputElement).value = prefill.name;
  }
  (card.querySelector('.cs-case-name') as HTMLInputElement).addEventListener('input', () => renderCaseOutline());
  setupRichEditor(card, prefill?.description || '');
  (card.querySelector('.cs-case-description') as HTMLTextAreaElement).addEventListener('input', () => renderCaseOutline());
  renderCheckpointEditor(row);
  renderCaseCardFiles(row);
  renderCaseCardBindings(row);

  const pptVisualSwitch = card.querySelector('.cs-case-ppt-visual-switch') as HTMLElement;
  const htmlVisualSwitch = card.querySelector('.cs-case-html-visual-switch') as HTMLElement;
  pptVisualSwitch.classList.toggle('on', row.enablePPTVisualScore);
  htmlVisualSwitch.classList.toggle('on', row.enableHTMLVisualScore);
  pptVisualSwitch.addEventListener('click', () => {
    row.enablePPTVisualScore = !row.enablePPTVisualScore;
    pptVisualSwitch.classList.toggle('on', row.enablePPTVisualScore);
  });
  htmlVisualSwitch.addEventListener('click', () => {
    row.enableHTMLVisualScore = !row.enableHTMLVisualScore;
    row.skipHTMLVisualScore = !row.enableHTMLVisualScore;
    htmlVisualSwitch.classList.toggle('on', row.enableHTMLVisualScore);
  });

  (card.querySelector('.cs-case-remove') as HTMLElement).addEventListener('click', () => {
    const removedIdx = csEditorRows.indexOf(row);
    csEditorRows = csEditorRows.filter(r => r !== row);
    card.remove();
    if (csEditorRows.length === 0) { addCaseCard(); return; }
    setActiveCase(Math.min(removedIdx, csEditorRows.length - 1));
  });
  (card.querySelector('.cs-case-file-input') as HTMLInputElement).addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.files) row.newFiles.push(...Array.from(input.files));
    input.value = '';
    renderCaseCardFiles(row);
  });
  (card.querySelector('.cs-add-checkpoint') as HTMLButtonElement).addEventListener('click', () => { addCheckpointFromInput(row); renderCaseOutline(); });
  (card.querySelector('.cs-checkpoint-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addCheckpointFromInput(row); renderCaseOutline(); }
  });

  setActiveCase(csEditorRows.length - 1);
}

// caseCompletion 用例卡片的编排完整度：用于用例大纲标签页上的三态圆点提示，
// 帮助用户在不逐条切换的情况下一眼看出哪些用例还没编排完。
function caseCompletion(row: CaseEditorRow): 'empty' | 'partial' | 'complete' {
  const name = (row.card.querySelector('.cs-case-name') as HTMLInputElement).value.trim();
  const desc = (row.card.querySelector('.cs-case-description') as HTMLTextAreaElement).value.trim();
  if (!name && !desc && row.checkpoints.length === 0) return 'empty';
  if (name && desc && row.checkpoints.length > 0) return 'complete';
  return 'partial';
}

// setActiveCase 切换当前聚焦编辑的用例卡片：解决"多用例纵向堆叠反复滚动"的核心手段——
// 任意时刻只有一张卡片可见，用横向标签页跳转取代纵向滚动查找。
function setActiveCase(idx: number): void {
  csActiveIndex = Math.max(0, Math.min(idx, csEditorRows.length - 1));
  csEditorRows.forEach((row, i) => row.card.classList.toggle('active', i === csActiveIndex));
  renumberCaseCards();
}

function renderCaseOutline(): void {
  const outline = document.getElementById('cs-case-outline')!;
  outline.innerHTML = csEditorRows.map((row, i) => {
    const name = (row.card.querySelector('.cs-case-name') as HTMLInputElement).value.trim();
    const completion = caseCompletion(row);
    const dotCls = completion === 'complete' ? 'filled-complete' : completion === 'partial' ? 'filled-partial' : '';
    return `<div class="case-outline-tab${i === csActiveIndex ? ' active' : ''}" data-outline-idx="${i}">
      <span class="case-outline-dot ${dotCls}"></span>
      <span class="outline-no mono">#${String(i + 1).padStart(2, '0')}</span>
      <span>${escapeHtml(name || '未命名用例')}</span>
    </div>`;
  }).join('');
  outline.querySelectorAll<HTMLElement>('[data-outline-idx]').forEach(el => el.addEventListener('click', () => {
    setActiveCase(Number(el.getAttribute('data-outline-idx')));
  }));
  const countEl = document.getElementById('cs-editor-case-count');
  if (countEl) countEl.textContent = String(csEditorRows.length);
}
function renumberCaseCards(): void {
  csEditorRows.forEach((row, i) => {
    (row.card.querySelector('.cs-case-no') as HTMLElement).textContent = '#' + String(i + 1).padStart(2, '0');
  });
  renderCaseOutline();
}


function openCaseSetModal(existing: CaseSet | null): void {
  csEditingId = existing ? existing.id : null;
  csEditorRows = [];
  csActiveIndex = 0;
  document.getElementById('cs-case-editor-list')!.innerHTML = '';
  document.getElementById('cs-modal-title')!.textContent = existing ? '编辑用例集' : '新建用例集';
  (document.getElementById('cs-name') as HTMLInputElement).value = existing ? existing.name : '';
  (document.getElementById('cs-desc') as HTMLTextAreaElement).value = existing ? existing.description : '';
  if (existing && existing.cases && existing.cases.length > 0) {
    existing.cases.forEach(c => addCaseCard(c));
  } else {
    addCaseCard();
  }
  setActiveCase(0);
  openModal('modal-caseset');
}
document.getElementById('cs-add-case-btn')!.addEventListener('click', () => addCaseCard());

document.getElementById('cs-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('cs-submit') as HTMLButtonElement;
  const name = (document.getElementById('cs-name') as HTMLInputElement).value.trim();
  const description = (document.getElementById('cs-desc') as HTMLTextAreaElement).value.trim();
  if (!name) { toast('请填写用例集名称'); return; }
  if (csEditorRows.length === 0) { toast('请至少添加一条用例'); return; }

  btn.disabled = true;
  try {
    const cases: CaseRequestInput[] = [];
    for (const row of csEditorRows) {
      const caseName = (row.card.querySelector('.cs-case-name') as HTMLInputElement).value.trim();
      const caseDesc = (row.card.querySelector('.cs-case-description') as HTMLTextAreaElement).value.trim();
      if (!caseName || !caseDesc || row.checkpoints.length === 0) {
        throw new Error(`用例「${caseName || '(未命名)'}」缺少名称/描述/校验点`);
      }
      const uploadedIds: string[] = [];
      for (const file of row.newFiles) {
        const uploaded = await filesApi.uploadInput(file);
        uploadedIds.push(uploaded.file_id);
      }
      const checkpoints: CheckpointRequestInput[] = [];
      for (const cp of row.checkpoints) {
        const uploadedCkptIds: string[] = [];
        for (const file of cp.newFiles) {
          const uploaded = await filesApi.uploadInput(file);
          uploadedCkptIds.push(uploaded.file_id);
        }
        checkpoints.push({
          description: cp.description,
          file_ids: [...cp.existingFileIds, ...uploadedCkptIds],
        });
      }
      cases.push({
        name: caseName,
        description: caseDesc,
        file_ids: [...row.existingFileIds, ...uploadedIds],
        checkpoints,
        mcp_ids: [...row.mcpIds],
        skill_ids: [...row.skillIds],
        enable_ppt_visual_score: row.enablePPTVisualScore,
        enable_html_visual_score: row.enableHTMLVisualScore,
        skip_html_visual_score: !row.enableHTMLVisualScore,
      });
    }
    if (csEditingId) {
      await caseSetsApi.update(csEditingId, { name, description, cases });
      toast('用例集已更新');
    } else {
      await caseSetsApi.create({ name, description, cases });
      toast('用例集已创建');
    }
    cache.caseSets = null;
    closeModal('modal-caseset');
    if (csEditingId) openCaseSetDetail(csEditingId); else renderCaseSetGrid();
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

