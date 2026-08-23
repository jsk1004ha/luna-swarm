import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [candidateArgument, countArgument = "15000"] = process.argv.slice(2);
if (!candidateArgument) throw new Error("candidate module path is required");
const count = Number(countArgument);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("count must be a positive safe integer");

const candidateUrl = pathToFileURL(resolve(candidateArgument));
candidateUrl.searchParams.set("stress", String(Date.now()));
const { AsyncTaskPool } = await import(candidateUrl.href);

let releaseGate;
const gate = new Promise((resolveGate) => {
  releaseGate = resolveGate;
});
const pool = new AsyncTaskPool({ concurrency: 1 });
const outcomes = [pool.schedule({ id: "gate", run: () => gate })];
for (let index = 0; index < count; index += 1) {
  outcomes.push(pool.schedule({
    id: `sync-failure-${index}`,
    run: () => {
      throw new Error("expected synchronous failure");
    },
  }));
}

releaseGate();
const settled = await Promise.allSettled(outcomes);
await pool.whenIdle();
const rejected = settled.filter((outcome) => outcome.status === "rejected").length;
const result = {
  candidate: resolve(candidateArgument),
  scheduled: count + 1,
  fulfilled: settled.length - rejected,
  rejected,
  idle: true,
  metrics: pool.metrics(),
};
console.log(JSON.stringify(result));
if (rejected !== count) process.exitCode = 1;
