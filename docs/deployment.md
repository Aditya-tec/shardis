# Deploying the public demo

This is the secondary, smaller-scope "clickable live demo" — not the
primary proof of the system. That's local Docker Compose (the full
3-shard/6-node cluster; see the root README). This demo is a reduced
1-shard/2-node topology (`cluster.config.render.json`), sized to fit
Render's free-tier limits (see `render.yaml` for why).

Both steps below require your own Render and Vercel accounts — no
paid tier, no credit card, but they are your accounts, not something
that can be provisioned from this repo alone.

## 1. Render: the two store nodes

1. Push this repo to GitHub (already done if you're reading this from
   the repo).
2. In the Render dashboard: **New +** → **Blueprint**, connect this
   repo. Render detects `render.yaml` at the repo root automatically
   and proposes two services: `shardis-leader` and `shardis-follower`.
3. Deploy. Render builds `packages/node/Dockerfile` for each service.
4. Once both are live, open `shardis-leader` in the Render dashboard →
   **Environment** → add `DEMO_WRITE_KEY` (any value you choose - this
   is the one variable `render.yaml` intentionally leaves unset via
   `sync: false`, so it's never committed to the repo). Redeploy that
   service for the new env var to take effect. `shardis-follower`
   doesn't need it — only the current leader enforces write-protection,
   and the demo cluster's leader identity is fixed at `node-leader` in
   `cluster.config.render.json` (no failover partner in this 2-node
   topology to fail over *to* in a meaningful demo sense, though the
   replication/heartbeat code path is identical to the local cluster's).
5. Confirm both are healthy:
   `curl https://shardis-leader.onrender.com/healthz` and the
   equivalent for `shardis-follower` — each should return
   `{"status":"ok",...}`.

**If you rename the services** in the Render dashboard away from
`shardis-leader`/`shardis-follower`, update the URLs in
`cluster.config.render.json` to match — they're hardcoded there
(Render service URLs are `https://<service-name>.onrender.com`, and
there's no dynamic service-discovery in this v1 design; see
`docs/architecture.md` on the static-topology simplification).

### What to expect

- **First request after idle is slow.** Free services spin down after
  15 minutes with no traffic and take ~1 minute to wake on the next
  request. That's Render's free tier, not a bug here.
- **Data does not survive a redeploy or a spin-down/wake cycle.** No
  persistent disk on the free plan — `DATA_DIR=/data` is real local
  storage while the container is alive, gone once it isn't. This is a
  known, deliberate limitation of the public demo, not the local
  Compose cluster (which uses real named volumes).
- **Writes need the key.** `PUBLIC_DEMO=true` is set in `render.yaml`,
  so `SET`/`DEL`/`EXPIRE`/`PUBLISH` all require `write_key` matching
  `DEMO_WRITE_KEY`. `GET`/`SUBSCRIBE` stay open. Use
  `shardis-cli --url wss://shardis-leader.onrender.com/ws --write-key <your key> SET foo bar`.

## 2. Vercel: the dashboard

1. In the Vercel dashboard: **Add New** → **Project**, import this
   repo.
2. Set **Root Directory** to `packages/dashboard`. Vercel auto-detects
   Next.js from there.
3. Add an environment variable `NEXT_PUBLIC_CLUSTER_NODES` (a JSON
   array — see `packages/dashboard/lib/clusterConfig.ts` for the exact
   shape) pointing at the two Render services, e.g.:
   ```json
   [
     { "id": "node-leader", "shard": "shard-a", "httpUrl": "https://shardis-leader.onrender.com", "wsUrl": "wss://shardis-leader.onrender.com/ws" },
     { "id": "node-follower", "shard": "shard-a", "httpUrl": "https://shardis-follower.onrender.com", "wsUrl": "wss://shardis-follower.onrender.com/ws" }
   ]
   ```
   and `NEXT_PUBLIC_CLUSTER_SHARDS`:
   ```json
   [{ "id": "shard-a", "hashRange": [0, 16383], "nodeIds": ["node-leader", "node-follower"] }]
   ```
4. Deploy. Without these two env vars, the dashboard falls back to the
   local Docker Compose topology (`localhost:7001-7006`), which won't
   resolve from a deployed Vercel app — so this step isn't optional for
   the hosted dashboard.
5. The dashboard's own console write form still needs the write key
   when `PUBLIC_DEMO=true` — there's no UI field for it yet (a known
   gap; see the "what you'd add with more time" section of the README).
   Use `shardis-cli` for authenticated writes against the demo; the
   dashboard is read/observe-focused for the public deployment.

## Status of this deployment

As of this repo's current state, `render.yaml` and
`cluster.config.render.json` are written and locally validated (the
node boots correctly under the exact env vars Render will set, and
write-protection/CORS behave as expected — see the Step 16 commit for
the validation done without a live Render account). The actual Render
and Vercel deployments require signing into those platforms
interactively, which wasn't done as part of writing this repo. Follow
the steps above to actually put it live, then update the README's
"Live demo" section with the real URL.
