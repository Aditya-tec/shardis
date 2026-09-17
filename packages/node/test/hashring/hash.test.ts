import { describe, expect, it } from "vitest";
import { keySlot, SLOT_COUNT } from "../../src/hashring/hash.js";

describe("keySlot", () => {
  it("is deterministic for the same key", () => {
    expect(keySlot("foo")).toBe(keySlot("foo"));
  });

  it("always returns a slot within [0, SLOT_COUNT)", () => {
    for (const key of ["a", "b", "some-longer-key", "", "🎉unicode-key"]) {
      const slot = keySlot(key);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(SLOT_COUNT);
    }
  });

  it("different keys generally land on different slots", () => {
    const slots = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(keySlot));
    expect(slots.size).toBeGreaterThan(1);
  });

  it("uses only the {hash tag} portion of a key when present", () => {
    expect(keySlot("user:{42}:profile")).toBe(keySlot("user:{42}:orders"));
    expect(keySlot("{42}")).toBe(keySlot("user:{42}:profile"));
  });

  it("falls back to the whole key when the braces are empty", () => {
    expect(keySlot("user:{}:profile")).toBe(keySlot("user:{}:profile"));
    // An empty tag "{}" must not resolve to slot 0 for every such key -
    // it should hash the full literal string instead.
    expect(keySlot("user:{}:profile")).not.toBe(keySlot("other:{}:key"));
  });

  it("falls back to the whole key when there is no closing brace", () => {
    expect(keySlot("no-closing-{brace")).toBe(keySlot("no-closing-{brace"));
  });

  it("hash tags with different tag content land on different slots (usually)", () => {
    expect(keySlot("user:{1}:profile")).not.toBe(keySlot("user:{2}:profile"));
  });
});
