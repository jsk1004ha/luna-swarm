import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ExecutionBundleStore, assertNoLinks } from "../registry/bundle-store.js";
import { canonicalEvolutionJson, deepFreezeEvolution, evolutionHash } from "./integrity.js";
import { verifyDecisionTrace } from "./decision-trace.js";
import type { DecisionTrace } from "./types.js";

export class DecisionTraceConflictError extends Error {}
export class DecisionTraceIntegrityError extends Error {}

export class DecisionTraceStore {
  readonly directory: string;
  private readonly boundary: ExecutionBundleStore;

  constructor(workspace: string, directoryName = ".luna-swarm/evolution/traces") {
    this.directory = resolve(workspace, directoryName);
    this.boundary = new ExecutionBundleStore(workspace);
  }

  async init(): Promise<void> {
    await this.boundary.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    await mkdir(this.directory, { recursive: true });
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
  }

  async append(trace: DecisionTrace): Promise<DecisionTrace> {
    if (!verifyDecisionTrace(trace)) throw new DecisionTraceIntegrityError("Decision trace integrity check failed");
    await this.init();
    try {
      await writeFile(this.tracePath(trace.traceId), `${canonicalEvolutionJson(trace)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new DecisionTraceConflictError(`Decision trace already exists: ${trace.traceId}`);
      throw error;
    }
    return trace;
  }

  async read(traceId: string): Promise<DecisionTrace> {
    await this.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    const path = this.tracePath(traceId);
    const trace = JSON.parse(await readRegularTraceFile(path)) as DecisionTrace;
    if (trace.traceId !== traceId || !verifyDecisionTrace(trace)) throw new DecisionTraceIntegrityError("Decision trace integrity check failed");
    return deepFreezeEvolution(trace);
  }

  async list(): Promise<DecisionTrace[]> {
    await this.init();
    await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const names = entries.filter((entry) => {
      if (!entry.name.endsWith(".json")) return false;
      if (!entry.isFile() || entry.isSymbolicLink()) throw new DecisionTraceIntegrityError(`Unsafe decision trace path: ${join(this.directory, entry.name)}`);
      return true;
    }).map((entry) => entry.name).sort();
    const traces = await Promise.all(names.map(async (name) => {
      const path = join(this.directory, name);
      await assertNoLinks(this.boundary.workspaceDirectory, this.directory);
      const trace = JSON.parse(await readRegularTraceFile(path)) as DecisionTrace;
      if (!verifyDecisionTrace(trace) || name !== `${evolutionHash(trace.traceId)}.json`) throw new DecisionTraceIntegrityError("Decision trace integrity check failed");
      return deepFreezeEvolution(trace);
    }));
    return traces.sort((left, right) => left.traceId.localeCompare(right.traceId));
  }

  private tracePath(traceId: string): string { return join(this.directory, `${evolutionHash(traceId)}.json`); }
}

async function readRegularTraceFile(path: string): Promise<string> {
  await assertRegularTraceFile(path);
  const handle = await open(path, "r");
  try {
    const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
    if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || !sameFileIdentity(opened, current)) {
      throw new DecisionTraceIntegrityError(`Unsafe decision trace path: ${path}`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

function sameFileIdentity(opened: import("node:fs").Stats, current: import("node:fs").Stats): boolean {
  return opened.ino === current.ino && (process.platform === "win32" || opened.dev === current.dev);
}

async function assertRegularTraceFile(path: string): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink()) throw new DecisionTraceIntegrityError(`Unsafe decision trace path: ${path}`);
}
