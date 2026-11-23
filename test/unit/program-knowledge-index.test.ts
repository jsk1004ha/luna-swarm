import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  PersistentProgramKnowledgeIndex,
  ProgramKnowledgeIndexIntegrityError,
} from "../../src/harness-v2/program-knowledge-index.js";

const run = promisify(execFile);

test("persistent program knowledge index reuses clean Git blobs and reads only a changed source", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-pkg-index-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", main: "./dist/index.js" }), "utf8");
  await writeFile(join(root, "src", "index.ts"), "export const answer = 41;\n", "utf8");
  await writeFile(join(root, "src", "other.ts"), "export const stable = true;\n", "utf8");
  await git(root, "init");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "user.name", "Luna Test");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");

  const index = new PersistentProgramKnowledgeIndex({
    rootDir: root,
    cacheDirectory: join(root, ".pkg-cache"),
    ignoreDirectories: [".pkg-cache"],
  });
  const first = await index.build();
  assert.equal(first.stats.gitAware, true);
  assert.equal(first.stats.sourceFilesRead, 3);
  assert.equal(first.stats.fileRecordsReused, 0);
  assert.equal(first.stats.graphCacheHit, false);

  const exact = await index.build();
  assert.equal(exact.cacheKey, first.cacheKey);
  assert.equal(exact.stats.graphCacheHit, true);
  assert.equal(exact.stats.sourceFilesRead, 0);
  assert.equal(exact.graph.hash, first.graph.hash);

  await writeFile(join(root, "src", "index.ts"), "export const answer = 42;\n", "utf8");
  const changed = await index.build();
  assert.notEqual(changed.sourceIdentity, first.sourceIdentity);
  assert.equal(changed.stats.graphCacheHit, false);
  assert.equal(changed.stats.sourceFilesRead, 1);
  assert.equal(changed.stats.fileRecordsReused, 2);
  assert.notEqual(changed.graph.hash, first.graph.hash);
});

test("persistent program knowledge index fails closed on canonical graph cache corruption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "luna-pkg-corrupt-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await writeFile(join(root, "index.ts"), "export const value = 1;\n", "utf8");
  const cacheDirectory = join(root, ".pkg-cache");
  const index = new PersistentProgramKnowledgeIndex({
    rootDir: root,
    cacheDirectory,
    ignoreDirectories: [".pkg-cache"],
  });
  const built = await index.build();
  const path = join(cacheDirectory, "graphs", `${built.cacheKey}.json`);
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace('"schemaVersion":1', '"schemaVersion":2'), "utf8");
  await assert.rejects(() => index.build(), ProgramKnowledgeIndexIntegrityError);
});

async function git(root: string, ...args: string[]): Promise<void> {
  await run("git", ["-C", root, ...args], { maxBuffer: 1024 * 1024 });
}
