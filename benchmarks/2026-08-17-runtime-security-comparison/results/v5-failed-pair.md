# v5 유효 실패 쌍

v5는 Luna와 Sol 모두 동일한 mission, evidence snapshot, rubric, scorer, 설정 한도 아래 실제 허가 계정으로 실행된 첫 유효 paired run이다. 결과를 본 뒤 제외하지 않는다. 두 실행 모두 최종 출시 승인에는 실패했지만 서로 다른 실패 경계와 비용을 드러냈다.

| 항목 | gpt-5.6-luna | gpt-5.6-sol |
| --- | ---: | ---: |
| run ID | `runtime-security-luna-v5-20260817` | `runtime-security-sol-v5-20260817` |
| terminal status | failed | failed |
| wall time | 562,335 ms | 1,818,275 ms |
| model calls | 16 | 29 |
| retries / rate limits | 0 / 0 | 0 / 0 |
| total tokens | 1,795,303 | 5,683,744 |
| input / cached input | 1,747,138 / 1,262,336 | 5,564,144 / 4,277,760 |
| output / reasoning output | 48,165 / 18,739 | 119,600 / 39,018 |
| tasks | accepted 1, failed 1, blocked 2 | accepted 5 |
| final artifact | 없음 | 없음 |

## Luna 실패 경계

- 한 worker 결과의 `claims[].evidenceRefs` ordinal이 범위를 벗어나 전체 task를 다시 실행했다. task-level schema 오류가 read/search 도구 조사 전체를 반복시키면서 4개의 `execute_task` call이 1,441,668 token을 소비했다.
- 결과적으로 R1/R7 immutable claim/evidence trace가 비어 최종 coverage gate가 hard-fail했고, 이미 승인된 T2 결과도 `final.md`로 남지 않았다.
- 개선 목표: 의미 내용은 고정한 채 evidence reference 배열만 1회 bounded schema repair하고, 미커버 요구사항은 release 승인 없이 검증된 `partial` 보고서에 남긴다.

## Sol 실패 경계

- 모든 5개 task는 승인됐지만 최종 critic이 단일 출시 결정, 30/60/90 날짜·exit evidence, 구현 주장과 독립 검증 상태 분리, provenance gate와 제품 출시 gate 구분을 요구하며 `revise/reject`했다.
- 일부 worker/validator turn이 Host Tool을 과도하게 반복했다. `execute_task` 5 call이 2,844,707 token, `validate_task` 10 call이 2,256,485 token을 소비했다.
- 개선 목표: final critic의 비승인은 그대로 release blocker로 보존하되 검증된 근거와 unresolved issue를 `partial` 보고서로 출력하고, 한 model turn의 Host Tool 호출을 64회로 제한하며 안전한 error code만 반환한다.

## 해석

v5만으로 모델 우열을 선언할 수 없다. Luna는 더 빠르고 적은 token을 썼지만 task 계약 오류에 취약했고, Sol은 더 많은 leaf work를 승인했지만 최종 의사결정 일관성에서 막혔다. v6는 v5 결과를 보고 구현을 개선한 post-improvement follow-up이므로, 동일한 frozen rubric/scorer로 개선 효과와 상대 품질을 진단하되 독립적인 사전등록 모델 우승 실험으로 포장하지 않는다.
