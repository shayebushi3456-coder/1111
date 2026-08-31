import { escapeHtml } from '@/lib/ui';

export function toast(msg: string): void {
  const wrap = document.getElementById('toast-wrap');
  if (!wrap) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M5 12l4 4L19 6"/></svg><span>${escapeHtml(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function toastError(prefix: string, e: unknown): void {
  toast(`${prefix}：${errMsg(e)}`);
}

export function openModal(id: string): void {
  document.getElementById(id)?.classList.add('open');
}

export function closeModal(id: string): void {
  document.getElementById(id)?.classList.remove('open');
}

export function bindModalCloseHandlers(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-close-modal]').forEach(el => {
    el.addEventListener('click', () => closeModal(el.getAttribute('data-close-modal')!));
  });
}

export function confirmAction(title: string, desc: string, onConfirm: () => void): void {
  document.getElementById('confirm-title')!.textContent = title;
  document.getElementById('confirm-desc')!.textContent = desc;
  openModal('modal-confirm');
  const btn = document.getElementById('confirm-ok-btn')!;
  const handler = () => {
    onConfirm();
    closeModal('modal-confirm');
    btn.removeEventListener('click', handler);
  };
  btn.addEventListener('click', handler);
}
