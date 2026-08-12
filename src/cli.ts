#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MockAgentBackend } from "./backend/mock-backend.js";
import { CodexAppServerBackend } from "./backend/codex-app-server.js";
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
} from "./store.js";
import { createDashboardServer, type DashboardCommand } from "./dashboard/server.js";
import type { JsonValue, RunDirective, RunEvent, RunState, SwarmConfig } from "./types.js";
import { SkillCatalog } from "./capabilities.js";
import { LearningStore } from "./learning.js";
import { LearningPolicyStore } from "./improvement.js";
import { DurableControlStore, ExecutionController } from "./controls/index.js";
import { UiRuntimeRegistry, type ManagedRunRuntime } from "./ui-server/runtime-registry.js";
import { UiObservationCoordinator } from "./ui-server/observation-coordinator.js";
import { MockUiRuntime } from "./ui-server/mock-runtime.js";
import type { UiControlCommand, UiControlResult } from "./ui-server/control-schema.js";
import {
  UiEventHub,
  attachUiEventWebSocketServer,
} from "./ui-events/index.js";

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (command === "init") return initConfig(args);
  if (command === "doctor") return doctor();
  if (command === "org") return printOrganization(args);
  if (command === "skills") return printSkills(args);
  if (command === "learning" || command === "learn") return printLearning(args);
  if (command === "status") return status(args);
  if (command === "dashboard") return dashboard(args);
  if (command === "ui") return ui(args);
  if (command === "run") return runNew(args);
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

  const startRun = async (command: Extract<UiControlCommand, { action: "start" }>): Promise<UiControlResult> => {
    if (activeRun) {
      return { accepted: false, code: "RUN_ALREADY_ACTIVE", message: "이 UI 서버가 이미 실행 하나를 소유하고 있습니다." };
    }
    const runId = makeRunId();
    const maxConcurrency = command.maxConcurrency ?? config.maxConcurrency;
    const runConfig: SwarmConfig = {
      ...config,
      maxConcurrency,
      initialConcurrency: Math.min(config.initialConcurrency, maxConcurrency),
    };
    validateConfig(runConfig);
    const store = new AtomicRunStore(workspace, runConfig.stateDirectory, runId);
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
          message: `운영자가 UI에서 새 실행을 승인했습니다: ${goalSummary}`,
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
    return { accepted: true, runId, message: command.mock ? "Mock Luna 실행을 시작했습니다." : "Luna 실행을 시작했습니다." };
  };

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
      if (mockRuntime) return mockRuntime.control(command);
      if (command.action === "start") return startRun(command);
      return registry.control(command);
    },
  });
  const webSockets = attachUiEventWebSocketServer(server.server, hub, {
    requireLoopback: isLoopbackBind(host),
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
      if (activeRun) {
        return {
          accepted: false,
          message: "A dashboard-started run is already active",
        };
      }
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
      const store = new AtomicRunStore(workspace, runConfig.stateDirectory, runId);
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
        });
      return {
        accepted: true,
        runId,
        message: command.mock ? "Mock run started" : "Luna run started",
      };
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
  const requiredAssets = [
    "index.html",
    "assets/employee-atlas-v2.png",
    "assets/hq/seated-workers-north.png",
    "assets/hq/seated-workers-south.png",
    "assets/hq/seated-workers-east.png",
  ];
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
  const store = new AtomicRunStore(workspace, config.stateDirectory, runId);
  await launch({ goal, workspace, config, store, mock: args.includes("--mock") });
}

async function resume(args: string[]): Promise<void> {
  const runId = positional(args)[0];
  if (!runId) throw new Error("Usage: luna-swarm resume <run-id>");
  const workspace = resolve(option(args, "--workspace") ?? process.cwd());
  const bootstrap = await loadConfig(option(args, "--config"), concurrencyOverrides(args));
  const store = new AtomicRunStore(workspace, bootstrap.stateDirectory, runId);
  const state = await store.load();
  const config: SwarmConfig = {
    ...DEFAULT_CONFIG,
    ...state.config,
    ...concurrencyOverrides(args),
    reasoning: {
      ...DEFAULT_CONFIG.reasoning,
      ...state.config.reasoning,
    },
  };
  validateConfig(config);
  await launch({
    goal: state.goal,
    workspace,
    config,
    store,
    mock: args.includes("--mock"),
    loaded: state,
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
}): Promise<void> {
  const releaseExecutionLease = options.releaseExecutionLease
    ?? await options.store.acquireExecutionLease();
  const backend: AgentBackend = options.mock
    ? new MockAgentBackend()
    : new CodexAppServerBackend({
        workspace: options.workspace,
        config: options.config,
        ...(process.env.LUNA_SWARM_CODEX_PATH
          ? { codexPath: process.env.LUNA_SWARM_CODEX_PATH }
          : {}),
        onStderr: (line) => {
          if (/error|warn/i.test(line)) process.stderr.write(`[codex] ${line}\n`);
        },
      });
  const controller = options.abortController ?? new AbortController();
  const controlStore = new DurableControlStore(options.store.runDirectory, options.store.runId, {
    initialConcurrencyCap: options.config.maxConcurrency,
  });
  const controls = new ExecutionController(controlStore, { abortController: controller });
  await controls.init();
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
  const onSignal = () => {
    process.stderr.write("\n취소 요청을 전달했습니다. 상태를 저장하는 중입니다…\n");
    void controls.cancel(new Error("Cancelled by process signal"));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let managedRuntime: ManagedRunRuntime | undefined;
  try {
    printBanner(options.store.runId, backend.info(), options.config);
    const orchestrator = new SwarmOrchestrator({
      gateway,
      store: options.store,
      config: options.config,
      workspace: options.workspace,
      onProgress: printEvent,
    });
    managedRuntime = {
      runId: options.store.runId,
      gateway,
      orchestrator,
      controls,
      store: options.store,
      configuredMaximum: options.config.maxConcurrency,
    };
    const state = options.loaded
      ? (await options.onRuntimeReady?.(managedRuntime), await orchestrator.resume(options.loaded, controller.signal))
      : await orchestrator.start(
          options.goal,
          controller.signal,
          () => options.onRuntimeReady?.(managedRuntime!),
        );
    printResult(state, options.store.finalPath, options.store.organizationPath);
    if (state.status === "failed") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    try {
      await backend.close();
    } finally {
      if (managedRuntime) options.onRuntimeDisposed?.(managedRuntime);
      await releaseExecutionLease();
    }
  }
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
    "--workspace",
    "--config",
    "--run-id",
    "--max-concurrency",
    "--initial-concurrency",
    "--port",
    "--host",
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

function printHelp(): void {
  process.stdout.write(`Luna Swarm — ChatGPT 로그인으로 Codex Luna 논리 에이전트를 조율합니다.

사용법:
  luna-swarm doctor
  luna-swarm dashboard [--workspace .] [--port 4310] [--open]
  luna-swarm ui [--workspace .] [--port 4310] [--mock] [--open]
  luna-swarm org [run-id]
  luna-swarm skills [--workspace .] [--json]
  luna-swarm learning [--workspace .] [--recent] [--rollback]
  luna-swarm init [config.json]
  luna-swarm run --goal "작업" [--workspace .] [--mock]
  luna-swarm resume <run-id> [--workspace .]
  luna-swarm status [run-id] [--workspace .]

옵션:
  --config <file>
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
