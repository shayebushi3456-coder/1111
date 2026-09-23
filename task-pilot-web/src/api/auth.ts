import { api } from './client';
import type { AuthMeResponse } from '@/types';

export const authApi = {
  me: () => api.get<AuthMeResponse>('/auth/me'),
  login: (body: { username: string; password: string }) => api.post<AuthMeResponse>('/auth/login', body),
  register: (body: { username: string; password: string; display_name: string; email: string }) => api.post<{ message: string }>('/auth/register', body),
  logout: () => api.post<{ status: string }>('/auth/logout'),
};
