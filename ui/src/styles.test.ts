import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const home = readFileSync(new URL("./pages/Home.tsx", import.meta.url), "utf8");
const uiPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { dependencies?: Record<string, string> };

function filesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe("user-provided ZIP command-center contract", () => {
  it("does not ship the decorative Headquarters campus surface", () => {
    expect(home).not.toMatch(/HQView|Headquarters/);
    expect(existsSync(fileURLToPath(new URL("./components/HQView.tsx", import.meta.url)))).toBe(false);
    expect(existsSync(fileURLToPath(new URL("./pixi/", import.meta.url)))).toBe(false);
    expect(uiPackage.dependencies).not.toHaveProperty("pixi.js");
  });

  it("renders one ZIP-derived workspace shell instead of nesting the legacy app", () => {
    expect(app).toMatch(/<Home\s*\/>/);
    expect(app).not.toMatch(/<TopBar|<ViewNav|<DirectoryPanel|<InspectorPanel|<EventDock/);
    expect(home.match(/className="workspace-shell"/g)).toHaveLength(1);
    for (const className of [
      "app-sidebar",
      "app-topbar",
      "content-area",
      "project-summary",
      "organization-card",
      "lower-grid",
      "directive-bar",
      "agent-drawer",
      "mobile-nav",
    ]) expect(home).toContain(className);
  });

  it("keeps real Luna data and every supported control inside the ZIP composition", () => {
    expect(home).toMatch(/useCompanyStore/);
    expect(home).not.toMatch(/useCompanyStore\(filteredAgents\)/);
    expect(home).toMatch(/useMemo\([\s\S]*?filteredAgents\(\{ snapshot, selectedDepartment, activityFilter, search \}\)/);
    expect(home).toMatch(/switchRun\(event\.target\.value\)/);
    expect(home).toMatch(/filteredAgents/);
    for (const action of ["start", "cancel", "concurrency", "instruction", "priority", "cancel_task"])
      expect(home).toContain(`action: "${action}"`);
    expect(home).toMatch(/action:\s*isPaused\s*\?\s*"resume"\s*:\s*"pause"/);
    expect(home).toMatch(/<DagView\s*\/>/);
    expect(home).toMatch(/All runtime events/);
  });

  it("preserves the ZIP desktop and mobile layout selectors", () => {
    for (const selector of [".workspace-shell", ".app-sidebar", ".app-topbar", ".project-summary", ".organization-chart", ".directive-bar", ".agent-drawer"])
      expect(css).toContain(selector);
    expect(css).toMatch(/@media \(max-width:820px\)[\s\S]*?\.workspace-shell\s*\{\s*display:block/);
    expect(css).toMatch(/@media \(max-width:820px\)[\s\S]*?\.mobile-nav\s*\{\s*display:grid/);
    expect(css).toMatch(/@media \(max-width:560px\)[\s\S]*?\.summary-cover\s*\{\s*display:none/);
    expect(css).toMatch(/\.directive-entry\s*\{[^}]*grid-template-columns/);
    expect(css).toMatch(/\.dag-board\s*\{[^}]*grid-template-columns/);
  });

  it("ships no old people or HQ raster assets or image references", () => {
    const assetRoots = [
      fileURLToPath(new URL("../public/assets/", import.meta.url)),
      fileURLToPath(new URL("../../web/assets/", import.meta.url)),
    ];
    const rasterExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"]);
    const rasterFiles = assetRoots.flatMap(filesUnder).filter((path) => rasterExtensions.has(extname(path).toLowerCase()));
    expect(rasterFiles).toEqual([]);
    expect(html).not.toMatch(/rel=["']preload["']/);
    expect(home).not.toMatch(/<img\b|manus-storage|employee-atlas|seated-workers|luna-hq-environment/);
    expect(css).not.toMatch(/url\([^)]*\.(?:png|jpe?g|webp|gif|bmp|avif)/i);
  });
});
