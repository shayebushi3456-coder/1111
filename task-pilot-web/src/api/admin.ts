import { api } from './client';
import type { User, UserListResponse } from '@/types';

function queryString(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') qs.set(k, String(v)); });
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export const adminApi = {
  listUsers: (query: { page?: number; page_size?: number; q?: string; status?: string; role?: string }) => api.get<UserListResponse>(`/admin/users${queryString(query)}`),
  approve: (id: string, role: User['role']) => api.post<User>(`/admin/users/${id}/approve`, { role }),
  reject: (id: string) => api.post<User>(`/admin/users/${id}/reject`),
  updateRole: (id: string, role: User['role']) => api.put<User>(`/admin/users/${id}/role`, { role }),
  disable: (id: string) => api.post<User>(`/admin/users/${id}/disable`),
  enable: (id: string) => api.post<User>(`/admin/users/${id}/enable`),
};
