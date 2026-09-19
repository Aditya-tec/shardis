import type { Store } from "../engine/store.js";
import type { OkResponse, Response, StoreRequest } from "./types.js";

export function dispatch(request: StoreRequest, store: Store): Response {
  switch (request.op) {
    case "SET":
      store.set(request.key, request.value, request.ttl_ms);
      return { id: request.id, ok: true };
    case "GET": {
      const value = store.get(request.key);
      return { id: request.id, ok: true, value: value ?? null };
    }
    case "DEL":
      return { id: request.id, ok: true, deleted: store.del(request.key) };
    case "EXPIRE":
      return { id: request.id, ok: true, updated: store.expire(request.key, request.ttl_ms) };
    case "TTL": {
      const remaining = store.ttl(request.key);
      if (remaining === undefined) return { id: request.id, ok: false, error: "not_found" };
      return { id: request.id, ok: true, ttl_ms: remaining };
    }
  }
}
