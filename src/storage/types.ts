import type { SwarmConfig } from "../types.js";

export type StorageMaintenancePolicy = SwarmConfig["storageMaintenance"];

export interface StorageManagerOptions {
  workspace: string;
  stateDirectory: string;
  policy: StorageMaintenancePolicy;
  learningHistoryRuns: number;
  now?: () => number;
  pid?: number;
}

export interface StorageCategoryUsage {
  category: string;
  bytes: number;
  files: number;
}

export interface StorageInspection {
  stateRoot: string;
  totalBytes: number;
  totalFiles: number;
  categories: StorageCategoryUsage[];
  rawRuns: { count: number; bytes: number; files: number };
  archives: { count: number; bytes: number; files: number };
  budget: {
    maxStateBytes: number;
    pressure: number;
    overBudget: boolean;
    reclaimTargetBytes: number;
  };
}

export interface ArchiveFileManifest {
  path: string;
  size: number;
  sha256: string;
  mode: number;
}

export interface RunArchiveManifest {
  schemaVersion: 1;
  format: "luna-run-framed-gzip-v1";
  runId: string;
  terminalStatus: "completed" | "partial" | "failed" | "cancelled";
  createdAt: string;
  uncompressedBytes: number;
  fileCount: number;
  files: ArchiveFileManifest[];
}

export type RunMaintenanceDecision =
  | "archive"
  | "active"
  | "protected"
  | "recent"
  | "too-new"
  | "non-terminal"
  | "already-archived"
  | "unsafe";

export interface RunMaintenanceCandidate {
  runId: string;
  decision: RunMaintenanceDecision;
  updatedAt?: string;
  bytes?: number;
  files?: number;
  reason?: string;
}

export interface StorageMaintenancePlan {
  generatedAt: string;
  inspection: StorageInspection;
  protectedRunIds: string[];
  runs: RunMaintenanceCandidate[];
  learningFilesToPrune: string[];
  plannedReclaimBytes: number;
  protectedPressureBytes: number;
}

export interface StorageMaintenanceAction {
  kind: "archive" | "prune-learning" | "recover-quarantine";
  id: string;
  status: "planned" | "applied" | "skipped" | "failed";
  reclaimedBytes: number;
  message: string;
}

export interface StorageMaintenanceReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  before: StorageInspection;
  after: StorageInspection;
  plan: StorageMaintenancePlan;
  actions: StorageMaintenanceAction[];
  reclaimedBytes: number;
}

export interface ArchiveRunResult {
  runId: string;
  archivePath: string;
  manifestPath: string;
  manifest: RunArchiveManifest;
  alreadyArchived: boolean;
  reclaimedBytes: number;
}

export interface RestoreRunResult {
  runId: string;
  runDirectory: string;
  manifest: RunArchiveManifest;
}
