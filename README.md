# Shardis

Shardis is a small distributed key-value store built to make distributed
systems behavior visible: sharding, replication, failover, durability,
pub/sub, live metrics, and chaos testing run through real WebSocket
connections and real processes.

It is intentionally modest in scale. The value is in the implementation and
the tests, not in pretending to be a production Redis replacement.

![Shardis dashboard](docs/media/dashboard-screenshot.png)

## What it does

- In-memory key-value storage with TTLs and LRU eviction.
- AOF durability with `fsync` before acknowledgements, snapshots, replay, and
  crash recovery.
- Redis CRC16 hash slots across fixed shard ranges, including hash tags.
- JSON WebSocket protocol by default, plus an opt-in compact binary protocol.
- `MOVED` redirects for cross-shard requests and follower writes.
- Pub/sub with disconnect cleanup and subscription limits.
- Deterministic failover by default, based on the lowest live node id.
- Cross-shard leader gossip so redirects follow live failover state.
- Runtime follower membership through `JOIN_URL` and membership relay.
- Opt-in Raft-lite failover through `FAILOVER_MODE=raft`.
- CLI, dashboard, Docker Compose topology, metrics, health checks, and
  structured logs.

Every feature is covered by unit tests and the important failure paths have
real multi-process integration tests, including SIGKILL recovery.

## Quick start

Requirements: Node.js 20 or newer, pnpm 9, and Docker for the full cluster.

```bash
pnpm install
pnpm build
pnpm test
```

Start the six-node local cluster:

```bash
docker compose up -d
curl http://localhost:7001/healthz
```

Build and use the CLI:

```bash
pnpm --filter @shardis/cli build
node packages/cli/dist/shardis-cli.js --url ws://localhost:7001/ws SET foo bar
node packages/cli/dist/shardis-cli.js --url ws://localhost:7001/ws GET foo
```

The CLI follows `MOVED` redirects automatically. Use `--binary` to send and
receive the compact binary protocol:

```bash
node packages/cli/dist/shardis-cli.js --binary --url ws://localhost:7001/ws SET foo bar
```

Run the dashboard locally with:

```bash
pnpm --filter @shardis/dashboard dev
```

Then open `http://localhost:3000`.

## Failure modes

Kill a deterministic leader and watch its follower take over:

```bash
docker compose kill -s SIGKILL node-a1
curl http://localhost:7002/healthz
docker compose up -d node-a1
```

The returning node reconnects and performs a full resync. The repository also
tests follower outages, crash recovery, graceful shutdown, stale cross-shard
redirects, and dynamic follower joins with actual processes.

## Replication modes

### Deterministic mode

This is the default and preserves the original simple operating model. A
follower that loses its leader waits for the lowest live node id to promote
itself. It is tested and useful for controlled deployments, but it is not
consensus: a network partition can still create a split-brain window.

### Raft-lite mode

Set `FAILOVER_MODE=raft` on every node in a shard. The opt-in controller adds:

- randomized election timeouts;
- terms and one vote per term;
- log up-to-date checks before granting votes;
- AppendEntries consistency checks;
- majority commit tracking; and
- leader replacement after SIGKILL without losing committed data.

This is deliberately a lite implementation. `currentTerm` and `votedFor` are
not persisted, and membership changes do not use Raft joint consensus. Those
limitations are explicit rather than implied guarantees.

## Dynamic followers

Shard ranges and initial leaders remain in the cluster config. A new follower
does not need to be added to the existing nodes' follower lists. Give it the
leader URL and a reachable node URL:

```bash
JOIN_URL=ws://127.0.0.1:7001/ws
NODE_URL=ws://127.0.0.1:7003/ws
```

The new node sends `MEMBER_JOIN`; the recipient adds it, connects to it, and
relays `MEMBER_ANNOUNCE` to known members. A graceful shutdown sends
`MEMBER_LEAVE`. This changes only the follower set, never hash ownership.

## Configuration

Configuration is supplied through environment variables. `.env.example` lists
the complete set. The most important values are:

| Variable | Purpose | Default |
| --- | --- | --- |
| `NODE_ID` | Stable node identity | `node-a1` |
| `ROLE` | Boot role hint | `leader` |
| `SHARD_ID` | Shard assignment | `shard-a` |
| `CLUSTER_CONFIG_PATH` | Shard and node topology | `./cluster.config.local.json` |
| `PORT` | WebSocket and HTTP port | `7000` |
| `FAILOVER_MODE` | `deterministic` or `raft` | `deterministic` |
| `JOIN_URL` | Existing leader for a dynamic follower join | unset |
| `NODE_URL` | Reachable WebSocket URL for this node | derived from `PORT` |
| `DATA_DIR` | AOF and snapshot directory | `./data/<NODE_ID>` |
| `PUBLIC_DEMO` | Enable write-key protection | `false` |
| `DEMO_WRITE_KEY` | Required key when public demo protection is enabled | unset |

## HTTP endpoints

- `GET /healthz` returns node id, shard, uptime, and current role.
- `GET /metrics` returns key count, evictions, operation count, connected
  peers, and replication lag.
- WebSocket requests use `GET`, `SET`, `DEL`, `EXPIRE`, `SUBSCRIBE`,
  `UNSUBSCRIBE`, and `PUBLISH`.

## Transport security

The node speaks plain `ws://` and does not terminate TLS in-process. This is
intentional: production traffic must pass through a TLS-terminating reverse
proxy or managed platform endpoint and reach clients as `wss://`. Do not
publish a node's plain WebSocket port directly to the internet.

Local Compose is open for development. The public demo adds a shared
`DEMO_WRITE_KEY` for mutating requests; it is a demo safeguard, not per-user
authentication or tenant isolation. See [SECURITY.md](SECURITY.md) for the
reporting policy and deployment boundary.

## Repository layout

```text
packages/node/       storage node, protocol, persistence, replication
packages/cli/        shardis-cli WebSocket client
packages/dashboard/  Next.js live dashboard
packages/benchmarks/ benchmark runners and report generation
docs/                architecture, deployment, and benchmark history
```

## Development

```bash
pnpm build
pnpm test
pnpm lint
pnpm audit --audit-level moderate
```

The CI workflow runs dependency installation, audit, builds, all package
tests, type checks, dashboard build, and the real-process node integration
tests on every push and pull request.