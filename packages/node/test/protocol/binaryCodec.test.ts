import { describe, expect, it } from "vitest";
import { decodeRequest, decodeResponse, encodeRequest, encodeResponse } from "../../src/protocol/binaryCodec.js";
import type { OkResponse, Request } from "../../src/protocol/types.js";

const limits = { maxKeyBytes: 1024, maxValueBytes: 65536 };

function roundTripRequest(request: Request) {
  const encoded = encodeRequest(request);
  const result = decodeRequest(encoded, limits);
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.request).toEqual(request);
}

describe("binaryCodec request round-trip", () => {
  it("SET without ttl or write_key", () => {
    roundTripRequest({ id: "1", op: "SET", key: "foo", value: "bar" });
  });

  it("SET with ttl_ms", () => {
    roundTripRequest({ id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: 5000 });
  });

  it("SET with write_key", () => {
    roundTripRequest({ id: "1", op: "SET", key: "foo", value: "bar", write_key: "secret" });
  });

  it("SET with both ttl_ms and write_key", () => {
    roundTripRequest({ id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: 1000, write_key: "secret" });
  });

  it("GET", () => {
    roundTripRequest({ id: "1", op: "GET", key: "foo" });
  });

  it("DEL without write_key", () => {
    roundTripRequest({ id: "1", op: "DEL", key: "foo" });
  });

  it("DEL with write_key", () => {
    roundTripRequest({ id: "1", op: "DEL", key: "foo", write_key: "secret" });
  });

  it("EXPIRE", () => {
    roundTripRequest({ id: "1", op: "EXPIRE", key: "foo", ttl_ms: 2000 });
  });

  it("SUBSCRIBE", () => {
    roundTripRequest({ id: "1", op: "SUBSCRIBE", channel: "events" });
  });

  it("UNSUBSCRIBE", () => {
    roundTripRequest({ id: "1", op: "UNSUBSCRIBE", channel: "events" });
  });

  it("PUBLISH", () => {
    roundTripRequest({ id: "1", op: "PUBLISH", channel: "events", message: "hi" });
  });

  it("PUBLISH with write_key", () => {
    roundTripRequest({ id: "1", op: "PUBLISH", channel: "events", message: "hi", write_key: "secret" });
  });

  it("empty string key/value round-trip correctly", () => {
    roundTripRequest({ id: "1", op: "SET", key: "", value: "" });
  });

  it("multi-byte UTF-8 content round-trips by byte length, not character count", () => {
    roundTripRequest({ id: "1", op: "SET", key: "café-🎉", value: "日本語のテキスト" });
  });

  it("a ttl_ms of exactly 0 is preserved, not treated as absent", () => {
    roundTripRequest({ id: "1", op: "SET", key: "foo", value: "bar", ttl_ms: 0 });
  });

  it("rejects an oversized key the same way the JSON path does", () => {
    const encoded = encodeRequest({ id: "1", op: "SET", key: "a".repeat(2000), value: "v" });
    const result = decodeRequest(encoded, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("key_too_large");
  });

  it("rejects an oversized value the same way the JSON path does", () => {
    const encoded = encodeRequest({ id: "1", op: "SET", key: "k", value: "v".repeat(100000) });
    const result = decodeRequest(encoded, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("value_too_large");
  });

  it("rejects a truncated/malformed buffer without throwing", () => {
    const result = decodeRequest(Buffer.from([1, 0, 0, 0, 5, 102]), limits); // claims a 5-byte id, only 1 byte present
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("malformed_binary_message");
  });

  it("rejects an unknown opcode cleanly", () => {
    const buf = Buffer.concat([Buffer.from([99]), encodeRequest({ id: "x", op: "GET", key: "k" }).subarray(1)]);
    const result = decodeRequest(buf, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.error).toBe("unknown_op");
  });
});

describe("binaryCodec response round-trip", () => {
  function roundTripOk(response: OkResponse) {
    const decoded = decodeResponse(encodeResponse(response));
    expect(decoded).toEqual(response);
  }

  it("a bare ok with no extra fields", () => {
    roundTripOk({ id: "1", ok: true });
  });

  it("GET hit (value present)", () => {
    roundTripOk({ id: "1", ok: true, value: "bar" });
  });

  it("GET miss (value explicitly null, not absent)", () => {
    roundTripOk({ id: "1", ok: true, value: null });
  });

  it("DEL response", () => {
    roundTripOk({ id: "1", ok: true, deleted: true });
    roundTripOk({ id: "1", ok: true, deleted: false });
  });

  it("EXPIRE response", () => {
    roundTripOk({ id: "1", ok: true, updated: true });
  });

  it("SUBSCRIBE/UNSUBSCRIBE responses", () => {
    roundTripOk({ id: "1", ok: true, subscribed: true });
    roundTripOk({ id: "1", ok: true, unsubscribed: true });
  });

  it("PUBLISH response with a delivered count", () => {
    roundTripOk({ id: "1", ok: true, delivered: 3 });
    roundTripOk({ id: "1", ok: true, delivered: 0 });
  });

  it("an error response with an id", () => {
    const decoded = decodeResponse(encodeResponse({ id: "1", ok: false, error: "key_too_large" }));
    expect(decoded).toEqual({ id: "1", ok: false, error: "key_too_large" });
  });

  it("an error response with a null id (e.g. malformed input)", () => {
    const decoded = decodeResponse(encodeResponse({ id: null, ok: false, error: "malformed_json" }));
    expect(decoded).toEqual({ id: null, ok: false, error: "malformed_json" });
  });

  it("a MOVED response carries its shard/leader redirect fields", () => {
    const original = { id: "1", ok: false as const, error: "MOVED", shard: "shard-b", leader: "ws://node-b1:7000/ws" };
    const decoded = decodeResponse(encodeResponse(original));
    expect(decoded).toEqual(original);
  });
});
