import type { ErrResponse, Request, RequestOp, Response } from "./types.js";
import type { ParseLimits, ParseResult } from "./parse.js";

// A compact binary framing for the *closed* set of message shapes this
// project actually has - not a generic serializer. Opt-in: a client sends
// a WS binary frame instead of text to use this instead of JSON. The
// default stays JSON/text specifically because it's debuggable with
// wscat/devtools; this exists to prove the capability, not replace that.
//
// Every string field is length-prefixed (u32 BE byte length + UTF-8
// bytes) so multi-byte characters round-trip exactly by byte length, not
// character count. ttl_ms uses a 1-byte presence flag + an 8-byte double
// (safe for any JS-representable number) rather than a numeric sentinel,
// since 0 is a legitimate ttl_ms ("expire immediately") and can't double
// as "absent".

const OPCODES: Record<RequestOp, number> = {
  SET: 1,
  GET: 2,
  DEL: 3,
  EXPIRE: 4,
  SUBSCRIBE: 5,
  UNSUBSCRIBE: 6,
  PUBLISH: 7
};
const OPCODE_TO_OP = new Map<number, RequestOp>(Object.entries(OPCODES).map(([op, code]) => [code, op as RequestOp]));

const STATUS_ERR = 0;
const STATUS_OK = 1;

// Ok-response optional-field presence bits, in the fixed order they're
// written/read - the response doesn't carry the op it answers, so this is
// what makes decode unambiguous without one.
const BIT_VALUE = 1 << 0;
const BIT_DELETED = 1 << 1;
const BIT_UPDATED = 1 << 2;
const BIT_SUBSCRIBED = 1 << 3;
const BIT_UNSUBSCRIBED = 1 << 4;
const BIT_DELIVERED = 1 << 5;

class BufferWriter {
  private readonly chunks: Buffer[] = [];

  writeUInt8(value: number): this {
    this.chunks.push(Buffer.from([value & 0xff]));
    return this;
  }

  writeUInt32BE(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    this.chunks.push(buf);
    return this;
  }

  writeDoubleBE(value: number): this {
    const buf = Buffer.alloc(8);
    buf.writeDoubleBE(value, 0);
    this.chunks.push(buf);
    return this;
  }

  writeString(value: string): this {
    const bytes = Buffer.from(value, "utf8");
    this.writeUInt32BE(bytes.length);
    this.chunks.push(bytes);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

class BufferReader {
  private offset = 0;

  constructor(private readonly buf: Buffer) {}

  readUInt8(): number {
    const value = this.buf.readUInt8(this.offset);
    this.offset += 1;
    return value;
  }

  readUInt32BE(): number {
    const value = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  readDoubleBE(): number {
    const value = this.buf.readDoubleBE(this.offset);
    this.offset += 8;
    return value;
  }

  readString(): string {
    const len = this.readUInt32BE();
    const value = this.buf.toString("utf8", this.offset, this.offset + len);
    this.offset += len;
    return value;
  }
}

function keyTooLarge(key: string, limit: number): boolean {
  return Buffer.byteLength(key, "utf8") > limit;
}

function valueTooLarge(value: string, limit: number): boolean {
  return Buffer.byteLength(value, "utf8") > limit;
}

function err(id: string | null, error: string): ParseResult {
  return { ok: false, response: { id, ok: false, error } };
}

export function encodeRequest(request: Request): Buffer {
  const w = new BufferWriter();
  w.writeUInt8(OPCODES[request.op]);
  w.writeString(request.id);

  switch (request.op) {
    case "SET":
      w.writeString(request.key);
      w.writeString(request.value);
      if (request.ttl_ms !== undefined) {
        w.writeUInt8(1);
        w.writeDoubleBE(request.ttl_ms);
      } else {
        w.writeUInt8(0);
      }
      w.writeString(request.write_key ?? "");
      break;
    case "GET":
      w.writeString(request.key);
      break;
    case "DEL":
      w.writeString(request.key);
      w.writeString(request.write_key ?? "");
      break;
    case "EXPIRE":
      w.writeString(request.key);
      w.writeDoubleBE(request.ttl_ms);
      w.writeString(request.write_key ?? "");
      break;
    case "SUBSCRIBE":
    case "UNSUBSCRIBE":
      w.writeString(request.channel);
      break;
    case "PUBLISH":
      w.writeString(request.channel);
      w.writeString(request.message);
      w.writeString(request.write_key ?? "");
      break;
  }

  return w.toBuffer();
}

// Mirrors parseRequest(raw, limits)'s shape exactly (same ParseResult type,
// same error strings) so app.ts can treat the binary and JSON paths
// identically after decode - the only difference is which decoder ran.
export function decodeRequest(buf: Buffer, limits: ParseLimits): ParseResult {
  let r: BufferReader;
  let opcode: number;
  let id: string;
  try {
    r = new BufferReader(buf);
    opcode = r.readUInt8();
    id = r.readString();
  } catch {
    return err(null, "malformed_binary_message");
  }

  const op = OPCODE_TO_OP.get(opcode);
  if (!op) return err(id ?? null, "unknown_op");

  try {
    if (op === "SET") {
      const key = r.readString();
      const value = r.readString();
      const hasTtl = r.readUInt8();
      const ttl_ms = hasTtl ? r.readDoubleBE() : undefined;
      const write_key = r.readString();
      if (keyTooLarge(key, limits.maxKeyBytes)) return err(id, "key_too_large");
      if (valueTooLarge(value, limits.maxValueBytes)) return err(id, "value_too_large");
      return { ok: true, request: { id, op, key, value, ttl_ms, write_key: write_key || undefined } };
    }

    if (op === "GET") {
      const key = r.readString();
      if (keyTooLarge(key, limits.maxKeyBytes)) return err(id, "key_too_large");
      return { ok: true, request: { id, op, key } };
    }

    if (op === "DEL") {
      const key = r.readString();
      const write_key = r.readString();
      if (keyTooLarge(key, limits.maxKeyBytes)) return err(id, "key_too_large");
      return { ok: true, request: { id, op, key, write_key: write_key || undefined } };
    }

    if (op === "EXPIRE") {
      const key = r.readString();
      const ttl_ms = r.readDoubleBE();
      const write_key = r.readString();
      if (keyTooLarge(key, limits.maxKeyBytes)) return err(id, "key_too_large");
      return { ok: true, request: { id, op, key, ttl_ms, write_key: write_key || undefined } };
    }

    if (op === "SUBSCRIBE" || op === "UNSUBSCRIBE") {
      const channel = r.readString();
      if (keyTooLarge(channel, limits.maxKeyBytes)) return err(id, "channel_too_large");
      return { ok: true, request: { id, op, channel } };
    }

    // PUBLISH
    const channel = r.readString();
    const message = r.readString();
    const write_key = r.readString();
    if (keyTooLarge(channel, limits.maxKeyBytes)) return err(id, "channel_too_large");
    if (valueTooLarge(message, limits.maxValueBytes)) return err(id, "message_too_large");
    return { ok: true, request: { id, op, channel, message, write_key: write_key || undefined } };
  } catch {
    return err(id, "malformed_binary_message");
  }
}

export function encodeResponse(response: Response): Buffer {
  const w = new BufferWriter();

  if (!response.ok) {
    w.writeUInt8(STATUS_ERR);
    w.writeUInt8(response.id === null ? 0 : 1);
    if (response.id !== null) w.writeString(response.id);
    w.writeString(response.error);
    // MOVED's extra shard/leader fields, when present - always writes the
    // presence flag so decode doesn't need to inspect `error` to know
    // whether to expect them.
    const hasMovedFields = response.shard !== undefined && response.leader !== undefined;
    w.writeUInt8(hasMovedFields ? 1 : 0);
    if (hasMovedFields) {
      w.writeString(response.shard!);
      w.writeString(response.leader!);
    }
    return w.toBuffer();
  }

  w.writeUInt8(STATUS_OK);
  w.writeString(response.id);

  let bits = 0;
  if (response.value !== undefined) bits |= BIT_VALUE;
  if (response.deleted !== undefined) bits |= BIT_DELETED;
  if (response.updated !== undefined) bits |= BIT_UPDATED;
  if (response.subscribed !== undefined) bits |= BIT_SUBSCRIBED;
  if (response.unsubscribed !== undefined) bits |= BIT_UNSUBSCRIBED;
  if (response.delivered !== undefined) bits |= BIT_DELIVERED;
  w.writeUInt8(bits);

  if (response.value !== undefined) {
    w.writeUInt8(response.value === null ? 0 : 1);
    if (response.value !== null) w.writeString(response.value);
  }
  if (response.deleted !== undefined) w.writeUInt8(response.deleted ? 1 : 0);
  if (response.updated !== undefined) w.writeUInt8(response.updated ? 1 : 0);
  if (response.subscribed !== undefined) w.writeUInt8(response.subscribed ? 1 : 0);
  if (response.unsubscribed !== undefined) w.writeUInt8(response.unsubscribed ? 1 : 0);
  if (response.delivered !== undefined) w.writeUInt32BE(response.delivered);

  return w.toBuffer();
}

export function decodeResponse(buf: Buffer): Response {
  const r = new BufferReader(buf);
  const status = r.readUInt8();

  if (status === STATUS_ERR) {
    const hasId = r.readUInt8();
    const id = hasId ? r.readString() : null;
    const error = r.readString();
    const hasMovedFields = r.readUInt8();
    const response: ErrResponse = { id, ok: false, error };
    if (hasMovedFields) {
      response.shard = r.readString();
      response.leader = r.readString();
    }
    return response;
  }

  const id = r.readString();
  const bits = r.readUInt8();

  const response: Response = { id, ok: true };
  if (bits & BIT_VALUE) {
    const hasValue = r.readUInt8();
    response.value = hasValue ? r.readString() : null;
  }
  if (bits & BIT_DELETED) response.deleted = r.readUInt8() === 1;
  if (bits & BIT_UPDATED) response.updated = r.readUInt8() === 1;
  if (bits & BIT_SUBSCRIBED) response.subscribed = r.readUInt8() === 1;
  if (bits & BIT_UNSUBSCRIBED) response.unsubscribed = r.readUInt8() === 1;
  if (bits & BIT_DELIVERED) response.delivered = r.readUInt32BE();
  return response;
}
