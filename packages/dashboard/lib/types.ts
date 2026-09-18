export interface NodeDescriptor {
  id: string;
  shard: string;
  httpUrl: string;
  wsUrl: string;
}

export interface ShardDescriptor {
  id: string;
  hashRange: [number, number];
  nodeIds: string[];
}

export interface NodeStatus {
  id: string;
  shard: string;
  reachable: boolean;
  role: "leader" | "follower" | "unknown";
  uptimeS: number | null;
  keys: number | null;
  evictions: number | null;
  opsTotal: number | null;
  connectedSockets: number | null;
  connectedPeers: number | null;
  replicationLagMs: number | null;
  lastUpdated: number;
}

export interface LiveEvent {
  nodeId: string;
  ts: string;
  event: string;
  [key: string]: unknown;
}
