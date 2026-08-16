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
