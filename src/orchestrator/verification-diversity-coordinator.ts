import type { BackendInfo } from "../backend/agent-backend.js";
import { canonicalSha256 } from "../evolution/domain/canonical.js";
import type {
  ArtifactRef,
  ArtifactRevision,
  ProgramKnowledgeSummary,
  WorkOrderRisk,
} from "../harness-v2/contracts.js";
import {
  assessVerificationDiversity,
  createVerificationExecutionEvidence,
  type VerificationDiversityArtifactContent,
} from "../harness-v2/verification-diversity.js";

export interface DiversityVoteBinding {
  artifact: ArtifactRef;
  agentId: string;
  teamId: string;
  verdict: "accept" | "revise" | "reject";
}

/**
 * Builds verification diversity only from host-owned immutable identities.
 * Agent prose never supplies verifier, model, prompt-family, context, or source
 * bindings used by the assessment.
 */
export class VerificationDiversityCoordinator {
  build(input: {
    risk: WorkOrderRisk;
    outputArtifact: ArtifactRevision;
    backend: BackendInfo;
    oracleGateArtifact: ArtifactRef;
    oracleReceiptHash: string;
    oraclePassed: boolean;
    verifierTeamId: string;
    redTeam: DiversityVoteBinding;
    workspace?: DiversityVoteBinding;
    programKnowledge?: ProgramKnowledgeSummary;
  }): VerificationDiversityArtifactContent {
    const outputRef = toRef(input.outputArtifact);
    const artifactRevisionHash = canonicalSha256(outputRef);
    const modelBuildHash = canonicalSha256({
      name: input.backend.name,
      model: input.backend.model,
      transport: input.backend.transport,
    });
    const author = input.outputArtifact.createdBy;
    const executions = [
      createVerificationExecutionEvidence({
        method: "deterministic-oracle",
        verifierAgentId: "system-oracle:evaluator",
        verifierTeamId: input.verifierTeamId,
        authorAgentId: author.agentId,
        authorTeamId: author.teamId,
        artifactRevisionHash,
        modelBuildHash,
        promptFamilyHash: canonicalSha256("verification/deterministic-oracle/v1"),
        contextPackHash: canonicalSha256({
          kind: "sealed-oracle-context/v1",
          output: outputRef,
          gate: input.oracleGateArtifact,
          receiptHash: input.oracleReceiptHash,
        }),
        toolReceiptHashes: [canonicalSha256({
          kind: "oracle-receipt/v1",
          gate: input.oracleGateArtifact,
          receiptHash: input.oracleReceiptHash,
        })],
        outcome: input.oraclePassed ? "pass" : "fail",
        oracleReceiptHash: canonicalSha256(input.oracleReceiptHash),
      }),
      createVerificationExecutionEvidence({
        method: "artifact-only-adversarial",
        verifierAgentId: input.redTeam.agentId,
        verifierTeamId: input.redTeam.teamId,
        authorAgentId: author.agentId,
        authorTeamId: author.teamId,
        artifactRevisionHash,
        modelBuildHash,
        promptFamilyHash: canonicalSha256("verification/red-team-artifact-only/v1"),
        contextPackHash: canonicalSha256({
          kind: "red-team-artifact-only-context/v1",
          output: outputRef,
          vote: input.redTeam.artifact,
        }),
        toolReceiptHashes: [],
        outcome: input.redTeam.verdict === "accept" ? "pass" : "fail",
      }),
      ...this.workspaceExecution({
        ...input,
        outputRef,
        artifactRevisionHash,
        modelBuildHash,
        authorAgentId: author.agentId,
        authorTeamId: author.teamId,
      }),
    ];
    const assessment = assessVerificationDiversity({
      risk: input.risk,
      artifactRevisionHash,
      executions,
    });
    return Object.freeze({
      schemaVersion: 1,
      reviewedArtifact: outputRef,
      bindings: Object.freeze({
        oracleGateArtifact: { ...input.oracleGateArtifact },
        redTeamVoteArtifact: { ...input.redTeam.artifact },
        ...(input.workspace ? { workspaceVoteArtifact: { ...input.workspace.artifact } } : {}),
      }),
      executions: Object.freeze(executions),
      assessment,
    });
  }

  private workspaceExecution(input: {
    workspace?: DiversityVoteBinding;
    programKnowledge?: ProgramKnowledgeSummary;
    outputRef: ArtifactRef;
    artifactRevisionHash: ReturnType<typeof canonicalSha256>;
    modelBuildHash: ReturnType<typeof canonicalSha256>;
    authorAgentId: string;
    authorTeamId: string;
  }) {
    const sourceIdentity = input.programKnowledge?.sourceIdentity;
    const graphHash = input.programKnowledge?.graphHash;
    if (!input.workspace || !sourceIdentity || !graphHash) return [];
    const sourceReceiptHash = canonicalSha256({
      kind: "program-knowledge-source-receipt/v1",
      sourceIdentity,
      graphHash,
      cacheKey: input.programKnowledge?.cacheKey ?? null,
      parserVersion: input.programKnowledge?.parserVersion ?? null,
    });
    return [createVerificationExecutionEvidence({
      method: "workspace-reproduction" as const,
      verifierAgentId: input.workspace.agentId,
      verifierTeamId: input.workspace.teamId,
      authorAgentId: input.authorAgentId,
      authorTeamId: input.authorTeamId,
      artifactRevisionHash: input.artifactRevisionHash,
      modelBuildHash: input.modelBuildHash,
      promptFamilyHash: canonicalSha256("verification/workspace-reproduction/v1"),
      contextPackHash: canonicalSha256({
        kind: "workspace-reproduction-context/v1",
        output: input.outputRef,
        vote: input.workspace.artifact,
        sourceIdentity,
        graphHash,
      }),
      toolReceiptHashes: [sourceReceiptHash],
      outcome: input.workspace.verdict === "accept" ? "pass" : "fail",
      workspaceSourceHash: canonicalSha256({ sourceIdentity, graphHash }),
    })];
  }
}

function toRef(artifact: ArtifactRevision): ArtifactRef {
  return {
    artifactId: artifact.artifactId,
    revision: artifact.revision,
    contentHash: artifact.contentHash,
  };
}
