# Shardis — Build Spec

A distributed, in-memory key-value store built from scratch: replication, sharding via consistent hashing, durability (AOF + snapshots), pub/sub, and a live cluster dashboard. Portfolio-flagship project. Zero paid infrastructure, no credit card anywhere in the stack.

This doc is written to be handed directly to a coding agent. It assumes the agent has no prior context beyond this file.

---

## 0. Hard constraints — read first

- **No credit card, anywhere, ever.** Every platform below has been checked as of the time this spec was written. Do not substitute a platform without re-verifying its current free-tier terms first — free-tier policies change without notice (confirmed case: Fly.io removed its no-card free tier for new signups; it now requires a card from day one — **do not use Fly.io**).
- Primary/authoritative environment is **local Docker Compose**. It is unlimited, free, and has no card requirement, ever. All core feature validation and the real benchmark numbers come from here.
- The public cloud deployment (Render) is a secondary, smaller-scope "clickable live demo," not the primary proof of the system. Render free web services have two real constraints that shape the design below:
  - **Ephemeral filesystem** — free web services have no persistent disk (that's a paid feature). Any local file (our AOF/snapshot) is wiped on redeploy and likely on a full spin-down/wake cycle. Don't fight this — document it as a known, intentional limitation of the public demo.
  - **750 free instance-hours per workspace per month, shared across every service in that workspace**, plus each free service spins down after 15 minutes idle and takes ~1 minute to wake on the next request/WS connection. Running more than ~1 service continuously 24/7 will exceed the monthly budget before the month ends. Design the public demo scope (Step 16) around this, don't ignore it.
- Railway is excluded as a host for anything that needs to stay up: its free plan is $1/month in credit after the first month — enough for a few hours, not a running cluster.
- Cloudflare Workers is excluded as node compute: V8-isolate execution model, no persistent TCP/WS server process, 10ms CPU cap per invocation — wrong shape for a stateful server.

If a coding agent building this hits a wall on any of the above (e.g., Render changes its free-tier terms again), stop and re-verify current terms before proceeding — don't assume.

---

## 1. What this project is

A working, from-scratch implementation of what a system like Redis does internally, at small scale, fully instrumented and benchmarked:

- In-memory key-value store with TTL expiry
- Durability via append-only log (AOF) + periodic snapshot/compaction
- Memory-cap eviction (LRU)
- Pub/Sub (SUBSCRIBE / PUBLISH / UNSUBSCRIBE)
- Sharding via consistent hashing across multiple shard-groups
- Per-shard leader–follower replication with heartbeat-based failover
- A minimal custom wire protocol over WebSocket
- A live dashboard visualizing the hash ring, node health, replication lag, and pub/sub events in real time
- A benchmark/chaos suite producing real, published numbers: failover time, rebalance %, replication lag, throughput

Scale target is explicitly modest and stated as such everywhere it's discussed (README, dashboard, writeup) — the point is correct distributed-systems behavior under controlled chaos, not raw throughput.

---

## 2. Architecture

### 2.1 Components

**Store Node** (`packages/node`) — the core process. Every node in the cluster runs the same binary; role (leader/follower) and shard assignment come from config, not code branching.

Responsibilities per node:
- `engine/` — in-memory map, TTL sweep (lazy check on read + periodic active sweep), LRU eviction once a configured `maxmemory` is hit
- `persistence/` — append every write to an AOF file before acking; replay AOF on startup to rebuild state; periodic snapshot (serialize full state, truncate AOF) to bound recovery time
- `replication/` — if leader: stream each applied write to connected followers over WS, track each follower's ack offset (for lag measurement). If follower: apply the leader's stream in order, reject direct writes (redirect to leader), send heartbeats
- `failover/` — followers track leader heartbeat; on timeout, deterministic promotion (lowest node ID among live followers in that shard becomes leader). **This is a v1 simplification, not consensus** — document clearly as a known limitation (see §10) rather than claiming split-brain safety you haven't built
- `hashring/` — static consistent hash ring built from `cluster.config.json`; used to route a key to its owning shard
- `protocol/` — parses/frames one JSON object per WebSocket message (see §2.2)

**Gateway logic** — not a separate service in v1. Any node can receive a client request; if the key doesn't belong to that node's shard, it responds with a redirect (`{"error":"MOVED","shard":"...","leader":"wss://..."}`) rather than proxying — this keeps routing logic visible and simple, and it's a real pattern (see Redis Cluster's `MOVED`).

**CLI** (`packages/cli`) — `shardis-cli` connects to any node via WS, issues `SET/GET/DEL/EXPIRE/SUBSCRIBE/PUBLISH`, follows `MOVED` redirects automatically. Used for manual testing and scriptable in benchmarks.

**Dashboard** (`packages/dashboard`, Next.js on Vercel) — subscribes to a cluster metadata WS stream and renders:
- Hash ring diagram (which shard owns which key range, which node is leader/follower)
- Node table: role, status, last heartbeat, replication lag
- Live event feed: replication events, pub/sub traffic, failover events as they happen
- An in-browser console for `SET/GET/DEL/EXPIRE` against the live cluster

**Benchmark/chaos suite** (`packages/benchmarks`) — Node scripts, runnable locally or in CI:
- Throughput: N concurrent clients, SET/GET for T seconds → ops/sec
- Failover: kill the leader process mid-run → measure time to promotion + first accepted write after
- Rebalance: add/remove a node → measure % of keys whose owning shard changed
- Replication lag: write on leader, poll follower until visible → measure delta
- Every run appends a row to `docs/benchmarks.md` with a timestamp and git commit hash — this becomes your real, dated evidence, not a one-off claim

### 2.2 Wire protocol (v1)

One JSON object per WebSocket message, both directions. Keep it boring and debuggable — you can add a compact binary framing later as a stretch goal (§10) once the JSON version works end-to-end.

Request:
```json
{"id": "uuid", "op": "SET", "key": "foo", "value": "bar", "ttl_ms": 60000}
{"id": "uuid", "op": "GET", "key": "foo"}
{"id": "uuid", "op": "SUBSCRIBE", "channel": "events"}
```

Response:
```json
{"id": "uuid", "ok": true, "value": "bar"}
{"id": "uuid", "ok": false, "error": "MOVED", "shard": "shard-b", "leader": "wss://node3.example/ws"}
```

Replication stream (leader → follower, no `id`, fire-and-forget with periodic offset acks):
```json
{"type": "REPL_OP", "seq": 10422, "op": "SET", "key": "foo", "value": "bar"}
{"type": "REPL_ACK", "seq": 10422}
```

### 2.3 Cluster topology

Static, not gossip-discovered, in v1 (dynamic membership/gossip is a stretch goal, §10). Topology lives in `cluster.config.json`, one version per environment (`cluster.config.local.json`, `cluster.config.render.json`):

```json
{
  "shards": [
    {
      "id": "shard-a",
      "hash_range": [0, 5460],
      "leader": { "id": "node-a1", "url": "wss://..." },
      "followers": [{ "id": "node-a2", "url": "wss://..." }]
    },
    {
      "id": "shard-b",
      "hash_range": [5461, 10922],
      "leader": { "id": "node-b1", "url": "wss://..." },
      "followers": [{ "id": "node-b2", "url": "wss://..." }]
    },
    {
      "id": "shard-c",
      "hash_range": [10923, 16383],
      "leader": { "id": "node-c1", "url": "wss://..." },
      "followers": [{ "id": "node-c2", "url": "wss://..." }]
    }
  ]
}
```

Local Docker Compose runs the full 6-node, 3-shard topology above. The public Render demo runs a reduced 1-shard, 2-node topology (§0's constraints make a full 6-node always-on deployment unrealistic for free — see Step 16).

### 2.4 Configuration

All per-node behavior is driven by environment variables — nothing hardcoded, so the same image runs locally, in CI, and on Render.

| Variable | Purpose | Example |
|---|---|---|
| `NODE_ID` | Unique id for this node — used in logs, hash ring, promotion tie-breaks | `node-a1` |
| `ROLE` | `leader` or `follower` at boot (can change at runtime after failover) | `leader` |
| `SHARD_ID` | Which shard this node belongs to | `shard-a` |
| `CLUSTER_CONFIG_PATH` | Path to the topology file to load | `./cluster.config.local.json` |
| `MAXMEMORY_MB` | Memory cap before LRU eviction kicks in | `64` |
| `TTL_SWEEP_INTERVAL_MS` | How often the active TTL sweep runs | `1000` |
| `SNAPSHOT_INTERVAL_MS` | How often a full snapshot + AOF compaction runs | `60000` |
| `HEARTBEAT_INTERVAL_MS` / `HEARTBEAT_TIMEOUT_MS` | Leader heartbeat cadence and the timeout that triggers failover | `1000` / `3000` |
| `RATE_LIMIT_RPS` | Per-connection request cap (§8) | `50` |
| `MAX_KEY_BYTES` / `MAX_VALUE_BYTES` | Input bounds (§8) | `1024` / `65536` |
| `PUBLIC_DEMO` | `true` only on the Render deployment — turns on write-protection | `false` |
| `DEMO_WRITE_KEY` | Required write key when `PUBLIC_DEMO=true` (Render env var, never committed) | *(secret)* |

Ship a `.env.example` listing every variable with a sane local default — the coding agent should never have to guess a config surface by reading source.

---

## 3. Repo structure

```
shardis/
  packages/
    node/
      src/
        server.ts
        engine/          # store, ttl, eviction
        persistence/      # aof, snapshot
        replication/      # leader/follower streaming, heartbeat, failover
        hashring/          # consistent hashing
        protocol/          # ws message parsing/framing
      Dockerfile
      package.json
    cli/
      src/shardis-cli.ts
      package.json
    dashboard/
      # Next.js app
      app/
      package.json
    benchmarks/
      src/
        throughput.ts
        failover.ts
        rebalance.ts
        replication-lag.ts
      package.json
  docker-compose.yml
  cluster.config.local.json
  cluster.config.render.json
  render.yaml
  .github/
    workflows/
      ci.yml
      chaos-bench.yml
  docs/
    architecture.md
    benchmarks.md
  README.md
  LICENSE                # MIT — it's going public
  package.json          # workspace root (npm/pnpm workspaces)
```

---

## 4. Ordered build sequence

Each step should be a working, committed state before moving to the next. Don't parallelize early steps — later ones depend on earlier ones being solid.

1. **Scaffold** — npm/pnpm workspaces monorepo, TypeScript base config, `packages/node` skeleton, Dockerfile for a single node. Pick a test framework now (Vitest is a reasonable default) — every step from here on ships with tests, not as a separate pass at the end.
2. **Core engine** — in-memory map, `SET/GET/DEL/EXPIRE`, TTL lazy-check on read + periodic sweep. Unit tests for expiry edge cases.
3. **Wire protocol + WS server** — implement the JSON protocol from §2.2, no persistence/replication yet. Include input bounds (max key/value size) and malformed-message handling now, not bolted on later — a bad or oversized message from one client should get a clean error response, never crash the node (see §8). Smoke-test with a bare WS client (`wscat` or a throwaway script).
4. **CLI** — `shardis-cli` talks to a single node over WS. This becomes your manual test tool for every step after.
5. **AOF** — append every write before acking, replay on startup. Use a temp directory per test run and a dynamically assigned port so tests can run in parallel without colliding. Test: write keys, kill `-9` the process, restart, verify state matches via checksum comparison.
6. **Snapshotting** — periodic full-state snapshot + AOF truncation/compaction. Test: snapshot + a few post-snapshot writes, kill, restart, verify correct merge of snapshot + replayed tail.
7. **Eviction** — LRU once `maxmemory` is hit. Test: fill past cap, verify oldest-accessed keys evicted first.
8. **Pub/Sub** — `SUBSCRIBE/PUBLISH/UNSUBSCRIBE`. Test with two concurrent `shardis-cli` sessions.
9. **Hash ring + static topology + MOVED routing** — load `cluster.config.json`, route by key hash, respond `MOVED` for out-of-shard keys. `shardis-cli` should auto-follow `MOVED`.
10. **Replication + heartbeat + failover** — leader streams applied writes to followers; followers ack offset; heartbeat timeout triggers deterministic promotion. Test: kill leader process, verify a follower promotes and starts accepting writes, verify `cluster.config` is NOT required to change (routing should redirect to whichever node currently holds leadership, tracked at runtime, not hardcoded).
10a. **Graceful shutdown** — handle `SIGTERM` (this is exactly what Render sends before spinning a free service down, §0): stop accepting new writes, flush/fsync any buffered AOF entries, close WS connections with a clean frame, then exit. Test: send `SIGTERM` mid-write-burst locally, restart, verify zero data loss — skipping this turns your durability feature into a visible bug on the public demo every time it spins down.
11. **Docker Compose, full local cluster** — wire up the 3-shard/6-node topology from §2.3. This is your primary working environment from here on.
12. **Dashboard v1** — hash ring diagram, node table, live event feed, in-browser console. Point it at the local Compose cluster first.
13. **Benchmark/chaos suite** — throughput, failover time, rebalance %, replication lag scripts, each appending dated results to `docs/benchmarks.md`.
14. **CI** — `.github/workflows/ci.yml` runs unit tests on every push. `.github/workflows/chaos-bench.yml` (manual trigger + weekly schedule) spins the Docker Compose cluster inside the Actions runner, runs the full benchmark/chaos suite, commits updated `docs/benchmarks.md`. This is your source of dated, reproducible evidence — unlimited and free on a public repo.
15. **Security hardening before going public** — write-protection (env-var-gated write key), per-connection rate limiting, and secrets handling from §8. Do this *before* step 16, not after — an unprotected public write endpoint is a real abuse/DoS surface the moment it's live, not a nice-to-have.
16. **Render deployment (reduced scope)** — `render.yaml` Blueprint defining 2 web services (1 leader + 1 follower, single shard) from `cluster.config.render.json`, `healthCheckPath` pointed at `/healthz` (§9). Deploy dashboard to Vercel pointed at the public node URLs. Document the ephemeral-fs and instance-hour caveats directly in the README next to the live link.
17. **Writeup** — README, `docs/architecture.md`, `docs/benchmarks.md` polish, a short screen-recorded GIF/video of the local cluster handling a kill-the-leader chaos test (this is your fallback proof if the public demo happens to be asleep/reset when someone clicks it).

---

## 5. Free-stack summary (verified, no card)

| Purpose | Platform | Key limits to respect |
|---|---|---|
| Store nodes (public demo) | Render free web services | Ephemeral filesystem (no disk persistence); 750 shared instance-hours/workspace/month; spins down after 15 min idle, ~1 min cold start; supports long-running processes + WebSocket |
| Store nodes (primary/real) | Docker Compose, local | Unlimited, no card, ever |
| Dashboard | Vercel Hobby (Next.js) | 100GB bandwidth/month, no card |
| CI + chaos benchmarks | GitHub Actions | Free/unlimited minutes on public repos |
| Source control | GitHub | Free |

Explicitly excluded: **Fly.io** (no free tier for new signups as of this year, card required), **Railway** (free credit too small for an always-on service), **Cloudflare Workers** (wrong execution model for stateful servers).

---

## 6. Validation / hardening checklist

- [ ] AOF replay after a hard kill produces identical state to pre-crash (checksum comparison in a test)
- [ ] Consistent-hash rebalance on node add/remove moves approximately the expected fraction of keys, not dramatically more (measure and record the actual %, don't assume the textbook number)
- [ ] Failover completes within a bounded, measured time window; the number is logged and published in `docs/benchmarks.md`, not just claimed
- [ ] Only one node per shard accepts writes as leader at any time in normal operation — and the README honestly documents that this is enforced by heartbeat timeout + deterministic promotion, **not** by a consensus protocol, so a network partition could theoretically produce a brief split-brain window. Say this plainly; it's a correct and defensible v1 scope limit, not a bug to hide.
- [ ] Pub/Sub cleanly drops a subscriber on disconnect (no leaked listeners/memory growth over time)
- [ ] Dashboard's WS client reconnects with backoff through a Render cold-start wake (~1 min) instead of showing a broken/blank state
- [ ] Every benchmark script run is dated and tied to a git commit hash in `docs/benchmarks.md`
- [ ] The public Render demo rejects `SET/DEL/EXPIRE` without a valid write key; `GET/SUBSCRIBE` stay open
- [ ] A single client sending oversized or malformed messages gets a clean error, never crashes the node or affects other connections
- [ ] Per-connection rate limiting is active on the public demo and its threshold is documented (so a benchmark run against your own demo doesn't look like the abuse case it's meant to catch)
- [ ] No secret (write key or otherwise) appears in the repo, `cluster.config.render.json`, or client-side dashboard code — only in Render/GitHub Actions environment variables

---

## 7. README / writeup outline

1. One-paragraph pitch — what it is, why you built it (understand the internals, not just use the client library)
2. Architecture diagram (can reuse the dashboard's hash-ring view as a screenshot)
3. What's real vs. simplified — be explicit: deterministic failover not Raft, static topology not gossip discovery, JSON protocol not binary. Frame these as scope decisions with reasons, not gaps you're hoping nobody notices
4. Live demo link — with the ephemeral-fs / cold-start caveat stated right next to it
5. Benchmark numbers table (pulled from `docs/benchmarks.md`) — failover time, rebalance %, replication lag, throughput, each dated
6. The chaos-test GIF/video
7. Security posture — write-protection on the public demo, rate limiting, and what's explicitly out of scope (§8). Interviewers ask about this; having it written down beats improvising an answer
8. Operability — health checks, graceful shutdown, structured logs, `/metrics` (§9). Short, but it's the difference between "I wrote code" and "I thought about running it"
9. What you'd add with more time — Raft-lite leader election, gossip-based dynamic membership, binary wire protocol (this doubles as your answer to "what would you do differently" in interviews)

---

## 8. Security & hardening

A toy KV store that's reachable on the public internet is still reachable on the public internet — treat this seriously even though the project is a portfolio piece, not a production system.

- **Write-protection on the public demo.** Local/CI environments run open (no auth — that would just add friction to your own testing). The Render deployment sets `PUBLIC_DEMO=true`, which requires a `write_key` field on every `SET/DEL/EXPIRE` request, checked against an env var (`DEMO_WRITE_KEY`, set in the Render dashboard, never committed). `GET/SUBSCRIBE` stay open so anyone can watch the live cluster without being able to trash it. State this plainly in the README next to the demo link — it's a legitimate design choice, not something to obscure.
- **Per-connection rate limiting.** Cap requests-per-second per WebSocket connection with a simple in-memory token bucket in the node process — you already know this pattern well from your Redis-backed rate limiter project; here it's local-only (no shared Redis needed) since it's per-connection, not cluster-wide. This protects the public demo from being flooded, which matters doubly given Render's shared instance-hour budget (§0) — a flood doesn't just degrade the demo, it burns through your monthly free compute.
- **Input bounds.** Reject keys/values above a configured max size (e.g. 1 KB key / 64 KB value) and malformed protocol messages with a clean `{"ok": false, "error": "..."}` response — implemented in step 3, not bolted on later. One misbehaving client should never be able to crash a node or affect other connections.
- **Transport security.** `wss://` (Render) and `https://` (Vercel) are the platform's managed TLS — nothing to configure yourself, but say so explicitly in the README so it reads as accounted for, not missed.
- **Secrets.** `DEMO_WRITE_KEY` and anything else sensitive live only in Render and GitHub Actions environment variables — never in the repo, never in `cluster.config.render.json`, never in dashboard client-side code (which is publicly readable by anyone who opens devtools).
- **Explicitly out of scope, worth naming rather than hiding.** Per-key ACLs, encryption at rest for the AOF file, and mTLS between nodes are real production-Redis features this project doesn't attempt. Naming them as deliberately deferred in the README is more credible than implying the project is production-hardened when it isn't.

---

## 9. Observability & operability

Not enterprise-grade ops for a portfolio project — but "did you think about this" is exactly what gets asked in backend/infra interviews, and it's genuinely what you'll want while debugging replication lag yourself.

- **`GET /healthz`** — a plain HTTP endpoint (not WS) on each node returning `200` with `{status, role, shard, uptime_s}` when healthy. Two uses: Render's own health checks (`healthCheckPath` in `render.yaml`, Step 16) and the dashboard polling node status without opening a full WS handshake just to check liveness.
- **Graceful shutdown** — covered in Step 10a; listed here because it's as much an operability property as a correctness one.
- **Structured logs** — one JSON line per event to stdout: `{ts, node_id, level, event, ...}` for things like `write_applied`, `replication_lag_ms`, `failover_triggered`, `client_rejected` (rate limit/input bounds). This is what Render and GitHub Actions logs actually show you when something breaks, and it's a real talking point: "how would you debug this in prod" → "grep the structured logs for `event=failover_triggered`."
- **`GET /metrics`** — a lightweight per-node endpoint exposing counters (ops/sec, connected clients, replication lag, evictions) as JSON or Prometheus text format. The dashboard's live event feed is the demo-friendly view of the same data; this is the "I exposed metrics the way real systems do" answer underneath it.

---

## 10. Stretch goals (explicitly out of v1 scope)

- Raft-lite leader election, replacing deterministic promotion — the single biggest "understands consensus" signal, but genuinely hard; don't let it block shipping v1
- Gossip-based dynamic node discovery instead of static `cluster.config.json`
- Compact binary wire protocol instead of JSON-over-WS
- Multi-DC / cross-region replication simulation (would require a second free host region — re-verify free-tier terms before attempting)

---

## 11. Open questions / assumptions made in this spec

- **Language: Node.js/TypeScript** for nodes, CLI, dashboard, and benchmarks — matches the existing stack (rate limiter, BullMQ workflow agent) and keeps one language across the whole repo. Could substitute Python for the node engine specifically if preferred, at the cost of a two-language repo.
- **6-node/3-shard local topology, 2-node/1-shard public demo** — chosen to fit Render's shared 750-hour/month budget realistically while keeping the local cluster rich enough for meaningful hash-ring and rebalance demos.
- **JSON-over-WebSocket protocol for v1**, binary framing deferred to stretch goals — prioritizes shipping a complete, correct system over protocol-level polish.
