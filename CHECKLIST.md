# CHECKLIST — github-core-clone-01 / nurz-forge2

Kompetisi: github-core-clone-01 ($500, deadline 2026-11-21 06:30 UTC). Akun: NURZ.
Entrypoint: `node /bot/main.ts` (Node 22.23.4, stdlib murni, tanpa build/install).

## Lifecycle (harness)
- [ ] `MAKEFUN_ENV_URL` wajib ada; tanpa itu exit 1.
- [ ] Bind port ephemeral (`listen(0)`), eksplisit `0.0.0.0` (bukan localhost/`::` implisit).
- [ ] POST `$MAKEFUN_ENV_URL/register` `{"port": N}`; 200/409 = ok; retry selamanya.
- [ ] Poll GET `$MAKEFUN_ENV_URL/done` sampai `{"done": true}`; lalu tutup server, exit 0.
- [ ] Boot: register ≤20 dtk, lalu GET /healthz 2× ≤10 dtk. `/healthz` trivial, tanpa auth.
- [ ] Token: `MAKEFUN_SHOP_TOKEN`; tanpa token valid = 401 di semua API.

## REST v3 (`/api/v3`, semua balasan JSON + header `X-GitHub-Request-Id` non-kosong)
- [ ] GET `/` 200 + header `X-OAuth-Scopes`; GET `/meta` 200 `{installed_version}`.
- [ ] GET `/user` 200 `{login: "adaiversen"}` (viewer deterministik dari seed skenario).
- [ ] POST `/user/repos` 201 (`{name, private, description}`); duplikat → 422.
- [ ] GET `/user/repos` paginasi `?page=&per_page=` + header `Link: rel="next"`, tanpa duplikat.
- [ ] GET/PATCH/DELETE `/repos/{o}/{r}`: owner ≠ viewer → 404 (bukan 403); PATCH deskripsi; DELETE 204.
- [ ] POST `/git/refs` 201 `{ref, object:{sha}}`; GET `/git/refs/heads/{b}` dan `/branches/{b}`.
- [ ] GET `/branches` `[{name, commit:{sha}}]`; GET `/commits[?sha=]` hanya commit reachable.
- [ ] PUT `/contents/{path}`: 201 create / 200 update / 409 sha basi; balasan `{content:{sha, encoding:"base64"}, commit:{sha}}`; `branch` yang belum ada dibuat dari tip default branch; commit baru memakai sha blob/commit git SHA-1 asli.
- [ ] GET `/contents/{path}[?ref=]`: file `{type:"file", encoding:"base64", content, sha, size}` / direktori array; 404 bila hilang.
- [ ] DELETE `/contents/{path}` 200 `{commit:{sha}}`.
- [ ] POST `/labels` 201 `{name}`; POST `/issues` 201 (label tak dikenal → 422); nomor issue+PR SATU counter per repo.
- [ ] GET `/issues` filter `state` + `sort=created` + `direction` + `per_page`; GET/PATCH `/issues/{n}` (tutup persisten).
- [ ] POST/GET `/issues/{n}/comments` 201 `{id, body}` / list.
- [ ] POST `/pulls` 201 `{number, state:"open", head:{ref,sha}, base:{ref,sha}}`; GET `/pulls[?state=]`; GET `/pulls/{n}` 200/404.
- [ ] GET `/pulls/{n}/files` `[{filename, status, additions, deletions, changes}]` (status added/modified; additions ≥1).
- [ ] PUT `/pulls/{n}/merge {merge_method:"squash"}` 200 `{sha, merged:true, message}`; PR tak dikenal → 404; konflik → 405; sesudah merge PR closed + `merged_at` + `merge_commit_sha == sha`; commit squash terbaca lewat GET contents?ref=base.
- [ ] Route tak dikenal → 404 JSON; JSON malformed → 400 JSON.

## Git smart HTTP (`/{owner}/{repo}.git`)
- [ ] GET `info/refs?service=git-upload-pack` + header `Git-Protocol: version=2` → iklan v2: `version 2`, `ls-refs=unborn`, `fetch=shallow filter`, `object-format=sha1`, `agent=...`. Tanpa header → iklan v0 (`# service=...`, caps `symref=HEAD:refs/heads/main multi_ack_detailed thin-pack side-band-64k ofs-delta shallow agent=...`, pseudo-ref `capabilities^{}` bila repo kosong).
- [ ] GET `info/refs?service=git-receive-pack` → iklan v0 (`report-status side-band-64k delete-refs ofs-delta agent=...`).
- [ ] POST `git-upload-pack` v2: `ls-refs` (filter `ref-prefix` di server; `unborn HEAD symref-target:refs/heads/main` bila kosong; `peeled:` hanya bila diminta) dan `fetch` (seksi `acknowledgments` NAK, `shallow-info`, `packfile` sideband band 1; pack v2, objek plain, trailer SHA-1).
- [ ] POST `git-upload-pack` v0: baris NAK/ACK + `shallow`/`unshallow`, lalu pack sideband.
- [ ] Semantik fetch: objek = closure(wants, depth) − closure(haves); depth-N hanya commit jarak <N; `shallow` = commit ter-include yang parent-nya tak ter-include; `unshallow` = boundary lama yang kini lengkap; fetch-nothing-new = pack 0 objek; clone kosong = 0 objek.
- [ ] POST `git-receive-pack`: parse command + pack (plain + OFS/REF delta), simpan objek (verifikasi SHA-1), terapkan per ref berurutan; FF wajib (bila tidak → `ng <ref> non-fast-forward`, `unpack ok` tetap); delete (new=ZERO) didukung; balasan report-status di sideband band 1 (`unpack ok`, `ok`/`ng` per ref).
- [ ] Content-Type persis: `application/x-git-*-advertisement` / `application/x-git-*-result`.
- [ ] Repo tak ada → 404 (server tetap hidup); push ke ref `refs/heads/*` dan `refs/tags/*`; tag annotated ikut peel.

## GraphQL (`POST /api/graphql`, tanpa token → 401)
- [ ] `viewer{login}` = `adaiversen`; `repository(owner:,name:)` → `{id, databaseId, name, owner{login}, defaultBranchRef{name}, viewerPermission (ADMIN), hasIssuesEnabled:true}`; repo tak dikenal → `data.repository=null`, tanpa errors.
- [ ] `__type(name:)` + `fields(includeDeprecated:)` untuk Issue (id,number,title,state,body), PullRequest (id,number,headRefName,baseRefName,mergeable,state,merged,files), Repository (id,databaseId,name,nameWithOwner,owner,defaultBranchRef,viewerPermission,hasIssuesEnabled,issue,issues,pullRequests,pullRequest); `enumValues` SearchType memuat ISSUE.
- [ ] `repository.issues(first, states:[OPEN], orderBy:{field:CREATED_AT,direction:DESC}, after)` + `pageInfo{hasNextPage,endCursor}` (cursor opaque, urutan DESC default).
- [ ] `repository.issue(number:)`, `repository.pullRequests(first:)`, `repository.pullRequest(number:){files(first:){nodes{path}}}`, `pullRequest{mergeable}` ∈ MERGEABLE/CONFLICTING/UNKNOWN.
- [ ] Mutasi: `createIssue{repositoryId,title,body}`, `closeIssue{issueId}`, `createPullRequest{repositoryId,baseRefName,headRefName,title}`, `mergePullRequest{pullRequestId,mergeMethod:SQUASH}`, `addComment{subjectId,body}` — semua tembus ke REST view.
- [ ] `node(id:)` round-trip repo; global id opaque + stabil (base64, BUKAN databaseId/nomor mentah).
- [ ] Field tak dikenal → HTTP 200 + `errors[]` berisi nama field; batching: body array JSON → array balasan berurutan.

## MCP (`POST /mcp`, tanpa token → 401)
- [ ] `server/discover` → `{supportedVersions:["2026-07-28",...], capabilities:{tools:{}}, serverInfo:{name,version}}` (era modern); `initialize` legacy → echo `protocolVersion` + `capabilities.tools` + `serverInfo`; `notifications/initialized` → 202 kosong.
- [ ] `tools/list` ≥6 tool, keenam wajib ada (create_repo, get_repo, create_issue, list_issues, create_pull_request, merge_pull_request), deskripsi non-kosong, `inputSchema.type=="object"`, daftar byte-identik antar panggilan; `required` hanya properti yang suite bisa isi.
- [ ] `tools/call`: hasil `{content:[{type:"text",text:JSON}], structuredContent, isError}`; argumen hilang → `isError:true`; tool tak dikenal → JSON-RPC -32601/-32602 (bukan HTTP 500); id request di-echo persis (panggilan konkuren).
- [ ] Body bukan JSON → HTTP 400 + JSON-RPC -32700.
- [ ] Tool-tool tembus ke REST (repo + issue dibuat via MCP terbaca identik via REST, id stabil).

## Determinisme & performa
- [ ] Semua timestamp dari counter monotonik (epoch dasar + seq), BUKAN `Date.now()`/acak — replay state identik.
- [ ] Cache: pack fetch per (repo, wants, haves, depth, shallow); JSON GET issue per nomor (invalidasi saat mutasi); `Map` lookup di semua jalur panas, tanpa scan O(n).
- [ ] Target lokal: 120/120 checks, perf total ≥170 (ambang server ≥143; vocaine 129 di produksi).
- [ ] Repo dibuat setelah kompetisi dibuka; LICENSE MIT; `.makefun/owner.json` = `{"wallet":"H3q6PFBmzpqN6vNE94hFn1vt9KdtXCnn5jg6efsDD83b"}`.
- [ ] JANGAN submit, JANGAN buat repo GitHub, JANGAN hubungi make.fun API untuk submit.

## Practice trial results (local, Node 22.23.4, kit practice runner)

- 2026-11-17 state-v2e: **120/120 checks, working=1**, perf 112 (machine under heavy sibling load)
- 2026-11-17 state-v2f: **120/120, working=1**, perf 132 (push 35, clone 30, read 31, write 36)
- 2026-11-17 state-v2g: **120/120, working=1**, perf 126 (push 38, clone 32, read 30, write 26)
- Best local run (lighter load, state-v2c): 113/120 + perf 171; the 7 failures were fixed after it.
- Checks are deterministic (120/120 twice in a row); perf varies with machine load
  (a sibling chess trial was using ~80% CPU during the last runs). Production
  threshold for top-100 is score ≥943 (feature 600 + agent 200 + perf ≥143).

## v1 diagnosis (why the v1 entry scored 0 on the server)

No locally-reproducible cause was found: v1 passed 120/120 locally under the
exact pinned Node, as uid 65534, and byte-identical to the submitted snapshot.
Most likely a server-side/pod-specific transient fault in that trial run.
v2 mitigations: explicit `listen(0, '0.0.0.0')`, starter-faithful minimal
lifecycle, fail-loud startup logging, register retry forever.

## Bugs found and fixed while building v2 (local trials)

- Node type-stripping rejects TS parameter properties (`constructor(private …)`)
  — removed in `src/graphqlapi.ts` (Parser) and `src/util.ts` (SeqClock).
- v0 advertisement: `# service=…` must be a pkt-line, not raw text.
- `/\0.*$/` does NOT strip NUL-caps from a line ending in `\n` (`.` misses `\n`,
  `$` only matches at the very end) — use `line.split('\0')[0]`.
- ls-refs v2: an annotated tag must be ONE line with `peeled:<target>`,
  not a duplicated plain line (the client takes the first match).
- Shallow fetch: object collection must not walk parents past the depth
  boundary; the haves exclusion must stop at the client's shallow boundaries
  (boundedClosure), else deepen/new-tip fetches lose the wanted commit.
- PR conflict detection must use the CURRENT base tip, not the tip stored at
  PR creation (other PRs move the base).
- Commit messages are stored verbatim; the REST commits list strips one
  trailing newline for presentation.
- DELETE requests must have their body read (server only read bodies for
  POST/PUT/PATCH).
- Pack inflate: one `inflateSync(buf, {info: true})` per object and read
  `engine.bytesWritten` for the stream length — ~8× fewer inflates than
  binary-search probing.
