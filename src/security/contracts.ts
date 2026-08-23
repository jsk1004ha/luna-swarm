import type { Sha256 } from "../evolution/domain/canonical.js";

export type SecurityEngagementMode = "static" | "offline-dynamic" | "live-authorized";
export type SecurityTargetKind = "local-workspace" | "disposable-environment" | "live-service";

export type SecurityMethod =
  | "source-read"
  | "static-analysis"
  | "offline-test"
  | "disposable-reproduction"
  | "live-safe-probe";

export type ProhibitedSecurityAction =
  | "credential-exfiltration"
  | "persistence"
  | "stealth-or-evasion"
  | "destructive-action"
  | "third-party-targeting"
  | "scope-escape"
  | "denial-of-service";

export type SecurityStopCondition =
  | "authorization-revoked"
  | "scope-violation"
  | "target-drift"
  | "unexpected-side-effect"
  | "rate-cap-reached"
  | "real-user-impact";

export interface SecurityEngagementV1 {
  schemaVersion: "security-engagement/v1";
  engagementId: string;
  target: {
    targetId: string;
    kind: SecurityTargetKind;
    resource: string;
  };
  workspaceScope: {
    root: string;
    readPaths: string[];
    writePaths: string[];
  };
  mode: SecurityEngagementMode;
  validFrom: string;
  validUntil: string;
  caps: {
    totalRequests: number;
    requestsPerMinute: number;
    concurrentRequests: number;
  };
  allowedMethods: SecurityMethod[];
  prohibitedActions: ProhibitedSecurityAction[];
  stopConditions: SecurityStopCondition[];
  credentialHandleIds: string[];
}

export interface SignedSecurityEngagementV1 {
  manifest: SecurityEngagementV1;
  signature: {
    algorithm: "Ed25519";
    authorityId: string;
    value: string;
  };
}

export interface SecurityAuthorityV1 {
  authorityId: string;
  publicKeyPem: string;
  trustedForLive: boolean;
  allowedLiveTargetIds: string[];
}

export interface SecurityVerificationContext {
  expectedTargetId: string;
  expectedTargetResource: string;
  expectedWorkspaceRoot: string;
  now?: Date;
  authorities: Readonly<Record<string, SecurityAuthorityV1>>;
}

export interface VerifiedSecurityEngagementV1 {
  manifest: Readonly<SecurityEngagementV1>;
  authorityId: string;
  manifestHash: Sha256;
}

export type SecuritySeverity = "low" | "medium" | "high" | "critical";

export interface SecurityFindingV1 {
  schemaVersion: "security-finding/v1";
  findingId: string;
  engagementId: string;
  engagementManifestHash: Sha256;
  title: string;
  producerAgentId: string;
  classification: {
    cweId: `CWE-${number}`;
    attackClass: string;
  };
  reproducibility: {
    evidenceHash: Sha256;
    environmentHash: Sha256;
    stepsHash: Sha256;
  };
  severity: {
    level: SecuritySeverity;
    rationale: string;
  };
  remediation: {
    summary: string;
    patchArtifactHash: Sha256;
  };
  regressionTest: {
    testId: string;
    testDefinitionHash: Sha256;
    resultArtifactHash: Sha256;
  };
  independentVerification: {
    verifierAgentId: string;
    verdict: "confirmed" | "rejected";
    evidenceHash: Sha256;
    verifiedAt: string;
    authorityId: string;
    algorithm: "Ed25519";
    signature: string;
  };
}

export interface SecurityFindingVerifierAuthorityV1 {
  authorityId: string;
  verifierAgentId: string;
  publicKeyPem: string;
  engagementManifestHashes: Readonly<Record<string, Sha256>>;
}

export interface SecurityFindingVerificationContextV1 {
  authorities: Readonly<Record<string, SecurityFindingVerifierAuthorityV1>>;
}

export interface SecurityKnowledgePackManifestV1 {
  schemaVersion: "security-knowledge-pack/v1";
  packId: string;
  title: string;
  sources: Array<{
    sourceUrl: string;
    version: string;
    retrievedAt: string;
    contentHash: Sha256;
    license: string;
    applicability: {
      modes: SecurityEngagementMode[];
      targetKinds: SecurityTargetKind[];
      technologies: string[];
      exclusions: string[];
    };
  }>;
}
