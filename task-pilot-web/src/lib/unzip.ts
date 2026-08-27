/* ============================================================
   零依赖 ZIP 解包器
   用于浏览器端读取用户导入的用例集 zip。支持 STORE(0) 与常见 DEFLATE(8)。
   ============================================================ */

export interface UnzipEntry {
  name: string;
  data: Uint8Array;
  size: number;
}

function u16(bytes: Uint8Array, off: number): number {
  return bytes[off] | (bytes[off + 1] << 8);
}
function u32(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
}
function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.length - 0xffff - 22);
  for (let i = bytes.length - 22; i >= min; i--) {
    if (u32(bytes, i) === 0x06054b50) return i;
  }
  throw new Error('未找到 ZIP 中央目录，请确认文件为有效 zip');
}
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持解压 deflate zip，请使用未压缩 zip 或升级浏览器');
  }
  const ds = new DecompressionStream('deflate-raw' as CompressionFormat);
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export async function unzip(blob: Blob): Promise<UnzipEntry[]> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const eocd = findEocd(bytes);
  const total = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  const entries: UnzipEntry[] = [];

  for (let i = 0; i < total; i++) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error('ZIP 中央目录结构异常');
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const uncompressedSize = u32(bytes, offset + 24);
    const nameLen = u16(bytes, offset + 28);
    const extraLen = u16(bytes, offset + 30);
    const commentLen = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = new TextDecoder(flags & 0x0800 ? 'utf-8' : 'utf-8').decode(nameBytes).replace(/\\/g, '/');
    offset += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/')) continue;
    if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`ZIP 本地文件头异常：${name}`);
    const localNameLen = u16(bytes, localOffset + 26);
    const localExtraLen = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = bytes.slice(dataStart, dataStart + compressedSize);
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`暂不支持 ZIP 压缩方式 ${method}：${name}`);
    entries.push({ name, data, size: uncompressedSize || data.length });
  }
  return entries;
}

export function decodeZipText(entry: UnzipEntry): string {
  return new TextDecoder('utf-8').decode(entry.data);
}
