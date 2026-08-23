import { assertSha256, immutable } from "../evolution/domain/canonical.js";
import type { SecurityKnowledgePackManifestV1 } from "./contracts.js";

export function validateSecurityKnowledgePackManifestV1(
  manifest: SecurityKnowledgePackManifestV1,
): Readonly<SecurityKnowledgePackManifestV1> {
  exactKeys(manifest, ["schemaVersion", "packId", "title", "sources"], "manifest");
  if (manifest.schemaVersion !== "security-knowledge-pack/v1") fail("unsupported schema");
  required(manifest.packId, "packId", 192);
  required(manifest.title, "title", 256);
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0 || manifest.sources.length > 64) fail("sources must contain 1-64 items");
  const sourceKeys = new Set<string>();
  for (const [index, source] of manifest.sources.entries()) {
    exactKeys(source, ["sourceUrl", "version", "retrievedAt", "contentHash", "license", "applicability"], `sources[${index}]`);
    let url: URL;
    try { url = new URL(source.sourceUrl); } catch { fail(`sources[${index}].sourceUrl is invalid`); }
    if (url!.protocol !== "https:") fail(`sources[${index}].sourceUrl must use HTTPS`);
    required(source.sourceUrl, `sources[${index}].sourceUrl`, 2_048);
    required(source.version, `sources[${index}].version`, 128);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(source.retrievedAt)
      || !Number.isFinite(Date.parse(source.retrievedAt))) fail(`sources[${index}].retrievedAt is invalid`);
    assertSha256(source.contentHash, `sources[${index}].contentHash`);
    required(source.license, `sources[${index}].license`, 128);
    const sourceKey = `${url!.href}\0${source.version}`;
    if (sourceKeys.has(sourceKey)) fail(`sources[${index}] duplicates a source version`);
    sourceKeys.add(sourceKey);
    exactKeys(source.applicability, ["modes", "targetKinds", "technologies", "exclusions"], `sources[${index}].applicability`);
    if (!source.applicability.modes.length || !source.applicability.targetKinds.length
      || source.applicability.modes.length > 3 || source.applicability.targetKinds.length > 3
      || source.applicability.technologies.length > 32 || source.applicability.exclusions.length > 32) {
      fail(`sources[${index}].applicability must pin modes and target kinds`);
    }
    if (new Set(source.applicability.modes).size !== source.applicability.modes.length ||
        new Set(source.applicability.targetKinds).size !== source.applicability.targetKinds.length) {
      fail(`sources[${index}].applicability contains duplicates`);
    }
    for (const technology of source.applicability.technologies) required(technology, `sources[${index}].technology`, 128);
    for (const exclusion of source.applicability.exclusions) required(exclusion, `sources[${index}].exclusion`, 256);
  }
  return immutable(manifest);
}

function required(value: string, label: string, max: number): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail(`${label} is required and bounded`);
}

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const keys = Object.keys(value);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) fail(`${label} contains missing or unknown fields`);
}

function fail(message: string): never {
  throw new Error(`Invalid security knowledge pack: ${message}`);
}
