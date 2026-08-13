# Evolution Harness v2

Evolution Harness v2는 Luna Swarm이 자기 설정을 즉시 덮어쓰는 자동학습기가 아닙니다. 현재 실행 조직, 후보 연구, 독립 평가, Stable 배포를 분리하고 객관적 증거가 있는 변경만 운영자가 승격하는 로컬 실험 운영체제입니다.

## 현재 구현된 P0

### 1. 레거시 학습 방화벽

- `learningAutoApply` 기본값은 `false`이며 `true` 설정은 거부됩니다.
- 기존 `learning/runs`와 `learning/policy.json`은 관찰·감사 전용입니다.
- 레거시 experience, 자기 confidence, manager/validator 투표는 실행 routing이나 Bundle 승격을 바꾸지 않습니다.

### 2. 불변 Genome과 Execution Bundle

- Genome과 Bundle은 canonical JSON의 SHA-256으로 식별됩니다.
- Bundle blob은 content-addressed, append-only 저장소에 기록됩니다.
- protected gate mutation은 publication 전에 거부됩니다.
- workload별 Stable Pointer가 현재 Champion을 가리키며 generation CAS로만 변경됩니다.

지원 workload:

```text
long-running-orchestration
engineering.feature
engineering.bugfix
engineering.refactor
engineering.performance
research.deep-synthesis
research.numeric
security.audit
validation
integration
```

### 3. Run 단위 Bundle 고정

새 run은 시작할 때 workload별 Stable Pointer를 snapshot합니다. Work Order의 실행, retry, manager/validator 검증, interruption 후 resume은 저장된 `bundleId`와 `bundleHash`를 계속 사용합니다.

```text
Stable Pointer 변경 ──X──> 현재 run
Stable Pointer 변경 ─────> 다음 run
```

Evolution 상태가 없는 legacy run은 `legacy_unpinned`으로 표시하며 과거 실행에 Bundle identity나 객관적 Trace를 소급 생성하지 않습니다. 이 run의 결과는 승격 근거로 사용할 수 없습니다.

Git 작업공간은 HEAD와 dirty/untracked 내용까지 포함한 source identity를 자동 계산합니다. Git이 아닌 작업공간은 설정의 `sourceIdentity`, Luna 전용 `LUNA_SOURCE_COMMIT`, 또는 검증된 빌드 매니페스트로 구체적인 빌드 identity를 제공할 수 있습니다. ambient CI 변수인 `GITHUB_SHA`는 작업공간 provenance로 인정하지 않습니다. identity가 없더라도 본 작업은 중단하지 않고 `legacy_unpinned` 관찰 전용으로 실행하며, 해당 run만 승격 근거에서 제외합니다.

### 4. Flight Recorder와 객관적 Outcome

Decision Trace는 다음 identity를 불변으로 묶습니다.

- run / Work Order / attempt / fencing token
- Bundle ID와 canonical hash
- environment / budget / case digest
- agent / role / team / workload
- input, context, component, tool, output, validation reference
- 실제로 측정된 latency와 선택적 queue/model-turn telemetry
- terminal state와 구조화된 failure class

원시 채팅, secret, PII, 전체 환경변수 값은 저장하지 않습니다. 측정할 수 없는 queue 시간이나 model turn 수를 `0`으로 꾸미지 않고 `null`로 남깁니다.

Objective Outcome Receipt는 원본 Decision Trace를 역참조합니다. Bundle, attempt, 환경, 예산, case, terminal 상태, output/validation reference, 품질·효율 측정값이 하나라도 다르면 저장과 조회가 모두 실패합니다. L0/L1/L2는 진단 신호이고 승격에는 L3/L4만 사용할 수 있습니다.

### 5. Failure Capsule

실패는 workload, gate, role, error, transition, requirement의 구조화 fingerprint로 묶입니다. 반복 관측은 새 immutable revision에 trace reference를 누적합니다. 재현됐다는 이유만으로 회귀 Oracle을 만들어내지 않으며, 검증 가능한 실제 Oracle reference를 받은 뒤에만 `oracle-locked`로 전이합니다.

### 6. Paired Evaluation과 수동 승격

Champion과 Challenger 평가는 동일한 다음 조건을 요구합니다.

- case identity
- environment digest
- budget digest
- objective L3/L4 level
- 반복 횟수와 중요 slice 표본

평가 JSON의 점수만 신뢰하지 않습니다. 각 점수는 저장된 Objective Outcome Receipt와 원본 Decision Trace에 더해, 보호된 benchmark evaluator가 발행한 immutable quality receipt에 결합됩니다. benchmark suite ID/hash와 evaluator version이 allowlist에 없거나 별도 evaluator 검증을 통과하지 못하면 paired evaluation 저장과 Stable 승격이 실패합니다. receipt 또는 source trace를 다른 관측에 재사용할 수도 없습니다.

보호된 evaluator의 공개키와 suite hash만 `evolutionBenchmarkAuthorities` 설정에 둡니다. 개인키는 Luna Swarm 프로세스나 저장소에 넣지 않고 격리된 evaluator가 receipt 서명에만 사용합니다.

```json
{
  "evolutionBenchmarkAuthorities": {
    "benchmark-key-prod-v1": {
      "evaluatorVersion": "benchmark-evaluator-v1",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "benchmarkSuites": {
        "engineering-bugfix-suite-v1": "sha256:<64-hex>"
      }
    }
  }
}
```

승격 조건은 다음과 같습니다.

```text
paired evaluation = PROMOTABLE
AND champion = 현재 Stable Pointer
AND challenger = 승격 대상 Bundle
AND workload 일치
AND receipt hash 일치
AND expected generation 일치
AND operator actor/reason 존재
```

자동 Stable 승격 API는 거부됩니다. Rollback은 이전 Stable을 generation CAS로 복구하고 문제가 된 Bundle을 quarantine합니다.

## CLI

```bash
# 기준 Bundle과 workload별 Stable Pointer 생성
luna-swarm evolve bootstrap --workspace .

# Stable, Trace, Outcome, Failure, Evaluation, 승격 감사 이력 확인
luna-swarm evolve status --workspace .

# 객관적 paired evaluation으로 수동 승격
luna-swarm evolve promote <bundle-id> \
  --workload <class> \
  --expected-generation <n> \
  --evaluation <receipt-id> \
  --evaluation-hash <sha256:...> \
  --actor <name> \
  --reason <text>

# 이전 Stable로 복구
luna-swarm evolve rollback <workload-class> \
  --expected-generation <n> \
  --actor <name> \
  --reason <text>
```

`evolve bootstrap`은 빈 workload pointer에만 기준 Bundle을 설치합니다. 경쟁 프로세스가 동시에 실행되어도 generation 1의 한 pointer 집합으로 수렴하며 기존 Stable을 덮지 않습니다.

## 저장 구조

P0는 새 데이터베이스 의존성을 추가하지 않고 기존 파일 기반 원자 저장과 content-addressed registry를 사용합니다.

```text
.luna-swarm/evolution/
├─ genomes/
├─ bundles/
├─ traces/
├─ outcomes/
├─ failures/
├─ evaluations/
├─ stable-pointers.json
└─ stable-pointers.lock
```

모든 경로는 workspace realpath 안에 있어야 하며 symlink/junction 탈출을 거부합니다. Stable Pointer와 평가 등록 lock은 token으로 소유권을 확인하고, 살아 있는 PID를 시간만으로 탈취하지 않으며 종료된 소유자의 lock만 복구합니다.

## 의도적으로 미구현한 후속 단계

다음 항목은 P0가 제공한다고 주장하지 않습니다.

- Candidate Factory의 자동 변이와 후보 조합
- exact/tool replay 실행기
- 별도 OS 권한·프로세스로 격리된 hidden evaluator
- Shadow·Canary traffic router와 자동 rollback SLO
- MAP-Elites, Bayesian Optimization, contextual bandit
- Evolution REST API와 원격 배포 제어
- SQLite WAL registry migration

이 기능들은 현재 불변 Bundle, objective Trace/Outcome, paired receipt, manual CAS 경계를 재사용해 별도 단계로 추가해야 합니다.

## 핵심 불변식

1. 실행 중 Bundle은 변경되지 않습니다.
2. legacy 학습과 동일 모델 투표만으로 Stable을 바꿀 수 없습니다.
3. 평가 점수는 실제 Outcome Receipt, 원본 Trace, 보호된 benchmark quality receipt에 결합됩니다.
4. 승격은 명시적인 operator action과 generation CAS를 요구합니다.
5. rollback은 Bundle blob을 수정하지 않고 pointer만 복구하며 실패 Bundle을 격리합니다.
6. legacy run에 증거 identity를 소급 생성하지 않습니다.
7. secret·PII·원시 채팅은 Evolution Trace에 저장하지 않습니다.
