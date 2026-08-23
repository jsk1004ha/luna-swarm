import { randomUUID } from "node:crypto";
import { link, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Publishes an immutable authority record only after its bytes and directory
 * entry are durable. The hard-link publication is create-only and therefore
 * cannot replace an existing record.
 */
export async function durableCreateText(target: string, text: string): Promise<void> {
  const directory = dirname(target);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, target);
    await unlink(temporary);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

/** Atomically replaces a mutable head after syncing the new bytes. */
export async function durableReplaceText(target: string, text: string): Promise<void> {
  const directory = dirname(target);
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await handle.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  if (!isNodeError(error)) return false;
  if (["EINVAL", "EISDIR", "ENOSYS", "ENOTSUP"].includes(error.code ?? "")) return true;
  return process.platform === "win32" && error.code === "EPERM";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
