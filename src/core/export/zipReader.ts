/**
 * Pure zero-dependency RFC-compliant ZIP archive reader.
 * Supports compression method 0 (Store) and method 8 (Deflate via standard Web `DecompressionStream('deflate-raw')`),
 * verifies IEEE 802.3 CRC-32 checksums, rejects path traversal, and safely unwraps a shared single wrapper root folder.
 */
import { computeCrc32 } from './zipWriter';

export interface ZipReadEntry {
  /** Normalized forward-slash relative path inside the archive. */
  path: string;
  bytes: Uint8Array;
}

const utf8Decoder = new TextDecoder('utf-8');

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('当前运行环境不支持 Deflate 压缩的 ZIP 解包');
  }
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  const payload = new Uint8Array(compressed.byteLength);
  payload.set(compressed);
  const writePromise = writer.write(payload).then(() => writer.close());
  writePromise.catch(() => {
    // Prevent unhandled rejection when reader throws early on corrupt deflate stream
  });
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
    await writePromise;
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function findEocdOffset(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === bytes.length) {
        return i;
      }
    }
  }
  return -1;
}

function sanitizeZipPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`ZIP 包含非法路径穿越条目: ${rawPath}`);
  }
  return segments.join('/');
}

/**
 * Strips a single shared top-level wrapper folder (e.g. `my_robot/project.polyblock.json`
 * created when re-zipping an extracted folder in Finder/Explorer) while preserving
 * canonical root folders (`extensions/`, `boards/`).
 */
function unwrapSingleTopDirectory(entries: ZipReadEntry[]): ZipReadEntry[] {
  if (entries.length === 0) return entries;
  const firstSegments = new Set<string>();
  for (const entry of entries) {
    const slashIdx = entry.path.indexOf('/');
    if (slashIdx <= 0) return entries; // At least one file is already at root
    firstSegments.add(entry.path.slice(0, slashIdx));
    if (firstSegments.size > 1) return entries;
  }
  const [onlyRoot] = Array.from(firstSegments);
  if (onlyRoot === 'extensions' || onlyRoot === 'boards') {
    return entries;
  }
  const prefix = `${onlyRoot}/`;
  return entries.map((e) => ({
    path: e.path.slice(prefix.length),
    bytes: e.bytes,
  }));
}

/** Returns true if the byte buffer begins with a standard PKZIP signature (`PK\x03\x04` or `PK\x05\x06`). */
export function isZipBuffer(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/** Parses a standard `.zip` binary buffer into UTF-8/binary entries with CRC-32 verification. */
export async function readZipBytes(bytes: Uint8Array): Promise<ZipReadEntry[]> {
  if (bytes.length < 22) {
    throw new Error('ZIP 文件长度无效');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocdOffset(bytes);
  if (eocdOffset < 0) {
    throw new Error('无效的 ZIP 文件（未找到中央目录结束标记）');
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset + cdSize > bytes.length) {
    throw new Error('ZIP 中央目录越界或文件已损坏');
  }

  const entries: ZipReadEntry[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.length) {
      throw new Error('ZIP 中央目录记录截断');
    }
    const sig = view.getUint32(cursor, true);
    if (sig !== 0x02014b50) {
      throw new Error('ZIP 中央目录签名异常');
    }
    const method = view.getUint16(cursor + 10, true);
    const expectedCrc = view.getUint32(cursor + 16, true);
    const compSize = view.getUint32(cursor + 20, true);
    const uncompSize = view.getUint32(cursor + 24, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);

    const rawName = utf8Decoder.decode(
      bytes.subarray(cursor + 46, cursor + 46 + nameLen),
    );
    cursor += 46 + nameLen + extraLen + commentLen;

    // Skip directory entries (POSIX `/` or Windows `\`) and macOS Finder metadata (`__MACOSX`, `._*`)
    if (rawName.endsWith('/') || rawName.endsWith('\\')) {
      continue;
    }

    const cleanPath = sanitizeZipPath(rawName);
    if (!cleanPath) continue;
    const segments = cleanPath.split('/');
    const baseName = segments[segments.length - 1] ?? '';
    if (segments.includes('__MACOSX') || baseName.startsWith('._')) {
      continue;
    }

    if (localHeaderOffset + 30 > bytes.length) {
      throw new Error(`ZIP 本地文件头越界: ${cleanPath}`);
    }
    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== 0x04034b50) {
      throw new Error(`ZIP 本地文件头签名无效: ${cleanPath}`);
    }
    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > bytes.length) {
      throw new Error(`ZIP 条目数据截断: ${cleanPath}`);
    }

    const compBytes = bytes.subarray(dataStart, dataEnd);
    let outBytes: Uint8Array;
    if (method === 0) {
      outBytes = compBytes.slice();
    } else if (method === 8) {
      outBytes = await inflateRaw(compBytes);
    } else {
      throw new Error(`不支持的 ZIP 压缩方式 (${method}): ${cleanPath}`);
    }

    if (outBytes.length !== uncompSize) {
      throw new Error(`ZIP 条目解压长度不匹配: ${cleanPath}`);
    }
    if (computeCrc32(outBytes) !== expectedCrc) {
      throw new Error(`ZIP 条目 CRC-32 校验失败: ${cleanPath}`);
    }

    entries.push({ path: cleanPath, bytes: outBytes });
  }

  return unwrapSingleTopDirectory(entries);
}

export function decodeZipEntryText(entry: ZipReadEntry): string {
  return utf8Decoder.decode(entry.bytes);
}
