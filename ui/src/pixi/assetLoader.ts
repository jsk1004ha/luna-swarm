export const OFFICE_ASSET_VERSION = "luna-hq-20260812-10";

export const OFFICE_ASSET_PATHS = {
  standing: "/assets/employee-atlas-v2.png",
  north: "/assets/hq/seated-workers-north.png",
  south: "/assets/hq/seated-workers-south.png",
  east: "/assets/hq/seated-workers-east.png",
} as const;

export function versionedAssetUrl(path: string, attempt = 0, generation = 0): string {
  const separator = path.includes("?") ? "&" : "?";
  const recovery = attempt > 0 ? `&recovery=${attempt}` : "";
  const reload = generation > 0 ? `&reload=${generation}` : "";
  return `${path}${separator}v=${OFFICE_ASSET_VERSION}${recovery}${reload}`;
}

export async function loadAssetWithRetry<T>(
  path: string,
  loader: (url: string) => Promise<T>,
  options: { attempts?: number; generation?: number; pause?: (milliseconds: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const pause = options.pause ?? ((milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await loader(versionedAssetUrl(path, attempt, options.generation ?? 0));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await pause(120 * 2 ** attempt);
    }
  }
  throw new Error(`Office asset failed after ${attempts} attempts: ${path}`, { cause: lastError });
}
