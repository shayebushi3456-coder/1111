import { api, apiUrl } from './client';
import type { FileResponse, TaskRecord } from '@/types';

interface ArtifactListResponse {
  artifacts: FileResponse[];
}

function filenameFromDisposition(disposition: string | null): string | undefined {
  if (!disposition) return undefined;
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) return decodeURIComponent(utf8[1].replace(/"/g, ''));
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : undefined;
}

export const filesApi = {
  /** 上传用例输入文件，purpose 固定为 input（供用例集创建/编辑引用）。 */
  uploadInput: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    form.append('purpose', 'input');
    return api.postForm<FileResponse>('/files/upload', form);
  },
  /** 文件下载直链，用于 <a href> 或新开标签页，浏览器原生下载不占用前端内存。 */
  downloadUrl: (fileId: string) => apiUrl(`/files/${fileId}/download`),
  /** 拉取文件二进制内容（用于本地解析，如产物 tar.gz）。 */
  downloadBlob: (fileId: string) => api.getBlob(`/files/${fileId}/download`),
  /** 拉取文件二进制内容并尽量从响应头解析原始文件名（用例集导出使用）。 */
  async downloadBlobWithName(fileId: string): Promise<{ blob: Blob; filename: string }> {
    const res = await fetch(apiUrl(`/files/${fileId}/download`));
    if (!res.ok) throw new Error(`下载文件失败：HTTP ${res.status}`);
    return {
      blob: await res.blob(),
      filename: filenameFromDisposition(res.headers.get('Content-Disposition')) || fileId,
    };
  },
  /** 某个测试/评测任务已上传的产物列表（通常仅一个 output.tar.gz）。 */
  listArtifacts: (taskId: string) => api.get<ArtifactListResponse>(`/tasks/${taskId}/artifacts`).then(r => r.artifacts),
};

export const tasksApi = {
  get: (id: string) => api.get<{ task: TaskRecord }>(`/tasks/${id}`).then(r => r.task),
};
