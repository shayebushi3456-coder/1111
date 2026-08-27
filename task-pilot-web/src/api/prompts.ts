import { api } from './client';
import type { EvalPrompt, UpsertPromptRequest } from '@/types';

interface PromptListResponse {
  prompts: EvalPrompt[];
}

export const promptsApi = {
  list: () => api.get<PromptListResponse>('/eval-prompts').then(r => r.prompts),
  get: (id: string) => api.get<EvalPrompt>(`/eval-prompts/${id}`),
  create: (body: UpsertPromptRequest) => api.post<EvalPrompt>('/eval-prompts', body),
  update: (id: string, body: UpsertPromptRequest) => api.put<EvalPrompt>(`/eval-prompts/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/eval-prompts/${id}`),
};
