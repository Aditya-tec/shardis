export type ClusterGossipMessage = {
  type: "SHARD_LEADER_ANNOUNCE";
  shardId: string;
  leaderId: string;
  leaderUrl: string;
};

export function tryParseClusterGossipMessage(raw: string): ClusterGossipMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (
    body.type !== "SHARD_LEADER_ANNOUNCE" ||
    typeof body.shardId !== "string" ||
    typeof body.leaderId !== "string" ||
    typeof body.leaderUrl !== "string"
  ) {
    return null;
  }
  return body as ClusterGossipMessage;
}