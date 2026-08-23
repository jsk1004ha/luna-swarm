import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g;
const ALLOWED_CYCLES = new Set([
  "src/evolution/evaluator/process-authority.ts|src/evolution/evaluator/protected-runner.ts",
]);

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files.sort();
}

function resolveImport(owner, specifier) {
  const raw = resolve(dirname(owner), specifier);
  const candidates = specifier.endsWith(".js")
    ? [`${raw.slice(0, -3)}.ts`]
    : [`${raw}.ts`, join(raw, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate));
}

function graph() {
  const files = sourceFiles(SRC);
  const known = new Set(files);
  const edges = new Map(files.map((file) => [file, new Set()]));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const dependency = resolveImport(file, match[1]);
      if (dependency && known.has(dependency)) edges.get(file).add(dependency);
    }
  }
  return edges;
}

function stronglyConnectedComponents(edges) {
  let nextIndex = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const lowLink = new Map();
  const components = [];

  function visit(node) {
    index.set(node, nextIndex);
    lowLink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);
    for (const dependency of edges.get(node)) {
      if (!index.has(dependency)) {
        visit(dependency);
        lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(dependency)));
      } else if (onStack.has(dependency)) {
        lowLink.set(node, Math.min(lowLink.get(node), index.get(dependency)));
      }
    }
    if (lowLink.get(node) !== index.get(node)) return;
    const component = [];
    while (stack.length > 0) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component);
  }

  for (const node of edges.keys()) if (!index.has(node)) visit(node);
  return components;
}

function cycleId(component) {
  return component
    .map((file) => relative(ROOT, file).split(sep).join("/"))
    .sort()
    .join("|");
}

const edges = graph();
const cycles = stronglyConnectedComponents(edges)
  .filter((component) => component.length > 1 || edges.get(component[0]).has(component[0]))
  .map(cycleId)
  .sort();
const unexpected = cycles.filter((cycle) => !ALLOWED_CYCLES.has(cycle));
const missingBaseline = [...ALLOWED_CYCLES].filter((cycle) => !cycles.includes(cycle));
if (unexpected.length > 0 || missingBaseline.length > 0) {
  if (unexpected.length > 0) process.stderr.write(`Unexpected import cycles:\n${unexpected.join("\n")}\n`);
  if (missingBaseline.length > 0) {
    process.stderr.write(`Import-cycle baseline changed; remove resolved entries explicitly:\n${missingBaseline.join("\n")}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write(`[import-cycles] ${cycles.length} known cycle(s), 0 new\n`);
}
