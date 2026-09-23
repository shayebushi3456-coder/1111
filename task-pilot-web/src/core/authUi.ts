import { authApi } from '@/api/auth';
import { closeModal, openModal, toast, toastError } from '@/core/feedback';
import { getAuth, login, logout, onAuthChange, refreshAuth, setLoginOpener } from '@/core/auth';
import { escapeHtml } from '@/lib/ui';

function roleLabel(role: string): string {
  const labels: Record<string, string> = { guest: '游客只读', viewer: '只读用户', operator: '评测操作员', admin: '平台管理员' };
  return labels[role] || role;
}

function initials(name: string): string {
  return (name || 'G').trim().slice(0, 2).toUpperCase();
}

function renderSidebarUser(): void {
  const auth = getAuth();
  const nameEl = document.getElementById('sidebar-user-name');
  const roleEl = document.getElementById('sidebar-user-role');
  const avatar = document.getElementById('sidebar-user-avatar');
  if (!nameEl || !roleEl || !avatar) return;
  const name = auth.user ? (auth.user.display_name || auth.user.username) : '未登录';
  nameEl.textContent = name;
  roleEl.textContent = roleLabel(auth.role);
  const fill = auth.role === 'admin' ? '#F5A524' : auth.role === 'operator' ? '#3B82C4' : auth.role === 'viewer' ? '#2FA968' : '#71717A';
  const textFill = auth.role === 'admin' ? '#1C1305' : '#fff';
  avatar.innerHTML = `<rect width="32" height="32" rx="8" fill="${fill}"/><text x="16" y="21" text-anchor="middle" font-size="13" font-weight="700" fill="${textFill}" font-family="monospace">${escapeHtml(initials(name))}</text>`;
}

function renderAuthArea(): void {
  renderSidebarUser();
  const wrap = document.getElementById('auth-area');
  if (!wrap) return;
  const auth = getAuth();
  const adminNav = document.getElementById('nav-admin-users');
  const adminGroup = document.getElementById('nav-admin-group');
  if (adminNav) adminNav.style.display = auth.role === 'admin' ? 'flex' : 'none';
  if (adminGroup) adminGroup.style.display = auth.role === 'admin' ? 'block' : 'none';
  if (!auth.user) {
    wrap.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="btn-login">登录</button>
      <button class="btn btn-primary btn-sm" id="btn-register">注册</button>
    `;
    document.getElementById('btn-login')?.addEventListener('click', () => openModal('modal-login'));
    document.getElementById('btn-register')?.addEventListener('click', () => openModal('modal-register'));
    return;
  }
  wrap.innerHTML = `
    <span class="auth-user"><b>${auth.user.display_name || auth.user.username}</b><small>${auth.role}</small></span>
    <button class="btn btn-ghost btn-sm" id="btn-logout">退出</button>
  `;
  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try { await logout(); toast('已退出登录'); }
    catch (e) { toastError('退出失败', e); }
  });
}

export function initAuthUI(): void {
  setLoginOpener(() => openModal('modal-login'));
  window.addEventListener('auth:login-required', () => openModal('modal-login'));
  onAuthChange(renderAuthArea);
  renderAuthArea();

  document.getElementById('login-submit')?.addEventListener('click', async () => {
    const username = (document.getElementById('login-username') as HTMLInputElement).value.trim();
    const password = (document.getElementById('login-password') as HTMLInputElement).value;
    if (!username || !password) { toast('请填写用户名和密码'); return; }
    try {
      await login(username, password);
      closeModal('modal-login');
      toast('登录成功');
    } catch (e) { toastError('登录失败', e); }
  });

  document.getElementById('register-submit')?.addEventListener('click', async () => {
    const username = (document.getElementById('reg-username') as HTMLInputElement).value.trim();
    const displayName = (document.getElementById('reg-display-name') as HTMLInputElement).value.trim();
    const email = (document.getElementById('reg-email') as HTMLInputElement).value.trim();
    const password = (document.getElementById('reg-password') as HTMLInputElement).value;
    const confirm = (document.getElementById('reg-password-confirm') as HTMLInputElement).value;
    if (!username || !password) { toast('请填写用户名和密码'); return; }
    if (password !== confirm) { toast('两次密码输入不一致'); return; }
    try {
      await authApi.register({ username, password, display_name: displayName, email });
      closeModal('modal-register');
      toast('注册成功，请等待管理员审核');
    } catch (e) { toastError('注册失败', e); }
  });

  refreshAuth().catch(() => renderAuthArea());
}
