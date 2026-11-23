import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  activatePreparedUiExecution,
  classifyUiExecutionGoal,
  prepareUiExecution,
  UiAutoExecutionError,
} from "../../src/ui-server/auto-execution.js";
import { uiControlCommandSchema } from "../../src/ui-server/control-schema.js";
import {
  reserveUiStartRequest,
  uiStartRequestHash,
  UiRequestConflictError,
} from "../../src/ui-server/request-ledger.js";

const execFileAsync = promisify(execFile);

type ExpectedProfile = "standard" | "coding" | "artifact" | "combined";
type ExpectedCapability = "command-execution" | "external-network" | "workspace-write" | "artifact-render";
type ExpectedFormat = "pdf" | "docx" | "pptx" | "xlsx" | "csv" | "svg" | "png";

function expected(
  profile: ExpectedProfile,
  capabilities: ExpectedCapability[],
  requestedFormats: ExpectedFormat[] = [],
) {
  return {
    schemaVersion: 1 as const,
    classifierVersion: "semantic-capability-v1" as const,
    profile,
    capabilities,
    requestedFormats,
  };
}

test("classifies a Korean analysis-only request as standard execution", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("이 저장소의 구조를 분석하고 개선점을 보고해줘"),
    expected("standard", []),
  );
});

test("classifies an English analysis-only request as standard execution", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("Analyze the architecture and explain the risks"),
    expected("standard", []),
  );
});

test("records host-mediated internet authority only when the natural-language goal requests it", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("인터넷에서 타 AI 에이전트의 최신 공식 자료를 조사해줘"),
    expected("standard", ["external-network"]),
  );
  assert.deepEqual(
    classifyUiExecutionGoal("Use only the supplied local evidence; do not browse the web"),
    expected("standard", []),
  );
  assert.deepEqual(
    classifyUiExecutionGoal(
      "이 루나 스웜의 장점을 타 AI 에이전트와 비교해서 조사하고 그 장점을 잘 부각한 모션그래픽 웹사이트를 제작해줘",
    ),
    expected("coding", ["command-execution", "external-network", "workspace-write"]),
  );
});

test("classifies a Korean implementation request as coding execution", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("로그인 버그를 고치고 테스트도 실행해줘"),
    expected("coding", ["command-execution", "workspace-write"]),
  );
});

test("classifies an English implementation request as coding execution", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("Implement the feature and update the tests"),
    expected("coding", ["command-execution", "workspace-write"]),
  );
});

test("classifies a Korean document request as artifact execution with normalized formats", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("분기별 품질 보고서를 PDF와 Excel로 만들어줘"),
    expected("artifact", ["artifact-render"], ["pdf", "xlsx"]),
  );
});

test("classifies an English document request as artifact execution with normalized formats", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("Create a PDF report and an Excel workbook"),
    expected("artifact", ["artifact-render"], ["pdf", "xlsx"]),
  );
});

test("classifies explicit Word and presentation requests as DOCX and PPTX", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("회의 결과를 워드 문서와 파워포인트 슬라이드로 만들어줘"),
    expected("artifact", ["artifact-render"], ["docx", "pptx"]),
  );
  assert.deepEqual(
    classifyUiExecutionGoal("Create a DOCX report and a PPTX presentation"),
    expected("artifact", ["artifact-render"], ["docx", "pptx"]),
  );
});

test("classifies a Korean coding and document request as combined execution", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("대시보드를 코딩하고 결과 보고서를 PDF로 만들어줘"),
    expected("combined", ["command-execution", "workspace-write", "artifact-render"], ["pdf"]),
  );
});

test("classifies an English coding and export request as combined execution", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("Build the dashboard and export the results as PDF and XLSX"),
    expected("combined", ["command-execution", "workspace-write", "artifact-render"], ["pdf", "xlsx"]),
  );
});

test("honors a Korean prohibition on code changes before positive coding vocabulary", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("코드는 수정하지 말고 문제만 분석해줘"),
    expected("standard", []),
  );
});

test("honors an English prohibition on file changes before positive bug vocabulary", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("Do not change files; only explain the bug"),
    expected("standard", []),
  );
});

test("excludes a negated Korean PDF request while retaining the coding request", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("PDF는 만들지 말고 코드만 수정해줘"),
    expected("coding", ["command-execution", "workspace-write"]),
  );
});

test("excludes a negated English code request while retaining the PDF request", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("Don't edit code; create only a PDF report"),
    expected("artifact", ["artifact-render"], ["pdf"]),
  );
});

test("does not treat a PDF feature name as a request to render an artifact", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("PDF 생성 기능의 버그를 고쳐줘"),
    expected("coding", ["command-execution", "workspace-write"]),
  );
});

test("does not treat a negated coding mention as a coding request", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("코딩 없이 PDF만 만들어줘"),
    expected("artifact", ["artifact-render"], ["pdf"]),
  );
});

test("does not treat a Korean file-structure explanation as a write request", () => {
  assert.deepEqual(
    classifyUiExecutionGoal("파일을 수정하지 말고 파일 구조만 설명해줘"),
    expected("standard", []),
  );
});

test("builds an automatic artifact policy without exposing UI options", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-ui-auto-artifact-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const prepared = await prepareUiExecution({
    goal: "Create a PDF report and Excel workbook",
    workspace,
    runId: "run-artifact",
    model: "gpt-5.6-luna",
  });
  assert.equal(prepared.intent.profile, "artifact");
  assert.equal(prepared.policySources.artifact, "automatic");
  assert.deepEqual(prepared.artifactPolicy?.allowedFormats, ["pdf", "xlsx"]);
  assert.deepEqual(prepared.artifactPolicy?.allowedOutputNames, ["report.pdf", "data.xlsx"]);
  assert.equal(prepared.codingPolicy, undefined);
});

test("builds an automatic DOCX and PPTX policy with deterministic output names", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-ui-auto-office-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const prepared = await prepareUiExecution({
    goal: "Create a DOCX report and a PPTX presentation",
    workspace,
    runId: "run-office-artifacts",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(prepared.artifactPolicy?.allowedFormats, ["docx", "pptx"]);
  assert.deepEqual(prepared.artifactPolicy?.allowedOutputNames, ["report.docx", "briefing.pptx"]);
});

test("builds a protected automatic coding policy and a dedicated candidate ref", async (t) => {
  const workspace = await cleanCodingRepository(t);
  const prepared = await prepareUiExecution({
    goal: "Implement the feature and update the code",
    workspace,
    runId: "run-coding",
    model: "gpt-5.6-luna",
  });
  assert.equal(prepared.intent.profile, "coding");
  assert.equal(prepared.policySources.coding, "automatic");
  assert.deepEqual(prepared.codingPolicy?.checks, [{
    id: "auto-node-test-suite",
    program: "node:test",
    testFiles: ["test/public.test.mjs"],
  }]);
  assert.equal(prepared.codingPolicy?.strategy?.mode, "repair");
  assert.equal(prepared.codingPolicy?.strategy && "candidates" in prepared.codingPolicy.strategy
    ? prepared.codingPolicy.strategy.candidates
    : undefined, 2);
  await assert.rejects(() => git(workspace, ["rev-parse", "refs/heads/luna/auto/run-coding"]));
  await activatePreparedUiExecution(workspace, prepared);
  const target = await git(workspace, ["rev-parse", "refs/heads/luna/auto/run-coding"]);
  assert.equal(target, prepared.codingPolicy?.baseCommit);
});

test("snapshots a dirty worktree without changing the operator index or checkout", async (t) => {
  const workspace = await cleanCodingRepository(t);
  const head = await git(workspace, ["rev-parse", "HEAD"]);
  await writeFile(join(workspace, "src", "index.js"), "export const value = 2;\n", "utf8");
  const statusBefore = await git(workspace, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  const runDirectory = join(workspace, ".luna-swarm", "runs", "run-dirty");
  const prepared = await prepareUiExecution({
    goal: "Fix the feature",
    workspace,
    runId: "run-dirty",
    model: "gpt-5.6-luna",
  });
  assert.notEqual(prepared.codingPolicy?.baseCommit, head);
  assert.equal(await git(workspace, ["show", `${prepared.codingPolicy?.baseCommit}:src/index.js`]), "export const value = 2;");
  assert.equal(await git(workspace, ["rev-parse", "HEAD"]), head);
  assert.equal(await git(workspace, ["status", "--porcelain=v1", "--untracked-files=normal"]), statusBefore);
  await activatePreparedUiExecution(workspace, prepared);
  assert.equal(await git(workspace, ["rev-parse", "refs/heads/luna/auto/run-dirty"]), prepared.codingPolicy?.baseCommit);
  await assert.rejects(() => access(runDirectory));
});

test("dirty snapshot never executes repository-configured Git clean filters", async (t) => {
  const workspace = await cleanCodingRepository(t);
  await writeFile(join(workspace, ".gitattributes"), "src/index.js filter=blocked\n", "utf8");
  await git(workspace, ["add", ".gitattributes"]);
  await git(workspace, ["-c", "user.name=Luna Test", "-c", "user.email=luna@example.invalid", "commit", "-m", "attributes"]);
  await git(workspace, ["config", "filter.blocked.clean", "false"]);
  await git(workspace, ["config", "filter.blocked.required", "true"]);
  await writeFile(join(workspace, "src", "index.js"), "export const value = 3;\n", "utf8");

  const prepared = await prepareUiExecution({
    goal: "Fix the feature",
    workspace,
    runId: "run-no-clean-filter",
    model: "gpt-5.6-luna",
  });

  assert.equal(
    await git(workspace, ["show", `${prepared.codingPolicy?.baseCommit}:src/index.js`]),
    "export const value = 3;",
  );
});

test("prepares both runtimes for a combined natural-language request", async (t) => {
  const workspace = await cleanCodingRepository(t);
  const prepared = await prepareUiExecution({
    goal: "Build the dashboard and export the result as PDF",
    workspace,
    runId: "run-combined",
    model: "gpt-5.6-luna",
  });
  assert.equal(prepared.intent.profile, "combined");
  assert.ok(prepared.codingPolicy);
  assert.ok(prepared.artifactPolicy);
  assert.deepEqual(prepared.artifactPolicy.allowedOutputNames, ["report.pdf"]);
});

test("keeps the Web UI start payload optionless and rejects client-supplied execution policy", () => {
  assert.equal(uiControlCommandSchema.safeParse({
    action: "start",
    goal: "Fix the bug and export a PDF",
    requestId: "123e4567-e89b-12d3-a456-426614174000",
  }).success, true);
  assert.equal(uiControlCommandSchema.safeParse({
    action: "start",
    goal: "Fix the bug",
    mode: "coding",
  }).success, false);
  assert.equal(uiControlCommandSchema.safeParse({
    action: "start",
    goal: "Fix the bug",
    codingPolicy: { writeScopes: ["./**"] },
  }).success, false);
  assert.equal(uiControlCommandSchema.safeParse({ action: "recover", runId: "run-interrupted" }).success, true);
});

test("rejects a command-only request before model launch instead of silently routing it as analysis", async (t) => {
  const workspace = await cleanCodingRepository(t);
  await assert.rejects(
    () => prepareUiExecution({
      goal: "코드를 읽고 테스트만 실행해줘",
      workspace,
      runId: "command-only",
      model: "gpt-5.6-luna",
    }),
    (error: unknown) => error instanceof UiAutoExecutionError && error.code === "AUTO_COMMAND_VERIFICATION_UNAVAILABLE",
  );
});

test("rejects a stale saved coding policy and rebinds a current policy to the new goal", async (t) => {
  const workspace = await cleanCodingRepository(t);
  const seed = await prepareUiExecution({
    goal: "Implement the seed feature",
    workspace,
    runId: "seed-run",
    model: "gpt-5.6-luna",
  });
  assert.ok(seed.codingPolicy);
  await writeFile(join(workspace, "src", "index.js"), "export const value = 2;\n", "utf8");
  await git(workspace, ["add", "src/index.js"]);
  await git(workspace, ["-c", "user.name=Luna Test", "-c", "user.email=luna@example.invalid", "commit", "-m", "advance"]);
  const advanced = await git(workspace, ["rev-parse", "HEAD"]);
  await git(workspace, ["update-ref", seed.codingPolicy.targetRef, advanced]);
  await mkdir(join(workspace, ".luna-swarm"), { recursive: true });
  await writeFile(
    join(workspace, ".luna-swarm", "coding-policy.json"),
    `${JSON.stringify(seed.codingPolicy, null, 2)}\n`,
    "utf8",
  );

  const input = {
    goal: "Implement another feature",
    workspace,
    runId: "saved-run",
    model: "gpt-5.6-luna",
  } as const;
  await assert.rejects(
    () => prepareUiExecution(input),
    (error: unknown) => error instanceof UiAutoExecutionError && error.code === "AUTO_EXECUTION_POLICY_INVALID",
  );
  await writeFile(
    join(workspace, ".luna-swarm", "coding-policy.json"),
    `${JSON.stringify({ ...seed.codingPolicy, baseCommit: advanced }, null, 2)}\n`,
    "utf8",
  );
  const first = await prepareUiExecution(input);
  const replay = await prepareUiExecution(input);
  assert.equal(first.policySources.coding, "workspace");
  assert.equal(first.codingPolicy?.targetRef, "refs/heads/luna/auto/saved-run");
  assert.ok(first.codingPolicy?.baseCommit);
  if (first.codingPolicy.baseCommit !== advanced) {
    assert.equal(await git(workspace, ["rev-parse", `${first.codingPolicy.baseCommit}^`]), advanced);
  }
  assert.equal(first.codingPolicy?.objective, input.goal);
  assert.ok(first.codingPolicy?.requirementIds.includes("REQ-UI-GOAL"));
  assert.deepEqual(replay.codingPolicy, first.codingPolicy);
  await activatePreparedUiExecution(workspace, first);
  await activatePreparedUiExecution(workspace, replay);
  assert.equal(
    await git(workspace, ["rev-parse", "refs/heads/luna/auto/saved-run"]),
    first.codingPolicy.baseCommit,
  );
});

test("builds a host-pinned TypeScript syntax check when a repository has no JavaScript tests", async (t) => {
  const workspace = await cleanTypeScriptRepository(t);
  const prepared = await prepareUiExecution({
    goal: "Implement the TypeScript feature",
    workspace,
    runId: "typescript-run",
    model: "gpt-5.6-luna",
  });
  assert.deepEqual(prepared.codingPolicy?.checks, [{
    id: "auto-typescript-syntax",
    program: "luna:typescript-syntax",
    testFiles: ["tsconfig.json"],
  }]);
  assert.equal(prepared.codingPolicy?.contextReferences[0]?.path, "tsconfig.json");
});

test("durably replays a UI request id across process-local gate loss and rejects a different body", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "luna-ui-request-ledger-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const requestId = "11111111-1111-4111-8111-111111111111";
  const requestHash = uiStartRequestHash({
    goal: "Implement the feature",
    mock: false,
    maxConcurrency: 4,
    model: "gpt-5.6-luna",
  });
  const first = await reserveUiStartRequest({ workspace, requestId, requestHash, proposedRunId: "run-first" });
  const replay = await reserveUiStartRequest({ workspace, requestId, requestHash, proposedRunId: "run-second" });
  assert.equal(first.replay, false);
  assert.equal(replay.replay, true);
  assert.equal(replay.record.runId, "run-first");
  await assert.rejects(
    () => reserveUiStartRequest({
      workspace,
      requestId,
      requestHash: uiStartRequestHash({
        goal: "A different feature",
        mock: false,
        maxConcurrency: 4,
        model: "gpt-5.6-luna",
      }),
      proposedRunId: "run-third",
    }),
    (error: unknown) => error instanceof UiRequestConflictError && error.code === "IDEMPOTENCY_CONFLICT",
  );
});

async function cleanCodingRepository(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "luna-ui-auto-code-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(join(workspace, "src", "index.js"), "export const value = 1;\n", "utf8");
  await writeFile(
    join(workspace, "test", "public.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("value",()=>assert.equal(1,1));\n',
    "utf8",
  );
  await git(workspace, ["init", "-b", "main"]);
  await git(workspace, ["add", "."]);
  await git(workspace, ["-c", "user.name=Luna Test", "-c", "user.email=luna@example.invalid", "commit", "-m", "fixture"]);
  return workspace;
}

async function cleanTypeScriptRepository(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "luna-ui-auto-typescript-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), '{"type":"module"}\n', "utf8");
  await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
    compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true },
    include: ["src/**/*.ts", "test/**/*.ts"],
  }), "utf8");
  await writeFile(join(workspace, "src", "index.ts"), "export const value: number = 1;\n", "utf8");
  await writeFile(join(workspace, "test", "public.test.ts"), "export const fixture: string = 'ok';\n", "utf8");
  await git(workspace, ["init", "-b", "main"]);
  await git(workspace, ["add", "."]);
  await git(workspace, ["-c", "user.name=Luna Test", "-c", "user.email=luna@example.invalid", "commit", "-m", "fixture"]);
  return workspace;
}

async function git(workspace: string, args: readonly string[]): Promise<string> {
  return (await execFileAsync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
  })).stdout.trim();
}
