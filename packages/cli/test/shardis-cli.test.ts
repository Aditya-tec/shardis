import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgv } from "../src/shardis-cli.js";

const ENV_KEYS = ["SHARDIS_URL", "SHARDIS_WRITE_KEY"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("parseArgv", () => {
  it("defaults to ws://localhost:7000/ws with no write key and no command", () => {
    expect(parseArgv([])).toEqual({ url: "ws://localhost:7000/ws", writeKey: undefined, binary: false, command: [] });
  });

  it("parses --url / -u", () => {
    expect(parseArgv(["--url", "ws://example.com/ws"]).url).toBe("ws://example.com/ws");
    expect(parseArgv(["-u", "ws://example.com/ws"]).url).toBe("ws://example.com/ws");
  });

  it("parses --write-key / -k", () => {
    expect(parseArgv(["--write-key", "secret"]).writeKey).toBe("secret");
    expect(parseArgv(["-k", "secret"]).writeKey).toBe("secret");
  });

  it("parses --binary", () => {
    expect(parseArgv(["--binary"]).binary).toBe(true);
    expect(parseArgv(["--binary", "GET", "foo"]).command).toEqual(["GET", "foo"]);
  });

  it("reads SHARDIS_URL and SHARDIS_WRITE_KEY from the environment", () => {
    process.env.SHARDIS_URL = "ws://from-env/ws";
    process.env.SHARDIS_WRITE_KEY = "env-secret";
    const result = parseArgv([]);
    expect(result.url).toBe("ws://from-env/ws");
    expect(result.writeKey).toBe("env-secret");
  });

  it("an explicit flag overrides the environment variable", () => {
    process.env.SHARDIS_URL = "ws://from-env/ws";
    process.env.SHARDIS_WRITE_KEY = "env-secret";
    const result = parseArgv(["--url", "ws://from-flag/ws", "--write-key", "flag-secret"]);
    expect(result.url).toBe("ws://from-flag/ws");
    expect(result.writeKey).toBe("flag-secret");
  });

  it("everything else is passed through as the command", () => {
    expect(parseArgv(["SET", "foo", "bar"]).command).toEqual(["SET", "foo", "bar"]);
  });

  it("mixes flags and a command in either order", () => {
    const result = parseArgv(["--url", "ws://example.com/ws", "SET", "foo", "bar", "--write-key", "k"]);
    expect(result.url).toBe("ws://example.com/ws");
    expect(result.writeKey).toBe("k");
    expect(result.command).toEqual(["SET", "foo", "bar"]);
  });

  it("throws CommandError if --url is given with no value", () => {
    expect(() => parseArgv(["--url"])).toThrow(/--url requires a value/);
  });

  it("throws CommandError if --write-key is given with no value", () => {
    expect(() => parseArgv(["--write-key"])).toThrow(/--write-key requires a value/);
  });
});
