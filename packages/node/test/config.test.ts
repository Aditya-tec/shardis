import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const ENV_KEYS = [
  "NODE_ID",
  "ROLE",
  "SHARD_ID",
  "CLUSTER_CONFIG_PATH",
  "PORT",
  "MAXMEMORY_MB",
  "PUBLIC_DEMO",
  "DEMO_WRITE_KEY"
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("loadConfig", () => {
  it("applies documented defaults when env vars are absent", () => {
    const config = loadConfig();
    expect(config.nodeId).toBe("node-a1");
    expect(config.role).toBe("leader");
    expect(config.shardId).toBe("shard-a");
    expect(config.port).toBe(7000);
    expect(config.publicDemo).toBe(false);
  });

  it("reads values from environment variables", () => {
    process.env.NODE_ID = "node-b2";
    process.env.ROLE = "follower";
    process.env.PORT = "8123";
    process.env.PUBLIC_DEMO = "true";

    const config = loadConfig();
    expect(config.nodeId).toBe("node-b2");
    expect(config.role).toBe("follower");
    expect(config.port).toBe(8123);
    expect(config.publicDemo).toBe(true);
  });

  it("rejects an invalid ROLE", () => {
    process.env.ROLE = "primary";
    expect(() => loadConfig()).toThrow(/ROLE must be/);
  });

  it("rejects a non-integer numeric env var", () => {
    process.env.PORT = "not-a-number";
    expect(() => loadConfig()).toThrow(/must be an integer/);
  });
});
