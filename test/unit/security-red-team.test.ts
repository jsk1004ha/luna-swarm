import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { canonicalJson, canonicalSha256 } from "../../src/evolution/domain/canonical.js";
import {
  validateSecurityFindingV1,
  validateSecurityKnowledgePackManifestV1,
  securityFindingVerificationMaterial,
  verifySecurityEngagementV1,
  type SecurityEngagementV1,
  type SecurityFindingV1,
  type SignedSecurityEngagementV1,
} from "../../src/security/index.js";

const keys = generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const verifierKeys = generateKeyPairSync("ed25519");
const verifierPublicKeyPem = verifierKeys.publicKey.export({ type: "spki", format: "pem" }).toString();
const workspace = mkdtempSync(join(tmpdir(), "luna-security-fixture-"));
after(() => rmSync(workspace, { recursive: true, force: true }));

function manifest(mode: SecurityEngagementV1["mode"] = "static"): SecurityEngagementV1 {
  return {
    schemaVersion: "security-engagement/v1",
    engagementId: "engagement:test-1",
    target: {
      targetId: mode === "live-authorized" ? "service:owned-staging" : "workspace:test",
      kind: mode === "static" ? "local-workspace" : mode === "offline-dynamic" ? "disposable-environment" : "live-service",
      resource: mode === "live-authorized" ? "https://staging.example.invalid" : workspace,
    },
    workspaceScope: { root: workspace, readPaths: [workspace], writePaths: [] },
    mode,
    validFrom: "2026-08-18T00:00:00.000Z",
    validUntil: "2026-08-19T00:00:00.000Z",
    caps: { totalRequests: 20, requestsPerMinute: mode === "live-authorized" ? 5 : 20, concurrentRequests: mode === "live-authorized" ? 1 : 2 },
    allowedMethods: mode === "static" ? ["source-read", "static-analysis"] : mode === "offline-dynamic" ? ["offline-test", "disposable-reproduction"] : ["live-safe-probe"],
    prohibitedActions: ["credential-exfiltration", "persistence", "stealth-or-evasion", "destructive-action", "third-party-targeting", "scope-escape", "denial-of-service"],
    stopConditions: ["authorization-revoked", "scope-violation", "target-drift", "unexpected-side-effect", "rate-cap-reached", "real-user-impact"],
    credentialHandleIds: ["credential-handle:staging-readonly"],
  };
}

function signed(value: SecurityEngagementV1): SignedSecurityEngagementV1 {
  return {
    manifest: value,
    signature: {
      algorithm: "Ed25519",
      authorityId: "security-authority:test",
      value: sign(null, Buffer.from(canonicalJson(value)), keys.privateKey).toString("base64url"),
    },
  };
}

function context(targetId = "workspace:test", live = false) {
  return {
    expectedTargetId: targetId,
    expectedTargetResource: live ? "https://staging.example.invalid" : workspace,
    expectedWorkspaceRoot: workspace,
    now: new Date("2026-08-18T12:00:00.000Z"),
    authorities: {
      "security-authority:test": {
        authorityId: "security-authority:test",
        publicKeyPem,
        trustedForLive: live,
        allowedLiveTargetIds: live ? ["service:owned-staging"] : [],
      },
    },
  };
}

test("accepts a signed, scoped defensive engagement", () => {
  const value = manifest();
  const verified = verifySecurityEngagementV1(signed(value), context());
  assert.equal(verified.manifestHash, canonicalSha256(value));
  assert(Object.isFrozen(verified.manifest));
});

test("fails closed for unsigned, expired, wrong-target, and tampered engagements", () => {
  const value = manifest();
  assert.throws(() => verifySecurityEngagementV1({ ...signed(value), signature: { ...signed(value).signature, value: "" } }, context()), /signature/i);
  assert.throws(() => verifySecurityEngagementV1(signed(value), { ...context(), now: new Date("2026-08-20T00:00:00Z") }), /time window/i);
  assert.throws(() => verifySecurityEngagementV1(signed(value), context("workspace:other")), /active target/i);
  const tampered = signed(value);
  tampered.manifest.caps.totalRequests = 21;
  assert.throws(() => verifySecurityEngagementV1(tampered, context()), /tampered/i);
});

test("restricts local modes and requires explicit live authority plus target allowlist", () => {
  const offline = manifest("offline-dynamic");
  assert.doesNotThrow(() => verifySecurityEngagementV1(signed(offline), context()));
  const wrongOffline = { ...offline, target: { ...offline.target, kind: "live-service" as const } };
  assert.throws(() => verifySecurityEngagementV1(signed(wrongOffline), context()), /disposable|live target resource/i);

  const live = manifest("live-authorized");
  assert.throws(() => verifySecurityEngagementV1(signed(live), {
    ...context("service:owned-staging"),
    expectedTargetResource: "https://staging.example.invalid",
  }), /trusted live authority/i);
  assert.doesNotThrow(() => verifySecurityEngagementV1(signed(live), context("service:owned-staging", true)));
  assert.throws(() => verifySecurityEngagementV1(signed(live), { ...context("service:owned-staging", true), expectedTargetResource: "https://other.example.invalid" }), /active target resource/i);
  const notAllowed = { ...context("service:owned-staging", true), authorities: { "security-authority:test": { ...context().authorities["security-authority:test"], trustedForLive: true, allowedLiveTargetIds: [] } } };
  assert.throws(() => verifySecurityEngagementV1(signed(live), notAllowed), /allowlisted/i);
});

test("rejects workspace scopes that traverse a symlink or junction", (t) => {
  const outside = mkdtempSync(join(tmpdir(), "luna-security-outside-"));
  const alias = join(workspace, "outside-alias");
  try {
    symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    rmSync(outside, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.diagnostic("symlink/junction creation unavailable; assertion skipped");
      return;
    }
    throw error;
  }
  try {
    const value = manifest();
    value.workspaceScope.readPaths = [alias];
    assert.throws(() => verifySecurityEngagementV1(signed(value), context()), /symlink|junction/i);
  } finally {
    unlinkSync(alias);
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects raw credential fields and methods outside the signed mode", () => {
  const raw = manifest() as SecurityEngagementV1 & { credentials: { password: string } };
  raw.credentials = { password: "must-never-enter-the-contract" };
  assert.throws(() => verifySecurityEngagementV1(signed(raw), context()), /unknown fields/i);
  const unsafeMethod = { ...manifest(), allowedMethods: ["live-safe-probe" as const] };
  assert.throws(() => verifySecurityEngagementV1(signed(unsafeMethod), context()), /not allowed/i);
});

test("finding requires reproducible evidence, remediation, regression proof, and an independent verifier", () => {
  const digest = canonicalSha256("evidence");
  const finding: SecurityFindingV1 = {
    schemaVersion: "security-finding/v1",
    findingId: "finding:1",
    engagementId: "engagement:test-1",
    engagementManifestHash: canonicalSha256(manifest()),
    title: "Authorization boundary bypass",
    producerAgentId: "red-team-agent",
    classification: { cweId: "CWE-862", attackClass: "authorization-bypass" },
    reproducibility: { evidenceHash: digest, environmentHash: digest, stepsHash: digest },
    severity: { level: "high", rationale: "A scoped user can cross an authorization boundary." },
    remediation: { summary: "Enforce authorization at the resource boundary.", patchArtifactHash: digest },
    regressionTest: { testId: "authz-boundary", testDefinitionHash: digest, resultArtifactHash: digest },
    independentVerification: {
      verifierAgentId: "security-verifier",
      verdict: "confirmed",
      evidenceHash: digest,
      verifiedAt: "2026-08-18T12:00:00Z",
      authorityId: "security-finding-verifier:test",
      algorithm: "Ed25519",
      signature: "pending",
    },
  };
  finding.independentVerification.signature = sign(
    null,
    Buffer.from(canonicalJson(securityFindingVerificationMaterial(finding))),
    verifierKeys.privateKey,
  ).toString("base64url");
  const verificationContext = {
    authorities: {
      "security-finding-verifier:test": {
        authorityId: "security-finding-verifier:test",
        verifierAgentId: "security-verifier",
        publicKeyPem: verifierPublicKeyPem,
        engagementManifestHashes: { "engagement:test-1": finding.engagementManifestHash },
      },
    },
  };
  assert.equal(validateSecurityFindingV1(finding, verificationContext).findingId, "finding:1");
  assert.throws(() => validateSecurityFindingV1({ ...finding, independentVerification: { ...finding.independentVerification, verifierAgentId: finding.producerAgentId } }, verificationContext), /self-verify/i);
  assert.throws(() => validateSecurityFindingV1({ ...finding, severity: { ...finding.severity, rationale: "tampered" } }, verificationContext), /tampered/i);
  assert.throws(() => validateSecurityFindingV1({ ...finding, engagementManifestHash: canonicalSha256("different engagement") }, verificationContext), /not trusted|tampered/i);
  assert.throws(() => validateSecurityFindingV1({ ...finding, rawPrompt: "secret" } as SecurityFindingV1, verificationContext), /unknown fields/i);
});

test("knowledge packs pin source, version, retrieval time, hash, license, and applicability", () => {
  const pack = validateSecurityKnowledgePackManifestV1({
    schemaVersion: "security-knowledge-pack/v1",
    packId: "owasp:web-v1",
    title: "Pinned web security references",
    sources: [{
      sourceUrl: "https://owasp.org/www-project-web-security-testing-guide/",
      version: "v4.2",
      retrievedAt: "2026-08-18T12:00:00Z",
      contentHash: canonicalSha256("pinned-source"),
      license: "CC BY-SA 4.0",
      applicability: { modes: ["static", "offline-dynamic"], targetKinds: ["local-workspace", "disposable-environment"], technologies: ["web"], exclusions: ["third-party targets"] },
    }],
  });
  assert.equal(pack.sources[0]?.version, "v4.2");
  assert.throws(() => validateSecurityKnowledgePackManifestV1({ ...pack, sources: [{ ...pack.sources[0]!, sourceUrl: "http://example.com/insecure" }] }), /HTTPS/i);
  assert.throws(() => validateSecurityKnowledgePackManifestV1({ ...pack, sources: [{ ...pack.sources[0]!, credential: "secret" }] } as never), /unknown fields/i);
});
