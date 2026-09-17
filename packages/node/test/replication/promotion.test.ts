import { describe, expect, it } from "vitest";
import { selectPromotedLeader } from "../../src/replication/promotion.js";

describe("selectPromotedLeader", () => {
  it("picks the lowest id among self and live others", () => {
    expect(selectPromotedLeader("node-a2", ["node-a3"], "node-a1")).toBe("node-a2");
    expect(selectPromotedLeader("node-a3", ["node-a2"], "node-a1")).toBe("node-a2");
  });

  it("promotes self when self has the lowest id", () => {
    expect(selectPromotedLeader("node-a1", ["node-a2", "node-a3"], "node-a0")).toBe("node-a1");
  });

  it("excludes the presumed-dead leader even if it appears in liveOtherIds", () => {
    // Defensive: shouldn't normally happen, but the dead leader must never win.
    expect(selectPromotedLeader("node-a3", ["node-a1", "node-a2"], "node-a1")).toBe("node-a2");
  });

  it("promotes self when there are no other live peers", () => {
    expect(selectPromotedLeader("node-a2", [], "node-a1")).toBe("node-a2");
  });
});
