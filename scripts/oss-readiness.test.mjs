import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditOssReadiness, renderOssReadinessMarkdown } from "./oss-readiness.mjs";

async function write(root, path, content = "content\n") {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, content, "utf8");
}

test("a fully documented repository receives a ready report", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oss-ready-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    write(root, "README.md"),
    write(root, "LICENSE"),
    write(root, "CONTRIBUTING.md"),
    write(root, "CODE_OF_CONDUCT.md"),
    write(root, "SECURITY.md"),
    write(root, "GOVERNANCE.md"),
    write(root, "CHANGELOG.md"),
    write(root, ".github/ISSUE_TEMPLATE/bug.yml"),
    write(root, ".github/pull_request_template.md"),
    write(root, ".github/workflows/ci.yml"),
    write(root, "test/example.test.js"),
    write(root, "package.json", JSON.stringify({
      name: "example",
      version: "1.0.0",
      private: false,
      license: "MIT",
      repository: { type: "git", url: "https://example.invalid/repo.git" },
      bugs: { url: "https://example.invalid/issues" },
      homepage: "https://example.invalid",
      scripts: { test: "node --test" },
    })),
  ]);

  const report = await auditOssReadiness(root);
  assert.equal(report.status, "ready");
  assert.equal(report.score, 100);
  assert.deepEqual(report.blockers, []);
  assert.match(renderOssReadinessMarkdown(report), /Score: \*\*100\/100\*\*/);
});

test("missing license is a blocker even when optional artifacts exist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oss-blocked-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    write(root, "README.md"),
    write(root, "CONTRIBUTING.md"),
    write(root, ".github/workflows/ci.yml"),
    write(root, "tests/example.test.js"),
  ]);

  const report = await auditOssReadiness(root);
  assert.equal(report.status, "blocked");
  assert.equal(report.checks.find((check) => check.id === "license")?.state, "fail");
  assert.match(report.blockers.join("\n"), /Open-source license/);
});

test("malformed package metadata is reported without crashing the audit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oss-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    write(root, "README.md"),
    write(root, "LICENSE"),
    write(root, "package.json", "{not-json"),
  ]);

  const report = await auditOssReadiness(root);
  const packageCheck = report.checks.find((check) => check.id === "package-metadata");
  assert.equal(packageCheck?.state, "fail");
  assert.match(packageCheck?.message ?? "", /could not be parsed/);
});
