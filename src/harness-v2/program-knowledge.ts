import { createHash } from "node:crypto";
import { lstatSync, opendirSync, readFileSync, realpathSync, type Dirent } from "node:fs";
import { extname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import type { AgentRoleContract, WorkOrder } from "./contracts.js";
import type { ContextSourceItem } from "./context.js";

export type ProgramKnowledgeNodeKind =
  | "file" | "symbol" | "module" | "entrypoint" | "config" | "environment"
  | "ci" | "commit" | "team" | "write-scope";
export type ProgramKnowledgeEdgeKind =
  | "contains" | "imports" | "calls" | "tested-by" | "entrypoint-for"
  | "configures" | "changed-by" | "owned-by" | "permits-write";

export interface ProgramKnowledgeNode {
  id: string;
  kind: ProgramKnowledgeNodeKind;
  label: string;
  path?: string;
  data: Record<string, unknown>;
  hash: string;
}

export interface ProgramKnowledgeEdge {
  id: string;
  kind: ProgramKnowledgeEdgeKind;
  from: string;
  to: string;
  data: Record<string, unknown>;
  hash: string;
}

export interface GitHistoryRecord {
  commit: string;
  paths: string[];
  author?: string;
  timestamp?: string;
  subject?: string;
}

export interface ProgramSourceRecord { path: string; content: string }

export interface ProgramKnowledgeCaps {
  maxFiles: number;
  maxCandidateFiles: number;
  maxFileBytes: number;
  maxScannedBytes: number;
  maxVisitedDirectories: number;
  maxScanDepth: number;
  maxEntriesPerDirectory: number;
  maxNodes: number;
  maxEdges: number;
  maxGitRecords: number;
  maxBundleNodes: number;
  maxBundleEdges: number;
  maxTraversalDepth: number;
}

export interface ProgramKnowledgeOptions {
  rootDir: string;
  sources?: readonly ProgramSourceRecord[];
  gitHistory?: readonly GitHistoryRecord[];
  roleContract?: AgentRoleContract;
  teamId?: string;
  writeScopes?: readonly string[];
  ignoreDirectories?: readonly string[];
  caps?: Partial<ProgramKnowledgeCaps>;
}

export interface ProgramKnowledgeGraph {
  version: "program-knowledge-v1";
  root: ".";
  nodes: ProgramKnowledgeNode[];
  edges: ProgramKnowledgeEdge[];
  functionTests: Record<string, string[]>;
  omitted: {
    files: number;
    directories: number;
    candidates: number;
    nodes: number;
    edges: number;
    gitRecords: number;
    truncated: boolean;
  };
  scan: { visitedDirectories: number; candidateFiles: number; scannedBytes: number };
  hash: string;
}

export interface ProgramContextBundle {
  version: "program-context-v1";
  workOrderId: string;
  graphHash: string;
  nodes: ProgramKnowledgeNode[];
  edges: ProgramKnowledgeEdge[];
  functionTests: Record<string, string[]>;
  omitted: { nodes: number; edges: number };
  hash: string;
  contextItem: ContextSourceItem;
}

const DEFAULT_CAPS: ProgramKnowledgeCaps = {
  maxFiles: 2_000,
  maxCandidateFiles: 4_000,
  maxFileBytes: 512 * 1_024,
  maxScannedBytes: 64 * 1_024 * 1_024,
  maxVisitedDirectories: 2_000,
  maxScanDepth: 32,
  maxEntriesPerDirectory: 10_000,
  maxNodes: 20_000,
  maxEdges: 50_000,
  maxGitRecords: 500,
  maxBundleNodes: 120,
  maxBundleEdges: 400,
  maxTraversalDepth: 2,
};
const HARD_CAPS: ProgramKnowledgeCaps = {
  maxFiles: 50_000,
  maxCandidateFiles: 100_000,
  maxFileBytes: 16 * 1_024 * 1_024,
  maxScannedBytes: 512 * 1_024 * 1_024,
  maxVisitedDirectories: 50_000,
  maxScanDepth: 128,
  maxEntriesPerDirectory: 100_000,
  maxNodes: 500_000,
  maxEdges: 1_000_000,
  maxGitRecords: 50_000,
  maxBundleNodes: 10_000,
  maxBundleEdges: 50_000,
  maxTraversalDepth: 16,
};
const DEFAULT_IGNORES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "coverage", ".next",
  ".turbo", ".cache", ".luna-swarm", "tmp", "temp", "vendor", "target", "artifacts", ".artifacts",
]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const TEXT_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, ".json", ".jsonc", ".yml", ".yaml", ".toml", ".env", ".md"]);

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical values require finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError(`Unsupported canonical value: ${typeof value}`);
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function canonicalProgramKnowledgeHash(value: unknown): string {
  return createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function assertCap(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
  return value;
}

function caps(input?: Partial<ProgramKnowledgeCaps>): ProgramKnowledgeCaps {
  const merged = { ...DEFAULT_CAPS, ...input };
  for (const [key, value] of Object.entries(merged)) {
    assertCap(key, value);
    const ceiling = HARD_CAPS[key as keyof ProgramKnowledgeCaps];
    if (value > ceiling) throw new RangeError(`${key} exceeds the hard ceiling of ${ceiling}`);
  }
  return merged;
}

function normalizeRelativePath(value: string): string {
  if (value.includes("\0") || isAbsolute(value)) throw new Error(`Path must be relative and safe: ${value}`);
  const normalized = posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//u, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Path escapes the program root: ${value}`);
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

interface SourceScanResult {
  sources: ProgramSourceRecord[];
  omittedFiles: number;
  omittedDirectories: number;
  omittedCandidates: number;
  visitedDirectories: number;
  candidateFiles: number;
  scannedBytes: number;
  truncated: boolean;
}

function scanSources(rootDir: string, limit: ProgramKnowledgeCaps, extraIgnores: readonly string[]): SourceScanResult {
  const root = realpathSync(resolve(rootDir));
  const ignores = new Set([...DEFAULT_IGNORES, ...extraIgnores]);
  const sources: ProgramSourceRecord[] = [];
  const pending: Array<{ directory: string; relativePath: string; depth: number }> = [{ directory: root, relativePath: "", depth: 0 }];
  let omittedFiles = 0;
  let omittedDirectories = 0;
  let omittedCandidates = 0;
  let visitedDirectories = 0;
  let candidateFiles = 0;
  let scannedBytes = 0;
  let truncated = false;
  let stopped = false;

  while (pending.length > 0 && !stopped) {
    if (visitedDirectories >= limit.maxVisitedDirectories) {
      omittedDirectories += pending.length;
      truncated = true;
      break;
    }
    const current = pending.pop()!;
    visitedDirectories++;
    const directoryEntries: Dirent[] = [];
    let discoveredCandidates = 0;
    const remainingCandidates = limit.maxCandidateFiles - candidateFiles;
    const handle = opendirSync(current.directory, { bufferSize: Math.min(32, Math.max(1, limit.maxEntriesPerDirectory)) });
    try {
      while (directoryEntries.length < limit.maxEntriesPerDirectory) {
        const entry = handle.readSync();
        if (!entry) break;
        const metadataBytes = Buffer.byteLength(`${current.relativePath}/${entry.name}`, "utf8") + 32;
        if (scannedBytes + metadataBytes > limit.maxScannedBytes) { truncated = true; stopped = true; break; }
        scannedBytes += metadataBytes;
        const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
        const extension = extname(entry.name).toLowerCase();
        const eligibleFile = entry.isFile() && (TEXT_EXTENSIONS.has(extension) || entry.name.startsWith(".env") || relativePath.startsWith(".github/workflows/"));
        if (eligibleFile && discoveredCandidates >= remainingCandidates) {
          omittedCandidates++;
          omittedFiles++;
          truncated = true;
          stopped = true;
          break;
        }
        if (eligibleFile) discoveredCandidates++;
        directoryEntries.push(entry);
      }
      if (!stopped && directoryEntries.length === limit.maxEntriesPerDirectory && handle.readSync()) {
        truncated = true;
        omittedCandidates++;
      }
    } finally {
      handle.closeSync();
    }
    const childDirectories: Array<{ directory: string; relativePath: string; depth: number }> = [];
    for (const entry of directoryEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name;
      const absolute = resolve(current.directory, entry.name);
      if (!isContained(root, absolute)) continue;
      if (entry.isDirectory()) {
        if (ignores.has(entry.name)) continue;
        if (current.depth >= limit.maxScanDepth) { omittedDirectories++; truncated = true; continue; }
        childDirectories.push({ directory: absolute, relativePath, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const path = normalizeRelativePath(relativePath);
      const extension = extname(entry.name).toLowerCase();
      const special = entry.name.startsWith(".env") || path.startsWith(".github/workflows/");
      if (!TEXT_EXTENSIONS.has(extension) && !special) continue;
      if (candidateFiles >= limit.maxCandidateFiles || sources.length >= limit.maxFiles) {
        omittedCandidates++;
        omittedFiles++;
        truncated = true;
        stopped = true;
        break;
      }
      candidateFiles++;
      const info = lstatSync(absolute);
      if (!info.isFile() || info.size > limit.maxFileBytes) { omittedFiles++; continue; }
      if (scannedBytes + info.size > limit.maxScannedBytes) { omittedFiles++; truncated = true; continue; }
      const content = readFileSync(absolute, "utf8");
      scannedBytes += info.size;
      if (content.includes("\0")) { omittedFiles++; continue; }
      sources.push({ path, content });
    }
    if (!stopped) for (const child of childDirectories.sort((a, b) => b.relativePath.localeCompare(a.relativePath))) pending.push(child);
  }
  return { sources, omittedFiles, omittedDirectories, omittedCandidates, visitedDirectories, candidateFiles, scannedBytes, truncated };
}

function boundedSourceRecords(records: readonly ProgramSourceRecord[], limit: ProgramKnowledgeCaps): SourceScanResult {
  const candidates: ProgramSourceRecord[] = [];
  for (const source of records) {
    candidates.push({ path: normalizeRelativePath(source.path), content: source.content });
    candidates.sort((a, b) => a.path.localeCompare(b.path));
    if (candidates.length > limit.maxCandidateFiles) candidates.pop();
  }
  for (let index = 1; index < candidates.length; index++) {
    if (candidates[index - 1]!.path === candidates[index]!.path) throw new Error(`Duplicate program source path: ${candidates[index]!.path}`);
  }
  const sources: ProgramSourceRecord[] = [];
  let omittedFiles = Math.max(0, records.length - candidates.length);
  let scannedBytes = 0;
  let truncated = records.length > candidates.length;
  for (const source of candidates) {
    if (sources.length >= limit.maxFiles) { omittedFiles++; truncated = true; continue; }
    const metadataBytes = Buffer.byteLength(source.path, "utf8") + 32;
    const sourceBytes = Buffer.byteLength(source.content, "utf8");
    if (sourceBytes > limit.maxFileBytes || scannedBytes + metadataBytes + sourceBytes > limit.maxScannedBytes || source.content.includes("\0")) {
      omittedFiles++; truncated = true; continue;
    }
    scannedBytes += metadataBytes + sourceBytes;
    sources.push(source);
  }
  return {
    sources,
    omittedFiles,
    omittedDirectories: 0,
    omittedCandidates: Math.max(0, records.length - candidates.length),
    visitedDirectories: 0,
    candidateFiles: candidates.length,
    scannedBytes,
    truncated,
  };
}

function node(kind: ProgramKnowledgeNodeKind, id: string, label: string, data: Record<string, unknown>, path?: string): ProgramKnowledgeNode {
  const base = { id, kind, label, ...(path === undefined ? {} : { path }), data };
  return { ...base, hash: canonicalProgramKnowledgeHash(base) };
}

function edge(kind: ProgramKnowledgeEdgeKind, from: string, to: string, data: Record<string, unknown> = {}): ProgramKnowledgeEdge {
  const id = `${kind}:${from}->${to}`;
  const base = { id, kind, from, to, data };
  return { ...base, hash: canonicalProgramKnowledgeHash(base) };
}

function syntaxKind(path: string): ts.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (path.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/u.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function declarationName(value: ts.Node): string | undefined {
  if ((ts.isFunctionDeclaration(value) || ts.isMethodDeclaration(value) || ts.isClassDeclaration(value)) && value.name) return value.name.getText();
  if (ts.isVariableDeclaration(value) && ts.isIdentifier(value.name) && value.initializer &&
      (ts.isArrowFunction(value.initializer) || ts.isFunctionExpression(value.initializer))) return value.name.text;
  return undefined;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/u.test(path);
}

function fileKind(path: string): ProgramKnowledgeNodeKind {
  if (path.startsWith(".github/workflows/") || /(^|\/)(\.gitlab-ci|azure-pipelines|Jenkinsfile)/iu.test(path)) return "ci";
  if (/(^|\/)\.env(?:\.|$)/u.test(path)) return "environment";
  if (/(^|\/)(package(?:-lock)?\.json|tsconfig[^/]*\.json|jsconfig[^/]*\.json|[^/]+\.config\.[cm]?[jt]s|Dockerfile|docker-compose[^/]*\.ya?ml)$/u.test(path)) return "config";
  return "file";
}

function isEntrypoint(path: string, packageEntrypoints: Set<string>): boolean {
  return packageEntrypoints.has(path) || /(^|\/)(index|main|cli|server|app)\.[cm]?[jt]sx?$/u.test(path);
}

function packageEntryPoints(sources: readonly ProgramSourceRecord[]): Set<string> {
  const result = new Set<string>();
  const pkg = sources.find((source) => source.path === "package.json");
  if (!pkg) return result;
  try {
    const value = JSON.parse(pkg.content) as Record<string, unknown>;
    const add = (candidate: unknown): void => {
      if (typeof candidate !== "string") return;
      const stripped = candidate.replace(/^\.\//u, "").replace(/^dist\//u, "src/").replace(/\.js$/u, ".ts");
      try { result.add(normalizeRelativePath(stripped)); } catch { /* invalid package path is ignored */ }
    };
    add(value.main);
    if (typeof value.bin === "string") add(value.bin);
    else if (value.bin && typeof value.bin === "object") for (const candidate of Object.values(value.bin)) add(candidate);
  } catch { /* malformed configuration remains represented as a config node */ }
  return result;
}

/** Builds a read-only, bounded index. Git history is data supplied by the caller; no git process is invoked. */
export function buildProgramKnowledgeGraph(options: ProgramKnowledgeOptions): ProgramKnowledgeGraph {
  const limit = caps(options.caps);
  const scanned = options.sources
    ? boundedSourceRecords(options.sources, limit)
    : scanSources(options.rootDir, limit, options.ignoreDirectories ?? []);
  const sources = scanned.sources;
  const knownPaths = new Set(sources.map((source) => source.path));
  const packageEntries = packageEntryPoints(sources);
  const nodes: ProgramKnowledgeNode[] = [];
  const edges: ProgramKnowledgeEdge[] = [];
  const symbolByName = new Map<string, string[]>();
  const calls: Array<{ caller: string; name: string; file: string }> = [];
  const testCalls: Array<{ testPath: string; name: string }> = [];
  let droppedNodes = 0;
  let droppedEdges = 0;
  const addNode = (value: ProgramKnowledgeNode): void => { if (nodes.length < limit.maxNodes) nodes.push(value); else droppedNodes++; };
  const addEdge = (value: ProgramKnowledgeEdge): void => { if (edges.length < limit.maxEdges) edges.push(value); else droppedEdges++; };

  for (const source of sources) {
    const fileId = `file:${source.path}`;
    const kind = fileKind(source.path);
    addNode(node(kind, fileId, source.path, {
      bytes: Buffer.byteLength(source.content, "utf8"), contentHash: canonicalProgramKnowledgeHash(source.content), test: isTestPath(source.path),
    }, source.path));
    if (isEntrypoint(source.path, packageEntries)) {
      const entryId = `entrypoint:${source.path}`;
      addNode(node("entrypoint", entryId, source.path, {}, source.path));
      addEdge(edge("entrypoint-for", entryId, fileId));
    }
    if (kind !== "file" || !SOURCE_EXTENSIONS.has(extname(source.path).toLowerCase())) continue;
    const ast = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true, syntaxKind(source.path));
    const functionStack: string[] = [];
    const visit = (current: ts.Node): void => {
      if ((ts.isImportDeclaration(current) || ts.isExportDeclaration(current)) && current.moduleSpecifier && ts.isStringLiteral(current.moduleSpecifier)) {
        const specifier = current.moduleSpecifier.text;
        let target = `module:${specifier}`;
        if (specifier.startsWith(".")) {
          const base = posix.normalize(posix.join(posix.dirname(source.path), specifier));
          const withoutRuntimeExtension = base.replace(/\.[cm]?jsx?$/u, "");
          const candidates = [base, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"].flatMap((suffix) => [`${base}${suffix}`, `${withoutRuntimeExtension}${suffix}`]), ...["index.ts", "index.tsx", "index.js"].map((name) => `${base}/${name}`)];
          const resolved = candidates.find((candidate) => knownPaths.has(candidate));
          if (resolved) target = `file:${resolved}`;
        }
        if (target.startsWith("module:") && !nodes.some((candidate) => candidate.id === target)) addNode(node("module", target, specifier, { external: true }));
        addEdge(edge("imports", fileId, target, { specifier }));
      }
      const name = declarationName(current);
      let pushed = false;
      if (name) {
        const position = ast.getLineAndCharacterOfPosition(current.getStart(ast));
        const symbolId = `symbol:${source.path}#${name}@${position.line + 1}:${position.character + 1}`;
        const signature = current.getText(ast).split("{")[0]!.trim().slice(0, 300);
        addNode(node("symbol", symbolId, name, { declaration: ts.SyntaxKind[current.kind], signature }, source.path));
        addEdge(edge("contains", fileId, symbolId));
        const bucket = symbolByName.get(name) ?? [];
        bucket.push(symbolId); symbolByName.set(name, bucket);
        functionStack.push(symbolId); pushed = true;
      }
      if (ts.isCallExpression(current)) {
        const callName = ts.isIdentifier(current.expression) ? current.expression.text
          : ts.isPropertyAccessExpression(current.expression) ? current.expression.name.text : undefined;
        if (callName) {
          const caller = functionStack.at(-1) ?? fileId;
          calls.push({ caller, name: callName, file: source.path });
          if (isTestPath(source.path)) testCalls.push({ testPath: source.path, name: callName });
        }
      }
      ts.forEachChild(current, visit);
      if (pushed) functionStack.pop();
    };
    visit(ast);
  }

  for (const call of calls.sort((a, b) => `${a.caller}:${a.name}`.localeCompare(`${b.caller}:${b.name}`))) {
    const matches = symbolByName.get(call.name) ?? [];
    const sameFile = matches.filter((id) => id.startsWith(`symbol:${call.file}#`));
    for (const target of (sameFile.length > 0 ? sameFile : matches).slice(0, 4)) addEdge(edge("calls", call.caller, target, { approximate: true }));
  }
  const functionTests = new Map<string, Set<string>>();
  for (const call of testCalls) for (const symbolId of symbolByName.get(call.name) ?? []) {
    const bucket = functionTests.get(symbolId) ?? new Set<string>(); bucket.add(call.testPath); functionTests.set(symbolId, bucket);
    addEdge(edge("tested-by", symbolId, `file:${call.testPath}`, { approximate: true }));
  }

  const teamId = options.roleContract?.teamId ?? options.teamId;
  if (teamId) {
    const teamNodeId = `team:${teamId}`;
    addNode(node("team", teamNodeId, teamId, options.roleContract ? { agentId: options.roleContract.agentId, role: options.roleContract.role } : {}));
    for (const scope of options.writeScopes ?? options.roleContract?.filesystem.write ?? []) {
      const scopeId = `write-scope:${canonicalProgramKnowledgeHash(scope).slice(0, 16)}`;
      addNode(node("write-scope", scopeId, scope, { scope }));
      addEdge(edge("permits-write", teamNodeId, scopeId));
      for (const source of sources.filter((candidate) => pathMatchesScope(candidate.path, scope))) addEdge(edge("owned-by", `file:${source.path}`, teamNodeId, { scope }));
    }
  }

  const history = [...(options.gitHistory ?? [])].sort((a, b) => a.commit.localeCompare(b.commit));
  for (const record of history.slice(0, limit.maxGitRecords)) {
    const commitId = `commit:${record.commit}`;
    addNode(node("commit", commitId, record.subject ?? record.commit, {
      commit: record.commit, ...(record.author === undefined ? {} : { author: record.author }), ...(record.timestamp === undefined ? {} : { timestamp: record.timestamp }),
    }));
    for (const rawPath of [...record.paths].sort()) {
      let path: string; try { path = normalizeRelativePath(rawPath); } catch { continue; }
      if (knownPaths.has(path)) addEdge(edge("changed-by", `file:${path}`, commitId));
    }
  }

  const sortedNodes = dedupe(nodes, (value) => value.id).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit.maxNodes);
  const nodeIds = new Set(sortedNodes.map((value) => value.id));
  const sortedEdges = dedupe(edges.filter((value) => nodeIds.has(value.from) && nodeIds.has(value.to)), (value) => value.id)
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit.maxEdges);
  const reverseIndex = Object.fromEntries([...functionTests].sort(([a], [b]) => a.localeCompare(b)).map(([id, paths]) => [id, [...paths].sort()]));
  const omitted = {
    files: scanned.omittedFiles,
    directories: scanned.omittedDirectories,
    candidates: scanned.omittedCandidates,
    nodes: droppedNodes + Math.max(0, nodes.length - sortedNodes.length), edges: droppedEdges + Math.max(0, edges.length - sortedEdges.length),
    gitRecords: Math.max(0, history.length - limit.maxGitRecords),
    truncated: scanned.truncated || droppedNodes > 0 || droppedEdges > 0 || history.length > limit.maxGitRecords,
  };
  const scan = { visitedDirectories: scanned.visitedDirectories, candidateFiles: scanned.candidateFiles, scannedBytes: scanned.scannedBytes };
  const base = { version: "program-knowledge-v1" as const, root: "." as const, nodes: sortedNodes, edges: sortedEdges, functionTests: reverseIndex, omitted, scan };
  return { ...base, hash: canonicalProgramKnowledgeHash(base) };
}

function dedupe<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => { const id = key(value); if (seen.has(id)) return false; seen.add(id); return true; });
}

function pathMatchesScope(path: string, rawScope: string): boolean {
  const scope = rawScope.replaceAll("\\", "/").replace(/^workspace\//u, "").replace(/^\.\//u, "");
  const prefix = scope.split(/[*?[{]/u)[0]!.replace(/\/$/u, "");
  return prefix === "" || path === prefix || path.startsWith(`${prefix}/`) || (scope.endsWith("/**") && path.startsWith(prefix));
}

function queryTerms(workOrder: WorkOrder): Set<string> {
  const text = [workOrder.id, workOrder.missionId, workOrder.ownerTeam, workOrder.objective, ...workOrder.requirementIds,
    ...workOrder.constraints, ...workOrder.deliverables, ...workOrder.acceptanceTests, ...workOrder.inputArtifactIds].join(" ").toLowerCase();
  return new Set(text.match(/[a-z0-9_.\/-]{3,}/gu) ?? []);
}

/** Selects a deterministic, bounded relevant subgraph and packages it as one compileContext reference item. */
export function buildProgramContextBundle(
  graph: ProgramKnowledgeGraph,
  workOrder: WorkOrder,
  options: { caps?: Partial<Pick<ProgramKnowledgeCaps, "maxBundleNodes" | "maxBundleEdges" | "maxTraversalDepth">>; priority?: number } = {},
): ProgramContextBundle {
  const limit = caps(options.caps);
  const terms = queryTerms(workOrder);
  const scores = new Map<string, number>();
  for (const candidate of graph.nodes) {
    const haystack = `${candidate.id} ${candidate.label} ${candidate.path ?? ""} ${stableJson(candidate.data)}`.toLowerCase();
    let score = candidate.kind === "entrypoint" ? 15 : candidate.kind === "config" || candidate.kind === "ci" || candidate.kind === "environment" ? 8 : 0;
    for (const term of terms) if (haystack.includes(term)) score += Math.min(20, term.length);
    if (candidate.id === `team:${workOrder.ownerTeam}`) score += 100;
    if (candidate.path && workOrder.toolPolicy.writeScopes.some((scope) => pathMatchesScope(candidate.path!, scope))) score += 40;
    if (score > 0) scores.set(candidate.id, score);
  }
  if (scores.size === 0) {
    for (const candidate of graph.nodes.filter((value) => value.kind === "file").slice(0, Math.min(5, limit.maxBundleNodes))) scores.set(candidate.id, 1);
  }
  const adjacency = new Map<string, Set<string>>();
  for (const connection of graph.edges) {
    const forward = adjacency.get(connection.from) ?? new Set<string>(); forward.add(connection.to); adjacency.set(connection.from, forward);
    const backward = adjacency.get(connection.to) ?? new Set<string>(); backward.add(connection.from); adjacency.set(connection.to, backward);
  }
  let frontier = [...scores.keys()].sort();
  const distance = new Map(frontier.map((id) => [id, 0]));
  for (let depth = 1; depth <= limit.maxTraversalDepth; depth++) {
    const next = new Set<string>();
    for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) if (!distance.has(neighbor)) { distance.set(neighbor, depth); next.add(neighbor); }
    frontier = [...next].sort();
  }
  for (const [id, depth] of distance) scores.set(id, (scores.get(id) ?? 0) + Math.max(1, 5 - depth));
  const selectedIds = new Set([...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit.maxBundleNodes).map(([id]) => id));
  const nodes = graph.nodes.filter((candidate) => selectedIds.has(candidate.id));
  const edges = graph.edges.filter((candidate) => selectedIds.has(candidate.from) && selectedIds.has(candidate.to)).slice(0, limit.maxBundleEdges);
  const functionTests = Object.fromEntries(Object.entries(graph.functionTests).filter(([id]) => selectedIds.has(id)).sort(([a], [b]) => a.localeCompare(b)));
  const omitted = { nodes: Math.max(0, graph.nodes.length - nodes.length), edges: Math.max(0, graph.edges.length - edges.length) };
  const base = { version: "program-context-v1" as const, workOrderId: workOrder.id, graphHash: graph.hash, nodes, edges, functionTests, omitted };
  const hash = canonicalProgramKnowledgeHash(base);
  const content = { ...base, hash };
  return { ...content, contextItem: { id: `program-context:${workOrder.id}:${hash.slice(0, 16)}`, priority: options.priority ?? workOrder.priority, content } };
}

export const buildContextBundle = buildProgramContextBundle;
