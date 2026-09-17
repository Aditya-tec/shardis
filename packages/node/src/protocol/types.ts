export type RequestOp = "SET" | "GET" | "DEL" | "EXPIRE";

interface BaseRequest {
  id: string;
  op: RequestOp;
}

export interface SetRequest extends BaseRequest {
  op: "SET";
  key: string;
  value: string;
  ttl_ms?: number;
}

export interface GetRequest extends BaseRequest {
  op: "GET";
  key: string;
}

export interface DelRequest extends BaseRequest {
  op: "DEL";
  key: string;
}

export interface ExpireRequest extends BaseRequest {
  op: "EXPIRE";
  key: string;
  ttl_ms: number;
}

export type Request = SetRequest | GetRequest | DelRequest | ExpireRequest;

export interface OkResponse {
  id: string;
  ok: true;
  value?: string | null;
  deleted?: boolean;
  updated?: boolean;
}

export interface ErrResponse {
  id: string | null;
  ok: false;
  error: string;
}

export type Response = OkResponse | ErrResponse;
