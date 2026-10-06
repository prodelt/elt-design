// Opens a Figma .fig without loading it whole: a studio file saved as a local copy can be 5+ GB
// (a ZIP64 archive of canvas.fig, meta.json and images/<sha1>), past what one Node buffer holds.
// Only the central directory and canvas.fig are read up front; images are read on demand.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { parseFigBinary } from 'openfig-core';
import { SpError } from '../out.mjs';

const SIG = { eocd: 0x06054b50, zip64Locator: 0x07064b50, zip64Eocd: 0x06064b50, central: 0x02014b50, local: 0x04034b50 };

function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = fs.readSync(fd, buf, done, length - done, position + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

// The ZIP central directory: name -> { method, compressed, size, offset }.
function readDirectory(fd, fileSize) {
  const tailLen = Math.min(fileSize, 65557);
  const tail = readAt(fd, fileSize - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === SIG.eocd) { at = i; break; }
  if (at < 0) throw new SpError('fig', 'not a ZIP archive or the download is incomplete (no end-of-directory record)');
  let entries = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = at - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== SIG.zip64Locator) throw new SpError('fig', 'ZIP64 locator missing');
    const eocd64 = readAt(fd, Number(tail.readBigUInt64LE(loc + 8)), 56);
    if (eocd64.readUInt32LE(0) !== SIG.zip64Eocd) throw new SpError('fig', 'ZIP64 end record missing');
    entries = Number(eocd64.readBigUInt64LE(32));
    cdSize = Number(eocd64.readBigUInt64LE(40));
    cdOffset = Number(eocd64.readBigUInt64LE(48));
  }
  const cd = readAt(fd, cdOffset, cdSize);
  const dir = new Map();
  let p = 0;
  for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== SIG.central) throw new SpError('fig', `bad central directory entry ${i}`);
    const method = cd.readUInt16LE(p + 10);
    let compressed = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    // ZIP64 extra field: only the values stored as 0xFFFFFFFF follow, in this order
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (compressed === 0xffffffff) { compressed = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (offset === 0xffffffff) { offset = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    dir.set(name, { method, compressed, size, offset });
    p = end + commentLen;
  }
  return dir;
}

function readEntry(fd, entry) {
  const head = readAt(fd, entry.offset, 30);
  if (head.readUInt32LE(0) !== SIG.local) throw new SpError('fig', 'bad local file header');
  const start = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  const raw = readAt(fd, start, entry.compressed);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new SpError('fig', `unsupported ZIP compression method ${entry.method}`);
}

// { doc, meta, imageNames, image(hash) -> Buffer | null, close() }
export function openFig(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) throw new SpError('fig', `no such file: ${file}`);
  const fd = fs.openSync(file, 'r');
  try {
    const magic = readAt(fd, 0, 8).toString('latin1');
    if (magic === 'fig-kiwi') {
      // a bare canvas without images
      const doc = parseFigBinary(new Uint8Array(readAt(fd, 0, stat.size)));
      fs.closeSync(fd);
      return { doc, meta: null, imageNames: new Set(), image: () => null, close() {} };
    }
    const dir = readDirectory(fd, stat.size);
    const canvas = dir.get('canvas.fig');
    if (!canvas) throw new SpError('fig', 'the archive has no canvas.fig');
    const doc = parseFigBinary(new Uint8Array(readEntry(fd, canvas)));
    const metaEntry = dir.get('meta.json');
    const meta = metaEntry ? JSON.parse(readEntry(fd, metaEntry).toString('utf8')) : null;
    const imageNames = new Set([...dir.keys()].filter((n) => n.startsWith('images/') && n.length > 7).map((n) => n.slice(7)));
    let open = true;
    return {
      doc,
      meta,
      imageNames,
      image(hash) {
        const entry = dir.get('images/' + hash);
        return entry && open ? readEntry(fd, entry) : null;
      },
      close() {
        if (open) fs.closeSync(fd);
        open = false;
      },
    };
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    throw e;
  }
}
