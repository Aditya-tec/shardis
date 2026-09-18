const SLOT_COUNT = 16384;

function crc16(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function hashTagPortion(key: string): string {
  const open = key.indexOf("{");
  if (open === -1) return key;
  const close = key.indexOf("}", open + 1);
  return close > open + 1 ? key.slice(open + 1, close) : key;
}

export function keySlot(key: string): number {
  return crc16(hashTagPortion(key)) % SLOT_COUNT;
}