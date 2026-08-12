import { describe, expect, it, vi } from "vitest";
import { loadAssetWithRetry, OFFICE_ASSET_VERSION, versionedAssetUrl } from "./assetLoader";

describe("office asset loader", () => {
  it("uses one shared version key for the initial request", () => {
    expect(versionedAssetUrl("/assets/employee.png")).toBe(`/assets/employee.png?v=${OFFICE_ASSET_VERSION}`);
    expect(versionedAssetUrl("/assets/employee.png", 0, 2)).toBe(`/assets/employee.png?v=${OFFICE_ASSET_VERSION}&reload=2`);
  });

  it("busts a rejected Pixi cache after an operator retry", async () => {
    const urls: string[] = [];
    await loadAssetWithRetry("/assets/employee.png", async (url) => {
      urls.push(url);
      return "texture";
    }, { generation: 3 });
    expect(urls).toEqual([`/assets/employee.png?v=${OFFICE_ASSET_VERSION}&reload=3`]);
  });

  it("recovers from a transient image failure without poisoning later attempts", async () => {
    const loader = vi.fn<(_url: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("temporary decode failure"))
      .mockResolvedValue("texture");
    const value = await loadAssetWithRetry("/assets/employee.png", loader, {
      attempts: 3,
      pause: async () => undefined,
    });
    expect(value).toBe("texture");
    expect(loader).toHaveBeenCalledTimes(2);
    expect(loader.mock.calls[1]?.[0]).toContain(`v=${OFFICE_ASSET_VERSION}&recovery=1`);
  });

  it("reports the exact missing asset after bounded retries", async () => {
    const loader = vi.fn(async () => { throw new Error("404"); });
    await expect(loadAssetWithRetry("/assets/missing.png", loader, {
      attempts: 2,
      pause: async () => undefined,
    })).rejects.toThrow("/assets/missing.png");
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
