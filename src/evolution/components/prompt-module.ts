import { canonicalSha256, immutable, type Sha256 } from "../domain/canonical.js";

export const PROMPT_MODULE_SCHEMA_VERSION = 1 as const;

export interface PromptModuleV1 {
  schemaVersion: typeof PROMPT_MODULE_SCHEMA_VERSION;
  moduleId: string;
  directive: string;
  contentHash: Sha256;
}

export type PromptModuleV1Input = Omit<PromptModuleV1, "contentHash">;

export class PromptModuleIntegrityError extends Error {}

export function createPromptModuleV1(input: PromptModuleV1Input): Readonly<PromptModuleV1> {
  validateInput(input);
  return immutable({ ...input, contentHash: canonicalSha256(input) });
}

export function verifyPromptModuleV1(value: PromptModuleV1): Readonly<PromptModuleV1> {
  const { contentHash, ...input } = value;
  validateInput(input);
  if (!/^sha256:[a-f0-9]{64}$/.test(contentHash) || canonicalSha256(input) !== contentHash) {
    throw new PromptModuleIntegrityError(`Prompt module ${value.moduleId} hash does not match its canonical content`);
  }
  return immutable(value);
}

export function renderPromptModuleV1(module: Readonly<PromptModuleV1>): string {
  const verified = verifyPromptModuleV1(module);
  return `<evolution-prompt-module schema="1" id="${escapeAttribute(verified.moduleId)}" hash="${verified.contentHash}">\n${verified.directive}\n</evolution-prompt-module>`;
}

export function prefixPromptModuleV1(module: Readonly<PromptModuleV1>, prompt: string): string {
  return `${renderPromptModuleV1(module)}\n\n${prompt}`;
}

function validateInput(input: PromptModuleV1Input): void {
  if (input.schemaVersion !== PROMPT_MODULE_SCHEMA_VERSION) {
    throw new PromptModuleIntegrityError(`Unsupported prompt module schema version: ${String(input.schemaVersion)}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+\-]{0,255}$/.test(input.moduleId) || input.moduleId.includes("..")) {
    throw new PromptModuleIntegrityError("Prompt module ID is invalid");
  }
  if (!input.directive.trim()) throw new PromptModuleIntegrityError("Prompt module directive is required");
  if (Buffer.byteLength(input.directive, "utf8") > 32 * 1024) {
    throw new PromptModuleIntegrityError("Prompt module directive exceeds 32 KiB");
  }
  if (/<\/evolution-prompt-module\s*>/i.test(input.directive)) {
    throw new PromptModuleIntegrityError("Prompt module directive cannot close its provenance envelope");
  }
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
