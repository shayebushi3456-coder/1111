/* ============================================================
   零依赖 ZIP 编码器（STORE，无压缩）
   用于浏览器端聚合导出某次执行的多个产物文件为一个 zip。
   ============================================================ */

export interface ZipEntry {
  name: string;
  data: Uint8Array | string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toUtf8(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return input;
}

function dosDateTime(d: Date): { date: number; time: number } {
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  return { date, time };
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff];
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

export function createZip(files: ZipEntry[], now: Date = new Date()): Blob {
  const { date, time } = dosDateTime(now);
  const chunks: Uint8Array[] = [];
  const centralRecords: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = new TextEncoder().encode(file.name);
    const dataBytes = toUtf8(file.data);
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    const localHeader = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, // local file header signature
      ...u16(20), // version needed
      ...u16(0x0800), // flags: UTF-8 filename
      ...u16(0), // compression: store
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(size), // compressed size
      ...u32(size), // uncompressed size
      ...u16(nameBytes.length),
      ...u16(0), // extra field length
    ]);

    chunks.push(localHeader, nameBytes, dataBytes);
    const localHeaderOffset = offset;
    offset += localHeader.length + nameBytes.length + dataBytes.length;

    const centralHeader = new Uint8Array([
      0x50, 0x4b, 0x01, 0x02, // central directory signature
      ...u16(20), // version made by
      ...u16(20), // version needed
      ...u16(0x0800),
      ...u16(0),
      ...u16(time),
      ...u16(date),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(nameBytes.length),
      ...u16(0), // extra length
      ...u16(0), // comment length
      ...u16(0), // disk number start
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(localHeaderOffset),
    ]);
    centralRecords.push(centralHeader, nameBytes);
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const rec of centralRecords) centralDirSize += rec.length;

  const eocd = new Uint8Array([
    0x50, 0x4b, 0x05, 0x06, // end of central directory signature
    ...u16(0), // disk number
    ...u16(0), // disk with central dir
    ...u16(files.length), // entries on this disk
    ...u16(files.length), // total entries
    ...u32(centralDirSize),
    ...u32(centralDirOffset),
    ...u16(0), // comment length
  ]);

  return new Blob([...chunks, ...centralRecords, eocd] as BlobPart[], { type: 'application/zip' });
}

export function downloadZip(files: ZipEntry[], zipName: string): void {
  const blob = createZip(files);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
