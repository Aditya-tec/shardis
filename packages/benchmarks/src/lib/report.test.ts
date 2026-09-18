import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendBenchmarkRowTo } from "./report.js";

// Uses an isolated temp file, never the real docs/benchmarks.md - this
// module previously pointed straight at the real file, and running the
// test suite silently deleted the project's actual dated benchmark
// history as a beforeEach/afterEach side effect.
let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shardis-benchmarks-report-test-"));
  filePath = join(dir, "benchmarks.md");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appendBenchmarkRowTo", () => {
  it("creates a new section with a header row and the data row", () => {
    appendBenchmarkRowTo(filePath, "Throughput", ["Ops/sec"], [1234]);

    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("## Throughput");
    expect(content).toContain("| Date | Commit | Ops/sec |");
    expect(content).toContain("1234");
  });

  it("a second row for an existing section lands inside that section, not at EOF after a different section", () => {
    appendBenchmarkRowTo(filePath, "Rebalance", ["Moved %"], ["10%"]);
    appendBenchmarkRowTo(filePath, "Throughput", ["Ops/sec"], [1000]);
    // A second Throughput row, appended after Rebalance already has its own
    // section - this is exactly the scenario that regressed before the fix.
    appendBenchmarkRowTo(filePath, "Throughput", ["Ops/sec"], [2000]);

    const lines = readFileSync(filePath, "utf8").split("\n");
    function section(heading: string): string {
      const start = lines.findIndex((l) => l === `## ${heading}`);
      let end = lines.length;
      for (let i = start + 1; i < lines.length; i += 1) {
        if (lines[i].startsWith("## ")) {
          end = i;
          break;
        }
      }
      return lines.slice(start, end).join("\n");
    }

    expect(section("Throughput")).toContain("1000");
    expect(section("Throughput")).toContain("2000");
    expect(section("Rebalance")).not.toContain("1000");
    expect(section("Rebalance")).not.toContain("2000");
  });

  it("finds an existing section even when the file has CRLF line endings (Windows checkout)", () => {
    // Git's core.autocrlf checks this file out with CRLF locally; an exact
    // "## Heading" === line match against "## Heading\r" silently fails,
    // making every section look missing and duplicating it on each run.
    const crlfContent = "# Benchmarks\r\n\r\n## Rebalance\r\n\r\n| Date | Commit | x |\r\n| --- | --- | --- |\r\n| d | c | 1 |\r\n";
    writeFileSync(filePath, crlfContent);

    appendBenchmarkRowTo(filePath, "Rebalance", ["x"], [2]);

    const content = readFileSync(filePath, "utf8");
    expect(content.match(/## Rebalance/g)).toHaveLength(1);
    expect(content).toContain("| 2 |");
  });

  it("preserves section order and row order across multiple appends", () => {
    appendBenchmarkRowTo(filePath, "A", ["x"], [1]);
    appendBenchmarkRowTo(filePath, "B", ["x"], [2]);
    appendBenchmarkRowTo(filePath, "A", ["x"], [3]);

    const content = readFileSync(filePath, "utf8");
    const aIndex = content.indexOf("## A");
    const bIndex = content.indexOf("## B");
    expect(aIndex).toBeLessThan(bIndex);

    const sectionA = content.slice(aIndex, bIndex);
    expect(sectionA.indexOf("| 1 |")).toBeLessThan(sectionA.indexOf("| 3 |"));
  });
});
