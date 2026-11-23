import { verify as verifyBytes } from "node:crypto";
import { assertSha256, canonicalJson, immutable } from "../evolution/domain/canonical.js";
import type { SecurityFindingV1, SecurityFindingVerificationContextV1 } from "./contracts.js";

export function validateSecurityFindingV1(
  finding: SecurityFindingV1,
  context: SecurityFindingVerificationContextV1,
): Readonly<SecurityFindingV1> {
  exactKeys(finding, ["schemaVersion", "findingId", "engagementId", "engagementManifestHash", "title", "producerAgentId", "classification", "reproducibility", "severity", "remediation", "regressionTest", "independentVerification"], "finding");
  if (finding.schemaVersion !== "security-finding/v1") fail("unsupported schema");
  required(finding.findingId, "findingId", 192);
  required(finding.engagementId, "engagementId", 192);
  assertSha256(finding.engagementManifestHash, "engagementManifestHash");
  required(finding.title, "title", 256);
  required(finding.producerAgentId, "producerAgentId", 192);
  exactKeys(finding.classification, ["cweId", "attackClass"], "classification");
  if (!/^CWE-[1-9]\d*$/.test(finding.classification.cweId)) fail("classification.cweId must be a CWE identifier");
  required(finding.classification.attackClass, "classification.attackClass", 128);
  exactKeys(finding.reproducibility, ["evidenceHash", "environmentHash", "stepsHash"], "reproducibility");
  assertSha256(finding.reproducibility.evidenceHash, "reproducibility.evidenceHash");
  assertSha256(finding.reproducibility.environmentHash, "reproducibility.environmentHash");
  assertSha256(finding.reproducibility.stepsHash, "reproducibility.stepsHash");
  exactKeys(finding.severity, ["level", "rationale"], "severity");
  if (!["low", "medium", "high", "critical"].includes(finding.severity.level)) fail("severity.level is invalid");
  required(finding.severity.rationale, "severity.rationale", 2_048);
  exactKeys(finding.remediation, ["summary", "patchArtifactHash"], "remediation");
  required(finding.remediation.summary, "remediation.summary", 2_048);
  assertSha256(finding.remediation.patchArtifactHash, "remediation.patchArtifactHash");
  exactKeys(finding.regressionTest, ["testId", "testDefinitionHash", "resultArtifactHash"], "regressionTest");
  required(finding.regressionTest.testId, "regressionTest.testId", 192);
  assertSha256(finding.regressionTest.testDefinitionHash, "regressionTest.testDefinitionHash");
  assertSha256(finding.regressionTest.resultArtifactHash, "regressionTest.resultArtifactHash");
  exactKeys(finding.independentVerification, ["verifierAgentId", "verdict", "evidenceHash", "verifiedAt", "authorityId", "algorithm", "signature"], "independentVerification");
  required(finding.independentVerification.verifierAgentId, "independentVerification.verifierAgentId", 192);
  if (finding.producerAgentId === finding.independentVerification.verifierAgentId) {
    fail("the finding producer cannot self-verify");
  }
  if (!["confirmed", "rejected"].includes(finding.independentVerification.verdict)) fail("verification verdict is invalid");
  assertSha256(finding.independentVerification.evidenceHash, "independentVerification.evidenceHash");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(finding.independentVerification.verifiedAt)
    || !Number.isFinite(Date.parse(finding.independentVerification.verifiedAt))) fail("verification timestamp is invalid");
  if (finding.independentVerification.algorithm !== "Ed25519") fail("verification algorithm is invalid");
  const authority = context.authorities[finding.independentVerification.authorityId];
  if (!authority
    || authority.authorityId !== finding.independentVerification.authorityId
    || authority.verifierAgentId !== finding.independentVerification.verifierAgentId
    || authority.engagementManifestHashes[finding.engagementId] !== finding.engagementManifestHash) {
    fail("independent verification authority is not trusted for this finding");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(finding.independentVerification.signature)) fail("verification signature is invalid");
  let verified = false;
  try {
    verified = verifyBytes(
      null,
      Buffer.from(canonicalJson(securityFindingVerificationMaterial(finding))),
      authority.publicKeyPem,
      Buffer.from(finding.independentVerification.signature, "base64url"),
    );
  } catch {
    fail("verification authority key is invalid");
  }
  if (!verified) fail("independent verification signature is invalid or the finding was tampered");
  return immutable(finding);
}

export function securityFindingVerificationMaterial(finding: SecurityFindingV1): unknown {
  const { signature: _signature, ...verification } = finding.independentVerification;
  return { ...finding, independentVerification: verification };
}

function required(value: string, label: string, max: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) fail(`${label} is required and bounded`);
}

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) fail(`${label} contains missing or unknown fields`);
}

function fail(message: string): never {
  throw new Error(`Invalid security finding: ${message}`);
}
