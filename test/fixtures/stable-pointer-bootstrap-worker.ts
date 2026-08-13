import { type Sha256 } from "../../src/evolution/domain/canonical.js";
import { ExecutionBundleStore } from "../../src/evolution/registry/bundle-store.js";
import {
  StablePointerConflictError,
  StablePointerStore,
} from "../../src/evolution/registry/stable-pointer-store.js";

const [workspace, bundleId, bundleHash, workloadClass] = process.argv.slice(2);
if (!workspace || !bundleId || !bundleHash || !workloadClass) {
  throw new Error("stable-pointer bootstrap worker arguments are missing");
}

const bundles = new ExecutionBundleStore(workspace);
const pointers = new StablePointerStore(workspace, {
  bundleStore: bundles,
  bootstrapAuthority: { bundleId, bundleHash: bundleHash as Sha256 },
});

try {
  const pointer = await pointers.promote({
    workloadClass,
    bundleId,
    expectedGeneration: null,
    mode: "manual",
    actor: `bootstrap-worker-${process.pid}`,
    reason: "concurrent bootstrap convergence test",
    bootstrap: true,
  });
  process.stdout.write(`${JSON.stringify({ status: "committed", generation: pointer.generation })}\n`);
} catch (error) {
  if (error instanceof StablePointerConflictError) {
    process.stdout.write(`${JSON.stringify({ status: "conflict" })}\n`);
  } else {
    throw error;
  }
}
