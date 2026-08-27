import { api } from './client';
import type { CaseItem, CaseSet, CaseSetRequestInput } from '@/types';

interface CaseSetResponse {
  case_set: CaseSet;
  /**
   * 详情接口的后端 DTO 可能将用例数组作为顶层 cases 返回，
   * 而列表接口/旧版本接口可能把 cases 直接挂在 case_set 上。
   * 前端统一归一化到 CaseSet.cases，避免详情页丢弃用例列表。
   */
  cases?: CaseItem[] | null;
}
interface CaseSetListResponse {
  case_sets: CaseSet[];
}

function normalizeCaseItem(item: CaseItem): CaseItem {
  const raw = item as CaseItem & {
    file_ids?: string[] | null;
    checkpoints?: CaseItem['checkpoints'] | null;
    mcp_ids?: string[] | null;
    skill_ids?: string[] | null;
  };
  return {
    ...item,
    file_ids: Array.isArray(raw.file_ids) ? raw.file_ids : [],
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints : [],
    mcp_ids: Array.isArray(raw.mcp_ids) ? raw.mcp_ids : [],
    skill_ids: Array.isArray(raw.skill_ids) ? raw.skill_ids : [],
  };
}

function normalizeCaseSet(caseSet: CaseSet, cases?: CaseItem[] | null): CaseSet {
  const normalizedCases = Array.isArray(cases)
    ? cases.map(normalizeCaseItem)
    : Array.isArray(caseSet.cases)
      ? caseSet.cases.map(normalizeCaseItem)
      : undefined;
  return { ...caseSet, cases: normalizedCases };
}

function normalizeCaseSetResponse(res: CaseSetResponse): CaseSet {
  return normalizeCaseSet(res.case_set, res.cases);
}

export const caseSetsApi = {
  list: () => api.get<CaseSetListResponse>('/case-sets').then(r => r.case_sets.map(cs => normalizeCaseSet(cs))),
  get: (id: string) => api.get<CaseSetResponse>(`/case-sets/${id}`).then(normalizeCaseSetResponse),
  create: (body: CaseSetRequestInput) => api.post<CaseSetResponse>('/case-sets', body).then(normalizeCaseSetResponse),
  update: (id: string, body: CaseSetRequestInput) => api.put<CaseSetResponse>(`/case-sets/${id}`, body).then(normalizeCaseSetResponse),
  remove: (id: string) => api.del<{ status: string }>(`/case-sets/${id}`),
};
