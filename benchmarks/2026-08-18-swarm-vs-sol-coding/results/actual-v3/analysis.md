# 실제 Luna Swarm 코딩 vs 단일 Sol — 객관 평가

비교 ID: `actual-v3`

## 결론

- 결정론 게이트 점수는 **Luna 40/100, Sol 40/100**으로 동률이다.
- 두 후보 모두 공개 테스트·문법·변경 범위·완성도 게이트는 통과했지만, 동일한 post-freeze hidden case인 `now()`의 constructor-time finite-value 검증을 놓쳤다.
- 따라서 품질 승자는 **선정 불가(inconclusive)**다. 효율은 이 한 과제에서 Sol이 분명히 앞섰다.
- 점수 외 보조 스트레스 검사에서는 Luna가 15,000개의 동기 실패 작업을 모두 정산했지만 Sol은 재귀 drain으로 `RangeError: Maximum call stack size exceeded`가 발생했다. 이 검사는 사후 추가 검사이므로 점수에는 반영하지 않았다.
- intended hidden-suite digest를 보존 바이트로 복원하지 못했기 때문에 이 결과는 `diagnosticOnly: true`, `promotionEligible: false`다. 후보 동결 후 evaluator를 공개하여 양쪽에 대한 블라인드성은 유지했지만, 사전등록 권위로 주장하지 않는다.

## 실제 코딩 경로

Luna 후보는 별도 Codex 코더가 만든 코드를 받아온 것이 아니다. 실제 `luna-swarm code` 실행 안에서 다음 경로를 거쳤다.

1. `gpt-5.6-luna` worker가 정확한 파일 바이트를 implementation manifest로 작성했다.
2. manager와 독립 validator들이 manifest를 검토했다.
3. 호스트가 승인된 manifest를 격리 clone에 적용했다.
4. 보호 check와 독립 audit가 서명된 receipt를 만들었다.
5. Single Committer가 `refs/heads/luna-candidate`에 정확히 한 commit을 통합했다.

증거는 Luna의 `state.json`, `events.jsonl`, candidate bundle에 보존되어 있다. `coding_work_order_created → coding_snapshot_captured → coding_check_recorded → coding_audit_recorded → coding_integrated` 순서와 commit `5f697729ef336beb73f74c4389ec9685f569e431`을 확인할 수 있다.

실행 자체는 `partial`로 끝났다. 코딩 통합 실패가 아니라, 최종 critic이 코딩 통합 전에 작성된 worker의 “host checks pending” 문장을 보고 통합 뒤 생성된 호스트 receipt를 입력으로 받지 못해 “테스트 미실행”으로 오판했기 때문이다. 이 비교 후 최종 synthesis에 durable coding proof를 추가하고 critic에게 시간 순서를 명시하도록 런타임을 수정했으며 회귀 테스트를 추가했다. 비용 때문에 실제 15분 run 전체를 다시 호출하지는 않았고, 해당 경계는 mock-backed causal E2E와 TypeScript 검사로 검증했다.

## 결정론 결과

| 게이트 | Luna | Sol | 배점 |
| --- | ---: | ---: | ---: |
| post-freeze hidden evaluator | FAIL | FAIL | 60 |
| public tests | PASS | PASS | 15 |
| syntax | PASS | PASS | 10 |
| scope/repository integrity | PASS | PASS | 10 |
| completeness | PASS | PASS | 5 |
| 합계 | **40** | **40** | **100** |

공통 hidden failure는 `new AsyncTaskPool({ concurrency: 1, now: () => Number.NaN })`가 constructor에서 동기 예외를 내야 한다는 경계였다. 두 구현 모두 clock을 실제 schedule 시점에 읽을 때만 검증했다.

## 비용과 속도

| 지표 | Luna Swarm | 단일 Sol | 진단 |
| --- | ---: | ---: | --- |
| wall time | 896.9 s | 200.4 s | Luna 4.47× 느림 |
| model calls | 13 | 1 | Luna 13× |
| exact total tokens | 596,745 | 228,051 | Luna 2.62× |
| input tokens | 538,694 | 219,407 | Luna 2.46× |
| non-cached input | 421,958 | 38,927 | Luna 10.84× |
| output tokens | 58,051 | 8,644 | Luna 6.72× |

Sol의 upstream event에는 `total_tokens`가 없었으나 exact `input_tokens + output_tokens`가 모두 존재해 228,051로 합산했다. 추정치는 아니다.

Luna 토큰의 단계별 분포는 다음과 같다.

- 독립 validator 5회: 273,804 tokens, 45.9%
- worker 2회: 132,161 tokens, 22.1%
- manager review 2회: 77,138 tokens, 12.9%
- preflight + planner + architect: 85,053 tokens, 14.3%
- final critic: 28,589 tokens, 4.8%

이 과제에서는 협업의 추가 검증이 공개 게이트 점수를 높이지 못했고, 호출 및 반복 input 비용만 크게 늘렸다. 반면 사후 스트레스 검사에서 Sol만 발견된 stack-overflow 결함을 Luna의 재진입 방지 구조가 피했으므로, 협업/방어적 구현의 가치가 전혀 없다고도 결론낼 수 없다.

## 점수 외 보조 correctness 검사

동일한 후보 파일에 concurrency 1인 pool을 만들고 gate 뒤에 동기 예외 작업 15,000개를 대기시킨 뒤 drain했다.

- Luna: exit 0, 15,001 submitted/started, 1 succeeded, 15,000 failed, idle 도달.
- Sol: exit 1, `_settleUnderlying → _drain → _start` 동기 재귀에서 stack overflow.

Luna는 `_pumping` 재진입 guard가 있어 이 경계를 통과한다. Sol은 직접 재귀 대신 drain guard 또는 microtask 기반 settlement가 필요하다.

## 실전 중 발견해 수정한 Luna 문제

1. coding plan이 분석 task와 workspace-change task를 함께 만들며 capability mismatch를 일으켰다. coding topology를 정확히 한 개의 workspace-change task로 제한했다.
2. validator가 호스트 적용 전에 테스트·diff·commit 증거를 요구하는 순환 계약이 있었다. semantic review와 post-acceptance protected execution의 책임 경계를 prompt에 고정했다.
3. benchmark runner가 run-state envelope를 잘못 읽어 Luna telemetry를 놓쳤다. 실제 `.state` payload를 읽도록 수정했다.
4. Sol usage event의 누락된 `total_tokens` 때문에 exact 사용량이 불완전으로 보였다. exact input/output component가 모두 있을 때만 합산하도록 수정했다.
5. Windows CRLF checkout 때문에 고정 contract/public-test hash가 오탐 실패했다. scorer가 Git-normalized LF bytes로 비교하도록 수정했다.
6. Single Committer CAS 뒤 run-state 저장 전 crash gap을 durable journal proof로 재조정하는 recovery 경계를 추가했다.
7. 최종 critic이 post-integration host proof를 보지 못해 성공한 코딩 run을 partial로 오판했다. synthesis에 source artifact/work-order/tree/receipt/commit을 묶은 host claim/check를 추가했다.

## 다음 성능 개선 우선순위

### P0 — 품질

1. 자연어 계약을 constructor/schedule/lifecycle 경계 행렬로 컴파일하고, 모델 호출 전 host가 누락된 음성 케이스 후보를 생성한다. hidden evaluator의 답을 feedback으로 주지는 않는다.
2. protected public check가 실패하면 bounded repair loop에 정규화된 공개 finding만 전달하고, 통과 receipt는 새 snapshot에 다시 발급한다.
3. sync throw, 대량 queue, abort-ignoring task, invalid injected clock처럼 상태 전이 경계를 모든 coding Work Order의 기본 counterexample checklist로 만든다.

### P0 — 보안

Node permission model의 파일 권한만으로는 candidate test code의 네트워크를 차단하지 못한다. 실제 외부/비신뢰 코딩을 일반 활성화하기 전에 OS/container/firewall 수준의 outbound network 차단과 독립 runner 격리를 추가해야 한다.

### P1 — 토큰

1. 엄격한 one-file/one-task coding policy에서는 preflight, candidate planner, architect를 host-canonical plan으로 대체한다. 이번 run 기준 최대 85,053 tokens(14.3%)의 LLM planning 입력을 제거할 수 있다.
2. validator 5회가 전체 토큰의 45.9%를 사용했다. 기본은 manager 1 + 독립 validator 1로 시작하고, 불일치·고위험·구체 finding이 있을 때만 추가 reviewer를 호출한다.
3. review prompt는 전체 AgentResult를 반복 직렬화하지 않고 hash dictionary 기반 ReviewPacket을 사용한다. claim/evidence/check 원문은 한 번만 싣고 reviewer는 ID로 참조한다.
4. worker 재시도는 전체 context 대신 immutable prior artifact hash + bounded repair finding delta만 전달한다.
5. constitution, coding policy, role/skill instructions를 stable prefix로 고정해 cache hit를 높인다. 이번 Luna non-cached input은 Sol의 10.84배였다.

### P1 — 평가 신뢰도

사전등록 hidden suite 원본과 digest를 protected runner에 보존하고, arm 순서를 무작위화한 3회 이상의 paired repetition을 수행해야 한다. 그 전까지 이 단일 결과로 모델 또는 Swarm bundle을 promotion하면 안 된다.

## 판정

- 결정론 품질: **동률 / inconclusive**
- 사후 보조 correctness: **Luna 우세**
- 측정 효율: **Sol 우세**
- 종합 승자: **선정 불가**

이 결과가 말해주는 가장 중요한 점은 “협업 agent 수를 늘리면 자동으로 품질이 오른다”가 아니라, 복잡도에 맞춰 계획·검증 호출을 적응적으로 줄이고 host-owned boundary tests를 강화해야 한다는 것이다.
