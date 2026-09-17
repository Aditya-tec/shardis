const SLOT_COUNT = 16384;

// CRC16/XMODEM, the same algorithm Redis Cluster uses for key -> slot.
function crc16(input: Buffer): number {
  let crc = 0x0000;
  for (const byte of input) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

// Redis Cluster hash tags: if the key contains "{...}", only the text
// between the first '{' and the next '}' is hashed (and only if that
// substring is non-empty), so related keys can be pinned to one shard,
// e.g. "user:{42}:profile" and "user:{42}:orders" always land together.
function hashTagPortion(key: string): string {
  const open = key.indexOf("{");
  if (open === -1) return key;
  const close = key.indexOf("}", open + 1);
  if (close === -1 || close === open + 1) return key;
  return key.slice(open + 1, close);
}

export function keySlot(key: string): number {
  const hashed = hashTagPortion(key);
  return crc16(Buffer.from(hashed, "utf8")) % SLOT_COUNT;
}

export { SLOT_COUNT };
