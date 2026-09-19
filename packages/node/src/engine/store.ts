export interface StoreEntry {
  value: string;
  expiresAt: number | null;
}

export interface StoreOptions {
  now?: () => number;
  // Approximate byte cap on total key+value size. When set() pushes usage
  // over this, the least-recently-used entries are evicted until back
  // under cap. Undefined means no eviction.
  maxmemoryBytes?: number;
}

export class Store {
  // Iteration order of a Map is insertion order, and re-inserting a key
  // (delete then set) moves it to the end. Every read/write that "uses" a
  // key does that, so the map's own order becomes the LRU order for free:
  // the front is always the least-recently-used entry.
  private readonly data = new Map<string, StoreEntry>();
  private readonly now: () => number;
  private readonly maxmemoryBytes: number | undefined;
  private approxBytes = 0;
  private evictedCount = 0;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxmemoryBytes = options.maxmemoryBytes;
  }

  set(key: string, value: string, ttlMs?: number): void {
    const expiresAt = ttlMs !== undefined ? this.now() + ttlMs : null;
    this.write(key, value, expiresAt);
  }

  // Writes an entry with an already-resolved absolute expiry instead of a
  // ttl relative to now(). Used by AOF/snapshot replay so a key's remaining
  // lifetime survives a restart instead of restarting its ttl countdown.
  restoreSet(key: string, value: string, expiresAt: number | null): void {
    this.write(key, value, expiresAt);
  }

  restoreExpire(key: string, expiresAt: number): void {
    const entry = this.data.get(key);
    if (entry) entry.expiresAt = expiresAt;
  }

  get(key: string): string | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.removeEntry(key, entry);
      return undefined;
    }
    this.touch(key, entry);
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  del(key: string): boolean {
    const entry = this.data.get(key);
    if (!entry) return false;
    this.removeEntry(key, entry);
    return true;
  }

  expire(key: string, ttlMs: number): boolean {
    const entry = this.data.get(key);
    if (!entry || this.isExpired(entry)) {
      if (entry) this.removeEntry(key, entry);
      return false;
    }
    entry.expiresAt = this.now() + ttlMs;
    return true;
  }

  ttl(key: string): number | null | undefined {
    const entry = this.data.get(key);
    if (!entry || this.isExpired(entry)) return undefined;
    if (entry.expiresAt === null) return null;
    return entry.expiresAt - this.now();
  }

  get size(): number {
    return this.data.size;
  }

  get evictions(): number {
    return this.evictedCount;
  }

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  // Returns all live (non-expired) keys whose CRC16 hash slot equals `slot`.
  // Used during slot migration to identify which keys to transfer.
  // ponytail: O(n) scan over all keys — acceptable at this project's scale.
  keysInSlot(slot: number, slotFn: (key: string) => number): string[] {
    return this.dumpSlot(slot, slotFn).map((entry) => entry.key);
  }

  dumpSlot(
    slot: number,
    slotFn: (key: string) => number
  ): Array<{ key: string; value: string; expiresAt: number | null }> {
    const result: Array<{ key: string; value: string; expiresAt: number | null }> = [];
    for (const [key, entry] of this.data) {
      if (!this.isExpired(entry) && slotFn(key) === slot) {
        result.push({ key, value: entry.value, expiresAt: entry.expiresAt });
      }
    }
    return result;
  }

  // A point-in-time export of every live (non-expired) entry, for
  // snapshotting. Read-only: does not sweep or mutate expired entries.
  dump(): Array<{ key: string; value: string; expiresAt: number | null }> {
    const out: Array<{ key: string; value: string; expiresAt: number | null }> = [];
    for (const [key, entry] of this.data) {
      if (!this.isExpired(entry)) {
        out.push({ key, value: entry.value, expiresAt: entry.expiresAt });
      }
    }
    return out;
  }

  // Discards every entry (and resets byte accounting). Used when a follower
  // receives a full resync from its leader and must replace its state
  // wholesale, not merge with whatever it had before.
  clear(): void {
    this.data.clear();
    this.approxBytes = 0;
  }

  private isExpired(entry: StoreEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.now();
  }

  private entrySize(key: string, value: string): number {
    return Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  }

  private write(key: string, value: string, expiresAt: number | null): void {
    const existing = this.data.get(key);
    if (existing) this.approxBytes -= this.entrySize(key, existing.value);
    this.data.delete(key);
    this.data.set(key, { value, expiresAt });
    this.approxBytes += this.entrySize(key, value);
    this.evictIfOverCap();
  }

  private touch(key: string, entry: StoreEntry): void {
    this.data.delete(key);
    this.data.set(key, entry);
  }

  private removeEntry(key: string, entry: StoreEntry): void {
    this.data.delete(key);
    this.approxBytes -= this.entrySize(key, entry.value);
  }

  private evictIfOverCap(): void {
    if (this.maxmemoryBytes === undefined) return;
    while (this.approxBytes > this.maxmemoryBytes && this.data.size > 0) {
      const oldestKey = this.data.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.data.get(oldestKey);
      if (!entry) break;
      this.removeEntry(oldestKey, entry);
      this.evictedCount += 1;
    }
  }

  sweepExpired(): number {
    let removed = 0;
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry)) {
        this.removeEntry(key, entry);
        removed += 1;
      }
    }
    return removed;
  }

  startSweep(intervalMs: number): void {
    this.stopSweep();
    this.sweepTimer = setInterval(() => this.sweepExpired(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }
}
