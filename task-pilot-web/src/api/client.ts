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
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function url(path: string): string {
  return `${API_BASE}/api/v1${path}`;
}

async function parseErrorBody(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as ErrorResponse;
    if (body && typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // 响应体不是 JSON，忽略
  }
  return `HTTP ${res.status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), {
    ...init,
    headers: {
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    throw new ApiError(res.status, await parseErrorBody(res));
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
    const res = await fetch(url(path));
    if (!res.ok) throw new ApiError(res.status, await parseErrorBody(res));
    return res.blob();
  },
};

export { url as apiUrl };
