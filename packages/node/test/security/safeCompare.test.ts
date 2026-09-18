import { describe, expect, it } from "vitest";
import { safeCompare, writeKeyValid } from "../../src/security/safeCompare.js";

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("secret123", "secret123")).toBe(true);
  });

  it("returns false for different strings", () => {
    expect(safeCompare("secret123", "wrongkey")).toBe(false);
  });

  it("returns false when only one side is undefined", () => {
    expect(safeCompare(undefined, "secret123")).toBe(false);
    expect(safeCompare("secret123", undefined)).toBe(false);
  });

  it("returns true when both sides are undefined", () => {
    expect(safeCompare(undefined, undefined)).toBe(true);
  });

  it("compares strings of different lengths correctly (not just a length check)", () => {
    expect(safeCompare("a", "aaaaaaaaaaaaaaaaaaaa")).toBe(false);
  });
});

describe("writeKeyValid", () => {
  it("matches when the provided key equals the expected key", () => {
    expect(writeKeyValid("secret123", "secret123")).toBe(true);
  });

  it("rejects a wrong or missing key", () => {
    expect(writeKeyValid("wrong", "secret123")).toBe(false);
    expect(writeKeyValid(undefined, "secret123")).toBe(false);
  });

  it("fails closed when no expected key is configured, even if the client also sends nothing", () => {
    // A misconfigured PUBLIC_DEMO=true node (DEMO_WRITE_KEY left unset)
    // must never fall back to "no key needed" - that would silently
    // disable write-protection instead of enforcing it.
    expect(writeKeyValid(undefined, undefined)).toBe(false);
    expect(writeKeyValid("", undefined)).toBe(false);
    expect(writeKeyValid("anything", undefined)).toBe(false);
  });

  it("fails closed when the expected key is an empty string", () => {
    expect(writeKeyValid(undefined, "")).toBe(false);
    expect(writeKeyValid("", "")).toBe(false);
  });
});
