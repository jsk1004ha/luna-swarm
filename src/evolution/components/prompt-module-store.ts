import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canonicalJson } from "../domain/canonical.js";
import { assertNoLinks, ExecutionBundleStore } from "../registry/bundle-store.js";
import {
  PromptModuleIntegrityError,
  createPromptModuleV1,
  verifyPromptModuleV1,
  type PromptModuleV1,
  type PromptModuleV1Input,
} from "./prompt-module.js";

export class PromptModuleStoreConflictError extends Error {}

/** Immutable content-addressed storage for declarative prompt-module/v1 records. */
export class PromptModuleStore {
  readonly rootDirectory: string;
  readonly modulesDirectory: string;

  constructor(
    readonly workspaceDirectory: string,
    readonly bundleStore = new ExecutionBundleStore(workspaceDirectory),
  ) {
    this.rootDirectory = bundleStore.rootDirectory;
    this.modulesDirectory = join(this.rootDirectory, "components", "prompt-module-v1", "sha256");
  }

  async init(): Promise<void> {
    await this.bundleStore.init();
    await mkdir(this.modulesDirectory, { recursive: true });
    await assertNoLinks(this.bundleStore.workspaceDirectory, this.modulesDirectory);
  }

  async publish(input: PromptModuleV1Input | PromptModuleV1): Promise<Readonly<PromptModuleV1>> {
    const module = "contentHash" in input ? verifyPromptModuleV1(input) : createPromptModuleV1(input);
    await this.init();
    const path = this.pathFor(module.contentHash);
    await assertNoLinks(this.bundleStore.workspaceDirectory, dirname(path));
    const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
    await writeFile(temp, `${canonicalJson(module)}\n`, { encoding: "utf8", flag: "wx" });
    try {
      const handle = await open(temp, "r");
      try { await syncFile(handle); } finally { await handle.close(); }
      try {
        await link(temp, path);
      } catch (error) {
        if (!isNodeError(error) || !["EEXIST", "EPERM"].includes(error.code ?? "")) throw error;
        const existing = await this.readAfterPublishRace(module.contentHash);
        if (canonicalJson(existing) !== canonicalJson(module)) {
          throw new PromptModuleStoreConflictError(`Prompt module hash ${module.contentHash} is already bound to different content`);
        }
      }
      return module;
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  async read(contentHash: string): Promise<Readonly<PromptModuleV1>> {
    if (!/^sha256:[a-f0-9]{64}$/.test(contentHash)) {
      throw new PromptModuleIntegrityError("Prompt module hash is not canonical SHA-256");
    }
    await this.init();
    const path = this.pathFor(contentHash);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new PromptModuleIntegrityError(`Unsafe prompt module path: ${path}`);
    }
    const handle = await open(path, "r");
    try {
      const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
      if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() ||
          opened.nlink !== 1 || current.nlink !== 1 || !sameFileIdentity(opened, current)) {
        throw new PromptModuleIntegrityError(`Unsafe prompt module path: ${path}`);
      }
      const module = verifyPromptModuleV1(JSON.parse(await handle.readFile("utf8")) as PromptModuleV1);
      if (module.contentHash !== contentHash) throw new PromptModuleIntegrityError("Prompt module path/hash mismatch");
      return module;
    } finally {
      await handle.close();
    }
  }

  private pathFor(contentHash: string): string {
    return join(this.modulesDirectory, `${contentHash.slice("sha256:".length)}.json`);
  }

  private async readAfterPublishRace(contentHash: string): Promise<Readonly<PromptModuleV1>> {
    let latest: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.read(contentHash);
      } catch (error) {
        latest = error;
        if (!(error instanceof PromptModuleIntegrityError) || !/Unsafe prompt module path/.test(error.message)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 2 ** attempt));
      }
    }
    throw latest;
  }
}

async function syncFile(handle: import("node:fs/promises").FileHandle): Promise<void> {
  try { await handle.datasync(); } catch (error) {
    if (!isNodeError(error) || !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code ?? "")) throw error;
  }
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
