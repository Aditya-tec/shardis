import { readFileSync } from "node:fs";

export interface ShardNode {
  id: string;
  url: string;
}

export interface ShardConfig {
  id: string;
  hash_range: [number, number];
  leader: ShardNode;
  followers: ShardNode[];
}

export interface ClusterConfig {
  shards: ShardConfig[];
}

export function loadClusterConfig(filePath: string): ClusterConfig {
  const content = readFileSync(filePath, "utf8");
  return JSON.parse(content) as ClusterConfig;
}
