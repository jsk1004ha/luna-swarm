import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryDirectory, sha256, sourcePath } from "./harness.mjs";

export const DIRECT_PROTOCOL_VERSION = "company-os-v4/direct-full-source@1";
export const DIRECT_MAX_PROMPT_CHARS = 64_000;
export const DIRECT_MAX_SOURCE_CHARS = 128_000;
export const DIRECT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    protocolVersion: { type: "string", enum: [DIRECT_PROTOCOL_VERSION] },
    sourcePath: { type: "string", enum: [sourcePath] },
    fullSource: { type: "string" },
  },
  required: ["protocolVersion", "sourcePath", "fullSource"],
  additionalProperties: false,
});

export function buildInitialDirectPrompt({ mission, contract, starter, publicBehaviorTest, publicTypeTest }) {
  return boundedPrompt([
    protocolHeader("initial implementation"),
    block("MISSION.md", mission),
    block("README.md", contract),
    block(sourcePath, starter),
    block("test/public/crash-safe-lease-log.public.test.mjs", publicBehaviorTest),
    block("test/public/type-contract.public.test.mjs", publicTypeTest),
  ]);
}

export function buildRetryDirectPrompt({ mission, currentSource, publicTrajectory }) {
  return boundedPrompt([
    protocolHeader("fresh non-resumed public-test repair"),
    "This second session receives only the mission, current candidate source, and the host-recorded public-test trajectory.",
    block("MISSION.md", mission),
    block(sourcePath, currentSource),
    block("PUBLIC_TEST_TRAJECTORY.txt", publicTrajectory),
  ]);
}

export function parseDirectManifest(text) {
  let value;
  try { value = JSON.parse(text); }
  catch { throw new Error("Direct App Server response is not a JSON manifest"); }
  if (!isPlainObject(value) || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["fullSource", "protocolVersion", "sourcePath"])) {
    throw new Error("Direct App Server manifest must have exactly protocolVersion, sourcePath, and fullSource");
  }
  if (value.protocolVersion !== DIRECT_PROTOCOL_VERSION) throw new Error("Direct App Server manifest protocolVersion mismatch");
  if (value.sourcePath !== sourcePath) throw new Error(`Direct App Server manifest sourcePath must be exactly ${sourcePath}`);
  if (typeof value.fullSource !== "string" || value.fullSource.length < 1 || value.fullSource.length > DIRECT_MAX_SOURCE_CHARS) {
    throw new Error("Direct App Server manifest fullSource is empty or exceeds the bounded source limit");
  }
  if (value.fullSource.includes("\0")) throw new Error("Direct App Server manifest fullSource contains a NUL byte");
  return value;
}

export async function applyDirectManifest(workspace, manifest) {
  const parsed = parseDirectManifest(JSON.stringify(manifest));
  const exactPath = join(workspace, sourcePath);
  await writeFile(exactPath, parsed.fullSource, { encoding: "utf8", flag: "w" });
  const written = await readFile(exactPath, "utf8");
  if (written !== parsed.fullSource) throw new Error("Host write did not preserve the exact structured fullSource bytes");
  return { sourceSha256: `sha256:${sha256(written)}`, sourceBytes: Buffer.byteLength(written, "utf8") };
}

export async function runDirectAppServerAttempt({ model, workspace, prompt, threadKey, timeoutMs, onStderr }) {
  if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > DIRECT_MAX_PROMPT_CHARS) throw new Error("Direct prompt exceeds its bounded limit");
  const [{ CodexAppServerBackend }, { DEFAULT_CONFIG }] = await Promise.all([
    import(pathToFileURL(join(repositoryDirectory, "dist", "src", "backend", "codex-app-server.js")).href),
    import(pathToFileURL(join(repositoryDirectory, "dist", "src", "config.js")).href),
  ]);
  const backend = new CodexAppServerBackend({
    workspace,
    config: {
      ...DEFAULT_CONFIG,
      model,
      allowNetwork: false,
      ephemeralThreads: true,
      maxConcurrency: 1,
      initialConcurrency: 1,
      minConcurrency: 1,
      callTimeoutMs: timeoutMs,
    },
    rpcTimeoutMs: timeoutMs,
    ...(onStderr ? { onStderr } : {}),
  });
  const startedNs = process.hrtime.bigint();
  try {
    const response = await backend.run({
      threadKey,
      role: "worker",
      purpose: "benchmark-direct-full-source-generation",
      prompt,
      outputSchema: DIRECT_OUTPUT_SCHEMA,
      reasoningEffort: "high",
    });
    return { response, wallMs: Number((process.hrtime.bigint() - startedNs) / 1_000_000n) };
  } finally {
    await backend.close();
  }
}

export function directResponseMetrics(response) {
  const modelCalls = Number.isSafeInteger(response?.modelTurns) && response.modelTurns > 0 ? response.modelTurns : 1;
  const tokenUsage = response?.tokenUsage && typeof response.tokenUsage === "object" ? response.tokenUsage : null;
  const tokenUsageComplete = response?.tokenUsageComplete === true && tokenUsage !== null;
  const costReported = typeof response?.costUsd === "number" && Number.isFinite(response.costUsd) && response.costUsd >= 0;
  return {
    sessionCount: 1,
    subagentSignals: 0,
    networkToolSignals: 0,
    modelCalls,
    eventCount: 1,
    tokenUsage,
    tokenMeteredCalls: tokenUsageComplete ? modelCalls : 0,
    tokenUnmeteredCalls: tokenUsageComplete ? 0 : modelCalls,
    tokenUsageComplete,
    costUsd: costReported ? response.costUsd : null,
    costReportedCalls: costReported ? modelCalls : 0,
    costUnreportedCalls: costReported ? 0 : modelCalls,
    costComplete: costReported,
  };
}

function protocolHeader(mode) {
  return [
    `DIRECT PROTOCOL: ${DIRECT_PROTOCOL_VERSION} (${mode}).`,
    "No tools are available. Do not request shell, file, network, browser, or subagent access.",
    "The host will run public tests and is the only authority allowed to write the candidate file.",
    `Return only the strict JSON object required by the output schema, with sourcePath exactly ${sourcePath} and fullSource containing the complete replacement module.`,
    "Do not include Markdown fences or infer any unavailable inputs.",
  ].join("\n");
}

function block(label, content) {
  if (typeof content !== "string") throw new Error(`${label} prompt input must be text`);
  return `<BEGIN ${label} sha256:${sha256(content)}>\n${content}\n<END ${label}>`;
}

function boundedPrompt(parts) {
  const prompt = parts.join("\n\n");
  if (prompt.length > DIRECT_MAX_PROMPT_CHARS) throw new Error(`Direct prompt exceeds ${DIRECT_MAX_PROMPT_CHARS} characters`);
  return prompt;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
