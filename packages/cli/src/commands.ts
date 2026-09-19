import type { ShardisRequest } from "./client.js";

export class CommandError extends Error {}

// Tokenize a line, honoring "double quoted" and 'single quoted' segments so
// values can contain spaces (e.g. SET greeting "hello world").
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let inToken = false;

  for (const char of line) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) {
        tokens.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }
    current += char;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

function parseTtl(raw: string): number {
  const ttl = Number(raw);
  if (!Number.isFinite(ttl)) throw new CommandError(`invalid ttl_ms: ${raw}`);
  return ttl;
}

export function parseCommand(line: string): ShardisRequest | null {
  return parseCommandTokens(tokenize(line.trim()));
}

// Takes already-split tokens directly (e.g. argv, where the shell has
// already resolved quoting) so callers never re-tokenize a joined string
// and silently lose word boundaries inside a quoted argument.
export function parseCommandTokens(tokens: string[]): ShardisRequest | null {
  if (tokens.length === 0) return null;

  const [rawOp, ...args] = tokens;
  const op = rawOp.toUpperCase();

  switch (op) {
    case "SET": {
      if (args.length < 2) throw new CommandError("usage: SET <key> <value> [ttl_ms]");
      const [key, value, ttl] = args;
      return { op, key, value, ttl_ms: ttl !== undefined ? parseTtl(ttl) : undefined };
    }
    case "GET":
    case "DEL": {
      if (args.length < 1) throw new CommandError(`usage: ${op} <key>`);
      return { op, key: args[0] };
    }
    case "EXPIRE": {
      if (args.length < 2) throw new CommandError("usage: EXPIRE <key> <ttl_ms>");
      return { op, key: args[0], ttl_ms: parseTtl(args[1]) };
    }
    case "TTL": {
      if (args.length < 1) throw new CommandError("usage: TTL <key>");
      return { op, key: args[0] };
    }
    case "SUBSCRIBE":
    case "UNSUBSCRIBE": {
      if (args.length < 1) throw new CommandError(`usage: ${op} <channel>`);
      return { op, channel: args[0] };
    }
    case "PUBLISH": {
      if (args.length < 2) throw new CommandError("usage: PUBLISH <channel> <message> [--cluster]");
      const cluster = args.includes("--cluster");
      const messageArgs = args.filter((a) => a !== "--cluster");
      return { op, channel: messageArgs[0], message: messageArgs.slice(1).join(" "), scope: cluster ? "cluster" : undefined };
    }
    default:
      throw new CommandError(`unknown command: ${rawOp}`);
  }
}