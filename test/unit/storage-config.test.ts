import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, loadConfig, validateConfig } from "../../src/config.js";

test("storage maintenance config deep-merges narrow operator overrides", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "luna-storage-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify({
    storageMaintenance: { keepRecentRuns: 7 },
  }), "utf8");

  const config = await loadConfig(path);

  assert.equal(config.storageMaintenance.keepRecentRuns, 7);
  assert.equal(
    config.storageMaintenance.maxStateBytes,
    DEFAULT_CONFIG.storageMaintenance.maxStateBytes,
  );
  assert.equal(config.storageMaintenance.autoCompact, true);
});

test("storage maintenance config rejects unsafe or unbounded values", () => {
  assert.throws(
    () => validateConfig({
      ...DEFAULT_CONFIG,
      storageMaintenance: {
        ...DEFAULT_CONFIG.storageMaintenance,
        maxArchiveFiles: 0,
      },
    }),
    /storageMaintenance\.maxArchiveFiles/,
  );
  assert.throws(
    () => validateConfig({
      ...DEFAULT_CONFIG,
      storageMaintenance: {
        ...DEFAULT_CONFIG.storageMaintenance,
        maxArchiveBytes: Number.MAX_SAFE_INTEGER,
      },
    }),
    /storageMaintenance\.maxArchiveBytes/,
  );
});
