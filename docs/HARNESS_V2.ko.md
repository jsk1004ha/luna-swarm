# Luna Swarm Harness v2

Harness v2는 모델을 무조건 128개 호출하는 기능이 아니라, 실행 계획에 맞게 산정된 논리 직원을 구조화된 계약과 검증 절차로 운영하는 계층입니다.

## 현재 구현된 실행 계약

- 기본 `auto` 조직: 계획의 작업 수·동시성·검증자 수를 기준으로 14~256명의 논리 roster를 산정하고 실행 전체에 고정
- 본부 → 실 → 팀 → 셀의 가변 Agent Slot과 역할별 도구·파일·네트워크 정책 (`lab-128@2` 명칭은 기존 저장 실행 호환용 schema version)
- Task DAG를 revisioned Work Order로 변환하고 실행자와 독립 검증자를 결정적으로 배정
- 자유 채팅 대신 `WORK_ORDER`, `ARTIFACT_SUBMITTED`, `GATE_RECEIPT` 등 구조화된 메시지 사용
- 결과와 게이트 receipt를 실행 디렉터리의 `blackboard-v2`에 canonical JSON + SHA-256 CAS로 불변 저장
- dependency Work Order는 선행 결과 artifact revision/hash를 직접 입력으로 사용
- G0가 schema/hash/staleness/producer/input envelope를 실제 검사하고, G2가 봉인된 Oracle suite로 산출물의 구조화 관측을 재평가하며, G3가 고정 reviewer slot의 manager·blind audit vote artifact를 정확히 참조한 뒤에만 acceptance 허용
- validator 인프라 장애는 결과 결함과 분리하여 기존 artifact를 보존하고 검증자만 교체
- Work Order, Role Contract, Mission, dependency artifact를 item 단위로 Context Compiler에 넣고 필수 항목이 예산을 넘으면 자르지 않고 실패
- Work Order의 도구·파일·네트워크 정책을 역할 계약보다 좁힌 뒤 실제 App Server sandbox에 적용; 현재 backend가 강제할 수 없는 쓰기·도구·좁은 파일 범위는 실행 전 거부
- 최대 9명의 sealed-first Council Engine과 validator 충돌/고위험 검증 workflow 연결, claim 대상 challenge, minority report, 결정론 실패 우선 규칙
- Dashboard API와 HQ·명부·조직 화면에 해당 실행에 배정된 고유 이름의 논리 직원 전체, Work Order 상태, 공개 가능한 Council 요약을 노출
- v2 이전의 진행 중 실행은 미완료 Work Order를 결정적으로 backfill하되, 구현 전에 봉인된 Oracle commitment나 검증 가능한 CAS/G0/G2/G3가 없는 과거 결과는 사후 생성으로 위장하지 않고 migration-required로 중단

## P0 지식·평가 엔진

- **Mission Preflight**: 새 실행의 계획 전에 별도 planner 호출로 가정, 모호함, 상충 요구, 빠진 경계, 요구 제거·변형 민감도, pre-mortem 위험을 구조화합니다. 해결되지 않은 항목은 planner/architect 입력에 명시되며, 이미 계획된 과거 실행에는 사후 점검을 조작해 넣지 않습니다.
- **Program Knowledge Graph**: TypeScript AST의 파일·symbol·import·call·test 역색인과 설정·CI·entrypoint 관계를 bounded graph로 만들고, Work Order마다 관련 subgraph만 하나의 Context Compiler item으로 공급합니다. `.luna-swarm`, 빌드 산출물, binary, oversized 파일은 색인하지 않습니다.
- **Oracle Forge**: Work Order 실행 전에 example/property/metamorphic/differential/invariant/performance/security/research/citation oracle을 결정적으로 만들고 source/suite hash를 봉인합니다. worker에는 공개 계약만 주고 hidden case는 주지 않습니다. 제출 뒤 worker 응답과 분리된 structural runner가 원본 artifact의 claim/evidence/check ordinal과 deliverable을 직접 읽어 observation receipt를 만들고, G2는 이 receipt와 평가 receipt를 모두 exact CAS input으로 다시 검증합니다. worker가 acceptance 문장이나 `oracleObservations`를 되풀이하는 것만으로는 통과할 수 없습니다. 명령 실행이 필요한 oracle은 Tool Broker가 없으므로 `not-executable`로 fail-closed합니다.
- **Experiment Fabric**: 고위험 Work Order는 후보·dataset digest·환경 digest·seed·metric·resource limit·stopping rule을 관측 전에 사전등록합니다. trusted runner/verifier receipt가 없는 관측은 통계에는 남지만 `UNVERIFIED_SIGNAL`로만 표시되어 양성·음성 결론으로 승격되지 않습니다. 현재 오케스트레이터 연결은 사전등록까지이며, `observationCount=0`을 실제 실험 완료로 표시하지 않습니다.
- **Verified Knowledge Capsules**: 성공·실패·음성 결과를 workspace-scoped immutable candidate로 보존합니다. accepted success candidate는 별도 admission 단계에서 exact Blackboard provenance closure, artifact hash, 현재 Work Order 상태, G0/G2/G3와 reviewer vote를 다시 계산한 경우에만 verified revision으로 승격됩니다. 실패·음성 결과는 자동 승격하지 않습니다. 외부가 스스로 만든 receipt로 verified 상태를 만들 수 없고, 저장소의 등록 verifier만 receipt를 발급합니다. verified/current/unexpired/applicable capsule만 다음 실행 컨텍스트에 들어가며, candidate/stale/revoked/expired/negative/deprecated capsule은 회상에서 제외됩니다. capsule 경로는 realpath 기준 containment와 symlink/junction 거부를 적용합니다.
- Dashboard는 위 상태를 별도 카드로 표시해 `사전등록`, `후보`, `검증 완료`를 구분합니다. 봉인된 oracle 본문이나 Council sealed memo는 API에 노출하지 않습니다.

Program Knowledge Graph는 현재 **정적 AST 관계**입니다. 탐색은 파일·디렉터리·depth·metadata/source byte 상한을 순회 중 적용하며, runtime trace와 실제 Git history는 호출자가 구조화 record를 제공할 때만 합쳐집니다. 자동 subprocess 수집을 했다고 주장하지 않습니다. Oracle 봉인은 컨텍스트·상태 계약상 변경 방지이지 적대적인 파일 접근까지 막는 별도 암호화 sandbox가 아닙니다. Experiment Fabric은 실험 명세·관측 admission·통계·판정 엔진을 제공하지만 임의 코드를 실행하는 Tool Broker가 아닙니다. Knowledge Capsule은 실행 결과만으로 자동 검증되거나 모델 가중치를 변경하지 않습니다.

현재 Codex App Server sandbox는 계속 `read-only`입니다. 따라서 Work Order의 write scope는 권한 상한을 기술하지만, 실제 patch 적용이나 단일 committer를 가장하지 않습니다. 모델 출력은 immutable artifact로 보존되며 실제 파일 쓰기 권한은 별도 Tool Broker/worktree 단계가 구현되기 전까지 주어지지 않습니다.

## 아직 구현하지 않았다고 명시하는 부분

- SQLite WAL을 canonical state로 사용하는 event/outbox/lease transaction
- 여러 App Server shard를 운영하는 shard supervisor
- capability token을 실제 파일·shell·network 호출에 연결하는 외부 Tool Broker
- Git worktree 기반 구현자 격리와 Single Committer 자동 병합
- G1 명령 실행 receipt와 run-level G4 release receipt. 현재 G2는 구조화 Oracle evaluator receipt이며 실제 shell/test command 실행은 주장하지 않습니다.
- planner·architecture·cross-team integration 단계의 Council 자동 소집 adapter (현재 validator 충돌/고위험 검증 경로만 연결)
- 1,000회 chaos와 cross-process exactly-once 보장

현재 Work Order는 실제로 증명 가능한 G0/G2/G3를 요구합니다. lint·compile·unit test가 실행됐다는 문자열을 모델이 반환해도 G1로 승격하지 않습니다. 이후 Tool Broker가 깨끗한 검증 환경에서 command, exit code, output hash를 생성할 때만 G1 receipt를 acceptance에 연결해야 합니다.

## 주요 모듈

```text
src/harness-v2/
├── contracts.ts              # v2 계약과 상태
├── organization-registry.ts  # 자동/지정형 가변 Agent Slot
├── work-orders.ts            # Work Order와 fenced lifecycle
├── blackboard.ts             # immutable CAS/revision/staleness
├── gates.ts                  # G0~G4 receipt 평가 엔진
├── council.ts                # 구조화 Council 상태기계
├── context.ts                # whole-item Context Compiler
├── tool-policy.ts            # scope/network/capability 검사
├── preflight.ts              # Mission Preflight
├── program-knowledge.ts      # AST 기반 Program Knowledge Graph
├── oracle-forge.ts           # 구현 전 평가기 봉인
├── experiment-fabric.ts      # 사전등록·관측·통계·판정
├── knowledge-capsules.ts     # 검증 receipt 기반 장기 지식
└── messages.ts               # 허용된 구조화 통신
```

이 문서의 완료 기준은 “모듈이 존재한다”가 아니라 실제 오케스트레이터가 Work Order를 발행하고, 결과와 receipt를 CAS에 저장하고, 독립 gate가 통과해야만 task를 accepted로 만드는 것입니다.
