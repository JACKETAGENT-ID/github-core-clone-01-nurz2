// gitpack.ts — git object model: hashing, pack read/write (plain + delta),
// pkt-line codec, tree/commit parse + build. Pure functions over Buffers.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { ZERO_OID } from './util.ts';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  /** Raw object body (without the `type len\0` header). */
  data: Buffer;
}

export function sha1(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex');
}

/** The object id of (type, data). */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

export function isValidOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// -------------------------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('pkt-line: truncated length');
    const hex = buf.subarray(off, off + 4).toString('ascii');
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error(`pkt-line: bad length ${hex}`);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      off += 4;
    } else {
      if (off + len > buf.length) throw new Error('pkt-line: truncated payload');
      out.push({ kind: 'data', payload: Buffer.from(buf.subarray(off + 4, off + len)) });
      off += len;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------- pack I/O

const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Inflate the zlib stream starting at the front of `buf` and return its data plus
 * the number of input bytes the stream consumed. One inflateSync with `{info: true}`
 * reports the exact consumed length (engine.bytesWritten), so no probing is needed.
 */
function inflateObject(buf: Buffer): { data: Buffer; consumed: number } {
  const result = inflateSync(buf, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off]!;
      off += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta: base size mismatch');
  const chunks: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off]!;
    off += 1;
    if ((op & 0x80) !== 0) {
      let cpOff = 0;
      let cpSize = 0;
      let p = off;
      if (op & 0x01) { cpOff = delta[p]!; p += 1; }
      if (op & 0x02) { cpOff |= delta[p]! << 8; p += 1; }
      if (op & 0x04) { cpOff |= delta[p]! << 16; p += 1; }
      if (op & 0x08) { cpOff |= delta[p]! << 24; p += 1; }
      if (op & 0x10) { cpSize = delta[p]!; p += 1; }
      if (op & 0x20) { cpSize |= delta[p]! << 8; p += 1; }
      if (op & 0x40) { cpSize |= delta[p]! << 16; p += 1; }
      off = p;
      if (cpSize === 0) cpSize = 0x10000;
      chunks.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      chunks.push(delta.subarray(off, off + op));
      produced += op;
      off += op;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  if (produced !== dstSize) throw new Error('delta: target size mismatch');
  return Buffer.concat(chunks);
}

/** Parse a pack (v2) into a map oid -> object. Handles plain, OFS_DELTA and REF_DELTA. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 12) throw new Error('pack: too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad signature');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack: unsupported version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  // Objects are indexed by pack offset for OFS_DELTA resolution.
  const byOffset = new Map<number, GitObject>();
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const startOff = off;
    const first = buf[off]!;
    const typeNum = (first >> 4) & 0x7;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while ((buf[off - 1]! & 0x80) !== 0) {
      size |= (buf[off]! & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeNum === 6) {
      // OFS_DELTA: negative offset to base.
      let baseOff = buf[off]!;
      off += 1;
      while ((baseOff & 0x80) !== 0) {
        baseOff = ((baseOff + 1) << 7) | (buf[off]! & 0x7f);
        off += 1;
      }
      const baseObj = byOffset.get(startOff - baseOff);
      if (baseObj === undefined) throw new Error('pack: ofs-delta base not found');
      const { data: raw, consumed } = inflateObject(buf.subarray(off));
      off += consumed;
      data = applyDelta(baseObj.data, raw);
      type = baseObj.type;
    } else if (typeNum === 7) {
      // REF_DELTA: base oid.
      const baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
      const baseObj = objects.get(baseOid);
      if (baseObj === undefined) throw new Error('pack: ref-delta base not found');
      const { data: raw, consumed } = inflateObject(buf.subarray(off));
      off += consumed;
      data = applyDelta(baseObj.data, raw);
      type = baseObj.type;
    } else {
      type = PACK_TYPES[typeNum]!;
      if (type === undefined) throw new Error(`pack: unknown object type ${typeNum}`);
      const inflated = inflateObject(buf.subarray(off));
      data = inflated.data;
      off += inflated.consumed;
    }
    if (data.length !== size) throw new Error('pack: object size mismatch');
    const oid = hashObject(type, data);
    const obj: GitObject = { type, data };
    objects.set(oid, obj);
    byOffset.set(startOff, obj);
  }
  // Verify trailer SHA-1.
  const trailer = buf.subarray(buf.length - 20);
  const computed = sha1(buf.subarray(0, buf.length - 20));
  if (!trailer.equals(Buffer.from(computed, 'hex'))) throw new Error('pack: bad trailer checksum');
  return objects;
}

/** Build a pack (v2, plain objects, no deltas) from a list of objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const headBytes: number[] = [];
    let remaining = size;
    headBytes.push(((typeId & 0x7) << 4) | (remaining & 0x0f));
    remaining >>= 4;
    while (remaining > 0) {
      headBytes[headBytes.length - 1]! |= 0x80;
      headBytes.push(remaining & 0x7f);
      remaining >>= 7;
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** An empty pack (0 objects): 12-byte header + 20-byte trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

// -------------------------------------------------------------------------------- object text formats

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) throw new Error('tree: bad entry');
    const mode = data.subarray(off, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0) throw new Error('tree: bad entry');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries (sorted in git order: name, dirs compared as name + '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit: no tree');
  return { tree, parents, author, committer, message };
}

/** Build a commit object. */
export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const p of info.parents) lines.push(`parent ${p}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag object. */
export function buildTag(info: TagInfo): Buffer {
  return Buffer.from(`object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${info.message}`, 'utf8');
}

/** Peel a tag (possibly nested) to its target commit/tree oid, or the oid itself when not a tag. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const obj = objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return cur;
    cur = parseTag(obj.data).object;
  }
}

export { ZERO_OID };
