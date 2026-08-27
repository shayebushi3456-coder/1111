import { api } from './client';
import type { SkillConfig, UpsertSkillConfigRequest } from '@/types';

interface SkillConfigListResponse {
  skill_configs: SkillConfig[];
}

function normalizeSkillConfig(sk: SkillConfig): SkillConfig {
  return { ...sk, extra_files: sk.extra_files || {} };
}

export const skillConfigsApi = {
  list: () => api.get<SkillConfigListResponse>('/config/skills').then(r => r.skill_configs.map(normalizeSkillConfig)),
  get: (id: string) => api.get<SkillConfig>(`/config/skills/${id}`).then(normalizeSkillConfig),
  create: (body: UpsertSkillConfigRequest) => api.post<SkillConfig>('/config/skills', body).then(normalizeSkillConfig),
  update: (id: string, body: UpsertSkillConfigRequest) => api.put<SkillConfig>(`/config/skills/${id}`, body).then(normalizeSkillConfig),
  remove: (id: string) => api.del<{ status: string }>(`/config/skills/${id}`),
};
