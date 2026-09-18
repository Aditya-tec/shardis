import type { NodeDescriptor, ShardDescriptor } from "./types";

// Matches docker-compose.yml + cluster.config.local.json: the browser runs
// outside the Docker network, so these are the host-exposed ports, not the
// internal service-name URLs the nodes use to talk to each other.
const DEFAULT_NODES: NodeDescriptor[] = [
  { id: "node-a1", shard: "shard-a", httpUrl: "http://localhost:7001", wsUrl: "ws://localhost:7001/ws" },
  { id: "node-a2", shard: "shard-a", httpUrl: "http://localhost:7002", wsUrl: "ws://localhost:7002/ws" },
  { id: "node-b1", shard: "shard-b", httpUrl: "http://localhost:7003", wsUrl: "ws://localhost:7003/ws" },
  { id: "node-b2", shard: "shard-b", httpUrl: "http://localhost:7004", wsUrl: "ws://localhost:7004/ws" },
  { id: "node-c1", shard: "shard-c", httpUrl: "http://localhost:7005", wsUrl: "ws://localhost:7005/ws" },
  { id: "node-c2", shard: "shard-c", httpUrl: "http://localhost:7006", wsUrl: "ws://localhost:7006/ws" }
];

const DEFAULT_SHARDS: ShardDescriptor[] = [
  { id: "shard-a", hashRange: [0, 5460], nodeIds: ["node-a1", "node-a2"] },
  { id: "shard-b", hashRange: [5461, 10922], nodeIds: ["node-b1", "node-b2"] },
  { id: "shard-c", hashRange: [10923, 16383], nodeIds: ["node-c1", "node-c2"] }
];

function parseEnvJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// Overridable via env for pointing the same dashboard build at a different
// deployment (e.g. the smaller Render demo topology in a later step)
// without a code change.
export const NODES: NodeDescriptor[] =
  parseEnvJson<NodeDescriptor[]>(process.env.NEXT_PUBLIC_CLUSTER_NODES) ?? DEFAULT_NODES;

export const SHARDS: ShardDescriptor[] =
  parseEnvJson<ShardDescriptor[]>(process.env.NEXT_PUBLIC_CLUSTER_SHARDS) ?? DEFAULT_SHARDS;

export const HASH_SLOT_COUNT = 16384;
