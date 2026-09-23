/* ============================================================
   task-pilot 后端 REST 客户端基础封装
   API_BASE 留空时走相对路径 /api/v1/...，配合同源反代或 Vite 开发代理，
   避免在生产环境暴露跨域请求（后端未内置 CORS 中间件）。
   通过 VITE_API_BASE_URL 可覆盖为绝对地址（见 .env.example）。
   ============================================================ */
import type { ErrorResponse } from '@/types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  status: number;
  code?: string;
  permission?: string;
  constructor(status: number, message: string, code?: string, permission?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.permission = permission;
  }
}

function url(path: string): string {
  return `${API_BASE}/api/v1${path}`;
}

/* ----------------------------------------------------------------
   项目空间请求头：业务接口自动带上当前项目 ID，后端据此做数据隔离与权限判断。
   /auth/* 与 /admin/* 是平台级接口（登录态、平台用户管理），与项目空间无关，
   不附带该头，避免后端把它当作项目上下文误处理。
   通过 getProjectIdForRequest 注入点解耦，避免 client.ts 直接依赖 core/project.ts
   （core/project.ts 反过来会依赖 client.ts 的 ApiError，避免循环依赖）。
   ---------------------------------------------------------------- */
let projectIdProvider: (() => string | null) | null = null;
export function setProjectIdProvider(fn: () => string | null): void {
  projectIdProvider = fn;
}
function isPlatformPath(path: string): boolean {
  return path.startsWith('/auth/') || path.startsWith('/auth') || path.startsWith('/admin/') || path.startsWith('/admin') || path.startsWith('/projects');
}
function projectHeaders(path: string): Record<string, string> {
  if (isPlatformPath(path)) return {};
  const projectId = projectIdProvider?.();
  return projectId ? { 'X-Project-ID': projectId } : {};
}

async function parseErrorBody(res: Response): Promise<{ message: string; code?: string; permission?: string }> {
  try {
    const body = (await res.json()) as ErrorResponse;
    if (body && typeof body.error === 'string' && body.error) return { message: body.error, code: body.code, permission: body.permission };
  } catch {
    // 响应体不是 JSON，忽略
  }
  return { message: `HTTP ${res.status}` };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    credentials: 'include',
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...projectHeaders(path),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await parseErrorBody(res);
    if (err.code === 'LOGIN_REQUIRED') window.dispatchEvent(new CustomEvent('auth:login-required'));
    throw new ApiError(res.status, err.message, err.code, err.permission);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string): Promise<T> => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown): Promise<T> =>
    request<T>(path, { method: 'PUT', body: body !== undefined ? JSON.stringify(body) : undefined }),
  del: <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' }),
  postForm: <T>(path: string, form: FormData): Promise<T> => request<T>(path, { method: 'POST', body: form }),
  /** 返回原始二进制内容（下载文件 / 产物包）。 */
  async getBlob(path: string): Promise<Blob> {
    const res = await fetch(url(path), { credentials: 'include', headers: projectHeaders(path) });
    if (!res.ok) {
      const err = await parseErrorBody(res);
      if (err.code === 'LOGIN_REQUIRED') window.dispatchEvent(new CustomEvent('auth:login-required'));
      throw new ApiError(res.status, err.message, err.code, err.permission);
    }
    return res.blob();
  },
};

export { url as apiUrl };
