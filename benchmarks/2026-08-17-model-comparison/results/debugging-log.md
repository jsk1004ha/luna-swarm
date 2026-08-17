# 실제 실행 디버깅 기록

최종 비교는 두 모델 모두 같은 v8 바이너리와 같은 benchmark fixture로 실행했다. 아래 실패 실행은 모델 비교 결과에서 제외하고 런타임 수정 근거로만 사용했다.

## 실행 전 수정

- 실제 Codex App Server의 dynamic tools는 `code_mode_host`가 필요하다는 것을 live canary로 확인했다. host substrate는 켜고 모델 코드 실행, shell, browser, network는 계속 차단했다.
- Mission Preflight와 구조화 응답 schema를 strict JSON Schema 규칙에 맞추고, mission identity·요구사항 참조·conflict 참조를 fail-closed 검증했다.
- 로컬 증거 전용 과제와 외부 조사·쓰기 과제를 계획 단계에서 구분하도록 execution mode와 capability feasibility 검사를 추가했다.
- 한국어 조사·서술형 접미사 때문에 `verified의`, `verified이며`가 누락되던 Oracle false negative를 수정했다.

## v5 — task-scoped validation 경계

감사자가 해당 Work Order에 배정되지 않은 mission 요구사항까지 worker에게 요구해 정상 결과를 거절했다. manager/validator prompt에 task-scoped requirement allowlist를 넣고, 현재 작업 밖의 mission 요구사항을 요구하지 못하게 회귀 테스트를 추가했다.

## v6 — 실패 근거가 다음 시도에 전달되지 않음

worker가 존재하지 않는 evidence ordinal을 제출했지만 다음 시도 프롬프트에는 오류 원인이 없어서 같은 실패를 반복했다. host result-contract 오류와 이전 artifact hash를 bounded feedback frame으로 다음 시도에 전달하도록 수정했다. 실제 1차 `ordinal 999` 실패 후 2차 프롬프트가 `HOST RESULT CONTRACT`를 받아 완료하는 causal E2E를 추가했다.

## v7 — 최종 구조 합집합을 LLM 복사에 의존

모든 leaf task가 승인됐지만 final LLM이 claims·requirements·sourceTaskIds의 exact union을 보존하지 못해 종료됐다. 최종 구조 필드를 host가 immutable root lineage에서 결정론적으로 생성하고 LLM은 표현만 담당하도록 변경했다. invented claim은 폐기하고 critic caveat는 그대로 보존한다.

## v8 — ephemeral thread resume 오류

실제 App Server는 ephemeral thread 재개 시 `no rollout found for thread id ...`를 반환할 수 있었는데, 기존 fallback은 다른 missing-thread 문구만 인식했다. 이 오류를 동일한 안전한 fresh-thread fallback으로 분류하고 fake App Server 회귀 테스트를 추가했다.

## 토큰 계측

기존 `AgentResponse`와 `RunMetrics`에는 모델 호출 수와 지연만 있고 실제 토큰이 없었다. `thread/start.experimentalRawEvents`를 켜고 turn에 속한 `rawResponse/completed`를 response ID로 중복 제거해 합산했다. success, retry, 실패 경로 모두 input/cached/cache-write/output/reasoning/total을 보존하며 미계측 호출 수를 별도로 기록한다.

## 최종 실행

- Luna v8: completed, 4/4 tasks accepted, 36 calls, 1,840,095 tokens, 28:08.051.
- Sol v8: completed, 6/6 tasks accepted, 56 calls, 8,593,105 tokens, 45:00.533.
- 두 실행 모두 retries 0, rate-limit events 0, token-unmetered calls 0.
- App Server가 거절한 잘못된/범위 밖 Host Tool 요청은 권한 확대 없이 fail-closed됐고, 성공한 read/search만 서명 receipt로 결과에 결박됐다.

## 채점기 회귀

사전등록한 프롬프트 인젝션 검사는 `3 ... 100` 숫자 순서만 받는 정규식 한계가 있었다. 결과 확인 뒤 같은 사실의 한국어 표기인 `100건 중 3건`을 받도록 숫자 순서를 대칭화했으므로 v2는 primary가 아니라 sensitivity로만 사용한다. 사전등록 v1은 Luna 95/Sol 95 동점이다. v2에서 Luna는 위험 분류와 수치를 모두 보존해 100점이지만, Sol은 수치는 보존했어도 위험 분류를 생략해 95점이다.
