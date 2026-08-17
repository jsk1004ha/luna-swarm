import { readFile } from "node:fs/promises";

const path = process.argv[2];
const scorerVersion = Number(process.argv[3] ?? "1");
if (!path || ![1, 2].includes(scorerVersion)) {
  throw new Error("Usage: node score-report.mjs <final.md> [1|2]");
}
const raw = await readFile(path, "utf8");
const text = raw.toLowerCase().replaceAll(",", "");
const promptInjectionPattern = scorerVersion === 1
  ? /(프롬프트.?인젝션|prompt.?injection).{0,160}(3.{0,20}100)/i
  : /(프롬프트.?인젝션|prompt.?injection).{0,160}(3.{0,20}100|100.{0,20}3)|(3.{0,20}100|100.{0,20}3).{0,160}(프롬프트.?인젝션|prompt.?injection)/i;

const checks = [
  ["decision.blocks_full_launch", 15, /(전면|전체).{0,30}(차단|보류|금지|no.?go)|(no.?go|보류).{0,30}(전면|전체)/i],
  ["pilot.sample_1200", 5, /1200/],
  ["pilot.response_time", 5, /18\.0?.{0,80}10\.2|10\.2.{0,80}18\.0|43\.3%/],
  ["pilot.resolution_time", 5, /9\.6.{0,80}8\.1|8\.1.{0,80}9\.6|15\.6%/],
  ["pilot.csat", 5, /4\.18.{0,80}4\.31|4\.31.{0,80}4\.18/],
  ["pilot.hallucination", 5, /11.{0,40}0\.92%|0\.92%.{0,40}11/],
  ["pilot.pii", 5, /3.{0,40}0\.25%|0\.25%.{0,40}3/],
  ["security.cross_tenant", 5, /(교차.?테넌트|cross.?tenant).{0,160}(2.{0,20}50|tenant_id)/i],
  ["security.prompt_injection", 5, promptInjectionPattern],
  ["security.retention", 5, /90.{0,80}30.{0,30}(일|day)|30.{0,80}90.{0,30}(일|day)/i],
  ["security.audit_gap", 5, /(감사|audit).{0,120}17%/i],
  ["security.quantified_gates", 5, /(99\.9%|0\.10%|0\.1%).{0,240}(pii|개인정보|환각)|(pii|개인정보|환각).{0,240}(99\.9%|0\.10%|0\.1%)/i],
  ["finance.unit_economics", 5, /8\.20.{0,120}1\.77|1\.77.{0,120}8\.20|78\.4%/],
  ["finance.budget_schedule", 5, /(120000|120k).{0,160}(46000|46k|8주)|(46000|46k|8주).{0,160}(120000|120k)/i],
  ["plan.shadow_canary", 5, /shadow.{0,160}(5%|canary)|canary.{0,160}(5%|shadow)/i],
  ["plan.30_60_90", 5, /30.{0,120}60.{0,120}90/],
  ["source.pilot", 2.5, /01-pilot-metrics\.md/],
  ["source.security", 2.5, /02-security-review\.md/],
  ["source.customer", 2.5, /03-customer-feedback\.md/],
  ["source.finance", 2.5, /04-finance-and-launch-gates\.md/],
];

const results = checks.map(([id, points, pattern]) => ({
  id,
  points,
  passed: pattern.test(text),
}));
const score = results.reduce((sum, result) => sum + (result.passed ? result.points : 0), 0);
process.stdout.write(`${JSON.stringify({ scorerVersion, path, score, maximumScore: 100, results }, null, 2)}\n`);
