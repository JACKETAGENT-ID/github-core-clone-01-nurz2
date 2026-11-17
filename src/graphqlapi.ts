// graphqlapi.ts — a small GraphQL executor for the fixed document set the suite sends
// (gh's viewer/repository/issue/pull-request reads, feature-detection __type probes,
// mutations, node(id:), cursor pagination, operation batching). Hand-written parser;
// no dependencies.

import { DEFAULT_BRANCH, VIEWER_LOGIN, type Forge, type Issue, type PullRequest, type Repo } from './db.ts';
import { addCommentOp, closeIssueOp, createIssueOp, createPullRequestOp, mergePullRequestOp } from './restapi.ts';
import { b64uDecode, b64uEncode } from './util.ts';

const GQL_TYPE = Symbol('gqlType');

function wrap<T extends object>(type: string, obj: T): T {
  (obj as unknown as Record<symbol, string>)[GQL_TYPE] = type;
  return obj;
}

function gqlTypeOf(obj: unknown): string | null {
  if (obj === null || typeof obj !== 'object') return null;
  return (obj as unknown as Record<symbol, string>)[GQL_TYPE] ?? null;
}

// -------------------------------------------------------------------------------- lexer

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'eof'; value: '' };

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j]!)) j += 1;
      }
      const num = Number(src.slice(i, j));
      tokens.push(isFloat ? { kind: 'float', value: num } : { kind: 'int', value: num });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`graphql: unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// -------------------------------------------------------------------------------- parser

interface ValueNode {
  kind: 'variable' | 'int' | 'float' | 'string' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: number | string | boolean;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

interface SelectionNode {
  kind: 'field' | 'inlineFragment' | 'fragmentSpread';
  alias?: string;
  name?: string;
  typeCondition?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
}

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== value) throw new Error(`graphql: expected ${value}, got ${JSON.stringify(t)}`);
  }

  private expectName(value?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error(`graphql: expected a name, got ${JSON.stringify(t)}`);
    if (value !== undefined && t.value !== value) throw new Error(`graphql: expected ${value}, got ${t.value}`);
    return t.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') {
        operations.push({ kind: 'query', variables: [], selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
        const kind = this.next().value as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek().kind === 'name') name = this.next().value as string;
        const variables = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseVariableDefinitions() : [];
        this.skipDirectives();
        operations.push({ kind, name, variables, selections: this.parseSelectionSet() });
      } else if (t.kind === 'name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`graphql: unexpected token ${JSON.stringify(t)}`);
      }
    }
    return { operations, fragments };
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  private parseVariableDefinitions(): Array<{ name: string; defaultValue?: ValueNode }> {
    const out: Array<{ name: string; defaultValue?: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      out.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.peek().kind === 'punct' && this.peek().value === '(' ? this.parseArguments() : undefined;
    this.skipDirectives();
    const selections = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> {
    const out: Array<{ name: string; value: ValueNode }> = [];
    this.expectPunct('(');
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') return { kind: 'variable', name: this.expectName() };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (t.kind === 'int') return { kind: 'int', value: t.value };
    if (t.kind === 'float') return { kind: 'float', value: t.value };
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error(`graphql: unexpected value token ${JSON.stringify(t)}`);
  }
}

// -------------------------------------------------------------------------------- values

type Variables = Record<string, unknown>;

function evalValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name ?? ''];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return (node.items ?? []).map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = evalValue(f.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function argsOf(sel: SelectionNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of sel.args ?? []) out[a.name] = evalValue(a.value, variables);
  return out;
}

// -------------------------------------------------------------------------------- schema tables (introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'labels', 'author', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommitSha', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Comment: ['id', 'body'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name', 'target'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const TYPE_KIND: Record<string, 'OBJECT' | 'ENUM'> = {
  Query: 'OBJECT',
  Mutation: 'OBJECT',
  User: 'OBJECT',
  Repository: 'OBJECT',
  Issue: 'OBJECT',
  PullRequest: 'OBJECT',
  IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT',
  PullRequestChangedFile: 'OBJECT',
  PageInfo: 'OBJECT',
  Ref: 'OBJECT',
  __Type: 'OBJECT',
  __Field: 'OBJECT',
  __EnumValue: 'OBJECT',
};

// -------------------------------------------------------------------------------- executor

interface ExecCtx {
  forge: Forge;
  variables: Variables;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function issueCursor(repo: Repo, number: number): string {
  return b64uEncode(`cursor:${repo.id}:${number}`);
}

function cursorNumber(repo: Repo, cursor: string): number | null {
  const text = b64uDecode(cursor);
  if (text === null) return null;
  const parts = text.split(':');
  if (parts.length !== 3 || parts[0] !== 'cursor' || Number(parts[1]) !== repo.id) return null;
  const n = Number(parts[2]);
  return Number.isInteger(n) ? n : null;
}

function issueStateEnum(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prStateEnum(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** Resolve one field on a wrapped object. Returns undefined for unknown fields. */
function resolveField(ctx: ExecCtx, type: string, obj: unknown, field: string, args: Record<string, unknown>): unknown {
  const { forge } = ctx;
  switch (type) {
    case 'Query': {
      if (field === 'viewer') return wrap('User', { login: VIEWER_LOGIN });
      if (field === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const repo = forge.getRepo(name);
        return repo === undefined ? null : wrap('Repository', repo);
      }
      if (field === 'node') {
        const id = args.id as string;
        if (typeof id !== 'string') return null;
        const decoded = forge.decodeGlobalId(id);
        if (decoded === null) return null;
        const repo = forge.repoOrder.find((r) => r.id === decoded.repoId);
        if (repo === undefined) return null;
        if (decoded.kind === 'R') return wrap('Repository', repo);
        if (decoded.kind === 'I') {
          const issue = repo.issues.get(decoded.number);
          return issue === undefined ? null : wrap('Issue', issue);
        }
        if (decoded.kind === 'P') {
          const pr = repo.pulls.get(decoded.number);
          return pr === undefined ? null : wrap('PullRequest', pr);
        }
        return null;
      }
      if (field === '__type') {
        return introspectionType(args.name as string);
      }
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') return mutationCreateIssue(ctx, args.input as Record<string, unknown>);
      if (field === 'closeIssue') return mutationCloseIssue(ctx, args.input as Record<string, unknown>);
      if (field === 'createPullRequest') return mutationCreatePullRequest(ctx, args.input as Record<string, unknown>);
      if (field === 'mergePullRequest') return mutationMergePullRequest(ctx, args.input as Record<string, unknown>);
      if (field === 'addComment') return mutationAddComment(ctx, args.input as Record<string, unknown>);
      return undefined;
    }
    case 'MutationPayload': {
      // A mutation's result object: plain property lookup.
      return (obj as Record<string, unknown>)[field];
    }
    case 'Comment': {
      const comment = obj as { id: string; body: string };
      if (field === 'id') return comment.id;
      if (field === 'body') return comment.body;
      return undefined;
    }
    case 'User': {
      const user = obj as { login: string };
      if (field === 'login') return user.login;
      if (field === 'id') return '1';
      if (field === 'name') return VIEWER_LOGIN;
      if (field === 'email') return `${VIEWER_LOGIN}@example.invalid`;
      return undefined;
    }
    case 'Repository': {
      const repo = obj as Repo;
      if (field === 'id') return forge.repoGlobalId(repo);
      if (field === 'databaseId') return repo.id;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${VIEWER_LOGIN}/${repo.name}`;
      if (field === 'owner') return wrap('User', { login: VIEWER_LOGIN });
      if (field === 'defaultBranchRef') return wrap('Ref', { name: DEFAULT_BRANCH });
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'private') return repo.isPrivate;
      if (field === 'createdAt') return repo.createdAt;
      if (field === 'url') return `https://example.invalid/${VIEWER_LOGIN}/${repo.name}`;
      if (field === 'issue') {
        const number = args.number as number;
        const issue = repo.issues.get(number);
        return issue === undefined ? null : wrap('Issue', issue);
      }
      if (field === 'issues') return issuesConnection(ctx, repo, args);
      if (field === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = [...repo.pulls.values()].sort((a, b) => b.seq - a.seq).slice(0, first).map((pr) => wrap('PullRequest', pr));
        return wrap('PullRequestConnection', { nodes, pageInfo: wrap('PageInfo', { hasNextPage: false, endCursor: null }) });
      }
      if (field === 'pullRequest') {
        const number = args.number as number;
        const pr = repo.pulls.get(number);
        return pr === undefined ? null : wrap('PullRequest', pr);
      }
      return undefined;
    }
    case 'Issue': {
      const issue = obj as Issue;
      const repo = issueRepo(ctx, issue);
      if (field === 'id') return repo === null ? '' : forge.issueGlobalId(repo, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issueStateEnum(issue);
      if (field === 'body') return issue.body;
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'labels') return issue.labels.map((name) => ({ name }));
      if (field === 'author') return wrap('User', { login: VIEWER_LOGIN });
      if (field === 'comments') return { nodes: [] };
      if (field === 'url') return '';
      return undefined;
    }
    case 'PullRequest': {
      const pr = obj as PullRequest;
      const repo = prRepo(ctx, pr);
      if (field === 'id') return repo === null ? '' : forge.prGlobalId(repo, pr.number);
      if (field === 'number') return pr.number;
      if (field === 'title') return pr.title;
      if (field === 'body') return pr.body;
      if (field === 'state') return prStateEnum(pr);
      if (field === 'merged') return pr.merged;
      if (field === 'mergedAt') return pr.mergedAt;
      if (field === 'mergeCommitSha') return pr.mergeCommitSha;
      if (field === 'headRefName') return pr.headRef;
      if (field === 'baseRefName') return pr.baseRef;
      if (field === 'mergeable') {
        if (pr.merged || pr.state !== 'open') return 'UNKNOWN';
        if (repo === null) return 'UNKNOWN';
        return forge.prConflicts(repo, pr) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field === 'files') {
        if (repo === null) return wrap('PullRequestConnection', { nodes: [] });
        const first = typeof args.first === 'number' ? args.first : 100;
        const nodes = forge.prFiles(repo, pr).slice(0, first).map((f) => wrap('PullRequestChangedFile', { path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status }));
        return wrap('PullRequestConnection', { nodes });
      }
      if (field === 'headRef') return wrap('Ref', { name: pr.headRef });
      if (field === 'baseRef') return wrap('Ref', { name: pr.baseRef });
      if (field === 'author') return wrap('User', { login: VIEWER_LOGIN });
      if (field === 'createdAt') return pr.createdAt;
      if (field === 'updatedAt') return pr.updatedAt;
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      const conn = obj as { nodes: unknown[]; pageInfo?: unknown };
      if (field === 'nodes') return conn.nodes;
      if (field === 'pageInfo') return conn.pageInfo ?? wrap('PageInfo', { hasNextPage: false, endCursor: null });
      if (field === 'totalCount') return conn.nodes.length;
      return undefined;
    }
    case 'PullRequestChangedFile': {
      const file = obj as { path: string; additions: number; deletions: number; changeType: string };
      if (field === 'path') return file.path;
      if (field === 'additions') return file.additions;
      if (field === 'deletions') return file.deletions;
      if (field === 'changeType') return file.changeType;
      return undefined;
    }
    case 'PageInfo': {
      const page = obj as { hasNextPage: boolean; hasPreviousPage?: boolean; endCursor: string | null; startCursor?: string | null };
      if (field === 'hasNextPage') return page.hasNextPage;
      if (field === 'hasPreviousPage') return page.hasPreviousPage ?? false;
      if (field === 'endCursor') return page.endCursor;
      if (field === 'startCursor') return page.startCursor ?? null;
      return undefined;
    }
    case 'Ref': {
      const ref = obj as { name: string };
      if (field === 'name') return ref.name;
      if (field === 'target') return null;
      return undefined;
    }
    case '__Type': {
      const t = obj as { name: string; kind: string; fields?: string[]; enumValues?: string[] };
      if (field === 'name') return t.name;
      if (field === 'kind') return t.kind;
      if (field === 'fields') return (t.fields ?? []).map((name) => wrap('__Field', { name }));
      if (field === 'enumValues') return (t.enumValues ?? []).map((name) => wrap('__EnumValue', { name }));
      if (field === 'description') return null;
      return undefined;
    }
    case '__Field': {
      if (field === 'name') return (obj as { name: string }).name;
      if (field === 'description') return null;
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return (obj as { name: string }).name;
      if (field === 'description') return null;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The repo an Issue belongs to (issues are looked up through their repo). */
function issueRepo(ctx: ExecCtx, issue: Issue): Repo | null {
  for (const repo of ctx.forge.repoOrder) if (repo.issues.get(issue.number) === issue) return repo;
  return null;
}

function prRepo(ctx: ExecCtx, pr: PullRequest): Repo | null {
  for (const repo of ctx.forge.repoOrder) if (repo.pulls.get(pr.number) === pr) return repo;
  return null;
}

function introspectionType(name: unknown): unknown {
  if (typeof name !== 'string') return null;
  if (TYPE_FIELDS[name] !== undefined) {
    return wrap('__Type', { name, kind: TYPE_KIND[name] ?? 'OBJECT', fields: TYPE_FIELDS[name] });
  }
  if (TYPE_ENUMS[name] !== undefined) {
    return wrap('__Type', { name, kind: 'ENUM', enumValues: TYPE_ENUMS[name] });
  }
  return null;
}

function issuesConnection(ctx: ExecCtx, repo: Repo, args: Record<string, unknown>): unknown {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s)));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  const direction = orderBy?.direction ?? 'DESC';
  const field = orderBy?.field ?? 'CREATED_AT';
  list.sort((a, b) => {
    let cmp: number;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.seq - b.seq;
    else if (field === 'COMMENTS') cmp = (repo.comments.get(a.number)?.length ?? 0) - (repo.comments.get(b.number)?.length ?? 0);
    else cmp = a.seq - b.seq;
    return direction === 'ASC' ? cmp : -cmp;
  });
  const after = args.after as string | null | undefined;
  if (typeof after === 'string' && after !== '') {
    const afterNumber = cursorNumber(repo, after);
    if (afterNumber !== null) {
      const idx = list.findIndex((i) => i.number === afterNumber);
      if (idx >= 0) list = list.slice(idx + 1);
    }
  }
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = list.slice(0, first);
  const hasNextPage = list.length > page.length;
  const endCursor = page.length > 0 ? issueCursor(repo, page[page.length - 1]!.number) : null;
  const nodes = page.map((issue) => wrap('Issue', issue));
  return wrap('IssueConnection', { nodes, pageInfo: wrap('PageInfo', { hasNextPage, endCursor }) });
}

// -------------------------------------------------------------------------------- mutations

function mutationCreateIssue(ctx: ExecCtx, input: Record<string, unknown>): unknown {
  const repo = typeof input.repositoryId === 'string' ? ctx.forge.repoByGlobalId(input.repositoryId) : null;
  if (repo === null) {
    ctx.errors.push({ message: 'createIssue: unknown repositoryId' });
    return null;
  }
  const title = typeof input.title === 'string' ? input.title : '';
  const result = createIssueOp(ctx.forge, repo, title, typeof input.body === 'string' ? input.body : '', []);
  if ('error' in result) {
    ctx.errors.push({ message: `createIssue: ${result.error}` });
    return null;
  }
  const issue = wrap('Issue', result.issue);
  return wrap('MutationPayload', { issue });
}

function mutationCloseIssue(ctx: ExecCtx, input: Record<string, unknown>): unknown {
  const id = input.issueId as string;
  const decoded = typeof id === 'string' ? ctx.forge.decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'I') {
    ctx.errors.push({ message: 'closeIssue: unknown issueId' });
    return null;
  }
  const repo = ctx.forge.repoOrder.find((r) => r.id === decoded.repoId);
  if (repo === undefined) {
    ctx.errors.push({ message: 'closeIssue: unknown repository' });
    return null;
  }
  const issue = closeIssueOp(repo, decoded.number);
  if (issue === null) {
    ctx.errors.push({ message: 'closeIssue: issue not found' });
    return null;
  }
  return wrap('MutationPayload', { issue: wrap('Issue', issue) });
}

function mutationCreatePullRequest(ctx: ExecCtx, input: Record<string, unknown>): unknown {
  const repo = typeof input.repositoryId === 'string' ? ctx.forge.repoByGlobalId(input.repositoryId) : null;
  if (repo === null) {
    ctx.errors.push({ message: 'createPullRequest: unknown repositoryId' });
    return null;
  }
  const result = createPullRequestOp(
    ctx.forge,
    repo,
    typeof input.title === 'string' ? input.title : '',
    typeof input.body === 'string' ? input.body : '',
    typeof input.headRefName === 'string' ? input.headRefName : '',
    typeof input.baseRefName === 'string' ? input.baseRefName : DEFAULT_BRANCH,
  );
  if ('error' in result) {
    ctx.errors.push({ message: `createPullRequest: ${result.error}` });
    return null;
  }
  return wrap('MutationPayload', { pullRequest: wrap('PullRequest', result.pr) });
}

function mutationMergePullRequest(ctx: ExecCtx, input: Record<string, unknown>): unknown {
  const id = input.pullRequestId as string;
  const decoded = typeof id === 'string' ? ctx.forge.decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'P') {
    ctx.errors.push({ message: 'mergePullRequest: unknown pullRequestId' });
    return null;
  }
  const repo = ctx.forge.repoOrder.find((r) => r.id === decoded.repoId);
  if (repo === undefined) {
    ctx.errors.push({ message: 'mergePullRequest: unknown repository' });
    return null;
  }
  const result = mergePullRequestOp(ctx.forge, repo, decoded.number);
  if ('error' in result) {
    ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
    return null;
  }
  const pr = repo.pulls.get(decoded.number)!;
  return wrap('MutationPayload', { pullRequest: wrap('PullRequest', pr) });
}

function mutationAddComment(ctx: ExecCtx, input: Record<string, unknown>): unknown {
  const id = input.subjectId as string;
  const decoded = typeof id === 'string' ? ctx.forge.decodeGlobalId(id) : null;
  if (decoded === null || decoded.kind !== 'I') {
    ctx.errors.push({ message: 'addComment: unknown subjectId' });
    return null;
  }
  const repo = ctx.forge.repoOrder.find((r) => r.id === decoded.repoId);
  if (repo === undefined) {
    ctx.errors.push({ message: 'addComment: unknown repository' });
    return null;
  }
  const result = addCommentOp(ctx.forge, repo, decoded.number, typeof input.body === 'string' ? input.body : '');
  if ('error' in result) {
    ctx.errors.push({ message: `addComment: ${result.error}` });
    return null;
  }
  const node = wrap('Comment', { id: ctx.forge.commentGlobalId(repo, decoded.number, result.id), body: result.body });
  return wrap('MutationPayload', { commentEdge: { node } });
}

// -------------------------------------------------------------------------------- selection execution

function executeSelections(ctx: ExecCtx, type: string, obj: unknown, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'inlineFragment') {
      if (sel.typeCondition !== undefined && sel.typeCondition !== type) continue;
      Object.assign(out, executeSelections(ctx, type, obj, sel.selections ?? []));
      continue;
    }
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name ?? '');
      if (frag === undefined) continue;
      if (frag.typeCondition !== type) continue;
      Object.assign(out, executeSelections(ctx, type, obj, frag.selections));
      continue;
    }
    const fieldName = sel.name!;
    const key = sel.alias ?? fieldName;
    const allowed = type === 'MutationPayload' ? true : TYPE_FIELDS[type]?.includes(fieldName) ?? false;
    if (!allowed && type !== 'MutationPayload') {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    const args = argsOf(sel, ctx.variables);
    const value = resolveField(ctx, type, obj, fieldName, args);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${fieldName}" on type "${type}".` });
      out[key] = null;
      continue;
    }
    if (sel.selections !== undefined && sel.selections.length > 0) {
      const childType = gqlTypeOf(value);
      if (value === null) {
        out[key] = null;
      } else if (Array.isArray(value)) {
        out[key] = value.map((entry) => {
          const t = gqlTypeOf(entry);
          return t === null ? entry : executeSelections(ctx, t, entry, sel.selections!);
        });
      } else if (childType !== null) {
        out[key] = executeSelections(ctx, childType, value, sel.selections);
      } else if (typeof value === 'object') {
        // Plain object (mutation payloads, commentEdge): resolve its keys as fields.
        const sub: Record<string, unknown> = {};
        for (const subSel of sel.selections) {
          if (subSel.kind !== 'field') continue;
          const subValue = (value as Record<string, unknown>)[subSel.name!];
          const subKey = subSel.alias ?? subSel.name!;
          if (subValue === undefined) {
            sub[subKey] = null;
            continue;
          }
          if (subSel.selections !== undefined && subSel.selections.length > 0) {
            const t = gqlTypeOf(subValue);
            if (subValue === null) sub[subKey] = null;
            else if (t !== null) sub[subKey] = executeSelections(ctx, t, subValue, subSel.selections);
            else if (typeof subValue === 'object') sub[subKey] = executeSelections(ctx, 'MutationPayload', subValue, subSel.selections);
            else sub[subKey] = subValue;
          } else {
            sub[subKey] = subValue;
          }
        }
        out[key] = sub;
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value;
    }
  }
  return out;
}

// -------------------------------------------------------------------------------- entry points

export interface GraphQLResult {
  status: number;
  body: string;
}

function executeOne(forge: Forge, request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { data: null, errors: [{ message: 'a GraphQL request must be a JSON object' }] };
  }
  const { query, variables, operationName } = request as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'query must be a non-empty string' }] };
  }
  let doc: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    doc = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let op: OperationNode | undefined;
  if (typeof operationName === 'string' && operationName !== '') {
    op = doc.operations.find((o) => o.name === operationName);
  }
  op ??= doc.operations[0];
  if (op === undefined) {
    return { data: null, errors: [{ message: 'no operation in the document' }] };
  }
  const vars: Variables = {};
  const givenVars = variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? (variables as Variables) : {};
  for (const def of op.variables) {
    if (def.name in givenVars) vars[def.name] = givenVars[def.name];
    else if (def.defaultValue !== undefined) vars[def.name] = evalValue(def.defaultValue, {});
    else vars[def.name] = null;
  }
  const ctx: ExecCtx = { forge, variables: vars, fragments: doc.fragments, errors: [] };
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, {}, op.selections);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** POST /api/graphql. `body` is the parsed JSON request (object or array). */
export function handleGraphQL(forge: Forge, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((entry) => executeOne(forge, entry));
    return { status: 200, body: JSON.stringify(results) };
  }
  return { status: 200, body: JSON.stringify(executeOne(forge, body)) };
}
