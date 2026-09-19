import { describe, expect, it } from "vitest";
import { RaftLog } from "../../src/raft/log.js";
import {
  appendEntriesForPeer,
  electionTimeoutMs,
  isLogUpToDate,
  majorityCount
} from "../../src/raft/raftManager.js";
import type { AofEntry } from "../../src/persistence/aof.js";

describe("Raft mechanics", () => {
  it("calculates a majority for common cluster sizes", () => {
    expect(majorityCount(1)).toBe(1);
    expect(majorityCount(3)).toBe(2);
    expect(majorityCount(5)).toBe(3);
  });

  it("orders candidate logs by term, then index", () => {
    expect(isLogUpToDate(1, 2, 99, 1)).toBe(true);
    expect(isLogUpToDate(4, 2, 3, 2)).toBe(true);
    expect(isLogUpToDate(2, 2, 3, 2)).toBe(false);
    expect(isLogUpToDate(9, 1, 3, 2)).toBe(false);
  });

  it("keeps randomized election timeouts within the configured range", () => {
    expect(electionTimeoutMs(300, 0)).toBe(150);
    expect(electionTimeoutMs(300, 0.999)).toBe(299);
  });
});

describe("RaftLog", () => {
  it("termAt returns the term for valid indices and undefined for out-of-bounds", () => {
    const log = new RaftLog();
    expect(log.termAt(0)).toBeUndefined();
    expect(log.termAt(-1)).toBeUndefined();

    log.append([
      { term: 1, entry: { op: "SET", key: "a", value: "1", expiresAt: null } },
      { term: 2, entry: { op: "SET", key: "b", value: "2", expiresAt: null } }
    ]);
    expect(log.termAt(0)).toBe(1);
    expect(log.termAt(1)).toBe(2);
    expect(log.termAt(2)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// prevLogIndex / prevLogTerm invariant
//
// RAFT_APPEND_ENTRIES must always carry prevLogIndex === peer.matchIndex
// (by the Raft definition: nextIndex[peer] = matchIndex+1, so the entry just
// before what we're sending is at matchIndex).
// ---------------------------------------------------------------------------

describe("appendEntriesForPeer prevLogIndex invariant", () => {
  function fiveEntryLog(): RaftLog {
    const log = new RaftLog();
    const entry: AofEntry = { op: "SET", key: "k", value: "v", expiresAt: null };
    log.append([
      { term: 1, entry },
      { term: 1, entry },
      { term: 1, entry },
      { term: 1, entry },
      { term: 1, entry }
    ]);
    return log;
  }

  it("new peer (matchIndex=-1): prevLogIndex=-1, prevLogTerm=0, and all 5 entries", () => {
    const result = appendEntriesForPeer(-1, fiveEntryLog());
    expect(result.prevLogIndex).toBe(-1);
    expect(result.prevLogTerm).toBe(0);
    expect(result.entries).toHaveLength(5);
  });

  it("partially-caught-up peer (matchIndex=2): prevLogIndex=2 and entries [3,4]", () => {
    const result = appendEntriesForPeer(2, fiveEntryLog());
    expect(result.prevLogIndex).toBe(2);
    expect(result.prevLogTerm).toBe(1);
    expect(result.entries).toHaveLength(2);
  });
});
