/* ============================================================
   WorkEval — App logic
   全部数据通过 task-pilot 后端 REST 接口获取（src/api/*），不含任何 mock 数据。
   ============================================================ */
import './styles.css';
import { evalRunsApi } from '@/api/evalRuns';
import { escapeHtml, emptyStateHtml, errorStateHtml, fmtTime, skeletonRows } from '@/lib/ui';
import { badgeHtml, CASE_STATUS_MAP, RUN_STATUS_MAP } from '@/lib/status';
import { HashRouter, navKeyOf, type AppView } from '@/core/router';
import { bindModalCloseHandlers, errMsg } from '@/core/feedback';
import { loadCaseSets, loadEvalRuns } from '@/core/dataCache';
import { disposeEvalRunCaseTable, initEvalRunPages, openEvalRunDetail, openNewEvalRunModal, openNewEvalRunModalFor, renderEvalRunList, renderLeaderboard } from '@/pages/evalRuns';
import { initCaseSetPages, openCaseSetDetail, renderCaseSetGrid } from '@/pages/caseSets';
import { renderEndpointList, renderMCPConfigList, renderPromptGrid, renderSkillConfigGrid } from '@/pages/config';
import type { CaseSet, EvalRun } from '@/types';

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

// ---------------- Modal helpers ----------------
bindModalCloseHandlers();

// ---------------- Router ----------------
const views = document.querySelectorAll('.view');
const navItems = document.querySelectorAll('.nav-item[data-view]');
const crumbs = document.getElementById('crumbs')!;
const state: { evalRunId: string | null; caseSetId: string | null } = { evalRunId: null, caseSetId: null };
let appRouter: HashRouter;

function showView(name: AppView, crumbHtml?: string): void {
  views.forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  const activeNav = navKeyOf(name);
  navItems.forEach(n => n.classList.toggle('active', n.getAttribute('data-view') === activeNav));
  crumbs.innerHTML = crumbHtml || '<b>概览</b>';
  window.scrollTo(0, 0);
}

navItems.forEach(n => n.addEventListener('click', () => {
  routeTo(n.getAttribute('data-view') as AppView);
}));
document.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLElement>('[data-view-link]');
  if (!link) return;
  e.preventDefault();
  // 使用捕获阶段统一拦截，阻止详情页历史重复绑定的冒泡处理器再次触发路由。
  e.stopImmediatePropagation();
  routeTo(link.getAttribute('data-view-link') as AppView);
  if (link.getAttribute('data-action') === 'new-evalrun') openNewEvalRunModal();
}, true);

function routeTo(view: AppView, param?: string): void {
  appRouter.navigate(view, param);
}

function renderRoute(view: AppView, param?: string): void {
  if (view !== 'evalrun-detail') disposeEvalRunCaseTable();
  switch (view) {
    case 'dashboard': showView('dashboard', '<b>概览</b>'); renderDashboard(); break;
    case 'evalruns': showView('evalruns', '<b>评测执行</b>'); renderEvalRunList(); break;
    case 'evalrun-detail': param ? openEvalRunDetail(param) : routeTo('evalruns'); break;
    case 'casesets': showView('casesets', '<b>用例集</b>'); renderCaseSetGrid(); break;
    case 'caseset-detail': param ? openCaseSetDetail(param) : routeTo('casesets'); break;
    case 'target-endpoints': showView('target-endpoints', '<b>配置中心</b> / 被测模型端点'); renderEndpointList('target'); break;
    case 'eval-endpoints': showView('eval-endpoints', '<b>配置中心</b> / 评测模型端点'); renderEndpointList('eval'); break;
    case 'prompts': showView('prompts', '<b>评测 Prompt</b>'); renderPromptGrid(); break;
    case 'leaderboard': showView('leaderboard', '<b>模型 Leaderboard</b>'); renderLeaderboard('30d'); break;
    case 'mcp-servers': showView('mcp-servers', '<b>配置中心</b> / MCP 服务器'); renderMCPConfigList(); break;
    case 'skills': showView('skills', '<b>配置中心</b> / Skill'); renderSkillConfigGrid(); break;
  }
}

appRouter = new HashRouter(({ view, param }) => renderRoute(view, param));
initEvalRunPages({ routeTo, showView, setCrumbs: html => { crumbs.innerHTML = html; } });
initCaseSetPages({ routeTo, showView, setCrumbs: html => { crumbs.innerHTML = html; }, openNewEvalRunModalFor });

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
  const completedRuns = runs.filter(r => r.status === 'SUCCEEDED').length;
  const totalCases = caseSets.reduce((s, c) => s + (c.cases?.length || 0), 0);
  const finishedCases = reported + errored;
  const completionRate = total ? Math.round((finishedCases / total) * 100) : 0;

  document.getElementById('stat-reported')!.textContent = String(reported);
  document.getElementById('stat-reported-sub')!.textContent = total
    ? `共 ${total} 条用例，${finishedCases} 条已结束，${reported} 条已生成报告`
    : '暂无执行数据，创建评测任务后将在这里展示整体进度';
  document.getElementById('stat-hero-bars')!.innerHTML = runs.slice(0, 7).reverse().map(r => {
    const pct = r.total ? Math.round(((r.reported + r.errored) / r.total) * 100) : 0;
    return `<i style="height:${Math.max(pct, 4)}%"></i>`;
  }).join('') || '<span class="muted" style="font-size:12px;">暂无执行数据</span>';
  document.getElementById('stat-running')!.textContent = String(running);
  document.getElementById('stat-running-foot')!.textContent = running ? `${running} 个执行正在运行` : '当前无运行中的执行';
  document.getElementById('stat-pending')!.textContent = String(pendingRuns);
  document.getElementById('stat-casesets')!.textContent = String(caseSets.length);
  document.getElementById('stat-cases-total')!.textContent = `共 ${totalCases} 条用例资产`;
  document.getElementById('stat-completion-rate')!.textContent = total ? `${completionRate}%` : '--';
  document.getElementById('stat-completion-foot')!.textContent = total
    ? `${completedRuns} 个执行已完成 · ${running} 运行中 · ${pendingRuns} 排队`
    : '完成率按已结束用例 / 总用例计算';

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

// ---------------- Global search (client-side filter demo) ----------------
document.getElementById('global-search')!.addEventListener('input', (e) => {
  const q = (e.target as HTMLInputElement).value.trim();
  if (!q) return;
});

// ---------------- Init ----------------
appRouter.start();
