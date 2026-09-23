import { authApi } from '@/api/auth';
import { ApiError } from '@/api/client';
import { toast } from '@/core/feedback';
import type { AuthMeResponse, User } from '@/types';

let authState: AuthMeResponse = { user: null, role: 'guest', permissions: ['eval_run:read', 'case_set:read'] };
let loginOpener: (() => void) | null = null;
let listeners: Array<() => void> = [];

export function getAuth(): AuthMeResponse { return authState; }
export function currentUser(): User | null { return authState.user; }
export function hasPermission(permission: string): boolean { return authState.permissions.includes(permission); }
export function isAdmin(): boolean { return authState.role === 'admin'; }
export function onAuthChange(listener: () => void): void { listeners.push(listener); }
function notify(): void { listeners.forEach(fn => fn()); }

export function setLoginOpener(fn: () => void): void { loginOpener = fn; }
export function openLogin(): void { loginOpener?.(); }

export async function refreshAuth(): Promise<AuthMeResponse> {
  authState = await authApi.me();
  notify();
  return authState;
}

export function requirePermission(permission: string, label = '该操作'): boolean {
  if (hasPermission(permission)) return true;
  if (!authState.user) {
    toast(`${label}需要登录后使用`);
    openLogin();
  } else {
    toast(`当前角色无权限：${permission}`);
  }
  return false;
}

export async function handleAuthError(e: unknown): Promise<boolean> {
  if (e instanceof ApiError && e.code === 'LOGIN_REQUIRED') {
    toast('请先登录');
    openLogin();
    return true;
  }
  if (e instanceof ApiError && e.code === 'PERMISSION_DENIED') {
    toast(`权限不足：${e.permission || ''}`);
    return true;
  }
  return false;
}

export async function login(username: string, password: string): Promise<void> {
  await authApi.login({ username, password });
  // 以 cookie 会话再拉一次 /auth/me，保证与后续带凭证请求一致。
  await refreshAuth();
}

export async function logout(): Promise<void> {
  await authApi.logout();
  await refreshAuth();
}
