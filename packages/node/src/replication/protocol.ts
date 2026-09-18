export interface SyncEntry {
  key: string;
  value: string;
  expiresAt: number | null;
}

export type PeerMessage =
  | { type: "PEER_HELLO"; nodeId: string; shardId: string }
  | { type: "HEARTBEAT"; nodeId: string; leaderId: string }
  | { type: "REPL_OP"; leaderId: string; seq: number; op: "SET" | "DEL" | "EXPIRE"; key: string; value?: string; expiresAt?: number | null }
  | { type: "REPL_ACK"; nodeId: string; leaderId: string; seq: number }
  | { type: "SYNC_REQUEST"; nodeId: string }
  | { type: "SYNC_RESPONSE"; entries: SyncEntry[] };

const PEER_MESSAGE_TYPES = new Set([
  "PEER_HELLO",
  "HEARTBEAT",
  "REPL_OP",
  "REPL_ACK",
  "SYNC_REQUEST",
  "SYNC_RESPONSE"
]);

// Peer messages (type-tagged, no "id") and client requests (op-tagged, with
// an "id" for correlation) share the same /ws endpoint and are told apart
// purely by shape - no separate handshake or connection-level state needed.
export function tryParsePeerMessage(raw: string): PeerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  if (typeof body.type !== "string" || !PEER_MESSAGE_TYPES.has(body.type)) return null;
  return body as PeerMessage;
}
