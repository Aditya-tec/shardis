import type { AofEntry } from "../persistence/aof.js";

export interface RaftLogEntry {
  term: number;
  entry: AofEntry;
}

export class RaftLog {
  private readonly entries: RaftLogEntry[] = [];

  get length(): number { return this.entries.length; }
  get lastIndex(): number { return this.entries.length - 1; }
  get lastTerm(): number { return this.entries.length === 0 ? 0 : this.entries[this.entries.length - 1].term; }
  at(index: number): RaftLogEntry | undefined { return this.entries[index]; }
  append(entries: RaftLogEntry[]): void { this.entries.push(...entries); }
  truncateFrom(index: number): void { this.entries.splice(index); }
  slice(index: number): RaftLogEntry[] { return this.entries.slice(index); }
}