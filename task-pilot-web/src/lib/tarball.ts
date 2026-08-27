/* ============================================================
   零依赖 tar.gz 解压（浏览器端）
   评测/测试任务的产物统一打包为 output.tar.gz 上传（见 task-pilot
   internal/job/template.go: `tar -czf output.tar.gz -C output .`），
   前端拿到这个二进制文件后需要在本地解压才能读到里面的 trace.jsonl /
   report.md / 其他产出文件，不依赖服务端提供解压后的文件列表接口。
   gzip 解压用浏览器原生 DecompressionStream，tar 层按 ustar 格式手写解析。
   ============================================================ */
import type { TarMember } from '@/types';

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function readOctal(bytes: Uint8Array, start: number, len: number): number {
  const str = new TextDecoder('ascii').decode(bytes.subarray(start, start + len)).replace(/\0/g, '').trim();
  if (!str) return 0;
  return parseInt(str, 8) || 0;
}

function readString(bytes: Uint8Array, start: number, len: number): string {
  const slice = bytes.subarray(start, start + len);
  const nul = slice.indexOf(0);
  const trimmed = nul === -1 ? slice : slice.subarray(0, nul);
  return new TextDecoder('utf-8').decode(trimmed);
}

/** 解析 ustar 格式的 tar 字节流为文件成员列表（忽略目录/特殊类型条目）。 */
function parseTar(bytes: Uint8Array): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(b => b === 0)) break; // 全零块：archive 结束标记

    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 0);
    const fullName = prefix ? `${prefix}/${name}` : name;

    offset += 512;
    const dataStart = offset;
    const dataEnd = dataStart + size;
    if (typeflag === '0' || typeflag === '\0') {
      members.push({ name: fullName, size, data: bytes.slice(dataStart, dataEnd) });
    }
    // 目录（'5'）、长链接名等类型跳过，仅前进偏移量
    offset = dataEnd + ((512 - (size % 512)) % 512);
  }
  return members;
}

/** 从 output.tar.gz 二进制内容中提取全部文件成员。 */
export async function extractTarGz(blob: Blob): Promise<TarMember[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const tarBytes = await gunzip(bytes);
  return parseTar(tarBytes);
}

export function findMember(members: TarMember[], filename: string): TarMember | undefined {
  return members.find(m => m.name === filename || m.name.endsWith('/' + filename));
}

export function decodeText(member: TarMember): string {
  return new TextDecoder('utf-8').decode(member.data);
}
