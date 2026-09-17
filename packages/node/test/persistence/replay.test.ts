import { describe, expect, it } from "vitest";
import { Store } from "../../src/engine/store.js";
import { applyAofEntries } from "../../src/persistence/replay.js";

describe("applyAofEntries", () => {
  it("applies SET, DEL, and EXPIRE entries in order", () => {
    const store = new Store();
    applyAofEntries(store, [
      { op: "SET", key: "a", value: "1", expiresAt: null },
      { op: "SET", key: "b", value: "2", expiresAt: null },
      { op: "DEL", key: "a" },
      { op: "SET", key: "c", value: "3", expiresAt: null },
      { op: "EXPIRE", key: "c", expiresAt: Date.now() - 1 }
    ]);

    expect(store.get("a")).toBeUndefined();
    expect(store.get("b")).toBe("2");
    expect(store.get("c")).toBeUndefined();
  });

  it("a later SET for the same key wins over an earlier one, matching write order", () => {
    const store = new Store();
    applyAofEntries(store, [
      { op: "SET", key: "a", value: "old", expiresAt: null },
      { op: "SET", key: "a", value: "new", expiresAt: null }
    ]);
    expect(store.get("a")).toBe("new");
  });

  it("DEL and EXPIRE on a key never written are safe no-ops", () => {
    const store = new Store();
    expect(() =>
      applyAofEntries(store, [
        { op: "DEL", key: "never-existed" },
        { op: "EXPIRE", key: "never-existed", expiresAt: Date.now() + 1000 }
      ])
    ).not.toThrow();
    expect(store.size).toBe(0);
  });

  it("restores an absolute future expiry so the key is still live after replay", () => {
    const store = new Store();
    applyAofEntries(store, [{ op: "SET", key: "a", value: "1", expiresAt: Date.now() + 1000 * 60 }]);
    expect(store.get("a")).toBe("1");
  });
});
