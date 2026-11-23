import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Creates cache directories only through real, in-boundary directory ancestors. */
export async function prepareManagedCacheDirectories(
  boundaryRoot: string,
  directories: readonly string[],
): Promise<void> {
  const boundary = await realpath(resolve(boundaryRoot));
  for (const candidate of directories) {
    const target = resolve(candidate);
    assertContained(boundary, target);
    const parts = relative(boundary, target).split(sep).filter(Boolean);
    let current = boundary;
    for (const part of parts) {
      current = join(current, part);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(current);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        await mkdir(current);
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`Managed cache ancestor is not a real directory: ${current}`);
      }
    }
    assertContained(boundary, await realpath(target));
  }
}

function assertContained(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) return;
  throw new Error(`Managed cache path escapes its workspace boundary: ${target}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
