import { api } from './client';
import type { RuntimeEnvConfig, UpsertRuntimeEnvConfigRequest } from '@/types';

interface RuntimeEnvConfigListResponse {
  runtime_env_configs: RuntimeEnvConfig[];
}

export const runtimeEnvConfigsApi = {
  list: () => api.get<RuntimeEnvConfigListResponse>('/config/runtime-envs').then(r => r.runtime_env_configs),
  get: (id: string) => api.get<RuntimeEnvConfig>(`/config/runtime-envs/${id}`),
  create: (body: UpsertRuntimeEnvConfigRequest) => api.post<RuntimeEnvConfig>('/config/runtime-envs', body),
  update: (id: string, body: UpsertRuntimeEnvConfigRequest) => api.put<RuntimeEnvConfig>(`/config/runtime-envs/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/config/runtime-envs/${id}`),
};
