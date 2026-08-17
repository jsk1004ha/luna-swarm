# Luna Swarm 실행 품질 최적화

기준일: 2026-08-17

## 목표

하네스의 목적은 많은 에이전트를 보이게 하는 것이 아니라, 동일한 예산에서 더 정확하고 검증 가능한 결과를 만드는 것입니다. 전문 역할은 캐릭터 설정이 아니라 다음 네 가지를 고정하는 짧은 실행 계약입니다.

1. 완성해야 할 결과
2. 자기 권한이 아닌 결정
3. 통과에 필요한 관찰 가능한 근거와 검사
4. 완료·인계·실패 조건

논리 조직 규모, 실제 App Server shard 수, 동시에 실행되는 모델 호출 수는 서로 독립적인 값입니다. 고정 128명 운영은 품질 원칙이 아닙니다.

## 근거

- [Google Research의 agent-system scaling 연구](https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/)는 병렬화 가능한 작업에서 중앙 통제형 병렬 구조가 유효하지만, 순차 의존 작업에서는 multi-agent 구성이 성능을 크게 떨어뜨릴 수 있음을 보고합니다. Luna는 이 수치를 목표값으로 복사하지 않고, 작업의 독립성과 순차 의존성을 실행 topology 입력으로 사용합니다.
- [OpenAI Agents SDK의 orchestration 가이드](https://openai.github.io/openai-agents-js/guides/multi-agent/)는 manager가 최종 책임을 유지하는 agents-as-tools 구조, 구조화된 routing, execute/evaluate loop를 구분합니다. Luna의 architect·Single Committer·독립 validator 경계와 일치합니다.
- [OpenAI의 guardrail 가이드](https://openai.github.io/openai-agents-js/guides/guardrails/)처럼 권한 검사는 prompt가 아니라 tool 호출 경계에서 시행합니다. Luna App Server의 built-in tool은 끄고 read/search만 Host Tool Broker가 집행합니다.
- [Anthropic의 multi-agent research 시스템](https://www.anthropic.com/engineering/multi-agent-research-system)은 독립 조사에는 lead-worker 구조가 유효하지만 긴밀히 결합된 코딩에는 부적합하고 token 비용도 크다고 설명합니다. Luna는 조사만 제한적으로 fan-out하고 구현은 review loop를 우선합니다.
- [Anthropic의 context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)과 [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)는 structured notes, subagent isolation, progressive disclosure를 권장합니다. Luna는 선택되지 않은 스킬 본문을 prompt에 넣지 않고, 선택된 스킬도 제한된 공평 예산으로 제공합니다.
- [Google DS-STAR](https://research.google/blog/ds-star-a-state-of-the-art-versatile-data-science-agent/)의 planner → executor → verifier → router 구조는 순차 작업의 bounded repair loop 근거입니다.

## 실행 topology

Mission Preflight의 요구사항·미해결 항목·위험 수와 목표의 조사/순차 전달 신호를 결정론적으로 조합해 다음 중 하나를 선택합니다.

| 모드 | 적용 대상 | 규칙 |
|---|---|---|
| `single` | 작고 저위험인 단일 결과 | planner 1명, 독립 artifact edge가 입증되지 않으면 fan-out 금지 |
| `centralized` | 조사와 구현이 섞였거나 경계가 많은 목표 | bounded planning committee + architect 소유 DAG |
| `parallel-research` | 서로 독립적인 자료원·시장·가설 조사 | evidence domain만 병렬화하고 provenance 통합은 중앙화 |
| `review-loop` | 코딩·수정·배포처럼 순차 의존이 강한 작업 | planner 1명 + execute → independent verify → repair/stop |

`planningCommitteeSize`는 항상 실행하는 인원 수가 아니라 최대치입니다. topology가 더 작은 수를 선택할 수 있습니다.

## 전문 역할 계약

페르소나 이름이나 위계는 권한이 아닙니다. 모델 입력에는 짧은 operating contract만 포함합니다.

```text
OBJECTIVE     무엇을 완료할지
NON-AUTHORITY 무엇을 승인·변경·추정하면 안 되는지
EVIDENCE      어떤 artifact/check가 있어야 완료인지
HANDOFF       언제 결과·한계·실패를 다음 역할에 넘길지
```

Worker는 자기 결과를 승인할 수 없고, validator는 결과를 대신 작성할 수 없으며, reducer는 새 사실을 만들 수 없고, judge는 gate를 우회할 수 없습니다. 역할 문구보다 Work Order, output schema, Host Tool policy, G0/G2/G3 receipt가 우선합니다.

## 스킬 선택과 progressive disclosure

- 스킬 ID·version뿐 아니라 실제 정규화 본문의 SHA-256 content hash를 routing identity에 포함합니다.
- 선언된 role/department 값에 오타나 미지원 값이 있으면 빈 배열을 universal 권한으로 해석하지 않고 스킬 전체를 거부합니다.
- 추천, 부서, task kind, 텍스트 overlap 등 실제 관련성 신호가 없는 priority-only 스킬은 선택하지 않습니다.
- 선택 결과에는 점수와 신호를 결정론적 trace로 남깁니다. raw chain-of-thought는 저장하지 않습니다.
- prompt에는 먼저 모든 선택 스킬의 짧은 metadata를 싣고, 남은 instruction 예산을 스킬 간에 공평하게 배분합니다. 한 스킬이 나머지 스킬을 가리는 prefix starvation을 허용하지 않습니다.
- Workspace `SKILL.md`는 untrusted procedural playbook입니다. 회사 역할, 회장 지시, schema, tool/network/write 경계를 바꿀 수 없습니다.

## 컨텍스트 불변식

Mission, Work Order, 역할 계약, dependency artifact, gate finding처럼 Context Compiler가 required whole item으로 승인한 frame은 모델 호출 직전에 일반 문자열 절단으로 훼손하지 않습니다. 최종 prompt가 예산에 맞지 않으면 일부 Work Order를 전송하는 대신 gateway 호출 전 명시적으로 실패합니다.

Evolution prompt module과 회장 지시도 별도 경계를 유지합니다. 스킬/페르소나 설명을 줄여야 할 때는 먼저 advisory body를 줄이고, 권위 계약을 자르지 않습니다.

## 검증 기준

- 같은 version의 스킬 본문이 바뀌면 content hash와 harness decision ID가 바뀐다.
- 알 수 없는 role을 선언한 workspace skill은 어떤 역할에도 선택되지 않는다.
- 선택된 스킬 N개의 metadata가 모두 prompt에 존재하고, 한 스킬이 전체 instruction budget을 독점하지 않는다.
- 순차 코딩 fixture는 `review-loop`, 독립 조사 fixture는 `parallel-research`, 조사+제작 fixture는 `centralized`를 선택한다.
- required context marker는 최종 gateway prompt에 완전하게 남거나 gateway 호출 전에 실패한다.
- tool-less App Server shard는 Codex plugin/system-skill 설치를 시도하지 않고, 내부 thread는 기본적으로 ephemeral이다.
- 결과 품질은 agent 수가 아니라 requirement coverage, verified evidence, gate 통과, semantic rework, 비용·latency, failure recurrence로 비교한다.

## 다음 평가 단계

하네스 변경은 즉시 Stable로 자동 승격하지 않습니다. 동일 hidden case에서 `baseline`, `persona contract`, `contract + skill`을 matched pair로 비교하고 protected evaluator가 서명한 quality receipt로만 효과를 인정합니다. Shadow/Canary에서 quality·latency·cost evidence가 불완전하거나 SLO가 나빠지면 candidate traffic을 중단하고 rollback합니다.

## 실제 benchmark 이후 성능 경로

2026-08-17 실제 Luna/Sol paired run은 두 모델 모두 retry와 rate-limit이 0이었고, 입력 토큰이 total의 대부분을 차지했습니다. 따라서 동시성 확대보다 반복되는 대형 입력과 host가 최종적으로 폐기하는 모델 호출을 먼저 줄입니다.

- 최종 independent critic이 `accept`하고 material issue가 없으면 host가 immutable claim/evidence lineage에서 FinalReport를 직접 렌더링합니다. 모델 executive judge가 만든 prose를 다시 host가 전부 덮어쓰던 호출은 실행하지 않습니다.
- 팀 입력이 immutable packet 하나뿐이면 reducer가 추가할 수 있는 권위 정보가 없으므로 deterministic pass-through를 사용합니다. 두 개 이상의 packet은 기존 reducer와 deterministic union/fallback 경계를 유지합니다.
- manager, blind auditor quorum, Oracle, final critic은 품질·권위 경계이므로 성능을 이유로 생략하지 않습니다.
- Gateway는 prompt 원문을 저장하지 않고 role/purpose, prompt 문자·UTF-8 byte·SHA-256, duration, queue wait, exact token usage를 남깁니다. resume 후에도 breakdown을 이어서 누적합니다.

고정 mock DAG에서는 accepted task·lineage·gate·final 불변을 유지하며 23 calls에서 19 calls로 감소했습니다. 이 17.4%는 결정론적 회귀 측정일 뿐 실제 계정 토큰 절감치가 아닙니다. 실제 효과는 같은 preregistered mission을 다시 실행해 primary 품질, critical failure, 미계측 호출 수가 동일한 조건에서 uncached input과 wall time으로 판정합니다.

## 개선 후 두 번째 실제 진단

다른 주제인 Luna 보안·운영 출시 감사를 실제 계정으로 실행한 v7에서 Luna는 4/4 task와 45 immutable claims를 보존했고 Sol은 2/6 task와 20 claims를 보존했습니다. 두 실행 모두 final critic 비승인으로 partial이며, frozen scorer의 정식 판정은 승자 없음입니다. 정확한 total token은 Luna 2,850,715, Sol 8,574,243으로 Luna가 66.75% 적었지만, 품질 pass 전에는 이를 공식 효율 승리로 부르지 않습니다.

실행은 다음 병목을 더 분명히 했습니다.

- Sol은 28 calls로 Luna의 40 calls보다 적었지만 call당 평균 token이 약 306k로 Luna 약 71k의 4.3배였습니다.
- Sol의 worker+validator가 전체 token의 93.2%를 사용했습니다. 반복 call 수보다 반복되는 대형 cached input이 우선 최적화 대상입니다.
- Luna의 bounded result repair 2회는 52,079 tokens였고 도구 재호출 없이 invalid evidence ordinal만 교정했습니다.
- verified partial final은 task 또는 critic 실패가 있어도 승인된 evidence를 잃지 않았으며 release authority는 계속 차단했습니다.

실행 뒤 mixed-language 후치 부정(`write·network·code execution 불가`)을 capability 요구로 오인하는 classifier를 수정했습니다. 또한 repair 전에 모든 invalid claim index를 host가 계산하고 exact set 전체를 한 번에 고치도록 강제했습니다. 일부만 고친 repair는 거부하고 그 경우에만 기존 clean task retry로 복귀합니다.

### v7 계측 기반 추가 최적화

v7에서 Sol token의 93.2%가 worker와 validator에 집중된 원인은 독립성 자체가 아니라 같은 워크스페이스 근거를 여러 검토자가 반복해서 열고, 동일한 큰 tool 결과가 같은 model turn의 다음 입력마다 다시 포함된 데 있었습니다. 현재 런타임은 검증 권위를 다음처럼 분리합니다.

- `V1 evidence-auditor`만 Work Order가 허용한 bounded read/search를 유지합니다.
- manager는 immutable worker artifact와 task contract만 검토합니다.
- `V2 requirements-auditor`는 acceptance coverage를 immutable artifact에서 검사합니다.
- 초기 표가 갈라져 호출되는 `V3 failure-mode-critic`은 source counterexample이 필요할 수 있으므로 bounded read/search를 유지합니다.
- Oracle, manager vote, blind quorum, G0/G2/G3, final critic은 그대로이며, reviewer 수나 quorum은 줄이지 않습니다.

따라서 workspace-inspection task의 정상 3-lane 검토(manager+V1+V2)에서 tool-capable lane은 3개에서 1개로 줄지만 독립 투표는 3개 모두 남습니다. 또한 한 model turn 안의 canonical tool 요청은 single-flight로 한 번만 실행·서명하며, 같은 요청의 재호출은 앞선 결과를 재사용하라는 512-byte 미만 marker만 반환합니다. 64 KiB 이상 fixture에서 반복 응답 직렬화 크기가 100배 이상 감소하는 회귀로 잠갔습니다.

Host Tool 총 호출 hard bound는 64에서 32로 낮췄고, 실제 모델에 전달되는 단일 read/search 구조화 출력은 256 KiB, 검색 match는 256개로 제한했습니다. 큰 파일은 전체를 한 번에 주입하지 않고 search로 범위를 좁혀야 합니다. 이 값은 보안 권한을 넓히지 않으며, 동일 요청 memoization은 같은 turn 내부에서만 유지됩니다.

이 절감치는 현재 deterministic 회귀의 wire-byte/tool-authority 측정입니다. 실제 Luna/Sol token 개선률은 새 주제의 사전등록 paired run을 다시 수행하기 전까지 주장하지 않습니다.

상세 결과와 원본 보고서는 [v7 비교 보고서](../benchmarks/2026-08-17-runtime-security-comparison/results/comparison.v7.md)에 있습니다.
