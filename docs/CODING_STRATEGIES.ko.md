# Luna Swarm 코딩 전략

Luna Swarm의 코딩 경로는 계속 `gpt-5.6-luna`만 사용한다. 성능을 높이는 수단은 더 강한 단일 모델로 교체하는 것이 아니라, 독립 후보·실행 증거·재공격·결정론적 선택을 호스트 계약으로 강제하는 것이다.

## Repair

```text
repository inspection / failure contract
             ↓
1~4 Luna candidate manifests
             ↓
candidate마다 fresh exact-base clone
             ↓
동일 protected checks + independent audit
             ↓
host deterministic selector
             ↓
manager → Red Team → validators → Judge
             ↓
fresh final verification → Single Committer CAS
```

- 후보는 서로의 출력이 아니라 같은 accepted support artifact에서 시작한다.
- 후보별 check/audit receipt와 선택 행렬은 Blackboard `benchmark`/`decision` artifact로 보존한다.
- 선택 결정은 최종 integration 전에 RunState transition으로 먼저 고정한다. 재시작은 저장된 source revision·strategy hash·평가/선택 refs와 당시 공개키 manifest를 검증하고 후보를 다시 실행하지 않는다.
- 실행 증거를 먼저 비교하고, 동률이면 더 작은 변경을 선택한다.
- 모든 후보가 check를 통과하지 못하면 audit을 통과한 최선 후보 하나만 bounded repair 대상으로 삼는다.
- protected check 실패만 새 Luna manifest를 허용한다. audit·권위·정책·무결성·인프라 실패는 즉시 fail-closed한다.
- stdout, stderr, stack, credential 값은 다음 Luna 호출에 전달하지 않는다. 오류 code와 검증된 hash만 전달한다.
- 탈락 후보와 실패 revision은 commit/ref를 만들지 않으며 final lineage에서 제외한다.

이 구조는 SE-Agent의 실패 궤적 revision/refinement와 CodeMonkeys의 다중 patch·실행 기반 선택을 Luna의 기존 immutable artifact/Single Committer 경계에 맞게 축소한 것이다. full MCTS는 기본값이 아니다. 첫 bounded round가 실패할 때만 향후 2~3개 micro-branch로 확장할 수 있다.

## Genesis

```text
요구사항 컴파일
      ↓
독립 설계안 2~4개
      ↓
통합 아키텍처·계약
      ↓
경로가 겹치지 않는 수직 slice 1~8개
      ↓
slice byte를 보존한 최종 통합 manifest
      ↓
사용자 시나리오 protected checks
      ↓
Red Team / Judge / Single Committer
```

Genesis는 기존 저장소 수정을 신규 제작으로 위장하지 않는다. 요구사항과 구조가 먼저 확정되고, slice는 기능 단위로 소유 경로를 분리한다. 최종 통합은 각 slice의 exact manifest change를 삭제하거나 다시 쓸 수 없고 필요한 glue 파일만 추가할 수 있다.

각 slice는 target ref를 움직이지 않는 fresh clone에서 policy의 protected suite와 독립 audit를 실행한다. 아직 다른 slice가 없어 시나리오 check가 실패할 수 있으므로 중간 check 결과는 진행 증거로 보존하고 audit failure만 즉시 차단한다. 최종 integration manifest는 모든 slice를 합친 fresh clone에서 전체 protected suite를 다시 통과해야 한다.

V1 전제:

- Git-initialized scaffold와 exact `baseCommit`이 있다.
- 사용자 시나리오 test는 base commit의 SHA-256으로 고정되고 `writeScopes` 밖에 있다.
- slice 경로는 서로 겹치지 않는다.
- 최종 integration task가 모든 slice와 architecture artifact를 직접 입력으로 소비한다.
- G0/G2/G3, mandatory Red Team/Judge, CodingPipeline signed check/audit receipt, Single Committer를 유지한다. 현재 generic Harness G1을 구현됐다고 주장하지 않는다.

완전히 빈 디렉터리에서 test authority까지 모델이 동시에 만드는 방식은 지원하지 않는다. 그 경로는 별도의 trusted scenario DSL/runner authority가 생기기 전까지 정답 판정기를 모델이 스스로 약화할 수 있기 때문이다.

## 정책

Repair:

```json
{ "mode": "repair", "candidates": 3, "maxSelectionRounds": 2 }
```

- `candidates`: 1~4
- `maxSelectionRounds`: 1~3

Genesis:

```json
{
  "mode": "genesis",
  "designCandidates": 3,
  "verticalSlices": 4,
  "userScenarioCheckIds": ["scenario-smoke"]
}
```

- `designCandidates`: 2~4
- `verticalSlices`: 1~8
- `userScenarioCheckIds`: policy의 `checks[].id`에 실제로 존재해야 한다.

CLI는 policy 전체와 strategy를 marker schema v3에 SHA-256으로 고정하고 model을 정확히 `gpt-5.6-luna`로 제한한다. resume은 외부 policy 파일을 다시 읽지 않으며 marker의 model/policy/strategy 중 하나라도 달라지면 state load 전에 종료한다. 이 SHA-256은 손상·불일치 탐지용이며, 로컬 공격자에 대한 인증은 run 디렉터리의 OS 접근 통제와 transition 권위 경계가 담당한다.

## 참고한 1차 자료

- [SE-Agent 공식 저장소](https://github.com/JARVIS-Xs/SE-Agent) / [논문](https://arxiv.org/html/2508.02085v6)
- [CodeMonkeys 공식 저장소](https://github.com/ScalingIntelligence/codemonkeys) / [논문](https://arxiv.org/html/2501.14723v2)
- [Moatless Tree Search 공식 저장소](https://github.com/aorwall/moatless-tree-search) / [SWE-Search 논문](https://arxiv.org/html/2410.20285v6)
- [AgentForge 논문](https://arxiv.org/abs/2604.13120)
- [Agyn 논문](https://arxiv.org/html/2602.01465v2)

이 자료들의 공개 수치는 서로 다른 모델·벤치마크·도구 환경에서 측정됐다. 따라서 이 구현은 Luna/Sol 동급 성능을 선언하지 않으며, 동일 base·hidden evaluator·token/call/time budget의 paired benchmark로만 품질 차이를 판단한다.
