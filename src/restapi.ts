// restapi.ts — REST v3 surface: repositories, git data, contents, issues, labels,
// pull requests. All state lives in Forge (db.ts); this file is the HTTP mapping.
// Every reply is JSON (except 204) and carries X-GitHub-Request-Id (set by server.ts).

import { DEFAULT_BRANCH, VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Forge, type Issue, type PullRequest, type Repo } from './db.ts';
import { parseCommit as _pc, parseTree as _pt } from './gitpack.ts';
import { b64Decode, b64Encode, isOid } from './util.ts';

export interface RestContext {
  forge: Forge;
  /** The entry's own base URL, for absolute pagination links. */
  baseUrl: string;
}

export interface RestResult {
  status: number;
  /** Pre-serialized JSON body ('' for 204). */
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown, headers?: Record<string, string>): RestResult => ({
  status,
  body: JSON.stringify(value),
  headers,
});

const err = (status: number, message: string): RestResult => json(status, { message });

function parseQuery(query: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    if (eq < 0) out.set(decodeURIComponent(part), '');
    else out.set(decodeURIComponent(part.slice(0, eq)), decodeURIComponent(part.slice(eq + 1)));
  }
  return out;
}

function pageParams(query: Map<string, string>): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Paginate `items` (already ordered); returns the page slice + Link header when needed. */
function paginate<T>(ctx: RestContext, pathname: string, query: Map<string, string>, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const next = new URL(`${ctx.baseUrl}${pathname}`);
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice as T[], headers };
}

// ---------------------------------------------------------- shared operations (also used by GraphQL/MCP)

export function createIssueOp(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labels: readonly string[],
): { issue: Issue } | { error: string } {
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `unknown label "${name}"` };
  }
  const number = repo.nextNumber();
  const now = forge.clock.nextIso();
  const issue: Issue = { number, title, body, state: 'open', labels: [...labels], createdAt: now, updatedAt: now, seq: number };
  repo.issues.set(number, issue);
  repo.comments.set(number, []);
  return { issue };
}

export function closeIssueOp(repo: Repo, number: number): Issue | null {
  const issue = repo.issues.get(number);
  if (issue === undefined) return null;
  if (issue.state !== 'closed') {
    issue.state = 'closed';
    repo.invalidateIssue(number);
  }
  return issue;
}

export function createPullRequestOp(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): { pr: PullRequest } | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined) return { error: `unknown head branch "${headRef}"` };
  if (baseSha === undefined) return { error: `unknown base branch "${baseRef}"` };
  for (const pr of repo.pulls.values()) {
    if (pr.state === 'open' && pr.headRef === headRef && pr.baseRef === baseRef) return { error: 'a pull request is already open for this head and base' };
  }
  const number = repo.nextNumber();
  const now = forge.clock.nextIso();
  const pr: PullRequest = {
    number,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
    seq: number,
  };
  repo.pulls.set(number, pr);
  return { pr };
}

export function addCommentOp(
  forge: Forge,
  repo: Repo,
  issueNumber: number,
  body: string,
): { id: number; body: string; createdAt: string } | { error: string } {
  const issue = repo.issues.get(issueNumber);
  if (issue === undefined) return { error: 'issue not found' };
  const id = repo.nextCommentId();
  const comment = { id, body, createdAt: forge.clock.nextIso() };
  repo.comments.get(issueNumber)?.push(comment);
  return comment;
}

/** Squash-merge a PR. Returns the merge commit sha, or an error with an HTTP status. */
export function mergePullRequestOp(
  forge: Forge,
  repo: Repo,
  number: number,
): { sha: string } | { error: string; status: number } {
  const pr = repo.pulls.get(number);
  if (pr === undefined) return { error: 'pull request not found', status: 404 };
  if (pr.merged) return { sha: pr.mergeCommitSha ?? '' };
  if (forge.prConflicts(repo, pr)) return { error: 'merge conflict', status: 405 };
  const sha = forge.squashMerge(repo, pr);
  if (sha === null) return { error: 'merge conflict', status: 405 };
  return { sha };
}

// ---------------------------------------------------------- contents helpers

/** Resolve a ref name / oid to a commit oid (default branch when unset). */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`) ?? null;
  const direct = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(ref);
  if (direct !== undefined) return direct;
  if (isOid(ref) && repo.objects.get(ref)?.type === 'commit') return ref;
  return null;
}

/** The entries of a directory path in a commit's tree ('' = root). */
function dirEntries(forge: Forge, repo: Repo, commitOid: string, dirPath: string): Array<{ type: string; name: string; path: string; sha: string; size?: number }> {
  const files = forge.treeFiles(repo, commitOid);
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  const out: Array<{ type: string; name: string; path: string; sha: string; size?: number }> = [];
  const seenDirs = new Map<string, string>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      out.push({ type: 'file', name: rest, path, sha: file.oid, size: repo.objects.get(file.oid)?.data.length ?? 0 });
    } else {
      const dirName = rest.slice(0, slash);
      if (!seenDirs.has(dirName)) {
        // The directory's tree oid: find it by walking the tree.
        seenDirs.set(dirName, '');
        out.push({ type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: '' });
      }
    }
  }
  // Fill directory tree oids.
  for (const entry of out) {
    if (entry.type !== 'dir') continue;
    entry.sha = walkTree(repo, commitOid, entry.path);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function walkTree(repo: Repo, commitOid: string, dirPath: string): string {
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return '';
  let treeOid = _pc(commit.data).tree;
  if (dirPath === '') return treeOid;
  for (const part of dirPath.split('/')) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return '';
    const entry = _pt(tree.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return '';
    treeOid = entry.oid;
  }
  return treeOid;
}

// ---------------------------------------------------------- the router

export function handleRest(ctx: RestContext, method: string, rawPath: string, rawQuery: string, bodyText: string): RestResult {
  const { forge } = ctx;
  const query = parseQuery(rawQuery);
  // Routing uses the path without the /api/v3 prefix; pagination links keep the full path.
  const path = rawPath.startsWith('/api/v3') ? rawPath.slice('/api/v3'.length) || '/' : rawPath;
  const fullPath = decodeURIComponent(rawPath);
  let body: unknown = undefined;
  if (bodyText !== '') {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch {
      return err(400, 'malformed JSON body');
    }
  }
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const seg = path.split('/').filter((s) => s !== '');

  // ---- /api/v3 root + meta + user
  if (seg.length === 0) {
    if (method !== 'GET') return err(405, 'method not allowed');
    return json(200, { current_user_url: `${ctx.baseUrl}/api/v3/user`, meta_url: `${ctx.baseUrl}/api/v3/meta` }, { 'x-oauth-scopes': 'repo, user' });
  }
  if (seg.length === 1 && seg[0] === 'meta') {
    if (method !== 'GET') return err(405, 'method not allowed');
    return json(200, { installed_version: '1.0.0' });
  }
  if (seg.length === 1 && seg[0] === 'user') {
    if (method !== 'GET') return err(405, 'method not allowed');
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
  }
  if (seg.length === 2 && seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      if (!isObj(body)) return err(400, 'a JSON object body is required');
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || /[^A-Za-z0-9._-]/.test(name)) return err(422, 'invalid repository name');
      const repo = forge.createRepo(name, typeof body.description === 'string' ? body.description : '', body.private === true);
      if (repo === null) return err(422, 'a repository with this name already exists');
      return json(201, forge.repoJson(repo));
    }
    if (method === 'GET') {
      const items = forge.repoOrder.map((r) => forge.repoJson(r));
      const { page, headers } = paginate(ctx, fullPath, query, items);
      return json(200, page, headers);
    }
    return err(405, 'method not allowed');
  }

  // ---- /api/v3/repos/{owner}/{repo}/...
  if (seg.length >= 3 && seg[0] === 'repos') {
    const owner = seg[1]!;
    const repoName = seg[2]!;
    if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
    const repo = forge.getRepo(repoName);
    const rest = seg.slice(3);

    if (rest.length === 0) {
      if (repo === undefined) return err(404, 'Not Found');
      if (method === 'GET') return json(200, forge.repoJson(repo));
      if (method === 'PATCH') {
        if (!isObj(body)) return err(400, 'a JSON object body is required');
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        return json(200, forge.repoJson(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repoName);
        return { status: 204, body: '' };
      }
      return err(405, 'method not allowed');
    }
    if (repo === undefined) return err(404, 'Not Found');

    // branches
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.keys()]
          .filter((r) => r.startsWith('refs/heads/'))
          .sort()
          .map((r) => ({ name: r.slice('refs/heads/'.length), commit: { sha: repo.refs.get(r) } }));
        return json(200, list);
      }
      if (rest.length === 2 && method === 'GET') {
        const sha = repo.refs.get(`refs/heads/${rest[1]}`);
        if (sha === undefined) return err(404, 'Not Found');
        return json(200, { name: rest[1], commit: { sha } });
      }
      return err(404, 'Not Found');
    }

    // commits
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = query.get('sha') ?? null;
      const tip = resolveRef(repo, ref);
      const list: Array<Record<string, unknown>> = [];
      if (tip !== null) {
        const seen = new Set<string>();
        const queue: string[] = [tip];
        while (queue.length > 0) {
          const oid = queue.shift()!;
          if (seen.has(oid)) continue;
          seen.add(oid);
          const obj = repo.objects.get(oid);
          if (obj === undefined || obj.type !== 'commit') continue;
          const c = _pc(obj.data);
          const epoch = parseInt(c.author.split(' ').pop() ?? '0', 10);
          const date = Number.isFinite(epoch) ? new Date(epoch * 1000).toISOString() : repo.createdAt;
          list.push({
            sha: oid,
            commit: {
              message: c.message.replace(/\n$/, ''),
              author: { name: c.author.split(' <')[0], email: VIEWER_EMAIL, date },
              committer: { name: c.committer.split(' <')[0], email: VIEWER_EMAIL, date },
              tree: { sha: c.tree },
            },
            parents: c.parents.map((p) => ({ sha: p })),
          });
          for (const p of c.parents) queue.push(p);
        }
      }
      const { page, headers } = paginate(ctx, fullPath, query, list);
      return json(200, page, headers);
    }

    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        if (!isObj(body)) return err(400, 'a JSON object body is required');
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha)) return err(422, 'invalid ref or sha');
        if (repo.objects.get(sha) === undefined) return err(422, 'unknown object sha');
        if (repo.refs.has(ref)) return err(422, 'a ref with this name already exists');
        repo.refs.set(ref, sha);
        repo.invalidatePackCache();
        return json(201, { ref, object: { sha } });
      }
      if (method === 'GET') {
        if (rest.length === 2) {
          const list = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([ref, sha]) => ({ ref, object: { sha } }));
          return json(200, list);
        }
        const refName = rest.slice(2).join('/');
        const sha = repo.refs.get(refName);
        if (sha === undefined) return err(404, 'Not Found');
        return json(200, { ref: refName, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    // contents
    if (rest[0] === 'contents') {
      const filePath = rest.slice(1).join('/');
      if (method === 'GET') {
        const tip = resolveRef(repo, query.get('ref') ?? null);
        if (tip === null) return err(404, 'Not Found');
        const files = forge.treeFiles(repo, tip);
        const exact = files.get(filePath);
        if (filePath === '' || exact === undefined) {
          const entries = dirEntries(forge, repo, tip, filePath);
          if (filePath !== '' && entries.length === 0) return err(404, 'Not Found');
          return json(200, entries);
        }
        const data = repo.objects.get(exact.oid)?.data ?? Buffer.alloc(0);
        return json(200, {
          type: 'file',
          encoding: 'base64',
          size: data.length,
          name: filePath.split('/').pop(),
          path: filePath,
          content: b64Encode(data),
          sha: exact.oid,
        });
      }
      if (method === 'PUT') {
        if (!isObj(body)) return err(400, 'a JSON object body is required');
        const message = typeof body.message === 'string' ? body.message : 'update';
        const content = typeof body.content === 'string' ? b64Decode(body.content) : null;
        if (content === null) return err(400, 'content must be base64');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
        const refName = `refs/heads/${branch}`;
        const tip = repo.refs.get(refName) ?? (branch === DEFAULT_BRANCH ? undefined : repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`));
        const files = tip === undefined ? new Map() : forge.treeFiles(repo, tip);
        const existing = files.get(filePath);
        const sha = typeof body.sha === 'string' ? body.sha : null;
        if (existing !== undefined) {
          if (sha === null) return err(422, 'sha is required to update a file');
          if (sha !== existing.oid) return err(409, 'sha does not match the current file');
        } else if (sha !== null) {
          return err(409, 'sha given for a file that does not exist');
        }
        const changes = new Map<string, Buffer | null>([[filePath, content]]);
        const commitOid = forge.commitFiles(repo, branch, message, changes);
        if (commitOid === null) return err(422, 'no base commit for the branch');
        const blobOid = forge.treeFiles(repo, commitOid).get(filePath)?.oid ?? '';
        const status = existing === undefined ? 201 : 200;
        return json(status, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blobOid, size: content.length, encoding: 'base64', content: b64Encode(content) },
          commit: { sha: commitOid },
        });
      }
      if (method === 'DELETE') {
        if (!isObj(body)) return err(400, 'a JSON object body is required');
        const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : DEFAULT_BRANCH;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        const files = forge.treeFiles(repo, tip);
        const existing = files.get(filePath);
        if (existing === undefined) return err(404, 'Not Found');
        const sha = typeof body.sha === 'string' ? body.sha : null;
        if (sha !== null && sha !== existing.oid) return err(409, 'sha does not match the current file');
        const commitOid = forge.commitFiles(repo, branch, typeof body.message === 'string' ? body.message : 'delete', new Map([[filePath, null]]));
        if (commitOid === null) return err(422, 'no base commit for the branch');
        return json(200, { commit: { sha: commitOid } });
      }
      return err(405, 'method not allowed');
    }

    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
      }
      if (method === 'POST' && rest.length === 1) {
        if (!isObj(body)) return err(400, 'a JSON object body is required');
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return err(422, 'label name is required');
        const existing = repo.labels.get(name);
        if (existing !== undefined) return json(201, { name: existing.name, color: existing.color, description: '' });
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        repo.labels.set(name, { name, color });
        return json(201, { name, color, description: '' });
      }
      return err(404, 'Not Found');
    }

    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!isObj(body)) return err(400, 'a JSON object body is required');
          const title = typeof body.title === 'string' ? body.title : '';
          if (title === '') return err(422, 'title is required');
          const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
          const result = createIssueOp(forge, repo, title, typeof body.body === 'string' ? body.body : '', labels);
          if ('error' in result) return err(422, result.error);
          return json(201, forge.issueJson(repo, result.issue));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((i) => i.state === state);
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          const { page, headers } = paginate(ctx, fullPath, query, list.map((i) => forge.issueJson(repo, i)));
          return json(200, page, headers);
        }
        return err(405, 'method not allowed');
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
      if (rest.length === 2) {
        const issue = repo.issues.get(number);
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          const cached = repo.issueJsonCache.get(number);
          if (cached !== undefined) return { status: 200, body: cached };
          const bodyStr = JSON.stringify(forge.issueJson(repo, issue));
          repo.issueJsonCache.set(number, bodyStr);
          return { status: 200, body: bodyStr };
        }
        if (method === 'PATCH') {
          if (!isObj(body)) return err(400, 'a JSON object body is required');
          if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
            issue.state = body.state;
            issue.updatedAt = forge.clock.nextIso();
            repo.invalidateIssue(number);
          }
          if (typeof body.title === 'string') {
            issue.title = body.title;
            issue.updatedAt = forge.clock.nextIso();
            repo.invalidateIssue(number);
          }
          if (typeof body.body === 'string') {
            issue.body = body.body;
            issue.updatedAt = forge.clock.nextIso();
            repo.invalidateIssue(number);
          }
          return json(200, forge.issueJson(repo, issue));
        }
        return err(405, 'method not allowed');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          if (!repo.issues.has(number)) return err(404, 'Not Found');
          const list = (repo.comments.get(number) ?? []).map((c) => forge.commentJson(repo, number, c));
          return json(200, list);
        }
        if (method === 'POST') {
          if (!isObj(body)) return err(400, 'a JSON object body is required');
          const text = typeof body.body === 'string' ? body.body : '';
          const result = addCommentOp(forge, repo, number, text);
          if ('error' in result) return err(404, result.error);
          return json(201, forge.commentJson(repo, number, result));
        }
        return err(405, 'method not allowed');
      }
      return err(404, 'Not Found');
    }

    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') {
          if (!isObj(body)) return err(400, 'a JSON object body is required');
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : DEFAULT_BRANCH;
          if (title === '' || head === '') return err(422, 'title and head are required');
          const result = createPullRequestOp(forge, repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in result) return err(422, result.error);
          return json(201, forge.prJson(repo, result.pr));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((p) => p.state === state);
          list.sort((a, b) => b.seq - a.seq);
          const { page, headers } = paginate(ctx, fullPath, query, list.map((p) => forge.prJson(repo, p)));
          return json(200, page, headers);
        }
        return err(405, 'method not allowed');
      }
      const number = parseInt(rest[1] ?? '', 10);
      if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
      if (rest.length === 2) {
        const pr = repo.pulls.get(number);
        if (pr === undefined) return err(404, 'Not Found');
        if (method === 'GET') return json(200, forge.prJson(repo, pr));
        return err(405, 'method not allowed');
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pr = repo.pulls.get(number);
        if (pr === undefined) return err(404, 'Not Found');
        return json(200, forge.prFiles(repo, pr));
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const methodName = isObj(body) && typeof body.merge_method === 'string' ? body.merge_method : 'squash';
        if (methodName !== 'squash' && methodName !== 'merge' && methodName !== 'rebase') return err(400, 'unknown merge_method');
        const result = mergePullRequestOp(forge, repo, number);
        if ('error' in result) return err(result.status, result.error);
        const pr = repo.pulls.get(number)!;
        return json(200, { sha: result.sha, merged: true, message: `${pr.title} (#${pr.number})` });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
