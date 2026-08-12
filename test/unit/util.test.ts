import assert from "node:assert/strict";
import test from "node:test";
import { truncate } from "../../src/util.js";

test("context truncation is strictly bounded and preserves both requirements and recent feedback", () => {
  const requirements = "REQUIREMENTS:\nR1 must never be lost\n";
  const middle = "historical material\n".repeat(200);
  const feedback = "LATEST FEEDBACK:\nFix the final verification failure";
  const packed = truncate(`${requirements}${middle}${feedback}`, 240);

  assert.ok(packed.length <= 240);
  assert.match(packed, /R1 must never be lost/);
  assert.match(packed, /Fix the final verification failure/);
  assert.match(packed, /omitted from middle/);
});

test("context truncation never returns a dangling UTF-16 surrogate", () => {
  const packed = truncate(`HEAD ${"😀".repeat(200)} TAIL`, 73);
  const last = packed.charCodeAt(packed.length - 1);
  assert.equal(last >= 0xd800 && last <= 0xdbff, false);
  assert.match(packed, /HEAD/);
  assert.match(packed, /TAIL/);
});
