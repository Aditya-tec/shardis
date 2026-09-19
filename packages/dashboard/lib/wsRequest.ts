"use client";

export interface ConsoleRequest {
  op: string;
  key?: string;
  value?: string;
  ttl_ms?: number;
  channel?: string;
  message?: string;
  write_key?: string;
  asking?: boolean;
}

export interface ConsoleResult {
  request: ConsoleRequest;
  response: Record<string, unknown>;
  respondedByUrl: string;
  followedMoved: boolean;
  followedAsk: boolean;
}

function randomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function sendOnce(wsUrl: string, request: ConsoleRequest, timeoutMs: number): Promise<Record<string, unknown>> {
  const socket = new WebSocket(wsUrl);
  const id = randomId();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out waiting for a response from ${wsUrl}`));
    }, timeoutMs);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, ...request }));
    });

    socket.addEventListener("message", (evt) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(evt.data as string);
      } catch {
        return;
      }
      if (parsed.id !== id) return;
      clearTimeout(timer);
      socket.close();
      resolve(parsed);
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`could not connect to ${wsUrl}`));
    });
  });
}

// Sends one request and, if redirected with MOVED, follows it exactly once
// more (the in-browser console is for poking at the cluster interactively,
// not a production client - one hop is enough to demonstrate the redirect
// and land the request; shardis-cli has the full bounded-retry version).
export async function sendConsoleRequest(
  startUrl: string,
  request: ConsoleRequest,
  timeoutMs = 4000
): Promise<ConsoleResult> {
  const first = await sendOnce(startUrl, request, timeoutMs);
  if (first.ok === false && first.error === "MOVED" && typeof first.leader === "string") {
    const second = await sendOnce(first.leader, request, timeoutMs);
    return { request, response: second, respondedByUrl: first.leader, followedMoved: true, followedAsk: false };
  }
  if (first.ok === false && first.error === "ASK" && typeof first.leader === "string") {
    const second = await sendOnce(first.leader, { ...request, asking: true }, timeoutMs);
    return { request, response: second, respondedByUrl: first.leader, followedMoved: false, followedAsk: true };
  }
  return { request, response: first, respondedByUrl: startUrl, followedMoved: false, followedAsk: false };
}
