import { describe, expect, it } from "vitest";
import { parseRequest } from "../../src/protocol/parse.js";

const limits = { maxKeyBytes: 16, maxValueBytes: 32 };

describe("parseRequest", () => {
  it("parses a valid SET request", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar" }), limits);
    expect(result).toEqual({ ok: true, request: { id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: undefined } });
  });

  it("parses a valid SET request with ttl_ms", () => {
    const result = parseRequest(
      JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: 1000 }),
      limits
    );
    expect(result).toEqual({
      ok: true,
      request: { id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: 1000 }
    });
  });

  it("parses a valid GET request", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "GET", key: "foo" }), limits);
    expect(result).toEqual({ ok: true, request: { id: "1", op: "GET", key: "foo" } });
  });

  it("parses a valid DEL request", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "DEL", key: "foo" }), limits);
    expect(result).toEqual({ ok: true, request: { id: "1", op: "DEL", key: "foo" } });
  });

  it("parses a valid EXPIRE request", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "EXPIRE", key: "foo", ttl_ms: 500 }), limits);
    expect(result).toEqual({ ok: true, request: { id: "1", op: "EXPIRE", key: "foo", ttl_ms: 500 } });
  });

  it("rejects invalid JSON without crashing, id null since it can't be trusted", () => {
    const result = parseRequest("{not json", limits);
    expect(result).toEqual({ ok: false, response: { id: null, ok: false, error: "malformed_json" } });
  });

  it("rejects a JSON array payload", () => {
    const result = parseRequest("[1,2,3]", limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("malformed_message");
  });

  it("rejects a JSON primitive payload", () => {
    const result = parseRequest("42", limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("malformed_message");
  });

  it("rejects a missing id", () => {
    const result = parseRequest(JSON.stringify({ op: "GET", key: "foo" }), limits);
    expect(result).toEqual({ ok: false, response: { id: null, ok: false, error: "missing_id" } });
  });

  it("rejects an unknown op but preserves the id for correlation", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "DESTROY", key: "foo" }), limits);
    expect(result).toEqual({ ok: false, response: { id: "1", ok: false, error: "unknown_op" } });
  });

  it("rejects SET missing a key", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "SET", value: "bar" }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("missing_key");
  });

  it("rejects SET missing a value", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "SET", key: "foo" }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("missing_value");
  });

  it("rejects SET with a non-numeric ttl_ms", () => {
    const result = parseRequest(
      JSON.stringify({ id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: "soon" }),
      limits
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("invalid_ttl");
  });

  it("rejects EXPIRE missing ttl_ms", () => {
    const result = parseRequest(JSON.stringify({ id: "1", op: "EXPIRE", key: "foo" }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("invalid_ttl");
  });

  it("rejects a key over the configured byte limit", () => {
    const result = parseRequest(
      JSON.stringify({ id: "1", op: "GET", key: "a-key-way-too-long-for-the-limit" }),
      limits
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("key_too_large");
  });

  it("rejects a value over the configured byte limit", () => {
    const result = parseRequest(
      JSON.stringify({ id: "1", op: "SET", key: "foo", value: "a".repeat(64) }),
      limits
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("value_too_large");
  });

  it("measures size limits in bytes, not characters, for multi-byte utf8", () => {
    // "é" is 2 bytes in utf8; 9 copies is 18 bytes > the 16-byte key limit.
    const key = "é".repeat(9);
    const result = parseRequest(JSON.stringify({ id: "1", op: "GET", key }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("key_too_large");
  });
});
