# Production-readiness Roadmap

Shardis intentionally concentrates on observable distributed storage behavior in a compact implementation. The items below are future production capabilities, not missing requirements for the project's current learning and portfolio scope.

## Identity, authorization, and tenancy

| Capability | What it would require | Why it is deferred |
| --- | --- | --- |
| User identity and RBAC | An identity provider, authenticated sessions or service credentials, role policy evaluation, and audit events | The current public-demo write key is intentionally a small abuse-control mechanism, not an identity system. |
| Per-key ACLs | A key-namespace authorization model, policy propagation, efficient checks on the request path, and administration APIs | It would substantially expand data-model and policy complexity beyond the core storage exercise. |
| Multi-tenant isolation | Tenant-aware quotas, routing boundaries, observability, lifecycle management, and data-deletion guarantees | Shardis models a single cluster rather than a managed multi-tenant service. |

## Transport and data protection

| Capability | What it would require | Why it is deferred |
| --- | --- | --- |
| mTLS between nodes | Certificate issuance, rotation, trust distribution, identity binding, and failure-safe renewal | A managed TLS endpoint or reverse proxy already provides the intended public edge boundary for this project. |
| Encryption at rest | Key management, encrypted AOF/snapshot formats, rotation, and recovery procedures | Local durable files are part of the persistence demonstration; encrypted storage would be a separate security system. |
| Automated off-node backups | Authenticated snapshot export, encrypted storage, retention policy, restore validation, and disaster-recovery drills | Local AOF and snapshots make recovery behavior visible today; off-node durability is the next operational boundary. |

## Availability and scale

| Capability | What it would require | Why it is deferred |
| --- | --- | --- |
| Multi-region replication | Region-aware topology, asynchronous replication semantics, conflict policy, latency monitoring, and regional failover | The local topology is deliberately single-region so failover and resharding remain understandable and reproducible. |
| Full Raft membership changes | Joint consensus, durable configuration entries, and safe peer-add/remove workflows | Raft-lite focuses on leader election and commit behavior without turning the project into a complete consensus implementation. |
| Automatic placement and rebalancing | Capacity telemetry, placement policy, migration orchestration, admission control, and rollback | Explicit slot migration makes ownership changes and client redirects visible instead of automatic and opaque. |

## Suggested delivery order

1. Deploy the existing reduced public demo behind managed TLS and verify write-key protection.
2. Add authenticated snapshot export, scheduled backups, and a restore drill.
3. Add trend charts and reproducible scaling reports.
4. Evaluate stronger identity, encryption, and multi-region capabilities only if Shardis evolves beyond its current portfolio scope.
