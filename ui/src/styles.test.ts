import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("operations workspace layout contract", () => {
  it("keeps the Luna brand on one line", () => {
    expect(css).toMatch(/\.brand strong\s*\{[^}]*white-space:\s*nowrap/);
  });

  it("gives medium desktop widths an icon rail and overlay inspector", () => {
    expect(css).toMatch(/@media \(min-width:\s*1121px\) and \(max-width:\s*1499px\)[\s\S]*?grid-template-columns:\s*68px minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/@media \(min-width:\s*1121px\) and \(max-width:\s*1499px\)[\s\S]*?\.view-org \.inspector-panel[\s\S]*?position:\s*absolute/);
    expect(css).toMatch(/@media \(min-width:\s*1121px\) and \(max-width:\s*1499px\)[\s\S]*?\.view-org \.inspector-empty\s*\{\s*display:\s*none/);
  });

  it("reduces organization density on short desktop screens", () => {
    expect(css).toMatch(/@media \(min-width:\s*901px\) and \(max-height:\s*800px\)[\s\S]*?\.department-agents\s*\{\s*display:\s*none/);
  });
});
