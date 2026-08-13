import { StablePointerStore } from "../../src/evolution/registry/stable-pointer-store.js";

const [workspace, workloadClass, expectedBundleId, rawIterations] = process.argv.slice(2);
if (!workspace || !workloadClass || !expectedBundleId || !rawIterations) {
  throw new Error("stable-pointer reader worker arguments are missing");
}
const iterations = Number.parseInt(rawIterations, 10);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("reader iteration count is invalid");

const pointers = new StablePointerStore(workspace);
for (let iteration = 0; iteration < iterations; iteration += 1) {
  const pointer = await pointers.get(workloadClass);
  if (!pointer || pointer.bundleId !== expectedBundleId || pointer.generation !== 1) {
    throw new Error(`reader observed an invalid Stable Pointer at iteration ${iteration}`);
  }
}
process.stdout.write(`${JSON.stringify({ status: "read", iterations })}\n`);
