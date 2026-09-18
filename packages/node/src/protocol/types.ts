export type StoreOp = "SET" | "GET" | "DEL" | "EXPIRE";
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

export interface SetRequest extends BaseRequest, WriteProtected {
  op: "SET";
  key: string;
  value: string;
  ttl_ms?: number;
}

export interface GetRequest extends BaseRequest {
  op: "GET";
  key: string;
}

export interface DelRequest extends BaseRequest, WriteProtected {
  op: "DEL";
  key: string;
}

export interface ExpireRequest extends BaseRequest, WriteProtected {
  op: "EXPIRE";
  key: string;
  ttl_ms: number;
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
}

export type StoreRequest = SetRequest | GetRequest | DelRequest | ExpireRequest;
export type PubSubRequest = SubscribeRequest | UnsubscribeRequest | PublishRequest;
export type Request = StoreRequest | PubSubRequest;

export function isStoreRequest(request: Request): request is StoreRequest {
  return request.op === "SET" || request.op === "GET" || request.op === "DEL" || request.op === "EXPIRE";
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
}

export interface ErrResponse {
  id: string | null;
  ok: false;
  error: string;
}

export type Response = OkResponse | ErrResponse;
