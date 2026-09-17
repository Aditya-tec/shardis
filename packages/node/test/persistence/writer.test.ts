import { describe, expect, it } from "vitest";
import { entryForRequest } from "../../src/persistence/writer.js";

const now = () => 1_000_000;

describe("entryForRequest", () => {
  it("GET produces no AOF entry", () => {
    expect(entryForRequest({ id: "1", op: "GET", key: "foo" }, now)).toBeNull();
  });

  it("SET without a ttl resolves to a null (never-expiring) absolute expiry", () => {
    expect(entryForRequest({ id: "1", op: "SET", key: "foo", value: "bar" }, now)).toEqual({
      op: "SET",
      key: "foo",
      value: "bar",
      expiresAt: null
    });
  });

  it("SET with a ttl resolves ttl_ms into an absolute expiresAt using the injected clock", () => {
    expect(entryForRequest({ id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: 5000 }, now)).toEqual({
      op: "SET",
      key: "foo",
      value: "bar",
      expiresAt: 1_005_000
    });
  });

  it("DEL passes through as-is regardless of whether the key exists", () => {
    expect(entryForRequest({ id: "1", op: "DEL", key: "foo" }, now)).toEqual({ op: "DEL", key: "foo" });
  });

  it("EXPIRE resolves ttl_ms into an absolute expiresAt", () => {
    expect(entryForRequest({ id: "1", op: "EXPIRE", key: "foo", ttl_ms: 2000 }, now)).toEqual({
      op: "EXPIRE",
      key: "foo",
      expiresAt: 1_002_000
    });
  });
});
