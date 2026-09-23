import { api } from './client';
import type {
  AddProjectMemberRequest, Project, ProjectListResponse, ProjectMember,
  UpdateProjectMemberRoleRequest, UpsertProjectRequest, UserSearchItem,
} from '@/types';

export const projectsApi = {
  list: () => api.get<ProjectListResponse>('/projects').then(r => r.projects),
  create: (body: UpsertProjectRequest) => api.post<Project>('/projects', body),
  get: (id: string) => api.get<Project>(`/projects/${id}`),
  update: (id: string, body: UpsertProjectRequest) => api.put<Project>(`/projects/${id}`, body),
  remove: (id: string) => api.del<{ status: string }>(`/projects/${id}`),

  listMembers: (id: string) =>
    api.get<{ members: ProjectMember[] }>(`/projects/${id}/members`).then(r => r.members),
  addMember: (id: string, body: AddProjectMemberRequest) => api.post<ProjectMember>(`/projects/${id}/members`, body),
  updateMemberRole: (id: string, userId: string, body: UpdateProjectMemberRoleRequest) =>
    api.put<ProjectMember>(`/projects/${id}/members/${userId}`, body),
  removeMember: (id: string, userId: string) => api.del<{ status: string }>(`/projects/${id}/members/${userId}`),
  searchUsers: (q: string) =>
    api.get<{ users: UserSearchItem[] }>(`/users/search?q=${encodeURIComponent(q)}`).then(r => r.users),
};
