import type { ErrResponse, Request, RequestOp } from "./types.js";

export interface ParseLimits {
  maxKeyBytes: number;
  maxValueBytes: number;
}

export type ParseResult = { ok: true; request: Request } | { ok: false; response: ErrResponse };

const KNOWN_OPS: ReadonlySet<RequestOp> = new Set([
  "SET",
  "GET",
  "DEL",
  "EXPIRE",
  "TTL",
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "PUBLISH"
]);

function err(id: string | null, error: string): ParseResult {
  return { ok: false, response: { id, ok: false, error } };
}

function keyTooLarge(key: string, limit: number): boolean {
  return Buffer.byteLength(key, "utf8") > limit;
}

function valueTooLarge(value: string, limit: number): boolean {
  return Buffer.byteLength(value, "utf8") > limit;
}

function writeKey(body: Record<string, unknown>): string | undefined {
  return typeof body.write_key === "string" ? body.write_key : undefined;
}

function asking(body: Record<string, unknown>): true | undefined {
  return body.asking === true ? true : undefined;
}

export function parseRequest(raw: string, limits: ParseLimits): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err(null, "malformed_json");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return err(null, "malformed_message");
  }

  const body = parsed as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : null;
  if (id === null) {
    return err(null, "missing_id");
  }

  if (typeof body.op !== "string" || !KNOWN_OPS.has(body.op as RequestOp)) {
    return err(id, "unknown_op");
  }
  const op = body.op as RequestOp;

  if (op === "SET") {
    if (typeof body.key !== "string") return err(id, "missing_key");
    if (typeof body.value !== "string") return err(id, "missing_value");
    if (body.ttl_ms !== undefined && (typeof body.ttl_ms !== "number" || !Number.isFinite(body.ttl_ms))) {
      return err(id, "invalid_ttl");
    }
    if (keyTooLarge(body.key, limits.maxKeyBytes)) return err(id, "key_too_large");
    if (valueTooLarge(body.value, limits.maxValueBytes)) return err(id, "value_too_large");
    return {
      ok: true,
      request: {
        id,
        op,
        key: body.key,
        value: body.value,
        ttl_ms: body.ttl_ms as number | undefined,
        write_key: writeKey(body),
        asking: asking(body)
      }
    };
  }

  if (op === "GET" || op === "DEL" || op === "TTL") {
    if (typeof body.key !== "string") return err(id, "missing_key");
    if (keyTooLarge(body.key, limits.maxKeyBytes)) return err(id, "key_too_large");
    if (op === "DEL") return { ok: true, request: { id, op, key: body.key, write_key: writeKey(body), asking: asking(body) } };
    if (op === "TTL") return { ok: true, request: { id, op, key: body.key, asking: asking(body) } };
    return { ok: true, request: { id, op, key: body.key, asking: asking(body) } };
  }

  if (op === "EXPIRE") {
    if (typeof body.key !== "string") return err(id, "missing_key");
    if (typeof body.ttl_ms !== "number" || !Number.isFinite(body.ttl_ms)) return err(id, "invalid_ttl");
    if (keyTooLarge(body.key, limits.maxKeyBytes)) return err(id, "key_too_large");
    return { ok: true, request: { id, op, key: body.key, ttl_ms: body.ttl_ms, write_key: writeKey(body), asking: asking(body) } };
  }

  if (op === "SUBSCRIBE" || op === "UNSUBSCRIBE") {
    if (typeof body.channel !== "string") return err(id, "missing_channel");
    if (keyTooLarge(body.channel, limits.maxKeyBytes)) return err(id, "channel_too_large");
    return { ok: true, request: { id, op, channel: body.channel } };
  }

  // PUBLISH
  if (typeof body.channel !== "string") return err(id, "missing_channel");
  if (typeof body.message !== "string") return err(id, "missing_message");
  if (keyTooLarge(body.channel, limits.maxKeyBytes)) return err(id, "channel_too_large");
  if (valueTooLarge(body.message, limits.maxValueBytes)) return err(id, "message_too_large");
  const scope = body.scope === "cluster" ? "cluster" as const : body.scope === "local" ? "local" as const : undefined;
  return { ok: true, request: { id, op, channel: body.channel, message: body.message, write_key: writeKey(body), scope } };
}
