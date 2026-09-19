export type ClusterGossipMessage =
  | {
      type: "SHARD_LEADER_ANNOUNCE";
      shardId: string;
      leaderId: string;
      leaderUrl: string;
      clusterSecret?: string;
    }
  | {
      // Source shard is migrating this slot out; writes for new keys in
      // this slot should land on the destination (clients get ASK redirects
      // for keys not yet physically transferred).
      type: "SLOT_MIGRATING";
      slot: number;
      fromShard: string;
      toShard: string;
    }
  | {
      // Destination shard is importing this slot; it accepts new writes for
      // it while the source still holds pre-existing keys.
      type: "SLOT_IMPORTING";
      slot: number;
      fromShard: string;
      toShard: string;
    }
  | {
      // Slot migration complete; all nodes update their routing table.
      type: "SLOT_OWNED";
      slot: number;
      shard: string;
    }
  | {
      // Compact catch-up for a node that missed live SLOT_OWNED messages
      // (restart / new connection). diffs are only slots that differ from
      // the receiver's static config baseline.
      type: "SLOT_TABLE";
      diffs: Array<{ slot: number; shard: string }>;
      migrating: Array<{ slot: number; fromShard: string; toShard: string }>;
    }
  | {
      // Cluster-wide PUBLISH relay. Recipients deliver locally and do not
      // flood-fill — the origin already broadcast to every gossip peer.
      type: "PUBLISH_RELAY";
      channel: string;
      message: string;
    };

const GOSSIP_TYPES = new Set([
  "SHARD_LEADER_ANNOUNCE",
  "SLOT_MIGRATING",
  "SLOT_IMPORTING",
  "SLOT_OWNED",
  "SLOT_TABLE",
  "PUBLISH_RELAY"
]);

export function tryParseClusterGossipMessage(raw: string): ClusterGossipMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (typeof body.type !== "string" || !GOSSIP_TYPES.has(body.type)) return null;

  if (body.type === "SHARD_LEADER_ANNOUNCE") {
    if (
      typeof body.shardId !== "string" ||
      typeof body.leaderId !== "string" ||
      typeof body.leaderUrl !== "string"
    ) return null;
  }

  if (body.type === "SLOT_MIGRATING" || body.type === "SLOT_IMPORTING") {
    if (
      typeof body.slot !== "number" ||
      typeof body.fromShard !== "string" ||
      typeof body.toShard !== "string"
    ) return null;
  }

  if (body.type === "SLOT_OWNED") {
    if (typeof body.slot !== "number" || typeof body.shard !== "string") return null;
  }

  if (body.type === "SLOT_TABLE") {
    if (!Array.isArray(body.diffs) || !Array.isArray(body.migrating)) return null;
  }

  if (body.type === "PUBLISH_RELAY") {
    if (typeof body.channel !== "string" || typeof body.message !== "string") return null;
  }

  return body as ClusterGossipMessage;
}