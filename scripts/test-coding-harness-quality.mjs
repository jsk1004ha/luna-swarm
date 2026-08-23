import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dirname, "..");
const typescript = resolve(ROOT, "node_modules", "typescript", "bin", "tsc");
const eslint = resolve(ROOT, "node_modules", "eslint", "bin", "eslint.js");

run(process.execPath, [
  "--import",
  "tsx",
  "--test",
  "--test-concurrency=1",
  "test/unit/orchestrator-coding.test.ts",
  "test/unit/swarm-coding-runtime.test.ts",
  "test/unit/coding-single-committer.test.ts",
], "protected Luna coding E2E");
run(process.execPath, [typescript, "-p", "tsconfig.json", "--noEmit"], "root typecheck");
run(process.execPath, [typescript, "-p", "ui/tsconfig.json", "--noEmit"], "UI typecheck");
run(process.execPath, [
  eslint,
  "src/**/*.ts",
  "test/**/*.ts",
  "ui/src/**/*.{ts,tsx}",
], "lint");
run(process.execPath, ["scripts/check-import-cycles.mjs"], "import-cycle gate");

function run(command, args, label) {
  process.stdout.write(`[coding-harness-quality] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
