import { keySlot, SLOT_COUNT } from "../../node/dist/hashring/hash.js";
import { appendBenchmarkRow } from "./lib/report.js";

const SAMPLE_SIZE = Number(process.env.BENCH_REBALANCE_SAMPLE ?? 10000);
const SCENARIO = (process.env.BENCH_REBALANCE_SCENARIO ?? "add") as "add" | "remove";
const OLD_SHARD_COUNT = 3;
const NEW_SHARD_COUNT = SCENARIO === "add" ? OLD_SHARD_COUNT + 1 : OLD_SHARD_COUNT - 1;

// This benchmark measures a *naive re-bootstrap*: discarding all slot
// assignments and recomputing even contiguous ranges from scratch.  This is
// NOT how a production Redis Cluster rebalances — real resharding is done
// by an explicit slot-by-slot migration (see the reshard benchmark).
// This number is kept here so the improvement from real resharding is
// visible.  It is labeled accordingly in docs/benchmarks.md.
function evenRanges(shardCount: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const base = Math.floor(SLOT_COUNT / shardCount);
  let start = 0;
  for (let i = 0; i < shardCount; i += 1) {
    const isLast = i === shardCount - 1;
    const end = isLast ? SLOT_COUNT - 1 : start + base - 1;
    ranges.push([start, end]);
    start = end + 1;
  }
  return ranges;
}

function shardIndexForSlot(ranges: Array<[number, number]>, slot: number): number {
  return ranges.findIndex(([lo, hi]) => slot >= lo && slot <= hi);
}

async function main(): Promise<void> {
  const oldRanges = evenRanges(OLD_SHARD_COUNT);
  const newRanges = evenRanges(NEW_SHARD_COUNT);

  let changed = 0;
  for (let i = 0; i < SAMPLE_SIZE; i += 1) {
    const slot = keySlot(`rebalance-sample-key-${i}`);
    const oldShard = shardIndexForSlot(oldRanges, slot);
    const newShard = shardIndexForSlot(newRanges, slot);
    if (oldShard !== newShard) changed += 1;
  }

  const pct = (changed / SAMPLE_SIZE) * 100;
  const textbookPct = (1 / NEW_SHARD_COUNT) * 100;

  console.log(
    `[naive-rebootstrap] ${SCENARIO === "add" ? "Adding" : "Removing"} a shard (${OLD_SHARD_COUNT} -> ${NEW_SHARD_COUNT}): ` +
      `${changed}/${SAMPLE_SIZE} keys moved (${pct.toFixed(2)}%). ` +
      `Virtual-node textbook: ~${textbookPct.toFixed(2)}%. ` +
      `(This is a naive re-bootstrap, NOT how real resharding works. See bench:reshard for the real mechanism.)`
  );

  appendBenchmarkRow(
    "Rebalance (naive re-bootstrap — NOT production-realistic; see Reshard benchmark below for real mechanism)",
    ["Scenario", "Shards (before -> after)", "Sample size", "Keys moved", "Moved %", "Virtual-node textbook %"],
    [
      SCENARIO,
      `${OLD_SHARD_COUNT} -> ${NEW_SHARD_COUNT}`,
      SAMPLE_SIZE,
      changed,
      `${pct.toFixed(2)}%`,
      `${textbookPct.toFixed(2)}%`
    ]
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
