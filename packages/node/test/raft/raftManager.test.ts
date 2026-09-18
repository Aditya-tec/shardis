import { describe, expect, it } from "vitest";
import { electionTimeoutMs, isLogUpToDate, majorityCount } from "../../src/raft/raftManager.js";

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