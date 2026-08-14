import { createHash } from "node:crypto";

const PROTECTED_EVALUATOR_PROCESS_PROTOCOL = 1 as const;
type RecordValue = Record<string, unknown>;
type RunnerRequest = { protocolVersion: 1; id: string; request: RecordValue & { hiddenInput: unknown; side: string; scheduleId: string } };
type RunnerResponse = { protocolVersion: 1; id: string; ok: boolean; result?: unknown; error?: unknown };

const mode = process.argv[2];
if (mode !== "runner") {
  process.stderr.write("trusted-runner:invalid_mode\n");
  process.exit(64);
}

const maxBytes = 8 * 1024 * 1024;
let buffer = Buffer.alloc(0);
write({
  protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL,
  event: "trusted-runner-ready",
});

process.stdin.on("data", (chunk: Buffer) => {
  try {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxBytes) throw new Error("oversize");
    for (;;) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) break;
      const frame = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as unknown;
      buffer = buffer.subarray(newline + 1);
      execute(parseRequest(frame));
    }
  } catch {
    process.stderr.write("trusted-runner:protocol_failed\n");
    process.exit(65);
  }
});
process.stdin.resume();

function execute(message: RunnerRequest): void {
  const hidden = message.request.hiddenInput;
  if (!isPlainRecord(hidden) || typeof hidden.datasetRow !== "number") {
    send({
      protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL,
      id: message.id,
      ok: false,
      error: { code: "EXECUTION_FAILED", message: "Trusted execution failed" },
    });
    return;
  }
  if (hidden.behavior === "crash") {
    process.stderr.write("trusted-runner:execution_failed\n");
    process.exit(70);
  }
  if (hidden.behavior === "hang") return;
  const successful = message.request.side === "challenger";
  const rawResult = { answer: successful ? hidden.datasetRow : -1 };
  send({
    protocolVersion: PROTECTED_EVALUATOR_PROCESS_PROTOCOL,
    id: message.id,
    ok: true,
    result: {
      rawResult,
      toolReceiptHashes: [digest({ tool: "read", scheduleId: message.request.scheduleId })],
      efficiencyCost: 1,
      terminalState: successful ? "SUCCEEDED" : "FAILED",
      objectiveEvidencePresent: true,
      integrityVerified: true,
      safetyGatesPassed: successful,
      requirementsRetained: successful,
      evidenceRetained: successful,
      criticalRegression: !successful,
    },
  });
}

function parseRequest(value: unknown): RunnerRequest {
  if (!isPlainRecord(value) || Object.keys(value).sort().join(",") !== "id,protocolVersion,request" ||
      value.protocolVersion !== PROTECTED_EVALUATOR_PROCESS_PROTOCOL || typeof value.id !== "string" || !isPlainRecord(value.request)) {
    throw new Error("invalid request");
  }
  return value as unknown as RunnerRequest;
}

function send(response: RunnerResponse): void {
  write(response);
}

function write(value: unknown): void {
  const frame = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(frame) > maxBytes) throw new Error("oversize");
  process.stdout.write(frame);
}

function isPlainRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as RecordValue).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as RecordValue)[key])}`).join(",")}}`;
}
