import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileContext } from "../../src/harness-v2/context.js";
import { HARNESS_V2_ORG_VERSION, type AgentRoleContract, type WorkOrder } from "../../src/harness-v2/contracts.js";
import {
  buildProgramContextBundle,
  buildProgramKnowledgeGraph,
  canonicalProgramKnowledgeHash,
} from "../../src/harness-v2/program-knowledge.js";

const role: AgentRoleContract = {
  agentId: "engineering-runtime-001", orgVersion: HARNESS_V2_ORG_VERSION, headquartersId: "engineering",
  divisionId: "runtime", teamId: "core-runtime", cellId: "cell-1", role: "executor", title: "Engineer",
  charter: ["implement"], inputs: ["work order"], tools: { allow: ["read"], deny: [] },
  filesystem: { read: ["workspace/**"], write: ["workspace/src/**"] }, network: "off", allowedDomains: [],
  outputSchema: "artifact-v1", cannotReview: ["self", "core-runtime"], memory: "task-scoped",
};

const workOrder: WorkOrder = {
  id: "WO-PKG", revision: 1, missionId: "mission-1", requirementIds: ["REQ-CALCULATE"],
  objective: "Change calculate behavior", constraints: ["keep the API stable"], nonGoals: [], ownerTeam: "core-runtime",
  reviewerPool: ["unit-testing"], risk: "standard", dependencies: [], inputArtifactIds: [],
  deliverables: ["calculator"], acceptanceTests: ["calculate unit test"], requiredGateIds: ["G0"],
  toolPolicy: { allowedTools: ["read"], network: "off", allowedDomains: [], readScopes: ["workspace/**"], writeScopes: ["workspace/src/**"] },
  maxExecutionAttempts: 2, maxValidationAttempts: 2, priority: 17,
};

const sources = [
  { path: "test/calculate.test.ts", content: "import { calculate } from '../src/math.js';\ncalculate(2);" },
  { path: "src/math.ts", content: "export function calculate(value: number) { return double(value); }\nfunction double(value: number) { return value * 2; }" },
  { path: "src/index.ts", content: "export { calculate } from './math.js';" },
  { path: ".github/workflows/ci.yml", content: "name: CI" },
  { path: ".env.example", content: "API_URL=https://example.test" },
  { path: "package.json", content: JSON.stringify({ main: "dist/src/index.js" }) },
] as const;

test("program graph deterministically indexes files, AST relations, tests, history, and ownership", () => {
  const options = {
    rootDir: ".", sources, roleContract: role,
    gitHistory: [{ commit: "abc123", paths: ["src/math.ts"], author: "dev", subject: "calculator" }],
  };
  const first = buildProgramKnowledgeGraph(options);
  const second = buildProgramKnowledgeGraph({ ...options, sources: [...sources].reverse() });
  assert.deepEqual(first, second);
  assert.match(first.hash, /^[a-f0-9]{64}$/u);
  assert.ok(first.nodes.some((node) => node.id === "entrypoint:src/index.ts"));
  assert.ok(first.nodes.some((node) => node.kind === "ci"));
  assert.ok(first.nodes.some((node) => node.kind === "environment"));
  assert.ok(first.nodes.some((node) => node.id === "team:core-runtime"));
  assert.ok(first.edges.some((edge) => edge.kind === "imports" && edge.to === "file:src/math.ts"));
  assert.ok(first.edges.some((edge) => edge.kind === "calls" && edge.to.includes("#double@")));
  assert.ok(first.edges.some((edge) => edge.kind === "changed-by" && edge.to === "commit:abc123"));
  const calculate = first.nodes.find((node) => node.kind === "symbol" && node.label === "calculate")!;
  assert.deepEqual(first.functionTests[calculate.id], ["test/calculate.test.ts"]);
  assert.equal(first.hash, canonicalProgramKnowledgeHash({
    version: first.version, root: first.root, nodes: first.nodes, edges: first.edges,
    functionTests: first.functionTests, omitted: first.omitted, scan: first.scan,
  }));
});

test("iterative scan stops before enumerating a many-file directory", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-program-many-"));
  try {
    for (let index = 0; index < 40; index++) writeFileSync(join(root, `${String(index).padStart(3, "0")}.ts`), `export const value${index} = "${"x".repeat(100)}";`);
    const graph = buildProgramKnowledgeGraph({
      rootDir: root,
      caps: { maxCandidateFiles: 5, maxFiles: 20, maxEntriesPerDirectory: 100 },
    });
    assert.equal(graph.scan.candidateFiles, 5);
    assert.equal(graph.nodes.filter((node) => node.kind === "file").length, 5);
    assert.equal(graph.omitted.truncated, true);
    assert.ok(graph.omitted.candidates >= 1);
    assert.ok(graph.scan.scannedBytes < 2_000, "scanner should stop well before reading all forty source files");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("iterative scan bounds deep directory traversal and rejects caps above hard ceilings", () => {
  const root = mkdtempSync(join(tmpdir(), "luna-program-deep-"));
  try {
    let directory = root;
    for (let depth = 0; depth < 20; depth++) {
      writeFileSync(join(directory, `depth-${depth}.ts`), `export const depth = ${depth};`);
      directory = join(directory, `level-${depth}`);
      mkdirSync(directory);
    }
    const graph = buildProgramKnowledgeGraph({ rootDir: root, caps: { maxScanDepth: 3, maxVisitedDirectories: 4 } });
    assert.equal(graph.scan.visitedDirectories, 4);
    assert.equal(graph.omitted.truncated, true);
    assert.ok(graph.omitted.directories >= 1);
    assert.ok(!graph.nodes.some((node) => node.path === "level-0/level-1/level-2/level-3/depth-4.ts"));
    assert.throws(
      () => buildProgramKnowledgeGraph({ rootDir: root, caps: { maxScanDepth: 129 } }),
      /hard ceiling/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context bundle selects a bounded relevant subgraph as one whole compileContext item", () => {
  const graph = buildProgramKnowledgeGraph({ rootDir: ".", sources, roleContract: role });
  const bundle = buildProgramContextBundle(graph, workOrder, { caps: { maxBundleNodes: 8, maxBundleEdges: 12, maxTraversalDepth: 1 } });
  assert.ok(bundle.nodes.length <= 8);
  assert.ok(bundle.edges.length <= 12);
  assert.equal(bundle.contextItem.priority, 17);
  assert.equal((bundle.contextItem.content as { hash: string }).hash, bundle.hash);
  assert.ok(bundle.nodes.some((node) => node.label === "calculate"));
  const compiled = compileContext({
    constitution: { id: "constitution", content: {} }, roleContract: role,
    mission: { id: "mission-1", content: {} }, workOrder, dependencyArtifacts: [], gateFindings: [],
    optionalReferences: [bundle.contextItem], budget: { maxUtf8Bytes: 1_000_000, maxCharacters: 1_000_000 },
  });
  assert.deepEqual(compiled.items.slice(-1).map((item) => item.id), [bundle.contextItem.id]);
  assert.match(compiled.text, /program-context-v1/u);
});

test("source paths are safe and filesystem scanning skips ignored, binary, and oversized files", () => {
  assert.throws(() => buildProgramKnowledgeGraph({ rootDir: ".", sources: [{ path: "../escape.ts", content: "" }] }), /escapes/u);
  assert.throws(() => buildProgramKnowledgeGraph({ rootDir: ".", sources: [{ path: join(tmpdir(), "absolute.ts"), content: "" }] }), /relative and safe/u);

  const root = mkdtempSync(join(tmpdir(), "luna-program-knowledge-"));
  try {
    mkdirSync(join(root, "src"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "src", "ok.ts"), "export const ok = () => 1;");
    writeFileSync(join(root, "src", "large.ts"), "x".repeat(100));
    writeFileSync(join(root, "src", "binary.ts"), "a\0b");
    writeFileSync(join(root, "node_modules", "ignored.ts"), "export const ignored = true;");
    const graph = buildProgramKnowledgeGraph({ rootDir: root, caps: { maxFileBytes: 50 } });
    assert.ok(graph.nodes.some((node) => node.id === "file:src/ok.ts"));
    assert.ok(!graph.nodes.some((node) => node.id.includes("large.ts") || node.id.includes("binary.ts") || node.id.includes("ignored.ts")));
    assert.equal(graph.omitted.files, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
