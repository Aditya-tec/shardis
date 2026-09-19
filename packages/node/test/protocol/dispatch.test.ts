import { describe, expect, it } from "vitest";
import { Store } from "../../src/engine/store.js";
import { dispatch } from "../../src/protocol/dispatch.js";

describe("dispatch", () => {
  it("SET applies the write and acks", () => {
    const store = new Store();
    const response = dispatch({ id: "1", op: "SET", key: "foo", value: "bar" }, store);
    expect(response).toEqual({ id: "1", ok: true });
    expect(store.get("foo")).toBe("bar");
  });

  it("GET returns the stored value", () => {
    const store = new Store();
    store.set("foo", "bar");
    const response = dispatch({ id: "1", op: "GET", key: "foo" }, store);
    expect(response).toEqual({ id: "1", ok: true, value: "bar" });
  });

  it("GET returns null (not an error) for a missing key", () => {
    const store = new Store();
    const response = dispatch({ id: "1", op: "GET", key: "missing" }, store);
    expect(response).toEqual({ id: "1", ok: true, value: null });
  });

  it("DEL reports whether a key was actually removed", () => {
    const store = new Store();
    store.set("foo", "bar");
    expect(dispatch({ id: "1", op: "DEL", key: "foo" }, store)).toEqual({ id: "1", ok: true, deleted: true });
    expect(dispatch({ id: "2", op: "DEL", key: "foo" }, store)).toEqual({ id: "2", ok: true, deleted: false });
  });

  it("EXPIRE reports whether the ttl was actually updated", () => {
    const store = new Store();
    store.set("foo", "bar");
    expect(dispatch({ id: "1", op: "EXPIRE", key: "foo", ttl_ms: 1000 }, store)).toEqual({
      id: "1",
      ok: true,
      updated: true
    });
    expect(dispatch({ id: "2", op: "EXPIRE", key: "missing", ttl_ms: 1000 }, store)).toEqual({
      id: "2",
      ok: true,
      updated: false
    });
  });

  it("TTL returns remaining ms, null for no expiry, and not_found for missing keys", () => {
    const store = new Store({ now: () => 1000 });
    store.set("forever", "x");
    store.set("timed", "y", 500);
    expect(dispatch({ id: "1", op: "TTL", key: "forever" }, store)).toEqual({
      id: "1",
      ok: true,
      ttl_ms: null
    });
    expect(dispatch({ id: "2", op: "TTL", key: "timed" }, store)).toEqual({
      id: "2",
      ok: true,
      ttl_ms: 500
    });
    expect(dispatch({ id: "3", op: "TTL", key: "missing" }, store)).toEqual({
      id: "3",
      ok: false,
      error: "not_found"
    });
  });
});
