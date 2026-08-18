#!/usr/bin/env node
import { access, appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_DEFINITIONS = Object.freeze([
  { id: "readme", title: "README", points: 10, critical: true, recommendation: "Add a root README that explains the problem, installation, usage, and project status." },
  { id: "license", title: "Open-source license", points: 10, critical: true, recommendation: "Add a recognized open-source license at the repository root." },
  { id: "contributing", title: "Contribution guide", points: 10, critical: false, recommendation: "Document setup, tests, review expectations, and contribution boundaries in CONTRIBUTING.md." },
  { id: "code-of-conduct", title: "Code of conduct", points: 5, critical: false, recommendation: "Add a code of conduct with reporting and enforcement guidance." },
  { id: "security", title: "Security policy", points: 8, critical: false, recommendation: "Document supported versions and a private vulnerability reporting path in SECURITY.md." },
  { id: "governance", title: "Governance and maintainer roles", points: 8, critical: false, recommendation: "Document maintainers, decision rights, release authority, and how contributors can earn responsibility." },
  { id: "issue-templates", title: "Issue templates", points: 8, critical: false, recommendation: "Add structured bug and feature templates under .github/ISSUE_TEMPLATE." },
  { id: "pull-request-template", title: "Pull request template", points: 5, critical: false, recommendation: "Add a pull request template that asks for scope, validation, risks, and linked issues." },
  { id: "continuous-integration", title: "Continuous integration", points: 10, critical: false, recommendation: "Run build, tests, and static checks on pull requests." },
  { id: "tests", title: "Automated tests", points: 10, critical: false, recommendation: "Add automated tests or a documented verification harness." },
  { id: "release-notes", title: "Release notes or changelog", points: 6, critical: false, recommendation: "Track user-visible changes in CHANGELOG.md or an equivalent release-notes process." },
]);

export async function auditOssReadiness(rootDirectory) {
  const root = resolve(rootDirectory);
  const checks = [];

  checks.push(await fileCheck(root, CHECK_DEFINITIONS[0], {
    rootPrefixes: ["readme"],
  }));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[1], {
    rootPrefixes: ["license", "copying"],
  }));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[2], {
    paths: ["CONTRIBUTING.md", ".github/CONTRIBUTING.md"],
  }));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[3], {
    paths: ["CODE_OF_CONDUCT.md", ".github/CODE_OF_CONDUCT.md"],
  }));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[4], {
    paths: ["SECURITY.md", ".github/SECURITY.md"],
  }));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[5], {
    paths: ["GOVERNANCE.md", "MAINTAINERS.md", ".github/CODEOWNERS"],
  }));
  checks.push(await directoryCheck(root, CHECK_DEFINITIONS[6], ".github/ISSUE_TEMPLATE", (name) => {
    const normalized = name.toLowerCase();
    return normalized !== "config.yml" && normalized !== "config.yaml" && /\.(yml|yaml|md)$/.test(normalized);
  }));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[7], {
    paths: [
      ".github/pull_request_template.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
    ],
    directories: [".github/PULL_REQUEST_TEMPLATE"],
  }));
  checks.push(await directoryCheck(root, CHECK_DEFINITIONS[8], ".github/workflows", (name) => /\.(yml|yaml)$/.test(name.toLowerCase())));
  checks.push(await testCheck(root, CHECK_DEFINITIONS[9]));
  checks.push(await fileCheck(root, CHECK_DEFINITIONS[10], {
    rootPrefixes: ["changelog", "changes", "releases"],
    paths: [".changeset/config.json"],
  }));
  checks.push(await packageMetadataCheck(root));

  const availablePoints = checks.reduce((total, check) => total + check.maxPoints, 0);
  const earnedPoints = checks.reduce((total, check) => total + check.points, 0);
  const score = availablePoints === 0 ? 0 : Math.round((earnedPoints / availablePoints) * 100);
  const blockers = checks
    .filter((check) => check.critical && check.state !== "pass")
    .map((check) => `${check.title}: ${check.message}`);
  const recommendations = checks
    .filter((check) => check.state !== "pass" && check.state !== "not-applicable")
    .map((check) => check.recommendation);
  const status = blockers.length > 0 || score < 60
    ? "blocked"
    : score >= 85
      ? "ready"
      : "needs-work";

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root,
    score,
    earnedPoints,
    availablePoints,
    status,
    blockers,
    recommendations,
    checks,
    limitations: [
      "This audit checks repository artifacts, not real-world adoption, maintainer responsiveness, release cadence, or ecosystem importance.",
      "A high score is not evidence of eligibility for any external funding, credit, or support program.",
    ],
  };
}

export function renderOssReadinessMarkdown(report) {
  const rows = report.checks.map((check) => {
    const evidence = check.evidence.length > 0 ? check.evidence.map(escapeTableCell).join("<br>") : "—";
    return `| ${escapeTableCell(check.title)} | ${check.state} | ${check.points}/${check.maxPoints} | ${evidence} |`;
  });
  const blockers = report.blockers.length > 0
    ? report.blockers.map((blocker) => `- ${blocker}`).join("\n")
    : "- None";
  const recommendations = report.recommendations.length > 0
    ? report.recommendations.map((recommendation) => `- ${recommendation}`).join("\n")
    : "- No repository-artifact gaps detected.";
  const limitations = report.limitations.map((limitation) => `- ${limitation}`).join("\n");

  return `# OSS readiness report\n\n- Status: **${report.status}**\n- Score: **${report.score}/100** (${report.earnedPoints}/${report.availablePoints} weighted points)\n- Root: \`${report.root}\`\n- Generated: ${report.generatedAt}\n\n## Checks\n\n| Check | State | Points | Evidence |\n|---|---:|---:|---|\n${rows.join("\n")}\n\n## Blockers\n\n${blockers}\n\n## Recommended next actions\n\n${recommendations}\n\n## Limits of this report\n\n${limitations}\n`;
}

async function fileCheck(root, definition, options) {
  const evidence = [];
  for (const candidate of options.paths ?? []) {
    if (await pathExists(join(root, candidate))) evidence.push(candidate);
  }
  for (const directory of options.directories ?? []) {
    if (await directoryHasEntries(join(root, directory))) evidence.push(`${directory}/`);
  }
  if (options.rootPrefixes?.length) {
    const entries = await safeReadDirectory(root);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const normalized = entry.name.toLowerCase();
      if (options.rootPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`) || normalized.startsWith(`${prefix}-`))) {
        evidence.push(entry.name);
      }
    }
  }
  return resultFromEvidence(definition, unique(evidence));
}

async function directoryCheck(root, definition, relativeDirectory, predicate) {
  const entries = await safeReadDirectory(join(root, relativeDirectory));
  const evidence = entries
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => `${relativeDirectory}/${entry.name}`);
  return resultFromEvidence(definition, evidence);
}

async function testCheck(root, definition) {
  const evidence = [];
  for (const directory of ["test", "tests", "__tests__", "spec"]) {
    if (await directoryHasEntries(join(root, directory))) evidence.push(`${directory}/`);
  }
  const packageJson = await readPackageJson(root);
  const testScript = packageJson.ok && typeof packageJson.value.scripts?.test === "string"
    ? packageJson.value.scripts.test.trim()
    : "";
  if (testScript && !/no test specified/i.test(testScript)) evidence.push("package.json#scripts.test");
  return resultFromEvidence(definition, unique(evidence));
}

async function packageMetadataCheck(root) {
  const definition = {
    id: "package-metadata",
    title: "Package and release metadata",
    points: 10,
    critical: false,
    recommendation: "For a distributable Node package, set private=false and add license, repository, bugs, and homepage metadata before publishing.",
  };
  const packageJson = await readPackageJson(root);
  if (!packageJson.present) {
    return {
      id: definition.id,
      title: definition.title,
      state: "not-applicable",
      points: 0,
      maxPoints: 0,
      critical: false,
      evidence: [],
      message: "No package.json was found; this language-specific check is not applicable.",
      recommendation: definition.recommendation,
    };
  }
  if (!packageJson.ok) {
    return {
      id: definition.id,
      title: definition.title,
      state: "fail",
      points: 0,
      maxPoints: definition.points,
      critical: false,
      evidence: ["package.json"],
      message: `package.json could not be parsed: ${packageJson.error}`,
      recommendation: "Repair package.json before relying on package or release automation.",
    };
  }

  const value = packageJson.value;
  const criteria = [
    { ok: value.private !== true, label: "public package" },
    { ok: nonEmpty(value.license), label: "license" },
    { ok: nonEmpty(value.repository), label: "repository" },
    { ok: nonEmpty(value.bugs), label: "bugs" },
    { ok: nonEmpty(value.homepage), label: "homepage" },
  ];
  const passed = criteria.filter((criterion) => criterion.ok);
  const points = passed.length * 2;
  const missing = criteria.filter((criterion) => !criterion.ok).map((criterion) => criterion.label);
  return {
    id: definition.id,
    title: definition.title,
    state: points === definition.points ? "pass" : points >= 6 ? "warn" : "fail",
    points,
    maxPoints: definition.points,
    critical: false,
    evidence: ["package.json", ...passed.map((criterion) => `package.json#${criterion.label}`)],
    message: missing.length === 0 ? "Package metadata is ready for a public distribution workflow." : `Missing or disabled: ${missing.join(", ")}.`,
    recommendation: definition.recommendation,
  };
}

function resultFromEvidence(definition, evidence) {
  const passed = evidence.length > 0;
  return {
    id: definition.id,
    title: definition.title,
    state: passed ? "pass" : "fail",
    points: passed ? definition.points : 0,
    maxPoints: definition.points,
    critical: definition.critical,
    evidence,
    message: passed ? "Detected." : "Not detected.",
    recommendation: definition.recommendation,
  };
}

async function readPackageJson(root) {
  const path = join(root, "package.json");
  if (!await pathExists(path)) return { present: false, ok: false, error: "not found" };
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return { present: true, ok: true, value };
  } catch (error) {
    return { present: true, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function nonEmpty(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasEntries(path) {
  return (await safeReadDirectory(path)).length > 0;
}

async function safeReadDirectory(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function unique(values) {
  return [...new Set(values)].sort();
}

function escapeTableCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integerOption(args, name, fallback, minimum, maximum) {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const root = resolve(option(args, "--root") ?? process.cwd());
  const format = option(args, "--format") ?? "markdown";
  if (!new Set(["markdown", "json"]).has(format)) throw new Error("--format must be markdown or json");
  const failUnder = integerOption(args, "--fail-under", 0, 0, 100);
  const outputOption = option(args, "--output");
  const output = outputOption ? (isAbsolute(outputOption) ? outputOption : resolve(outputOption)) : undefined;
  const githubOutput = option(args, "--github-output");
  const report = await auditOssReadiness(root);
  const rendered = format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderOssReadinessMarkdown(report);

  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
  if (githubOutput) {
    await appendFile(githubOutput, `score=${report.score}\nstatus=${report.status}\nreport_path=${output ?? ""}\n`, "utf8");
  }
  if (report.score < failUnder || report.blockers.length > 0) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`oss-readiness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
