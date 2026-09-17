import type { Store } from "../engine/store.js";
import type { AofEntry } from "./aof.js";

export function applyAofEntries(store: Store, entries: AofEntry[]): void {
  for (const entry of entries) {
    switch (entry.op) {
      case "SET":
        store.restoreSet(entry.key, entry.value, entry.expiresAt);
        break;
      case "DEL":
        store.del(entry.key);
        break;
      case "EXPIRE":
        store.restoreExpire(entry.key, entry.expiresAt);
        break;
    }
  }
}
