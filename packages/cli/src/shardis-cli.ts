#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ShardisClient, type ShardisResponse } from "./client.js";
import { CommandError, parseCommand, parseCommandTokens } from "./commands.js";

export function parseArgv(argv: string[]): {
  url: string;
  writeKey: string | undefined;
  binary: boolean;
  command: string[];
} {
  let url = process.env.SHARDIS_URL ?? "ws://localhost:7000/ws";
  let writeKey = process.env.SHARDIS_WRITE_KEY;
  let binary = false;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url" || argv[i] === "-u") {
      i += 1;
      if (argv[i] === undefined) throw new CommandError("--url requires a value");
      url = argv[i];
      continue;
    }
    if (argv[i] === "--binary") {
      binary = true;
      continue;
    }
    // Required only against a node running with PUBLIC_DEMO=true; ignored
    // (harmlessly) by any node that isn't gating writes.
    if (argv[i] === "--write-key" || argv[i] === "-k") {
      i += 1;
      if (argv[i] === undefined) throw new CommandError("--write-key requires a value");
      writeKey = argv[i];
      continue;
    }
    rest.push(argv[i]);
  }

  return { url, writeKey, binary, command: rest };
}

function printPush(message: ShardisResponse): void {
  console.log(`[event] ${JSON.stringify(message)}`);
}

async function runOneShot(client: ShardisClient, command: string[], writeKey: string | undefined): Promise<number> {
  try {
    const request = parseCommandTokens(command);
    if (!request) return 0;
    if (writeKey) request.write_key = writeKey;
    const response = await client.send(request);
    console.log(JSON.stringify(response));
    return response.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof CommandError ? error.message : String(error));
    return 1;
  }
}

async function runRepl(client: ShardisClient, writeKey: string | undefined): Promise<void> {
  console.log(`shardis-cli connected to ${client.currentUrl}`);
  console.log("commands: SET GET DEL EXPIRE TTL SUBSCRIBE PUBLISH UNSUBSCRIBE QUIT");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "shardis> " });
  rl.prompt();

  rl.on("line", (line) => {
    void (async () => {
      const trimmed = line.trim();
      if (trimmed === "" ) {
        rl.prompt();
        return;
      }
      if (trimmed.toUpperCase() === "QUIT" || trimmed.toUpperCase() === "EXIT") {
        rl.close();
        return;
      }

      try {
        const request = parseCommand(trimmed);
        if (request) {
          if (writeKey) request.write_key = writeKey;
          const response = await client.send(request);
          console.log(JSON.stringify(response));
        }
      } catch (error) {
        console.error(error instanceof CommandError ? error.message : String(error));
      }
      rl.prompt();
    })();
  });

  await new Promise<void>((resolve) => rl.once("close", resolve));
}

// ---------------------------------------------------------------------------
// shardis-cli reshard --to <shard-id> --slots <n> [--from <s1,s2,...>]
//
// Fetches the cluster topology from the connected node, selects `n` slots
// proportionally from the existing shards (or from the specified ones), and
// migrates them one by one via POST /admin/migrate-slot on each source shard's
// leader.  Reports progress and counts transferred keys.
// ---------------------------------------------------------------------------
async function runReshard(
  nodeUrl: string,
  toShard: string,
  slotCount: number,
  fromShards?: string[],
  resume = false
): Promise<number> {
  const httpBase = nodeUrl.replace(/^ws(s?):\/\//, (_, s: string) => `http${s}://`).replace(/\/ws$/, "");

  const topoResp = await fetch(`${httpBase}/topology`);
  if (!topoResp.ok) throw new CommandError(`failed to fetch topology from ${httpBase}/topology`);
  const topo = await topoResp.json() as {
    shards: Array<{
      id: string;
      hash_range: [number, number];
      leader: { id: string; url: string };
      followers: Array<{ id: string; url: string }>;
    }>;
  };

  const shards = topo.shards.filter((s) => s.id !== toShard);
  if (shards.length === 0) throw new CommandError("no source shards found");

  const sources = fromShards && fromShards.length > 0
    ? shards.filter((s) => fromShards.includes(s.id))
    : shards;

  if (sources.length === 0) throw new CommandError(`no matching source shards among: ${fromShards?.join(", ")}`);

  interface SlotTask { slot: number; sourceHttpBase: string; sourceShardId: string; }
  const tasks: SlotTask[] = [];

  const stuck: SlotTask[] = [];
  for (const source of sources) {
    const sourceHttpBase = source.leader.url.replace(/^ws(s?):\/\//, (_, s: string) => `http${s}://`).replace(/\/ws$/, "");
    const stateResp = await fetch(`${sourceHttpBase}/admin/slot-state`);
    if (!stateResp.ok) continue;
    const state = await stateResp.json() as { migrating: Array<{ slot: number; fromShard: string; toShard: string }> };
    for (const entry of state.migrating ?? []) {
      if (entry.toShard === toShard && entry.fromShard === source.id) {
        stuck.push({ slot: entry.slot, sourceHttpBase, sourceShardId: source.id });
      }
    }
  }

  if (stuck.length > 0 && !resume) {
    const slots = stuck.map((t) => `${t.sourceShardId}:${t.slot}`).join(", ");
    throw new CommandError(
      `slots stuck in MIGRATING (${slots}). Re-run with --resume to continue; refusing to start a new reshard.`
    );
  }

  if (resume) {
    if (stuck.length === 0) throw new CommandError("nothing to resume: no slots are stuck in MIGRATING");
    tasks.push(...stuck);
  } else {
    const perShard = Math.floor(slotCount / sources.length);
    const remainder = slotCount % sources.length;

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const count = perShard + (i < remainder ? 1 : 0);
      const sourceHttpBase = source.leader.url.replace(/^ws(s?):\/\//, (_, s: string) => `http${s}://`).replace(/\/ws$/, "");
      const [lo, hi] = source.hash_range;
      for (let slot = lo; slot <= hi && tasks.filter((t) => t.sourceShardId === source.id).length < count; slot++) {
        tasks.push({ slot, sourceHttpBase, sourceShardId: source.id });
      }
    }
  }

  console.log(`resharding: moving ${tasks.length} slots to ${toShard}`);
  let totalTransferred = 0;

  for (const task of tasks) {
    process.stdout.write(`  slot ${task.slot} (${task.sourceShardId} → ${toShard}) ... `);
    const resp = await fetch(`${task.sourceHttpBase}/admin/migrate-slot`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot: task.slot, toShard })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`FAILED: ${errText}`);
      return 1;
    }
    const result = await resp.json() as { transferred: number };
    totalTransferred += result.transferred;
    console.log(`done (${result.transferred} keys)`);
  }

  console.log(`reshard complete: ${tasks.length} slots migrated, ${totalTransferred} keys transferred`);
  return 0;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle `reshard` subcommand before the normal flow.
  if (args[0] === "reshard") {
    let toShard = "";
    let slotCount = 0;
    let fromShards: string[] | undefined;
    let url = process.env.SHARDIS_URL ?? "ws://localhost:7000/ws";
    let resume = false;

    for (let i = 1; i < args.length; i++) {
      if ((args[i] === "--url" || args[i] === "-u") && args[i + 1]) { url = args[++i]; continue; }
      if (args[i] === "--to" && args[i + 1]) { toShard = args[++i]; continue; }
      if (args[i] === "--slots" && args[i + 1]) { slotCount = Number(args[++i]); continue; }
      if (args[i] === "--from" && args[i + 1]) { fromShards = args[++i].split(","); continue; }
      if (args[i] === "--resume") { resume = true; continue; }
    }

    if (!toShard) throw new CommandError("reshard requires --to <shard-id>");
    if (!resume && (!slotCount || slotCount < 1)) throw new CommandError("reshard requires --slots <n> where n >= 1");

    process.exitCode = await runReshard(url, toShard, slotCount, fromShards, resume);
    return;
  }

  const { url, writeKey, binary, command } = parseArgv(args);
  const client = new ShardisClient(url, printPush, binary);
  await client.connect();

  try {
    if (command.length > 0) {
      const code = await runOneShot(client, command, writeKey);
      process.exitCode = code;
    } else {
      await runRepl(client, writeKey);
    }
  } finally {
    client.close();
  }
}

// Only auto-run when this file is the actual entrypoint (`node
// shardis-cli.js ...`), not when a test imports it for parseArgv - without
// this guard, importing the module would immediately try to open a real
// WebSocket connection as a side effect of import alone.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
