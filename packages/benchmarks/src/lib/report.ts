import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const DEFAULT_BENCHMARKS_PATH = `${REPO_ROOT}/docs/benchmarks.md`;

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

// Inserts a row into its own "## <heading>" section, wherever that section
// falls in the file - never just at EOF. A plain append would land a row
// under whichever section happens to be *last in the file*, not the one it
// actually belongs to, the moment more than one section exists.
export function appendBenchmarkRowTo(
  filePath: string,
  heading: string,
  columns: string[],
  values: (string | number)[]
): void {
  const allColumns = ["Date", "Commit", ...columns];
  const row = `| ${timestamp()} | ${gitCommitHash()} | ${values.join(" | ")} |`;

  // Normalize CRLF -> LF before splitting: this file gets checked out with
  // CRLF line endings on Windows (core.autocrlf), and without this an exact
  // "## Heading" match against a "## Heading\r" line silently fails,
  // making every section look missing and duplicating it on each run.
  const rawContent = existsSync(filePath) ? readFileSync(filePath, "utf8") : FILE_HEADER;
  const content = rawContent.replace(/\r\n/g, "\n");
  const lines = content.split("\n");

  const headingLine = `## ${heading}`;
  const sectionStart = lines.findIndex((line) => line === headingLine);

  if (sectionStart === -1) {
    // New section: header, column row, separator row, data row.
    const table = [
      "",
      headingLine,
      "",
      `| ${allColumns.join(" | ")} |`,
      `| ${allColumns.map(() => "---").join(" | ")} |`,
      row,
      ""
    ];
    writeFileSync(filePath, [...lines, ...table].join("\n"));
    return;
  }

  // Find where this section ends: the next "## " heading, or EOF.
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }

  // Insert right before the first blank line that trails the section's
  // existing content (i.e. just after its last table row).
  let insertAt = sectionEnd;
  while (insertAt > sectionStart && lines[insertAt - 1].trim() === "") insertAt -= 1;

  const next = [...lines.slice(0, insertAt), row, ...lines.slice(insertAt)];
  writeFileSync(filePath, next.join("\n"));
}

export function appendBenchmarkRow(heading: string, columns: string[], values: (string | number)[]): void {
  appendBenchmarkRowTo(DEFAULT_BENCHMARKS_PATH, heading, columns, values);
}
