#!/usr/bin/env node
import { createInterface } from "node:readline";
import { ShardisClient, type ShardisResponse } from "./client.js";
import { CommandError, parseCommand, parseCommandTokens } from "./commands.js";

function parseArgv(argv: string[]): { url: string; command: string[] } {
  let url = process.env.SHARDIS_URL ?? "ws://localhost:7000/ws";
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--url" || argv[i] === "-u") {
      i += 1;
      if (argv[i] === undefined) throw new CommandError("--url requires a value");
      url = argv[i];
      continue;
    }
    rest.push(argv[i]);
  }

  return { url, command: rest };
}

function printPush(message: ShardisResponse): void {
  console.log(`[event] ${JSON.stringify(message)}`);
}

async function runOneShot(client: ShardisClient, command: string[]): Promise<number> {
  try {
    const request = parseCommandTokens(command);
    if (!request) return 0;
    const response = await client.send(request);
    console.log(JSON.stringify(response));
    return response.ok ? 0 : 1;
  } catch (error) {
    console.error(error instanceof CommandError ? error.message : String(error));
    return 1;
  }
}

async function runRepl(client: ShardisClient): Promise<void> {
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
  const { url, command } = parseArgv(process.argv.slice(2));
  const client = new ShardisClient(url, printPush);
  await client.connect();

  try {
    if (command.length > 0) {
      const code = await runOneShot(client, command);
      process.exitCode = code;
    } else {
      await runRepl(client);
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
