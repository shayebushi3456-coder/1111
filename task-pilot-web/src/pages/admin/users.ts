import { adminApi } from '@/api/admin';
import { pageInfoText, renderPagination } from '@/core/pagination';
import { toast, toastError } from '@/core/feedback';
import { escapeHtml, emptyStateHtml, errorStateHtml, fmtTime, skeletonRows } from '@/lib/ui';
import type { User } from '@/types';

let state = { page: 1, pageSize: 20, q: '', status: '' };

export async function renderAdminUsers(): Promise<void> {
  const wrap = document.getElementById('admin-user-list')!;
  wrap.innerHTML = skeletonRows(5);
  try {
    const res = await adminApi.listUsers({ page: state.page, page_size: state.pageSize, q: state.q || undefined, status: state.status || undefined });
    document.getElementById('admin-user-page-info')!.textContent = pageInfoText(res.total, res.page, res.page_size);
    renderPagination(document.getElementById('admin-user-pagination')!, { page: res.page, pageSize: res.page_size, total: res.total }, page => { state.page = page; renderAdminUsers(); });
    if (!res.users.length) { wrap.innerHTML = emptyStateHtml('暂无用户', '换个筛选条件试试。'); return; }
    wrap.innerHTML = res.users.map(u => userRow(u)).join('');
    bindActions(wrap);
  } catch (e) {
    wrap.innerHTML = errorStateHtml(e instanceof Error ? e.message : String(e));
  }
}

function userRow(u: User): string {
  return `<div class="row-item" style="grid-template-columns:1.2fr 1fr 1fr 1fr 1.3fr 190px;cursor:default;">
    <div><div class="row-title">${escapeHtml(u.username)}</div><div class="row-sub">${escapeHtml(u.display_name || '--')}</div></div>
    <div class="row-sub">${escapeHtml(u.email || '--')}</div>
    <div><span class="badge ash">${escapeHtml(u.role)}</span></div>
    <div><span class="badge ${u.status === 'active' ? 'ok' : u.status === 'pending' ? 'queue' : 'ash'}">${escapeHtml(u.status)}</span></div>
    <div class="row-sub">${fmtTime(u.created_at)}</div>
    <div class="flex gap-8" style="flex-wrap:wrap;">
      ${u.status === 'pending' ? `<button class="btn btn-ghost btn-sm" data-approve="${u.id}">通过</button><button class="btn btn-ghost btn-sm" data-reject="${u.id}">拒绝</button>` : ''}
      <select data-role="${u.id}" class="admin-role-select"><option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>viewer</option><option value="operator" ${u.role === 'operator' ? 'selected' : ''}>operator</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option></select>
      ${u.status === 'disabled' ? `<button class="btn btn-ghost btn-sm" data-enable="${u.id}">启用</button>` : `<button class="btn btn-ghost btn-sm" data-disable="${u.id}">禁用</button>`}
    </div>
  </div>`;
}

function bindActions(wrap: HTMLElement): void {
  wrap.querySelectorAll<HTMLElement>('[data-approve]').forEach(el => el.addEventListener('click', async () => {
    try { await adminApi.approve(el.getAttribute('data-approve')!, 'viewer'); toast('已通过'); renderAdminUsers(); } catch (e) { toastError('操作失败', e); }
  }));
  wrap.querySelectorAll<HTMLElement>('[data-reject]').forEach(el => el.addEventListener('click', async () => {
    try { await adminApi.reject(el.getAttribute('data-reject')!); toast('已拒绝'); renderAdminUsers(); } catch (e) { toastError('操作失败', e); }
  }));
  wrap.querySelectorAll<HTMLSelectElement>('[data-role]').forEach(sel => sel.addEventListener('change', async () => {
    try { await adminApi.updateRole(sel.getAttribute('data-role')!, sel.value as User['role']); toast('角色已更新'); renderAdminUsers(); } catch (e) { toastError('操作失败', e); }
  }));
  wrap.querySelectorAll<HTMLElement>('[data-disable]').forEach(el => el.addEventListener('click', async () => {
    try { await adminApi.disable(el.getAttribute('data-disable')!); toast('已禁用'); renderAdminUsers(); } catch (e) { toastError('操作失败', e); }
  }));
  wrap.querySelectorAll<HTMLElement>('[data-enable]').forEach(el => el.addEventListener('click', async () => {
    try { await adminApi.enable(el.getAttribute('data-enable')!); toast('已启用'); renderAdminUsers(); } catch (e) { toastError('操作失败', e); }
  }));
}

export function initAdminUsersPage(): void {
  document.getElementById('admin-user-search')?.addEventListener('input', e => { state.q = (e.target as HTMLInputElement).value.trim(); state.page = 1; window.setTimeout(() => renderAdminUsers(), 150); });
  document.getElementById('admin-user-status')?.addEventListener('change', e => { state.status = (e.target as HTMLSelectElement).value; state.page = 1; renderAdminUsers(); });
}
