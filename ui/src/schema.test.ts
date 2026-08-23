import { describe, expect, it } from "vitest";
import { createMockSnapshot } from "./data/mock";
import { evidenceArtifactDetailSchema, snapshotSchema, socketEnvelopeSchema } from "./schema";

describe("UI transport schemas", () => {
  it("accepts a complete dashboard snapshot", () => {
    const snapshot = createMockSnapshot(30);
    const parsed = snapshotSchema.parse(snapshot);
    expect(parsed.agents).toHaveLength(30);
    expect(parsed.logicalAgents).toHaveLength(30);
    expect(parsed.reports.length).toBeGreaterThan(0);
    expect(parsed.reports.every((report) => report.sections.length > 0)).toBe(true);
    expect(new Set(parsed.logicalAgents.map((agent) => agent.id)).size).toBe(30);
    expect(parsed.logicalAgents.every((agent) => agent.lineage.length === 4)).toBe(true);
  });

  it("defaults reports for a legacy snapshot produced before the report registry", () => {
    const { reports: _reports, ...legacySnapshot } = createMockSnapshot(30);
    const parsed = snapshotSchema.parse(legacySnapshot);
    expect(parsed.reports).toEqual([]);
  });

  it("accepts optional Harness v2 organization, work-order, and council projections", () => {
    const snapshot = createMockSnapshot(4, 31);
    const parsed = snapshotSchema.parse({
      ...snapshot,
      organizationV2: {
        orgVersion: "lab-128@2",
        totalAgents: 31,
        headquarters: [{ id: "command", name: "Project Command HQ", allocation: 3 }],
        units: [{ id: "hq-command", name: "Project Command HQ", kind: "headquarters", headquartersId: "command", parentId: null, declaredHeadcount: 3 }],
      },
      workOrders: [{
        id: "WO-1", revision: 1, state: "VALIDATING", objective: "검증 가능한 결과 생성", owner: "team-core",
        reviewers: ["team-qa"], risk: "high", dependencies: [], gates: ["G0", "G1"], artifacts: ["artifact-1"],
      }],
      councils: [{
        id: "council-1", type: "architecture-review", state: "CLOSED", question: "설계를 채택할까?", round: 1,
        outcome: "ADOPTED", minorityCount: 1, blockingFindings: [],
      }],
      intelligenceV2: {
        preflight: { status: "ready", assumptions: 4, blockers: 0, risks: 2 },
        programKnowledge: { status: "ready", nodes: 42, edges: 77, omittedFiles: 3 },
        oracles: { suites: 1, oracles: 6, hidden: 1 },
        experiments: { preregistered: 1, observing: 0, decided: 0, observations: 0 },
        capsules: { total: 1, candidate: 1, verified: 0, stale: 0, revoked: 0, negative: 0 },
      },
      reportCenter: {
        executiveBrief: {
          directive: "검증 가능한 결과 생성", coveredRequirements: 0, totalRequirements: 1,
          unresolvedRisks: 1, approvalStatus: "needs-review",
        },
        staffing: { logical: 31, active: 1, inflight: 1, idle: 30, employees: [] },
        missionCells: [], departmentBoard: [], meetings: [], evidenceLedger: [], engineeringQuality: [], visualQa: [], artifacts: [],
        health: {
          activeAssignmentRate: 1 / 31, meetingCount: 0, meetingEvidenceCount: 0, handoffCount: 0,
          reworkCount: 0, reviewerIndependenceViolations: 0,
        },
      },
    });

    expect(parsed.logicalAgents).toHaveLength(31);
    expect(parsed.organizationV2?.totalAgents).toBe(31);
    expect(parsed.workOrders?.[0]?.gates).toEqual(["G0", "G1"]);
    expect(parsed.councils?.[0]?.minorityCount).toBe(1);
    expect(parsed.intelligenceV2?.experiments.observations).toBe(0);
    expect(parsed.intelligenceV2?.capsules.verified).toBe(0);
    expect(parsed.reportCenter?.executiveBrief.approvalStatus).toBe("needs-review");
  });

  it("rejects organization totals that do not match the logical roster", () => {
    const snapshot = createMockSnapshot(4, 31);
    const parsed = snapshotSchema.safeParse({
      ...snapshot,
      organizationV2: {
        orgVersion: "lab-128@2",
        totalAgents: 30,
        headquarters: [{ id: "command", name: "Project Command HQ", allocation: 30 }],
        units: [{ id: "hq:command", name: "Project Command HQ", kind: "headquarters", headquartersId: "command", parentId: null, declaredHeadcount: 30 }],
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts sequenced websocket events", () => {
    const event = createMockSnapshot(30).events[0]!;
    const parsed = socketEnvelopeSchema.parse({ type: "event", seq: 44, data: event });
    expect(parsed.type).toBe("event");
    expect("seq" in parsed && parsed.seq).toBe(44);
  });

  it("keeps only the public claim-citation-snapshot projection", () => {
    const hash = (character: string) => `sha256:${character.repeat(64)}`;
    const parsed = evidenceArtifactDetailSchema.parse({
      schemaVersion: 1,
      artifactRef: { artifactId: "research-envelope-task-1", revision: 1, contentHash: "a".repeat(64) },
      taskId: "task-1", workOrderId: "task-1", kind: "research", verificationStatus: "accepted",
      createdAt: "2026-08-23T00:00:00.000Z",
      claims: [{ claimId: "claim-1", claimText: "Quality reached 94 points", status: "supported", modality: "fact", claimHash: hash("1"), citations: [{
        citationHash: hash("2"), snapshotHash: hash("3"), sourceFamilyId: hash("4"), sourceIdentityHash: hash("5"),
        sourceUrl: "https://official.test/report", finalUrl: "https://official.test/report",
        spans: [{ startByte: 0, endByte: 18, quoteHash: hash("6"), quote: "Quality was 94." }],
      }] }],
      bodyUtf8: "RAW BODY MUST BE STRIPPED",
      sealedMemos: ["PRIVATE"],
    });
    expect(parsed.claims[0]?.citations[0]?.spans[0]?.quote).toBe("Quality was 94.");
    expect(parsed).not.toHaveProperty("bodyUtf8");
    expect(parsed).not.toHaveProperty("sealedMemos");
  });
});
