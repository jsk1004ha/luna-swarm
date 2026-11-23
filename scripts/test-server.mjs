import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const TEST_ROOT = join(ROOT, "test");

const FAST_FILES = [
  "test/unit/context-v2.test.ts",
  "test/unit/council-v2.test.ts",
  "test/unit/dag.test.ts",
  "test/unit/experiment-fabric-v2.test.ts",
  "test/unit/gates-v2.test.ts",
  "test/unit/harness-topology.test.ts",
  "test/unit/harness-v3-contracts.test.ts",
  "test/unit/messages-v2.test.ts",
  "test/unit/oracle-forge-v2.test.ts",
  "test/unit/oracle-runner-v2.test.ts",
  "test/unit/organization-v2.test.ts",
  "test/unit/organization.test.ts",
  "test/unit/pool.test.ts",
  "test/unit/preflight-v2.test.ts",
  "test/unit/prompts.test.ts",
  "test/unit/schemas.test.ts",
  "test/unit/staffing-plan-v2.test.ts",
  "test/unit/tool-policy-v2.test.ts",
  "test/unit/util.test.ts",
  "test/unit/work-orders-v2.test.ts",
];

function discoverTests(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discoverTests(absolute));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(relative(ROOT, absolute).split(sep).join("/"));
    }
  }
  return files.sort();
}

function boundedConcurrency() {
  const value = Number.parseInt(process.env.LUNA_TEST_CONCURRENCY ?? "4", 10);
  if (!Number.isInteger(value) || value < 1 || value > 8) {
    throw new Error("LUNA_TEST_CONCURRENCY must be an integer from 1 through 8");
  }
  return value;
}

function classify() {
  const all = discoverTests(TEST_ROOT);
  const allSet = new Set(all);
  const fastSet = new Set(FAST_FILES);
  if (fastSet.size !== FAST_FILES.length) throw new Error("Fast test manifest contains duplicates");
  const missing = FAST_FILES.filter((file) => !allSet.has(file));
  if (missing.length > 0) throw new Error(`Fast test manifest references missing files: ${missing.join(", ")}`);
  const serial = all.filter((file) => !fastSet.has(file));
  if (all.length === 0 || FAST_FILES.length === 0 || serial.length === 0) {
    throw new Error("Test lane classification must produce non-empty all, fast, and serial sets");
  }
  if (FAST_FILES.length + serial.length !== all.length) throw new Error("Test lane classification is incomplete");
  return { all, fast: [...FAST_FILES].sort(), serial };
}

function run(files, concurrency, label) {
  process.stdout.write(`[test-server] ${label}: ${files.length} files, concurrency=${concurrency}\n`);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...files],
    { cwd: ROOT, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const mode = process.argv[2] ?? "all";
const lanes = classify();
let status;
if (mode === "fast") status = run(lanes.fast, boundedConcurrency(), "fast");
else if (mode === "serial") status = run(lanes.serial, 1, "serial");
else if (mode === "all") {
  status = run(lanes.fast, boundedConcurrency(), "fast");
  if (status === 0) status = run(lanes.serial, 1, "serial");
} else {
  throw new Error(`Unknown test-server mode: ${mode}`);
}
process.exitCode = status;
