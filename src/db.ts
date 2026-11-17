// db.ts — the forge's whole state: repositories, git objects and refs, issues,
// pull requests, labels and comments. In-memory, deterministic (timestamps from a
// monotonic counter), no filesystem. One owner: the scenario viewer.

import {
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './gitpack.ts';
import { SeqClock, b64uDecode, b64uEncode, diffLineCounts, splitPath } from './util.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'Ada Iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export class Repo {
  readonly id: number;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly createdAt: string;
  /** refname -> commit/tag oid */
  readonly refs = new Map<string, string>();
  /** oid -> object */
  readonly objects = new Map<string, GitObject>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();
  readonly labels = new Map<string, Label>();
  readonly comments = new Map<number, Comment[]>();
  /** shared issue + pull-request counter (GitHub semantics) */
  counter = 0;
  private commentSeq = 0;
  /** fetch pack cache: request signature -> pack bytes */
  readonly packCache = new Map<string, Buffer>();
  /** cached serialized GET-issue bodies, per issue number */
  readonly issueJsonCache = new Map<number, string>();

  constructor(id: number, name: string, description: string, isPrivate: boolean, createdAt: string) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
    this.createdAt = createdAt;
  }

  nextNumber(): number {
    this.counter += 1;
    return this.counter;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  invalidatePackCache(): void {
    this.packCache.clear();
  }

  invalidateIssue(number: number): void {
    this.issueJsonCache.delete(number);
  }
}

export class Forge {
  readonly clock = new SeqClock(1_700_000_000);
  private repoSeq = 0;
  readonly repos = new Map<string, Repo>();
  /** repo creation order (for GET /user/repos pagination) */
  readonly repoOrder: Repo[] = [];

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(name)) return null;
    this.repoSeq += 1;
    const repo = new Repo(this.repoSeq, name, description, isPrivate, this.clock.nextIso());
    this.repos.set(name, repo);
    this.repoOrder.push(repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (repo === undefined) return false;
    this.repos.delete(name);
    const idx = this.repoOrder.indexOf(repo);
    if (idx >= 0) this.repoOrder.splice(idx, 1);
    return true;
  }

  // ---------------------------------------------------------- global (Relay) ids

  repoGlobalId(repo: Repo): string {
    return b64uEncode(`R:${repo.id}`);
  }

  issueGlobalId(repo: Repo, number: number): string {
    return b64uEncode(`I:${repo.id}:${number}`);
  }

  prGlobalId(repo: Repo, number: number): string {
    return b64uEncode(`P:${repo.id}:${number}`);
  }

  commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
    return b64uEncode(`C:${repo.id}:${issueNumber}:${commentId}`);
  }

  /** Decode a global id: [kind, repoId, number?, commentId?]. */
  decodeGlobalId(id: string): { kind: string; repoId: number; number: number; commentId: number } | null {
    const text = b64uDecode(id);
    if (text === null) return null;
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number(parts[1]);
    if (!Number.isInteger(repoId) || repoId <= 0) return null;
    return {
      kind,
      repoId,
      number: parts.length > 2 ? Number(parts[2]) : 0,
      commentId: parts.length > 3 ? Number(parts[3]) : 0,
    };
  }

  repoByGlobalId(id: string): Repo | null {
    const decoded = this.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'R') return null;
    for (const repo of this.repoOrder) if (repo.id === decoded.repoId) return repo;
    return null;
  }

  // ---------------------------------------------------------- git object helpers

  static authorLine(epoch: number): string {
    return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  }

  /** Store an object (recomputing its oid); returns the oid. */
  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Is `ancestor` an ancestor of `oid` (or equal)? Follows all parents. */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const seen = new Set<string>();
    const stack: string[] = [oid];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return false;
  }

  /** All commit oids reachable from `oid` (peeling tags), with BFS distance from the root. */
  commitDistances(repo: Repo, oid: string): Map<string, number> {
    const dist = new Map<string, number>();
    const root = peelToCommit(repo.objects, oid);
    const queue: Array<[string, number]> = [[root, 0]];
    while (queue.length > 0) {
      const [cur, d] = queue.shift()!;
      if (dist.has(cur)) continue;
      dist.set(cur, d);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (!dist.has(p)) queue.push([p, d + 1]);
      }
    }
    return dist;
  }

  /**
   * The object closure of a set of oids, stopping at `boundaries`: a boundary commit
   * contributes itself and its tree, but not its parents (a shallow clone's client
   * holds the boundary, never the history behind it). Used for the haves side of a
   * fetch, where the client's shallow list names its boundaries.
   */
  boundedClosure(repo: Repo, roots: Iterable<string>, boundaries: Iterable<string>): Map<string, GitObject> {
    const boundarySet = new Set<string>();
    for (const b of boundaries) boundarySet.add(peelToCommit(repo.objects, b));
    const out = new Map<string, GitObject>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        if (!boundarySet.has(oid)) for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /** Full object closure of a set of oids (commits, trees, blobs, tags). */
  closure(repo: Repo, roots: Iterable<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        stack.push(c.tree);
        for (const p of c.parents) stack.push(p);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /**
   * The fetch set for wants/haves/depth/shallow, mirroring git's shallow protocol:
   * included commits are those with distance < depth from a want (all when depth is absent);
   * shallow = included commits with a parent outside the set; unshallow = old boundaries
   * that are now fully included. The object set is closure(included) minus closure(haves).
   */
  fetchSet(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth: number | null,
    shallowIn: readonly string[],
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const included = new Set<string>();
    const wantedTags: string[] = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (obj === undefined) continue;
      if (obj.type === 'tag') {
        wantedTags.push(want);
        const target = peelToCommit(repo.objects, want);
        const dists = this.commitDistances(repo, target);
        for (const [oid, d] of dists) if (depth === null || d < depth) included.add(oid);
      } else if (obj.type === 'commit') {
        const dists = this.commitDistances(repo, want);
        for (const [oid, d] of dists) if (depth === null || d < depth) included.add(oid);
      } else {
        included.add(want);
      }
    }
    const shallow: string[] = [];
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => !included.has(p))) shallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const b of shallowIn) {
      if (!included.has(b)) continue;
      const obj = repo.objects.get(b);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (parseCommit(obj.data).parents.every((p) => included.has(p))) unshallow.push(b);
    }
    // Objects: the included commits with their tree closures only — never their
    // parents (a depth-limited fetch must not leak history past the boundary).
    const objects = new Map<string, GitObject>();
    const addTreeClosure = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (objects.has(oid)) continue;
        const obj = repo.objects.get(oid);
        if (obj === undefined) continue;
        objects.set(oid, obj);
        if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    };
    for (const oid of included) {
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      objects.set(oid, obj);
      if (obj.type === 'commit') addTreeClosure(parseCommit(obj.data).tree);
      else if (obj.type === 'tree') addTreeClosure(oid);
    }
    for (const tag of wantedTags) {
      const obj = repo.objects.get(tag);
      if (obj !== undefined) objects.set(tag, obj);
    }
    // The client already holds the haves — but only up to its shallow boundaries:
    // a shallow clone's boundary commit is held, its parents are not.
    const haveClosure = this.boundedClosure(repo, haves, shallowIn);
    for (const oid of haveClosure.keys()) objects.delete(oid);
    return { objects, shallow, unshallow };
  }

  /** Flat file map (path -> {mode, oid}) of a commit's tree, recursively. */
  treeFiles(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const obj = repo.objects.get(commitOid);
    if (obj === undefined || obj.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const e of parseTree(tree.data)) {
        if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
        else out.set(`${prefix}${e.name}`, { mode: e.mode, oid: e.oid });
      }
    };
    walk(parseCommit(obj.data).tree, '');
    return out;
  }

  /** Build a tree object from a flat file map (nested dirs created as needed). */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    // Group by directory, bottom-up.
    const dirs = new Map<string, TreeEntry[]>();
    const ensureDir = (dir: string): TreeEntry[] => {
      let list = dirs.get(dir);
      if (list === undefined) {
        list = [];
        dirs.set(dir, list);
      }
      return list;
    };
    ensureDir('');
    for (const [path, file] of files) {
      const parts = splitPath(path);
      const name = parts.pop()!;
      const dir = parts.join('/');
      ensureDir(dir).push({ mode: file.mode, name, oid: file.oid });
      // Register parent dirs as tree entries in their own parent.
      let cur = dir;
      while (cur !== '') {
        const parentParts = cur.split('/');
        const base = parentParts.pop()!;
        const parent = parentParts.join('/');
        const list = ensureDir(parent);
        if (!list.some((e) => e.mode === '40000' && e.name === base)) {
          list.push({ mode: '40000', name: base, oid: '' });
        }
        cur = parent;
      }
    }
    // Build trees depth-first (deepest first; root '' is depth 0).
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const sortedDirs = [...dirs.keys()].sort((a, b) => depthOf(b) - depthOf(a));
    const treeOids = new Map<string, string>();
    for (const dir of sortedDirs) {
      const entries = dirs.get(dir)!;
      for (const e of entries) {
        if (e.mode === '40000') e.oid = treeOids.get(dir === '' ? e.name : `${dir}/${e.name}`) ?? '';
      }
      const data = buildTree(entries);
      const oid = hashObject('tree', data);
      repo.objects.set(oid, { type: 'tree', data });
      treeOids.set(dir, oid);
    }
    return treeOids.get('')!;
  }

  /**
   * Create a commit on `branch` applying file changes (Buffer = new content, null = delete).
   * Creates the branch from the default branch tip when it does not exist yet.
   * Returns the new commit oid, or null when the branch has no base commit.
   */
  commitFiles(
    repo: Repo,
    branch: string,
    message: string,
    changes: Map<string, Buffer | null>,
  ): string | null {
    const ref = `refs/heads/${branch}`;
    let parent = repo.refs.get(ref);
    if (parent === undefined && branch !== DEFAULT_BRANCH) {
      parent = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
      if (parent === undefined) return null;
    }
    const files = parent === undefined ? new Map<string, { mode: string; oid: string }>() : this.treeFiles(repo, parent);
    for (const [path, content] of changes) {
      if (content === null) files.delete(path);
      else {
        const oid = this.putObject(repo, 'blob', content);
        files.set(path, { mode: '100644', oid });
      }
    }
    const treeOid = this.buildTreeFromFiles(repo, files);
    const epoch = this.clock.nextEpoch();
    const author = Forge.authorLine(epoch);
    const commit = buildCommit({
      tree: treeOid,
      parents: parent === undefined ? [] : [parent],
      message,
      author,
      committer: author,
    });
    const commitOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitOid);
    repo.invalidatePackCache();
    return commitOid;
  }

  /** The merge-base of two commits (nearest common ancestor), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const distA = this.commitDistances(repo, a);
    if (distA.has(b)) return b;
    // BFS from b, first commit also in distA wins (closest to b).
    const seen = new Set<string>();
    const queue: string[] = [peelToCommit(repo.objects, b)];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (distA.has(cur)) return cur;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return null;
  }

  /** Files changed between two commits: [{path, status, oldOid, newOid}]. */
  diffCommits(
    repo: Repo,
    fromOid: string,
    toOid: string,
  ): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
    const from = this.treeFiles(repo, fromOid);
    const to = this.treeFiles(repo, toOid);
    const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const path of [...paths].sort()) {
      const f = from.get(path);
      const t = to.get(path);
      if (f === undefined && t !== undefined) out.push({ path, status: 'added', oldOid: null, newOid: t.oid });
      else if (f !== undefined && t === undefined) out.push({ path, status: 'removed', oldOid: f.oid, newOid: null });
      else if (f !== undefined && t !== undefined && f.oid !== t.oid) out.push({ path, status: 'modified', oldOid: f.oid, newOid: t.oid });
    }
    return out;
  }

  /** The base branch's current tip (the base side moves when other PRs merge). */
  currentBaseTip(repo: Repo, pr: PullRequest): string {
    return repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  }

  /** Whether merging `pr` would conflict (same file changed differently on both sides of the base). */
  prConflicts(repo: Repo, pr: PullRequest): boolean {
    const baseTip = this.currentBaseTip(repo, pr);
    const base = this.mergeBase(repo, baseTip, pr.headSha);
    if (base === null) return true;
    const headChanges = this.diffCommits(repo, base, pr.headSha);
    const baseChanges = this.diffCommits(repo, base, baseTip);
    const baseChanged = new Map(baseChanges.map((c) => [c.path, c.newOid]));
    for (const c of headChanges) {
      if (baseChanged.has(c.path) && baseChanged.get(c.path) !== c.newOid) return true;
    }
    return false;
  }

  /** Squash-merge a pull request. Returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    if (pr.merged) return pr.mergeCommitSha;
    if (this.prConflicts(repo, pr)) return null;
    const baseTip = this.currentBaseTip(repo, pr);
    const base = this.mergeBase(repo, baseTip, pr.headSha);
    if (base === null) return null;
    const files = this.treeFiles(repo, baseTip);
    for (const c of this.diffCommits(repo, base, pr.headSha)) {
      if (c.newOid === null) files.delete(c.path);
      else files.set(c.path, { mode: '100644', oid: c.newOid });
    }
    const treeOid = this.buildTreeFromFiles(repo, files);
    const epoch = this.clock.nextEpoch();
    const author = Forge.authorLine(epoch);
    const commit = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      message: `${pr.title} (#${pr.number})\n`,
      author,
      committer: author,
    });
    const commitOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
    pr.merged = true;
    pr.state = 'closed';
    pr.mergedAt = new Date(epoch * 1000).toISOString();
    pr.mergeCommitSha = commitOid;
    pr.updatedAt = pr.mergedAt;
    repo.invalidatePackCache();
    return commitOid;
  }

  /** PR file stats with line counts (for REST + GraphQL files views). */
  prFiles(repo: Repo, pr: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const base = this.mergeBase(repo, pr.baseSha, pr.headSha) ?? pr.baseSha;
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const c of this.diffCommits(repo, base, pr.headSha)) {
      const oldText = c.oldOid === null ? '' : (repo.objects.get(c.oldOid)?.data.toString('utf8') ?? '');
      const newText = c.newOid === null ? '' : (repo.objects.get(c.newOid)?.data.toString('utf8') ?? '');
      const { added, removed } = diffLineCounts(oldText, newText);
      out.push({ filename: c.path, status: c.status, additions: added, deletions: removed, changes: added + removed });
    }
    return out;
  }

  // ---------------------------------------------------------- REST view shapes

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: `${VIEWER_LOGIN}/${repo.name}`,
      owner: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
      private: repo.isPrivate,
      description: repo.description,
      default_branch: DEFAULT_BRANCH,
      created_at: repo.createdAt,
      updated_at: repo.createdAt,
      html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}`,
      clone_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}.git`,
      has_issues: true,
    };
  }

  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: repo.id * 1_000_000 + issue.number,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
      node_id: this.issueGlobalId(repo, issue.number),
    };
  }

  prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
    return {
      id: repo.id * 1_000_000 + pr.number,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha,
      head: { ref: pr.headRef, sha: pr.headSha, label: `${VIEWER_LOGIN}:${pr.headRef}` },
      base: { ref: pr.baseRef, sha: pr.baseSha, label: `${VIEWER_LOGIN}:${pr.baseRef}` },
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      html_url: `https://example.invalid/${VIEWER_LOGIN}/${repo.name}/pull/${pr.number}`,
      node_id: this.prGlobalId(repo, pr.number),
    };
  }

  commentJson(repo: Repo, issueNumber: number, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: VIEWER_LOGIN, id: VIEWER_ID },
      created_at: comment.createdAt,
      updated_at: comment.createdAt,
      node_id: this.commentGlobalId(repo, issueNumber, comment.id),
    };
  }
}
