#!/usr/bin/env node
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { ShardisClient, type ShardisResponse } from "./client.js";
import { CommandError, parseCommand, parseCommandTokens } from "./commands.js";

export function parseArgv(argv: string[]): { url: string; writeKey: string | undefined; command: string[] } {
  let url = process.env.SHARDIS_URL ?? "ws://localhost:7000/ws";
  let writeKey = process.env.SHARDIS_WRITE_KEY;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url" || argv[i] === "-u") {
      i += 1;
      if (argv[i] === undefined) throw new CommandError("--url requires a value");
      url = argv[i];
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

  return { url, writeKey, command: rest };
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
  console.log("commands: SET GET DEL EXPIRE SUBSCRIBE PUBLISH UNSUBSCRIBE QUIT");

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

async function main(): Promise<void> {
  const { url, writeKey, command } = parseArgv(process.argv.slice(2));
  const client = new ShardisClient(url, printPush);
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
