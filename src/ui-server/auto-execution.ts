import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, lstat, mkdir, mkdtemp, open, realpath, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { semanticCapabilityDemandForText } from "../dag.js";
import {
  loadSwarmCodingPolicy,
  parseSwarmCodingPolicy,
  type SwarmCodingPolicy,
} from "../coding/swarm-runtime.js";
import {
  ARTIFACT_FORMATS,
  type ArtifactFormat,
} from "../artifact-production/contracts.js";
import {
  loadArtifactProductionPolicy,
  parseArtifactProductionPolicy,
  type ArtifactProductionPolicy,
} from "../artifact-production/policy.js";
import { syncDirectory } from "../evolution/registry/durable-file.js";
import type { TaskCapability } from "../types.js";
import { extractUiSourceUrls, OperatorInputError } from "./operator-inputs.js";

const execFileAsync = promisify(execFile);
const CLASSIFIER_VERSION = "semantic-capability-v1" as const;
const CODING_POLICY_PATH = ".luna-swarm/coding-policy.json";
const ARTIFACT_POLICY_PATH = ".luna-swarm/artifact-policy.json";
const AUTO_TEST_PATTERN = /(?:^|\/)(?!hidden(?:\/|$))[^/]+\.(?:test|spec)\.(?:mjs|cjs|js)$/iu;
const AUTO_TYPESCRIPT_CONFIG_PATTERN = /(?:^|\/)tsconfig(?:\.[A-Za-z0-9_-]+)?\.json$/u;
const EXCLUDED_AUTOMATION_PATH_PATTERN = /(?:^|\/)(?:node_modules|dist|coverage|benchmarks?|results?)(?:\/|$)/iu;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type UiExecutionProfile = "standard" | "coding" | "artifact" | "combined";

export interface UiExecutionIntentV1 {
  schemaVersion: 1;
  classifierVersion: typeof CLASSIFIER_VERSION;
  profile: UiExecutionProfile;
  capabilities: readonly ("command-execution" | "external-network" | "workspace-write" | "artifact-render")[];
  requestedFormats: readonly ArtifactFormat[];
}

export interface PreparedUiExecution {
  intent: Readonly<UiExecutionIntentV1>;
  sourceUrls: readonly string[];
  codingPolicy?: Readonly<SwarmCodingPolicy>;
  artifactPolicy?: Readonly<ArtifactProductionPolicy>;
  policySources: Readonly<{
    coding?: "workspace" | "automatic";
    artifact?: "workspace" | "automatic";
  }>;
  activation?: Readonly<{ targetRef: string; baseCommit: string }>;
}

export class UiAutoExecutionError extends Error {
  constructor(
    readonly code:
      | "AUTO_EXECUTION_MODEL_UNSUPPORTED"
      | "AUTO_CODING_REPOSITORY_REQUIRED"
      | "AUTO_CODING_DIRTY_WORKTREE"
      | "AUTO_CODING_CHECK_REQUIRED"
      | "AUTO_CODING_TARGET_CONFLICT"
      | "AUTO_COMMAND_VERIFICATION_UNAVAILABLE"
      | "AUTO_ARTIFACT_FONT_REQUIRED"
      | "AUTO_INPUT_URL_INVALID"
      | "AUTO_WEB_RESEARCH_REQUIRED"
      | "AUTO_EXECUTION_POLICY_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "UiAutoExecutionError";
  }
}

/** Classifies authority needs without asking the model or accepting client-supplied policy. */
export function classifyUiExecutionGoal(goal: string): Readonly<UiExecutionIntentV1> {
  const normalized = goal.normalize("NFKC");
  const demanded = new Set<TaskCapability>(semanticCapabilityDemandForText(normalized));
  if (extractUiSourceUrls(normalized).length > 0) demanded.add("external-network");
  if (hasExplicitCodingRequest(normalized)) {
    demanded.add("command-execution");
    demanded.add("workspace-write");
  }
  const coding = demanded.has("workspace-write");
  const artifact = demanded.has("artifact-render");
  const capabilities: Array<"command-execution" | "external-network" | "workspace-write" | "artifact-render"> = [];
  if (coding) capabilities.push("command-execution");
  if (demanded.has("external-network")) capabilities.push("external-network");
  if (coding) capabilities.push("workspace-write");
  if (artifact) capabilities.push("artifact-render");
  return Object.freeze({
    schemaVersion: 1,
    classifierVersion: CLASSIFIER_VERSION,
    profile: coding && artifact ? "combined" : coding ? "coding" : artifact ? "artifact" : "standard",
    capabilities: Object.freeze(capabilities),
    requestedFormats: Object.freeze(artifact ? requestedArtifactFormats(normalized) : []),
  });
}

export async function prepareUiExecution(input: Readonly<{
  goal: string;
  workspace: string;
  runId: string;
  model: string;
  webResearchEnabled?: boolean;
}>): Promise<Readonly<PreparedUiExecution>> {
  let sourceUrls: readonly string[];
  try { sourceUrls = extractUiSourceUrls(input.goal); }
  catch (error) {
    if (error instanceof OperatorInputError) {
      throw new UiAutoExecutionError("AUTO_INPUT_URL_INVALID", error.message);
    }
    throw error;
  }
  const intent = classifyUiExecutionGoal(input.goal);
  if (sourceUrls.length > 0 && input.webResearchEnabled === false) {
    throw new UiAutoExecutionError(
      "AUTO_WEB_RESEARCH_REQUIRED",
      "링크를 읽으려면 config.webResearch.enabled가 true여야 합니다.",
    );
  }
  const demanded = new Set<TaskCapability>(semanticCapabilityDemandForText(input.goal.normalize("NFKC")));
  if (intent.profile === "standard" && demanded.has("command-execution")) {
    throw new UiAutoExecutionError(
      "AUTO_COMMAND_VERIFICATION_UNAVAILABLE",
      "명령 실행만 요청한 작업은 아직 Web UI의 보호된 command-verification 경로에 연결되지 않았습니다.",
    );
  }
  if (intent.profile === "standard") {
    return Object.freeze({ intent, sourceUrls, policySources: Object.freeze({}) });
  }
  if (input.model !== "gpt-5.6-luna") {
    throw new UiAutoExecutionError(
      "AUTO_EXECUTION_MODEL_UNSUPPORTED",
      `자동 코딩·파일 제작은 gpt-5.6-luna에 고정됩니다. 현재 모델: ${input.model}`,
    );
  }
  if (!SAFE_RUN_ID.test(input.runId)) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "자동 실행 runId가 안전한 형식이 아닙니다.");
  }
  const workspace = await realpath(input.workspace);
  let codingPolicy: Readonly<SwarmCodingPolicy> | undefined;
  let artifactPolicy: Readonly<ArtifactProductionPolicy> | undefined;
  let codingSource: "workspace" | "automatic" | undefined;
  let artifactSource: "workspace" | "automatic" | undefined;
  try {
    if (intent.profile === "coding" || intent.profile === "combined") {
      if (await exists(resolve(workspace, CODING_POLICY_PATH))) {
        codingPolicy = await prepareWorkspaceCodingPolicy(
          workspace,
          input.runId,
          input.goal,
          await loadSwarmCodingPolicy(CODING_POLICY_PATH, workspace),
        );
        codingSource = "workspace";
      } else {
        codingPolicy = await createAutomaticCodingPolicy(workspace, input.runId, input.goal);
        codingSource = "automatic";
      }
    }
    if (intent.profile === "artifact" || intent.profile === "combined") {
      if (await exists(resolve(workspace, ARTIFACT_POLICY_PATH))) {
        artifactPolicy = await loadArtifactProductionPolicy(ARTIFACT_POLICY_PATH, workspace);
        artifactSource = "workspace";
      } else {
        artifactPolicy = await createAutomaticArtifactPolicy(
          workspace,
          input.goal,
          intent.requestedFormats,
        );
        artifactSource = "automatic";
      }
    }
  } catch (error) {
    if (error instanceof UiAutoExecutionError) throw error;
    throw new UiAutoExecutionError(
      "AUTO_EXECUTION_POLICY_INVALID",
      `자동 실행 정책을 준비하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return Object.freeze({
    intent,
    sourceUrls,
    ...(codingPolicy ? { codingPolicy } : {}),
    ...(artifactPolicy ? { artifactPolicy } : {}),
    policySources: Object.freeze({
      ...(codingSource ? { coding: codingSource } : {}),
      ...(artifactSource ? { artifact: artifactSource } : {}),
    }),
    ...(codingPolicy ? { activation: Object.freeze({ targetRef: codingPolicy.targetRef, baseCommit: codingPolicy.baseCommit }) } : {}),
  });
}

/** Applies the only mutable coding preflight after the run and immutable markers exist. */
export async function activatePreparedUiExecution(
  workspace: string,
  prepared: Readonly<PreparedUiExecution>,
): Promise<void> {
  if (!prepared.activation) return;
  await ensureAutomaticTargetRef(await realpath(workspace), prepared.activation.targetRef, prepared.activation.baseCommit);
}

async function createAutomaticCodingPolicy(
  workspace: string,
  runId: string,
  goal: string,
): Promise<Readonly<SwarmCodingPolicy>> {
  let headCommit: string;
  try {
    headCommit = await gitText(workspace, ["rev-parse", "HEAD"]);
  } catch {
    throw new UiAutoExecutionError(
      "AUTO_CODING_REPOSITORY_REQUIRED",
      "자동 코딩에는 commit이 하나 이상 있는 Git 저장소가 필요합니다.",
    );
  }
  const filterOverrides = await safeGitFilterOverrides(workspace);
  const changedPaths = await snapshotChangedPaths(workspace, headCommit, filterOverrides);
  const baseCommit = changedPaths.length > 0
    ? await snapshotWorkingTree(workspace, inputSnapshotId(runId), headCommit, changedPaths)
    : headCommit;
  const files = (await gitText(workspace, ["ls-tree", "-r", "-z", "--name-only", baseCommit]))
    .split("\0")
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"));
  const testFiles = files.filter((path) => AUTO_TEST_PATTERN.test(path) && !EXCLUDED_AUTOMATION_PATH_PATTERN.test(path));
  const typescriptConfigs = files.filter((path) => AUTO_TYPESCRIPT_CONFIG_PATTERN.test(path) && !EXCLUDED_AUTOMATION_PATH_PATTERN.test(path));
  if (testFiles.length > 32 || typescriptConfigs.length > 8) {
    throw new UiAutoExecutionError(
      "AUTO_CODING_CHECK_REQUIRED",
      `자동 보호검사 한도(test 32, tsconfig 8)를 넘었습니다. ${CODING_POLICY_PATH}에 검증된 check 묶음을 저장하세요.`,
    );
  }
  const protectedInputs = [...testFiles, ...typescriptConfigs];
  if (protectedInputs.length === 0) {
    throw new UiAutoExecutionError(
      "AUTO_CODING_CHECK_REQUIRED",
      "자동 코딩에 사용할 tracked node:test 또는 TypeScript 프로젝트 설정이 없습니다. " +
        `${CODING_POLICY_PATH}에 보호 check가 고정된 정책을 저장하세요.`,
    );
  }
  const contextReferences = await Promise.all(protectedInputs.map(async (path) => {
    const bytes = Buffer.from(await gitText(workspace, ["show", `${baseCommit}:${path}`], false), "utf8");
    return {
      path,
      sha256: `sha256:${sha256(bytes)}` as const,
      purpose: AUTO_TYPESCRIPT_CONFIG_PATTERN.test(path)
        ? "Host-selected TypeScript syntax check configuration"
        : "Host-selected complete public node:test regression suite",
    };
  }));
  const writeScopes = automaticWriteScopes(files, protectedInputs);
  if (writeScopes.length === 0) {
    throw new UiAutoExecutionError(
      "AUTO_EXECUTION_POLICY_INVALID",
      "자동 코딩에서 보호 테스트와 겹치지 않는 안전한 쓰기 범위를 찾지 못했습니다.",
    );
  }
  const targetRef = `refs/heads/luna/auto/${runId}`;
  const policy = {
    baseCommit,
    targetRef,
    commitMessage: `luna: ${singleLine(goal).slice(0, 160)}`,
    objective: goal,
    requirementIds: ["REQ-UI-GOAL"],
    acceptanceCriteria: [{
      id: "AC-UI-GOAL",
      requirementIds: ["REQ-UI-GOAL"],
      statement: "The implementation satisfies the operator goal, preserves unrelated behavior, and passes the host-pinned protected check.",
    }],
    constraints: [
      "No network access, dependency installation, push, merge, or deployment.",
      "Do not modify .git, .luna-swarm, or the host-pinned protected check.",
      "Only the Single Committer may update the isolated candidate ref.",
    ],
    contextReferences,
    readScopes: ["./**"],
    writeScopes,
    checks: [
      ...(typescriptConfigs.length > 0
        ? [{ id: "auto-typescript-syntax", program: "luna:typescript-syntax" as const, testFiles: typescriptConfigs }]
        : []),
      ...(testFiles.length > 0
        ? [{ id: "auto-node-test-suite", program: "node:test" as const, testFiles }]
        : []),
    ],
    limits: { maxFiles: 128, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 },
    strategy: { mode: "repair", candidates: 2, maxSelectionRounds: 2 },
  };
  const parsed = parseSwarmCodingPolicy(policy);
  return parsed;
}

async function prepareWorkspaceCodingPolicy(
  workspace: string,
  runId: string,
  goal: string,
  source: Readonly<SwarmCodingPolicy>,
): Promise<Readonly<SwarmCodingPolicy>> {
  const currentHead = await gitText(workspace, ["rev-parse", "HEAD"]);
  if (source.baseCommit !== currentHead) {
    throw new UiAutoExecutionError(
      "AUTO_EXECUTION_POLICY_INVALID",
      `저장된 coding policy의 baseCommit이 현재 HEAD와 다릅니다. ${CODING_POLICY_PATH}를 현재 소스에 맞게 갱신하세요.`,
    );
  }
  const filterOverrides = await safeGitFilterOverrides(workspace);
  const changedPaths = await snapshotChangedPaths(workspace, currentHead, filterOverrides);
  const baseCommit = changedPaths.length > 0
    ? await snapshotWorkingTree(workspace, inputSnapshotId(runId), currentHead, changedPaths)
    : currentHead;
  const contextReferences = await Promise.all(source.contextReferences.map(async (reference) => {
    const bytes = Buffer.from(await gitText(workspace, ["show", `${baseCommit}:${reference.path}`], false), "utf8");
    return Object.freeze({ ...reference, sha256: `sha256:${sha256(bytes)}` as const });
  }));
  const targetRef = `refs/heads/luna/auto/${runId}`;
  const requirementIds = source.requirementIds.includes("REQ-UI-GOAL")
    ? [...source.requirementIds]
    : [...source.requirementIds, "REQ-UI-GOAL"];
  const acceptanceCriteria = source.acceptanceCriteria.some((criterion) => criterion.id === "AC-UI-GOAL")
    ? [...source.acceptanceCriteria]
    : [...source.acceptanceCriteria, {
        id: "AC-UI-GOAL",
        requirementIds: ["REQ-UI-GOAL"],
        statement: "The implementation satisfies the current operator goal and preserves the host policy invariants.",
      }];
  const policy = parseSwarmCodingPolicy({
    ...source,
    baseCommit,
    objective: goal,
    commitMessage: `luna: ${singleLine(goal).slice(0, 160)}`,
    requirementIds,
    acceptanceCriteria,
    contextReferences,
    targetRef,
  });
  return policy;
}

async function ensureAutomaticTargetRef(
  workspace: string,
  targetRef: string,
  baseCommit: string,
): Promise<void> {
  const existing = await resolveOptionalCommit(workspace, targetRef);
  if (existing !== undefined) {
    if (existing === baseCommit) return;
    throw new UiAutoExecutionError(
      "AUTO_CODING_TARGET_CONFLICT",
      `자동 코딩 후보 ref가 다른 commit을 가리킵니다: ${targetRef}`,
    );
  }
  const objectFormat = await gitText(workspace, ["rev-parse", "--show-object-format"]);
  const zero = "0".repeat(objectFormat === "sha256" ? 64 : 40);
  try {
    await gitText(workspace, ["update-ref", targetRef, baseCommit, zero]);
  } catch {
    throw new UiAutoExecutionError(
      "AUTO_CODING_TARGET_CONFLICT",
      `자동 코딩 후보 ref를 독점 생성하지 못했습니다: ${targetRef}`,
    );
  }
}

async function resolveOptionalCommit(workspace: string, ref: string): Promise<string | undefined> {
  try {
    return await gitText(workspace, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return undefined;
  }
}

async function createAutomaticArtifactPolicy(
  workspace: string,
  goal: string,
  requested: readonly ArtifactFormat[],
): Promise<Readonly<ArtifactProductionPolicy>> {
  const formats = requested.length > 0 ? [...requested] : ["pdf" as const];
  const needsTextFont = formats.includes("png") || (formats.includes("pdf") && /[^\u0000-\u007f]/u.test(goal));
  const fonts: Array<{ path: string; sha256: `sha256:${string}`; family: string }> = [];
  if (needsTextFont) {
    const staged = await stageLocalArtifactFont(workspace);
    if (!staged) {
      throw new UiAutoExecutionError(
        "AUTO_ARTIFACT_FONT_REQUIRED",
        "한국어 PDF 또는 글자가 있는 PNG를 만들 로컬 폰트를 찾지 못했습니다. " +
          `${ARTIFACT_POLICY_PATH}에 workspace font hash를 고정하세요.`,
      );
    }
    fonts.push(staged);
  }
  return parseArtifactProductionPolicy({
    schemaVersion: 1,
    allowedFormats: formats,
    allowedOutputNames: formats.map(defaultArtifactFileName),
    locale: /[가-힣]/u.test(goal) ? "ko-KR" : "en-US",
    timezone: "Asia/Seoul",
    limits: {
      outputs: formats.length,
      rowsPerDataset: 5_000,
      totalCells: 100_000,
      outputBytes: 64 * 1024 * 1024,
      width: 4_096,
      height: 4_096,
    },
    fonts,
    assets: [],
  });
}

function requestedArtifactFormats(goal: string): ArtifactFormat[] {
  const value = goal.toLocaleLowerCase("en-US");
  const present = new Set<ArtifactFormat>();
  if (/\bpdf\b/u.test(value)) present.add("pdf");
  if (/\b(?:docx|word\s+document)\b|(?:워드(?:\s*문서)?)/u.test(value)) present.add("docx");
  if (/\b(?:pptx|powerpoint|presentation|slide\s+deck|slides?)\b|(?:파워포인트|프레젠테이션|슬라이드(?:\s*덱)?)/u.test(value)) present.add("pptx");
  if (/\b(?:xlsx|excel|spreadsheet|workbook)\b|(?:엑셀|스프레드시트)/u.test(value)) present.add("xlsx");
  if (/\bcsv\b/u.test(value)) present.add("csv");
  if (/\bsvg\b/u.test(value)) present.add("svg");
  if (/\bpng\b/u.test(value)) present.add("png");
  return ARTIFACT_FORMATS.filter((format) => present.has(format));
}

function hasExplicitCodingRequest(goal: string): boolean {
  const value = goal.toLocaleLowerCase("en-US");
  if (/(?:코딩|코드\s*작성)(?:\s*(?:없이|하지\s*말|금지))/u.test(value) ||
      /\b(?:without|no)\s+cod(?:e|ing)\b|\bdo\s+not\s+(?:code|build|develop|implement)\b/u.test(value)) {
    return false;
  }
  const english = /\b(?:code|implement|develop|build)\b.{0,56}\b(?:dashboard|website|web\s*app|app|application|component|page|feature|code|repository|repo)\b/u;
  const korean = /(?:대시보드|웹\s*사이트|웹\s*앱|앱|애플리케이션|컴포넌트|페이지|기능|코드).{0,40}(?:코딩|구현|개발)(?:하|해|할|했|하고)|(?:코딩|구현|개발)(?:하|해|할|했|하고).{0,40}(?:대시보드|웹\s*사이트|웹\s*앱|앱|애플리케이션|컴포넌트|페이지|기능|코드)/u;
  return english.test(value) || korean.test(value);
}

function automaticWriteScopes(files: readonly string[], protectedInputs: readonly string[]): string[] {
  const scopes = [
    "src/**", "lib/**", "app/**", "packages/**", "ui/src/**", "public/**",
    "test/**", "tests/**", "docs/**", "examples/**", "scripts/**",
    "README.md", "CONTRIBUTING.md", "package.json", "package-lock.json",
    "tsconfig.json", "eslint.config.js",
  ];
  const present = scopes.filter((scope) => {
    if (scope.endsWith("/**")) {
      const base = scope.slice(0, -3);
      return files.some((path) => path === base || path.startsWith(`${base}/`));
    }
    return files.includes(scope);
  });
  const withoutProtectedOverlap = present.filter((scope) => {
    if (!scope.endsWith("/**")) return !protectedInputs.includes(scope);
    const base = scope.slice(0, -3);
    return !protectedInputs.some((path) => path === base || path.startsWith(`${base}/`));
  });
  return [...new Set(withoutProtectedOverlap)].sort();
}

async function stageLocalArtifactFont(
  workspace: string,
): Promise<{ path: string; sha256: `sha256:${string}`; family: string } | undefined> {
  const configured = process.env.LUNA_SWARM_ARTIFACT_FONT;
  const candidates = [
    ...(configured ? [{ path: configured, family: "Luna Artifact Font" }] : []),
    { path: "C:/Windows/Fonts/malgun.ttf", family: "Malgun Gothic" },
    { path: "/System/Library/Fonts/AppleSDGothicNeo.ttc", family: "Apple SD Gothic Neo" },
    { path: "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", family: "Noto Sans CJK" },
    { path: "/usr/share/fonts/truetype/noto/NotoSansKR-Regular.ttf", family: "Noto Sans KR" },
  ];
  const selected = await firstSafeFont(candidates);
  if (!selected) return undefined;
  const bytes = await readStableRegularFile(selected.path, 32 * 1024 * 1024, "Artifact font");
  if (!isSupportedFont(bytes)) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "자동 artifact font가 지원되는 OpenType/TrueType 파일이 아닙니다.");
  }
  const digest = sha256(bytes);
  const assetDirectory = await ensureWorkspaceAssetDirectory(workspace);
  const lowerPath = selected.path.toLocaleLowerCase("en-US");
  const extension = lowerPath.endsWith(".ttc") ? ".ttc" : lowerPath.endsWith(".otf") ? ".otf" : ".ttf";
  const target = resolve(assetDirectory, `${digest}${extension}`);
  await publishContentAddressedAsset(target, bytes);
  const published = await readStableRegularFile(target, 32 * 1024 * 1024, "Published artifact font");
  if (sha256(published) !== digest) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "고정된 artifact font hash가 일치하지 않습니다.");
  }
  const path = relative(workspace, target).replaceAll("\\", "/");
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "자동 artifact font 경로가 workspace를 벗어났습니다.");
  }
  return { path, sha256: `sha256:${digest}`, family: selected.family };
}

async function ensureWorkspaceAssetDirectory(workspace: string): Promise<string> {
  let cursor = workspace;
  for (const segment of [".luna-swarm", "artifact-assets", "sha256"]) {
    cursor = resolve(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "artifact asset 경로가 안전한 디렉터리가 아닙니다.");
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      try { await mkdir(cursor); }
      catch (createError) {
        if (!isNodeError(createError) || createError.code !== "EEXIST") throw createError;
      }
      const created = await lstat(cursor);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "artifact asset 디렉터리 생성이 다른 경로로 전환되었습니다.");
      }
    }
    const physical = await realpath(cursor);
    if (!samePath(physical, cursor) || !isPathContained(workspace, physical)) {
      throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "artifact asset 경로에 symlink 또는 junction이 있습니다.");
    }
  }
  return cursor;
}

async function publishContentAddressedAsset(target: string, bytes: Buffer): Promise<void> {
  if (await exists(target)) return;
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o400);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try { await link(temporary, target); }
    catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    }
    await unlink(temporary);
    await syncDirectory(dirname(target));
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function firstSafeFont(
  candidates: readonly { path: string; family: string }[],
): Promise<{ path: string; family: string } | undefined> {
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate.path);
      if (!/\.(?:ttf|ttc|otf)$/iu.test(canonical)) continue;
      const info = await lstat(canonical);
      if (info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 32 * 1024 * 1024) {
        return { path: canonical, family: candidate.family };
      }
    } catch {
      // Continue through the bounded local-only candidate list.
    }
  }
  return undefined;
}

function isSupportedFont(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  const signature = bytes.subarray(0, 4).toString("latin1");
  return signature === "OTTO" || signature === "ttcf" || signature === "true" || signature === "typ1" ||
    bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x01, 0x00, 0x00]));
}

async function readStableRegularFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || initial.size > maxBytes) {
    throw new Error(`${label} is unsafe`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
      throw new Error(`${label} changed while reading`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function defaultArtifactFileName(format: ArtifactFormat): string {
  if (format === "pdf") return "report.pdf";
  if (format === "docx") return "report.docx";
  if (format === "pptx") return "briefing.pptx";
  if (format === "xlsx") return "data.xlsx";
  if (format === "csv") return "data.csv";
  if (format === "svg") return "chart.svg";
  return "chart.png";
}

async function gitText(workspace: string, args: readonly string[], trim = true): Promise<string> {
  const result = await execFileAsync("git", [...args], {
    cwd: workspace,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: gitEnvironment(),
  });
  return trim ? result.stdout.trim() : result.stdout;
}

async function snapshotWorkingTree(
  workspace: string,
  snapshotId: string,
  parentCommit: string,
  changed: readonly string[],
): Promise<string> {
  const temporary = await mkdtemp(resolve(tmpdir(), "luna-ui-git-index-"));
  const indexPath = resolve(temporary, "index");
  const parentTimestampText = await gitText(workspace, ["show", "-s", "--format=%ct", parentCommit]);
  const parentTimestamp = Number.parseInt(parentTimestampText, 10);
  if (!Number.isSafeInteger(parentTimestamp) || parentTimestamp < 0) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "Git parent timestamp is invalid");
  }
  const date = `@${parentTimestamp + 1} +0000`;
  const environment: NodeJS.ProcessEnv = {
    ...gitEnvironment(),
    GIT_INDEX_FILE: indexPath,
    GIT_AUTHOR_NAME: "Luna UI Snapshot",
    GIT_AUTHOR_EMAIL: "luna-ui-snapshot@example.invalid",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Luna UI Snapshot",
    GIT_COMMITTER_EMAIL: "luna-ui-snapshot@example.invalid",
    GIT_COMMITTER_DATE: date,
  };
  try {
    await execFileAsync("git", ["read-tree", parentCommit], {
      cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
    });
    if (changed.length > 4_096) {
      throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "Dirty coding snapshot exceeds the 4096-file limit");
    }
    let totalBytes = 0;
    for (const path of changed) {
      const absolute = safeWorkspaceFile(workspace, path);
      let info: Awaited<ReturnType<typeof lstat>>;
      try {
        info = await lstat(absolute);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        await execFileAsync("git", ["update-index", "--force-remove", "--", path], {
          cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
        });
        continue;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        throw new UiAutoExecutionError(
          "AUTO_EXECUTION_POLICY_INVALID",
          `Dirty coding snapshot contains a non-regular or linked file: ${path}`,
        );
      }
      const bytes = await readStableRegularFile(absolute, 8 * 1024 * 1024, `Dirty coding file ${path}`);
      totalBytes += bytes.byteLength;
      if (totalBytes > 64 * 1024 * 1024) {
        throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "Dirty coding snapshot exceeds the 64 MiB limit");
      }
      const object = await hashGitBlob(workspace, environment, bytes);
      if (!/^[a-f0-9]{40,64}$/u.test(object)) {
        throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", `Git blob hash is invalid for ${path}`);
      }
      const indexedMode = await currentIndexMode(workspace, path);
      if (indexedMode === "120000" || indexedMode === "160000") {
        throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", `Dirty coding snapshot cannot replace a link or submodule: ${path}`);
      }
      const mode = process.platform === "win32"
        ? indexedMode ?? "100644"
        : (info.mode & 0o111) !== 0 ? "100755" : "100644";
      await execFileAsync("git", ["update-index", "--add", "--cacheinfo", mode, object, path], {
        cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
      });
    }
    const tree = (await execFileAsync("git", ["write-tree"], {
      cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
    })).stdout.trim();
    const commit = (await execFileAsync("git", ["commit-tree", tree, "-p", parentCommit, "-m", `luna-ui-snapshot:${snapshotId}`], {
      cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
    })).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/u.test(commit)) {
      throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "Git working-tree snapshot commit is invalid");
    }
    return commit;
  } catch (error) {
    if (error instanceof UiAutoExecutionError) throw error;
    throw new UiAutoExecutionError(
      "AUTO_EXECUTION_POLICY_INVALID",
      `현재 작업 내용을 안전한 coding base로 snapshot하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function snapshotChangedPaths(
  workspace: string,
  parentCommit: string,
  filterOverrides: readonly string[],
): Promise<string[]> {
  const environment = gitEnvironment();
  const [tracked, untracked] = await Promise.all([
    execFileAsync("git", [...filterOverrides, "-c", "core.fsmonitor=false", "diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", parentCommit, "--"], {
      cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
    }),
    execFileAsync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z", "--others", "--exclude-standard"], {
      cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: environment,
    }),
  ]);
  return [...new Set(`${tracked.stdout}${untracked.stdout}`.split("\0")
    .filter((path) => path.length > 0 && !EXCLUDED_AUTOMATION_PATH_PATTERN.test(path)))].sort();
}

async function safeGitFilterOverrides(workspace: string): Promise<string[]> {
  const listed = await execFileAsync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: gitEnvironment(),
  });
  const paths = listed.stdout.split("\0").filter(Boolean);
  if (paths.length > 100_000 || Buffer.byteLength(listed.stdout) > 16 * 1024 * 1024) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "Git attribute inspection exceeds its bounded input");
  }
  if (paths.length === 0) return [];
  const output = await runGitWithInput(
    workspace,
    ["check-attr", "-z", "--stdin", "filter"],
    gitEnvironment(),
    Buffer.from(`${paths.join("\0")}\0`, "utf8"),
    16 * 1024 * 1024,
    "Git filter attribute inspection",
  );
  const fields = output.toString("utf8").split("\0");
  const names = new Set<string>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const value = fields[index + 2];
    if (!value || value === "unspecified" || value === "unset" || value === "set") continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value)) {
      throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", "Git filter attribute name is unsafe");
    }
    names.add(value);
  }
  return [...names].sort().flatMap((name) => [
    "-c", `filter.${name}.clean=cat`,
    "-c", `filter.${name}.smudge=cat`,
    "-c", `filter.${name}.process=`,
    "-c", `filter.${name}.required=false`,
  ]);
}

async function hashGitBlob(workspace: string, environment: NodeJS.ProcessEnv, bytes: Buffer): Promise<string> {
  const output = await runGitWithInput(
    workspace,
    ["hash-object", "-w", "--stdin"],
    environment,
    bytes,
    64 * 1024,
    "Git blob hashing",
  );
  return output.toString("utf8").trim();
}

async function runGitWithInput(
  workspace: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input: Buffer,
  maxOutputBytes: number,
  label: string,
): Promise<Buffer> {
  return new Promise<Buffer>((resolveOutput, rejectOutput) => {
    const child = spawn("git", [...args], {
      cwd: workspace,
      env: environment,
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      rejectOutput(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOnce(new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", `${label} timed out`));
    }, 30_000);
    const collect = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        rejectOnce(new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", `${label} output exceeded its limit`));
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectOnce(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        rejectOnce(new UiAutoExecutionError(
          "AUTO_EXECUTION_POLICY_INVALID",
          `${label} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ));
        return;
      }
      settled = true;
      resolveOutput(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

function safeWorkspaceFile(workspace: string, path: string): string {
  if (
    path.includes("\\") || path.startsWith("/") || path.includes("\0") ||
    path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", `Git reported an unsafe dirty path: ${path}`);
  }
  const target = resolve(workspace, ...path.split("/"));
  if (!isPathContained(workspace, target)) {
    throw new UiAutoExecutionError("AUTO_EXECUTION_POLICY_INVALID", `Dirty coding path escaped the workspace: ${path}`);
  }
  return target;
}

async function currentIndexMode(workspace: string, path: string): Promise<string | undefined> {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "ls-files", "-s", "--", path], {
    cwd: workspace, encoding: "utf8", windowsHide: true, maxBuffer: 4096, env: gitEnvironment(),
  });
  const match = /^(100644|100755|120000|160000)\s/u.exec(result.stdout);
  return match?.[1];
}

function inputSnapshotId(runId: string): string {
  return sha256(runId).slice(0, 24);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC", "TMP", "TEMP", "LANG", "LC_ALL"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch { return false; }
}

export function isPathContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
