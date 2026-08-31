import type { TarMember } from '@/types';

export function sanitizeFolderName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

export function safeExportFilename(name: string, fallback: string): string {
  const clean = name.split('/').pop()?.replace(/[\\/:*?"<>|]/g, '_').trim();
  return clean || fallback;
}

export function normalizeZipPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

export function iconTypeOf(name: string): string {
  const ext = name.split('.').pop()!.toLowerCase();
  if (ext === 'jsonl') return 'jsonl';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (['pptx', 'docx', 'xlsx', 'pdf', 'zip'].includes(ext)) return ext;
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) return 'image';
  if (['txt', 'log', 'csv', 'tsv', 'xml', 'yaml', 'yml'].includes(ext)) return 'text';
  return 'json';
}

export function mimeTypeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    txt: 'text/plain;charset=utf-8',
    log: 'text/plain;charset=utf-8',
    csv: 'text/csv;charset=utf-8',
    tsv: 'text/tab-separated-values;charset=utf-8',
    md: 'text/markdown;charset=utf-8',
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    html: 'text/html;charset=utf-8',
    htm: 'text/html;charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    zip: 'application/zip',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

export function downloadConfigForMember(member: TarMember): { url: string; filename: string; revoke: boolean } {
  const blob = new Blob([member.data as BlobPart], { type: mimeTypeOf(member.name) });
  return { url: URL.createObjectURL(blob), filename: member.name.split('/').pop() || member.name, revoke: true };
}

export function isInternalArtifactMember(name: string): boolean {
  return name.split('/').some(part => part.startsWith('.') && part.length > 1);
}

/** 粗略判定二进制内容：抽样字节中出现 NUL 或过多不可打印字符即认为不可作为文本预览。 */
export function looksBinary(data: Uint8Array): boolean {
  const sample = data.subarray(0, Math.min(data.length, 4096));
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.05;
}
