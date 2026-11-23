import assert from "node:assert/strict";
import test from "node:test";
import {
  approveIndependentIntegration,
  assertCandidateAdmissions,
  assertCandidateDiversity,
  assertDisjointGenesisSliceOwnership,
  assertSelfHostCodingPolicy,
  assertSingleCommitterAdmission,
  codingResumeDecision,
  createCandidateProfiles,
  createDeltaRepairWorkOrder,
  createSupportTfCharter,
  evaluateProtectedCheckMatrix,
  parseSwarmCodingPolicy,
  sealBlindOracle,
  type BlindOracleSeal,
  type CandidateAdmission,
  type CodingCandidateProfile,
  type CodingRepairFinding,
  type ProtectedCheckDefinition,
} from "../../src/coding/index.js";
import { canonicalJson, sha256 } from "../../src/coding/integrity.js";

const BASE = "a".repeat(40);
const HASH = (value: string): string => `sha256:${sha256(value)}`;

test("Engineering HQ v4 binds six support specialists and fresh isolated candidate profiles", () => {
  const charter = supportCharter();
  assert.deepEqual(charter.assignments.map((assignment) => assignment.role), [
    "reproducer", "mapper", "contract", "test", "failure", "history",
  ]);
  assert.equal(charter.supportArtifactHashes.length, 6);

  const profiles = candidateProfiles(charter.charterHash, charter);
  assert.deepEqual(profiles.map((profile) => profile.profile), ["surgical", "invariant", "compatibility", "adversarial"]);
  assert.equal(new Set(profiles.map((profile) => profile.profileHash)).size, 4);
  assert.ok(profiles.every((profile) => profile.baseCommit === BASE && profile.supportCharterHash === charter.charterHash));
  assert.deepEqual(profiles[0]!.forbiddenCandidateIds, ["candidate-b", "candidate-c", "candidate-d"]);
});

test("Blind Oracle is sealed before candidates and applies one complete protected check vector", () => {
  const charter = supportCharter();
  const profiles = candidateProfiles(charter.charterHash, charter);
  const seal = oracleSeal();
  const admissions = profiles.map((profile, index) => admission(profile, index + 3, HASH(`source-${index}`)));

  assert.doesNotThrow(() => assertCandidateAdmissions(seal, admissions));
  const outcomes = seal.checks.map((check) => ({
    id: check.id,
    kind: check.kind,
    outcome: "pass" as const,
    receiptHash: HASH(`receipt-${check.id}`),
  }));
  const result = evaluateProtectedCheckMatrix(seal, profiles[0]!.candidateId, outcomes);
  assert.equal(result.qualified, true);
  assert.equal(result.checkVectorHash, seal.checkVectorHash);

  assert.throws(
    () => evaluateProtectedCheckMatrix(seal, profiles[0]!.candidateId, outcomes.slice(1)),
    /matrix is incomplete/u,
  );
  assert.throws(
    () => assertCandidateAdmissions(seal, [{ ...admissions[0]!, candidateArtifactRevision: seal.artifact.revision }]),
    /pre-sealed exact-base Oracle/u,
  );
  assert.throws(
    () => assertCandidateAdmissions(seal, [{
      ...admissions[0]!,
      manifest: { schemaVersion: 1, baseCommit: BASE, changes: [{ path: "test/hidden.test.mjs", operation: "upsert", mode: "100644", contentUtf8: "leak" }] },
    }]),
    /overlaps protected Oracle scope/u,
  );
  assert.throws(
    () => assertCandidateAdmissions(seal, [{
      ...admissions[0]!,
      sourceBinding: {
        ...admissions[0]!.sourceBinding,
        verificationArtifacts: [{ artifactId: "leaked-candidate", revision: 3, contentHash: admissions[1]!.sourceBinding.sourceArtifact.contentHash }],
      },
    }, admissions[1]!]),
    /artifact leakage/u,
  );
});

test("failure-class delta repair stays bounded and independent integration gates Single Committer", () => {
  const charter = supportCharter();
  const candidate = candidateProfiles(charter.charterHash, charter)[0]!;
  const seal = oracleSeal();
  const finding = repairFinding("hidden-check");
  const repair = createDeltaRepairWorkOrder({
    candidate,
    failedCheck: seal.checks.find((check) => check.id === "hidden-check")!,
    finding,
  });
  assert.equal(repair.failureClass, "hidden-regression");
  assert.deepEqual(repair.forbiddenRawFields, ["stdout", "stderr", "prompt", "fileContents", "candidateArtifacts"]);
  assert.doesNotMatch(canonicalJson(repair), /secret output|raw bytes/iu);

  const matrix = evaluateProtectedCheckMatrix(seal, candidate.candidateId, seal.checks.map((check) => ({
    id: check.id, kind: check.kind, outcome: "pass", receiptHash: HASH(`pass-${check.id}`),
  })));
  const approval = approveIndependentIntegration({
    workOrderId: "integration-review-1",
    selectedCandidateId: candidate.candidateId,
    selectionHash: HASH("selection"),
    oracleSealHash: seal.sealHash,
    checkResultHash: matrix.resultHash,
  });
  assert.doesNotThrow(() => assertSingleCommitterAdmission(approval, candidate.candidateId, matrix));
  assert.throws(
    () => assertSingleCommitterAdmission(approval, "candidate-b", matrix),
    /exact independent integration approval/u,
  );
});

test("candidate diversity uses canonical hypothesis and patch clusters", () => {
  const tuples = [
    ["candidate-a", "surgical", "null branch", "parseValue", "missing input", "patch-a"],
    ["candidate-b", "invariant", "state invariant", "commit", "partial save", "patch-b"],
    ["candidate-c", "compatibility", "version skew", "decode", "legacy payload", "patch-c"],
    ["candidate-d", "adversarial", "path escape", "resolvePath", "dot-dot input", "patch-d"],
  ] as const;
  assert.equal(assertCandidateDiversity(tuples.map(([candidateId, profile, failureMechanism, affectedSymbol, triggeringCondition, patch]) => ({
    candidateId, profile, failureMechanism, affectedSymbol, triggeringCondition, patchHash: HASH(patch),
  }))), 4);
  assert.throws(() => assertCandidateDiversity(tuples.map(([candidateId, profile]) => ({
    candidateId,
    profile,
    failureMechanism: "same",
    affectedSymbol: "same",
    triggeringCondition: "same",
    patchHash: HASH("same"),
  }))), /only 1 distinct/u);
});

test("Genesis rejects overlapping slice ownership and self-host protects authority paths", () => {
  assert.doesNotThrow(() => assertDisjointGenesisSliceOwnership([
    { sliceId: "auth-slice", writeScopes: ["src/auth/**"] },
    { sliceId: "billing-slice", writeScopes: ["src/billing/**"] },
  ]));
  assert.throws(() => assertDisjointGenesisSliceOwnership([
    { sliceId: "api-slice", writeScopes: ["src/api/**"] },
    { sliceId: "shared-slice", writeScopes: ["src/**"] },
  ]), /ownership overlaps/u);

  const policy = {
    schemaVersion: 1 as const,
    enabled: true as const,
    baseCommit: BASE,
    candidateRef: "refs/heads/luna/self-host-candidate",
    forbiddenScopes: [".git/**", ".luna-swarm/**", ".omx/**", "benchmarks/**", "test/fixtures/self-host/**"],
    protectedTestScopes: ["test/protected/**"],
    evaluatorScopes: ["src/evolution/evaluator/**"],
  };
  assert.doesNotThrow(() => assertSelfHostCodingPolicy(policy, {
    schemaVersion: 1,
    baseCommit: BASE,
    changes: [{ path: "src/coding/strategy.ts", operation: "upsert", mode: "100644", contentUtf8: "safe" }],
  }));
  assert.throws(() => assertSelfHostCodingPolicy({ ...policy, candidateRef: "refs/heads/main" }), /never main\/master/u);
  assert.throws(() => assertSelfHostCodingPolicy(policy, {
    schemaVersion: 1,
    baseCommit: BASE,
    changes: [{ path: "src/evolution/evaluator/protected.ts", operation: "upsert", mode: "100644", contentUtf8: "reward hack" }],
  }), /protected authority/u);
});

test("resume decisions never replay a prepared Single Committer side effect", () => {
  assert.equal(codingResumeDecision({}), "execute");
  assert.equal(codingResumeDecision({ preparedIntentHash: HASH("intent") }), "reconcile-only");
  assert.equal(codingResumeDecision({ preparedIntentHash: HASH("intent"), completionHash: HASH("completion") }), "reuse-completed");
  assert.throws(() => codingResumeDecision({ completionHash: HASH("completion") }), /cannot exist without/u);
});

test("Swarm coding policy activates the v4 matrix and self-host boundaries fail closed", () => {
  const files = ["public", "hidden", "blind", "negative", "differential"].map((kind) => `test/protected/${kind}.test.mjs`);
  const policy = {
    baseCommit: BASE,
    targetRef: "refs/heads/luna/self-host-candidate",
    commitMessage: "Apply verified self-host candidate",
    objective: "Improve Luna Swarm through the protected company coding program",
    requirementIds: ["R1"],
    acceptanceCriteria: [{ id: "A1", requirementIds: ["R1"], statement: "All protected matrix checks pass" }],
    constraints: ["Single Committer only"],
    contextReferences: files.map((path) => ({ path, sha256: HASH(path), purpose: "Protected Oracle input" })),
    readScopes: ["./**"],
    writeScopes: ["src/**"],
    checks: ["public", "hidden", "blind", "negative", "differential"].map((kind, index) => ({
      id: `${kind}-check`, kind, testFiles: [files[index]],
    })),
    limits: { maxFiles: 8, maxFileBytes: 65_536, maxTotalBytes: 262_144 },
    engineeringV4: true,
    selfHost: {
      schemaVersion: 1,
      enabled: true,
      baseCommit: BASE,
      candidateRef: "refs/heads/luna/self-host-candidate",
      forbiddenScopes: [".git/**", ".luna-swarm/**", ".omx/**", "benchmarks/**", "test/fixtures/self-host/**"],
      protectedTestScopes: ["test/protected/**"],
      evaluatorScopes: ["src/evolution/evaluator/**"],
    },
  };
  const parsed = parseSwarmCodingPolicy(policy);
  assert.equal(parsed.engineeringV4, true);
  assert.deepEqual(parsed.checks.map((check) => check.kind), ["public", "hidden", "blind", "negative", "differential"]);
  assert.equal(parsed.selfHost?.candidateRef, policy.targetRef);

  assert.throws(() => parseSwarmCodingPolicy({
    ...policy,
    checks: policy.checks.slice(0, 4),
    contextReferences: policy.contextReferences.slice(0, 4),
  }), /missing differential/u);
  assert.throws(() => parseSwarmCodingPolicy({
    ...policy,
    selfHost: { ...policy.selfHost, candidateRef: "refs/heads/main" },
    targetRef: "refs/heads/main",
  }), /never main\/master/u);
});

function supportCharter() {
  return createSupportTfCharter(BASE, ["reproducer", "mapper", "contract", "test", "failure", "history"].map((role, index) => ({
    role: role as "reproducer" | "mapper" | "contract" | "test" | "failure" | "history",
    taskId: `support-${role}`,
    workOrderHash: HASH(`work-order-${role}`),
    artifactHashes: [HASH(`artifact-${index}`)],
  })));
}

function candidateProfiles(charterHash: string, charter: ReturnType<typeof supportCharter>): readonly Readonly<CodingCandidateProfile>[] {
  assert.equal(charter.charterHash, charterHash);
  return createCandidateProfiles(["a", "b", "c", "d"].map((suffix) => ({
    candidateId: `candidate-${suffix}`,
    workOrderHash: HASH(`candidate-work-order-${suffix}`),
    hypothesis: { mechanism: suffix, symbol: `symbol-${suffix}` },
  })), charter);
}

function oracleSeal(): Readonly<BlindOracleSeal> {
  const checks: ProtectedCheckDefinition[] = [
    { id: "public-check", kind: "public", testFiles: ["test/public.test.mjs"] },
    { id: "hidden-check", kind: "hidden", testFiles: ["test/hidden.test.mjs"] },
    { id: "blind-check", kind: "blind", testFiles: ["test/blind.test.mjs"] },
    { id: "negative-check", kind: "negative", testFiles: ["test/negative.test.mjs"] },
    { id: "differential-check", kind: "differential", testFiles: ["test/differential.test.mjs"] },
  ];
  return sealBlindOracle({
    artifact: { artifactId: "blind-oracle", revision: 2, contentHash: HASH("oracle") },
    baseCommit: BASE,
    authoredFromRevision: 1,
    protectedWriteScopes: ["test/**"],
    checks,
  });
}

function admission(profile: Readonly<CodingCandidateProfile>, revision: number, sourceHash: string): CandidateAdmission {
  return {
    candidateId: profile.candidateId,
    candidateArtifactRevision: revision,
    profile,
    sourceBinding: {
      runId: "run-v4",
      taskId: profile.candidateId,
      assignedAgentId: `luna-${profile.candidateId}`,
      sourceArtifact: { artifactId: `artifact-${profile.candidateId}`, revision, contentHash: sourceHash },
      verificationArtifacts: [{ artifactId: "support-proof", revision: 1, contentHash: HASH("support-proof") }],
    },
    manifest: {
      schemaVersion: 1,
      baseCommit: BASE,
      changes: [{ path: `src/${profile.candidateId}.ts`, operation: "upsert", mode: "100644", contentUtf8: "export {};\n" }],
    },
    candidateWriteScopes: ["src/**"],
    oracleSealHash: oracleSeal().sealHash,
  };
}

function repairFinding(subject: string): CodingRepairFinding {
  const material = {
    schemaVersion: 1 as const,
    stage: "check" as const,
    code: "CHECK_FAILED" as const,
    subject,
    executionAttempt: 1,
    attemptContextHash: sha256("attempt"),
    patchHash: sha256("patch"),
    manifestHash: sha256("manifest"),
    receiptHash: sha256("receipt"),
    evidenceHash: sha256("evidence"),
  };
  return { ...material, findingHash: sha256(canonicalJson(material)) };
}
