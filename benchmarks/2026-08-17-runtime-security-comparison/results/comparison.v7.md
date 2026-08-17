# v7 개선 후 실제 Luna/Sol 비교

2026-08-17, 기존 HelioDesk 과제와 다른 **Luna Swarm 보안·운영 출시 감사**를 동일한 로컬 문서 네 개, 동일 mission·도구·조직·동시성·검증 설정에서 실제 ChatGPT 계정으로 순차 실행했다. 모델만 `gpt-5.6-luna`와 `gpt-5.6-sol`로 달랐다. v5의 실패를 본 뒤 reference repair, verified partial final, per-turn Host Tool 상한을 구현한 post-improvement 진단이며, 단일 pair이므로 일반 모델 우승이나 Evolution 승격 근거가 아니다.

## 결과

| 항목 | gpt-5.6-luna | gpt-5.6-sol |
| --- | ---: | ---: |
| run ID | `runtime-security-luna-v7-20260817` | `runtime-security-sol-v7-20260817` |
| terminal status | partial | partial |
| 작업 | **4 accepted / 0 failed / 0 blocked** | 2 accepted / 1 failed / 3 blocked |
| 보존된 immutable claims | **45** | 20 |
| 미커버 요구사항 | **0** | 7 |
| 미해결 final critic issues | 11 | 11 |
| 고정 scorer | **79/100** | 58/100 |
| scorer critical flag | 1 | **0** |
| wall time | 29:06.275 | **26:33.909** |
| model calls | 40 | **28** |
| total tokens | **2,850,715** | 8,574,243 |
| input / cached input | **2,745,789 / 1,575,936** | 8,462,035 / 7,372,288 |
| output / reasoning output | **104,926** / 42,226 | 112,208 / **36,447** |
| retries / rate limits | 0 / 0 | 0 / 0 |
| token metered / unmetered calls | 40 / 0 | 28 / 0 |
| final bytes | 115,561 | 55,284 |

두 실행 모두 독립 final critic이 release를 승인하지 않아 `partial`이다. 개선 전에는 이 경우 결과물이 사라졌지만, v7은 승인된 leaf evidence와 미충족 요구사항·미해결 이슈를 권위 상태 그대로 `final.md`에 남겼다.

## 품질 판정

사전등록 규칙은 `80점 이상`, critical failure 0건을 모두 요구한다. Luna는 79점에 critical flag 1건, Sol은 58점에 critical 0건이므로 **공식 결과는 승자 없음**이다. 품질 비열등 조건이 성립하지 않아 효율 승자 규칙도 활성화하지 않는다.

Luna critical flag는 원문이 실제로 일반 Swarm의 쓰기·shell·network 허용을 주장해서가 아니다. frozen scorer가 “파일 쓰기·shell·network Broker는 기본 Swarm 보장이 아니며”라는 부정문과 뒤쪽의 “실제 capability 연결”을 하나의 양성 문맥으로 잘못 결합했다. 출력 확인 뒤 scorer를 바꾸지 않았고 79점/critical 결과를 그대로 보존한다. 이 사후 확인은 자동 점수를 수정하는 adjudication이 아니라 scorer 한계 기록이다.

구조적 완성도에서는 Luna가 4/4 작업과 45 claims, 0 uncovered requirements를 보존했다. Sol은 T-02가 세 차례 독립 감사에서 실패해 T-04~T-06이 dependency-blocked가 되었고, 20 claims와 7 uncovered requirements만 남았다. Sol의 final은 그래서 read/search Broker, 기본 read-only, opt-in CodingPipeline, tool/worktree 문서 drift 등 frozen rubric 항목을 충분히 포함하지 못했다.

## 토큰·시간 해석

- Luna는 Sol보다 총 토큰을 **66.75% 적게** 썼고, Sol은 Luna의 **3.008배**를 사용했다.
- Luna는 호출 수가 42.86% 많았지만 call당 평균은 약 71,268 tokens였고 Sol은 약 306,223 tokens였다.
- Sol의 `execute_task` 5회가 5,252,546 tokens, `validate_task` 10회가 2,740,992 tokens였다. 전체의 93.2%가 이 두 단계였다. T-02 세 번 재작업에서 대형 cached context가 반복된 것이 핵심 병목이다.
- Luna의 `execute_task` 8회는 1,826,828 tokens, `validate_task` 14회는 410,237 tokens였다. bounded `repair_task_result` 2회는 52,079 tokens로, 도구 조사를 통째로 다시 수행하는 것보다 작았다.
- Sol은 wall time이 8.73% 짧았지만 사전등록 효율 기준 10%에 못 미치며 품질 조건도 충족하지 않았다.
- 실제 통화 비용은 App Server가 제공하지 않아 `null`이다. 가격표 기반 추정은 하지 않았다.

## v5 대비 개선 효과

- Luna v5는 invalid evidence ordinal 때문에 최종물이 없었지만 v7은 bounded repair를 거쳐 4개 작업을 모두 승인하고 115,561-byte partial final을 남겼다.
- Sol v5는 leaf 작업을 승인하고도 final critic 비승인으로 결과물이 없었지만, v7은 task 실패·dependency block이 있어도 승인된 20 claims를 55,284-byte partial final에 보존했다.
- Host Tool 64회 상한은 실제 Sol turn에서 발동했고, 65번째 이후는 payload-free `OUTPUT_LIMIT`으로 차단됐다. `INVALID_PATH`/`INVALID_REQUEST`도 내부 메시지나 credential 없이 범주 코드만 노출됐다.
- 전체 토큰이 v5보다 반드시 감소한 것은 아니다. v7은 이전보다 더 먼 단계까지 실행하고 결과물을 보존했으며, Sol의 반복 대형 context 비용은 오히려 더 명확하게 드러났다.

## 실행 후 추가로 닫은 결함

1. Architect가 `write·network·code execution 불가`라고 쓴 mixed-language 후치 부정을 workspace write 요구로 오인했다. 영문 capability/action 목록에도 한국어 후치 부정을 적용하고, 뒤의 별도 `commit` 같은 양성 동작은 계속 검출하도록 회귀를 추가했다.
2. 여러 claim의 evidence ordinal이 잘못됐을 때 모델이 일부 claim만 고치면 전체 task retry로 돌아갔다. Host가 모든 invalid claim index를 먼저 계산하고, repair 응답이 그 exact set을 한 번에 덮지 않으면 거부하도록 바꿨다. 정상 exact repair는 도구 재호출 없이 끝나며 incomplete repair만 기존 clean retry로 복귀한다.

## 다음 성능 우선순위

1. validator/worker에 반복되는 full result를 reversible lineage dictionary와 content-hash reference로 lossless packing한다.
2. invalid Host Tool 요청을 줄이도록 relative-path/schema 예제를 짧게 제공하되, broker의 path·scope·호출 상한은 완화하지 않는다.
3. task 재작업에는 전체 이전 결과 대신 exact failed criteria, immutable artifact hash, 필요한 evidence slice를 우선 제공한다.
4. 이 변경들은 같은 protected rubric에서 품질·critical failure를 먼저 통과한 뒤에만 token 효율 개선으로 인정한다.

## 원본과 재현 자료

- [Luna 최종 보고서](luna-v7-final.md)
- [Sol 최종 보고서](sol-v7-final.md)
- [정확한 집계](metrics.v7.json)
- [고정 scorer 결과](scoring.v7.json)
- [v7 사전등록](../preregistration.v7.json)
- [v5 유효 실패 쌍](v5-failed-pair.md)
- [제외 실행과 원인](excluded-run.md)

최종 보고서 SHA-256:

- Luna `d9ec385408625b3dc91751d7484c95648774cfaceda3f0fff2812a0a7c5b5b9d`
- Sol `beda2c81fcc74e63d12e14d7a31cb1c56b29bd77192112a6ef3f03991d9861cf`
