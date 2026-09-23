import { evalRunsApi, leaderboardApi } from '@/api/evalRuns';
import { filesApi } from '@/api/files';
import { downloadZip } from '@/lib/minizip';
import { escapeHtml, emptyStateHtml, errorStateHtml, fmtTime, skeletonRows } from '@/lib/ui';
import { badgeHtml, caseMessageTagHtml, CASE_STATUS_MAP, RUN_STATUS_MAP } from '@/lib/status';
import { issueTagsHtml, issueTagLabel, scorePillHtml } from '@/lib/issueTags';
import { sanitizeFolderName } from '@/lib/filePreview';
import { delegate, renderListInChunks } from '@/core/rendering';
import { pageInfoText, renderPagination } from '@/core/pagination';
import { cache, loadCaseSets, loadEvalEndpoints, loadPrompts, loadTargetEndpoints } from '@/core/dataCache';
import { confirmAction, closeModal, errMsg, openModal, toast, toastError } from '@/core/feedback';
import { canOpenCaseReport, fetchTaskMembers, openArtifactsDrawer, openReportDrawer, openTraceDrawer, renderTraceFromText } from '@/features/preview/previewRuntime';
import { requirePermission, handleAuthError, hasPermission } from '@/core/auth';
import { canWrite as canWriteProject, canDownload as canDownloadProject, requireWrite as requireWriteProject } from '@/core/project';
import type { CaseExecution, CaseSet, EvalRun, LeaderboardItem, ScoreSummary } from '@/types';
import type { AppView } from '@/core/router';

type RouteTo = (view: AppView, param?: string) => void;
type ShowView = (view: AppView, crumbHtml?: string) => void;
let routeTo: RouteTo = () => {};
let showView: ShowView = () => {};
let setCrumbs: (html: string) => void = () => {};
let activeEvalRunId: string | null = null;
let evalRunTableRenderCancel: (() => void) | null = null;
let evalRunTableDisposeEvents: (() => void) | null = null;
let evalRunTableRenderSeq = 0;
let evalRunListState = { page: 1, pageSize: 20, q: '' };

export function initEvalRunPages(deps: { routeTo: RouteTo; showView: ShowView; setCrumbs: (html: string) => void }): void {
  routeTo = deps.routeTo;
  showView = deps.showView;
  setCrumbs = deps.setCrumbs;
}

// ================= EVAL RUN LIST =================
export async function renderEvalRunList(): Promise<void> {
  const wrap = document.getElementById('evalrun-list')!;
  wrap.innerHTML = skeletonRows(5);
  let runs: EvalRun[];
  let total = 0;
  let page = evalRunListState.page;
  let pageSize = evalRunListState.pageSize;
  let caseSets: CaseSet[];
  try {
    const [res, cs] = await Promise.all([
      evalRunsApi.listPaged({ page: evalRunListState.page, page_size: evalRunListState.pageSize, q: evalRunListState.q || undefined }),
      loadCaseSets(),
    ]);
    runs = res.eval_runs || [];
    total = res.total ?? runs.length;
    page = res.page || evalRunListState.page;
    pageSize = res.page_size || evalRunListState.pageSize;
    caseSets = cs;
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  const search = document.getElementById('er-search') as HTMLInputElement;
  if (search && search.value !== evalRunListState.q) search.value = evalRunListState.q;
  const newRunBtn = document.getElementById('btn-new-evalrun') as HTMLButtonElement | null;
  if (newRunBtn) newRunBtn.style.display = canWriteProject() ? '' : 'none';
  document.getElementById('er-page-info')!.textContent = pageInfoText(total, page, pageSize);
  renderPagination(document.getElementById('er-pagination')!, { page, pageSize, total }, next => {
    evalRunListState.page = next;
    renderEvalRunList();
  });
  const selectAllBox = document.getElementById('er-select-all') as HTMLInputElement;
  const batchDeleteBtn = document.getElementById('er-batch-delete-btn') as HTMLButtonElement;
  const selCountEl = document.getElementById('er-selected-count') as HTMLElement;
  const canWriteRuns = canWriteProject();
  selectAllBox.checked = false;
  batchDeleteBtn.disabled = true;
  batchDeleteBtn.style.display = canWriteRuns ? '' : 'none';
  selCountEl.style.display = 'none';
  if (runs.length === 0) { wrap.innerHTML = emptyStateHtml(evalRunListState.q ? '没有匹配的评测执行' : '还没有评测执行', evalRunListState.q ? '换个关键词试试。' : '从用例集详情页发起第一次评测执行。'); return; }
  wrap.innerHTML = runs.map((r, i) => {
    const cs = caseSets.find(c => c.id === r.case_set_id);
    const pct = r.total ? Math.round(((r.reported + r.errored) / r.total) * 100) : 0;
    return `<div class="row-item" style="animation-delay:${i * 30}ms" data-open-run="${r.id}">
      <div><input type="checkbox" class="er-row-check" data-er-check="${r.id}"></div>
      <div>
        <div class="row-title">${escapeHtml(r.name)}</div>
        <div class="row-sub">${cs ? escapeHtml(cs.name) : '--'} · <span class="mono">${r.id}</span></div>
      </div>
      <div>${badgeHtml(RUN_STATUS_MAP, r.status)}</div>
      <div>
        <div class="progress-bar ${r.status === 'RUNNING' && pct === 0 ? 'progress-indeterminate' : ''}" style="margin-bottom:4px;"><span style="width:${pct}%"></span></div>
        <div class="row-sub">${r.reported} 通过 · ${r.errored} 异常 · ${r.total} 共计</div>
      </div>
      <div class="row-sub">${fmtTime(r.updated_at)}</div>
      <div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="color:var(--quiet)"><path d="M9 6l6 6-6 6"/></svg></div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('[data-open-run]').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('input[type=checkbox]')) return;
      routeTo('evalrun-detail', el.getAttribute('data-open-run')!);
    });
  });
  function refreshErSelection(): void {
    const checked = Array.from(wrap.querySelectorAll<HTMLInputElement>('.er-row-check:checked'));
    batchDeleteBtn.disabled = checked.length === 0;
    selCountEl.style.display = checked.length > 0 ? 'inline' : 'none';
    selCountEl.textContent = `已选 ${checked.length} 项`;
  }
  selectAllBox.onclick = () => {
    wrap.querySelectorAll<HTMLInputElement>('.er-row-check').forEach(cb => cb.checked = selectAllBox.checked);
    refreshErSelection();
  };
  wrap.querySelectorAll('.er-row-check').forEach(cb => cb.addEventListener('click', (e) => { e.stopPropagation(); refreshErSelection(); }));
  batchDeleteBtn.onclick = () => {
    if (!requireWriteProject('删除评测执行')) return;
    const ids = Array.from(wrap.querySelectorAll<HTMLInputElement>('.er-row-check:checked')).map(cb => cb.getAttribute('data-er-check')!);
    if (ids.length === 0) return;
    confirmAction('批量删除评测执行', `将永久删除已选 ${ids.length} 个评测执行及其所有用例执行记录，此操作不可撤销。`, async () => {
      const results = await Promise.allSettled(ids.map(id => evalRunsApi.remove(id)));
      const failed = results.filter(r => r.status === 'rejected').length;
      cache.evalRuns = null;
      if (failed > 0) toast(`已删除 ${ids.length - failed} 项，${failed} 项失败`);
      else toast(`已删除 ${ids.length} 项`);
      renderEvalRunList();
    });
  };
}

document.getElementById('btn-new-evalrun')!.addEventListener('click', openNewEvalRunModal);
document.getElementById('btn-preview-local-trace')!.addEventListener('click', previewLocalTraceFile);
document.getElementById('er-search')?.addEventListener('input', (e) => {
  evalRunListState.q = (e.target as HTMLInputElement).value.trim();
  evalRunListState.page = 1;
  window.setTimeout(() => renderEvalRunList(), 150);
});
export async function previewLocalTraceFile(): Promise<void> {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.jsonl,.txt,application/json,text/plain';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      renderTraceFromText(file.name || 'trace.jsonl', text);
    } catch (e) {
      toastError('读取 trace 文件失败', e);
    }
  };
  input.click();
}
export async function openNewEvalRunModal(): Promise<void> {
  if (!requirePermission('eval_run:create', '新建评测执行')) return;
  if (!requireWriteProject('新建评测执行')) return;
  const submitBtn = document.getElementById('nr-submit') as HTMLButtonElement;
  submitBtn.disabled = true;
  openModal('modal-new-evalrun');
  try {
    const [caseSets, targetEps, evalEps, prompts, prestartScripts] = await Promise.all([
      loadCaseSets(), loadTargetEndpoints(), loadEvalEndpoints(), loadPrompts(),
      filesApi.listPrestart().catch(() => []),
    ]);
    if (caseSets.length === 0) {
      closeModal('modal-new-evalrun');
      toast('请先创建至少一个用例集');
      return;
    }
    const caseSetSelect = document.getElementById('nr-caseset') as HTMLSelectElement;
    caseSetSelect.innerHTML = caseSets.map(c => `<option value="${c.id}">${escapeHtml(c.name)}（${c.cases?.length || 0} 条用例）</option>`).join('');
    const nameInput = document.getElementById('nr-name') as HTMLInputElement;
    const fillDefaultRunName = () => {
      const selected = caseSets.find(c => c.id === caseSetSelect.value);
      const stamp = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/[/:\s]/g, '');
      nameInput.placeholder = selected ? `${selected.name}-${stamp}` : '例如：模型A-日报用例回归';
    };
    nameInput.value = '';
    caseSetSelect.onchange = fillDefaultRunName;
    fillDefaultRunName();
    (document.getElementById('nr-endpoint') as HTMLSelectElement).innerHTML = targetEps.map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.is_default ? ' · 默认' : ''}</option>`).join('');
    (document.getElementById('nr-eval-endpoint') as HTMLSelectElement).innerHTML = evalEps.map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.is_default ? ' · 默认' : ''}</option>`).join('');
    (document.getElementById('nr-prompt') as HTMLSelectElement).innerHTML = prompts.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.is_default ? ' · 默认' : ''}</option>`).join('');
    (document.getElementById('nr-prestart') as HTMLSelectElement).innerHTML =
      `<option value="">不使用</option>` +
      prestartScripts.map(f => `<option value="${escapeHtml(f.file_id)}">${escapeHtml(f.filename)}</option>`).join('');
    (document.getElementById('nr-test-image') as HTMLInputElement).value = '';
    (document.getElementById('nr-eval-image') as HTMLInputElement).value = '';
    (document.getElementById('nr-test-timeout') as HTMLInputElement).value = '';
    (document.getElementById('nr-eval-timeout') as HTMLInputElement).value = '';
    (document.getElementById('nr-max-eval-attempts') as HTMLInputElement).value = '3';
    (document.getElementById('nr-max-concurrent') as HTMLInputElement).value = '';
    submitBtn.disabled = false;
  } catch (e) {
    closeModal('modal-new-evalrun');
    toastError('加载配置项失败', e);
  }
}
export function openNewEvalRunModalFor(caseSetId: string): void {
  openNewEvalRunModal().then(() => {
    const sel = document.getElementById('nr-caseset') as HTMLSelectElement;
    if (sel) sel.value = caseSetId;
  });
}
document.getElementById('nr-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('nr-submit') as HTMLButtonElement;
  const csId = (document.getElementById('nr-caseset') as HTMLSelectElement).value;
  if (!csId) { toast('请选择用例集'); return; }
  btn.disabled = true;
  try {
    const maxConcurrentRaw = (document.getElementById('nr-max-concurrent') as HTMLInputElement).value.trim();
    const maxConcurrent = maxConcurrentRaw ? parseInt(maxConcurrentRaw, 10) : undefined;
    const explicitName = (document.getElementById('nr-name') as HTMLInputElement).value.trim();
    const testImage = (document.getElementById('nr-test-image') as HTMLInputElement).value.trim();
    const evalImage = (document.getElementById('nr-eval-image') as HTMLInputElement).value.trim();
    const testTimeoutRaw = (document.getElementById('nr-test-timeout') as HTMLInputElement).value.trim();
    const evalTimeoutRaw = (document.getElementById('nr-eval-timeout') as HTMLInputElement).value.trim();
    const testTimeout = testTimeoutRaw ? parseInt(testTimeoutRaw, 10) : undefined;
    const evalTimeout = evalTimeoutRaw ? parseInt(evalTimeoutRaw, 10) : undefined;
    const maxEvalAttemptsRaw = (document.getElementById('nr-max-eval-attempts') as HTMLInputElement).value.trim();
    const maxEvalAttempts = maxEvalAttemptsRaw ? parseInt(maxEvalAttemptsRaw, 10) : undefined;
    const prestartScriptFileId = (document.getElementById('nr-prestart') as HTMLSelectElement).value;
    const selectedCaseSetName = (document.getElementById('nr-caseset') as HTMLSelectElement).selectedOptions[0]?.textContent?.replace(/（\d+ 条用例）$/, '').trim() || '评测执行';
    const defaultName = `${selectedCaseSetName}-${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/[/:\s]/g, '')}`;
    const run = await evalRunsApi.create({
      case_set_id: csId,
      name: explicitName || defaultName,
      endpoint_id: (document.getElementById('nr-endpoint') as HTMLSelectElement).value || undefined,
      eval_endpoint_id: (document.getElementById('nr-eval-endpoint') as HTMLSelectElement).value || undefined,
      prompt_id: (document.getElementById('nr-prompt') as HTMLSelectElement).value || undefined,
      test_image: testImage || undefined,
      eval_image: evalImage || undefined,
      test_timeout_seconds: testTimeout !== undefined && !isNaN(testTimeout) && testTimeout > 0 ? testTimeout : undefined,
      eval_timeout_seconds: evalTimeout !== undefined && !isNaN(evalTimeout) && evalTimeout > 0 ? evalTimeout : undefined,
      max_eval_attempts: maxEvalAttempts !== undefined && !isNaN(maxEvalAttempts) && maxEvalAttempts > 0 ? Math.min(maxEvalAttempts, 10) : undefined,
      max_concurrent: maxConcurrent !== undefined && !isNaN(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : undefined,
      prestart_script_file_id: prestartScriptFileId || undefined,
    });
    cache.evalRuns = null;
    closeModal('modal-new-evalrun');
    toast('评测执行已创建，用例已排入队列');
    routeTo('evalrun-detail', run.id);
  } catch (e) {
    if (!(await handleAuthError(e))) toastError('创建失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= LEADERBOARD =================
document.querySelectorAll('#lb-period-switch button').forEach(btn => btn.addEventListener('click', () => {
  const period = btn.getAttribute('data-period') as '30d' | '90d' | 'all';
  document.querySelectorAll('#lb-period-switch button').forEach(b => b.classList.toggle('active', b === btn));
  renderLeaderboard(period);
}));

export async function renderLeaderboard(period: '30d' | '90d' | 'all'): Promise<void> {
  const tbody = document.getElementById('lb-table-body')!;
  tbody.innerHTML = `<tr><td colspan="7">${skeletonRows(5)}</td></tr>`;
  let items: LeaderboardItem[];
  try {
    const resp = await leaderboardApi.get(period);
    items = resp.items || [];
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7">${errorStateHtml(errMsg(e))}</td></tr>`;
    return;
  }
  document.getElementById('lb-summary')!.textContent = `${items.length} 个模型参与排名`;
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7">${emptyStateHtml('暂无排名数据', '该统计周期内没有任何模型产出合法机评分数。')}</td></tr>`;
    return;
  }
  tbody.innerHTML = items.map((it, i) => {
    const rankCls = i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : '';
    const maxTrend = 4;
    const spark = it.score_trend.map((v, j) => `<i style="height:${Math.max(6, Math.round(v / maxTrend * 100))}%;${j === it.score_trend.length - 1 ? 'opacity:1;' : ''}"></i>`).join('');
    return `<tr>
      <td class="lb-rank ${rankCls}">${i + 1}</td>
      <td><div class="lb-model">
        <div class="lb-model-icon" style="background:var(--accent);">${escapeHtml(it.endpoint_name.slice(0, 2).toUpperCase())}</div>
        <div><div class="lb-model-name">${escapeHtml(it.endpoint_name)}</div><div class="lb-model-sub">${it.scored_case_count}/${it.case_count} 用例参与计分</div></div>
      </div></td>
      <td><span class="lb-score-num" style="color:${it.avg_score >= 3 ? 'var(--ok)' : it.avg_score >= 2 ? 'var(--accent)' : 'var(--err)'};">${Math.round(it.avg_score * 10) / 10}/4</span></td>
      <td class="mono">${it.run_count}</td>
      <td class="mono">${it.case_count}</td>
      <td><div class="lb-tags">${it.top_issues.slice(0, 2).map(t => `<span class="case-message-tag ${t.kind === 'good' ? 'violet' : (t.level === 'P0' || t.level === 'P1' ? 'err' : 'warn')}"><span class="tag-icon">${t.kind === 'good' ? '★' : '•'}</span>${escapeHtml((t.label || issueTagLabel(t.code)) + (t.level ? ' · ' + t.level : ''))}</span>`).join('') || '<span class="muted" style="font-size:12px;">--</span>'}</div></td>
      <td><div class="lb-sparkline">${spark || '<span class="muted" style="font-size:11px;">暂无趋势</span>'}</div></td>
    </tr>`;
  }).join('');
}

// ================= EVAL RUN DETAIL =================
export async function openEvalRunDetail(id: string): Promise<void> {
  activeEvalRunId = id;
  showView('evalrun-detail', `<a href="#" data-view-link="evalruns" class="link-inline" style="color:var(--quiet)">评测执行</a> / <b>加载中…</b>`);
  document.querySelectorAll('#view-evalrun-detail [data-view-link]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); routeTo('evalruns'); }));

  document.getElementById('erd-title')!.textContent = '加载中…';
  document.getElementById('erd-case-table-body')!.innerHTML = `<tr><td colspan="10">${skeletonRows(3)}</td></tr>`;

  let run: EvalRun;
  let scoreSummary: ScoreSummary | undefined;
  try {
    const resp = await evalRunsApi.getWithSummary(id);
    run = resp.eval_run;
    scoreSummary = resp.score_summary;
  } catch (e) {
    document.getElementById('erd-title')!.textContent = '加载失败';
    document.getElementById('erd-case-table-body')!.innerHTML = `<tr><td colspan="10">${errorStateHtml(errMsg(e))}</td></tr>`;
    return;
  }

  const [csRes, teRes, eeRes] = await Promise.allSettled([loadCaseSets(), loadTargetEndpoints(), loadEvalEndpoints()]);
  const caseSets = csRes.status === 'fulfilled' ? csRes.value : [];
  const targetEps = teRes.status === 'fulfilled' ? teRes.value : [];
  const evalEps = eeRes.status === 'fulfilled' ? eeRes.value : [];
  const cs = caseSets.find(c => c.id === run.case_set_id);
  const te = targetEps.find(e => e.id === run.endpoint_id);
  const ee = evalEps.find(e => e.id === run.eval_endpoint_id);

  document.getElementById('erd-title')!.textContent = run.name;
  document.getElementById('erd-status-badge')!.outerHTML = badgeHtml(RUN_STATUS_MAP, run.status).replace('<span class="badge', '<span class="badge" id="erd-status-badge"');
  document.getElementById('erd-meta')!.textContent = `${run.id}  ·  创建于 ${fmtTime(run.created_at)}  ·  用例集「${cs ? cs.name : '--'}」`;
  setCrumbs(`<a href="#" data-view-link="evalruns" class="link-inline" style="color:var(--quiet)">评测执行</a> / <b>${escapeHtml(run.name)}</b>`);
  document.querySelectorAll('#view-evalrun-detail [data-view-link]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); routeTo('evalruns'); }));

  const pct = run.total ? Math.round(((run.reported + run.errored) / run.total) * 100) : 0;
  document.getElementById('erd-progress-text')!.textContent = `${run.reported + run.errored} / ${run.total}`;
  document.getElementById('erd-progress-pct')!.textContent = pct + '%';
  (document.getElementById('erd-progress-bar') as HTMLElement).style.width = pct + '%';

  document.getElementById('erd-config-lines')!.innerHTML = `
    <div class="flex-between"><span class="muted">被测端点</span><span class="mono">${te ? escapeHtml(te.name) : '--'}</span></div>
    <div class="flex-between"><span class="muted">评测端点</span><span class="mono">${ee ? escapeHtml(ee.name) : '--'}</span></div>
    <div class="flex-between"><span class="muted">测试任务镜像</span><span class="mono" title="${escapeHtml(run.test_image || '服务端默认')}">${escapeHtml(run.test_image || '服务端默认')}</span></div>
    <div class="flex-between"><span class="muted">评测任务镜像</span><span class="mono" title="${escapeHtml(run.eval_image || '服务端默认')}">${escapeHtml(run.eval_image || '服务端默认')}</span></div>
    <div class="flex-between"><span class="muted">测试任务超时</span><span class="mono">${run.test_timeout_seconds ? run.test_timeout_seconds + 's' : '服务端默认'}</span></div>
    <div class="flex-between"><span class="muted">评测任务超时</span><span class="mono">${run.eval_timeout_seconds ? run.eval_timeout_seconds + 's' : '服务端默认'}</span></div>
    <div class="flex-between"><span class="muted">评测最大尝试次数</span><span class="mono">${run.max_eval_attempts || 3}</span></div>
    <div class="flex-between"><span class="muted">单请求并发上限</span><span class="mono">${run.max_concurrent || '不限'}</span></div>
  `;

  const stopBtn = document.getElementById('erd-stop-btn') as HTMLButtonElement;
  const canWriteRun = canWriteProject();
  stopBtn.style.display = (canWriteRun && (run.status === 'RUNNING' || run.status === 'PENDING')) ? 'inline-flex' : 'none';
  stopBtn.onclick = () => {
    if (!requireWriteProject('停止评测执行')) return;
    confirmAction('停止评测执行', `将取消所有未完成用例的任务，「${run.name}」将被置为 STOPPED，此操作不可撤销。`, async () => {
    try {
      await evalRunsApi.stop(id);
      cache.evalRuns = null;
      toast('执行已停止');
      openEvalRunDetail(id);
    } catch (e) {
      toastError('停止失败', e);
    }
    });
  };
  const deleteBtn = document.getElementById('erd-delete-btn') as HTMLButtonElement;
  deleteBtn.style.display = canWriteRun ? '' : 'none';
  deleteBtn.onclick = () => {
    if (!requireWriteProject('删除评测执行')) return;
    confirmAction('删除评测执行', `将永久删除「${run.name}」及其所有用例执行记录。`, async () => {
    try {
      await evalRunsApi.remove(id);
      cache.evalRuns = null;
      routeTo('evalruns');
      toast('已删除');
    } catch (e) {
      toastError('删除失败', e);
    }
    });
  };

  const executions = run.case_executions || [];
  renderScoreSection(scoreSummary, executions);
  renderEvalRunCaseTable(run, executions);
}

function canReEvalCase(ce: CaseExecution): boolean {
  if (!ce.test_task_id) return false;
  return ce.status === 'REPORTED' || ce.status === 'ERROR' || ce.status === 'STOPPED' || ce.status === 'TEST_DONE';
}

function evalRunCaseRowHtml(ce: CaseExecution, selected: boolean, showReEval: boolean): string {
  const reportCell = canOpenCaseReport(ce)
    ? `<span class="link-inline" data-open-report="${ce.id}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/></svg>${ce.report ? '报告' : '失败详情'}</span>`
    : '<span class="muted">--</span>';
  const reEvalCell = showReEval && canReEvalCase(ce)
    ? `<span class="link-inline" data-reeval="${ce.id}" title="不重跑测试，用最新题面/校验点/Prompt 重新判分"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></svg>重新评测</span>`
    : '<span class="muted">--</span>';
  return `<tr data-ce="${ce.id}">
      <td><input type="checkbox" class="erd-row-check" data-ce-check="${ce.id}" ${selected ? 'checked' : ''}></td>
      <td class="case-idx">${String(ce.order_no).padStart(2, '0')}</td>
      <td class="case-name">${escapeHtml(ce.case_name)}${caseMessageTagHtml(ce)}</td>
      <td>${badgeHtml(CASE_STATUS_MAP, ce.status)}</td>
      <td>${scorePillHtml(ce.score, ce.score_status, ce.score_error)}</td>
      <td>${issueTagsHtml(ce.issue_tags)}</td>
      <td><span class="link-inline" data-open-artifacts="${ce.id}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16v14H4z"/><path d="M4 6l8 6 8-6"/></svg>查看产物</span></td>
      <td>${ce.test_task_id ? `<span class="link-inline" data-open-trace="${ce.id}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>查看 trace</span>` : '<span class="muted">--</span>'}</td>
      <td>${reportCell}</td>
      <td>${reEvalCell}</td>
    </tr>`;
}

export function disposeEvalRunCaseTable(): void {
  evalRunTableRenderCancel?.();
  evalRunTableRenderCancel = null;
  evalRunTableDisposeEvents?.();
  evalRunTableDisposeEvents = null;
}

function renderEvalRunCaseTable(run: EvalRun, executions: CaseExecution[]): void {
  disposeEvalRunCaseTable();
  const seq = ++evalRunTableRenderSeq;
  const tbody = document.getElementById('erd-case-table-body')!;
  const exportBtn = document.getElementById('erd-export-btn') as HTMLButtonElement;
  const canExportArtifacts = hasPermission('eval_run:export') && hasPermission('file:download') && canDownloadProject();
  exportBtn.style.display = canExportArtifacts ? 'inline-flex' : 'none';
  const selCountEl = document.getElementById('erd-selected-count') as HTMLElement;
  const selectAllBox = document.getElementById('erd-select-all') as HTMLInputElement;
  const byId = new Map(executions.map(ce => [ce.id, ce]));
  const selectedIds = new Set<string>();

  function refreshSelection(): void {
    const count = selectedIds.size;
    exportBtn.disabled = count === 0;
    selCountEl.style.display = count > 0 ? 'inline' : 'none';
    selCountEl.textContent = `已选 ${count} 项`;
    selectAllBox.disabled = executions.length === 0;
    selectAllBox.checked = executions.length > 0 && count === executions.length;
    selectAllBox.indeterminate = count > 0 && count < executions.length;
  }

  function syncRenderedCheckboxes(): void {
    tbody.querySelectorAll<HTMLInputElement>('.erd-row-check').forEach(cb => {
      cb.checked = selectedIds.has(cb.getAttribute('data-ce-check') || '');
    });
  }

  selectAllBox.checked = false;
  selectAllBox.indeterminate = false;
  selectAllBox.onclick = () => {
    selectedIds.clear();
    if (selectAllBox.checked) executions.forEach(ce => selectedIds.add(ce.id));
    syncRenderedCheckboxes();
    refreshSelection();
  };
  exportBtn.onclick = () => {
    exportArtifactsZip(run, executions.filter(ce => selectedIds.has(ce.id)));
  };

  const showReEval = canWriteProject() && hasPermission('eval_run:create');
  const offArtifacts = delegate(tbody, '[data-open-artifacts]', (el, e) => { e.stopPropagation(); openArtifactsDrawer(run, el.getAttribute('data-open-artifacts')!); });
  const offTrace = delegate(tbody, '[data-open-trace]', (el, e) => { e.stopPropagation(); openTraceDrawer(run, el.getAttribute('data-open-trace')!); });
  const offReport = delegate(tbody, '[data-open-report]', (el, e) => { e.stopPropagation(); openReportDrawer(run, el.getAttribute('data-open-report')!); });
  const offReEval = delegate(tbody, '[data-reeval]', (el, e) => {
    e.stopPropagation();
    if (!requireWriteProject('重新评测')) return;
    const ceId = el.getAttribute('data-reeval') || '';
    const ce = byId.get(ceId);
    if (!ce) return;
    confirmAction(
      '重新评测',
      `将保留「${ce.case_name}」的测试产物，用更新后的标准重新判分。`,
      async () => {
        try {
          await evalRunsApi.reeval(run.id, ceId);
          cache.evalRuns = null;
          toast('已排队重新评测');
          openEvalRunDetail(run.id);
        } catch (err) {
          toastError('重新评测失败', err);
        }
      },
    );
  });
  const rowClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    const checkbox = target.closest<HTMLInputElement>('.erd-row-check');
    if (checkbox) {
      e.stopPropagation();
      const id = checkbox.getAttribute('data-ce-check') || '';
      if (checkbox.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      refreshSelection();
      return;
    }
    if (target.closest('[data-open-artifacts],[data-open-trace],[data-open-report],[data-reeval]')) return;
    const row = target.closest<HTMLTableRowElement>('tr[data-ce]');
    if (!row) return;
    const ce = byId.get(row.getAttribute('data-ce') || '');
    if (ce && canOpenCaseReport(ce)) openReportDrawer(run, ce.id);
    else if (ce) openArtifactsDrawer(run, ce.id);
  };
  tbody.addEventListener('click', rowClick);
  evalRunTableDisposeEvents = () => {
    offArtifacts();
    offTrace();
    offReport();
    offReEval();
    tbody.removeEventListener('click', rowClick);
    selectAllBox.onclick = null;
    exportBtn.onclick = null;
  };

  const renderJob = renderListInChunks({
    container: tbody,
    items: executions,
    chunkSize: 40,
    emptyHtml: `<tr><td colspan="10">${emptyStateHtml('暂无用例执行记录', '')}</td></tr>`,
    renderItem: ce => evalRunCaseRowHtml(ce, selectedIds.has(ce.id), showReEval),
    afterRender: () => {
      if (seq !== evalRunTableRenderSeq) return;
      syncRenderedCheckboxes();
      refreshSelection();
    },
  });
  evalRunTableRenderCancel = renderJob.cancel;
  renderJob.done.catch(e => {
    if (seq === evalRunTableRenderSeq) tbody.innerHTML = `<tr><td colspan="10">${errorStateHtml(errMsg(e))}</td></tr>`;
  });
  refreshSelection();
}

/* renderScoreSection 渲染机评总分区块：均分/极值/未参与统计数、Top问题、分数分布。
   scoreSummary 为空或全员 NOT_APPLICABLE（历史 run，脚本版本不支持打分）时整块隐藏，
   不展示一个没有意义的"0分"区块。 */
function renderScoreSection(summary: ScoreSummary | undefined, executions: CaseExecution[]): void {
  const section = document.getElementById('erd-score-section')!;
  if (!summary || summary.scored_count === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = 'block';

  document.getElementById('erd-score-avg')!.innerHTML = `${Math.round((summary.avg_score || 0) * 10) / 10}<span style="font-size:18px;color:var(--quiet);">/4</span>`;
  document.getElementById('erd-score-sub')!.textContent = `${summary.total_count} 条用例中 ${summary.scored_count} 条已生成得分${summary.availability_rate != null ? `，可用率 ${Math.round(summary.availability_rate * 100)}%` : ''}`;

  const scored = executions.filter(ce => ce.score_status === 'OK' && ce.score != null);
  const maxCe = scored.reduce((a, b) => (!a || (b.score! > a.score!)) ? b : a, undefined as CaseExecution | undefined);
  const minCe = scored.reduce((a, b) => (!a || (b.score! < a.score!)) ? b : a, undefined as CaseExecution | undefined);
  document.getElementById('erd-score-max')!.textContent = maxCe ? String(maxCe.score) : '--';
  document.getElementById('erd-score-max-name')!.textContent = maxCe ? maxCe.case_name : '';
  document.getElementById('erd-score-min')!.textContent = minCe ? String(minCe.score) : '--';
  document.getElementById('erd-score-min-name')!.textContent = minCe ? minCe.case_name : '';

  const naCount = summary.total_count - summary.scored_count;
  document.getElementById('erd-score-na')!.textContent = String(naCount);

  const issuesEl = document.getElementById('erd-top-issues')!;
  document.getElementById('erd-issues-sub')!.textContent = `参与计分用例 ${summary.scored_count} 条`;
  issuesEl.innerHTML = summary.top_issues.length
    ? summary.top_issues.map((it, i) => `
        <div class="issue-row">
          <div class="issue-rank">${i + 1}</div>
          <div class="issue-label">${escapeHtml((it.module ? it.module + ' / ' : '') + (it.label || issueTagLabel(it.code)) + (it.level ? ' · ' + it.level : ''))}</div>
          <div class="issue-bar-track"><div class="issue-bar-fill" style="width:${Math.round(it.ratio * 100)}%;"></div></div>
          <div class="issue-count">${it.count} · ${Math.round(it.ratio * 100)}%</div>
        </div>`).join('')
    : `<div class="panel-body pad muted">本次运行未命中任何标签</div>`;

  const dist = summary.distribution;
  const total = summary.scored_count || 1;
  const buckets: { key: string; color: string; label: string }[] = [
    { key: '0', label: '0 严重', color: 'var(--err)' },
    { key: '1', label: '1 较严重', color: 'var(--err)' },
    { key: '2', label: '2 轻微', color: 'var(--queue)' },
    { key: '3', label: '3 可用', color: 'var(--accent)' },
    { key: '4', label: '4 优秀', color: 'var(--ok)' },
  ];
  document.getElementById('erd-score-dist')!.innerHTML = `
    <div class="dist-bar">${buckets.map(b => `<span style="width:${Math.round((dist[b.key] || 0) / total * 100)}%;background:${b.color};"></span>`).join('')}</div>
    <div class="dist-legend">${buckets.map(b => `<span class="lg"><i class="sw" style="background:${b.color};"></i>${b.label} (${dist[b.key] || 0})</span>`).join('')}</div>
  `;
}

/* 批量导出：拉取所选用例测试/评测阶段产物 tar.gz，本地解压后按用例分文件夹重新打包为一个 zip。
   task-pilot 没有"跨用例批量下载"接口，只有 /tasks/:id/artifacts（单任务的产物列表）
   与 /files/:id/download（单文件下载），这里在浏览器侧把多个任务的产物聚合成一次下载。 */
async function exportArtifactsZip(run: EvalRun, executions: CaseExecution[]): Promise<void> {
  if (executions.length === 0) { toast('请先选择要导出的用例'); return; }
  toast(`正在拉取 ${executions.length} 条用例的产物…`);
  const files: { name: string; data: Uint8Array }[] = [];
  let fileCount = 0;
  for (const ce of executions) {
    const folder = sanitizeFolderName(ce.case_name) + '_' + ce.id;
    try {
      if (ce.test_task_id) {
        const testResult = await fetchTaskMembers(ce.test_task_id);
        testResult?.members.forEach(m => { files.push({ name: `${folder}/test/${m.name}`, data: m.data }); fileCount++; });
      }
      if (ce.eval_task_id) {
        const evalResult = await fetchTaskMembers(ce.eval_task_id);
        evalResult?.members.forEach(m => { files.push({ name: `${folder}/eval/${m.name}`, data: m.data }); fileCount++; });
      }
      if (ce.report) {
        files.push({ name: `${folder}/report.md`, data: new TextEncoder().encode(ce.report) });
        fileCount++;
      }
    } catch (e) {
      toastError(`拉取用例「${ce.case_name}」产物失败`, e);
    }
  }
  if (fileCount === 0) { toast('所选用例暂无可导出的产物'); return; }
  downloadZip(files, `${sanitizeFolderName(run.name)}-产物导出.zip`);
  toast(`已导出 ${executions.length} 条用例、共 ${fileCount} 个文件`);
}
