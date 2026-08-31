import { caseSetsApi } from '@/api/caseSets';
import { evalRunsApi } from '@/api/evalRuns';
import { targetEndpointsApi, evalEndpointsApi } from '@/api/endpoints';
import { promptsApi } from '@/api/prompts';
import { mcpConfigsApi } from '@/api/mcpConfigs';
import { skillConfigsApi } from '@/api/skillConfigs';
import type { CaseSet, EndpointResponse, EvalPrompt, EvalRun, MCPConfig, SkillConfig } from '@/types';

export const cache = {
  caseSets: null as CaseSet[] | null,
  evalRuns: null as EvalRun[] | null,
  targetEndpoints: null as EndpointResponse[] | null,
  evalEndpoints: null as EndpointResponse[] | null,
  prompts: null as EvalPrompt[] | null,
  mcpConfigs: null as MCPConfig[] | null,
  skillConfigs: null as SkillConfig[] | null,
};

export async function loadCaseSets(force = false): Promise<CaseSet[]> {
  if (!force && cache.caseSets) return cache.caseSets;
  cache.caseSets = await caseSetsApi.list();
  return cache.caseSets;
}

export async function loadEvalRuns(force = false): Promise<EvalRun[]> {
  if (!force && cache.evalRuns) return cache.evalRuns;
  cache.evalRuns = await evalRunsApi.list();
  return cache.evalRuns;
}

export async function loadTargetEndpoints(force = false): Promise<EndpointResponse[]> {
  if (!force && cache.targetEndpoints) return cache.targetEndpoints;
  cache.targetEndpoints = await targetEndpointsApi.list();
  return cache.targetEndpoints;
}

export async function loadEvalEndpoints(force = false): Promise<EndpointResponse[]> {
  if (!force && cache.evalEndpoints) return cache.evalEndpoints;
  cache.evalEndpoints = await evalEndpointsApi.list();
  return cache.evalEndpoints;
}

export async function loadPrompts(force = false): Promise<EvalPrompt[]> {
  if (!force && cache.prompts) return cache.prompts;
  cache.prompts = await promptsApi.list();
  return cache.prompts;
}

export async function loadMCPConfigs(force = false): Promise<MCPConfig[]> {
  if (!force && cache.mcpConfigs) return cache.mcpConfigs;
  cache.mcpConfigs = await mcpConfigsApi.list();
  return cache.mcpConfigs;
}

export async function loadSkillConfigs(force = false): Promise<SkillConfig[]> {
  if (!force && cache.skillConfigs) return cache.skillConfigs;
  cache.skillConfigs = await skillConfigsApi.list();
  return cache.skillConfigs;
}
