import type { AofEntry } from "../persistence/aof.js";

export type RaftMessage =
  | { type: "RAFT_REQUEST_VOTE"; term: number; candidateId: string; lastLogIndex: number; lastLogTerm: number }
  | { type: "RAFT_VOTE"; term: number; voterId: string; granted: boolean }
  | {
      type: "RAFT_APPEND_ENTRIES";
      term: number;
      leaderId: string;
      prevLogIndex: number;
      prevLogTerm: number;
      entries: Array<{ term: number; entry: AofEntry }>;
      leaderCommit: number;
    }
  | { type: "RAFT_APPEND_RESPONSE"; term: number; followerId: string; success: boolean; matchIndex: number };

const TYPES = new Set(["RAFT_REQUEST_VOTE", "RAFT_VOTE", "RAFT_APPEND_ENTRIES", "RAFT_APPEND_RESPONSE"]);

export function tryParseRaftMessage(raw: string): RaftMessage | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && typeof parsed.type === "string" && TYPES.has(parsed.type)
      ? parsed as RaftMessage
      : null;
  } catch {
    return null;
  }
}