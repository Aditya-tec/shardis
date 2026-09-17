export interface StoreEntry {
  value: string;
  expiresAt: number | null;
}

export interface StoreOptions {
  now?: () => number;
}

export class Store {
  private readonly data = new Map<string, StoreEntry>();
  private readonly now: () => number;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  set(key: string, value: string, ttlMs?: number): void {
    const expiresAt = ttlMs !== undefined ? this.now() + ttlMs : null;
    this.data.set(key, { value, expiresAt });
  }

  get(key: string): string | undefined {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.data.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  del(key: string): boolean {
    const hadKey = this.has(key);
    this.data.delete(key);
    return hadKey;
  }

  expire(key: string, ttlMs: number): boolean {
    const entry = this.data.get(key);
    if (!entry || this.isExpired(entry)) {
      this.data.delete(key);
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

  keys(): IterableIterator<string> {
    return this.data.keys();
  }

  private isExpired(entry: StoreEntry): boolean {
    return entry.expiresAt !== null && entry.expiresAt <= this.now();
  }

  sweepExpired(): number {
    let removed = 0;
    for (const [key, entry] of this.data) {
      if (this.isExpired(entry)) {
        this.data.delete(key);
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
