import { createHash, timingSafeEqual } from "node:crypto";

// A plain `===` on secrets leaks their length and, byte-by-byte, their
// content through response-timing differences. Hashing both sides to a
// fixed-length digest first sidesteps the "equal-length buffers required"
// constraint of timingSafeEqual too, so this works regardless of how long
// the client-supplied value is.
export function safeCompare(a: string | undefined, b: string | undefined): boolean {
  const digestA = createHash("sha256").update(a ?? "").digest();
  const digestB = createHash("sha256").update(b ?? "").digest();
  return timingSafeEqual(digestA, digestB);
}

// Fails closed: if no expected key is configured (PUBLIC_DEMO=true but
// DEMO_WRITE_KEY was left unset - a real misconfiguration, not a
// hypothetical), no client-supplied value can ever satisfy it, including
// an empty/undefined one. Without this, `undefined !== undefined` reads
// as "matches", silently disabling write-protection instead of enforcing
// it strictly.
export function writeKeyValid(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  return safeCompare(provided, expected);
}
