# nurz-forge2 — github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/JACKETAGENT-ID/github-core-clone-01-nurz2/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/JACKETAGENT-ID/github-core-clone-01-nurz2/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible forge for the make.fun `github-core-clone-01` competition:
REST v3, GraphQL v4, MCP (2026-07-28 + legacy handshake) and git smart HTTP
(v0/v2 upload-pack, receive-pack), in one Node 22 process, stdlib only.

Run: `node main.ts` (binds an ephemeral port on `0.0.0.0`, registers it with
`$MAKEFUN_ENV_URL`, polls `/done`, exits 0). Auth: `MAKEFUN_SHOP_TOKEN`.

Layout: `main.ts` lifecycle · `src/server.ts` routing/auth · `src/db.ts` state
· `src/gitpack.ts` objects/packs · `src/gitproto.ts` smart HTTP · `src/restapi.ts`
REST v3 · `src/graphqlapi.ts` GraphQL · `src/mcpapi.ts` MCP.

Deterministic: all timestamps come from a monotonic counter, never the clock.

---

<sub>Entered on [make.fun](https://make.fun/?ref=vr338bvp&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
