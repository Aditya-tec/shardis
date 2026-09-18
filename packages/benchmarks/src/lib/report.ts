import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const BENCHMARKS_PATH = `${REPO_ROOT}/docs/benchmarks.md`;

function gitCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "unknown";
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

const FILE_HEADER = `# Benchmarks

Every row here comes from an actual run of \`packages/benchmarks\`, dated
and tied to a git commit - not a one-off claim. Re-run any of these
yourself with \`pnpm --filter @shardis/benchmarks bench:<name>\` (build
\`@shardis/node\` first). See \`docs/architecture.md\` for what each
benchmark measures and why.
`;

function ensureFileExists(): void {
  if (!existsSync(BENCHMARKS_PATH)) {
    writeFileSync(BENCHMARKS_PATH, FILE_HEADER);
  }
}

function ensureSection(heading: string, columns: string[]): void {
  const content = readFileSync(BENCHMARKS_PATH, "utf8");
  if (content.includes(`## ${heading}`)) return;

  const table = `\n## ${heading}\n\n| ${columns.join(" | ")} |\n| ${columns.map(() => "---").join(" | ")} |\n`;
  appendFileSync(BENCHMARKS_PATH, table);
}

export function appendBenchmarkRow(heading: string, columns: string[], values: (string | number)[]): void {
  ensureFileExists();
  ensureSection(heading, ["Date", "Commit", ...columns]);
  const row = `| ${timestamp()} | ${gitCommitHash()} | ${values.join(" | ")} |\n`;
  appendFileSync(BENCHMARKS_PATH, row);
}
