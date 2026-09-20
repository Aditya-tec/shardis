# ADR 0001: Deterministic Failover by Default; Raft-lite as an Opt-in Mode

## Context

Shardis is intended to make replication and failover observable in a compact local cluster. A simple default is valuable for demos and deterministic integration tests, while a consensus-based mode demonstrates the additional machinery required for stronger guarantees.

## Decision

Use deterministic promotion by default: when a leader is unavailable, the lowest-id live follower promotes. Provide a separate `FAILOVER_MODE=raft` mode with term-based elections, votes, log checks, and majority commit tracking.

## Consequences

The default remains easy to explain, test, and operate in a controlled environment. It is not partition-safe and can have a split-brain window. Raft-lite improves the failure model when explicitly selected, but membership changes remain outside Raft joint consensus.

## Alternatives considered

- **Raft by default:** stronger semantics, but more operational and conceptual overhead for the primary learning path.
- **No automatic failover:** simpler implementation, but fails to demonstrate recovery behavior.
- **External coordination service:** would obscure the distributed-systems mechanisms Shardis is meant to expose.
