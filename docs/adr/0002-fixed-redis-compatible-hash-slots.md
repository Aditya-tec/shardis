# ADR 0002: Fixed Redis-compatible Hash Slots

## Context

The cluster needs stable key ownership, client redirects, and explicit live migration. A consistent-hash ring with virtual nodes is a common option, but it makes ownership changes less concrete to inspect and operate.

## Decision

Use 16,384 CRC16 hash slots and Redis-style hash tags. Assign contiguous slot ranges to shards and move ownership one slot at a time during resharding.

## Consequences

Routing is deterministic, inspectable, and compatible with the familiar `MOVED` and `ASK` client model. Operators can reason about and resume individual slot moves. Naively recomputing contiguous ranges can move a larger fraction of keys than a virtual-node ring, so Shardis uses explicit migration rather than presenting a range recompute as live resharding.

## Alternatives considered

- **Virtual-node consistent hashing:** smoother automatic redistribution, but less direct control over migration and less alignment with Redis Cluster semantics.
- **Modulo sharding:** simple, but remaps nearly all keys as shard counts change.
- **Central request proxy:** hides redirects and shifts routing complexity into a separate component.
