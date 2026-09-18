import { describe, expect, it } from "vitest";
import { keySlot } from "./keySlot";

describe("keySlot", () => {
  it("matches the shard-a slot used by the dashboard smoke flow", () => {
    expect(keySlot("ci-smoke-2")).toBe(3405);
  });

  it("uses Redis-style hash tags to keep related keys together", () => {
    expect(keySlot("user:{42}:profile")).toBe(keySlot("user:{42}:orders"));
  });
});
