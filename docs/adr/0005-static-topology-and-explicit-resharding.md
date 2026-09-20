# ADR 0005: Static Topology with Explicit Resharding

## Context

Cluster membership, routing, and data movement are separate concerns. Fully automatic gossip-based discovery and placement would make the system larger and make migration behavior harder to reason about in a portfolio-sized implementation.

## Decision

Load initial shard ranges and peers from cluster configuration. Permit runtime follower membership and leader gossip, but retain explicit operator-initiated slot migration for ownership changes.

## Consequences

The bootstrap topology is reproducible and local Compose environments are easy to understand. Dynamic followers can join without changing ownership. Resharding is observable, resumable, and intentional, but there is no fully automatic capacity-based placement or membership-driven rebalance.

## Alternatives considered

- **Fully gossip-discovered topology:** less configuration, but more convergence, security, and split-brain complexity.
- **Automatic rebalance on membership change:** convenient, but hides costly data movement and requires stronger placement safety.
- **Immutable topology:** simplest, but cannot demonstrate live migration or runtime membership.
