export type StoreOp = "SET" | "GET" | "DEL" | "EXPIRE" | "TTL";
export type PubSubOp = "SUBSCRIBE" | "UNSUBSCRIBE" | "PUBLISH";
export type RequestOp = StoreOp | PubSubOp;

interface BaseRequest {
  id: string;
  op: RequestOp;
}

// Present, and checked against DEMO_WRITE_KEY, only when PUBLIC_DEMO=true.
// Ignored otherwise - local/CI environments run open, matching the spec's
// "local/CI open, public demo gated" design.
interface WriteProtected {
  write_key?: string;
}

// Set when a client is following an ASK redirect for this one request.
// The destination must serve it even though the slot's runtime owner is
// still the source (the slot is mid-migration). Not a permanent routing
// change — that happens later via MOVED / SLOT_OWNED.
interface Asking {
  asking?: boolean;
}

export interface SetRequest extends BaseRequest, WriteProtected, Asking {
  op: "SET";
  key: string;
  value: string;
  ttl_ms?: number;
}

export interface GetRequest extends BaseRequest, Asking {
  op: "GET";
  key: string;
}

export interface DelRequest extends BaseRequest, WriteProtected, Asking {
  op: "DEL";
  key: string;
}

export interface ExpireRequest extends BaseRequest, WriteProtected, Asking {
  op: "EXPIRE";
  key: string;
  ttl_ms: number;
}

export interface TtlRequest extends BaseRequest, Asking {
  op: "TTL";
  key: string;
}

export interface SubscribeRequest extends BaseRequest {
  op: "SUBSCRIBE";
  channel: string;
}

export interface UnsubscribeRequest extends BaseRequest {
  op: "UNSUBSCRIBE";
  channel: string;
}

export interface PublishRequest extends BaseRequest, WriteProtected {
  op: "PUBLISH";
  channel: string;
  message: string;
  // Default "local": this node's subscribers only (sharded pub/sub).
  // "cluster": also relay once to every other node so each delivers locally.
  scope?: "local" | "cluster";
}

export type StoreRequest = SetRequest | GetRequest | DelRequest | ExpireRequest | TtlRequest;
export type PubSubRequest = SubscribeRequest | UnsubscribeRequest | PublishRequest;
export type Request = StoreRequest | PubSubRequest;

export function isStoreRequest(request: Request): request is StoreRequest {
  return request.op === "SET" || request.op === "GET" || request.op === "DEL" || request.op === "EXPIRE" || request.op === "TTL";
}

export interface OkResponse {
  id: string;
  ok: true;
  value?: string | null;
  deleted?: boolean;
  updated?: boolean;
  subscribed?: boolean;
  unsubscribed?: boolean;
  delivered?: number;
  // Remaining TTL in ms. null = key exists with no expire. Absent on non-TTL ops.
  ttl_ms?: number | null;
}

export interface ErrResponse {
  id: string | null;
  ok: false;
  error: string;
  // Present when error === "MOVED" or "ASK": the target shard/leader.
  // - MOVED: update routing table permanently (slot now owned by this shard).
  // - ASK:   query this one request at the given leader; do NOT update the
  //          routing table — the slot is in the middle of migration and will
  //          flip to MOVED once complete.
  shard?: string;
  leader?: string;
}

export type Response = OkResponse | ErrResponse;
