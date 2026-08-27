import { api } from './client';
import type { EnvVar, UpsertEnvVarRequest } from '@/types';

interface EnvVarListResponse {
  env_vars: EnvVar[];
}

export const envVarsApi = {
  list: () => api.get<EnvVarListResponse>('/config/env-vars').then(r => r.env_vars),
  get: (id: string) => api.get<EnvVar>(`/config/env-vars/${id}`),
  create: (body: UpsertEnvVarRequest) => api.post<EnvVar>('/config/env-vars', body),
  update: (id: string, body: UpsertEnvVarRequest) => api.put<EnvVar>(`/config/env-vars/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/config/env-vars/${id}`),
};
