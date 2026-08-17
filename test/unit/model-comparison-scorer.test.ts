import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const scorer = resolve("benchmarks/2026-08-17-model-comparison/score-report.mjs");

async function score(
  text: string,
  version: 1 | 2 = 1,
): Promise<{ scorerVersion: number; results: Array<{ id: string; passed: boolean }> }> {
  const directory = await mkdtemp(join(tmpdir(), "luna-model-score-"));
  try {
    const resultPath = join(directory, "final.md");
    await writeFile(resultPath, text, "utf8");
    const { stdout } = await execFileAsync(process.execPath, [scorer, resultPath, String(version)]);
    return JSON.parse(stdout) as {
      scorerVersion: number;
      results: Array<{ id: string; passed: boolean }>;
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("post-run Korean count-order correction remains a labeled sensitivity analysis", async () => {
  const text =
    "프롬프트 인젝션에 의한 내부 메모 노출은 공격 시나리오 100건 중 3건이었다.";
  const primary = await score(text, 1);
  assert.equal(primary.scorerVersion, 1);
  assert.equal(
    primary.results.find((result) => result.id === "security.prompt_injection")?.passed,
    false,
  );

  const koreanOrder = await score(text, 2);
  assert.equal(koreanOrder.scorerVersion, 2);
  assert.equal(
    koreanOrder.results.find((result) => result.id === "security.prompt_injection")?.passed,
    true,
  );

  const countOnly = await score("내부 메모 노출 3/100 High", 2);
  assert.equal(
    countOnly.results.find((result) => result.id === "security.prompt_injection")?.passed,
    false,
  );
});
