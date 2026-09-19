import type { ClusterConfig, ShardConfig } from "./config.js";
import { keySlot } from "./hash.js";

export class HashRing {
  constructor(private readonly config: ClusterConfig) {}

  shardForSlot(slot: number): ShardConfig {
    const shard = this.config.shards.find(
      (candidate) => slot >= candidate.hash_range[0] && slot <= candidate.hash_range[1]
    );
    if (!shard) throw new Error(`no shard owns hash slot ${slot}`);
    return shard;
  }

  shardForKey(key: string): ShardConfig {
    return this.shardForSlot(keySlot(key));
  }

  /** Returns the CRC16 hash slot for a key (0–16383). */
  slotForKey(key: string): number {
    return keySlot(key);
  }
}
