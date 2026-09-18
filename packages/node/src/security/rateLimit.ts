// A simple per-connection token bucket: holds up to `capacity` tokens,
// refilling at `refillPerSecond`, so a connection can burst up to capacity
// then is limited to a steady-state rate of refillPerSecond.
export class TokenBucket {
  private tokens: number;
  private lastRefillAt: number;
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.tokens = capacity;
    this.now = now;
    this.lastRefillAt = now();
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now = this.now();
    const elapsedS = (now - this.lastRefillAt) / 1000;
    if (elapsedS <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedS * this.refillPerSecond);
    this.lastRefillAt = now;
  }
}
