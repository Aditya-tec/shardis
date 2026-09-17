import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Store } from "../../src/engine/store.js";

describe("Store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets and gets a value", () => {
    const store = new Store();
    store.set("foo", "bar");
    expect(store.get("foo")).toBe("bar");
  });

  it("returns undefined for a missing key", () => {
    const store = new Store();
    expect(store.get("missing")).toBeUndefined();
  });

  it("deletes a key", () => {
    const store = new Store();
    store.set("foo", "bar");
    expect(store.del("foo")).toBe(true);
    expect(store.get("foo")).toBeUndefined();
    expect(store.del("foo")).toBe(false);
  });

  it("expires a key lazily on read after ttl elapses", () => {
    const store = new Store();
    store.set("foo", "bar", 1000);
    expect(store.get("foo")).toBe("bar");
    vi.advanceTimersByTime(1001);
    expect(store.get("foo")).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("treats ttl expiry as inclusive at the exact boundary", () => {
    const store = new Store();
    store.set("foo", "bar", 1000);
    vi.advanceTimersByTime(1000);
    expect(store.get("foo")).toBeUndefined();
  });

  it("a key with no ttl never expires", () => {
    const store = new Store();
    store.set("foo", "bar");
    vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);
    expect(store.get("foo")).toBe("bar");
  });

  it("overwriting a key via SET clears any previous ttl", () => {
    const store = new Store();
    store.set("foo", "bar", 1000);
    store.set("foo", "baz");
    vi.advanceTimersByTime(2000);
    expect(store.get("foo")).toBe("baz");
  });

  it("EXPIRE updates ttl on an existing key", () => {
    const store = new Store();
    store.set("foo", "bar");
    expect(store.expire("foo", 1000)).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(store.get("foo")).toBeUndefined();
  });

  it("EXPIRE on a missing key returns false", () => {
    const store = new Store();
    expect(store.expire("missing", 1000)).toBe(false);
  });

  it("EXPIRE on an already-expired key returns false and cleans it up", () => {
    const store = new Store();
    store.set("foo", "bar", 100);
    vi.advanceTimersByTime(200);
    expect(store.expire("foo", 1000)).toBe(false);
    expect(store.size).toBe(0);
  });

  it("a zero or negative ttl expires the key immediately", () => {
    const store = new Store();
    store.set("foo", "bar", 0);
    expect(store.get("foo")).toBeUndefined();

    store.set("baz", "qux", -1);
    expect(store.get("baz")).toBeUndefined();
  });

  it("ttl() reports remaining time, null for no-expiry, undefined for missing/expired", () => {
    const store = new Store();
    store.set("persistent", "v");
    store.set("expiring", "v", 5000);

    expect(store.ttl("persistent")).toBeNull();
    expect(store.ttl("expiring")).toBe(5000);
    expect(store.ttl("nope")).toBeUndefined();

    vi.advanceTimersByTime(5000);
    expect(store.ttl("expiring")).toBeUndefined();
  });

  it("has() respects expiry without leaving a lingering entry", () => {
    const store = new Store();
    store.set("foo", "bar", 100);
    vi.advanceTimersByTime(200);
    expect(store.has("foo")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("periodic sweep removes expired keys without requiring a read", () => {
    const store = new Store();
    store.set("foo", "bar", 1000);
    store.set("persistent", "v");
    store.startSweep(500);

    vi.advanceTimersByTime(1500);
    expect(store.size).toBe(1);
    expect(store.sweepExpired()).toBe(0);

    store.stopSweep();
  });

  it("sweepExpired returns the count of removed keys", () => {
    const store = new Store();
    store.set("a", "1", 100);
    store.set("b", "2", 100);
    store.set("c", "3");
    vi.advanceTimersByTime(200);
    expect(store.sweepExpired()).toBe(2);
    expect(store.size).toBe(1);
  });

  it("keys() reflects live keys after sets and deletes", () => {
    const store = new Store();
    store.set("a", "1");
    store.set("b", "2");
    store.del("a");
    expect(Array.from(store.keys())).toEqual(["b"]);
  });

  it("restoreSet writes an already-resolved absolute expiry, not a ttl relative to now()", () => {
    const store = new Store();
    const expiresAt = Date.now() + 1000;
    store.restoreSet("foo", "bar", expiresAt);
    expect(store.get("foo")).toBe("bar");

    vi.advanceTimersByTime(1001);
    expect(store.get("foo")).toBeUndefined();
  });

  it("restoreSet with expiresAt null never expires", () => {
    const store = new Store();
    store.restoreSet("foo", "bar", null);
    vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);
    expect(store.get("foo")).toBe("bar");
  });

  it("restoreExpire updates the expiry of an existing key", () => {
    const store = new Store();
    store.set("foo", "bar");
    store.restoreExpire("foo", Date.now() + 500);
    vi.advanceTimersByTime(501);
    expect(store.get("foo")).toBeUndefined();
  });

  it("restoreExpire on a missing key is a no-op, not an error", () => {
    const store = new Store();
    expect(() => store.restoreExpire("missing", Date.now() + 500)).not.toThrow();
    expect(store.has("missing")).toBe(false);
  });

  it("dump() exports only live entries, excluding expired ones, without mutating the store", () => {
    const store = new Store();
    store.set("live", "v1");
    store.set("expiring", "v2", 1000);
    vi.advanceTimersByTime(1001);

    expect(store.dump()).toEqual([{ key: "live", value: "v1", expiresAt: null }]);
    // Reading via dump() must not have swept the expired entry as a side effect.
    expect(store.size).toBe(2);
  });

  describe("LRU eviction under maxmemoryBytes", () => {
    // Each key/value below is deliberately sized so every entry is exactly
    // 10 bytes ("k0"+"0".repeat(8) etc.), making byte-cap math exact.
    function sizedEntry(store: Store, key: string, valueLen: number): void {
      store.set(key, "v".repeat(valueLen));
    }

    it("does not evict when no maxmemoryBytes cap is configured", () => {
      const store = new Store();
      for (let i = 0; i < 1000; i += 1) sizedEntry(store, `key-${i}`, 100);
      expect(store.evictions).toBe(0);
      expect(store.size).toBe(1000);
    });

    it("evicts the least-recently-used entry first once over the cap", () => {
      // "a"/"b"/"c" are each 1 (key) + 1 (value) = 2 bytes; cap of 4 bytes
      // holds exactly two entries.
      const store = new Store({ maxmemoryBytes: 4 });
      store.set("a", "1");
      store.set("b", "2");
      expect(store.evictions).toBe(0);

      store.set("c", "3");
      expect(store.evictions).toBe(1);
      // "a" was least-recently-used (written first, never touched again).
      expect(store.has("a")).toBe(false);
      expect(store.get("b")).toBe("2");
      expect(store.get("c")).toBe("3");
    });

    it("a GET touch protects a key from being the next eviction victim", () => {
      const store = new Store({ maxmemoryBytes: 4 });
      store.set("a", "1");
      store.set("b", "2");
      store.get("a"); // touch "a" - "b" is now the least-recently-used

      store.set("c", "3");
      expect(store.has("b")).toBe(false);
      expect(store.get("a")).toBe("1");
      expect(store.get("c")).toBe("3");
    });

    it("evicts multiple entries in one write if needed to get back under cap", () => {
      const store = new Store({ maxmemoryBytes: 4 });
      store.set("a", "1");
      store.set("b", "2");
      // A larger value can require evicting more than one older entry.
      store.set("c", "34");
      expect(store.has("a")).toBe(false);
      expect(store.has("b")).toBe(false);
      expect(store.get("c")).toBe("34");
      expect(store.evictions).toBe(2);
    });

    it("overwriting an existing key accounts for its old size, not double-counting it", () => {
      const store = new Store({ maxmemoryBytes: 4 });
      store.set("a", "1");
      store.set("a", "11"); // still within cap: 1(key)+2(value)=3 <= 4
      expect(store.evictions).toBe(0);
      expect(store.get("a")).toBe("11");
    });
  });
});
