# GPT-5.6-Luna vs GPT-5.6-Sol 런타임 보안 감사 비교

기존 HelioDesk 출시 판단과 다른 실제 주제로, Luna Swarm 자체 문서 네 개를 감사하는 단일 actual-account paired benchmark입니다. 두 실행은 동일 evidence snapshot, mission, 조직·reasoning·concurrency·도구 정책을 사용하며 모델만 다릅니다.

사전 고정 조건:

- 네트워크와 파일 쓰기 금지, read/search Host Tool만 허용
- Luna 먼저, Sol 다음으로 순차 실행
- 한 모델당 최대 96 backend calls, gateway retry 최대 2회
- primary scorer는 결과를 보기 전에 고정한 `score-report.mjs` v1
- 품질 점수와 critical failure가 우선이며, 효율은 품질 비열등일 때만 비교
- 단일 pair이므로 일반적인 모델 우열이나 Evolution 승격 근거로 사용하지 않음

측정값은 terminal state, accepted task/gate 상태, 외부 wall time, model calls/retries/rate-limit, exact App Server token usage, token 계측 완전성, role/purpose별 call breakdown, 최종 보고서 byte를 포함합니다. ChatGPT App Server가 통화 비용을 제공하지 않으므로 비용은 추정하지 않습니다.

`evidence/`는 benchmark 시작 직전 현재 workspace의 `README.md`, `SECURITY.md`, `docs/HARNESS_V2.ko.md`, `docs/EVOLUTION_HARNESS_V2.ko.md`를 byte-for-byte 복사한 snapshot입니다. `preregistration.v7.json`은 유효 post-improvement pair 전에 mission/config/rubric/scorer/evidence hash와 실행 순서를 고정합니다. v1~v4와 v6의 Luna-only infrastructure failures, 첫 유효 실패 쌍 v5도 삭제하지 않고 원인과 비용을 함께 남깁니다.

## v7 결과

두 실행 모두 독립 final critic 비승인으로 `partial`이어서 출시 가능한 결과는 아닙니다. Luna는 4/4 task, 45 immutable claims, uncovered requirement 0개를 보존했고 Sol은 2/6 task, 20 claims, uncovered requirement 7개를 보존했습니다. Frozen scorer는 Luna 79/100(부정문 regex 오탐 critical 1), Sol 58/100(critical 0)이므로 사전등록 규칙상 승자는 없습니다. Luna는 2.85M, Sol은 8.57M exact tokens를 사용했습니다.

- [전체 비교](results/comparison.v7.md)
- [정확한 token/call 집계](results/metrics.v7.json)
- [고정 scorer 출력](results/scoring.v7.json)
- [Luna 결과](results/luna-v7-final.md)
- [Sol 결과](results/sol-v7-final.md)
