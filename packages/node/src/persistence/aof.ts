import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export type AofEntry =
  | { op: "SET"; key: string; value: string; expiresAt: number | null }
  | { op: "DEL"; key: string }
  | { op: "EXPIRE"; key: string; expiresAt: number };

export class AofLog {
  private fd: number | null = null;

  constructor(private readonly filePath: string) {}

  open(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    this.fd = openSync(this.filePath, "a+");
  }

  // Appends and fsyncs before returning, so a caller that acks a write only
  // after this resolves has a durability guarantee that survives a hard kill.
  append(entry: AofEntry): void {
    if (this.fd === null) throw new Error("AOF is not open");
    writeSync(this.fd, `${JSON.stringify(entry)}\n`);
    fsyncSync(this.fd);
  }

  replay(): AofEntry[] {
    if (!existsSync(this.filePath)) return [];
    const content = readFileSync(this.filePath, "utf8");
    const lines = content.split("\n").filter((line) => line.length > 0);

    const entries: AofEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AofEntry);
      } catch {
        // A partial/corrupt final line (e.g. a crash mid-write) stops
        // replay there instead of discarding everything read so far.
        break;
      }
    }
    return entries;
  }

  // Resets the log to empty - called right after a snapshot captures full
  // state, so the log going forward holds only the tail written since.
  // A fd opened for append ("a+") can't be ftruncateSync'd on Windows
  // (EPERM), so this closes it, truncates via a fresh "w" open, and
  // reopens for append rather than truncating the existing fd in place.
  truncate(): void {
    if (this.fd === null) throw new Error("AOF is not open");
    closeSync(this.fd);
    closeSync(openSync(this.filePath, "w"));
    this.fd = openSync(this.filePath, "a+");
  }

  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }
}
