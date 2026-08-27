/* ============================================================
   WorkEval — App logic
   全部数据通过 task-pilot 后端 REST 接口获取（src/api/*），不含任何 mock 数据。
   ============================================================ */
import './styles.css';
import { caseSetsApi } from '@/api/caseSets';
import { evalRunsApi, leaderboardApi } from '@/api/evalRuns';
import { targetEndpointsApi, evalEndpointsApi } from '@/api/endpoints';
import { promptsApi } from '@/api/prompts';
import { mcpConfigsApi } from '@/api/mcpConfigs';
import { skillConfigsApi } from '@/api/skillConfigs';
import { envVarsApi } from '@/api/envVars';
import { filesApi } from '@/api/files';
import { ApiError } from '@/api/client';
import { extractTarGz, findMember, decodeText } from '@/lib/tarball';
import { downloadZip } from '@/lib/minizip';
import { unzip, decodeZipText, type UnzipEntry } from '@/lib/unzip';
import { escapeAttr, escapeHtml, emptyStateHtml, errorStateHtml, fmtSize, fmtTime, skeletonRows } from '@/lib/ui';
import { badgeHtml, caseMessageTagHtml, CASE_STATUS_MAP, RUN_STATUS_MAP } from '@/lib/status';
import { issueTagsHtml, scorePillHtml, issueTagLabel } from '@/lib/issueTags';
import { renderJSON, renderMarkdown } from '@/lib/renderers';
import { addCheckpointFromInput, insertAtCursor, renderCheckpointEditor, setupRichEditor, type CheckpointDraft } from '@/lib/richEditor';
import { CASE_LEVEL1_OPTIONS, CASE_TASK_TYPE_OPTIONS, level2OptionsOf } from '@/lib/caseTags';
import type {
  CaseSet, CaseItem, EvalRun, CaseExecution, EndpointResponse,
  EvalPrompt, FileResponse, TraceEvent, TraceItem, TraceItemKind, TraceUsage, EndpointKind,
  TarMember, CaseRequestInput, CheckpointRequestInput, ScoreSummary, LeaderboardItem, MCPConfig, SkillConfig, EnvVar,
} from '@/types';

// ---------------- Theme ----------------
const root = document.documentElement;
function applyTheme(t: string): void {
  root.setAttribute('data-theme', t);
  localStorage.setItem('we-theme', t);
  (document.getElementById('theme-icon-sun') as HTMLElement).style.display = t === 'light' ? 'block' : 'none';
  (document.getElementById('theme-icon-moon') as HTMLElement).style.display = t === 'light' ? 'none' : 'block';
}
applyTheme(localStorage.getItem('we-theme') || 'dark');
document.getElementById('theme-toggle')!.addEventListener('click', () => {
  applyTheme(root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
});

// ---------------- Toast ----------------
function toast(msg: string): void {
  const wrap = document.getElementById('toast-wrap')!;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12l4 4L19 6"/></svg><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}
function errMsg(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
function toastError(prefix: string, e: unknown): void {
  toast(`${prefix}：${errMsg(e)}`);
}

// ---------------- Modal helpers ----------------
function openModal(id: string): void { document.getElementById(id)!.classList.add('open'); }
function closeModal(id: string): void { document.getElementById(id)!.classList.remove('open'); }
document.querySelectorAll('[data-close-modal]').forEach(el => {
  el.addEventListener('click', () => closeModal(el.getAttribute('data-close-modal')!));
});

// ---------------- Router ----------------
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item[data-view]');
const crumbs = document.getElementById('crumbs')!;
const state: { evalRunId: string | null; caseSetId: string | null } = { evalRunId: null, caseSetId: null };

function showView(name: string, crumbHtml?: string): void {
  views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  navItems.forEach(n => n.classList.toggle('active', n.getAttribute('data-view') === name));
  crumbs.innerHTML = crumbHtml || navItems[0].outerHTML;
  window.scrollTo(0, 0);
}

navItems.forEach(n => n.addEventListener('click', () => {
  routeTo(n.getAttribute('data-view')!);
}));
document.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-view-link]');
  if (!link) return;
  e.preventDefault();
  // 使用捕获阶段统一拦截，阻止详情页历史重复绑定的冒泡处理器再次触发路由。
  e.stopImmediatePropagation();
  routeTo(link.getAttribute('data-view-link')!);
  if (link.getAttribute('data-action') === 'new-evalrun') openNewEvalRunModal();
}, true);

function routeTo(view: string, param?: string): void {
  switch (view) {
    case 'dashboard': showView('dashboard', '<b>概览</b>'); renderDashboard(); break;
    case 'evalruns': showView('evalruns', '<b>评测执行</b>'); renderEvalRunList(); break;
    case 'evalrun-detail': openEvalRunDetail(param!); break;
    case 'casesets': showView('casesets', '<b>用例集</b>'); renderCaseSetGrid(); break;
    case 'caseset-detail': openCaseSetDetail(param!); break;
    case 'target-endpoints': showView('target-endpoints', '<b>配置中心</b> / 被测模型端点'); renderEndpointList('target'); break;
    case 'eval-endpoints': showView('eval-endpoints', '<b>配置中心</b> / 评测模型端点'); renderEndpointList('eval'); break;
    case 'prompts': showView('prompts', '<b>评测 Prompt</b>'); renderPromptGrid(); break;
    case 'leaderboard': showView('leaderboard', '<b>模型 Leaderboard</b>'); renderLeaderboard('30d'); break;
    case 'mcp-servers': showView('mcp-servers', '<b>配置中心</b> / MCP 服务器'); renderMCPConfigList(); break;
    case 'skills': showView('skills', '<b>配置中心</b> / Skill'); renderSkillConfigGrid(); break;
    case 'env-vars': showView('env-vars', '<b>配置中心</b> / 环境变量'); renderEnvVarList(); break;
  }
}

/* ------------------------------------------------------------
   本地缓存：跨视图共享的引用数据（用例集/端点/Prompt 列表），
   避免每次切换页面都重新拉取。写操作后主动失效对应缓存。
   ------------------------------------------------------------ */
const cache = {
  caseSets: null as CaseSet[] | null,
  evalRuns: null as EvalRun[] | null,
  targetEndpoints: null as EndpointResponse[] | null,
  evalEndpoints: null as EndpointResponse[] | null,
  prompts: null as EvalPrompt[] | null,
  mcpConfigs: null as MCPConfig[] | null,
  skillConfigs: null as SkillConfig[] | null,
  envVars: null as EnvVar[] | null,
};
async function loadCaseSets(force = false): Promise<CaseSet[]> {
  if (!force && cache.caseSets) return cache.caseSets;
  cache.caseSets = await caseSetsApi.list();
  return cache.caseSets;
}
async function loadEvalRuns(force = false): Promise<EvalRun[]> {
  if (!force && cache.evalRuns) return cache.evalRuns;
  cache.evalRuns = await evalRunsApi.list();
  return cache.evalRuns;
}
async function loadTargetEndpoints(force = false): Promise<EndpointResponse[]> {
  if (!force && cache.targetEndpoints) return cache.targetEndpoints;
  cache.targetEndpoints = await targetEndpointsApi.list();
  return cache.targetEndpoints;
}
async function loadEvalEndpoints(force = false): Promise<EndpointResponse[]> {
  if (!force && cache.evalEndpoints) return cache.evalEndpoints;
  cache.evalEndpoints = await evalEndpointsApi.list();
  return cache.evalEndpoints;
}
async function loadPrompts(force = false): Promise<EvalPrompt[]> {
  if (!force && cache.prompts) return cache.prompts;
  cache.prompts = await promptsApi.list();
  return cache.prompts;
}
async function loadMCPConfigs(force = false): Promise<MCPConfig[]> {
  if (!force && cache.mcpConfigs) return cache.mcpConfigs;
  cache.mcpConfigs = await mcpConfigsApi.list();
  return cache.mcpConfigs;
}
async function loadSkillConfigs(force = false): Promise<SkillConfig[]> {
  if (!force && cache.skillConfigs) return cache.skillConfigs;
  cache.skillConfigs = await skillConfigsApi.list();
  return cache.skillConfigs;
}
async function loadEnvVars(force = false): Promise<EnvVar[]> {
  if (!force && cache.envVars) return cache.envVars;
  cache.envVars = await envVarsApi.list();
  return cache.envVars;
}

// ================= DASHBOARD =================
async function renderDashboard(): Promise<void> {
  const recentWrap = document.getElementById('dashboard-recent-runs')!;
  const runWrap = document.getElementById('dashboard-running-cases')!;
  recentWrap.innerHTML = skeletonRows(4);
  runWrap.innerHTML = skeletonRows(3, 70);

  let runs: EvalRun[];
  let caseSets: CaseSet[];
  try {
    [runs, caseSets] = await Promise.all([loadEvalRuns(true), loadCaseSets(true)]);
  } catch (e) {
    recentWrap.innerHTML = errorStateHtml(errMsg(e));
    runWrap.innerHTML = '';
    return;
  }

  document.getElementById('nav-count-evalruns')!.textContent = String(runs.length);
  document.getElementById('nav-count-casesets')!.textContent = String(caseSets.length);

  const reported = runs.reduce((s, r) => s + r.reported, 0);
  const errored = runs.reduce((s, r) => s + r.errored, 0);
  const total = runs.reduce((s, r) => s + r.total, 0);
  const running = runs.filter(r => r.status === 'RUNNING').length;
  const pendingRuns = runs.filter(r => r.status === 'PENDING').length;
  const totalCases = caseSets.reduce((s, c) => s + (c.cases?.length || 0), 0);

  document.getElementById('stat-reported')!.textContent = String(reported);
  document.getElementById('stat-reported-sub')!.textContent = `共 ${total} 条用例，${reported} 条已生成报告，${errored} 条异常`;
  document.getElementById('stat-hero-bars')!.innerHTML = runs.slice(0, 7).reverse().map(r => {
    const pct = r.total ? Math.round(((r.reported + r.errored) / r.total) * 100) : 0;
    return `<i style="height:${Math.max(pct, 4)}%"></i>`;
  }).join('') || '<span class="muted" style="font-size:12px;">暂无执行数据</span>';
  document.getElementById('stat-running')!.textContent = String(running);
  document.getElementById('stat-running-foot')!.textContent = `${running} 个执行处于 RUNNING`;
  document.getElementById('stat-pending')!.textContent = String(pendingRuns);
  document.getElementById('stat-casesets')!.textContent = String(caseSets.length);
  document.getElementById('stat-cases-total')!.textContent = `共 ${totalCases} 条用例`;
  document.getElementById('stat-errored')!.textContent = String(errored);

  const sorted = [...runs].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()).slice(0, 5);
  if (sorted.length === 0) {
    recentWrap.innerHTML = emptyStateHtml('还没有评测执行', '从用例集详情页发起第一次评测执行。');
  } else {
    recentWrap.innerHTML = sorted.map((r, i) => {
      const cs = caseSets.find(c => c.id === r.case_set_id);
      const pct = r.total ? Math.round(((r.reported + r.errored) / r.total) * 100) : 0;
      return `<div class="row-item" style="grid-template-columns:2fr 1fr 1.2fr 90px;animation-delay:${i * 30}ms" data-open-run="${r.id}">
        <div>
          <div class="row-title">${escapeHtml(r.name)}</div>
          <div class="row-sub">${cs ? escapeHtml(cs.name) : '--'}</div>
        </div>
        <div>${badgeHtml(RUN_STATUS_MAP, r.status)}</div>
        <div>
          <div class="progress-bar" style="margin-bottom:4px;"><span style="width:${pct}%"></span></div>
          <div class="row-sub">${r.reported + r.errored} / ${r.total} 完成</div>
        </div>
        <div class="row-sub">${fmtTime(r.updated_at).split(' ')[1] || ''}</div>
      </div>`;
    }).join('');
    recentWrap.querySelectorAll('[data-open-run]').forEach(el => {
      el.addEventListener('click', () => routeTo('evalrun-detail', el.getAttribute('data-open-run')!));
    });
  }

  let runningRes;
  try {
    runningRes = await evalRunsApi.running();
  } catch (e) {
    runWrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  const runningCases = runningRes.case_executions;
  if (runningCases.length === 0) {
    runWrap.innerHTML = emptyStateHtml('当前没有正在执行的用例', '所有评测执行都已完成或处于排队状态。');
  } else {
    runWrap.innerHTML = runningCases.map((ce, i) => {
      const run = runs.find(r => r.id === ce.eval_run_id);
      return `
      <div style="border:1px solid var(--line);border-radius:10px;padding:12px 14px;animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 40}ms">
        <div class="flex-between" style="margin-bottom:6px;">
          <span class="case-name" style="font-size:13px;">${escapeHtml(ce.case_name)}</span>
          ${badgeHtml(CASE_STATUS_MAP, ce.status)}
        </div>
        <div class="row-sub" style="margin-bottom:8px;">来自「${run ? escapeHtml(run.name) : ce.eval_run_id}」</div>
        <div class="progress-bar progress-indeterminate"><span></span></div>
      </div>
    `;
    }).join('');
  }
}

// ================= EVAL RUN LIST =================
async function renderEvalRunList(): Promise<void> {
  const wrap = document.getElementById('evalrun-list')!;
  wrap.innerHTML = skeletonRows(5);
  let runs: EvalRun[];
  let caseSets: CaseSet[];
  try {
    [runs, caseSets] = await Promise.all([loadEvalRuns(true), loadCaseSets()]);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  const selectAllBox = document.getElementById('er-select-all') as HTMLInputElement;
  const batchDeleteBtn = document.getElementById('er-batch-delete-btn') as HTMLButtonElement;
  const selCountEl = document.getElementById('er-selected-count') as HTMLElement;
  selectAllBox.checked = false;
  batchDeleteBtn.disabled = true;
  selCountEl.style.display = 'none';
  if (runs.length === 0) { wrap.innerHTML = emptyStateHtml('还没有评测执行', '从用例集详情页发起第一次评测执行。'); return; }
  const sorted = [...runs].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  wrap.innerHTML = sorted.map((r, i) => {
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
async function previewLocalTraceFile(): Promise<void> {
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
async function openNewEvalRunModal(): Promise<void> {
  const submitBtn = document.getElementById('nr-submit') as HTMLButtonElement;
  submitBtn.disabled = true;
  openModal('modal-new-evalrun');
  try {
    const [caseSets, targetEps, evalEps, prompts] = await Promise.all([
      loadCaseSets(), loadTargetEndpoints(), loadEvalEndpoints(), loadPrompts(),
    ]);
    if (caseSets.length === 0) {
      closeModal('modal-new-evalrun');
      toast('请先创建至少一个用例集');
      return;
    }
    (document.getElementById('nr-caseset') as HTMLSelectElement).innerHTML = caseSets.map(c => `<option value="${c.id}">${escapeHtml(c.name)}（${c.cases?.length || 0} 条用例）</option>`).join('');
    (document.getElementById('nr-endpoint') as HTMLSelectElement).innerHTML = targetEps.map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.is_default ? ' · 默认' : ''}</option>`).join('');
    (document.getElementById('nr-eval-endpoint') as HTMLSelectElement).innerHTML = evalEps.map(e => `<option value="${e.id}">${escapeHtml(e.name)}${e.is_default ? ' · 默认' : ''}</option>`).join('');
    (document.getElementById('nr-prompt') as HTMLSelectElement).innerHTML = prompts.map(p => `<option value="${p.id}">${escapeHtml(p.name)}${p.is_default ? ' · 默认' : ''}</option>`).join('');
    (document.getElementById('nr-max-concurrent') as HTMLInputElement).value = '';
    submitBtn.disabled = false;
  } catch (e) {
    closeModal('modal-new-evalrun');
    toastError('加载配置项失败', e);
  }
}
function openNewEvalRunModalFor(caseSetId: string): void {
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
    const run = await evalRunsApi.create({
      case_set_id: csId,
      endpoint_id: (document.getElementById('nr-endpoint') as HTMLSelectElement).value || undefined,
      eval_endpoint_id: (document.getElementById('nr-eval-endpoint') as HTMLSelectElement).value || undefined,
      prompt_id: (document.getElementById('nr-prompt') as HTMLSelectElement).value || undefined,
      max_concurrent: maxConcurrent !== undefined && !isNaN(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : undefined,
    });
    cache.evalRuns = null;
    closeModal('modal-new-evalrun');
    toast('评测执行已创建，用例已排入队列');
    routeTo('evalrun-detail', run.id);
  } catch (e) {
    toastError('创建失败', e);
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

async function renderLeaderboard(period: '30d' | '90d' | 'all'): Promise<void> {
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
async function openEvalRunDetail(id: string): Promise<void> {
  state.evalRunId = id;
  showView('evalrun-detail', `<a href="#" data-view-link="evalruns" class="link-inline" style="color:var(--quiet)">评测执行</a> / <b>加载中…</b>`);
  document.querySelectorAll('#view-evalrun-detail [data-view-link]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); routeTo('evalruns'); }));

  document.getElementById('erd-title')!.textContent = '加载中…';
  document.getElementById('erd-case-table-body')!.innerHTML = `<tr><td colspan="9">${skeletonRows(3)}</td></tr>`;

  let run: EvalRun;
  let scoreSummary: ScoreSummary | undefined;
  try {
    const resp = await evalRunsApi.getWithSummary(id);
    run = resp.eval_run;
    scoreSummary = resp.score_summary;
  } catch (e) {
    document.getElementById('erd-title')!.textContent = '加载失败';
    document.getElementById('erd-case-table-body')!.innerHTML = `<tr><td colspan="9">${errorStateHtml(errMsg(e))}</td></tr>`;
    return;
  }

  const [caseSets, targetEps, evalEps] = await Promise.all([loadCaseSets(), loadTargetEndpoints(), loadEvalEndpoints()]);
  const cs = caseSets.find(c => c.id === run.case_set_id);
  const te = targetEps.find(e => e.id === run.endpoint_id);
  const ee = evalEps.find(e => e.id === run.eval_endpoint_id);

  document.getElementById('erd-title')!.textContent = run.name;
  document.getElementById('erd-status-badge')!.outerHTML = badgeHtml(RUN_STATUS_MAP, run.status).replace('<span class="badge', '<span class="badge" id="erd-status-badge"');
  document.getElementById('erd-meta')!.textContent = `${run.id}  ·  创建于 ${fmtTime(run.created_at)}  ·  用例集「${cs ? cs.name : '--'}」`;
  crumbs.innerHTML = `<a href="#" data-view-link="evalruns" class="link-inline" style="color:var(--quiet)">评测执行</a> / <b>${escapeHtml(run.name)}</b>`;
  document.querySelectorAll('#view-evalrun-detail [data-view-link]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); routeTo('evalruns'); }));

  const pct = run.total ? Math.round(((run.reported + run.errored) / run.total) * 100) : 0;
  document.getElementById('erd-progress-text')!.textContent = `${run.reported + run.errored} / ${run.total}`;
  document.getElementById('erd-progress-pct')!.textContent = pct + '%';
  (document.getElementById('erd-progress-bar') as HTMLElement).style.width = pct + '%';

  document.getElementById('erd-config-lines')!.innerHTML = `
    <div class="flex-between"><span class="muted">被测端点</span><span class="mono">${te ? escapeHtml(te.name) : '--'}</span></div>
    <div class="flex-between"><span class="muted">评测端点</span><span class="mono">${ee ? escapeHtml(ee.name) : '--'}</span></div>
    <div class="flex-between"><span class="muted">单请求并发上限</span><span class="mono">${run.max_concurrent || '不限'}</span></div>
  `;

  const stopBtn = document.getElementById('erd-stop-btn') as HTMLButtonElement;
  stopBtn.style.display = (run.status === 'RUNNING' || run.status === 'PENDING') ? 'inline-flex' : 'none';
  stopBtn.onclick = () => confirmAction('停止评测执行', `将取消所有未完成用例的任务，「${run.name}」将被置为 STOPPED，此操作不可撤销。`, async () => {
    try {
      await evalRunsApi.stop(id);
      cache.evalRuns = null;
      toast('执行已停止');
      openEvalRunDetail(id);
    } catch (e) {
      toastError('停止失败', e);
    }
  });
  (document.getElementById('erd-delete-btn') as HTMLButtonElement).onclick = () => confirmAction('删除评测执行', `将永久删除「${run.name}」及其所有用例执行记录。`, async () => {
    try {
      await evalRunsApi.remove(id);
      cache.evalRuns = null;
      routeTo('evalruns');
      toast('已删除');
    } catch (e) {
      toastError('删除失败', e);
    }
  });

  const executions = run.case_executions || [];
  renderScoreSection(scoreSummary, executions);
  const tbody = document.getElementById('erd-case-table-body')!;
  tbody.innerHTML = executions.map(ce => `<tr data-ce="${ce.id}">
      <td><input type="checkbox" class="erd-row-check" data-ce-check="${ce.id}"></td>
      <td class="case-idx">${String(ce.order_no).padStart(2, '0')}</td>
      <td class="case-name">${escapeHtml(ce.case_name)}${caseMessageTagHtml(ce)}</td>
      <td>${badgeHtml(CASE_STATUS_MAP, ce.status)}</td>
      <td>${scorePillHtml(ce.score, ce.score_status, ce.score_error)}</td>
      <td>${issueTagsHtml(ce.issue_tags)}</td>
      <td><span class="link-inline" data-open-artifacts="${ce.id}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16v14H4z"/><path d="M4 6l8 6 8-6"/></svg>查看产物</span></td>
      <td>${ce.test_task_id ? `<span class="link-inline" data-open-trace="${ce.id}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h4l3 8 4-16 3 8h4"/></svg>查看 trace</span>` : '<span class="muted">--</span>'}</td>
      <td>${canOpenCaseReport(ce) ? `<span class="link-inline" data-open-report="${ce.id}"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h5"/></svg>${ce.report ? '报告' : '失败详情'}</span>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="9">${emptyStateHtml('暂无用例执行记录', '')}</td></tr>`;

  tbody.querySelectorAll('[data-open-artifacts]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); openArtifactsDrawer(run, el.getAttribute('data-open-artifacts')!); }));
  tbody.querySelectorAll('[data-open-trace]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); openTraceDrawer(run, el.getAttribute('data-open-trace')!); }));
  tbody.querySelectorAll('[data-open-report]').forEach(el => el.addEventListener('click', (e) => { e.stopPropagation(); openReportDrawer(run, el.getAttribute('data-open-report')!); }));
  tbody.querySelectorAll('tr').forEach(tr => tr.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('input[type=checkbox]')) return;
    const ce = executions.find(c => c.id === tr.getAttribute('data-ce'));
    if (ce && canOpenCaseReport(ce)) openReportDrawer(run, ce.id);
    else if (ce) openArtifactsDrawer(run, ce.id);
  }));

  // ---- 批量选择与导出 ----
  const exportBtn = document.getElementById('erd-export-btn') as HTMLButtonElement;
  const selCountEl = document.getElementById('erd-selected-count') as HTMLElement;
  const selectAllBox = document.getElementById('erd-select-all') as HTMLInputElement;
  function refreshSelection(): void {
    const checked = Array.from(tbody.querySelectorAll<HTMLInputElement>('.erd-row-check:checked'));
    exportBtn.disabled = checked.length === 0;
    selCountEl.style.display = checked.length > 0 ? 'inline' : 'none';
    selCountEl.textContent = `已选 ${checked.length} 项`;
  }
  selectAllBox.checked = false;
  selectAllBox.onclick = () => {
    tbody.querySelectorAll<HTMLInputElement>('.erd-row-check:not(:disabled)').forEach(cb => cb.checked = selectAllBox.checked);
    refreshSelection();
  };
  tbody.querySelectorAll('.erd-row-check').forEach(cb => cb.addEventListener('click', (e) => { e.stopPropagation(); refreshSelection(); }));
  exportBtn.onclick = () => {
    const ids = Array.from(tbody.querySelectorAll<HTMLInputElement>('.erd-row-check:checked')).map(cb => cb.getAttribute('data-ce-check')!);
    exportArtifactsZip(run, executions.filter(ce => ids.includes(ce.id)));
  };
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

/** 拉取某个任务已上传的产物（通常只有一个 output.tar.gz），下载并解压出全部内部文件。 */
async function fetchTaskMembers(taskId: string): Promise<{ artifact: FileResponse; members: TarMember[] } | null> {
  const artifacts = await filesApi.listArtifacts(taskId);
  if (artifacts.length === 0) return null;
  const artifact = artifacts[0];
  const blob = await filesApi.downloadBlob(artifact.file_id);
  const members = await extractTarGz(blob);
  return { artifact, members };
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
function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

function confirmAction(title: string, desc: string, onConfirm: () => void): void {
  document.getElementById('confirm-title')!.textContent = title;
  document.getElementById('confirm-desc')!.textContent = desc;
  openModal('modal-confirm');
  const btn = document.getElementById('confirm-ok-btn')!;
  const handler = () => { onConfirm(); closeModal('modal-confirm'); btn.removeEventListener('click', handler); };
  btn.addEventListener('click', handler);
}

// ================= CASE SETS =================
function linkedRunsOf(caseSetId: string, runs: EvalRun[]): EvalRun[] {
  return runs.filter(r => r.case_set_id === caseSetId);
}

async function renderCaseSetGrid(): Promise<void> {
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
  skip_html_visual_score?: unknown;
  level1_type?: unknown;
  level2_type?: unknown;
  task_types?: unknown;
  difficulty?: unknown;
}
// CheckpointImportItem 校验点条目：支持纯字符串（无参考文件，向后兼容旧模板）
// 或对象形式 {description, files}（files 是 ZIP 内相对路径数组，指向该校验点的参考文件）。
interface CheckpointImportItem {
  description: string;
  files: string[];
}

function normalizeZipPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\\/g, '/');
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
function validateImportedManifest(raw: CaseSetImportManifest): { name: string; description: string; cases: (CaseImportItem & { name: string; description: string; checkpoints: CheckpointImportItem[]; files: string[]; skipHTMLVisualScore: boolean; level1Type: string; level2Type: string; taskTypes: string[]; difficulty: string })[] } {
  const name = String(raw.name || '').trim();
  const description = String(raw.description || '').trim();
  if (!name) throw new Error('manifest.json 缺少 name');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('manifest.json 至少需要一条 cases');
  const cases = raw.cases.map((item, idx) => {
    const c = item as CaseImportItem & { task_type?: unknown };
    const caseName = String(c.name || '').trim();
    const caseDesc = String(c.description || '').trim();
    const checkpoints = asCheckpointArray(c.checkpoints, `cases[${idx}].checkpoints`);
    const files = asStringArray(c.files ?? c.file_paths, `cases[${idx}].files`);
    if (!caseName || !caseDesc || checkpoints.length === 0) throw new Error(`第 ${idx + 1} 条用例缺少 name / description / checkpoints`);
    // 兼容旧 ZIP：task_type 单字符串 → task_types 数组
    const taskTypes = Array.isArray(c.task_types)
      ? asStringArray(c.task_types, `cases[${idx}].task_types`)
      : (String(c.task_type || '').trim() ? [String(c.task_type).trim()] : []);
    return {
      ...c,
      name: caseName,
      description: caseDesc,
      checkpoints,
      files,
      skipHTMLVisualScore: c.skip_html_visual_score === true,
      level1Type: String(c.level1_type || '').trim(),
      level2Type: String(c.level2_type || '').trim(),
      taskTypes,
      difficulty: String(c.difficulty || '').trim(),
    };
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
        cases.push({
          name: c.name,
          description: c.description,
          checkpoints,
          file_ids: fileIds,
          mcp_ids: [],
          skill_ids: [],
          level1_type: c.level1Type,
          level2_type: c.level2Type,
          task_types: c.taskTypes,
          difficulty: c.difficulty,
          skip_html_visual_score: c.skipHTMLVisualScore,
        });
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
        level1_type: '信息处理类',
        level2_type: '文档摘要总结',
        task_types: ['多步', '多轮交互'],
        difficulty: '中',
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
        level1_type: '信息处理类',
        level2_type: '信息生成',
        task_types: ['单步'],
        difficulty: '易',
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
    { name: 'README.md', data: '# WorkEval 用例集导入格式\n\nZIP 根目录必须包含 `manifest.json`。\n\n`manifest.json` 字段：\n- `name`: 用例集名称\n- `description`: 用例集描述\n- `cases[]`: 用例数组\n  - `name`: 用例名称\n  - `description`: 下发给被测 agent 的任务描述，支持 Markdown 文本\n  - `level1_type` / `level2_type`: 可选，须取自前端级联词表（一级决定二级可选值）\n  - `task_types`: 可选字符串数组（可多选：单步/多步/条件分支/多轮交互/并发协作/长程任务）\n  - `difficulty`: 可选自由文本\n  - `checkpoints`: 数组，每项是一条评测校验点，两种写法都支持：\n    - 纯字符串：仅文本描述，无参考文件\n    - `{description, files}` 对象：`files` 为字符串数组，指向 ZIP 内该校验点的参考文件路径（如标准答案、评分参考图、规范文档），仅评测阶段可见，被测系统永远不会收到\n  - `files`: 字符串数组，指向 ZIP 内附件路径，例如 `files/sales.csv`（用例级输入文件，测试与评测阶段都可见）\n  - `skip_html_visual_score`: 布尔值，可选，默认 false。true 表示该用例测试产物中的 HTML 文件不转图片、不评测视觉美观度，仅按任务描述/校验点评估其它维度\n' },
    { name: 'files/sales.csv', data: 'region,product,orders,revenue\n华东,A商品,120,36000\n华东,B商品,86,25800\n华东,C商品,61,18300\n华东,D商品,33,9900\n' },
    { name: 'files/feedback.txt', data: '用户反馈：\n1. 导出报表速度较慢，集中在月末高峰。\n2. 部分图表字段解释不清晰。\n3. 移动端查看表格时横向滚动体验较差。\n' },
    { name: 'files/gold_report.md', data: '# 标准答案（评测参考）\n\n本周华东区销售额 90,000 元，订单量 300 单，客单价 300 元。\nTop 3 商品：A商品、B商品、C商品。\n' },
  ], 'workeval-caseset-import-template.zip');
}

async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}
function safeExportFilename(name: string, fallback: string): string {
  const cleaned = name.split('/').pop()?.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || fallback;
}
async function exportCaseSetZip(cs: CaseSet): Promise<void> {
  const cases = cs.cases || [];
  if (cases.length === 0) { toast('用例集为空，暂无可导出内容'); return; }
  toast('正在打包用例集 ZIP…');
  const files: { name: string; data: Uint8Array | string }[] = [];
  const usedPaths = new Set<string>();
  const manifestCases: { name: string; description: string; checkpoints: CheckpointImportItem[]; files: string[]; skip_html_visual_score: boolean; level1_type: string; level2_type: string; task_types: string[]; difficulty: string }[] = [];
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
      skip_html_visual_score: !!c.skip_html_visual_score,
      level1_type: c.level1_type || '',
      level2_type: c.level2_type || '',
      task_types: Array.isArray(c.task_types) ? [...c.task_types] : [],
      difficulty: c.difficulty || '',
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

async function openCaseSetDetail(id: string): Promise<void> {
  state.caseSetId = id;
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
  crumbs.innerHTML = `<a href="#" data-view-link="casesets" class="link-inline" style="color:var(--quiet)">用例集</a> / <b>${escapeHtml(cs.name)}</b>`;
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
  renderCaseSetTagStats(cases);
  const wrap = document.getElementById('csd-case-list')!;
  const [mcpConfigsForLabels, skillConfigsForLabels] = await Promise.all([loadMCPConfigs(), loadSkillConfigs()]).catch(() => [[], []] as [MCPConfig[], SkillConfig[]]);
  const mcpNameOf = (id: string) => mcpConfigsForLabels.find(m => m.id === id)?.name || id;
  const skillNameOf = (id: string) => skillConfigsForLabels.find(sk => sk.id === id)?.name || id;
  wrap.innerHTML = cases.length === 0 ? emptyStateHtml('用例集为空', '') : cases.map((c, i) => {
    const fileIds = Array.isArray(c.file_ids) ? c.file_ids : [];
    const checkpoints = Array.isArray(c.checkpoints) ? c.checkpoints : [];
    const mcpIds = Array.isArray(c.mcp_ids) ? c.mcp_ids : [];
    const skillIds = Array.isArray(c.skill_ids) ? c.skill_ids : [];
    const taskTypes = Array.isArray(c.task_types) ? c.task_types.filter(Boolean) : [];
    const hierarchy = [c.level1_type, c.level2_type].filter(Boolean) as string[];
    const groups: string[] = [];
    if (hierarchy.length) {
      groups.push(`<div class="case-label-group is-cat">
        <span class="case-label-k">分类</span>
        <span class="case-label-path">${hierarchy.map(escapeHtml).join('<span class="case-label-slash">/</span>')}</span>
      </div>`);
    }
    if (taskTypes.length) {
      groups.push(`<div class="case-label-group is-task">
        <span class="case-label-k">task</span>
        <span class="case-label-chips">${taskTypes.map(t => `<span class="case-label-chip">${escapeHtml(t)}</span>`).join('')}</span>
      </div>`);
    }
    if (c.difficulty) {
      groups.push(`<div class="case-label-group is-diff">
        <span class="case-label-k">难度</span>
        <span class="case-label-chip is-diff">${escapeHtml(c.difficulty)}</span>
      </div>`);
    }
    const dataLabelsHtml = groups.length === 0 ? '' : `<div class="case-label-bar">${groups.join('')}</div>`;
    return `
    <div style="padding:16px 18px;border-top:${i === 0 ? 'none' : '1px solid var(--line)'};animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 40}ms">
      <div class="flex-between" style="margin-bottom:8px;">
        <div class="flex gap-8" style="align-items:center;">
          <span class="case-idx mono">#${String(c.order_no).padStart(2, '0')}</span>
          <span class="case-name" style="font-size:14px;">${escapeHtml(c.name)}</span>
        </div>
        <span class="row-sub">${fileIds.length} 个关联文件</span>
      </div>
      ${dataLabelsHtml}
      <p style="font-size:13px;color:var(--steel);margin-bottom:10px;">${escapeHtml(c.description)}</p>
      <div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:10px;">
        ${fileIds.map(fid => `<a class="chip" href="${escapeAttr(filesApi.downloadUrl(fid))}" target="_blank" rel="noopener">
          <span class="mono">▢</span> ${escapeHtml(fid)}
        </a>`).join('')}
      </div>
      ${(mcpIds.length > 0 || skillIds.length > 0 || c.skip_html_visual_score) ? `<div class="flex gap-8" style="flex-wrap:wrap;margin-bottom:10px;">
        ${mcpIds.map(id => `<span class="chip active" title="MCP 服务器">⚙ ${escapeHtml(mcpNameOf(id))}</span>`).join('')}
        ${skillIds.map(id => `<span class="chip active" title="Skill">✦ ${escapeHtml(skillNameOf(id))}</span>`).join('')}
        ${c.skip_html_visual_score ? `<span class="chip" title="该用例测试产物中的 HTML 文件不转图片、不评测视觉美观度，仅按任务描述与校验点评估其它维度">⏭ HTML 视觉评测已跳过</span>` : ''}
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

function countByTag(cases: CaseItem[], getter: (c: CaseItem) => string | undefined): { name: string; count: number }[] {
  const map = new Map<string, number>();
  for (const c of cases) {
    const raw = (getter(c) || '').trim();
    const key = raw || '未标注';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

function countByTagMulti(cases: CaseItem[], getter: (c: CaseItem) => string[] | undefined): { name: string; count: number }[] {
  const map = new Map<string, number>();
  let empty = 0;
  for (const c of cases) {
    const vals = (getter(c) || []).map(v => v.trim()).filter(Boolean);
    if (vals.length === 0) { empty++; continue; }
    for (const v of vals) map.set(v, (map.get(v) || 0) + 1);
  }
  const rows = [...map.entries()].map(([name, count]) => ({ name, count }));
  if (empty > 0) rows.push({ name: '未标注', count: empty });
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

function renderCaseSetTagStats(cases: CaseItem[]): void {
  const sub = document.getElementById('csd-tag-stats-sub')!;
  const wrap = document.getElementById('csd-tag-stats')!;
  if (cases.length === 0) {
    sub.textContent = '';
    wrap.innerHTML = emptyStateHtml('暂无用例', '添加用例并填写数据标签后，这里会按维度汇总。');
    return;
  }
  sub.textContent = `${cases.length} 条`;
  const dims: { title: string; rows: { name: string; count: number }[] }[] = [
    { title: '一级类型', rows: countByTag(cases, c => c.level1_type) },
    { title: '二级类型', rows: countByTag(cases, c => c.level2_type) },
    { title: 'task类型', rows: countByTagMulti(cases, c => c.task_types) },
    { title: '难度', rows: countByTag(cases, c => c.difficulty) },
  ];
  const total = cases.length;
  wrap.innerHTML = dims.map(dim => `
    <div class="tag-stat-block">
      <div class="tag-stat-title">${escapeHtml(dim.title)}</div>
      ${dim.rows.map(r => {
        const pct = Math.min(100, Math.round((r.count / total) * 100));
        return `<div class="tag-stat-row" title="${escapeAttr(r.name)}：${r.count}（${pct}%）">
          <div class="tag-stat-name">${escapeHtml(r.name)}</div>
          <div class="tag-stat-bar"><div class="tag-stat-fill" style="width:${pct}%"></div></div>
          <div class="tag-stat-count">${r.count}</div>
        </div>`;
      }).join('')}
    </div>`).join('');
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
  taskTypes: string[];
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

function fillLevel1Select(sel: HTMLSelectElement, selected = ''): void {
  sel.innerHTML = `<option value="">请选择</option>` +
    CASE_LEVEL1_OPTIONS.map(v => `<option value="${escapeAttr(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

function fillLevel2Select(sel: HTMLSelectElement, level1: string, selected = ''): void {
  const opts = level2OptionsOf(level1);
  if (!level1 || opts.length === 0) {
    sel.innerHTML = `<option value="">请先选一级类型</option>`;
    sel.disabled = true;
    return;
  }
  const known = opts.includes(selected) ? selected : '';
  sel.disabled = false;
  sel.innerHTML = `<option value="">请选择</option>` +
    opts.map(v => `<option value="${escapeAttr(v)}"${v === known ? ' selected' : ''}>${escapeHtml(v)}</option>`).join('');
}

function wireCaseLevelSelects(card: HTMLElement, prefill?: CaseItem): void {
  const level1 = card.querySelector('.cs-case-level1') as HTMLSelectElement;
  const level2 = card.querySelector('.cs-case-level2') as HTMLSelectElement;
  fillLevel1Select(level1, prefill?.level1_type || '');
  fillLevel2Select(level2, level1.value, prefill?.level2_type || '');
  level1.addEventListener('change', () => fillLevel2Select(level2, level1.value));
}

function renderCaseTaskTypeChips(row: CaseEditorRow): void {
  const wrap = row.card.querySelector('.cs-case-task-types') as HTMLElement;
  wrap.innerHTML = CASE_TASK_TYPE_OPTIONS.map(v =>
    `<span class="chip${row.taskTypes.includes(v) ? ' active' : ''}" data-task-type-toggle="${escapeAttr(v)}">${escapeHtml(v)}</span>`
  ).join('');
  wrap.querySelectorAll('[data-task-type-toggle]').forEach(el => el.addEventListener('click', () => {
    const v = el.getAttribute('data-task-type-toggle')!;
    const idx = row.taskTypes.indexOf(v);
    if (idx >= 0) row.taskTypes.splice(idx, 1); else row.taskTypes.push(v);
    el.classList.toggle('active');
  }));
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
    taskTypes: prefill ? [...(prefill.task_types || [])] : [],
    // 默认开启（未设置视为开启）：与后端 skip_html_visual_score 默认 false 的语义一致。
    skipHTMLVisualScore: prefill ? !!prefill.skip_html_visual_score : false,
  };
  csEditorRows.push(row);

  if (prefill) {
    (card.querySelector('.cs-case-name') as HTMLInputElement).value = prefill.name;
    (card.querySelector('.cs-case-difficulty') as HTMLInputElement).value = prefill.difficulty || '';
  }
  wireCaseLevelSelects(card, prefill);
  renderCaseTaskTypeChips(row);
  (card.querySelector('.cs-case-name') as HTMLInputElement).addEventListener('input', () => renderCaseOutline());
  setupRichEditor(card, prefill?.description || '');
  (card.querySelector('.cs-insert-env') as HTMLElement)?.addEventListener('click', () => openInsertEnvModal(card));
  (card.querySelector('.cs-case-description') as HTMLTextAreaElement).addEventListener('input', () => renderCaseOutline());
  renderCheckpointEditor(row);
  renderCaseCardFiles(row);
  renderCaseCardBindings(row);

  const htmlVisualSwitch = card.querySelector('.cs-case-html-visual-switch') as HTMLElement;
  htmlVisualSwitch.classList.toggle('on', !row.skipHTMLVisualScore);
  htmlVisualSwitch.addEventListener('click', () => {
    row.skipHTMLVisualScore = !row.skipHTMLVisualScore;
    htmlVisualSwitch.classList.toggle('on', !row.skipHTMLVisualScore);
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
        level1_type: (row.card.querySelector('.cs-case-level1') as HTMLSelectElement).value.trim(),
        level2_type: (row.card.querySelector('.cs-case-level2') as HTMLSelectElement).value.trim(),
        task_types: [...row.taskTypes],
        difficulty: (row.card.querySelector('.cs-case-difficulty') as HTMLInputElement).value.trim(),
        skip_html_visual_score: row.skipHTMLVisualScore,
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

// ================= ENDPOINTS (config center) =================
async function renderEndpointList(kind: EndpointKind): Promise<void> {
  const wrapId = kind === 'target' ? 'target-endpoint-list' : 'eval-endpoint-list';
  const wrap = document.getElementById(wrapId)!;
  wrap.innerHTML = skeletonRows(3);
  let list: EndpointResponse[];
  try {
    list = kind === 'target' ? await loadTargetEndpoints(true) : await loadEvalEndpoints(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  if (list.length === 0) { wrap.innerHTML = emptyStateHtml('还没有配置端点', '点击右上角新增端点开始配置。'); return; }
  wrap.innerHTML = list.map((e, i) => `
    <div class="row-item" style="grid-template-columns:1.4fr 1.4fr 1fr 100px 90px;animation-delay:${i * 30}ms;cursor:default;">
      <div>
        <div class="row-title">${escapeHtml(e.name)}</div>
        <div class="row-sub">${e.id}</div>
      </div>
      <div>
        <div style="font-size:12.5px;">${escapeHtml(e.model_name)}</div>
        <div class="row-sub" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(e.base_url)}</div>
      </div>
      <div class="mono row-sub">${escapeHtml(e.api_key_masked)}</div>
      <div>${e.is_default ? '<span class="badge ok">默认</span>' : '<button class="btn btn-ghost btn-sm" data-set-default="' + e.id + '" data-kind="' + kind + '">设为默认</button>'}</div>
      <div class="flex gap-8">
        <button class="icon-btn" style="width:28px;height:28px;" data-edit-ep="${e.id}" data-kind="${kind}" title="编辑"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--err);border-color:var(--err-soft);" data-del-ep="${e.id}" data-kind="${kind}" title="删除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg></button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-set-default]').forEach(el => el.addEventListener('click', async () => {
    const kindAttr = el.getAttribute('data-kind') as EndpointKind;
    const epId = el.getAttribute('data-set-default')!;
    const arr = kindAttr === 'target' ? await loadTargetEndpoints() : await loadEvalEndpoints();
    const ep = arr.find(x => x.id === epId);
    if (!ep) return;
    try {
      const api = kindAttr === 'target' ? targetEndpointsApi : evalEndpointsApi;
      await api.update(epId, { name: ep.name, base_url: ep.base_url, model_name: ep.model_name, api_key: '', is_default: true });
      if (kindAttr === 'target') cache.targetEndpoints = null; else cache.evalEndpoints = null;
      renderEndpointList(kindAttr);
      toast('默认端点已更新');
    } catch (e) {
      toastError('更新失败', e);
    }
  }));
  wrap.querySelectorAll('[data-edit-ep]').forEach(el => el.addEventListener('click', () => openEndpointModal(el.getAttribute('data-kind') as EndpointKind, el.getAttribute('data-edit-ep'))));
  wrap.querySelectorAll('[data-del-ep]').forEach(el => el.addEventListener('click', () => {
    const kind2 = el.getAttribute('data-kind') as EndpointKind, id2 = el.getAttribute('data-del-ep')!;
    confirmAction('删除端点', '删除后使用该端点的历史评测执行记录仍会保留，但无法再用于新的执行。', async () => {
      try {
        const api = kind2 === 'target' ? targetEndpointsApi : evalEndpointsApi;
        await api.remove(id2);
        if (kind2 === 'target') cache.targetEndpoints = null; else cache.evalEndpoints = null;
        renderEndpointList(kind2);
        toast('端点已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}

let epModalKind: EndpointKind = 'target';
let epModalEditId: string | null = null;
document.getElementById('btn-new-target-endpoint')!.addEventListener('click', () => openEndpointModal('target', null));
document.getElementById('btn-new-eval-endpoint')!.addEventListener('click', () => openEndpointModal('eval', null));
async function openEndpointModal(kind: EndpointKind, editId: string | null): Promise<void> {
  epModalKind = kind; epModalEditId = editId;
  const arr = kind === 'target' ? await loadTargetEndpoints() : await loadEvalEndpoints();
  const ep = editId ? arr.find(e => e.id === editId) : null;
  document.getElementById('ep-modal-title')!.textContent = ep ? '编辑端点' : '新增端点';
  document.getElementById('ep-modal-desc')!.textContent = kind === 'target' ? '配置被测 agent 使用的模型接入参数。' : '配置驱动评测 LLM 的模型接入参数。';
  (document.getElementById('ep-name') as HTMLInputElement).value = ep ? ep.name : '';
  (document.getElementById('ep-baseurl') as HTMLInputElement).value = ep ? ep.base_url : '';
  (document.getElementById('ep-model') as HTMLInputElement).value = ep ? ep.model_name : '';
  const apikeyInput = document.getElementById('ep-apikey') as HTMLInputElement;
  apikeyInput.value = '';
  apikeyInput.placeholder = ep ? '留空则保留原值' : 'sk-xxxxxxxxxxxx';
  document.getElementById('ep-default-switch')!.classList.toggle('on', ep ? ep.is_default : false);
  openModal('modal-endpoint');
}
document.getElementById('ep-default-switch')!.addEventListener('click', (e) => (e.currentTarget as HTMLElement).classList.toggle('on'));
document.getElementById('ep-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('ep-submit') as HTMLButtonElement;
  const name = (document.getElementById('ep-name') as HTMLInputElement).value.trim();
  const baseUrl = (document.getElementById('ep-baseurl') as HTMLInputElement).value.trim();
  const model = (document.getElementById('ep-model') as HTMLInputElement).value.trim();
  const apiKey = (document.getElementById('ep-apikey') as HTMLInputElement).value.trim();
  if (!name || !baseUrl || !model) { toast('请完整填写名称 / Base URL / 模型名称'); return; }
  if (!epModalEditId && !apiKey) { toast('新增端点需填写 API Key'); return; }
  const isDefault = document.getElementById('ep-default-switch')!.classList.contains('on');
  btn.disabled = true;
  try {
    const api = epModalKind === 'target' ? targetEndpointsApi : evalEndpointsApi;
    const body = { name, base_url: baseUrl, model_name: model, api_key: apiKey, is_default: isDefault };
    if (epModalEditId) await api.update(epModalEditId, body);
    else await api.create(body);
    if (epModalKind === 'target') cache.targetEndpoints = null; else cache.evalEndpoints = null;
    closeModal('modal-endpoint');
    renderEndpointList(epModalKind);
    toast(epModalEditId ? '端点已更新' : '端点已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= PROMPTS =================
async function renderPromptGrid(): Promise<void> {
  const wrap = document.getElementById('prompt-grid')!;
  wrap.innerHTML = skeletonRows(3, 160);
  let prompts: EvalPrompt[];
  try {
    prompts = await loadPrompts(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  wrap.innerHTML = prompts.map((p, i) => `
    <div class="panel" style="animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 50}ms">
      <div class="panel-head">
        <h3>${escapeHtml(p.name)}</h3>
        ${p.is_default ? '<span class="badge ok">默认</span>' : `<button class="btn btn-ghost btn-sm" data-set-default-prompt="${p.id}">设为默认</button>`}
      </div>
      <div class="panel-body pad">
        <p class="mono" style="font-size:12px;color:var(--quiet);white-space:pre-wrap;max-height:120px;overflow:hidden;line-height:1.7;margin-bottom:12px;">${escapeHtml(p.content.slice(0, 220))}${p.content.length > 220 ? '…' : ''}</p>
        <div class="flex gap-8">
          <button class="btn btn-ghost btn-sm" data-edit-prompt="${p.id}">编辑</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--err);border-color:var(--err-soft);" data-del-prompt="${p.id}">删除</button>
        </div>
      </div>
    </div>
  `).join('') || emptyStateHtml('还没有 Prompt', '点击右上角新建 Prompt。');
  wrap.querySelectorAll('[data-set-default-prompt]').forEach(el => el.addEventListener('click', async () => {
    const id = el.getAttribute('data-set-default-prompt')!;
    const p = prompts.find(x => x.id === id);
    if (!p) return;
    try {
      await promptsApi.update(id, { name: p.name, content: p.content, is_default: true });
      cache.prompts = null;
      renderPromptGrid();
      toast('默认 Prompt 已更新');
    } catch (e) {
      toastError('更新失败', e);
    }
  }));
  wrap.querySelectorAll('[data-edit-prompt]').forEach(el => el.addEventListener('click', () => openPromptModal(el.getAttribute('data-edit-prompt'))));
  wrap.querySelectorAll('[data-del-prompt]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-prompt')!;
    confirmAction('删除 Prompt', '已引用该 Prompt 的历史评测执行不受影响（内容已快照）。', async () => {
      try {
        await promptsApi.remove(id);
        cache.prompts = null;
        renderPromptGrid();
        toast('Prompt 已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}
let promptEditId: string | null = null;
document.getElementById('btn-new-prompt')!.addEventListener('click', () => openPromptModal(null));
async function openPromptModal(editId: string | null): Promise<void> {
  promptEditId = editId;
  const prompts = editId ? await loadPrompts() : [];
  const p = editId ? prompts.find(x => x.id === editId) : null;
  document.getElementById('pm-modal-title')!.textContent = p ? '编辑 Prompt' : '新建 Prompt';
  (document.getElementById('pm-name') as HTMLInputElement).value = p ? p.name : '';
  (document.getElementById('pm-content') as HTMLTextAreaElement).value = p ? p.content : '';
  document.getElementById('pm-default-switch')!.classList.toggle('on', p ? p.is_default : false);
  openModal('modal-prompt');
}
document.getElementById('pm-default-switch')!.addEventListener('click', (e) => (e.currentTarget as HTMLElement).classList.toggle('on'));
document.getElementById('pm-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('pm-submit') as HTMLButtonElement;
  const name = (document.getElementById('pm-name') as HTMLInputElement).value.trim();
  const content = (document.getElementById('pm-content') as HTMLTextAreaElement).value.trim();
  if (!name || !content) { toast('请填写名称与内容'); return; }
  const isDefault = document.getElementById('pm-default-switch')!.classList.contains('on');
  btn.disabled = true;
  try {
    if (promptEditId) await promptsApi.update(promptEditId, { name, content, is_default: isDefault });
    else await promptsApi.create({ name, content, is_default: isDefault });
    cache.prompts = null;
    closeModal('modal-prompt');
    renderPromptGrid();
    toast(promptEditId ? 'Prompt 已更新' : 'Prompt 已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= MCP SERVERS (config center) =================
async function renderMCPConfigList(): Promise<void> {
  const wrap = document.getElementById('mcp-config-list')!;
  wrap.innerHTML = skeletonRows(3);
  let list: MCPConfig[];
  try {
    list = await loadMCPConfigs(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  if (list.length === 0) { wrap.innerHTML = emptyStateHtml('还没有配置 MCP 服务器', '点击右上角新增，供用例编排时勾选绑定。'); return; }
  wrap.innerHTML = list.map((m, i) => `
    <div class="row-item" style="grid-template-columns:1.2fr 2fr 90px;animation-delay:${i * 30}ms;cursor:default;">
      <div>
        <div class="row-title">${escapeHtml(m.name)}</div>
        <div class="row-sub">${escapeHtml(m.description || '--')}</div>
      </div>
      <div class="mono row-sub" style="max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(m.config_json)}</div>
      <div class="flex gap-8">
        <button class="icon-btn" style="width:28px;height:28px;" data-edit-mcp="${m.id}" title="编辑"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--err);border-color:var(--err-soft);" data-del-mcp="${m.id}" title="删除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg></button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-edit-mcp]').forEach(el => el.addEventListener('click', () => openMCPConfigModal(el.getAttribute('data-edit-mcp'))));
  wrap.querySelectorAll('[data-del-mcp]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-mcp')!;
    confirmAction('删除 MCP 服务器', '已被用例绑定的引用会在下次派发测试任务时被静默跳过，不影响用例本身。', async () => {
      try {
        await mcpConfigsApi.remove(id);
        cache.mcpConfigs = null;
        renderMCPConfigList();
        toast('MCP 服务器已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}
let mcpConfigEditId: string | null = null;
document.getElementById('btn-new-mcp-config')!.addEventListener('click', () => openMCPConfigModal(null));
async function openMCPConfigModal(editId: string | null): Promise<void> {
  mcpConfigEditId = editId;
  const list = editId ? await loadMCPConfigs() : [];
  const m = editId ? list.find(x => x.id === editId) : null;
  document.getElementById('mcp-modal-title')!.textContent = m ? '编辑 MCP 服务器' : '新增 MCP 服务器';
  (document.getElementById('mcp-name') as HTMLInputElement).value = m ? m.name : '';
  (document.getElementById('mcp-desc') as HTMLInputElement).value = m ? m.description : '';
  (document.getElementById('mcp-config-json') as HTMLTextAreaElement).value = m ? m.config_json : '';
  openModal('modal-mcp-config');
}
document.getElementById('mcp-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('mcp-submit') as HTMLButtonElement;
  const name = (document.getElementById('mcp-name') as HTMLInputElement).value.trim();
  const description = (document.getElementById('mcp-desc') as HTMLInputElement).value.trim();
  const configJson = (document.getElementById('mcp-config-json') as HTMLTextAreaElement).value.trim();
  if (!name || !configJson) { toast('请填写名称与 config_json'); return; }
  try {
    JSON.parse(configJson);
  } catch {
    toast('config_json 不是合法的 JSON');
    return;
  }
  btn.disabled = true;
  try {
    const body = { name, description, config_json: configJson };
    if (mcpConfigEditId) await mcpConfigsApi.update(mcpConfigEditId, body);
    else await mcpConfigsApi.create(body);
    cache.mcpConfigs = null;
    closeModal('modal-mcp-config');
    renderMCPConfigList();
    toast(mcpConfigEditId ? 'MCP 服务器已更新' : 'MCP 服务器已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= SKILLS (config center) =================
// extra_files 在编辑器里表示为一行一条的 "相对路径=内容" 文本，内容中的换行以字面 "\n" 转义，
// 避免多行文本框里同时编辑多个文件时互相污染彼此的换行结构。
function encodeExtraFilesText(files: Record<string, string>): string {
  return Object.entries(files).map(([p, c]) => `${p}=${c.replace(/\n/g, '\\n')}`).join('\n');
}
function decodeExtraFilesText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  text.split('\n').map(line => line.trim()).filter(Boolean).forEach(line => {
    const idx = line.indexOf('=');
    if (idx <= 0) return;
    const relPath = line.slice(0, idx).trim();
    const content = line.slice(idx + 1).replace(/\\n/g, '\n');
    if (relPath) out[relPath] = content;
  });
  return out;
}

async function renderSkillConfigGrid(): Promise<void> {
  const wrap = document.getElementById('skill-config-grid')!;
  wrap.innerHTML = skeletonRows(3, 160);
  let list: SkillConfig[];
  try {
    list = await loadSkillConfigs(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  wrap.innerHTML = list.map((sk, i) => {
    const extraCount = Object.keys(sk.extra_files || {}).length;
    return `
    <div class="panel" style="animation:fadeUp .4s cubic-bezier(.16,1,.3,1) backwards;animation-delay:${i * 50}ms">
      <div class="panel-head">
        <h3>${escapeHtml(sk.name)}</h3>
        <span class="row-sub">${extraCount > 0 ? `${extraCount} 个附加文件` : ''}</span>
      </div>
      <div class="panel-body pad">
        <p class="row-sub" style="margin-bottom:8px;">${escapeHtml(sk.description || '--')}</p>
        <p class="mono" style="font-size:12px;color:var(--quiet);white-space:pre-wrap;max-height:120px;overflow:hidden;line-height:1.7;margin-bottom:12px;">${escapeHtml(sk.content_md.slice(0, 220))}${sk.content_md.length > 220 ? '…' : ''}</p>
        <div class="flex gap-8">
          <button class="btn btn-ghost btn-sm" data-edit-skill="${sk.id}">编辑</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--err);border-color:var(--err-soft);" data-del-skill="${sk.id}">删除</button>
        </div>
      </div>
    </div>
  `;
  }).join('') || emptyStateHtml('还没有 Skill', '点击右上角新增，供用例编排时勾选绑定。');
  wrap.querySelectorAll('[data-edit-skill]').forEach(el => el.addEventListener('click', () => openSkillConfigModal(el.getAttribute('data-edit-skill'))));
  wrap.querySelectorAll('[data-del-skill]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-skill')!;
    confirmAction('删除 Skill', '已被用例绑定的引用会在下次派发测试任务时被静默跳过，不影响用例本身。', async () => {
      try {
        await skillConfigsApi.remove(id);
        cache.skillConfigs = null;
        renderSkillConfigGrid();
        toast('Skill 已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}
let skillConfigEditId: string | null = null;
document.getElementById('btn-new-skill-config')!.addEventListener('click', () => openSkillConfigModal(null));
async function openSkillConfigModal(editId: string | null): Promise<void> {
  skillConfigEditId = editId;
  const list = editId ? await loadSkillConfigs() : [];
  const sk = editId ? list.find(x => x.id === editId) : null;
  document.getElementById('skill-modal-title')!.textContent = sk ? '编辑 Skill' : '新增 Skill';
  (document.getElementById('skill-name') as HTMLInputElement).value = sk ? sk.name : '';
  (document.getElementById('skill-desc') as HTMLInputElement).value = sk ? sk.description : '';
  (document.getElementById('skill-content-md') as HTMLTextAreaElement).value = sk ? sk.content_md : '';
  (document.getElementById('skill-extra-files') as HTMLTextAreaElement).value = sk ? encodeExtraFilesText(sk.extra_files || {}) : '';
  openModal('modal-skill-config');
}
document.getElementById('skill-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('skill-submit') as HTMLButtonElement;
  const name = (document.getElementById('skill-name') as HTMLInputElement).value.trim();
  const description = (document.getElementById('skill-desc') as HTMLInputElement).value.trim();
  const contentMd = (document.getElementById('skill-content-md') as HTMLTextAreaElement).value.trim();
  const extraFiles = decodeExtraFilesText((document.getElementById('skill-extra-files') as HTMLTextAreaElement).value);
  if (!name || !contentMd) { toast('请填写名称与 SKILL.md 内容'); return; }
  btn.disabled = true;
  try {
    const body = { name, description, content_md: contentMd, extra_files: extraFiles };
    if (skillConfigEditId) await skillConfigsApi.update(skillConfigEditId, body);
    else await skillConfigsApi.create(body);
    cache.skillConfigs = null;
    closeModal('modal-skill-config');
    renderSkillConfigGrid();
    toast(skillConfigEditId ? 'Skill 已更新' : 'Skill 已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

// ================= ENV VARS (config center) =================
async function renderEnvVarList(): Promise<void> {
  const wrap = document.getElementById('env-var-list')!;
  wrap.innerHTML = skeletonRows(3);
  let list: EnvVar[];
  try {
    list = await loadEnvVars(true);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  if (list.length === 0) {
    wrap.innerHTML = emptyStateHtml('还没有环境变量', '点击右上角新增。用例描述可用 {{KEY}} 引用，派发时替换为真实 Value。');
    return;
  }
  wrap.innerHTML = list.map((ev, i) => `
    <div class="row-item" style="grid-template-columns:1.2fr 1.2fr 1.4fr 90px;animation-delay:${i * 30}ms;cursor:default;">
      <div class="row-title mono">{{${escapeHtml(ev.key)}}}</div>
      <div class="mono row-sub">${escapeHtml(ev.value_masked || '****')}</div>
      <div class="row-sub">${escapeHtml(ev.description || '--')}</div>
      <div class="flex gap-8">
        <button class="icon-btn" style="width:28px;height:28px;" data-edit-env="${ev.id}" title="编辑"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
        <button class="icon-btn" style="width:28px;height:28px;color:var(--err);border-color:var(--err-soft);" data-del-env="${ev.id}" title="删除"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg></button>
      </div>
    </div>
  `).join('');
  wrap.querySelectorAll('[data-edit-env]').forEach(el => el.addEventListener('click', () => openEnvVarModal(el.getAttribute('data-edit-env'))));
  wrap.querySelectorAll('[data-del-env]').forEach(el => el.addEventListener('click', () => {
    const id = el.getAttribute('data-del-env')!;
    confirmAction('删除环境变量', '若用例描述仍引用该 Key，下次派发测试任务会失败并提示未定义。', async () => {
      try {
        await envVarsApi.remove(id);
        cache.envVars = null;
        renderEnvVarList();
        toast('环境变量已删除');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  }));
}

let envVarEditId: string | null = null;
let insertEnvTargetCard: HTMLElement | null = null;
document.getElementById('btn-new-env-var')!.addEventListener('click', () => openEnvVarModal(null));

async function openEnvVarModal(editId: string | null): Promise<void> {
  envVarEditId = editId;
  const list = editId ? await loadEnvVars() : [];
  const ev = editId ? list.find(x => x.id === editId) : null;
  document.getElementById('env-modal-title')!.textContent = ev ? '编辑环境变量' : '新增环境变量';
  (document.getElementById('env-key') as HTMLInputElement).value = ev ? ev.key : '';
  (document.getElementById('env-value') as HTMLInputElement).value = '';
  (document.getElementById('env-desc') as HTMLInputElement).value = ev ? ev.description : '';
  openModal('modal-env-var');
}

document.getElementById('env-submit')!.addEventListener('click', async () => {
  const btn = document.getElementById('env-submit') as HTMLButtonElement;
  const key = (document.getElementById('env-key') as HTMLInputElement).value.trim();
  const value = (document.getElementById('env-value') as HTMLInputElement).value;
  const description = (document.getElementById('env-desc') as HTMLInputElement).value.trim();
  if (!key) { toast('请填写 Key'); return; }
  if (!envVarEditId && !value.trim()) { toast('请填写 Value'); return; }
  btn.disabled = true;
  try {
    const body = { key, value, description };
    if (envVarEditId) await envVarsApi.update(envVarEditId, body);
    else await envVarsApi.create(body);
    cache.envVars = null;
    closeModal('modal-env-var');
    renderEnvVarList();
    toast(envVarEditId ? '环境变量已更新' : '环境变量已创建');
  } catch (e) {
    toastError('保存失败', e);
  } finally {
    btn.disabled = false;
  }
});

async function openInsertEnvModal(card: HTMLElement): Promise<void> {
  insertEnvTargetCard = card;
  const wrap = document.getElementById('insert-env-list')!;
  wrap.innerHTML = '<span class="muted" style="font-size:12px;">加载中…</span>';
  openModal('modal-insert-env');
  try {
    const list = await loadEnvVars(true);
    if (list.length === 0) {
      wrap.innerHTML = emptyStateHtml('暂无环境变量', '请先到配置中心 → 环境变量中新增。');
      return;
    }
    wrap.innerHTML = list.map(ev =>
      `<span class="chip" data-insert-env-key="${escapeAttr(ev.key)}" title="${escapeAttr(ev.description || ev.value_masked)}">{{${escapeHtml(ev.key)}}}</span>`
    ).join('');
    wrap.querySelectorAll('[data-insert-env-key]').forEach(el => el.addEventListener('click', () => {
      const key = el.getAttribute('data-insert-env-key')!;
      const ta = insertEnvTargetCard?.querySelector('.cs-case-description') as HTMLTextAreaElement | null;
      if (ta) insertAtCursor(ta, `{{${key}}}`);
      closeModal('modal-insert-env');
      toast(`已插入 {{${key}}}`);
    }));
  } catch (e) {
    wrap.innerHTML = errorStateHtml(errMsg(e));
  }
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
type DrawerDownload = { url: string; filename?: string; revoke?: boolean } | null;
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
function openDrawer(title: string, sub: string, bodyHtml: string, iconType?: string, download?: string | DrawerDownload, options?: { pushHistory?: boolean; onRestoreCurrent?: () => void; preserveHistory?: boolean }): void {
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
function closeDrawer(): void {
  overlay.classList.remove('open'); drawer.classList.remove('open');
  revokeDrawerDownload(currentDownload);
  drawerHistory.forEach(s => revokeDrawerDownload(s.download));
  currentDownload = null;
  drawerHistory = [];
  refreshDrawerBackButton();
}
function loadingDrawerBody(): string {
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

function iconTypeOf(name: string): string {
  const ext = name.split('.').pop()!.toLowerCase();
  if (ext === 'jsonl') return 'jsonl';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['pptx', 'docx', 'xlsx', 'pdf', 'zip'].includes(ext)) return ext;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (['txt', 'log', 'csv', 'tsv', 'xml', 'yaml', 'yml'].includes(ext)) return 'text';
  return 'json';
}

function mimeTypeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    txt: 'text/plain;charset=utf-8',
    log: 'text/plain;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
    tsv: 'text/tab-separated-values;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    html: 'text/html;charset=utf-8',
    htm: 'text/html;charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

function downloadConfigForMember(member: TarMember): { url: string; filename: string; revoke: boolean } {
  const blob = new Blob([member.data as BlobPart], { type: mimeTypeOf(member.name) });
  return { url: URL.createObjectURL(blob), filename: member.name.split('/').pop() || member.name, revoke: true };
}

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

// ---- Artifacts drawer: 展示测试/评测阶段各自的 output.tar.gz，点开后解压显示内部文件树 ----
async function openArtifactsDrawer(run: EvalRun, ceId: string): Promise<void> {
  const ce = (run.case_executions || []).find(c => c.id === ceId);
  if (!ce) return;
  openDrawer('产物', ce.case_name, loadingDrawerBody(), 'json');

  const stages: { label: string; taskId?: string }[] = [
    { label: '测试阶段（被测系统执行结果）', taskId: ce.test_task_id },
    { label: '评测阶段（评测 LLM 分析报告）', taskId: ce.eval_task_id },
  ].filter(s => !!s.taskId);

  if (stages.length === 0) {
    document.getElementById('drawer-body')!.innerHTML = emptyStateHtml('暂无关联任务', '该用例尚未派发测试任务。');
    return;
  }

  const sections: string[] = [];
  for (const stage of stages) {
    try {
      const artifacts = await filesApi.listArtifacts(stage.taskId!);
      if (artifacts.length === 0) {
        sections.push(`<div class="section-title">${escapeHtml(stage.label)}</div><p class="muted" style="padding:0 18px 10px;font-size:12.5px;">尚未上传产物（任务可能仍在执行或未产出任何文件）。</p>`);
        continue;
      }
      sections.push(`<div class="section-title">${escapeHtml(stage.label)}</div>
        <div class="file-tree">
          ${artifacts.map(a => `<div class="file-row" data-open-tar="${a.file_id}|${escapeAttr(a.filename)}">
            ${fileRowIcon('json')}
            <span class="fname">${escapeHtml(a.filename)}</span>
            <span class="fsize mono">${fmtSize(a.size)}</span>
          </div>`).join('')}
        </div>`);
    } catch (e) {
      sections.push(`<div class="section-title">${escapeHtml(stage.label)}</div><p style="padding:0 18px 10px;font-size:12.5px;color:var(--err);">加载失败：${escapeHtml(errMsg(e))}</p>`);
    }
  }
  document.getElementById('drawer-body')!.innerHTML = sections.join('');
  document.getElementById('drawer-body')!.querySelectorAll('[data-open-tar]').forEach(el => {
    el.addEventListener('click', () => {
      const [fileId, filename] = el.getAttribute('data-open-tar')!.split('|');
      openTarFileList(fileId, filename, ce.case_name);
    });
  });
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

function isInternalArtifactMember(name: string): boolean {
  return name.split('/').some(part => part.startsWith('.') && part.length > 1);
}

/** 解压某个 tar.gz 文件并展示内部文件列表；点击其中文件项进入文本/图片预览。 */
async function openTarFileList(fileId: string, tarFilename: string, subtitle: string): Promise<void> {
  openDrawer(tarFilename, `${subtitle} · 解压中…`, loadingDrawerBody(), 'json', filesApi.downloadUrl(fileId));
  let members: TarMember[];
  try {
    const blob = await filesApi.downloadBlob(fileId);
    members = await extractTarGz(blob);
  } catch (e) {
    document.getElementById('drawer-body')!.innerHTML = errorStateHtml(errMsg(e));
    return;
  }
  const visibleMembers = members.filter(m => !isInternalArtifactMember(m.name));
  const hiddenCount = members.length - visibleMembers.length;
  document.getElementById('drawer-sub')!.textContent = hiddenCount > 0
    ? `${subtitle} · ${visibleMembers.length} 个文件 · 已隐藏 ${hiddenCount} 个内部文件`
    : `${subtitle} · ${visibleMembers.length} 个文件`;
  if (visibleMembers.length === 0) {
    document.getElementById('drawer-body')!.innerHTML = members.length === 0
      ? emptyStateHtml('压缩包为空', '')
      : emptyStateHtml('无可展示文件', '已隐藏 . 开头目录或文件下的内部产物。');
    return;
  }
  const html = `<div class="file-tree">
    ${visibleMembers.map((m, i) => `<div class="file-row" data-member-idx="${i}">
      ${fileRowIcon(iconTypeOf(m.name))}
      <span class="fname">${escapeHtml(m.name)}</span>
      <span class="fsize mono">${fmtSize(m.size)}</span>
    </div>`).join('')}
  </div>`;
  const bindMemberClicks = () => {
    document.getElementById('drawer-body')!.querySelectorAll('[data-member-idx]').forEach(el => {
      el.addEventListener('click', () => previewTarMember(visibleMembers[Number(el.getAttribute('data-member-idx'))], tarFilename, bindMemberClicks));
    });
  };
  document.getElementById('drawer-body')!.innerHTML = html;
  bindMemberClicks();
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

/** 粗略判定二进制内容：抽样字节中出现 NUL 或过多不可打印字符即认为不可作为文本预览。 */
function looksBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, Math.min(data.length, 4096));
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.05;
}

// ---- Report drawer ----
function canOpenCaseReport(ce: CaseExecution): boolean {
  return Boolean(ce.report || ce.status === 'ERROR' || ce.message);
}
function openReportDrawer(run: EvalRun, ceId: string): void {
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
async function openTraceDrawer(run: EvalRun, ceId: string): Promise<void> {
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

function renderTraceFromText(filename: string, text: string, drawerOptions?: { pushHistory?: boolean; onRestoreCurrent?: () => void; preserveHistory?: boolean }): void {
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
  openDrawer(filename, `Agent 执行轨迹 · 原始 ${rawEvents.length} 行`, html, 'jsonl', null, drawerOptions);
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

// ---------------- Global search (client-side filter demo) ----------------
document.getElementById('global-search')!.addEventListener('input', (e) => {
  const q = (e.target as HTMLInputElement).value.trim();
  if (!q) return;
});

// ---------------- Init ----------------
renderDashboard();
