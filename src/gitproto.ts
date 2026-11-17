// gitproto.ts — git smart HTTP: v0/v2 advertisements, ls-refs, fetch (upload-pack)
// and receive-pack (push). Speaks the exact wire formats the suite's git client
// sends and parses (pkt-line, sideband, report-status).

import {
  PKT_DELIM,
  PKT_FLUSH,
  decodePktLines,
  emptyPack,
  hashObject,
  parseTag,
  pktLine,
  readPack,
  writePack,
  type GitObject,
} from './gitpack.ts';
import { DEFAULT_BRANCH, type Forge, type Repo } from './db.ts';
import { ZERO_OID } from './util.ts';

const AGENT = 'forge/1.0';
const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} multi_ack_detailed thin-pack side-band-64k ofs-delta shallow agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function textResult(status: number, body: string, contentType = 'application/json'): HttpResult {
  return { status, contentType, body: Buffer.from(body, 'utf8') };
}

/** All refs of a repo, sorted; annotated tags carry their peeled target on the same entry. */
function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const lines: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { oid: string; name: string; peeled?: string } = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        entry.peeled = parseTag(obj.data).object;
      }
    }
    lines.push(entry);
  }
  return lines;
}

/** v0 advertisement body for a service. */
function advertiseV0(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = refLines(repo);
  const textLines: string[] = [];
  if (lines.length === 0) {
    textLines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (headOid !== undefined) textLines.push(`${headOid} HEAD`);
    for (const line of lines) {
      textLines.push(`${line.oid} ${line.name}`);
      // Peeled tags get a separate `<target> <ref>^{}` line in v0.
      if (line.peeled !== undefined) textLines.push(`${line.peeled} ${line.name}^{}`);
    }
  }
  textLines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 advertisement body (upload-pack only). */
function advertiseV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine(`object-format=sha1\n`),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

/** GET /{owner}/{repo}.git/info/refs */
export function handleInfoRefs(
  forge: Forge,
  owner: string,
  repoName: string,
  service: string,
  gitProtocol: string,
): HttpResult {
  if (owner !== 'adaiversen') return textResult(404, JSON.stringify({ message: 'Not Found' }));
  const repo = forge.getRepo(repoName);
  if (repo === undefined) return textResult(404, JSON.stringify({ message: 'Not Found' }));
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0('git-upload-pack', repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0('git-receive-pack', repo) };
  }
  return textResult(404, JSON.stringify({ message: 'Not Found' }));
}

/** Read pkt-lines from the front of `buf` until the first flush; returns lines + rest offset. */
function readSection(buf: Buffer, start: number): { lines: string[]; next: number } {
  const lines: string[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const len = parseInt(buf.subarray(off, off + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) return { lines, next: off + 4 };
    if (len < 4 || off + len > buf.length) break;
    lines.push(buf.subarray(off + 4, off + len).toString('utf8'));
    off += len;
  }
  return { lines, next: off };
}

/** Chunk a pack into sideband band-1 packets (payload ≤ 65516 incl. the band byte). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const slice = pack.subarray(off, Math.min(off + CHUNK, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

/** Shallow-info that belongs to a cached pack (keyed by the same request signature). */
const packMeta = new WeakMap<Repo, Map<string, { shallow: string[]; unshallow: string[] }>>();

function metaFor(repo: Repo): Map<string, { shallow: string[]; unshallow: string[] }> {
  let meta = packMeta.get(repo);
  if (meta === undefined) {
    meta = new Map();
    packMeta.set(repo, meta);
  }
  return meta;
}

/** Build (or reuse from cache) the fetch pack + shallow info for one request signature. */
function fetchPack(
  repo: Repo,
  forge: Forge,
  key: string,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowIn: readonly string[],
): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const cached = repo.packCache.get(key);
  if (cached !== undefined) {
    const entry = metaFor(repo).get(key);
    return { pack: cached, shallow: entry?.shallow ?? [], unshallow: entry?.unshallow ?? [] };
  }
  const result = forge.fetchSet(repo, wants, haves, depth, shallowIn);
  const objects = [...result.objects.values()].sort((a, b) => {
    const oa = hashObject(a.type, a.data);
    const ob = hashObject(b.type, b.data);
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  const pack = writePack(objects);
  repo.packCache.set(key, pack);
  metaFor(repo).set(key, { shallow: result.shallow, unshallow: result.unshallow });
  return { pack, shallow: result.shallow, unshallow: result.unshallow };
}
function lsRefsV2(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  const lines = refLines(repo);
  if (lines.length === 0) {
    if (unborn && keep('HEAD')) parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
  } else {
    if (headOid !== undefined && keep('HEAD')) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`));
    }
    for (const line of lines) {
      if (!keep(line.name)) continue;
      // One line per ref; an annotated tag peels in place: <tag oid> <ref> peeled:<target>.
      parts.push(pktLine(peel && line.peeled !== undefined ? `${line.oid} ${line.name} peeled:${line.peeled}\n` : `${line.oid} ${line.name}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 fetch response (acknowledgments + shallow-info + packfile sections). */
function fetchV2(repo: Repo, forge: Forge, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowIn: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowIn.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
  }
  const key = JSON.stringify({ wants, haves, depth, shallowIn });
  const { pack, shallow, unshallow } = fetchPack(repo, forge, key, wants, haves, depth, shallowIn);
  const parts: Buffer[] = [
    pktLine('acknowledgments\n'),
    pktLine('NAK\n'),
    PKT_FLUSH,
  ];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 fetch response: NAK + shallow lines + sideband pack. */
function fetchV0(repo: Repo, forge: Forge, wants: string[], haves: string[], shallowIn: string[], depth: number | null): Buffer {
  const key = JSON.stringify({ wants, haves, depth, shallowIn, v0: true });
  const { pack, shallow, unshallow } = fetchPack(repo, forge, key, wants, haves, depth, shallowIn);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
  gitProtocol: string,
): HttpResult {
  if (owner !== 'adaiversen') return textResult(404, JSON.stringify({ message: 'Not Found' }));
  const repo = forge.getRepo(repoName);
  if (repo === undefined) return textResult(404, JSON.stringify({ message: 'Not Found' }));
  const resultType = 'application/x-git-upload-pack-result';
  try {
    if (gitProtocol === 'version=2') {
      const packets = decodePktLines(body);
      const first = packets.find((p) => p.kind === 'data');
      const command = first?.payload.toString('utf8').trim() ?? '';
      const args: string[] = [];
      let seenDelim = false;
      for (const p of packets) {
        if (p.kind === 'delim') {
          seenDelim = true;
          continue;
        }
        if (p.kind !== 'data' || !seenDelim) continue;
        args.push(p.payload.toString('utf8').replace(/\n$/, ''));
      }
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: resultType, body: lsRefsV2(repo, args) };
      }
      if (command === 'command=fetch') {
        return { status: 200, contentType: resultType, body: fetchV2(repo, forge, args) };
      }
      return textResult(400, JSON.stringify({ message: `unknown v2 command ${JSON.stringify(command)}` }));
    }
    // v0: wants section, flush, haves section, flush.
    const first = readSection(body, 0);
    const second = readSection(body, first.next);
    const wants: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | null = null;
    for (const line of first.lines) {
      const clean = line.split('\0')[0]!.trim();
      if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
      else if (clean.startsWith('shallow ')) shallowIn.push(clean.slice(8).trim());
      else if (clean.startsWith('deepen ')) depth = parseInt(clean.slice(7).trim(), 10);
    }
    const haves: string[] = [];
    for (const line of second.lines) {
      const clean = line.trim();
      if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    }
    return { status: 200, contentType: resultType, body: fetchV0(repo, forge, wants, haves, shallowIn, depth) };
  } catch (err) {
    return textResult(400, JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(
  forge: Forge,
  owner: string,
  repoName: string,
  body: Buffer,
): HttpResult {
  if (owner !== 'adaiversen') return textResult(404, JSON.stringify({ message: 'Not Found' }));
  const repo = forge.getRepo(repoName);
  if (repo === undefined) return textResult(404, JSON.stringify({ message: 'Not Found' }));
  const resultType = 'application/x-git-receive-pack-result';
  const report = (unpackOk: boolean, unpackDetail: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): Buffer => {
    const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
    for (const r of refs) inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
    inner.push(PKT_FLUSH);
    return sidebandPack(Buffer.concat(inner));
  };
  try {
    const section = readSection(body, 0);
    const commands: PushCommand[] = [];
    for (const line of section.lines) {
      const clean = line.split('\0')[0]!.trim();
      if (clean === '') continue;
      const parts = clean.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
    if (commands.length === 0) {
      return { status: 200, contentType: resultType, body: report(true, 'ok', []) };
    }
    const packBytes = body.subarray(section.next);
    const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
    let unpacked = new Map<string, GitObject>();
    if (hasUpdates) {
      if (packBytes.length === 0) {
        return { status: 200, contentType: resultType, body: report(false, 'unpack failed: no pack', commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))) };
      }
      try {
        unpacked = readPack(packBytes);
      } catch (err) {
        return { status: 200, contentType: resultType, body: report(false, `unpack failed: ${err instanceof Error ? err.message : 'bad pack'}`, commands.map((c) => ({ ref: c.ref, ok: false, reason: 'unpack failed' }))) };
      }
      for (const [oid, obj] of unpacked) repo.objects.set(oid, obj);
    }
    const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(cmd.ref);
          results.push({ ref: cmd.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update/create: the new tip must exist (in the pack or already stored).
      if (repo.objects.get(cmd.newOid) === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) {
          results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
        continue;
      }
      if (cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!forge.isAncestor(repo, current, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      results.push({ ref: cmd.ref, ok: true, reason: '' });
    }
    repo.invalidatePackCache();
    return { status: 200, contentType: resultType, body: report(true, 'ok', results) };
  } catch (err) {
    return textResult(400, JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
  }
}
