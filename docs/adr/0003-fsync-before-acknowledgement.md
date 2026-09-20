# ADR 0003: fsync Before Acknowledgement

## Context

An acknowledged write that disappears after a process crash undermines the persistence model. Shardis uses append-only logging and snapshots, so the acknowledgement point must be explicit.

## Decision

Append and fsync every durable write before applying it and acknowledging the client. Snapshot files are written through an fsync-and-atomic-rename sequence; after a snapshot captures state, the AOF is truncated to hold only the subsequent tail.

## Consequences

Crash recovery reconstructs snapshot state plus the durable AOF tail, and an acknowledgement represents a locally durable write. The trade-off is lower write throughput and higher tail latency than buffered or asynchronous persistence.

## Alternatives considered

- **Buffered AOF writes:** higher throughput, but acknowledged writes may be lost during a crash.
- **Periodic fsync:** configurable latency/durability trade-off, but less direct semantics for a teaching system.
- **Memory-only writes:** simpler, but inconsistent with Shardis's durability goals.
