// server.ts — the HTTP server: routing, bearer auth, body reading, request ids.
// One Forge per process; the base URL (for absolute pagination links) is set after
// listen, once the ephemeral port is known.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './db.ts';
import { handleGraphQL } from './graphqlapi.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleMcp } from './mcpapi.ts';
import { handleRest } from './restapi.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ForgeApp {
  server: Server;
  forge: Forge;
  setBaseUrl(url: string): void;
}

export function createApp(token: string): ForgeApp {
  const forge = new Forge();
  let baseUrl = '';
  let reqSeq = 0;

  const sendJson = (res: ServerResponse, status: number, body: string, extraHeaders: Record<string, string> = {}): void => {
    reqSeq += 1;
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-github-request-id': `req-${reqSeq.toString(16).padStart(8, '0')}`,
      ...extraHeaders,
    });
    res.end(body);
  };

  const sendRaw = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          req.destroy();
          reject(new Error('request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const pathname = decodeURIComponent(url.pathname);
        const method = req.method ?? 'GET';

        // /healthz: no auth, trivial answer (the harness boot probe).
        if (pathname === '/healthz' && method === 'GET') {
          sendJson(res, 200, '{"ok":true}');
          return;
        }

        // Bearer auth on every other route (when a token is configured).
        if (token !== '') {
          const auth = req.headers.authorization ?? '';
          if (auth !== `Bearer ${token}`) {
            sendJson(res, 401, JSON.stringify({ message: 'Unauthorized' }));
            return;
          }
        }

        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        const body = needsBody ? await readBody(req) : Buffer.alloc(0);

        if (pathname === '/api/graphql' && method === 'POST') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            sendJson(res, 400, JSON.stringify({ data: null, errors: [{ message: 'malformed JSON body' }] }));
            return;
          }
          const result = handleGraphQL(forge, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204);
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, JSON.stringify({ message: 'method not allowed' }));
            return;
          }
          const result = handleMcp(forge, body.toString('utf8'));
          if (result.body === '') {
            res.writeHead(result.status);
            res.end();
          } else {
            sendJson(res, result.status, result.body);
          }
          return;
        }

        if (pathname.startsWith('/api/v3')) {
          const result = handleRest({ forge, baseUrl }, method, pathname, url.search.slice(1), body.toString('utf8'));
          if (result.status === 204) {
            res.writeHead(204);
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(pathname);
        if (gitMatch !== null) {
          const owner = gitMatch[1]!;
          const repoName = gitMatch[2]!;
          const service = gitMatch[3]!;
          const gitProtocolRaw = req.headers['git-protocol'];
          const gitProtocol = Array.isArray(gitProtocolRaw) ? (gitProtocolRaw[0] ?? '') : (gitProtocolRaw ?? '');
          if (service === 'info/refs' && method === 'GET') {
            const result = handleInfoRefs(forge, owner, repoName, url.searchParams.get('service') ?? '', gitProtocol);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (service === 'git-upload-pack' && method === 'POST') {
            const result = handleUploadPack(forge, owner, repoName, body, gitProtocol);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          if (service === 'git-receive-pack' && method === 'POST') {
            const result = handleReceivePack(forge, owner, repoName, body);
            sendRaw(res, result.status, result.contentType, result.body);
            return;
          }
          sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
          return;
        }

        sendJson(res, 404, JSON.stringify({ message: 'Not Found' }));
      } catch (err) {
        try {
          sendJson(res, 500, JSON.stringify({ message: err instanceof Error ? err.message : String(err) }));
        } catch {
          // The response is already gone; nothing left to do.
        }
      }
    })();
  });

  return {
    server,
    forge,
    setBaseUrl(url: string): void {
      baseUrl = url.replace(/\/+$/, '');
    },
  };
}
