#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MockAgentBackend } from "./backend/mock-backend.js";
import { CodexAppServerBackend } from "./backend/codex-app-server.js";
import { AppServerSupervisor } from "./backend/app-server-supervisor.js";
import {
  AppServerClient,
  chatGptOnlyEnvironment,
  locateCodex,
} from "./backend/app-server-client.js";
import type { AgentBackend } from "./backend/agent-backend.js";
import { configTemplate, DEFAULT_CONFIG, loadConfig, validateConfig } from "./config.js";
import { SwarmOrchestrator } from "./orchestrator.js";
import { organizationRows, RANK_LABELS } from "./organization.js";
import { AgentGateway } from "./runtime/gateway.js";
import {
  AtomicRunStore,
  DirectiveGateClosedError,
  DirectiveLimitError,
  RunExecutionLockedError,
  RunIdExistsError,
} from "./store.js";
import {
  createDashboardServer,
  type DashboardCommand,
  type DashboardCommandResult,
} from "./dashboard/server.js";
import type { JsonValue, RunDirective, RunEvent, RunState, SwarmConfig } from "./types.js";
import { HARNESS_POLICY_VERSION, SkillCatalog } from "./capabilities.js";
import { LearningStore } from "./learning.js";
import { LearningPolicyStore } from "./improvement.js";
import {
  AtomicStartGate,
  DurableControlStore,
  ExecutionController,
} from "./controls/index.js";
import { UiRuntimeRegistry, type ManagedRunRuntime } from "./ui-server/runtime-registry.js";
import { UiObservationCoordinator } from "./ui-server/observation-coordinator.js";
import { MockUiRuntime } from "./ui-server/mock-runtime.js";
import {
  reserveUiStartRequest,
  uiStartRequestHash,
  UiRequestConflictError,
} from "./ui-server/request-ledger.js";
import type { UiControlCommand, UiControlResult } from "./ui-server/control-schema.js";
import {
  activatePreparedUiExecution,
  prepareUiExecution,
  UiAutoExecutionError,
  type PreparedUiExecution,
} from "./ui-server/auto-execution.js";
import {
  UiEventHub,
  attachUiEventWebSocketServer,
} from "./ui-events/index.js";
import { HARNESS_V2_ORG_VERSION } from "./harness-v2/contracts.js";
import {
  EVOLUTION_WORKLOAD_CLASSES,
  initializeEvolutionRuntime,
  resolveEvolutionSourceIdentity,
  SourceIdentityUnavailableError,
  verifyRunnableEvolutionBundle,
  type ExplicitSourceIdentity,
  type EvolutionRuntimeFingerprintInput,
} from "./evolution/runtime.js";
import { ExecutionBundleStore } from "./evolution/registry/bundle-store.js";
import { OrganizationGenomeStore } from "./evolution/registry/genome-store.js";
import { GenomeQuarantineStore } from "./evolution/registry/quarantine-store.js";
import { StablePointerStore } from "./evolution/registry/stable-pointer-store.js";
import { PairedEvaluationReceiptStore } from "./evolution/evaluation/receipt.js";
import type { TrustedBenchmarkAuthority } from "./evolution/evaluation/quality-receipt.js";
import type { TrustedProtectedProcessAuthority } from "./evolution/evaluator/index.js";
import { DecisionTraceStore, ObjectiveOutcomeReceiptStore } from "./evolution/trace/index.js";
import { FailureCapsuleStore } from "./evolution/failure/index.js";
import {
  createDeploymentControlPlane,
  ActiveRolloutBindingStore,
  DeploymentRuntimeRouter,
  loadEd25519OperationsReceiptSigner,
  RolloutStore,
  type TrustedRolloutAuthority,
} from "./evolution/deployment/index.js";
import {
  SOAK_SHARD_STAGES,
  runShardSoak,
  shardSoakReportJson,
  type SoakShardStage,
} from "./soak/index.js";
import { RunHostToolRuntime } from "./tool-broker/index.js";
import {
  RunResearchToolRuntime,
  RunSearchDiscoveryToolRuntime,
  createHostControlledLiveSearchDiscoveryProvider,
} from "./research/index.js";
import { RunStorageCollisionError, StorageManager } from "./storage/index.js";
import {
  loadSwarmCodingPolicy,
  parseSwarmCodingPolicy,
  SwarmCodingRuntime,
  type SwarmCodingPolicy,
} from "./coding/swarm-runtime.js";
import { canonicalJson, sha256 } from "./coding/integrity.js";
import { durableCreateText } from "./evolution/registry/durable-file.js";
import {
  VerifiedArtifactCache,
  type VerifiedArtifactCacheKeyInput,
} from "./harness-v2/verified-artifact-cache.js";
import {
  ARTIFACT_RENDERER_IDENTITY,
  ARTIFACT_RENDERER_IDENTITY_HASH,
  ArtifactProductionRuntime,
  loadArtifactProductionPolicy,
  parseArtifactProductionPolicy,
  verifyArtifactProductionPolicyFiles,
  type ArtifactProductionPolicy,
} from "./artifact-production/index.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (command === "init") return initConfig(args);
  if (command === "doctor") return doctor();
  if (command === "org") return printOrganization(args);
  if (command === "skills") return printSkills(args);
  if (command === "learning" || command === "learn") return printLearning(args);
  if (command === "evolve") return evolve(args);
  if (command === "soak") return soak(args);
  if (command === "storage") return storage(args);
  if (command === "cache") return verifiedCache(args);
  if (command === "status") return status(args);
  if (command === "dashboard") return dashboard(args);
  if (command === "ui") return ui(args);
  if (command === "run") return runNew(args);
  if (command === "code") return runCode(args);
  if (command === "artifact") return runArtifact(args);
  if (command === "resume") return resume(args);
  throw new Error(`Unknown command: ${command}`);
}

async function ui(args: string[]): Promise<void> {
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const port = numberOption(args, "--port", 4310, 0, 65_535);
  const host = option(args, "--host") ?? "127.0.0.1";
  const accessToken = option(args, "--token");
  const mock = args.includes("--mock");
  const assetsDirectory = await locateUiAssets();
  const hub = new UiEventHub({ maxEventsPerRun: 10_000 });
  const registry = new UiRuntimeRegistry();
  const mockRuntime = mock ? new MockUiRuntime(hub) : undefined;
  const observer = mock
    ? undefined
    : new UiObservationCoordinator(hub, {
        workspace,
      stateDirectory: config.stateDirectory,
      intervalMs: 750,
      decorateSnapshot: async (snapshot) => {
        const owned = registry.isOwned(snapshot.run.id);
        const control = await registry.status(snapshot.run.id);
        return JSON.parse(JSON.stringify({
          ...snapshot,
          observation: {
            mode: owned ? "owned" : "external-read-only",
            readOnly: !owned,
            source: "state.json+events.jsonl",
          },
          control,
        })) as JsonValue;
      },
    });
  let activeRun: Promise<void> | null = null;
  const startGate = new AtomicStartGate<UiControlResult>();

  const startReservedRun = async (
    command: Extract<UiControlCommand, { action: "start" }>,
    reservedRunId?: string,
  ): Promise<UiControlResult> => {
    const runId = reservedRunId ?? makeRunId();
    const maxConcurrency = command.maxConcurrency ?? config.maxConcurrency;
    const runConfig: SwarmConfig = {
      ...config,
      maxConcurrency,
      initialConcurrency: Math.min(config.initialConcurrency, maxConcurrency),
    };
    validateConfig(runConfig);
    const storage = storageManager(workspace, runConfig);
    try {
      await storage.assertRunIdAvailable(runId);
    } catch (error) {
      if (error instanceof RunStorageCollisionError) {
        return { accepted: false, runId, code: error.code, message: error.message };
      }
      throw error;
    }
    let prepared: Readonly<PreparedUiExecution>;
    try {
      prepared = await prepareUiExecution({
        goal: command.goal,
        workspace,
        runId,
        model: runConfig.model,
      });
    } catch (error) {
      const code = error instanceof UiAutoExecutionError ? error.code : "AUTO_EXECUTION_PREPARE_FAILED";
      return {
        accepted: false,
        runId,
        code,
        message: `자연어 실행 경로를 준비하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const store = new AtomicRunStore(workspace, runConfig.stateDirectory, runId);
    try {
      await store.create();
      await persistUiAutoRunMarkers(store, command.goal, runConfig.model, command.mock === true, prepared);
      await activatePreparedUiExecution(workspace, prepared);
    } catch (error) {
      if (error instanceof RunIdExistsError) {
        return { accepted: false, runId, code: error.code, message: error.message };
      }
      throw error;
    }
    const releaseExecutionLease = await store.acquireExecutionLease();
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolveRuntime, rejectRuntime) => {
      resolveReady = resolveRuntime;
      rejectReady = rejectRuntime;
    });
    let runtimeRegistered = false;
    const execution = launch({
      goal: command.goal,
      workspace,
      config: runConfig,
      store,
      mock: command.mock === true,
      ...(prepared.codingPolicy ? { codingPolicy: prepared.codingPolicy } : {}),
      ...(prepared.artifactPolicy ? { artifactPolicy: prepared.artifactPolicy } : {}),
      releaseExecutionLease,
      onRuntimeReady: async (runtime) => {
        const goalSummary = command.goal.length > 240
          ? `${command.goal.slice(0, 239)}…`
          : command.goal;
        const startEvent = await store.appendEvent({
          eventId: randomUUID(),
          at: new Date().toISOString(),
          runId,
          type: "command_start_accepted",
          status: "accepted",
          message: `운영자가 UI에서 새 실행을 승인했습니다 (${prepared.intent.profile} 자동 분류): ${goalSummary}`,
        });
        printEvent(startEvent);
        registry.register(runtime);
        runtimeRegistered = true;
        resolveReady();
      },
      onRuntimeDisposed: (runtime) => registry.unregister(runtime.runId, runtime),
    });
    activeRun = execution;
    void execution
      .catch((error: unknown) => {
        if (!runtimeRegistered) rejectReady(error);
        process.stderr.write(`[ui-run ${runId}] ${error instanceof Error ? error.message : String(error)}\n`);
      })
      .finally(() => {
        if (activeRun === execution) activeRun = null;
        startGate.release();
        void observer?.poll().catch(() => undefined);
      });
    try {
      await ready;
    } catch (error) {
      return {
        accepted: false,
        runId,
        code: "RUN_START_FAILED",
        message: `실행을 준비하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      accepted: true,
      runId,
      message: command.mock
        ? "Mock Luna 실행을 시작했습니다."
        : `Luna 실행을 시작했습니다. 자연어 실행 유형: ${uiExecutionProfileLabel(prepared.intent.profile)}.`,
    };
  };
  const startRun = (
    command: Extract<UiControlCommand, { action: "start" }>,
  ): Promise<UiControlResult> => {
    const maxConcurrency = command.maxConcurrency ?? config.maxConcurrency;
    const requestHash = uiStartRequestHash({
      goal: command.goal,
      mock: command.mock === true,
      maxConcurrency,
      model: config.model,
    });
    const reserve = async (): Promise<UiControlResult> => {
      let runId: string | undefined;
      if (command.requestId) {
        try {
          const reservation = await reserveUiStartRequest({
            workspace,
            requestId: command.requestId,
            requestHash,
            proposedRunId: makeRunId(),
          });
          runId = reservation.record.runId;
          if (reservation.replay) {
            const replayStore = new AtomicRunStore(workspace, config.stateDirectory, runId);
            try {
              await access(replayStore.runDirectory);
              return {
                accepted: true,
                runId,
                code: "REQUEST_REPLAY",
                message: "동일한 시작 요청의 기존 Luna 실행을 반환했습니다.",
              };
            } catch {
              // A durable reservation without a run directory is a recoverable
              // pre-start crash; continue with the original runId.
            }
          }
        } catch (error) {
          if (error instanceof UiRequestConflictError) {
            return { accepted: false, code: error.code, message: error.message };
          }
          throw error;
        }
      }
      return startReservedRun(command, runId);
    };
    return startGate.start(
      command.requestId,
      () => ({
        accepted: false,
        code: "RUN_ALREADY_ACTIVE",
        message: "이 UI 서버가 이미 실행 하나를 소유하고 있습니다.",
      }),
      reserve,
      requestHash,
      () => ({
        accepted: false,
        code: "IDEMPOTENCY_CONFLICT",
        message: "같은 requestId가 다른 UI 시작 요청에 이미 사용되었습니다.",
      }),
    );
  };

  const recoverRun = (runId: string): Promise<UiControlResult> => startGate.start(
    undefined,
    () => ({
      accepted: false,
      runId,
      code: "RUN_ALREADY_ACTIVE",
      message: "이 UI 서버가 이미 실행 하나를 소유하고 있습니다.",
    }),
    async () => {
      let restored: Readonly<ResumeContext>;
      try {
        restored = await loadResumeContext(workspace, config.stateDirectory, runId);
      } catch (error) {
        return {
          accepted: false,
          runId,
          code: "RUN_RECOVERY_REJECTED",
          message: `실행을 안전하게 복구하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!restored.autoSnapshot) {
        return {
          accepted: false,
          runId,
          code: "EXTERNAL_READ_ONLY",
          message: "Web UI 자동 실행 marker가 없는 실행은 이 UI에서 인수할 수 없습니다.",
        };
      }
      if (!await isStaleRun(restored.state, restored.store)) {
        return {
          accepted: false,
          runId,
          code: "RUN_STILL_ACTIVE",
          message: "이 실행은 아직 최신 heartbeat를 가지고 있어 인수할 수 없습니다.",
        };
      }
      let releaseExecutionLease: () => Promise<void>;
      try {
        releaseExecutionLease = await restored.store.acquireExecutionLease();
      } catch (error) {
        if (error instanceof RunExecutionLockedError) {
          return { accepted: false, runId, code: "RUN_EXECUTION_LOCKED", message: error.message };
        }
        throw error;
      }
      let resolveReady!: () => void;
      let rejectReady!: (error: unknown) => void;
      const ready = new Promise<void>((resolveRuntime, rejectRuntime) => {
        resolveReady = resolveRuntime;
        rejectReady = rejectRuntime;
      });
      let runtimeRegistered = false;
      const execution = launch({
        goal: restored.state.goal,
        workspace,
        config: restored.config,
        store: restored.store,
        mock: restored.autoSnapshot.mock === true,
        loaded: restored.state,
        releaseExecutionLease,
        ...(restored.codingSnapshot ? { codingPolicy: restored.codingSnapshot.policy, allowPreparedCodingRecovery: true } : {}),
        ...(restored.artifactSnapshot ? { artifactPolicy: restored.artifactSnapshot.policy } : {}),
        onRuntimeReady: (runtime) => {
          registry.register(runtime);
          runtimeRegistered = true;
          resolveReady();
        },
        onRuntimeDisposed: (runtime) => registry.unregister(runtime.runId, runtime),
      });
      activeRun = execution;
      void execution
        .catch((error: unknown) => {
          if (!runtimeRegistered) rejectReady(error);
          process.stderr.write(`[ui-recover ${runId}] ${error instanceof Error ? error.message : String(error)}\n`);
        })
        .finally(() => {
          if (activeRun === execution) activeRun = null;
          startGate.release();
          void observer?.poll().catch(() => undefined);
        });
      try {
        await ready;
      } catch (error) {
        return {
          accepted: false,
          runId,
          code: "RUN_RECOVERY_FAILED",
          message: `실행 복구를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      return { accepted: true, runId, message: "중단된 Web UI 자동 실행을 immutable marker에서 복구했습니다." };
    },
  );

  const server = createDashboardServer({
    workspace,
    stateDirectory: config.stateDirectory,
    port,
    host,
    assetsDirectory,
    demo: mock,
    ...(accessToken ? { accessToken } : {}),
    isRunOwned: (runId) => mock ? runId === "demo-company" : registry.isOwned(runId),
    getUiControlState: async (runId) => mockRuntime?.status() ?? registry.status(runId),
    ...(mockRuntime
      ? {
          listUiRuns: async () => mockRuntime.runs(),
          getUiSnapshot: async () => mockRuntime.snapshot(),
        }
      : {}),
    onUiControl: async (command) => {
      if (mockRuntime) {
        if (command.action === "start") {
          return startGate.start(
            command.requestId,
            () => ({
              accepted: false,
              code: "RUN_ALREADY_ACTIVE",
              message: "이 UI 서버가 이미 실행 하나를 소유하고 있습니다.",
            }),
            () => mockRuntime.control(command),
          );
        }
        const result = await mockRuntime.control(command);
        if (command.action === "cancel" && result.accepted) startGate.release();
        return result;
      }
      if (command.action === "start") return startRun(command);
      if (command.action === "recover") return recoverRun(command.runId);
      return registry.control(command);
    },
  });
  const webSockets = attachUiEventWebSocketServer(server.server, hub, {
    requireLoopback: isLoopbackBind(host),
    requireSameOrigin: true,
    ...(accessToken ? { token: accessToken } : {}),
  });
  if (mockRuntime) mockRuntime.start();
  else {
    await observer!.poll();
    observer!.start();
  }
  const address = await server.listen();
  process.stdout.write(
    `Luna Swarm UI: ${address.url}\n작업공간: ${workspace}\n모드: ${mock ? "DEMO" : "REAL"}\nWebSocket replay: 활성화\n종료: Ctrl-C\n`,
  );
  if (args.includes("--open")) await openDashboard(address.url);

  await new Promise<void>((resolveShutdown) => {
    const stop = (): void => resolveShutdown();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  mockRuntime?.stop();
  observer?.stop();
  webSockets.close();
  await server.close();
  if (activeRun) await activeRun;
}

async function dashboard(args: string[]): Promise<void> {
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const port = numberOption(args, "--port", 4310, 0, 65_535);
  const host = option(args, "--host") ?? "127.0.0.1";
  const assetsDirectory = await locateDashboardAssets();
  let activeRun: Promise<void> | null = null;
  const startGate = new AtomicStartGate<DashboardCommandResult>();

  const server = createDashboardServer({
    workspace,
    stateDirectory: config.stateDirectory,
    port,
    host,
    assetsDirectory,
    onCommand: async (command) => {
      if (command.action === "intervene") {
        return queueDashboardDirective(workspace, config.stateDirectory, command);
      }
      return startGate.start(
        command.requestId,
        () => ({ accepted: false, message: "A dashboard-started run is already active" }),
        async () => {
        if (command.action === "resume") {
        if (!command.runId) {
          return { accepted: false, message: "A run id is required" };
        }
        const store = new AtomicRunStore(workspace, config.stateDirectory, command.runId);
        const state = await store.load();
        if (["completed", "partial", "failed", "cancelled"].includes(state.status)) {
          return {
            accepted: false,
            runId: command.runId,
            message: `Run ${command.runId} is already ${state.status}`,
          };
        }
        if (!await isStaleRun(state, store)) {
          return {
            accepted: false,
            runId: command.runId,
            message: `Run ${command.runId} still has a recent heartbeat`,
          };
        }
        const runConfig: SwarmConfig = {
          ...DEFAULT_CONFIG,
          ...state.config,
          storageMaintenance: {
            ...DEFAULT_CONFIG.storageMaintenance,
            ...(state.config.storageMaintenance ?? {}),
          },
          webResearch: {
            ...DEFAULT_CONFIG.webResearch,
            ...(state.config.webResearch ?? {}),
          },
          skillPortfolio: {
            ...DEFAULT_CONFIG.skillPortfolio,
            ...(state.config.skillPortfolio ?? {}),
          },
          reasoning: {
            ...DEFAULT_CONFIG.reasoning,
            ...state.config.reasoning,
          },
        };
        validateConfig(runConfig);
        let releaseExecutionLease: () => Promise<void>;
        try {
          releaseExecutionLease = await store.acquireExecutionLease();
        } catch (error) {
          if (error instanceof RunExecutionLockedError) {
            return {
              accepted: false,
              runId: command.runId,
              message: error.message,
            };
          }
          throw error;
        }
        const execution = launch({
          goal: state.goal,
          workspace,
          config: runConfig,
          store,
          mock: command.mock,
          loaded: state,
          releaseExecutionLease,
        });
        activeRun = execution;
        void execution
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`dashboard resume ${command.runId}: ${message}\n`);
          })
          .finally(() => {
            if (activeRun === execution) activeRun = null;
            startGate.release();
          });
        return {
          accepted: true,
          runId: command.runId,
          message: "Luna run resumed",
        };
      }
      const runId = makeRunId();
      const maxConcurrency = command.maxConcurrency ?? config.maxConcurrency;
      const runConfig: SwarmConfig = {
        ...config,
        maxConcurrency,
        initialConcurrency: Math.min(config.initialConcurrency, maxConcurrency),
      };
      validateConfig(runConfig);
      const storage = storageManager(workspace, runConfig);
      try {
        await storage.assertRunIdAvailable(runId);
      } catch (error) {
        if (error instanceof RunStorageCollisionError) {
          return { accepted: false, runId, message: error.message };
        }
        throw error;
      }
      const store = new AtomicRunStore(workspace, runConfig.stateDirectory, runId);
      try {
        await store.create();
      } catch (error) {
        if (error instanceof RunIdExistsError) {
          return { accepted: false, runId, message: error.message };
        }
        throw error;
      }
      const releaseExecutionLease = await store.acquireExecutionLease();
      const execution = launch({
        goal: command.text ?? "",
        workspace,
        config: runConfig,
        store,
        mock: command.mock,
        releaseExecutionLease,
      });
      activeRun = execution;
      void execution
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          process.stderr.write(`dashboard run ${runId}: ${message}\n`);
        })
        .finally(() => {
          if (activeRun === execution) activeRun = null;
          startGate.release();
        });
      return {
        accepted: true,
        runId,
        message: command.mock ? "Mock run started" : "Luna run started",
      };
      },
      );
    },
  });
  const address = await server.listen();
  process.stdout.write(
    `Luna HQ 대시보드: ${address.url}\n작업공간: ${workspace}\n회장 명령석: 활성화\n종료: Ctrl-C\n`,
  );
  if (args.includes("--open")) await openDashboard(address.url);

  await new Promise<void>((resolveShutdown) => {
    const stop = (): void => resolveShutdown();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await server.close();
}

async function queueDashboardDirective(
  workspace: string,
  stateDirectory: string,
  command: DashboardCommand,
): Promise<{ accepted: boolean; message: string; runId?: string }> {
  if (!command.runId) return { accepted: false, message: "A run id is required" };
  const store = new AtomicRunStore(workspace, stateDirectory, command.runId);
  const state = await store.load();
  if (["completed", "partial", "failed", "cancelled"].includes(state.status)) {
    return {
      accepted: false,
      runId: command.runId,
      message: `Run ${command.runId} is already ${state.status}`,
    };
  }
  if (await isStaleRun(state, store)) {
    return {
      accepted: false,
      runId: command.runId,
      message: `Run ${command.runId} is stale and must be resumed before it can accept directives`,
    };
  }
  const directive: RunDirective = {
    id: `directive-${command.requestId ?? randomUUID()}`,
    at: new Date().toISOString(),
    runId: command.runId,
    text: command.text ?? "",
    source: "dashboard",
    scope: "all",
  };
  try {
    await store.appendDirective(directive);
  } catch (error) {
    if (error instanceof DirectiveGateClosedError) {
      return {
        accepted: false,
        runId: command.runId,
        message: `Run ${command.runId} is finalizing and no longer accepts directives`,
      };
    }
    if (error instanceof DirectiveLimitError) {
      return {
        accepted: false,
        runId: command.runId,
        message: `Run ${command.runId} reached the directive limit`,
      };
    }
    throw error;
  }
  return {
    accepted: true,
    runId: command.runId,
    message: "Directive queued for the next safe checkpoint",
  };
}

async function isStaleRun(
  state: RunState,
  store: AtomicRunStore,
  now = Date.now(),
): Promise<boolean> {
  if (["completed", "partial", "failed", "cancelled"].includes(state.status)) return false;
  if (state.status === "interrupted") return true;
  const stateUpdatedAt = Date.parse(state.updatedAt);
  let eventUpdatedAt = Number.NEGATIVE_INFINITY;
  try {
    eventUpdatedAt = (await stat(store.eventsPath)).mtimeMs;
  } catch {
    // A run can be stale before its first event file is created.
  }
  const updatedAt = Math.max(
    Number.isFinite(stateUpdatedAt) ? stateUpdatedAt : Number.NEGATIVE_INFINITY,
    eventUpdatedAt,
  );
  if (!Number.isFinite(updatedAt)) return true;
  const staleAfterMs = Math.max(120_000, state.config.callTimeoutMs + 60_000);
  return now - updatedAt > staleAfterMs;
}

async function locateDashboardAssets(): Promise<string> {
  const entryDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "web"),
    resolve(entryDirectory, "../web"),
    resolve(entryDirectory, "../../web"),
  ];
  for (const candidate of candidates) {
    try {
      await access(resolve(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next development or compiled layout candidate.
    }
  }
  throw new Error("Dashboard assets were not found. Expected web/index.html.");
}

async function locateUiAssets(): Promise<string> {
  const entryDirectory = dirname(fileURLToPath(import.meta.url));
  const requiredAssets = ["index.html"];
  const candidates = [
    resolve(process.cwd(), "ui/dist"),
    resolve(entryDirectory, "../ui/dist"),
    resolve(entryDirectory, "../../ui/dist"),
  ];
  for (const candidate of candidates) {
    try {
      await Promise.all(requiredAssets.map((asset) => access(resolve(candidate, asset))));
      return candidate;
    } catch {
      // Try source and compiled layouts before explaining the required build.
    }
  }
  throw new Error(`React UI build is incomplete. Run \`npm run build:ui\` and verify: ${requiredAssets.join(", ")}`);
}

function isLoopbackBind(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

async function openDashboard(url: string): Promise<void> {
  if (process.platform === "win32") {
    await execFileAsync("rundll32", ["url.dll,FileProtocolHandler", url]);
    return;
  }
  await execFileAsync(process.platform === "darwin" ? "open" : "xdg-open", [url]);
}

async function runNew(args: string[]): Promise<void> {
  const goal = option(args, "--goal") ?? positional(args)[0];
  if (!goal) throw new Error("Provide a goal with --goal \"...\"");
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const overrides = concurrencyOverrides(args);
  const config = await loadConfig(option(args, "--config"), overrides);
  const runId = option(args, "--run-id") ?? makeRunId();
  const storage = storageManager(workspace, config);
  await storage.assertRunIdAvailable(runId);
  const store = new AtomicRunStore(workspace, config.stateDirectory, runId);
  await store.create();
  await launch({ goal, workspace, config, store, mock: args.includes("--mock") });
}

interface CodingRunMarkerV3 {
  schemaVersion: 3;
  command: "code";
  model: "gpt-5.6-luna";
  policyHash: `sha256:${string}`;
  strategyHash: `sha256:${string}`;
  policy: Readonly<SwarmCodingPolicy>;
}

function codingRunMarker(policy: Readonly<SwarmCodingPolicy>): Readonly<CodingRunMarkerV3> {
  return Object.freeze({
    schemaVersion: 3,
    command: "code",
    model: "gpt-5.6-luna",
    policyHash: `sha256:${sha256(canonicalJson(policy))}`,
    strategyHash: `sha256:${sha256(canonicalJson(policy.strategy))}`,
    policy,
  });
}

interface CodingRunSnapshot {
  policy: Readonly<SwarmCodingPolicy>;
  model: "gpt-5.6-luna";
}

async function readCodingRunPolicy(path: string): Promise<Readonly<CodingRunSnapshot>> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) {
    throw new Error("Coding run marker must be a bounded regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Coding run marker is unreadable: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Coding run marker schema is invalid");
  }
  const marker = value as Record<string, unknown>;
  if ((marker.schemaVersion !== 2 && marker.schemaVersion !== 3) || marker.command !== "code") {
    throw new Error(
      "Legacy coding run has no immutable policy snapshot and cannot be resumed safely",
    );
  }
  const keys = Object.keys(marker).sort().join(",");
  const legacy = marker.schemaVersion === 2;
  if ((legacy && keys !== "command,policy,policyHash,schemaVersion") ||
      (!legacy && keys !== "command,model,policy,policyHash,schemaVersion,strategyHash") ||
      typeof marker.policyHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.policyHash) ||
      (!legacy && (marker.model !== "gpt-5.6-luna" || typeof marker.strategyHash !== "string" ||
        !/^sha256:[a-f0-9]{64}$/u.test(marker.strategyHash)))) {
    throw new Error("Coding run marker schema is invalid");
  }
  const expectedHash = `sha256:${sha256(canonicalJson(marker.policy))}`;
  if (marker.policyHash !== expectedHash) {
    throw new Error("Coding run policy snapshot hash does not match its marker");
  }
  const policy = parseSwarmCodingPolicy(marker.policy);
  if (!legacy && marker.strategyHash !== `sha256:${sha256(canonicalJson(policy.strategy))}`) {
    throw new Error("Coding run strategy snapshot hash does not match its marker");
  }
  return Object.freeze({ policy, model: "gpt-5.6-luna" });
}

async function runCode(args: string[]): Promise<void> {
  const goal = option(args, "--goal") ?? positional(args)[0];
  if (!goal) throw new Error("Provide a coding goal with --goal \"...\"");
  const policyPath = option(args, "--coding-policy");
  if (!policyPath) {
    throw new Error("Usage: luna-swarm code --goal \"작업\" --coding-policy <policy.json> [--workspace .]");
  }
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const overrides = concurrencyOverrides(args);
  const config = await loadConfig(option(args, "--config"), overrides);
  if (config.model !== "gpt-5.6-luna") {
    throw new Error("Luna Swarm coding strategies require config.model to be exactly gpt-5.6-luna");
  }
  const codingPolicy = await loadSwarmCodingPolicy(resolve(workspace, policyPath), workspace);
  const runId = option(args, "--run-id") ?? makeRunId();
  const storage = storageManager(workspace, config);
  await storage.assertRunIdAvailable(runId);
  const store = new AtomicRunStore(workspace, config.stateDirectory, runId);
  await store.create();
  await durableCreateText(
    resolve(store.runDirectory, "coding-run.json"),
    `${canonicalJson(codingRunMarker(codingPolicy))}\n`,
  );
  await launch({
    goal,
    workspace,
    config,
    store,
    mock: args.includes("--mock"),
    codingPolicy,
  });
}

interface ArtifactRunMarkerV1 {
  schemaVersion: 1;
  command: "artifact";
  model: "gpt-5.6-luna";
  policyHash: `sha256:${string}`;
  rendererIdentity: typeof ARTIFACT_RENDERER_IDENTITY;
  rendererIdentityHash: `sha256:${string}`;
  policy: Readonly<ArtifactProductionPolicy>;
}

interface ArtifactRunKindV1 {
  schemaVersion: 1;
  command: "artifact";
  markerFile: "artifact-run.json";
  markerHash: `sha256:${string}`;
}

interface UiAutoRunKindV2 {
  schemaVersion: 2;
  command: "ui-auto";
  markerFile: "auto-run.json";
  markerHash: `sha256:${string}`;
  expectedMarkers: readonly ("coding-run.json" | "artifact-run.json")[];
}

type RunKindAnchor = ArtifactRunKindV1 | UiAutoRunKindV2;

interface ArtifactRunSnapshot {
  policy: Readonly<ArtifactProductionPolicy>;
  model: "gpt-5.6-luna";
}

function artifactRunMarker(policy: Readonly<ArtifactProductionPolicy>): Readonly<ArtifactRunMarkerV1> {
  return Object.freeze({
    schemaVersion: 1,
    command: "artifact",
    model: "gpt-5.6-luna",
    policyHash: `sha256:${sha256(canonicalJson(policy))}`,
    rendererIdentity: ARTIFACT_RENDERER_IDENTITY,
    rendererIdentityHash: `sha256:${ARTIFACT_RENDERER_IDENTITY_HASH}`,
    policy,
  });
}

interface UiAutoRunMarkerV1 {
  schemaVersion: 1 | 2;
  command: "ui-auto";
  classifierVersion: "semantic-capability-v1";
  profile: "standard" | "coding" | "artifact" | "combined";
  goalHash: `sha256:${string}`;
  model: string;
  codingPolicyHash: `sha256:${string}` | null;
  artifactPolicyHash: `sha256:${string}` | null;
  policySources: Readonly<{ coding?: "workspace" | "automatic"; artifact?: "workspace" | "automatic" }>;
  mock?: boolean;
}

async function persistUiAutoRunMarkers(
  store: AtomicRunStore,
  goal: string,
  model: string,
  mock: boolean,
  prepared: Readonly<PreparedUiExecution>,
): Promise<void> {
  if (prepared.codingPolicy) {
    await durableCreateText(
      resolve(store.runDirectory, "coding-run.json"),
      `${canonicalJson(codingRunMarker(prepared.codingPolicy))}\n`,
    );
  }
  if (prepared.artifactPolicy) {
    const marker = artifactRunMarker(prepared.artifactPolicy);
    await durableCreateText(
      resolve(store.runDirectory, "artifact-run.json"),
      `${canonicalJson(marker)}\n`,
    );
  }
  const autoMarker: UiAutoRunMarkerV1 = {
    schemaVersion: 2,
    command: "ui-auto",
    classifierVersion: "semantic-capability-v1",
    profile: prepared.intent.profile,
    goalHash: `sha256:${sha256(goal.normalize("NFKC"))}`,
    model,
    codingPolicyHash: prepared.codingPolicy
      ? `sha256:${sha256(canonicalJson(prepared.codingPolicy))}`
      : null,
    artifactPolicyHash: prepared.artifactPolicy
      ? `sha256:${sha256(canonicalJson(prepared.artifactPolicy))}`
      : null,
    policySources: prepared.policySources,
    mock,
  };
  const autoText = canonicalJson(autoMarker);
  await durableCreateText(
    resolve(store.runDirectory, "auto-run.json"),
    `${autoText}\n`,
  );
  const expectedMarkers: UiAutoRunKindV2["expectedMarkers"] = Object.freeze([
    ...(prepared.codingPolicy ? ["coding-run.json" as const] : []),
    ...(prepared.artifactPolicy ? ["artifact-run.json" as const] : []),
  ]);
  const runKind: UiAutoRunKindV2 = {
    schemaVersion: 2,
    command: "ui-auto",
    markerFile: "auto-run.json",
    markerHash: `sha256:${sha256(autoText)}`,
    expectedMarkers,
  };
  await durableCreateText(
    resolve(store.runDirectory, "run-kind.json"),
    `${canonicalJson(runKind)}\n`,
  );
}

function uiExecutionProfileLabel(profile: PreparedUiExecution["intent"]["profile"]): string {
  if (profile === "coding") return "코딩";
  if (profile === "artifact") return "파일 제작";
  if (profile === "combined") return "코딩 + 파일 제작";
  return "분석·조사";
}

async function readBoundedRunMarker(path: string, maxBytes: number, label: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`${label} must be a bounded regular non-linked file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes) {
      throw new Error(`${label} changed or is unsafe`);
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ino !== after.ino || opened.dev !== after.dev) {
      throw new Error(`${label} changed while reading`);
    }
    return text;
  } finally {
    await handle.close();
  }
}

async function readUiAutoRunMarker(
  path: string,
  expectedMarkerHash?: string,
): Promise<Readonly<UiAutoRunMarkerV1> | undefined> {
  let text: string;
  try {
    text = await readBoundedRunMarker(path, 64 * 1024, "UI auto-run marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`UI auto-run marker is unreadable: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("UI auto-run marker schema is invalid");
  }
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort().join(",");
  const v1Keys = "artifactPolicyHash,classifierVersion,codingPolicyHash,command,goalHash,model,policySources,profile,schemaVersion";
  const v2Keys = "artifactPolicyHash,classifierVersion,codingPolicyHash,command,goalHash,mock,model,policySources,profile,schemaVersion";
  if (
    !((marker.schemaVersion === 1 && keys === v1Keys) || (marker.schemaVersion === 2 && keys === v2Keys)) ||
    marker.command !== "ui-auto" ||
    marker.classifierVersion !== "semantic-capability-v1" ||
    !["standard", "coding", "artifact", "combined"].includes(String(marker.profile)) ||
    typeof marker.goalHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.goalHash) ||
    typeof marker.model !== "string" || marker.model.length === 0 || marker.model.length > 128 ||
    !nullableHash(marker.codingPolicyHash) || !nullableHash(marker.artifactPolicyHash) ||
    !validUiPolicySources(marker.policySources) ||
    (marker.schemaVersion === 2 && typeof marker.mock !== "boolean")
  ) {
    throw new Error("UI auto-run marker schema is invalid");
  }
  if (expectedMarkerHash && expectedMarkerHash !== `sha256:${sha256(canonicalJson(value))}`) {
    throw new Error("UI auto-run marker hash does not match its run-kind anchor");
  }
  return marker as unknown as Readonly<UiAutoRunMarkerV1>;
}

function nullableHash(value: unknown): boolean {
  return value === null || (typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function validUiPolicySources(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "coding" && key !== "artifact")) return false;
  return Object.values(record).every((source) => source === "workspace" || source === "automatic");
}

async function readArtifactRunPolicy(
  path: string,
  workspace: string,
  expectedMarkerHash?: string,
): Promise<Readonly<ArtifactRunSnapshot>> {
  let text: string;
  try {
    text = await readBoundedRunMarker(path, 1024 * 1024, "Artifact run marker");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new Error(`Artifact run marker is unreadable: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Artifact run marker is unreadable: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Artifact run marker schema is invalid");
  }
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort().join(",");
  if (
    keys !== "command,model,policy,policyHash,rendererIdentity,rendererIdentityHash,schemaVersion" ||
    marker.schemaVersion !== 1 || marker.command !== "artifact" || marker.model !== "gpt-5.6-luna" ||
    typeof marker.policyHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.policyHash) ||
    marker.rendererIdentityHash !== `sha256:${ARTIFACT_RENDERER_IDENTITY_HASH}` ||
    canonicalJson(marker.rendererIdentity) !== canonicalJson(ARTIFACT_RENDERER_IDENTITY)
  ) {
    throw new Error("Artifact run marker schema or renderer identity is invalid");
  }
  if (expectedMarkerHash && expectedMarkerHash !== `sha256:${sha256(canonicalJson(value))}`) {
    throw new Error("Artifact run marker hash does not match its run-kind anchor");
  }
  const expectedPolicyHash = `sha256:${sha256(canonicalJson(marker.policy))}`;
  if (marker.policyHash !== expectedPolicyHash) {
    throw new Error("Artifact run policy snapshot hash does not match its marker");
  }
  const policy = parseArtifactProductionPolicy(marker.policy);
  await verifyArtifactProductionPolicyFiles(policy, workspace);
  return Object.freeze({ policy, model: "gpt-5.6-luna" });
}

async function readArtifactRunKind(path: string): Promise<Readonly<RunKindAnchor> | undefined> {
  let text: string;
  try {
    text = await readBoundedRunMarker(path, 4096, "Run-kind anchor");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Run-kind anchor is unreadable: ${(error as Error).message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run-kind anchor schema is invalid");
  const marker = value as Record<string, unknown>;
  if (marker.schemaVersion === 2 && marker.command === "ui-auto") {
    if (
      Object.keys(marker).sort().join(",") !== "command,expectedMarkers,markerFile,markerHash,schemaVersion" ||
      marker.markerFile !== "auto-run.json" ||
      typeof marker.markerHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.markerHash) ||
      !Array.isArray(marker.expectedMarkers) || marker.expectedMarkers.length > 2 ||
      marker.expectedMarkers.some((entry) => entry !== "coding-run.json" && entry !== "artifact-run.json") ||
      new Set(marker.expectedMarkers).size !== marker.expectedMarkers.length
    ) throw new Error("Run-kind anchor schema is invalid");
    return marker as unknown as Readonly<UiAutoRunKindV2>;
  }
  if (
    Object.keys(marker).sort().join(",") !== "command,markerFile,markerHash,schemaVersion" ||
    marker.schemaVersion !== 1 || marker.command !== "artifact" || marker.markerFile !== "artifact-run.json" ||
    typeof marker.markerHash !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.markerHash)
  ) throw new Error("Run-kind anchor schema is invalid");
  return marker as unknown as Readonly<ArtifactRunKindV1>;
}

async function runArtifact(args: string[]): Promise<void> {
  const goal = option(args, "--goal") ?? positional(args)[0];
  if (!goal) throw new Error("Provide an artifact production goal with --goal \"...\"");
  const policyPath = option(args, "--artifact-policy");
  if (!policyPath) {
    throw new Error("Usage: luna-swarm artifact --goal \"작업\" --artifact-policy <policy.json> [--workspace .]");
  }
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"), concurrencyOverrides(args));
  if (config.model !== "gpt-5.6-luna") {
    throw new Error("Luna Swarm artifact production requires config.model to be exactly gpt-5.6-luna");
  }
  const artifactPolicy = await loadArtifactProductionPolicy(policyPath, workspace);
  const runId = option(args, "--run-id") ?? makeRunId();
  const storage = storageManager(workspace, config);
  await storage.assertRunIdAvailable(runId);
  const store = new AtomicRunStore(workspace, config.stateDirectory, runId);
  await store.create();
  const marker = artifactRunMarker(artifactPolicy);
  const markerText = `${canonicalJson(marker)}\n`;
  const runKind: ArtifactRunKindV1 = {
    schemaVersion: 1,
    command: "artifact",
    markerFile: "artifact-run.json",
    markerHash: `sha256:${sha256(canonicalJson(marker))}`,
  };
  await durableCreateText(resolve(store.runDirectory, "run-kind.json"), `${canonicalJson(runKind)}\n`);
  await durableCreateText(resolve(store.runDirectory, "artifact-run.json"), markerText);
  await launch({
    goal,
    workspace,
    config,
    store,
    mock: args.includes("--mock"),
    artifactPolicy,
  });
}

async function resume(args: string[]): Promise<void> {
  const runId = positional(args)[0];
  if (!runId) throw new Error("Usage: luna-swarm resume <run-id>");
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const bootstrap = await loadConfig(option(args, "--config"), concurrencyOverrides(args));
  const restored = await loadResumeContext(workspace, bootstrap.stateDirectory, runId, concurrencyOverrides(args));
  await launch({
    goal: restored.state.goal,
    workspace,
    config: restored.config,
    store: restored.store,
    mock: args.includes("--mock"),
    loaded: restored.state,
    ...(restored.codingSnapshot ? { codingPolicy: restored.codingSnapshot.policy, allowPreparedCodingRecovery: true } : {}),
    ...(restored.artifactSnapshot ? { artifactPolicy: restored.artifactSnapshot.policy } : {}),
  });
}

interface ResumeContext {
  store: AtomicRunStore;
  state: RunState;
  config: SwarmConfig;
  codingSnapshot?: Readonly<CodingRunSnapshot>;
  artifactSnapshot?: Readonly<ArtifactRunSnapshot>;
  autoSnapshot?: Readonly<UiAutoRunMarkerV1>;
}

async function loadResumeContext(
  workspace: string,
  stateDirectory: string,
  runId: string,
  overrides: Partial<SwarmConfig> = {},
): Promise<Readonly<ResumeContext>> {
  const store = new AtomicRunStore(workspace, stateDirectory, runId);
  let codingSnapshot: Readonly<CodingRunSnapshot> | undefined;
  let artifactSnapshot: Readonly<ArtifactRunSnapshot> | undefined;
  const runKind = await readArtifactRunKind(resolve(store.runDirectory, "run-kind.json"));
  const autoSnapshot = await readUiAutoRunMarker(
    resolve(store.runDirectory, "auto-run.json"),
    runKind?.command === "ui-auto" ? runKind.markerHash : undefined,
  );
  if (runKind?.command === "ui-auto" && !autoSnapshot) {
    throw new Error("UI auto-run marker is missing; the run cannot be resumed safely");
  }
  try {
    codingSnapshot = await readCodingRunPolicy(resolve(store.runDirectory, "coding-run.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    artifactSnapshot = await readArtifactRunPolicy(
      resolve(store.runDirectory, "artifact-run.json"),
      workspace,
      runKind?.command === "artifact" ? runKind.markerHash : undefined,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (runKind?.command === "artifact" ||
        (runKind?.command === "ui-auto" && runKind.expectedMarkers.includes("artifact-run.json"))) {
      throw new Error("Artifact run marker is missing; the run cannot be resumed safely");
    }
  }
  if (runKind?.command === "artifact" && !artifactSnapshot) {
    throw new Error("Run-kind anchor requires an artifact production marker");
  }
  if (runKind?.command === "ui-auto") {
    const hasCoding = codingSnapshot !== undefined;
    const hasArtifact = artifactSnapshot !== undefined;
    if (runKind.expectedMarkers.includes("coding-run.json") !== hasCoding ||
        runKind.expectedMarkers.includes("artifact-run.json") !== hasArtifact) {
      throw new Error("UI auto-run required marker set does not match its run-kind anchor");
    }
  }
  if (autoSnapshot) {
    const codingHash = codingSnapshot
      ? `sha256:${sha256(canonicalJson(codingSnapshot.policy))}`
      : null;
    const artifactHash = artifactSnapshot
      ? `sha256:${sha256(canonicalJson(artifactSnapshot.policy))}`
      : null;
    if (autoSnapshot.codingPolicyHash !== codingHash || autoSnapshot.artifactPolicyHash !== artifactHash) {
      throw new Error("UI auto-run policy markers do not match their immutable profile");
    }
    const expectedProfile = codingSnapshot && artifactSnapshot
      ? "combined"
      : codingSnapshot
        ? "coding"
        : artifactSnapshot
          ? "artifact"
          : "standard";
    if (autoSnapshot.profile !== expectedProfile) {
      throw new Error("UI auto-run execution profile does not match its policy markers");
    }
  }
  const state = await store.load();
  if (autoSnapshot) {
    if (autoSnapshot.goalHash !== `sha256:${sha256(state.goal.normalize("NFKC"))}`) {
      throw new Error("UI auto-run goal hash does not match persisted state");
    }
    if (autoSnapshot.model !== state.config.model) {
      throw new Error("UI auto-run model pin does not match persisted state");
    }
  }
  if (["completed", "partial", "failed", "cancelled"].includes(state.status)) {
    throw new Error(`Run ${runId} is already ${state.status} and cannot be resumed`);
  }
  const config: SwarmConfig = {
    ...DEFAULT_CONFIG,
    ...state.config,
    ...overrides,
    storageMaintenance: {
      ...DEFAULT_CONFIG.storageMaintenance,
      ...(state.config.storageMaintenance ?? {}),
    },
    webResearch: {
      ...DEFAULT_CONFIG.webResearch,
      ...(state.config.webResearch ?? {}),
    },
    skillPortfolio: {
      ...DEFAULT_CONFIG.skillPortfolio,
      ...(state.config.skillPortfolio ?? {}),
    },
    reasoning: {
      ...DEFAULT_CONFIG.reasoning,
      ...state.config.reasoning,
    },
  };
  validateConfig(config);
  if (codingSnapshot && config.model !== codingSnapshot.model) {
    throw new Error(`Coding run is pinned to ${codingSnapshot.model}; persisted config uses ${config.model}`);
  }
  if (artifactSnapshot && config.model !== artifactSnapshot.model) {
    throw new Error(`Artifact run is pinned to ${artifactSnapshot.model}; persisted config uses ${config.model}`);
  }
  return Object.freeze({
    store,
    state,
    config,
    ...(codingSnapshot ? { codingSnapshot } : {}),
    ...(artifactSnapshot ? { artifactSnapshot } : {}),
    ...(autoSnapshot ? { autoSnapshot } : {}),
  });
}

async function launch(options: {
  goal: string;
  workspace: string;
  config: SwarmConfig;
  store: AtomicRunStore;
  mock: boolean;
  loaded?: RunState;
  releaseExecutionLease?: () => Promise<void>;
  abortController?: AbortController;
  onRuntimeReady?: (runtime: ManagedRunRuntime) => void | Promise<void>;
  onRuntimeDisposed?: (runtime: ManagedRunRuntime) => void;
  codingPolicy?: SwarmCodingPolicy;
  allowPreparedCodingRecovery?: boolean;
  artifactPolicy?: ArtifactProductionPolicy;
}): Promise<void> {
  const releaseExecutionLease = options.releaseExecutionLease
    ?? await options.store.acquireExecutionLease();
  const backend: AgentBackend = options.mock
    ? new MockAgentBackend()
    : codexBackend(options.workspace, options.config);
  const controller = options.abortController ?? new AbortController();
  const controlStore = new DurableControlStore(options.store.runDirectory, options.store.runId, {
    initialConcurrencyCap: options.config.maxConcurrency,
  });
  const controls = new ExecutionController(controlStore, { abortController: controller });
  let hostToolRuntime: RunHostToolRuntime | undefined;
  let deploymentRuntime: DeploymentRuntimeRouter | undefined;
  let codingRuntime: SwarmCodingRuntime | undefined;
  let artifactRuntime: ArtifactProductionRuntime | undefined;
  let researchRuntime: RunResearchToolRuntime | undefined;
  let researchDiscoveryRuntime: RunSearchDiscoveryToolRuntime | undefined;
  try {
    await controls.init();
    if (options.loaded) await controls.resume();
    const generation = await options.store.generationAuthority().capture();
    if (options.codingPolicy && options.config.model !== "gpt-5.6-luna") {
      throw new Error("Host coding runtime is pinned to gpt-5.6-luna");
    }
    codingRuntime = options.codingPolicy
      ? await SwarmCodingRuntime.create({
          workspace: options.workspace,
          runDirectory: options.store.runDirectory,
          runId: options.store.runId,
          policy: options.codingPolicy,
          ...(options.allowPreparedCodingRecovery ? { allowPreparedRecovery: true } : {}),
        })
      : undefined;
    if (options.artifactPolicy && options.config.model !== "gpt-5.6-luna") {
      throw new Error("Host artifact production runtime is pinned to gpt-5.6-luna");
    }
    artifactRuntime = options.artifactPolicy
      ? await ArtifactProductionRuntime.create({
          workspace: options.workspace,
          runDirectory: options.store.runDirectory,
          runId: options.store.runId,
          policy: options.artifactPolicy,
        })
      : undefined;
    hostToolRuntime = options.mock
      ? undefined
      : await RunHostToolRuntime.create({
          workspaceRoot: options.workspace,
          runDirectory: options.store.runDirectory,
          runId: options.store.runId,
          generation: generation.generation,
          stateDirectory: options.config.stateDirectory,
        });
    researchRuntime = !options.mock && options.config.webResearch.enabled
      ? await RunResearchToolRuntime.create({
          workspaceRoot: options.workspace,
          runDirectory: options.store.runDirectory,
          runId: options.store.runId,
          generation: generation.generation,
          stateDirectory: options.config.stateDirectory,
          policy: options.config.webResearch,
        })
      : undefined;
    if (researchRuntime) {
      const publicInternet = options.config.webResearch.allowedOrigins.length === 1 &&
        options.config.webResearch.allowedOrigins[0] === "*";
      researchDiscoveryRuntime = await RunSearchDiscoveryToolRuntime.create({
        runId: options.store.runId,
        runDirectory: options.store.runDirectory,
        provider: createHostControlledLiveSearchDiscoveryProvider({
          limits: {
            timeoutMs: Math.min(10_000, options.config.webResearch.maxDeadlineMs),
            maxResponseBytes: Math.min(512 * 1_024, options.config.webResearch.maxResponseBytes),
            maxRedirects: Math.min(2, options.config.webResearch.maxRedirects),
          },
        }),
        policy: {
          ...(publicInternet ? { publicInternet: true } : {}),
          allowedDomains: publicInternet
            ? []
            : options.config.webResearch.allowedOrigins.map((origin) => new URL(origin).hostname),
          maxCandidatesPerQuery: 20,
          maxQueryLength: 500,
        },
      });
    }
    const rolloutAuthorities = evolutionRolloutAuthorities(options.config);
    const operationsSignerKeyId = process.env.LUNA_SWARM_OPERATIONS_SIGNER_KEY_ID;
    const operationsSignerPrivateKeyFile = process.env.LUNA_SWARM_OPERATIONS_SIGNER_PRIVATE_KEY_FILE;
    if ((operationsSignerKeyId === undefined) !== (operationsSignerPrivateKeyFile === undefined)) {
      throw new Error("Both LUNA_SWARM_OPERATIONS_SIGNER_KEY_ID and LUNA_SWARM_OPERATIONS_SIGNER_PRIVATE_KEY_FILE are required");
    }
    if (!options.mock && operationsSignerKeyId && operationsSignerPrivateKeyFile) {
      const signer = await loadEd25519OperationsReceiptSigner({
        keyId: operationsSignerKeyId,
        privateKeyPath: operationsSignerPrivateKeyFile,
        authorities: rolloutAuthorities,
      });
      deploymentRuntime = (await createDeploymentControlPlane({
        workspaceDirectory: options.workspace,
        authorities: rolloutAuthorities,
        signer,
      })).router;
    } else {
      // Public verification keys alone cannot authorize candidate traffic: the
      // full signed telemetry/recovery loop is required before routing is enabled.
      deploymentRuntime = undefined;
    }
  } catch (error) {
    const cleanup = await Promise.allSettled([
      codingRuntime?.close(),
      artifactRuntime?.close(),
      backend.close(),
      releaseExecutionLease(),
    ]);
    const cleanupErrors = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors.map((result) => result.reason)], "Run initialization and cleanup failed");
    }
    throw error;
  }
  const gateway = new AgentGateway({
    backend,
    config: options.config,
    ...(options.loaded ? { initialMetrics: options.loaded.metrics } : {}),
    onEvent: async (event) => {
      const persisted = await options.store.appendEvent({
        eventId: randomUUID(),
        at: new Date().toISOString(),
        runId: options.store.runId,
        ...event,
      });
      printEvent(persisted);
    },
    onEventError: (error, event) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[event_write_failed] ${event.type} — ${message}\n`);
    },
    controls,
  });
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    process.stderr.write("\n실행을 일시정지하고 재개 가능한 상태를 저장하는 중입니다…\n");
    void controls.interrupt(signal).catch((error: unknown) => {
      process.stderr.write(`[interrupt_failed] ${error instanceof Error ? error.message : String(error)}\n`);
    });
  };
  const onSigint = () => onSignal("SIGINT");
  const onSigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let managedRuntime: ManagedRunRuntime | undefined;
  let runStateInitialized = options.loaded !== undefined;
  let primaryFailure: unknown;
  try {
    printBanner(options.store.runId, backend.info(), options.config);
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store: options.store,
      config: options.config,
      workspace: options.workspace,
      onProgress: printEvent,
      ...(hostToolRuntime ? { hostToolRuntime } : {}),
      ...(deploymentRuntime ? { deploymentRuntime } : {}),
      ...(codingRuntime ? { codingRuntime } : {}),
      ...(artifactRuntime ? { artifactRuntime } : {}),
      ...(researchRuntime ? { researchRuntime } : {}),
      ...(researchDiscoveryRuntime ? { researchDiscoveryRuntime } : {}),
    });
    managedRuntime = {
      runId: options.store.runId,
      gateway,
      orchestrator,
      controls,
      store: options.store,
      configuredMaximum: options.config.maxConcurrency,
    };
    const markRuntimeReady = async (): Promise<void> => {
      runStateInitialized = true;
      await options.onRuntimeReady?.(managedRuntime!);
    };
    const state = options.loaded
      ? (await markRuntimeReady(), await orchestrator.resume(options.loaded, controller.signal))
      : await orchestrator.start(
          options.goal,
          controller.signal,
          markRuntimeReady,
        );
    printResult(state, options.store.finalPath, options.store.organizationPath);
    if (artifactRuntime) printArtifactOutputs(artifactRuntime);
    if (state.status === "failed") process.exitCode = 1;
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    const cleanupFailures: unknown[] = [];
    try { await deploymentRuntime?.drain(); }
    catch (error) { cleanupFailures.push(error); }
    try { await managedRuntime?.orchestrator.flushMetrics(); }
    catch (error) { cleanupFailures.push(error); }
    if (managedRuntime && runStateInitialized) {
      try { await options.store.compactTransitions(); }
      catch (error) { cleanupFailures.push(error); }
    }
    const runtimeCleanup = await Promise.allSettled([
      codingRuntime?.close(),
      artifactRuntime?.close(),
      backend.close(),
    ]);
    cleanupFailures.push(...runtimeCleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason));
    if (managedRuntime) {
      try { options.onRuntimeDisposed?.(managedRuntime); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await releaseExecutionLease(); }
    catch (error) { cleanupFailures.push(error); }
    try {
      await runAutomaticStorageMaintenance(storageManager(options.workspace, options.config), "after-run");
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, ...cleanupFailures],
          `Run failed: ${primaryFailure instanceof Error ? primaryFailure.message : String(primaryFailure)}; cleanup also failed`,
        );
      }
      throw new AggregateError(cleanupFailures, "Run cleanup failed");
    }
  }
}

async function storage(args: string[]): Promise<void> {
  const [action = "status", runId] = positional(args);
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const manager = storageManager(workspace, config);
  if (action === "status") {
    process.stdout.write(`${JSON.stringify({
      policy: config.storageMaintenance,
      inspection: await manager.inspect(),
    }, null, 2)}\n`);
    return;
  }
  if (action === "gc") {
    const report = await manager.maintain({ dryRun: args.includes("--dry-run") });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  if (action === "restore") {
    if (!runId) throw new Error("Usage: luna-swarm storage restore <run-id> [--workspace .]");
    const restored = await manager.restoreRun(runId);
    process.stdout.write(`${JSON.stringify({
      runId: restored.runId,
      runDirectory: restored.runDirectory,
      status: restored.manifest.terminalStatus,
      fileCount: restored.manifest.fileCount,
      restoredBytes: restored.manifest.uncompressedBytes,
    }, null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown storage action: ${action}`);
}

function storageManager(workspace: string, config: SwarmConfig): StorageManager {
  return new StorageManager({
    workspace,
    stateDirectory: config.stateDirectory,
    policy: config.storageMaintenance,
    learningHistoryRuns: config.learningHistoryRuns,
  });
}

async function runAutomaticStorageMaintenance(
  manager: StorageManager,
  phase: "after-run",
): Promise<void> {
  try {
    const report = await manager.maintainAfterRun();
    if (!report) return;
    const applied = report.actions.filter((action) => action.status === "applied").length;
    const failed = report.actions.filter((action) => action.status === "failed").length;
    if (applied > 0 || failed > 0 || report.after.budget.overBudget) {
      process.stdout.write(
        `[storage_maintenance] ${phase} · applied=${applied} failed=${failed} reclaimed=${report.reclaimedBytes}B total=${report.after.totalBytes}B\n`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[storage_maintenance_failed] ${phase} — ${message}\n`);
  }
}

function codexBackend(workspace: string, config: SwarmConfig): AgentBackend {
  const shardCount = config.appServerShardCount;
  const maxInflightPerShard = Math.max(1, Math.ceil(config.maxConcurrency / shardCount));
  const factory = (shard: number) => new CodexAppServerBackend({
    workspace,
    config: {
      ...config,
      maxConcurrency: maxInflightPerShard,
      initialConcurrency: Math.min(config.initialConcurrency, maxInflightPerShard),
      minConcurrency: Math.min(config.minConcurrency, maxInflightPerShard),
    },
    ...(process.env.LUNA_SWARM_CODEX_PATH
      ? { codexPath: process.env.LUNA_SWARM_CODEX_PATH }
      : {}),
    onStderr: (line) => {
      if (/error|warn/i.test(line)) process.stderr.write(`[codex:${shard}] ${line}\n`);
    },
  });
  return new AppServerSupervisor(factory, {
    shardCount,
    maxInflightPerShard,
    maxQueuePerShard: Math.max(1, maxInflightPerShard * 2),
    drainTimeoutMs: Math.min(config.callTimeoutMs, 30_000),
  });
}

async function status(args: string[]): Promise<void> {
  const runId = positional(args)[0];
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  if (!runId) {
    const runs = await AtomicRunStore.listRuns(workspace, config.stateDirectory);
    process.stdout.write(runs.length ? `${runs.join("\n")}\n` : "저장된 실행이 없습니다.\n");
    return;
  }
  const state = await new AtomicRunStore(workspace, config.stateDirectory, runId).load();
  const counts = Object.values(state.tasks).reduce<Record<string, number>>((all, task) => {
    all[task.status] = (all[task.status] ?? 0) + 1;
    return all;
  }, {});
  const departments = Object.values(state.tasks).reduce<Record<string, number>>((all, task) => {
    all[task.department] = (all[task.department] ?? 0) + 1;
    return all;
  }, {});
  process.stdout.write(
    `${JSON.stringify(
      {
        runId: state.runId,
        status: state.status,
        goal: state.goal,
        tasks: counts,
        departments,
        metrics: state.metrics,
        harness: state.harness,
        updatedAt: state.updatedAt,
      },
      null,
      2,
    )}\n`,
  );
}

async function printSkills(args: string[]): Promise<void> {
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const catalog = await SkillCatalog.load(workspace, config.stateDirectory);
  const skills = catalog.list().map((skill) => ({
    id: skill.id,
    name: skill.name,
    source: skill.source,
    roles: skill.roles,
    departments: skill.departments,
    taskKinds: skill.taskKinds,
    version: skill.version,
    contentHash: skill.contentHash,
  }));
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ count: skills.length, skills }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`스킬 카탈로그 ${skills.length}개\n`);
  for (const skill of skills) {
    process.stdout.write(
      `${skill.id.padEnd(32)} ${skill.source.padEnd(16)} ${skill.roles.join(",") || "all"}\n`,
    );
  }
}

async function printLearning(args: string[]): Promise<void> {
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const policyStore = new LearningPolicyStore(workspace, config.stateDirectory);
  if (args.includes("--rollback")) {
    const rolledBack = await policyStore.rollback();
    process.stdout.write(`${JSON.stringify({ policy: rolledBack.update }, null, 2)}\n`);
    return;
  }
  const snapshot = await new LearningStore(
    workspace,
    config.stateDirectory,
  ).loadSnapshot(config.learningHistoryRuns);
  const summary = snapshot.summary(config.learningMinSamples);
  const policy = (await policyStore.load()).state();
  const recent = args.includes("--recent")
    ? snapshot
        .allExperiences()
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
        .slice(0, 20)
        .map((experience) => ({
          id: experience.id,
          runId: experience.runId,
          taskId: experience.taskId,
          department: experience.department,
          taskKind: experience.taskKind,
          outcome: experience.outcome,
          attempts: experience.attempts,
          quality: experience.quality,
          skillIds: experience.skillIds,
          signals: experience.signals,
          at: experience.at,
        }))
    : undefined;
  process.stdout.write(
    `${JSON.stringify({ summary, policy, ...(recent ? { recent } : {}) }, null, 2)}\n`,
  );
}

async function evolve(args: string[]): Promise<void> {
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const [action = "status"] = positional(args);
  if (action === "bootstrap") {
    const fingerprint = await evolutionCliFingerprint(config, workspace);
    const runtime = await initializeEvolutionRuntime(workspace, fingerprint);
    process.stdout.write(`${JSON.stringify({ mode: "manual", pins: runtime.pins }, null, 2)}\n`);
    return;
  }

  if (action === "rollout") {
    const [, rolloutAction = "status", rolloutId] = positional(args);
    if (rolloutAction !== "status" || !rolloutId) {
      throw new Error("Usage: luna-swarm evolve rollout status <rollout-id> [--workspace .]");
    }
    const rollout = await new RolloutStore(workspace).read(rolloutId);
    if (!rollout) throw new Error(`Unknown rollout: ${rolloutId}`);
    process.stdout.write(`${JSON.stringify({
      mode: "durable-rollout-observation",
      readOnly: true,
      automaticPromotion: false,
      operatorPromotionRequired: true,
      rollout,
    }, null, 2)}\n`);
    return;
  }

  const bundleStore = new ExecutionBundleStore(workspace);
  const genomeStore = new OrganizationGenomeStore(workspace, bundleStore);
  const evaluationStore = new PairedEvaluationReceiptStore(workspace, {
    trustedBenchmarkAuthorities: evolutionBenchmarkAuthorities(config),
    trustedProtectedProcessAuthorities: evolutionProtectedProcessAuthorities(config),
  });
  const quarantineStore = new GenomeQuarantineStore(workspace, genomeStore);
  const rolloutBindings = new ActiveRolloutBindingStore(workspace, {
    bundleStore,
    quarantineStore,
    rolloutStore: new RolloutStore(workspace),
  });
  const pointers = new StablePointerStore(workspace, {
    bundleStore,
    evaluationStore,
    quarantineStore,
    assertPromotionAllowed: async (request) => {
      const bundle = await bundleStore.read(request.bundleId);
      await rolloutBindings.prepareStablePromotion({
        workloadClass: request.workloadClass,
        bundleId: request.bundleId,
        bundleHash: bundle.bundleHash,
        expectedPointerGeneration: request.expectedGeneration,
        actor: request.actor,
        reason: request.reason,
      });
    },
  });
  if (action === "promote") {
    const fingerprint = await evolutionCliFingerprint(config, workspace);
    const bundleId = positional(args)[1];
    const workloadClass = requiredOption(args, "--workload");
    if (!bundleId) throw new Error("Usage: luna-swarm evolve promote <bundle-id> --workload <class> --expected-generation <n> --evaluation <receipt-id> --evaluation-hash <sha256:...> --actor <name> --reason <text>");
    const expectedGeneration = requiredIntegerOption(args, "--expected-generation", 0);
    const bundle = await bundleStore.read(bundleId);
    await verifyRunnableEvolutionBundle(genomeStore, bundle, fingerprint);
    const pointer = await pointers.promote({
      workloadClass,
      bundleId,
      expectedGeneration,
      mode: "manual",
      actor: requiredOption(args, "--actor"),
      reason: requiredOption(args, "--reason"),
      evaluationReceipt: {
        receiptId: requiredOption(args, "--evaluation"),
        contentHash: canonicalEvolutionHashOption(args, "--evaluation-hash"),
      },
    });
    let rolloutCleanupWarning: string | undefined;
    try {
      await rolloutBindings.reconcileAfterStablePromotion(workloadClass);
    } catch {
      // The pointer CAS is already authoritative. Candidate admission also
      // self-heals this stale binding on the next read, so never report the
      // committed promotion as failed solely because cleanup must be retried.
      rolloutCleanupWarning = "Stable Pointer committed; active rollout cleanup will retry on the next control-plane read";
    }
    process.stdout.write(`${JSON.stringify({ pointer, ...(rolloutCleanupWarning ? { warning: rolloutCleanupWarning } : {}) }, null, 2)}\n`);
    return;
  }
  if (action === "rollback") {
    const workloadClass = positional(args)[1] ?? requiredOption(args, "--workload");
    const pointer = await pointers.rollback(
      workloadClass,
      requiredIntegerOption(args, "--expected-generation", 1),
      { actor: requiredOption(args, "--actor"), reason: requiredOption(args, "--reason") },
    );
    process.stdout.write(`${JSON.stringify({ pointer, quarantinedPrevious: true }, null, 2)}\n`);
    return;
  }
  if (action !== "status") throw new Error(`Unknown evolve command: ${action}`);

  const stable = Object.fromEntries(await Promise.all(EVOLUTION_WORKLOAD_CLASSES.map(async (workload) => [workload, await pointers.get(workload)])));
  const [traces, outcomeInspection, failures, evaluations, audit] = await Promise.all([
    new DecisionTraceStore(workspace).list(),
    new ObjectiveOutcomeReceiptStore(workspace).inspect(),
    new FailureCapsuleStore(workspace).listHeads(),
    evaluationStore.list(),
    pointers.getAudit(),
  ]);
  const outcomes = outcomeInspection.valid;
  const auditCounts = Object.fromEntries(["promote", "baseline_upgrade", "rollback"].map((action) => [
    action,
    audit.filter((entry) => entry.action === action).length,
  ]));
  const failureLifecycleCounts = Object.fromEntries(["observed", "reproduced", "oracle-locked", "resolved"].map((lifecycle) => [
    lifecycle,
    failures.filter((failure) => failure.lifecycle === lifecycle).length,
  ]));
  const evaluatedPromotions = audit.filter((entry) => entry.action === "promote" && entry.evaluationReceiptId !== null).length;
  const promotableEvaluations = evaluations.filter((evaluation) => evaluation.scorecard.outcome === "PROMOTABLE").length;
  const stage = evaluatedPromotions > 0
    ? "promoted-challengers"
    : evaluations.length > 0
      ? "evaluated-challengers"
      : outcomes.length > 0
        ? "collecting-outcomes"
        : "baseline-only";
  const warnings = [
    ...(outcomeInspection.invalid.length > 0
      ? [`${outcomeInspection.invalid.length} historical outcome receipt(s) failed authoritative verification and are excluded from evolution evidence.`]
      : []),
    ...(evaluations.length === 0 ? ["No authoritative paired challenger evaluation has been recorded."] : []),
    ...(failures.length > 0 && failureLifecycleCounts["oracle-locked"] === 0
      ? ["Failure capsules exist, but none has reached an oracle-locked regression state."]
      : []),
  ];
  process.stdout.write(`${JSON.stringify({
    mode: "observation-only/manual-promotion",
    stable,
    counts: {
      traces: traces.length,
      outcomes: outcomes.length,
      invalidOutcomes: outcomeInspection.invalid.length,
      failures: failures.length,
      evaluations: evaluations.length,
    },
    health: {
      stage,
      promotableEvaluations,
      evaluatedPromotions,
      audit: auditCounts,
      failureLifecycles: failureLifecycleCounts,
      warnings,
    },
    audit,
  }, null, 2)}\n`);
}

async function verifiedCache(args: string[]): Promise<void> {
  const [action = "status"] = positional(args);
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const cache = new VerifiedArtifactCache(resolve(
    workspace,
    config.stateDirectory,
    "cache",
    "verified-artifacts",
  ), { boundaryRoot: workspace });
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await cache.status(), null, 2)}\n`);
    return;
  }
  if (action === "invalidate" && option(args, "--source")) {
    const sourceIdentity = requiredOption(args, "--source");
    process.stdout.write(`${JSON.stringify({
      sourceIdentity,
      invalidated: await cache.invalidateSource(sourceIdentity),
    }, null, 2)}\n`);
    return;
  }
  const keyFile = option(args, "--key-file");
  if (!keyFile) {
    throw new Error(`cache ${action} requires --key-file <verified-cache-key.json>`);
  }
  const key = JSON.parse(await readFile(resolve(workspace, keyFile), "utf8")) as VerifiedArtifactCacheKeyInput;
  if (action === "explain") {
    process.stdout.write(`${JSON.stringify(await cache.explain(key), null, 2)}\n`);
    return;
  }
  if (action === "verify") {
    process.stdout.write(`${JSON.stringify(await cache.verify(key), null, 2)}\n`);
    return;
  }
  if (action === "invalidate") {
    process.stdout.write(`${JSON.stringify({ invalidated: await cache.invalidate(key) }, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: luna-swarm cache status|explain|verify|invalidate [--key-file file | --source id]");
}

async function soak(args: string[]): Promise<void> {
  if (!args.includes("--live-authorized")) {
    throw new Error("Live account access is disabled unless --live-authorized is supplied explicitly");
  }

  const action = positional(args)[0];
  if (action === "account-fingerprint") {
    const workspace = resolve(option(args, "--workspace") ?? process.cwd());
    const config = await loadConfig(option(args, "--config"));
    const timeoutMs = boundedIntegerOption(
      args,
      "--timeout-ms",
      Math.min(config.callTimeoutMs, 120_000),
      1_000,
      1_200_000,
    );
    const backend = liveAccountBackend(workspace, config, timeoutMs);
    try {
      const accountIdentityHash = await backend.accountIdentityHash();
      process.stdout.write(`${JSON.stringify({
        schemaVersion: 1,
        type: "chatgpt-account-fingerprint",
        accountIdentityHash,
      }, null, 2)}\n`);
    } finally {
      await backend.close();
    }
    return;
  }
  if (action !== undefined) throw new Error(`Unknown soak command: ${action}`);

  const maxStage = requiredSoakStage(args);
  const minStage = soakStageOption(args, "--min-stage", 1);
  if (minStage > maxStage) throw new Error("--min-stage must not exceed --max-stage");
  const maxCalls = requiredBoundedIntegerOption(args, "--max-calls", 1, 4_096);
  const budgetUnit = requiredOption(args, "--budget-unit");
  const budgetPerCall = requiredBoundedNumberOption(args, "--budget-per-call", 0, 1_000_000);
  const budgetLimit = requiredBoundedNumberOption(args, "--budget-limit", 0, 1_000_000_000);
  if (Math.floor(budgetLimit / budgetPerCall) < 1) {
    throw new Error("--budget-limit must authorize at least one declared --budget-per-call unit");
  }
  const maxRetries = boundedIntegerOption(args, "--max-retries", 0, 0, 3);
  const retryDelayMs = boundedIntegerOption(args, "--retry-delay-ms", 1_000, 0, 60_000);
  const maxErrorRate = boundedNumberOption(args, "--max-error-rate", 0.05, 0, 1);
  const warmupCallsPerStage = option(args, "--warmup-calls-per-stage") === undefined
    ? undefined
    : requiredBoundedIntegerOption(args, "--warmup-calls-per-stage", 0, 4_096);
  const measuredCallsPerStage = option(args, "--measured-calls-per-stage") === undefined
    ? undefined
    : requiredBoundedIntegerOption(args, "--measured-calls-per-stage", 1, 4_096);
  const accountIdentityHash = canonicalEvolutionHashOption(
    args,
    "--account-email-sha256",
  ) as `sha256:${string}`;
  const authorizationExpiresAt = requiredOption(args, "--authorization-expires-at");

  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const config = await loadConfig(option(args, "--config"));
  const timeoutMs = boundedIntegerOption(
    args,
    "--timeout-ms",
    Math.min(config.callTimeoutMs, 120_000),
    1_000,
    1_200_000,
  );
  const report = await runShardSoak({
      stageBackendFactory: (stage) => liveSoakBackend(
        workspace,
        config,
        stage,
        timeoutMs,
        accountIdentityHash,
      ),
      minStage,
      maxStage,
      maxCalls,
      estimatedBudget: {
        unit: budgetUnit,
        perCall: budgetPerCall,
        limit: budgetLimit,
      },
      provenance: "live",
      liveAuthorized: true,
      liveAuthorization: {
        accountIdentityHash,
        expiresAt: authorizationExpiresAt,
      },
      timeoutMs,
      maxRetries,
      retryDelayMs,
      maxErrorRate,
      ...(warmupCallsPerStage === undefined ? {} : { warmupCallsPerStage }),
      ...(measuredCallsPerStage === undefined ? {} : { measuredCallsPerStage }),
    });
  process.stdout.write(`${shardSoakReportJson(report)}\n`);
  if (report.status === "stopped") process.exitCode = 2;
}

function liveSoakBackend(
  workspace: string,
  config: SwarmConfig,
  shardCount: SoakShardStage,
  timeoutMs: number,
  expectedAccountIdentityHash: `sha256:${string}`,
): AgentBackend {
  const shardConfig: SwarmConfig = {
    ...config,
    maxConcurrency: 1,
    appServerShardCount: 1,
    initialConcurrency: 1,
    minConcurrency: 1,
    allowNetwork: false,
  };
  const factory = () => new CodexAppServerBackend({
    workspace,
    config: shardConfig,
    ...(process.env.LUNA_SWARM_CODEX_PATH
      ? { codexPath: process.env.LUNA_SWARM_CODEX_PATH }
      : {}),
    rpcTimeoutMs: timeoutMs,
    expectedChatGptAccountEmailSha256: expectedAccountIdentityHash,
  });
  return new AppServerSupervisor(factory, {
    shardCount,
    maxInflightPerShard: 1,
    maxQueuePerShard: 8,
    drainTimeoutMs: Math.min(timeoutMs, 30_000),
  });
}

function liveAccountBackend(
  workspace: string,
  config: SwarmConfig,
  timeoutMs: number,
): CodexAppServerBackend {
  return new CodexAppServerBackend({
    workspace,
    config: {
      ...config,
      maxConcurrency: 1,
      initialConcurrency: 1,
      minConcurrency: 1,
      allowNetwork: false,
    },
    ...(process.env.LUNA_SWARM_CODEX_PATH
      ? { codexPath: process.env.LUNA_SWARM_CODEX_PATH }
      : {}),
    rpcTimeoutMs: timeoutMs,
  });
}

function evolutionBenchmarkAuthorities(config: SwarmConfig): Readonly<Record<string, TrustedBenchmarkAuthority>> {
  return Object.fromEntries(Object.entries(config.evolutionBenchmarkAuthorities ?? {}).map(([keyId, authority]) => [keyId, {
    evaluatorVersion: authority.evaluatorVersion,
    publicKeyPem: authority.publicKeyPem,
    benchmarkSuites: authority.benchmarkSuites as Record<string, `sha256:${string}`>,
  }]));
}

async function evolutionCliFingerprint(
  config: SwarmConfig,
  workspace: string,
): Promise<EvolutionRuntimeFingerprintInput> {
  const explicitSource: ExplicitSourceIdentity | undefined = config.sourceIdentity
    ? { kind: "config", value: config.sourceIdentity }
    : process.env.LUNA_SOURCE_COMMIT
      ? { kind: "luna_environment", value: process.env.LUNA_SOURCE_COMMIT }
      : undefined;
  const source = await resolveEvolutionSourceIdentity(workspace, explicitSource);
  if (source.mode === "observation_only") throw new SourceIdentityUnavailableError(source.reason);
  return {
    model: config.model,
    reasoning: config.reasoning,
    maxContextChars: config.maxContextChars,
    maxConcurrency: config.maxConcurrency,
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
    organizationVersion: HARNESS_V2_ORG_VERSION,
    releaseEpoch: config.evolutionReleaseEpoch,
    sourceCommit: source.identity,
  };
}

async function initConfig(args: string[]): Promise<void> {
  const path = resolve(positional(args)[0] ?? "luna-swarm.config.json");
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing file: ${path}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }
  await writeFile(path, configTemplate(), "utf8");
  process.stdout.write(`설정 파일 생성: ${path}\n`);
}

async function doctor(): Promise<void> {
  const located = locateCodex(process.env.LUNA_SWARM_CODEX_PATH);
  const chatGptEnv = chatGptOnlyEnvironment();
  process.stdout.write(`Node: ${process.version}\n`);
  const version = await execFileAsync(located.command, [...located.args, "--version"], {
    encoding: "utf8",
    env: chatGptEnv,
  });
  process.stdout.write(`Codex: ${version.stdout.trim()}\n`);
  try {
    const login = await execFileAsync(located.command, [...located.args, "login", "status"], {
      encoding: "utf8",
      env: chatGptEnv,
    });
    process.stdout.write(`Auth: ${login.stdout.trim() || login.stderr.trim()}\n`);
  } catch (error) {
    process.stdout.write("Auth: 로그인 확인 실패 — 먼저 `npx codex login`을 실행하세요.\n");
    if (process.env.LUNA_SWARM_DEBUG) throw error;
  }
  const probe = new AppServerClient({
    cwd: process.cwd(),
    env: chatGptEnv,
    ...(process.env.LUNA_SWARM_CODEX_PATH
      ? { codexPath: process.env.LUNA_SWARM_CODEX_PATH }
      : {}),
  });
  try {
    await probe.start();
    process.stdout.write("App Server state: writable and ready\n");
    const account = await probe.request<{
      account: { type: string; planType?: string } | null;
    }>("account/read", { refreshToken: false });
    process.stdout.write(
      account.account?.type === "chatgpt"
        ? `App Server auth: ChatGPT (${account.account.planType ?? "plan unknown"})\n`
        : `App Server auth: ${account.account?.type ?? "none"} — Luna Swarm will refuse this mode\n`,
    );
    const models = await probe.request<{
      data: Array<{ id: string; model: string; displayName: string }>;
    }>("model/list", { limit: 100, includeHidden: true });
    const luna = models.data.find(
      (model) => model.id === DEFAULT_CONFIG.model || model.model === DEFAULT_CONFIG.model,
    );
    process.stdout.write(
      luna
        ? `Luna catalog: available (${luna.displayName})\n`
        : `Luna catalog: ${DEFAULT_CONFIG.model} not listed; check account entitlement and Codex version\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`App Server state: unavailable — ${message}\n`);
  } finally {
    await probe.close();
  }
  process.stdout.write(`Default model: ${DEFAULT_CONFIG.model}\n`);
}

function concurrencyOverrides(args: string[]): Partial<SwarmConfig> {
  const overrides: Partial<SwarmConfig> = {};
  const max = option(args, "--max-concurrency");
  const initial = option(args, "--initial-concurrency");
  if (max) overrides.maxConcurrency = Number(max);
  if (initial) overrides.initialConcurrency = Number(initial);
  return overrides;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredIntegerOption(args: string[], name: string, min: number): number {
  const raw = requiredOption(args, name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

function evolutionProtectedProcessAuthorities(
  config: SwarmConfig,
): Readonly<Record<string, TrustedProtectedProcessAuthority>> {
  const result: Record<string, TrustedProtectedProcessAuthority> = {};
  for (const benchmarkAuthority of Object.values(config.evolutionBenchmarkAuthorities ?? {})) {
    for (const [keyId, authority] of Object.entries(benchmarkAuthority.protectedProcessAuthorities ?? {})) {
      const existing = result[keyId];
      if (existing && JSON.stringify(existing) !== JSON.stringify(authority)) {
        throw new Error(`Conflicting protected process authority: ${keyId}`);
      }
      result[keyId] = authority as TrustedProtectedProcessAuthority;
    }
  }
  return Object.freeze(result);
}

function evolutionRolloutAuthorities(config: SwarmConfig): Readonly<Record<string, TrustedRolloutAuthority>> {
  return Object.fromEntries(Object.entries(config.evolutionRolloutAuthorities ?? {}).map(([keyId, authority]) => [keyId, {
    publicKeyPem: authority.publicKeyPem,
    authority: authority.authority,
  }]));
}

function requiredBoundedIntegerOption(
  args: string[],
  name: string,
  min: number,
  max: number,
): number {
  const value = Number(requiredOption(args, name));
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requiredBoundedNumberOption(
  args: string[],
  name: string,
  exclusiveMin: number,
  max: number,
): number {
  const value = Number(requiredOption(args, name));
  if (!Number.isFinite(value) || value <= exclusiveMin || value > max) {
    throw new Error(`${name} must be greater than ${exclusiveMin} and at most ${max}`);
  }
  return value;
}

function boundedNumberOption(
  args: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function boundedIntegerOption(
  args: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requiredSoakStage(args: string[]): SoakShardStage {
  const value = requiredBoundedIntegerOption(args, "--max-stage", 1, 256);
  if (!(SOAK_SHARD_STAGES as readonly number[]).includes(value)) {
    throw new Error(`--max-stage must be one of ${SOAK_SHARD_STAGES.join(", ")}`);
  }
  return value as SoakShardStage;
}

function soakStageOption(
  args: string[],
  name: string,
  fallback: SoakShardStage,
): SoakShardStage {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !(SOAK_SHARD_STAGES as readonly number[]).includes(value)) {
    throw new Error(`${name} must be one of ${SOAK_SHARD_STAGES.join(", ")}`);
  }
  return value as SoakShardStage;
}

function canonicalEvolutionHashOption(args: string[], name: string): string {
  const value = requiredOption(args, name);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a canonical SHA-256 digest`);
  return value;
}

function numberOption(
  args: string[],
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = option(args, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function positional(args: string[]): string[] {
  const withValue = new Set([
    "--goal",
    "--coding-policy",
    "--artifact-policy",
    "--workspace",
    "--config",
    "--run-id",
    "--max-concurrency",
    "--initial-concurrency",
    "--port",
    "--host",
    "--token",
    "--workload",
    "--expected-generation",
    "--evaluation",
    "--evaluation-hash",
    "--actor",
    "--reason",
    "--max-stage",
    "--min-stage",
    "--max-calls",
    "--budget-unit",
    "--budget-per-call",
    "--budget-limit",
    "--timeout-ms",
    "--max-retries",
    "--retry-delay-ms",
    "--max-error-rate",
    "--warmup-calls-per-stage",
    "--measured-calls-per-stage",
    "--account-email-sha256",
    "--authorization-expires-at",
    "--key-file",
    "--source",
  ]);
  const result: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (withValue.has(args[i]!)) {
      i += 1;
    } else if (!args[i]!.startsWith("--")) {
      result.push(args[i]!);
    }
  }
  return result;
}

function makeRunId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
}

function printBanner(
  runId: string,
  info: ReturnType<AgentBackend["info"]>,
  config: SwarmConfig,
): void {
  process.stdout.write(
    `Luna Swarm ${runId}\n${info.name} · ${info.model}\n상한 ${config.maxTasks} tasks / ${config.maxTeams} teams / ${config.maxAgentTurns} turns · 시작 동시성 ${config.initialConcurrency} · 동시성 상한 ${config.maxConcurrency}\n\n`,
  );
}

function printEvent(event: RunEvent): void {
  const task = event.taskId ? ` ${event.taskId}` : "";
  const detail = event.message ? ` — ${event.message}` : "";
  process.stdout.write(`[${event.type}]${task}${detail}\n`);
}

function printResult(state: RunState, finalPath: string, organizationPath: string): void {
  process.stdout.write(`\n상태: ${state.status}\n실행 ID: ${state.runId}\n`);
  if (state.final) {
    process.stdout.write(
      `결과: ${finalPath}\n조직도: ${organizationPath}\n\n${state.final.executiveSummary}\n`,
    );
  }
  if (state.error) process.stderr.write(`오류: ${state.error}\n`);
}

function printArtifactOutputs(runtime: ArtifactProductionRuntime): void {
  const outputs = runtime.listProducedFiles().flatMap((record) =>
    record.files.map((file) => ({ ...file, path: resolve(record.storeRoot, file.relativePath) }))
  );
  if (outputs.length === 0) return;
  process.stdout.write("\n생성 파일:\n");
  for (const output of outputs) {
    process.stdout.write(
      `- ${output.fileName} · ${output.format.toUpperCase()} · ${output.bytes} bytes · sha256:${output.sha256}\n  ${output.path}\n`,
    );
  }
}

function printHelp(): void {
  process.stdout.write(`Luna Swarm — ChatGPT 로그인으로 Codex Luna 논리 에이전트를 조율합니다.

사용법:
  luna-swarm doctor
  luna-swarm dashboard [--workspace .] [--port 4310] [--open]
  luna-swarm ui [--workspace .] [--port 4310] [--mock] [--open]
  luna-swarm org [run-id]
  luna-swarm skills [--workspace .] [--json]
  luna-swarm learning [--workspace .] [--recent] [--rollback]
  luna-swarm evolve status [--workspace .]
  luna-swarm evolve bootstrap [--workspace .]
  luna-swarm evolve rollout status <rollout-id> [--workspace .]
  luna-swarm evolve promote <bundle-id> --workload <class> --expected-generation <n> --evaluation <receipt-id> --evaluation-hash <sha256:...> --actor <name> --reason <text>
  luna-swarm evolve rollback <workload-class> --expected-generation <n> --actor <name> --reason <text>
  luna-swarm soak account-fingerprint --live-authorized [--workspace .]
  luna-swarm soak --live-authorized --account-email-sha256 <sha256:...> --authorization-expires-at <ISO> [--min-stage <stage>] --max-stage <1|2|4|8|16|32|64|128|256> --max-calls <1..4096> --budget-unit <label> --budget-per-call <n> --budget-limit <n> [--workspace .]
  luna-swarm storage status [--workspace .]
  luna-swarm storage gc [--dry-run] [--workspace .]
  luna-swarm storage restore <run-id> [--workspace .]
  luna-swarm cache status [--workspace .]
  luna-swarm cache explain|verify|invalidate --key-file <cache-key.json> [--workspace .]
  luna-swarm cache invalidate --source <source-identity> [--workspace .]
  luna-swarm init [config.json]
  luna-swarm run --goal "작업" [--workspace .] [--mock]
  luna-swarm code --goal "코딩 작업" --coding-policy <policy.json> [--workspace .] [--mock]
  luna-swarm artifact --goal "파일 제작" --artifact-policy <policy.json> [--workspace .] [--mock]
  luna-swarm resume <run-id> [--workspace .]
  luna-swarm status [run-id] [--workspace .]

옵션:
  --config <file>
  --coding-policy <file>   Luna-only repair/genesis 전략·범위·보호 check를 고정하는 코딩 정책 JSON
  --artifact-policy <file> PDF/XLSX/CSV/SVG/PNG 형식·파일명·locale·font hash·상한을 고정하는 정책 JSON
  --max-concurrency <1..1024>
  --initial-concurrency <1..1024>
  --run-id <id>
  --host <address>          UI 바인드 주소 (기본 127.0.0.1)
  --token <secret>          비-loopback UI에 필수인 접근 토큰
  --port <0..65535>         UI/대시보드 포트 (기본 4310)
  --open                    대시보드를 기본 브라우저에서 열기
  --mock                    실제 모델 호출 없는 설치 검증
  --json                    스킬 카탈로그를 JSON으로 출력
  --recent                  최근 학습 경험 메타데이터 20개 포함
  --rollback                직전 검증된 학습 정책 또는 안전 기준선으로 복구
  --dry-run                 저장소 정리 대상을 계산만 하고 파일은 변경하지 않음
  --evaluation <receipt>    PROMOTABLE paired 평가 영수증
  --evaluation-hash <hash>  평가 영수증의 canonical SHA-256
  --expected-generation <n> Stable Pointer CAS 세대
  --actor <identity>        수동 승격·롤백 실행자 감사 ID
  --reason <text>           수동 변경 사유
  --live-authorized         허가된 실제 ChatGPT 계정 soak 실행을 명시적으로 승인
  --account-email-sha256 <hash> account-fingerprint로 확인한 실제 계정 지문
  --authorization-expires-at <ISO> 계정·호출·단계·예산 승인의 만료시각 (최대 24시간)
  --min-stage <stage>       이전 성공 단계를 반복하지 않을 시작 shard 단계 (기본 1)
  --max-stage <stage>       단계별 soak의 최대 shard 단계 (1..256, 2의 거듭제곱)
  --max-calls <n>           재시도를 포함한 실제 모델 호출 hard limit (최대 4096)
  --budget-unit <label>     예산 추정 단위 (예: call-credit)
  --budget-per-call <n>     호출당 추정 예산
  --budget-limit <n>        전체 추정 예산 hard limit
  --timeout-ms <n>          soak 호출 제한 시간 (기본 min(callTimeoutMs, 120000))
  --max-error-rate <0..1>   단계를 중지할 최대 오류율 (기본 0.05)
  --max-retries <0..3>      429/timeout 재시도 횟수 (기본 0)
  --warmup-calls-per-stage <n>   단계별 warmup 호출 수 (기본 stage 크기)
  --measured-calls-per-stage <n> 단계별 측정 호출 수 (기본 stage 크기의 2배)
`);
}

async function printOrganization(args: string[]): Promise<void> {
  const runId = positional(args)[0];
  if (runId) {
    const workspace = resolve(option(args, "--workspace") ?? process.cwd());
    const config = await loadConfig(option(args, "--config"));
    const state = await new AtomicRunStore(
      workspace,
      config.stateDirectory,
      runId,
    ).load();
    printRunOrganization(state);
    return;
  }
  process.stdout.write("LEVEL  TITLE                         DEPARTMENT   REPORTS TO\n");
  for (const row of organizationRows()) {
    process.stdout.write(
      `${String(row.level).padEnd(6)} ${row.title.padEnd(29)} ${row.department.padEnd(12)} ${row.reportsTo}\n`,
    );
  }
}

function printRunOrganization(state: RunState): void {
  const root = Object.values(state.teams).find((team) => team.parentTeamId === null);
  process.stdout.write(`회장 · 사용자 — ${state.goal}\n`);
  if (!root) {
    process.stdout.write("└─ 아직 승인된 프로젝트 조직이 없습니다.\n");
    return;
  }
  const renderTeam = (teamId: string, prefix: string, last: boolean): void => {
    const team = state.teams[teamId];
    if (!team) return;
    const branch = last ? "└─" : "├─";
    process.stdout.write(
      `${prefix}${branch} ${RANK_LABELS[team.leadRank]} · ${team.name} [${team.status}]\n`,
    );
    const childTeams = team.childTeamIds
      .map((id) => state.teams[id])
      .filter((child): child is NonNullable<typeof child> => Boolean(child))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const tasks = Object.values(state.tasks)
      .filter((task) => task.teamId === team.id)
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
    const entries = [
      ...childTeams.map((child) => ({ type: "team" as const, id: child.id })),
      ...tasks.map((task) => ({ type: "task" as const, id: task.id })),
    ];
    const nextPrefix = `${prefix}${last ? "   " : "│  "}`;
    entries.forEach((entry, index) => {
      const entryLast = index === entries.length - 1;
      if (entry.type === "team") {
        renderTeam(entry.id, nextPrefix, entryLast);
      } else {
        const task = state.tasks[entry.id]!;
        process.stdout.write(
          `${nextPrefix}${entryLast ? "└─" : "├─"} ${RANK_LABELS[task.assigneeRank]} · ${task.title} [${task.status}]\n`,
        );
      }
    });
  };
  renderTeam(root.id, "", true);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`luna-swarm: ${message}\n`);
  process.exitCode = 1;
});
