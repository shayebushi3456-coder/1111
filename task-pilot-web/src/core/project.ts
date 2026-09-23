/* ============================================================
   项目空间状态：当前项目、项目列表、切换、localStorage 持久化，
   以及基于「公开性 + 项目角色 + 平台管理员」推导出的
   canWrite / canManage / canDownload 权限判定。

   - public ：任何人（含游客）只读；成员按角色另有编辑/管理。
   - private：仅成员可访问；可分享并设只读/编辑/管理。
   - owner/editor/viewer ↔ 管理/编辑/只读。
   平台 admin 视为对所有项目拥有 owner 等级权限。
   ============================================================ */
import { projectsApi } from '@/api/projects';
import { setProjectIdProvider } from '@/api/client';
import { isAdmin, currentUser } from '@/core/auth';
import { toast } from '@/core/feedback';
import type { Project, ProjectRole } from '@/types';

const STORAGE_KEY = 'we-project-id';

let projects: Project[] = [];
let currentProjectId: string | null = null;
let loaded = false;
let manageOpener: (() => void) | null = null;
let projectListListeners: Array<() => void> = [];
let projectContextListeners: Array<() => void> = [];

function notifyProjectListChange(): void {
  projectListListeners.forEach(fn => fn());
}

function notifyProjectContextChange(): void {
  projectContextListeners.forEach(fn => fn());
}

/** 项目列表变化：项目集合被刷新/增删改后通知，适合刷新项目选择器等纯列表 UI。 */
export function onProjectListChange(listener: () => void): void {
  projectListListeners.push(listener);
}

/** 项目上下文变化：当前项目或“是否已进入项目空间”变化，适合清空项目级缓存并重渲染项目内页面。 */
export function onProjectContextChange(listener: () => void): void {
  projectContextListeners.push(listener);
}

export function setProjectManageOpener(fn: () => void): void {
  manageOpener = fn;
}

export function openProjectManage(): void {
  manageOpener?.();
}

export function getProjects(): Project[] {
  return projects;
}

export function getCurrentProject(): Project | null {
  return projects.find(p => p.id === currentProjectId) || null;
}

export function getCurrentProjectId(): string | null {
  return currentProjectId;
}

/** 当前用户在当前项目内的角色；非成员（且非平台 admin）时为 null，代表只读。
 *  优先信任后端返回的 my_role（若后端已支持），否则从 members 列表按当前用户 ID 现算，
 *  避免后端暂未附带 my_role 时整个权限系统误判为「全员只读」。 */
export function currentProjectRole(): ProjectRole | null {
  const p = getCurrentProject();
  if (!p) return null;
  if (p.my_role) return p.my_role;
  const uid = currentUser()?.id;
  if (!uid || !p.members) return null;
  return p.members.find(m => m.user_id === uid)?.role ?? null;
}

export function canWrite(): boolean {
  if (isAdmin()) return true;
  const role = currentProjectRole();
  return role === 'owner' || role === 'editor';
}

export function canManage(): boolean {
  if (isAdmin()) return true;
  return currentProjectRole() === 'owner';
}

/** viewer 及以上角色均可下载/导出；非成员/游客不可。 */
export function canDownload(): boolean {
  if (isAdmin()) return true;
  const role = currentProjectRole();
  return role === 'owner' || role === 'editor' || role === 'viewer';
}

export function requireWrite(label = '该操作'): boolean {
  if (canWrite()) return true;
  toast(`${label}需要项目「编辑」或以上权限`);
  return false;
}

export function requireManage(label = '该操作'): boolean {
  if (canManage()) return true;
  toast(`${label}需要项目「管理」权限`);
  return false;
}

export function requireDownload(label = '该操作'): boolean {
  if (canDownload()) return true;
  toast(`${label}需要项目成员身份，游客/非成员无法下载或导出`);
  return false;
}

function persist(id: string | null): void {
  currentProjectId = id;
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
}

function pickInitialProjectId(list: Project[]): string | null {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && list.some(p => p.id === saved)) return saved;
  const def = list.find(p => p.is_default);
  if (def) return def.id;
  return list[0]?.id ?? null;
}

/** 拉取项目列表并确定当前项目（首次加载时按 localStorage -> 默认项目 -> 第一个 的顺序选取）。 */
export async function refreshProjects(): Promise<Project[]> {
  const previousProjectId = currentProjectId;
  projects = await projectsApi.list();
  if (!loaded) {
    persist(pickInitialProjectId(projects));
    loaded = true;
  } else if (!projects.some(p => p.id === currentProjectId)) {
    // 当前项目被删除或不再可见（如被移出项目），回退到默认项目。
    persist(pickInitialProjectId(projects));
  }
  notifyProjectListChange();
  if (previousProjectId !== currentProjectId) notifyProjectContextChange();
  return projects;
}

export async function switchProject(id: string): Promise<void> {
  if (id === currentProjectId) return;
  if (!projects.some(p => p.id === id)) return;
  persist(id);
  notifyProjectContextChange();
}

/** 是否已进入某个项目空间（用于首页/项目内视图的显示与侧边栏切换）。 */
let entered = false;
export function hasEnteredProject(): boolean {
  return entered && !!currentProjectId;
}
export function markProjectEntered(v: boolean): void {
  if (entered === v) return;
  entered = v;
  notifyProjectContextChange();
}

setProjectIdProvider(() => currentProjectId);
