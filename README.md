# Shardis

A distributed, in-memory key-value store built from scratch: replication, sharding via consistent hashing, durability (AOF + snapshots), pub/sub, and a live cluster dashboard.

Built to understand what a system like Redis does internally, at small scale, fully instrumented and benchmarked — not to wrap an existing client library.

## Status

Early scaffold. Following the build sequence in `docs/architecture.md` (ported from the original design doc): core engine → wire protocol → CLI → AOF → snapshotting → eviction → pub/sub → hash ring/routing → replication/failover → Docker Compose cluster → dashboard → benchmarks → CI → security hardening → public demo.

## Repo layout

```
packages/
  node/         # store node: engine, persistence, replication, hashring, protocol
  cli/          # shardis-cli (added in a later step)
  dashboard/    # live cluster dashboard, Next.js (added in a later step)
  benchmarks/   # throughput/failover/rebalance/replication-lag suite (added in a later step)
docs/
cluster.config.local.json   # 3-shard/6-node local topology
cluster.config.render.json  # reduced 1-shard/2-node public demo topology (added later)
```

## Local development

```bash
pnpm install
pnpm --filter @shardis/node test
pnpm --filter @shardis/node dev
```

`GET /healthz` on a running node returns `{status, node_id, role, shard, uptime_s}`.

Copy `.env.example` to `.env` and adjust per node — see that file for every configuration variable a node reads.

## Scope notes

This project favors correct, observable distributed-systems behavior over raw throughput or production-grade hardening. Simplifications made deliberately (and documented as such, not hidden): deterministic leader promotion instead of Raft, a static topology file instead of gossip-based membership, and a JSON-over-WebSocket wire protocol instead of a binary one. Details land in `docs/architecture.md` and the README's writeup section as the project progresses.

## License

MIT — see [LICENSE](LICENSE).
