import { api } from './client';
import type {
  EvalRun,
  CreateEvalRunRequest,
  CaseExecution,
  EvalRunResponse,
  ScoreSummary,
  LeaderboardResponse,
  LeaderboardItem,
} from '@/types';

interface EvalRunListResponse {
  eval_runs: EvalRun[];
  total?: number;
  page?: number;
  page_size?: number;
}
export interface EvalRunListQuery {
  page?: number;
  page_size?: number;
  q?: string;
}
interface RunningCaseExecutionsResponse {
  count: number;
  case_executions: CaseExecution[];
}

function queryString(params: EvalRunListQuery): string {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '') qs.set(k, String(v)); });
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export const evalRunsApi = {
  list: () => api.get<EvalRunListResponse>('/eval-runs').then(r => r.eval_runs),
  listPaged: (query: EvalRunListQuery) => api.get<EvalRunListResponse>(`/eval-runs${queryString(query)}`),
  get: (id: string) => api.get<EvalRunResponse>(`/eval-runs/${id}`).then(r => r.eval_run),
  // getWithSummary 保留 score_summary（机评总分/分布/Top问题），详情页渲染需要它。
  getWithSummary: (id: string) => api.get<EvalRunResponse>(`/eval-runs/${id}`),
  results: (id: string) => api.get<EvalRunResponse>(`/eval-runs/${id}/results`).then(r => r.eval_run),
  running: () => api.get<RunningCaseExecutionsResponse>('/eval-runs/running'),
  create: (body: CreateEvalRunRequest) => api.post<EvalRunResponse>('/eval-runs', body).then(r => r.eval_run),
  stop: (id: string) => api.post<EvalRunResponse>(`/eval-runs/${id}/stop`).then(r => r.eval_run),
  remove: (id: string) => api.del<{ status: string }>(`/eval-runs/${id}`),
  // reeval 不重跑测试，只拿已有测试产物用最新题面/校验点/Prompt 重新判分。
  reeval: (runId: string, ceId: string) =>
    api.post<EvalRunResponse>(`/eval-runs/${runId}/case-executions/${ceId}/reeval`).then(r => r.eval_run),
};

export const leaderboardApi = {
  get: (period: '30d' | '90d' | 'all' = '30d') =>
    api.get<LeaderboardResponse>(`/leaderboard?period=${period}`),
};

export type { ScoreSummary, LeaderboardItem };

