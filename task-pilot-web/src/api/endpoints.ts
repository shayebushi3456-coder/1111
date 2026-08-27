import { api } from './client';
import type { EndpointResponse, UpsertEndpointRequest } from '@/types';

interface EndpointListResponse {
  endpoints: EndpointResponse[];
}

export const targetEndpointsApi = {
  list: () => api.get<EndpointListResponse>('/config/target-endpoints').then(r => r.endpoints),
  get: (id: string) => api.get<EndpointResponse>(`/config/target-endpoints/${id}`),
  create: (body: UpsertEndpointRequest) => api.post<EndpointResponse>('/config/target-endpoints', body),
  update: (id: string, body: UpsertEndpointRequest) => api.put<EndpointResponse>(`/config/target-endpoints/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/config/target-endpoints/${id}`),
};

export const evalEndpointsApi = {
  list: () => api.get<EndpointListResponse>('/config/eval-endpoints').then(r => r.endpoints),
  get: (id: string) => api.get<EndpointResponse>(`/config/eval-endpoints/${id}`),
  create: (body: UpsertEndpointRequest) => api.post<EndpointResponse>('/config/eval-endpoints', body),
  update: (id: string, body: UpsertEndpointRequest) => api.put<EndpointResponse>(`/config/eval-endpoints/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/config/eval-endpoints/${id}`),
};
