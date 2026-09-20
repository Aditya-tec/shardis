# Shardis

[![CI](https://github.com/Aditya-tec/shardis/actions/workflows/ci.yml/badge.svg)](https://github.com/Aditya-tec/shardis/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Aditya-tec/shardis/actions/workflows/codeql.yml/badge.svg)](https://github.com/Aditya-tec/shardis/actions/workflows/codeql.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![pnpm 9](https://img.shields.io/badge/pnpm-9-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)

**A distributed, in-memory key-value store built to make distributed-systems behavior tangible.** Shardis implements sharding, leader–follower replication, durable writes, failover, live slot migration, pub/sub, and cluster observability using real processes and WebSocket connections.

It is intentionally a small-scale learning and demonstration system—not a Redis replacement. The goal is readable implementation, honest trade-offs, and reproducible failure testing.

![Shardis dashboard](docs/media/dashboard-screenshot.png)

## Highlights

- **Distributed data path** — Redis CRC16 hash slots, hash tags, cross-shard `MOVED` redirects, and `ASK` redirects while slots migrate.
- **Durability** — append-only logging with `fsync` before acknowledgement, snapshots, compaction, replay, and crash recovery.
- **Replication and failover** — leader–follower replication, heartbeats, runtime membership, gossip-backed redirect updates, and an opt-in Raft-lite mode.
- **Real operations** — Docker Compose topology, health checks, JSON metrics, structured logs, CLI tooling, and a Next.js cluster dashboard.
- **Resilience testing** — unit tests plus real multi-process integration tests, including `SIGKILL` recovery and Compose smoke tests in CI.

## Architecture at a glance

```text
                         ┌─────────────────────┐
                         │  Dashboard / CLI    │
                         │  WebSocket clients  │
                         └──────────┬──────────┘
                                    │
                  MOVED / ASK       │  GET · SET · DEL · PUB/SUB
                                    ▼
        ┌───────────────────────────────────────────────────┐
        │                  Shardis cluster                   │
        │                                                   │
        │  Shard A              Shard B              Shard C │
        │  a1 (leader) ──► a2   b1 (leader) ──► b2   c1 ──► c2│
        │      │                   │                   │     │
        │   AOF + snapshot      AOF + snapshot      AOF + snapshot
        └───────────────────────────────────────────────────┘
```

The local environment runs three shards and six nodes. Any node can accept a client connection; when a key belongs elsewhere, the client is redirected to the active leader for that shard.

## Quick start

### Prerequisites

- Node.js 20 or newer
- pnpm 9
- Docker Desktop and Docker Compose (for the full cluster)

### Install, build, and test

```bash
pnpm install
pnpm build
pnpm test
```

### Start the local cluster

```bash
docker compose up -d --build
curl http://localhost:7001/healthz
```

The six nodes are exposed on ports `7001`–`7006`. Stop the cluster and remove its local volumes with:

```bash
docker compose down -v
```

### Use the CLI

```bash
pnpm --filter @shardis/cli build

node packages/cli/dist/shardis-cli.js --url ws://localhost:7001/ws SET hello world
node packages/cli/dist/shardis-cli.js --url ws://localhost:7001/ws GET hello
```

The CLI follows `MOVED` redirects automatically. To use the compact binary protocol instead of JSON:

```bash
node packages/cli/dist/shardis-cli.js --binary --url ws://localhost:7001/ws SET hello world
```

### Run the dashboard

```bash
pnpm --filter @shardis/dashboard dev
```

Open [http://localhost:3000](http://localhost:3000). With the Compose cluster running, the dashboard shows topology, node health, replication state, events, and an in-browser console.

## Core capabilities

| Area | Included behavior |
| --- | --- |
| Storage | In-memory keys, TTLs, active and lazy expiry, and LRU eviction |
| Persistence | AOF writes before acknowledgement, snapshots, compaction, and recovery replay |
| Routing | 16,384 CRC16 hash slots, hash tags, `MOVED` redirects, and runtime slot ownership |
| Resharding | Slot-by-slot `MIGRATING` / `IMPORTING` handoff with `ASK` redirects and resume support |
| Replication | Leader streaming, follower acknowledgements, lag visibility, full resync, and membership relay |
| Failover | Deterministic promotion by default; opt-in Raft-lite elections and majority commit tracking |
| Messaging | Local sharded pub/sub and optional cluster-scoped publish relay |
| Protocols | JSON over WebSocket by default, plus an opt-in compact binary protocol |
| Observability | `/healthz`, `/metrics`, `/topology`, structured logs, CLI, and dashboard |

## Try a failure scenario

Shardis is designed to be observed under failure. Kill the leader of shard A, then inspect its follower:

```bash
docker compose kill -s SIGKILL node-a1
curl http://localhost:7002/healthz
docker compose up -d node-a1
```

In deterministic mode, the lowest live follower id promotes. The returning node reconnects and completes a full resynchronization. The test suite also covers follower outages, stale redirects, dynamic joins, graceful shutdown, and crash recovery.

## Protocol and endpoints

Client requests are WebSocket messages using commands such as `GET`, `SET`, `DEL`, `EXPIRE`, `TTL`, `SUBSCRIBE`, `UNSUBSCRIBE`, and `PUBLISH`.

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Node identity, shard, role, and uptime |
| `GET /metrics` | Operation, eviction, connection, and replication-lag metrics |
| `GET /topology` | The topology loaded by that node; used for dashboard bootstrap |
| `WS /ws` | WebSocket client and peer protocol endpoint |

By default, pub/sub is sharded: publishes reach subscribers connected to the receiving node. Use `scope: "cluster"` (CLI: `PUBLISH channel message --cluster`) to relay an event once to other shards.

## Configuration

All node configuration is environment-driven. Copy [`.env.example`](.env.example) when running a node outside Compose.

| Variable | Description | Default |
| --- | --- | --- |
| `NODE_ID` | Stable node identifier | `node-a1` |
| `ROLE` | Boot role hint | `leader` |
| `SHARD_ID` | Node's shard | `shard-a` |
| `CLUSTER_CONFIG_PATH` | Static topology file | `./cluster.config.local.json` |
| `PORT` | HTTP and WebSocket port | `7000` |
| `DATA_DIR` | AOF and snapshot directory | `./data/<NODE_ID>` |
| `FAILOVER_MODE` | `deterministic` or `raft` | `deterministic` |
| `JOIN_URL` / `NODE_URL` | Dynamic-follower join configuration | unset / derived |
| `PUBLIC_DEMO` / `DEMO_WRITE_KEY` | Demo write protection | `false` / unset |
| `CLUSTER_SECRET` | Shared peer authentication secret | unset |
| `MAX_CONNECTIONS_PER_IP` | Concurrent connection cap per source IP | `20` |

## Measured behavior

Benchmarks are recorded with a timestamp and commit hash in [docs/benchmarks.md](docs/benchmarks.md). Current local measurements include:

| Scenario | Result |
| --- | --- |
| Throughput | 2,260 ops/sec with 10 clients over 5 seconds |
| Scaling sweep | 18,123 ops/sec peak at 5 clients in a short single-node sweep |
| Failover recovery | 2,846 ms total with a 3,000 ms heartbeat timeout |
| Replication lag | 4.5 ms average; 7 ms p95 across 50 samples |
| Range recompute | ~50% of keys move when changing 3 shards to 4 |

These are local, controlled-environment measurements—not capacity guarantees. Reproduce them with the benchmark package after building the node:

```bash
pnpm --filter @shardis/benchmarks bench:<name>
```

## Security and deployment boundary

Shardis is not intended to be exposed directly to the public internet.

- Nodes speak plain `ws://` internally. Terminate TLS at a reverse proxy or managed platform and expose only `wss://` to clients.
- `PUBLIC_DEMO=true` can require `DEMO_WRITE_KEY` for mutating operations; this is a demo safeguard, not user authentication or tenant isolation.
- The node applies request, connection, key-size, and value-size limits. Peer authentication is available through `CLUSTER_SECRET`.
- Per-key ACLs, encryption at rest, mTLS, off-node backups, and full production hardening are deliberately out of scope.

Please review [SECURITY.md](SECURITY.md) before reporting a vulnerability or deploying an internet-facing instance.

## Design choices and known limits

- **Default failover is not consensus.** Deterministic promotion is useful for controlled environments but can have a split-brain window during a network partition.
- **Raft-lite is opt-in.** It adds elections, terms, vote and log checks, and majority commit tracking, but membership changes do not use Raft joint consensus.
- **Persistence is local.** A disk failure can lose that node's AOF and snapshot unless operators copy them elsewhere.
- **This is deliberately modest in scale.** The project prioritizes visibility and correctness under documented scenarios over throughput tuning or broad production guarantees.

## Repository guide

```text
packages/
  node/         Store engine, persistence, protocol, replication, routing
  cli/          Redirect-aware WebSocket client
  dashboard/    Next.js cluster dashboard
  benchmarks/   Throughput, failover, lag, and reshard benchmark runners
docs/
  architecture.md  System design and decisions
  benchmarks.md    Dated benchmark history
  deployment.md    Render and Vercel deployment guide
  ci-cd.md         CI/CD and release operations
```

## Development and CI

```bash
pnpm build
pnpm test
pnpm lint
pnpm audit --audit-level moderate
```

GitHub Actions builds and tests every package, audits dependencies, runs the real-process node integration suite, and starts the complete Compose topology for an end-to-end CLI write/read smoke test. Additional workflows run CodeQL, Gitleaks, scheduled chaos checks, benchmarks, and container-image releases.

## Further reading

- [Architecture](docs/architecture.md)
- [Benchmark history](docs/benchmarks.md)
- [Throughput scaling chart](docs/media/throughput-scaling.svg)
- [Deployment guide](docs/deployment.md)
- [CI/CD operations](docs/ci-cd.md)
- [Architecture decision records](docs/adr)
- [Production-readiness roadmap](docs/production-readiness.md)
- [Security policy](SECURITY.md)
- [MIT License](LICENSE)
