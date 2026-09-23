import { escapeHtml } from '@/lib/ui';

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

export function pageCountOf(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
}

export function renderPagination(el: HTMLElement, state: PaginationState, onPage: (page: number) => void): void {
  const pageCount = pageCountOf(state.total, state.pageSize);
  const page = Math.min(Math.max(1, state.page), pageCount);
  el.innerHTML = `
    <button class="btn btn-ghost btn-sm" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="mono muted">${escapeHtml(String(page))} / ${escapeHtml(String(pageCount))}</span>
    <button class="btn btn-ghost btn-sm" data-page="${page + 1}" ${page >= pageCount ? 'disabled' : ''}>下一页</button>
  `;
  el.querySelectorAll<HTMLButtonElement>('[data-page]').forEach(btn => btn.addEventListener('click', () => {
    const next = Number(btn.getAttribute('data-page'));
    if (!Number.isFinite(next) || next < 1 || next > pageCount || next === page) return;
    onPage(next);
  }));
}

export function pageInfoText(total: number, page: number, pageSize: number): string {
  if (total <= 0) return '0 条';
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(total, page * pageSize);
  return `${start}-${end} / ${total} 条`;
}
