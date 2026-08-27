import { api } from './client';
import type { MCPConfig, UpsertMCPConfigRequest } from '@/types';

interface MCPConfigListResponse {
  mcp_configs: MCPConfig[];
}

export const mcpConfigsApi = {
  list: () => api.get<MCPConfigListResponse>('/config/mcp-servers').then(r => r.mcp_configs),
  get: (id: string) => api.get<MCPConfig>(`/config/mcp-servers/${id}`),
  create: (body: UpsertMCPConfigRequest) => api.post<MCPConfig>('/config/mcp-servers', body),
  update: (id: string, body: UpsertMCPConfigRequest) => api.put<MCPConfig>(`/config/mcp-servers/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/config/mcp-servers/${id}`),
};
