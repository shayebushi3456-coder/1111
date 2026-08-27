export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const d = new Date(iso);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

export function escapeHtml(s: string | null | undefined): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

export function emptyStateHtml(title: string, desc: string): string {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M8 4v5"/></svg>
    <h4>${escapeHtml(title)}</h4><p>${escapeHtml(desc)}</p>
  </div>`;
}

export function errorStateHtml(msg: string): string {
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="var(--err)" stroke-width="1.4"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>
    <h4 style="color:var(--err);">加载失败</h4><p>${escapeHtml(msg)}</p>
  </div>`;
}

export function skeletonRows(n: number, height = 52): string {
  return Array.from({ length: n }, () => `<div class="skel" style="height:${height}px;margin:8px 18px;border-radius:10px;"></div>`).join('');
}
