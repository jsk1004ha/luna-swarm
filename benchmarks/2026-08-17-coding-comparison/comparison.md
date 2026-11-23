# Luna vs Sol: bounded coding comparison

## 결론

동일한 clean commit, 동일 prompt, medium reasoning, 동일 시간 제한과 사전 고정한
race 회귀 테스트에서 Luna와 Sol은 모두 3/3회 **자동 acceptance gate 100/100**을
기록했습니다. 별도의 blind code review는 수행하지 않았으므로 결론은 **gate 동률**이며,
일반적인 코딩 품질 동률을 뜻하지 않습니다.

Luna는 중앙값 기준 벽시계 시간이 1.9% 짧고, 입력 10.0%, 출력 34.5%,
추론 출력 30.6%, 완료 기록된 도구 action 33.3%가 적었습니다. 다만 시간 차이는 작고 과제가
하나뿐이므로 확정적 성능 우승이 아니라 **Luna의 방향성 있는 효율 우위**로만
판정합니다.

| 모델 | 자동 gate | 중앙 시간 | 입력 | 캐시 입력 | 출력 | 추론 출력 | 완료 도구 action |
|---|---:|---:|---:|---:|---:|---:|---:|
| gpt-5.6-luna | 100 / 100 / 100 | 249.4초 | 980,282 | 915,712 | 5,564 | 1,993 | 12 |
| gpt-5.6-sol | 100 / 100 / 100 | 254.3초 | 1,089,562 | 1,024,256 | 8,498 | 2,873 | 18 |

## 반복별 결과

| 반복 | Luna 시간 / 점수 | Sol 시간 / 점수 | 시간 우세 |
|---|---:|---:|---|
| r1 | 298.0초 / 100 | 328.9초 / 100 | Luna |
| r2 | 249.4초 / 100 | 247.9초 / 100 | Sol |
| r3 | 238.6초 / 100 | 254.3초 / 100 | Luna |

두 모델 모두 stale turn 필터링, `turn/start` 전 알림 지연, response ID의
first-observation 불변성, 기존 테스트 및 typecheck를 통과했습니다. Sol은 공개
실패/중단 회귀를 더 많이 작성하는 경향이 있었고, Luna는 더 작은 출력과 적은
완료 기록 도구 action으로 같은 자동 gate를 충족했습니다. 이 경향은 blind 정성 점수가 아닙니다.

## 결과를 반영한 개선

1. 공통 정답인 early `rawResponse/completed` race 수정을 제품 코드와 공개 회귀에
   통합했습니다.
2. `CodingWorkOrder`에 objective, requirement IDs, acceptance criteria,
   constraints, hash-bound context references를 추가했습니다.
3. 격리 executor뿐 아니라 독립 auditor도 동일한 의미 계약을 받습니다.
4. check/audit 영수증을 snapshot뿐 아니라 전체 Work Order hash에 서명해, 목표를
   바꿔치기한 패치의 통합을 거부합니다.
5. Pipeline 진입 즉시 Work Order를 복제·동결해 실행 중 caller mutation을 차단합니다.
6. 선언된 context SHA-256을 정확한 base commit의 regular Git blob bytes와 대조하고,
   검증된 bytes·blob ID·mode만 독립 auditor에 전달합니다.
7. target ref가 검증 뒤 전진하면 자동 merge 결과를 바로 commit하지 않고, protected
   source ref가 포함된 새 Integration Work Order로 돌려 최신 base에서 check/audit를 반복합니다.

## 해석 한계

- 이는 하나의 실제 TypeScript race 과제에 대한 model-level 진단입니다. 일반
  Luna Swarm 실행은 현재 read-only이므로 Luna Swarm 전체 코딩 성능을 뜻하지 않습니다.
- Windows 중첩 Codex `workspace-write`가 read-only로 전달되어, v5는 원격을 제거한
  일회성 clone에서 sandbox를 우회하고 사후 변경 경로를 검사했습니다. production
  sandbox 인증이나 Evolution 승격 증거가 아닙니다. 독립 감사에서 Sol r1이 workspace
  밖의 로컬 스크립트를 읽을 수 있었음이 확인되어 격리 부재가 실제로 증명됐습니다.
  여섯 transcript에서 hidden suite 경로나 웹 접근은 발견하지 못했지만 비접근을
  보증할 수는 없습니다.
- 공개 테스트/fixture도 채점에 포함되고 patch에 대한 익명 정성 리뷰가 없으므로
  `100/100`은 등록된 자동 gate 통과 점수로만 해석합니다.
- 중앙 non-cached input은 Luna 64,570, Sol 65,306으로 차이가 약 1.1%입니다. 전체 input
  10% 차이의 대부분은 cached input 차이입니다.
- v5 preregistration의 자체 기록 시각과 실행 시각이 모순되고 외부 서명 timestamp가
  없어 promotion-grade 사전등록으로 취급하지 않습니다.
- 도구 지표는 CLI의 `item.completed` action 수입니다. 시작/완료는 Luna가
  18/16, 12/11, 13/12이고 Sol이 24/24, 15/14, 18/18이므로 실제 호출 수나 모든
  시작 action이 끝났다는 뜻이 아닙니다.
- CLI가 `total_tokens`를 제공하지 않아 총 토큰은 0으로 추정하지 않고 unavailable로
  남겼습니다. 입력/캐시 입력/출력/추론 출력은 `turn.completed`의 실제 값입니다.
- 더 일반적인 결론에는 신규 기능 구현, 다중 파일 refactor, flaky test 진단,
  Git conflict 해결을 포함한 별도 사전등록 과제가 필요합니다.

원자료는 각 `results/<model>-r<1..3>-v5/`의 `run.json`, `score.json`,
`candidate.patch`, 테스트 로그에 보존되어 있습니다.
