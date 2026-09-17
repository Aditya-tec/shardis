import type { StoreRequest } from "../protocol/types.js";
import type { AofEntry } from "./aof.js";

// Returns the durable entry a write request must produce, or null for a
// read (GET) that has nothing to persist. Existence checks (does the key
// exist? was DEL a no-op?) are deliberately not made here - both the live
// dispatch and AOF replay independently no-op on a missing key, so the
// two stay consistent without this needing to know the store's state.
export function entryForRequest(request: StoreRequest, now: () => number): AofEntry | null {
  switch (request.op) {
    case "SET":
      return {
        op: "SET",
        key: request.key,
        value: request.value,
        expiresAt: request.ttl_ms !== undefined ? now() + request.ttl_ms : null
      };
    case "DEL":
      return { op: "DEL", key: request.key };
    case "EXPIRE":
      return { op: "EXPIRE", key: request.key, expiresAt: now() + request.ttl_ms };
    case "GET":
      return null;
  }
}
