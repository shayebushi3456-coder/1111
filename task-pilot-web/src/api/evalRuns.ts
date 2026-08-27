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
}
interface RunningCaseExecutionsResponse {
  count: number;
  case_executions: CaseExecution[];
}

export const evalRunsApi = {
  list: () => api.get<EvalRunListResponse>('/eval-runs').then(r => r.eval_runs),
  get: (id: string) => api.get<EvalRunResponse>(`/eval-runs/${id}`).then(r => r.eval_run),
  // getWithSummary 保留 score_summary（机评总分/分布/Top问题），详情页渲染需要它。
  getWithSummary: (id: string) => api.get<EvalRunResponse>(`/eval-runs/${id}`),
  results: (id: string) => api.get<EvalRunResponse>(`/eval-runs/${id}/results`).then(r => r.eval_run),
  running: () => api.get<RunningCaseExecutionsResponse>('/eval-runs/running'),
  create: (body: CreateEvalRunRequest) => api.post<EvalRunResponse>('/eval-runs', body).then(r => r.eval_run),
  stop: (id: string) => api.post<EvalRunResponse>(`/eval-runs/${id}/stop`).then(r => r.eval_run),
  remove: (id: string) => api.del<{ status: string }>(`/eval-runs/${id}`),
};

export const leaderboardApi = {
  get: (period: '30d' | '90d' | 'all' = '30d') =>
    api.get<LeaderboardResponse>(`/leaderboard?period=${period}`),
};

export type { ScoreSummary, LeaderboardItem };

