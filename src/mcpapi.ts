// mcpapi.ts — Model Context Protocol endpoint (POST /mcp): the modern 2026-07-28
// era (server/discover, no session) plus the legacy initialize handshake. JSON-RPC 2.0
// over plain JSON bodies; tools backed by the same Forge as REST/GraphQL.

import { VIEWER_LOGIN, type Forge } from './db.ts';
import { createIssueOp, createPullRequestOp, mergePullRequestOp } from './restapi.ts';

const SERVER_NAME = 'nurz-forge';
const SERVER_VERSION = '2.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (always the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

interface McpResult {
  status: number;
  body: string;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
}

/** Dispatch one tools/call. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (tool === undefined) return toolErr(`unknown tool "${name}"`);
  const missing = missingArgs(tool, args);
  if (missing.length > 0) return toolErr(`missing required argument(s): ${missing.join(', ')}`);
  const owner = typeof args.owner === 'string' ? args.owner : VIEWER_LOGIN;
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  switch (name) {
    case 'create_repo': {
      const repo = forge.createRepo(
        String(args.name),
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (repo === null) return toolErr(`a repository named "${args.name}" already exists`);
      return toolOk(forge.repoJson(repo));
    }
    case 'get_repo': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      return toolOk(forge.repoJson(repo));
    }
    case 'create_issue': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      const result = createIssueOp(forge, repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in result) return toolErr(result.error);
      return toolOk(forge.issueJson(repo, result.issue));
    }
    case 'list_issues': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return toolOk(list.map((i) => forge.issueJson(repo, i)));
    }
    case 'create_pull_request': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      const result = createPullRequestOp(
        forge,
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in result) return toolErr(result.error);
      return toolOk(forge.prJson(repo, result.pr));
    }
    case 'merge_pull_request': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      const number = Number(args.pull_number);
      const result = mergePullRequestOp(forge, repo, number);
      if ('error' in result) return toolErr(result.error);
      const pr = repo.pulls.get(number)!;
      return toolOk({ number, merged: true, state: pr.state, sha: result.sha });
    }
    case 'get_issue': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (issue === undefined) return toolErr('issue not found');
      return toolOk(forge.issueJson(repo, issue));
    }
    case 'list_pull_requests': {
      if (owner !== VIEWER_LOGIN) return toolErr('repository not found');
      const repo = forge.getRepo(repoName);
      if (repo === undefined) return toolErr('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return toolOk(list.map((p) => forge.prJson(repo, p)));
    }
    default:
      return toolErr(`unknown tool "${name}"`);
  }
}

/** POST /mcp. `bodyText` is the raw request body. */
export function handleMcp(forge: Forge, bodyText: string): McpResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const req = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = 'id' in req;
  const id = hasId ? req.id : null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {};

  // Notifications (no id) get no JSON-RPC answer.
  if (!hasId) {
    return { status: 202, body: '' };
  }

  switch (method) {
    case 'server/discover': {
      return rpcResult(id, {
        resultType: 'DiscoverResult',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'A GitHub-compatible forge: repositories, issues, pull requests, git smart HTTP, GraphQL and MCP tools.',
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: negotiated,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping': {
      return rpcResult(id, {});
    }
    case 'tools/list': {
      return rpcResult(id, { tools: TOOLS });
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      if (findTool(name) === undefined) {
        return rpcError(id, -32601, `Method not found: no tool named "${name}"`);
      }
      const result = callTool(forge, name, args);
      return rpcResult(id, result);
    }
    default: {
      if (method.startsWith('notifications/')) return { status: 202, body: '' };
      return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}
