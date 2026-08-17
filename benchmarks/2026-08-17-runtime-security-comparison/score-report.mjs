import { readFile } from "node:fs/promises";

const path = process.argv[2];
if (!path) throw new Error("Usage: node score-report.mjs <final.md>");
const raw = await readFile(path, "utf8");
const text = raw.toLowerCase().replaceAll(",", "");

const checks = [
  ["decision.overall_no_go", 15, [/(전체|전면|제품).{0,80}(no.?go|보류|출시.?불가)|(no.?go|보류).{0,80}(전체|전면|제품)/i]],
  ["runtime.read_search_broker", 8, [/(read|읽기).{0,80}(search|검색)|(search|검색).{0,80}(read|읽기)/i, /(hmac|capability|권한).{0,120}(durable|replay|재생|ledger|원장)|(durable|replay|재생|ledger|원장).{0,120}(hmac|capability|권한)/i]],
  ["runtime.readonly_never", 5, [/(read.?only|읽기.?전용)/i, /(approval.?policy|승인.?정책).{0,50}(never|없음|금지)|(never).{0,50}(approval.?policy)/i]],
  ["runtime.opt_in_coding", 7, [/(codingpipeline|coding pipeline|코딩.?파이프라인)/i, /(opt.?in|명시적|별도).{0,100}(일반|work order|swarm)|(일반|work order|swarm).{0,100}(자동|직접).{0,40}(아니|없|금지)/i]],
  ["evolution.pinned_resume", 6, [/(bundleid|bundlehash|bundle id|bundle hash|bundle).{0,120}(retry|resume|재시도|재개|고정|pin)|(retry|resume|재시도|재개).{0,120}(bundleid|bundlehash|bundle|pin|고정)/i]],
  ["evolution.source_observation_only", 4, [/(github_sha|github sha)/i, /(legacy_unpinned|observation.?only|관찰.?전용)/i]],
  ["evolution.manual_promotion", 5, [/(수동|manual).{0,80}(승격|promot)|(승격|promot).{0,80}(수동|manual)/i]],
  ["evolution.rollback_quarantine", 5, [/(rollback|롤백).{0,120}(generation.?cas|cas|quarantine|격리)|(quarantine|격리).{0,120}(rollback|롤백)/i]],
  ["storage.terminal_only", 5, [/(completed|partial|failed|cancelled|종료).{0,160}(archive|아카이브|보관)/i, /(planning|running|interrupted|실행.?중|중단).{0,120}(보호|제외|아카이브하지|보관하지)/i]],
  ["storage.byte_exact_restore", 5, [/(byte.?for.?byte|바이트).{0,100}(restore|복원)|(restore|복원).{0,100}(provenance|출처|blackboard|event)/i]],
  ["drift.tool_worktree", 7, [/(security\.md|harness_v2\.ko\.md)/i, /(tool broker|host tool|worktree|single committer).{0,180}(불일치|상충|문서|미래|구버전|drift)|(불일치|상충|문서|미래|구버전|drift).{0,180}(tool broker|host tool|worktree|single committer)/i]],
  ["drift.shadow_canary", 7, [/(evolution_harness_v2\.ko\.md)/i, /(shadow|canary).{0,180}(불일치|상충|문서|미래|구버전|drift)|(불일치|상충|문서|미래|구버전|drift).{0,180}(shadow|canary)/i]],
  ["gaps.unverified_scope", 6, [/(외부.?웹|원출처|web).{0,180}(미검증|남|별도|필요)|(live soak|production canary|프로덕션.?카나리).{0,180}(미검증|남|별도|필요)/i]],
  ["epistemic.separation", 5, [/(구현|보장).{0,160}(기본|opt.?in|미래|불일치|미검증)/i]],
  ["source.readme", 2.5, [/readme\.md/i]],
  ["source.security", 2.5, [/security\.md/i]],
  ["source.harness", 2.5, [/harness_v2\.ko\.md/i]],
  ["source.evolution", 2.5, [/evolution_harness_v2\.ko\.md/i]],
];

const results = checks.map(([id, points, patterns]) => ({
  id,
  points,
  passed: patterns.every((pattern) => pattern.test(text)),
}));
const score = results.reduce((sum, result) => sum + (result.passed ? result.points : 0), 0);
const criticalFailures = [
  {
    id: "claims_general_swarm_write_or_network",
    failed: /(일반|기본).{0,80}(swarm|work order).{0,120}(쓰기|write|shell|network).{0,80}(허용|가능|지원)/i.test(text),
  },
  {
    id: "claims_automatic_stable_promotion",
    failed: /(자동|모델|학습).{0,100}(stable|pointer|bundle).{0,80}(승격|promot)/i.test(text)
      && !/(거부|금지|불가|아니|fail.?closed)/i.test(text),
  },
  {
    id: "misses_all_document_drift",
    failed: !results.find((result) => result.id === "drift.tool_worktree")?.passed
      && !results.find((result) => result.id === "drift.shadow_canary")?.passed,
  },
];

process.stdout.write(`${JSON.stringify({
  scorerVersion: 1,
  path,
  score,
  maximumScore: 100,
  criticalFailure: criticalFailures.some((failure) => failure.failed),
  criticalFailures,
  results,
}, null, 2)}\n`);
