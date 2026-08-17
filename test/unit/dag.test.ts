import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  normalizeAndValidatePlan,
  recordsFromPlan,
  refreshTaskStates,
  semanticCapabilityDemandForText,
} from "../../src/dag.js";
import type { SwarmPlan, TaskSpec } from "../../src/types.js";

const baseTask: TaskSpec = {
  id: "A",
  title: "A",
  objective: "Do A",
  kind: "analyze",
  executionMode: "reasoning-only",
  requiredCapabilities: [],
  department: "strategy",
  ownerRole: "strategy_analyst",
  teamId: "ROOT",
  assigneeRank: "staff",
  dependencies: [],
  requirementIds: ["R1"],
  deliverable: "A result",
  acceptanceCriteria: ["A passes"],
  risk: "low",
  priority: 50,
  depth: 99,
  maxAttempts: 99,
};

function plan(tasks: TaskSpec[]): SwarmPlan {
  return {
    goal: "test",
    interpretation: "test",
    requirements: [{ id: "R1", text: "Requirement" }],
    assumptions: [],
    teams: [
      {
        id: "ROOT",
        name: "Root",
        mission: "Own test work",
        department: "executive",
        leadRole: "chief_of_staff",
        leadRank: "vice_chair",
        parentTeamId: null,
        requirementIds: ["R1"],
        synthesisCriteria: ["Preserve results"],
        priority: 100,
      },
    ],
    tasks,
    finalInstructions: "answer",
  };
}

test("normalizes depth and attempt budget in a diamond DAG", () => {
  const raw = plan([
    baseTask,
    { ...baseTask, id: "B", title: "B" },
    { ...baseTask, id: "C", title: "C", dependencies: ["A", "B"] },
    { ...baseTask, id: "D", title: "D", dependencies: ["C"] },
  ]);
  const normalized = normalizeAndValidatePlan(raw, DEFAULT_CONFIG);
  assert.deepEqual(
    normalized.tasks.map((task) => [task.id, task.depth]),
    [
      ["A", 0],
      ["B", 0],
      ["C", 1],
      ["D", 2],
    ],
  );
  assert.equal(normalized.tasks[0]?.maxAttempts, DEFAULT_CONFIG.maxAttempts);

  const highRisk = normalizeAndValidatePlan(plan([{
    ...baseTask,
    risk: "high",
    maxAttempts: 1,
  }]), { ...DEFAULT_CONFIG, maxAttempts: 3 });
  assert.equal(highRisk.tasks[0]?.maxAttempts, 3);

  const mediumRisk = normalizeAndValidatePlan(plan([{
    ...baseTask,
    risk: "medium",
    maxAttempts: 1,
  }]), { ...DEFAULT_CONFIG, maxAttempts: 3 });
  assert.equal(mediumRisk.tasks[0]?.maxAttempts, 2);

  const lowRisk = normalizeAndValidatePlan(plan([{
    ...baseTask,
    risk: "low",
    maxAttempts: 1,
  }]), { ...DEFAULT_CONFIG, maxAttempts: 3 });
  assert.equal(lowRisk.tasks[0]?.maxAttempts, 1);

  const explicitlyCapped = normalizeAndValidatePlan(plan([{
    ...baseTask,
    risk: "high",
    maxAttempts: 1,
  }]), { ...DEFAULT_CONFIG, maxAttempts: 1 });
  assert.equal(explicitlyCapped.tasks[0]?.maxAttempts, 1);
});

test("rejects cycles, missing dependencies, duplicates, and self-dependencies", () => {
  assert.throws(
    () =>
      normalizeAndValidatePlan(
        plan([
          { ...baseTask, dependencies: ["B"] },
          { ...baseTask, id: "B", title: "B", dependencies: ["A"] },
        ]),
        DEFAULT_CONFIG,
      ),
    /cycle/i,
  );
  assert.throws(
    () =>
      normalizeAndValidatePlan(
        plan([{ ...baseTask, dependencies: ["missing"] }]),
        DEFAULT_CONFIG,
      ),
    /missing dependency/i,
  );
  assert.throws(
    () => normalizeAndValidatePlan(plan([baseTask, { ...baseTask }]), DEFAULT_CONFIG),
    /duplicate task/i,
  );
  assert.throws(
    () =>
      normalizeAndValidatePlan(
        plan([{ ...baseTask, dependencies: ["A"] }]),
        DEFAULT_CONFIG,
      ),
    /itself/i,
  );
});

test("closed execution modes reject mismatched and semantically under-declared authority", () => {
  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      executionMode: "workspace-inspection",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /requires exactly.*workspace-read.*workspace-search/i,
  );

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "frontend-development",
      title: "Motion website",
      objective: "Implement and build an executable website in the workspace",
      deliverable: "Production-ready landing page",
      executionMode: "reasoning-only",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /under-declares execution authority.*command-execution.*workspace-write/i,
  );

  assert.doesNotThrow(() => normalizeAndValidatePlan(plan([{
    ...baseTask,
    kind: "local-evidence-review",
    objective: "Execute the declared read/search tools to inspect the supplied evidence",
    deliverable: "KPI benchmark comparison report",
    acceptanceCriteria: ["read/search 실행 결과로 네 문서를 확인한다"],
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
  }]), DEFAULT_CONFIG));

  assert.doesNotThrow(() => normalizeAndValidatePlan(plan([{
    ...baseTask,
    kind: "local-evidence-boundary",
    title: "외부 네트워크 비사용 근거 경계",
    objective: "제공된 네 문서에 한정해 외부 출처를 참조하지 않았음을 확인한다",
    deliverable: "외부 자료 비생성·비참조와 로컬 근거 파일명을 표시한 보고서",
    acceptanceCriteria: ["웹 검색 없이 작성되었고 외부 조회는 불가임을 명시한다"],
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
  }]), DEFAULT_CONFIG));

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "verification",
      objective: "Run the unit test suite and compile the workspace",
      executionMode: "workspace-inspection",
      requiredCapabilities: ["workspace-read", "workspace-search"],
    }]), DEFAULT_CONFIG),
    /under-declares execution authority.*command-execution/i,
  );

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "competitive-evidence-gathering",
      objective: "Verify current competitor sources on the web",
      executionMode: "reasoning-only",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /under-declares execution authority.*external-network/i,
  );

  assert.doesNotThrow(() => normalizeAndValidatePlan(plan([{
    ...baseTask,
    kind: "local-evidence-review",
    objective: "Read only the supplied workspace evidence and do not use external sources",
    deliverable: "외부 자료 미사용 여부를 포함한 로컬 근거 보고서",
    acceptanceCriteria: ["외부 자료를 사용하지 않았음을 검증한다"],
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
  }]), DEFAULT_CONFIG));

  assert.doesNotThrow(() => normalizeAndValidatePlan(plan([{
    ...baseTask,
    kind: "local-evidence-review",
    title: "제공된 네 문서의 최신 KPI와 공식 자료 표기 검토",
    objective: "evidence/ 내부 문서만 근거로 시장 조사 항목을 정리한다",
    deliverable: "문서 외 자료 사용 금지 준수표",
    acceptanceCriteria: ["외부 출처의 부재와 네 로컬 파일의 인용을 확인한다"],
    executionMode: "workspace-inspection",
    requiredCapabilities: ["workspace-read", "workspace-search"],
  }]), DEFAULT_CONFIG));

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "competitive-evidence-gathering",
      objective: "외부 자료를 검색하여 현재 시장을 검증한다",
      executionMode: "reasoning-only",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /under-declares execution authority.*external-network/i,
  );

  assert.throws(
    () => normalizeAndValidatePlan(plan([{
      ...baseTask,
      kind: "competitive-evidence-gathering",
      objective: "외부 출처를 조회하여 현재 시장 자료를 수집한다",
      executionMode: "reasoning-only",
      requiredCapabilities: [],
    }]), DEFAULT_CONFIG),
    /contract excerpt=.*외부 출처를 조회하여/u,
  );
});

test("original mission capability demand cannot be laundered by a restricted planner", () => {
  assert.deepEqual(
    semanticCapabilityDemandForText(
      "Compare other AI agents using current external sources and build a motion website",
    ),
    ["command-execution", "external-network", "workspace-write"],
  );
  assert.deepEqual(
    semanticCapabilityDemandForText(
      "Use only the supplied local evidence; do not use external sources and produce a read-only report",
    ),
    [],
  );
  for (const mission of [
    "readme 수정하고 메인에 커밋 푸시",
    "Edit README and commit it",
    "git commit and push the README update",
    "파일을 삭제해",
    "수정하지 말고 기존 변경사항만 커밋 푸시해",
    "Do not edit files and commit the existing changes",
    "새 README 파일을 만들어줘",
    "README에 사용법을 작성해줘",
    "파일을 추가해줘",
    "새 브랜치를 생성해줘",
    "Add a new test file",
    "Fix the failing tests",
    "Install the package",
    "Upgrade the dependency",
    "Open a pull request",
    "Create a pull request",
    "Format source code",
    "Generate a config file",
    "패키지를 설치해줘",
    "의존성을 업그레이드해줘",
    "PR을 생성해줘",
    "Write the analysis to README",
    "Create a report file",
    "Create a plan file",
    "Generate an assessment page",
    "Build a code review app",
    "Build a report website",
    "리뷰 웹사이트를 만들어줘",
    "보고서 파일을 생성해줘",
    "분석 결과를 README에 작성해줘",
    "Edit the repository",
    "Delete the repository",
    "Create the repository",
    "Edit the directory",
    "Delete the directory",
    "Create the directory",
    "Write the report to docs",
    "Write the analysis into documentation",
    "Create a review memo under docs",
  ]) {
    assert.deepEqual(
      semanticCapabilityDemandForText(mission),
      ["command-execution", "workspace-write"],
      mission,
    );
  }
  for (const mission of [
    "코드 수정 없이 현재 구현을 리뷰해줘",
    "Do not implement or change code; review only",
    "Review the current implementation without modifying files or running tests",
    "Create a read-only report from supplied evidence",
    "Develop recommendations without changing files",
    "Build an argument from the attached documents",
    "Apply the rubric to the final report",
    "Update me on the current status",
    "Write an analysis of the code",
    "Create a code review report",
    "Generate a test strategy for the application",
    "코드 리뷰 보고서를 작성해줘",
    "저장소 분석 보고서를 작성해줘",
    "애플리케이션 테스트 계획을 만들어줘",
    "README 개선안을 작성해줘",
    "Never modify the repository; create a code review report",
    "애플리케이션에 대한 분석 보고서를 작성해줘",
    "README에 관한 개선안을 작성해줘",
    "코드에 대한 리뷰를 작성해줘",
    "저장소에 대한 평가 보고서를 만들어줘",
    "Build a plan for the app",
    "Build a strategy for the application",
    "웹사이트를 테스트하지 말고 리뷰해줘",
    "컴포넌트를 테스트하지 않고 코드만 읽어줘",
    "애플리케이션을 테스트했던 기록을 요약해줘",
    "Test the website is not required",
    "Writing files is prohibited",
    "Editing the repository is not allowed",
    "Building the app is forbidden",
  ]) {
    assert.deepEqual(semanticCapabilityDemandForText(mission), [], mission);
  }
  for (const mission of [
    "테스트를 실행해줘",
    "테스트 돌려줘",
    "Test the existing changes",
    "Build",
    "Compile",
    "Typecheck",
    "Lint",
    "npm test",
    "pytest",
    "Run lint",
    "테스트해줘",
    "빌드해줘",
    "린트해줘",
    "타입체크해줘",
    "Run tests to generate a report",
    "Run the assessment tests",
    "테스트를 실행해서 보고서를 만들어줘",
    "Run the binary",
    "Execute the binary",
    "Test the website",
    "Test this component",
    "Test the API",
    "웹사이트를 테스트해줘",
    "컴포넌트를 테스트해줘",
  ]) {
    assert.deepEqual(semanticCapabilityDemandForText(mission), ["command-execution"], mission);
  }
});

test("a failed branch blocks descendants while an independent branch remains ready", () => {
  const normalized = normalizeAndValidatePlan(
    plan([
      baseTask,
      { ...baseTask, id: "B", title: "B", dependencies: ["A"] },
      { ...baseTask, id: "C", title: "C" },
    ]),
    DEFAULT_CONFIG,
  );
  const records = recordsFromPlan(normalized);
  records.A!.status = "failed";
  refreshTaskStates(records);
  assert.equal(records.B?.status, "blocked");
  assert.equal(records.C?.status, "ready");
});

test("dynamic reporting hierarchy requires descending ranks and useful managers", () => {
  const childTeam = {
    id: "CHILD",
    name: "Child",
    mission: "Child work",
    department: "strategy" as const,
    leadRole: "strategy_director",
    leadRank: "vice_chair" as const,
    parentTeamId: "ROOT",
    requirementIds: ["R1"],
    synthesisCriteria: ["Synthesize"],
    priority: 50,
  };
  const ranked = plan([
    baseTask,
    { ...baseTask, id: "B", title: "B", teamId: "CHILD" },
  ]);
  ranked.teams.push(childTeam);
  assert.throws(
    () => normalizeAndValidatePlan(ranked, DEFAULT_CONFIG),
    /rank.*report upward/i,
  );

  const unary = plan([{ ...baseTask, teamId: "CHILD" }]);
  unary.teams.push({ ...childTeam, leadRank: "president" });
  assert.throws(
    () => normalizeAndValidatePlan(unary, DEFAULT_CONFIG),
    /one-child management layer/i,
  );
});
