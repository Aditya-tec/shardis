# Backup and Restore Runbook

Shardis snapshots contain the live key set for one node. On startup, a node loads
`snapshot.json` and then replays its AOF tail.

## Scheduled backup

The `Snapshot Backup` workflow starts the local six-node topology daily, forces
a durable snapshot on each shard leader, and uploads the three JSON files as a
30-day GitHub Actions artifact. Set `SHARDIS_BACKUP_TOKEN` as a repository
secret to exercise the same protected admin path used by deployed clusters.

## Restore

1. Stop the target node.
2. Download the leader snapshot artifact for its shard.
3. Replace `<DATA_DIR>/snapshot.json` with that file.
4. Remove or archive `<DATA_DIR>/aof.log` when restoring the snapshot as the
   desired point-in-time baseline; otherwise its later entries are replayed.
5. Start the node and verify `snapshot_loaded` appears in structured logs, then
   verify data with the CLI.

Snapshots are node-local logical backups, not a point-in-time cluster-wide
transaction. Test this procedure before treating it as a disaster-recovery plan.
