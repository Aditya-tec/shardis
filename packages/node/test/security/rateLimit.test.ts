import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/security/rateLimit.js";

describe("TokenBucket", () => {
  it("allows bursts up to capacity", () => {
    let now = 0;
    const bucket = new TokenBucket(5, 5, () => now);
    for (let i = 0; i < 5; i += 1) expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("refills over time at refillPerSecond", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 10, () => now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);

    now += 100; // 100ms at 10/s refills 1 token
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("never refills past capacity", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 100, () => now);
    now += 10_000; // huge gap, would refill far past capacity if unclamped
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
  });

  it("a zero-cost elapsed time does not grant free tokens", () => {
    let now = 0;
    const bucket = new TokenBucket(1, 10, () => now);
    expect(bucket.tryConsume()).toBe(true);
    expect(bucket.tryConsume()).toBe(false);
    expect(bucket.tryConsume()).toBe(false);
  });
});
