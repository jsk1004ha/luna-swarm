import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { durableCreateText, durableReplaceText } from "../../src/evolution/registry/durable-file.js";

test("promotion authority records sync bytes and their parent directory before success", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-evolution-durable-"));
  const probePath = join(root, "probe");
  const probe = await open(probePath, "wx");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  await unlink(probePath);
  const originalSync = prototype.sync;
  let syncCalls = 0;
  prototype.sync = async function(this: unknown): Promise<void> {
    syncCalls += 1;
    return originalSync.call(this);
  };
  try {
    const record = join(root, "record.json");
    await durableCreateText(record, "one\n");
    await durableReplaceText(record, "two\n");
    assert.equal(await readFile(record, "utf8"), "two\n");
    assert.ok(syncCalls >= 4, "each authority commit must sync its file and directory");
  } finally {
    prototype.sync = originalSync;
    await rm(root, { recursive: true, force: true });
  }
});

test("a file sync failure cannot publish an authority record", async () => {
  const root = await mkdtemp(join(tmpdir(), "luna-evolution-durable-fail-"));
  const probePath = join(root, "probe");
  const probe = await open(probePath, "wx");
  const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  await unlink(probePath);
  const originalSync = prototype.sync;
  const injected = Object.assign(new Error("injected authority fsync failure"), { code: "EIO" });
  prototype.sync = async (): Promise<void> => { throw injected; };
  try {
    const target = join(root, "record.json");
    await assert.rejects(() => durableCreateText(target, "unsafe\n"), (error) => error === injected);
    await assert.rejects(() => readFile(target), { code: "ENOENT" });
  } finally {
    prototype.sync = originalSync;
    await rm(root, { recursive: true, force: true });
  }
});
