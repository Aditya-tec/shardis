export interface NodeConfig {
  nodeId: string;
  role: "leader" | "follower";
  failoverMode?: "deterministic" | "raft";
  shardId: string;
  clusterConfigPath: string;
  dataDir: string;
  port: number;
  nodeUrl?: string;
  joinUrl?: string;
  maxmemoryMb: number;
  ttlSweepIntervalMs: number;
  snapshotIntervalMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  rateLimitRps: number;
  maxConnectionsPerIp: number;
  maxKeyBytes: number;
  maxValueBytes: number;
  publicDemo: boolean;
  demoWriteKey: string | undefined;
  // When set, all peer connections (replication + gossip) must present this
  // secret in PEER_HELLO / SHARD_LEADER_ANNOUNCE to be accepted.
  clusterSecret: string | undefined;
}

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export function loadConfig(): NodeConfig {
  const role = requireEnv("ROLE", "leader");
  if (role !== "leader" && role !== "follower") {
    throw new Error(`ROLE must be "leader" or "follower", got: ${role}`);
  }

  const nodeId = requireEnv("NODE_ID", "node-a1");
  const failoverMode = process.env.FAILOVER_MODE ?? "deterministic";
  if (failoverMode !== "deterministic" && failoverMode !== "raft") {
    throw new Error(`FAILOVER_MODE must be "deterministic" or "raft", got: ${failoverMode}`);
  }

  return {
    nodeId,
    role,
    failoverMode,
    shardId: requireEnv("SHARD_ID", "shard-a"),
    clusterConfigPath: requireEnv("CLUSTER_CONFIG_PATH", "./cluster.config.local.json"),
    dataDir: requireEnv("DATA_DIR", `./data/${nodeId}`),
    port: intEnv("PORT", 7000),
    nodeUrl: process.env.NODE_URL ?? `ws://127.0.0.1:${intEnv("PORT", 7000)}/ws`,
    joinUrl: process.env.JOIN_URL,
    maxmemoryMb: intEnv("MAXMEMORY_MB", 64),
    ttlSweepIntervalMs: intEnv("TTL_SWEEP_INTERVAL_MS", 1000),
    snapshotIntervalMs: intEnv("SNAPSHOT_INTERVAL_MS", 60000),
    heartbeatIntervalMs: intEnv("HEARTBEAT_INTERVAL_MS", 1000),
    heartbeatTimeoutMs: intEnv("HEARTBEAT_TIMEOUT_MS", 3000),
    rateLimitRps: intEnv("RATE_LIMIT_RPS", 50),
    maxConnectionsPerIp: intEnv("MAX_CONNECTIONS_PER_IP", 20),
    maxKeyBytes: intEnv("MAX_KEY_BYTES", 1024),
    maxValueBytes: intEnv("MAX_VALUE_BYTES", 65536),
    publicDemo: (process.env.PUBLIC_DEMO ?? "false") === "true",
    demoWriteKey: process.env.DEMO_WRITE_KEY,
    clusterSecret: process.env.CLUSTER_SECRET
  };
}
