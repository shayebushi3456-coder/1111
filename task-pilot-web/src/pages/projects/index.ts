/* ============================================================
   项目空间 UI：顶栏项目选择器 + 项目管理页。
   - 顶栏选择器：展示当前项目、下拉切换项目、新建项目、进入项目管理。
   - 项目管理页：项目信息编辑、成员管理（添加/改角色/移除）、删除项目。
   仅项目所有者/平台 admin 可管理，其他角色只读查看。
   ============================================================ */
import { projectsApi } from '@/api/projects';
import { bindModalCloseHandlers, closeModal, confirmAction, openModal, toast, toastError } from '@/core/feedback';
import {
  canManage, getCurrentProject, getCurrentProjectId, getProjects,
  markProjectEntered, onProjectContextChange, onProjectListChange, refreshProjects, requireManage,
  setProjectManageOpener, switchProject,
} from '@/core/project';
import { currentUser, isAdmin } from '@/core/auth';
import type { AppView } from '@/core/router';
import { emptyStateHtml, errorStateHtml, escapeHtml, fmtTime, skeletonRows } from '@/lib/ui';
import type { Project, ProjectMember, ProjectRole, ProjectVisibility, UserSearchItem } from '@/types';

let routeTo: (view: AppView, param?: string) => void = () => {};

/** 新建/编辑项目弹窗当前编辑的项目 id；为 null 表示新建。 */
let editingProjectId: string | null = null;
/** 项目管理页当前正在管理的项目 id（进入该页时锁定，避免中途切换项目导致的错位）。 */
let managedProjectId: string | null = null;
/** 分享弹窗里选中的用户（搜索结果）。 */
let selectedShareUser: UserSearchItem | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
/** 当前管理项目已有成员：user_id → role，用于搜索结果标注。 */
let existingMemberRoles = new Map<string, ProjectRole>();

function initials(name: string): string {
  return (name || 'P').trim().slice(0, 2).toUpperCase();
}

function roleLabel(role: ProjectRole): string {
  const labels: Record<ProjectRole, string> = { owner: '管理', editor: '编辑', viewer: '只读' };
  return labels[role] || role;
}

function visibilityLabel(v: ProjectVisibility | string | undefined): string {
  return v === 'public' ? '公开' : '私有';
}

function visibilityBadge(v: ProjectVisibility | string | undefined): string {
  const label = visibilityLabel(v);
  const cls = v === 'public' ? 'ok' : 'warn';
  return `<span class="badge ${cls}" style="margin-left:6px;">${label}</span>`;
}

// ---------------- 顶栏项目选择器 ----------------

function closeSelector(): void {
  document.getElementById('project-selector')?.classList.remove('open');
}

export function renderProjectSelector(): void {
  const wrap = document.getElementById('project-selector');
  if (!wrap) return;
  const current = getCurrentProject();
  const projects = getProjects();

  const triggerName = current ? escapeHtml(current.name) : (projects.length ? '选择项目' : '暂无项目');
  const items = projects.map(p => `
    <div class="ps-item ${p.id === current?.id ? 'active' : ''}" data-select-project="${escapeHtml(p.id)}">
      <span class="ps-item-name">${escapeHtml(p.name)}${p.is_default ? ' <span class="muted" style="font-size:11px;">默认</span>' : ''}</span>
      ${p.id === current?.id ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l4 4L19 6"/></svg>' : ''}
    </div>`).join('');

  wrap.innerHTML = `
    <button class="project-selector-trigger" id="ps-trigger" type="button">
      <span class="ps-icon">${escapeHtml(initials(current?.name || ''))}</span>
      <span class="ps-name">${triggerName}</span>
      <svg class="ps-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
    <div class="project-selector-menu" id="ps-menu">
      ${items || `<div class="muted" style="padding:8px 10px;font-size:12.5px;">暂无可见项目</div>`}
      <div class="ps-divider"></div>
      <div class="ps-action" id="ps-new-project">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        新建项目
      </div>
      <div class="ps-action" id="ps-manage-project">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
        项目管理
      </div>
    </div>
  `;

  document.getElementById('ps-trigger')?.addEventListener('click', (e) => {
    e.stopPropagation();
    wrap.classList.toggle('open');
  });
  wrap.querySelectorAll<HTMLElement>('[data-select-project]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.getAttribute('data-select-project')!;
      closeSelector();
      await switchProject(id);
    });
  });
  document.getElementById('ps-new-project')?.addEventListener('click', () => {
    closeSelector();
    openProjectUpsertModal(null);
  });
  document.getElementById('ps-manage-project')?.addEventListener('click', () => {
    closeSelector();
    if (!current) { toast('请先创建或选择一个项目'); return; }
    routeTo('project-manage');
  });
}

// ---------------- 新建 / 编辑项目 弹窗 ----------------

function openProjectUpsertModal(project: Project | null): void {
  editingProjectId = project?.id ?? null;
  (document.getElementById('pu-modal-title') as HTMLElement).textContent = project ? '编辑项目' : '新建项目';
  (document.getElementById('pu-name') as HTMLInputElement).value = project?.name ?? '';
  (document.getElementById('pu-desc') as HTMLTextAreaElement).value = project?.description ?? '';
  (document.getElementById('pu-visibility') as HTMLSelectElement).value = project?.visibility || 'private';
  openModal('modal-project-upsert');
}

async function submitProjectUpsert(): Promise<void> {
  const name = (document.getElementById('pu-name') as HTMLInputElement).value.trim();
  const description = (document.getElementById('pu-desc') as HTMLTextAreaElement).value.trim();
  const visibility = (document.getElementById('pu-visibility') as HTMLSelectElement).value as ProjectVisibility;
  if (!name) { toast('请填写项目名称'); return; }
  try {
    if (editingProjectId) {
      await projectsApi.update(editingProjectId, { name, description, visibility });
      toast('项目信息已更新');
    } else {
      const created = await projectsApi.create({ name, description, visibility });
      toast('项目已创建');
      await refreshProjects();
      await switchProject(created.id);
    }
    closeModal('modal-project-upsert');
    await refreshProjects();
    paintWorkspaceHome(getProjects());
    if (managedProjectId) renderProjectManage();
  } catch (e) {
    toastError(editingProjectId ? '更新失败' : '创建失败', e);
  }
}

// ---------------- 添加成员 弹窗 ----------------

function renderSearchResults(users: UserSearchItem[]): void {
  const box = document.getElementById('pmm-search-results');
  if (!box) return;
  if (!users.length) {
    box.innerHTML = '<span>未找到匹配账号</span>';
    return;
  }
  box.innerHTML = users.map(u => {
    const mark = existingMemberRoles.has(u.id)
      ? '<span class="muted" title="已是成员" aria-label="已是成员" style="font-family:宋体,SimSun,serif;margin-right:4px;">✓</span>'
      : '';
    return `<button type="button" class="btn btn-ghost btn-sm" style="margin:2px 4px 2px 0;" data-pick-user="${escapeHtml(u.id)}" data-pick-username="${escapeHtml(u.username)}">${mark}${escapeHtml(u.display_name || u.username)} <span class="muted">@${escapeHtml(u.username)}</span></button>`;
  }).join('');
  box.querySelectorAll<HTMLElement>('[data-pick-user]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-pick-user')!;
      const username = el.getAttribute('data-pick-username')!;
      const hit = users.find(u => u.id === id);
      selectedShareUser = hit || { id, username, display_name: username };
      (document.getElementById('pmm-username') as HTMLInputElement).value = username;
      const tip = existingMemberRoles.has(id)
        ? '<span class="muted" style="font-family:宋体,SimSun,serif;margin-right:4px;">✓</span>'
        : '';
      box.innerHTML = `<span>已选：${tip}@${escapeHtml(username)}</span>`;
    });
  });
}

async function openAddMemberModal(): Promise<void> {
  selectedShareUser = null;
  existingMemberRoles = new Map();
  (document.getElementById('pmm-username') as HTMLInputElement).value = '';
  (document.getElementById('pmm-role') as HTMLSelectElement).value = 'viewer';
  const box = document.getElementById('pmm-search-results');
  if (box) box.innerHTML = '';
  if (managedProjectId) {
    try {
      const members = await projectsApi.listMembers(managedProjectId);
      existingMemberRoles = new Map(members.map(m => [m.user_id, m.role]));
    } catch {
      /* 标注失败时仍可搜索添加 */
    }
  }
  openModal('modal-project-member');
}

async function onShareUsernameInput(): Promise<void> {
  const q = (document.getElementById('pmm-username') as HTMLInputElement).value.trim();
  selectedShareUser = null;
  if (searchTimer) clearTimeout(searchTimer);
  if (q.length < 1) {
    const box = document.getElementById('pmm-search-results');
    if (box) box.innerHTML = '';
    return;
  }
  searchTimer = setTimeout(async () => {
    try {
      const me = currentUser()?.id;
      const users = (await projectsApi.searchUsers(q)).filter(u => u.id !== me);
      renderSearchResults(users);
    } catch {
      /* 忽略瞬时搜索失败 */
    }
  }, 250);
}

async function submitAddMember(): Promise<void> {
  if (!managedProjectId) return;
  const username = (document.getElementById('pmm-username') as HTMLInputElement).value.trim();
  const role = (document.getElementById('pmm-role') as HTMLSelectElement).value as ProjectRole;
  if (!username && !selectedShareUser) { toast('请搜索并选择要分享的账号'); return; }
  try {
    const body = selectedShareUser
      ? { user_id: selectedShareUser.id, role }
      : { username, role };
    await projectsApi.addMember(managedProjectId, body);
    toast('已分享');
    closeModal('modal-project-member');
    renderProjectManage();
  } catch (e) {
    toastError('添加失败', e);
  }
}

// ---------------- 项目管理页 ----------------

function memberRow(
  m: ProjectMember,
  opts: { canChangeRole: boolean; canRemove: boolean; isCreator: boolean },
): string {
  const name = m.display_name || m.username || m.user_id;
  const creatorBadge = opts.isCreator ? ' <span class="badge ash">创建者</span>' : '';
  const roleCell = opts.canChangeRole
    ? `<select class="admin-role-select" data-member-role="${escapeHtml(m.user_id)}">
            <option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>只读</option>
            <option value="editor" ${m.role === 'editor' ? 'selected' : ''}>编辑</option>
            <option value="owner" ${m.role === 'owner' ? 'selected' : ''}>管理</option>
          </select>`
    : `<span class="badge ash">${escapeHtml(roleLabel(m.role))}</span>`;
  const removeCell = opts.canRemove
    ? `<button class="btn btn-ghost btn-sm" data-remove-member="${escapeHtml(m.user_id)}">移除</button>`
    : '';
  return `<div class="row-item" style="grid-template-columns:1.4fr 1fr 1fr 140px;cursor:default;">
    <div class="row-title">${escapeHtml(name)}${creatorBadge}</div>
    <div>${roleCell}</div>
    <div class="row-sub">${fmtTime(m.created_at)}</div>
    <div>${removeCell}</div>
  </div>`;
}

export async function renderProjectManage(): Promise<void> {
  const current = getCurrentProject();
  const titleEl = document.getElementById('pm-page-title');
  const editBtn = document.getElementById('pm-edit-project-btn') as HTMLButtonElement;
  const deleteBtn = document.getElementById('pm-delete-project-btn') as HTMLButtonElement;
  const addMemberBtn = document.getElementById('pm-add-member-btn') as HTMLButtonElement;
  const memberList = document.getElementById('pm-member-list')!;

  if (!current) {
    if (titleEl) titleEl.textContent = '项目管理';
    editBtn.style.display = 'none';
    deleteBtn.style.display = 'none';
    addMemberBtn.style.display = 'none';
    memberList.innerHTML = emptyStateHtml('暂无项目', '请先在顶栏新建一个项目空间。');
    return;
  }

  managedProjectId = current.id;
  memberList.innerHTML = skeletonRows(3);

  let detail: Project;
  try {
    detail = await projectsApi.get(current.id);
  } catch (e) {
    memberList.innerHTML = errorStateHtml(e instanceof Error ? e.message : String(e));
    return;
  }

  const manageable = canManage();
  if (titleEl) titleEl.textContent = `项目管理 · ${detail.name}`;
  editBtn.style.display = manageable ? '' : 'none';
  deleteBtn.style.display = (manageable && !detail.is_default) ? '' : 'none';
  addMemberBtn.style.display = manageable ? '' : 'none';

  (document.getElementById('pm-info-name') as HTMLElement).textContent = detail.name;
  (document.getElementById('pm-info-visibility') as HTMLElement).innerHTML = visibilityBadge(detail.visibility);
  (document.getElementById('pm-info-desc') as HTMLElement).textContent = detail.description || '--';
  (document.getElementById('pm-info-created') as HTMLElement).textContent = fmtTime(detail.created_at);
  (document.getElementById('pm-info-id') as HTMLElement).textContent = detail.id;

  editBtn.onclick = () => openProjectUpsertModal(detail);
  deleteBtn.onclick = () => {
    if (!requireManage('删除项目')) return;
    confirmAction('删除项目', `确认删除项目「${detail.name}」？该操作不可恢复，项目下的关联数据将不再可见。`, async () => {
      try {
        await projectsApi.remove(detail.id);
        toast('项目已删除');
        managedProjectId = null;
        await refreshProjects();
        routeTo('dashboard');
      } catch (e) {
        toastError('删除失败', e);
      }
    });
  };
  addMemberBtn.onclick = () => {
    if (!requireManage('添加成员')) return;
    void openAddMemberModal();
  };

  let members = detail.members;
  if (!members) {
    try { members = await projectsApi.listMembers(detail.id); }
    catch { members = []; }
  }

  if (!members.length) {
    memberList.innerHTML = emptyStateHtml('暂无成员', '添加成员后即可协作管理该项目空间。');
    return;
  }
  const me = currentUser();
  const iAmCreator = !!me && me.id === detail.created_by;
  const iAmAdmin = isAdmin();
  memberList.innerHTML = members.map(m => {
    const isCreator = m.user_id === detail.created_by;
    const isSelf = !!me && m.user_id === me.id;
    // 被分享者不能改自己的角色；也不能改创建者；只能移除只读/编辑。
    const canChangeRole = manageable && !isSelf && (iAmAdmin || iAmCreator || !isCreator);
    const canRemove = manageable && !isCreator && (iAmAdmin || iAmCreator || m.role !== 'owner');
    return memberRow(m, { canChangeRole, canRemove, isCreator });
  }).join('');

  memberList.querySelectorAll<HTMLSelectElement>('[data-member-role]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const userId = sel.getAttribute('data-member-role')!;
      try {
        await projectsApi.updateMemberRole(detail.id, userId, { role: sel.value as ProjectRole });
        toast('角色已更新');
        if (userId === current.id || detail.id === getCurrentProjectId()) await refreshProjects();
      } catch (e) {
        toastError('更新失败', e);
        renderProjectManage();
      }
    });
  });
  memberList.querySelectorAll<HTMLElement>('[data-remove-member]').forEach(el => {
    el.addEventListener('click', () => {
      const userId = el.getAttribute('data-remove-member')!;
      confirmAction('移除成员', '确认将该成员从项目中移除？', async () => {
        try {
          await projectsApi.removeMember(detail.id, userId);
          toast('已移除');
          renderProjectManage();
        } catch (e) {
          toastError('移除失败', e);
        }
      });
    });
  });
}

// ---------------- 项目空间总览首页 ----------------

/**
 * 用户打开系统的第一屏：展示所有可见项目卡片。用户点击「进入项目」后才切换项目上下文
 * 并跳转到该项目内的评测概览（dashboard）。未进入项目时侧边栏隐藏项目内导航。
 */
function paintWorkspaceHome(list: Project[]): void {
  const wrap = document.getElementById('workspace-home-grid');
  if (!wrap) return;

  const newBtn = document.getElementById('wh-new-project-btn') as HTMLButtonElement | null;
  if (newBtn) newBtn.onclick = () => openProjectUpsertModal(null);

  if (!list.length) {
    wrap.innerHTML = emptyStateHtml('还没有项目空间', '新建一个项目空间，开始你的评测工作。');
    return;
  }

  wrap.innerHTML = list.map((p, i) => {
    const initialsText = initials(p.name);
    const role = p.my_role;
    const uid = currentUser()?.id;
    const roleBadge = role
      ? `<span class="badge ok">${escapeHtml(roleLabel(role))}</span>`
      : isAdmin()
        ? `<span class="badge ok">平台管理</span>`
        : (p.visibility === 'public'
          ? `<span class="badge ash">公开只读</span>`
          : `<span class="badge ash">已分享</span>`);
    const visBadge = visibilityBadge(p.visibility);
    const defaultBadge = p.is_default ? '<span class="badge ash" style="margin-left:6px;">默认</span>' : '';
    const memberCount = p.members?.length ?? 0;
    // 管理入口：项目 owner / 创建者 / 平台 admin
    const manageableCard = role === 'owner' || isAdmin() || (!!uid && p.created_by === uid);
    return `<div class="workspace-card" style="animation-delay:${i * 40}ms;">
      <div class="workspace-card-head">
        <span class="workspace-card-avatar" aria-hidden="true">${escapeHtml(initialsText)}</span>
        <div class="workspace-card-title">
          <div class="workspace-card-name">${escapeHtml(p.name)}${visBadge}${defaultBadge}</div>
          <div class="workspace-card-meta">${roleBadge}</div>
        </div>
      </div>
      <p class="workspace-card-desc">${escapeHtml(p.description || '暂无项目描述')}</p>
      <div class="workspace-card-stats">
        <div><span class="stat-num">${memberCount}</span><span class="stat-label">成员</span></div>
        <div><span class="stat-num">${fmtTime(p.updated_at || p.created_at).split(' ')[0]}</span><span class="stat-label">更新时间</span></div>
      </div>
      <div class="workspace-card-actions">
        <button class="btn btn-primary btn-sm" data-enter-project="${escapeHtml(p.id)}">进入项目</button>
        ${manageableCard ? `<button class="btn btn-ghost btn-sm" data-manage-project="${escapeHtml(p.id)}">管理项目</button>` : ''}
      </div>
    </div>`;
  }).join('');

  wrap.querySelectorAll<HTMLElement>('[data-enter-project]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.getAttribute('data-enter-project')!;
      await enterProject(id);
    });
  });
  wrap.querySelectorAll<HTMLElement>('[data-manage-project]').forEach(el => {
    el.addEventListener('click', async () => {
      const id = el.getAttribute('data-manage-project')!;
      await switchProject(id);
      markProjectEntered(true);
      routeTo('project-manage');
    });
  });
}

export async function renderWorkspaceHome(): Promise<void> {
  const wrap = document.getElementById('workspace-home-grid');
  if (!wrap) return;
  wrap.innerHTML = skeletonRows(3, 120);

  let list: Project[];
  try {
    list = await refreshProjects();
  } catch (e) {
    wrap.innerHTML = errorStateHtml(e instanceof Error ? e.message : String(e));
    return;
  }
  paintWorkspaceHome(list);
}

/** 切换到目标项目并进入项目内视图（默认进 dashboard）。 */
export async function enterProject(id: string): Promise<void> {
  await switchProject(id);
  markProjectEntered(true);
  routeTo('dashboard');
}

/** 退出当前项目空间，返回到项目空间总览首页。 */
export function leaveProject(): void {
  markProjectEntered(false);
  routeTo('workspace-home');
}

// ---------------- 初始化 ----------------

export function initProjectUI(deps: { routeTo: (view: AppView, param?: string) => void }): void {
  routeTo = deps.routeTo;
  setProjectManageOpener(() => routeTo('project-manage'));
  onProjectListChange(renderProjectSelector);
  onProjectContextChange(renderProjectSelector);
  renderProjectSelector();

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('project-selector');
    if (wrap && !wrap.contains(e.target as Node)) wrap.classList.remove('open');
  });

  bindModalCloseHandlers(document.getElementById('modal-project-upsert') || document);
  bindModalCloseHandlers(document.getElementById('modal-project-member') || document);
  document.getElementById('pu-submit')?.addEventListener('click', submitProjectUpsert);
  document.getElementById('pmm-submit')?.addEventListener('click', submitAddMember);
  document.getElementById('pmm-username')?.addEventListener('input', () => { void onShareUsernameInput(); });

  refreshProjects().catch(e => toastError('加载项目列表失败', e));
}
