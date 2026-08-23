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

### 6. Company Candidate Factory와 격리된 정책 후보

일반 Company 실행의 AAR은 실패 원인과 비효율 신호를 바탕으로 3~5개의 bounded 후보를 만듭니다. 현재 제품 경로가 실제로 materialize하는 범위는 allowlist된 declarative `EvolutionComponentV2` 정책입니다.

- context, assignment, reviewer, scheduler, meeting, skill, prompt 정책만 허용합니다.
- 각 후보는 현재 Champion Genome을 부모로 둔 새 Genome과 Bundle로 content-addressed 저장됩니다.
- proposal, payload, component, 부모·자식 Bundle/Genome, isolated workspace scope, 실행 identity는 불변 isolation receipt 하나로 결합됩니다.
- receipt를 다시 읽을 때 Bundle, Genome, component payload hash를 모두 재검증합니다.
- 이 권한에는 source patch, Stable Pointer 변경, 보호 평가 결과 생성 권한이 없습니다.

후보를 만들었다는 사실은 품질 우위나 승격 가능성을 뜻하지 않습니다. 요청과 정확히 결합된 기존 protected 30×3 paired-evaluation receipt와 보호 reference가 없으면 `EVOLUTION_PROTECTED_EVIDENCE_UNAVAILABLE`로 중단하며 점수, Quality 표, Council 서명, Stable CAS를 만들지 않습니다.

AAR 단계의 benchmark plan은 실행 결과가 아니라 `templateOnly`입니다. Challenger Bundle과 build manifest가 확정된 뒤 candidate-specific protected manifest를 정확히 하나만 해석하며, paired receipt·quality receipt·protected execution receipt·process attestation이 모두 같은 후보, Champion, suite, schedule, side, 환경, 예산을 가리킬 때만 다음 단계로 진행합니다. 중복 manifest나 하나라도 다른 binding은 실패 폐쇄합니다.

검증된 기존 증거가 있으면 제품 경로는 다음 독립 실행 권한을 실제 Harness v2 Work Order로 투영합니다.

- critic, Red artifact-only, provenance/reproduction은 서로 다른 등록 직원, Work Order, budget, active lease, fencing identity를 사용합니다.
- 각 Quality lane은 서로 다른 prompt family, context partition, verification method를 사용하고 exact protected reference만 읽습니다.
- Promotion Council 참가자는 서로의 memo를 보지 않는 sealed Luna 호출을 병렬 실행합니다. 한 호출이라도 실패하면 decision을 만들지 않습니다.
- Council 결과는 `recommend-manual-promotion`, `hold`, `reject` 중 하나인 권고이며 Stable Pointer 변경 API가 없습니다.
- Quality/Council receipt는 immutable CAS로 재생되고 동일 identity의 충돌·변조·stale lease·self-review는 거부됩니다.

### 7. Paired Evaluation과 수동 승격

Champion과 Challenger 평가는 동일한 다음 조건을 요구합니다.

- case identity
- environment digest
- budget digest
- objective L3/L4 level
- 반복 횟수와 중요 slice 표본

평가 JSON의 점수만 신뢰하지 않습니다. 각 점수는 저장된 Objective Outcome Receipt와 원본 Decision Trace에 더해, 보호된 benchmark evaluator 프로세스가 발행한 서명 execution receipt, 호스트가 검증·서명한 evaluator/runner 실행파일·명령·상대경로→digest closure manifest attestation, immutable quality receipt에 함께 결합됩니다. quality receipt나 execution receipt만 직접 서명한 경우에는 승격 근거가 되지 않습니다. protected manifest registration과 정확한 30×3 schedule, side, candidate build manifest, benchmark suite ID/hash, evaluator version이 승격 manifest와 일치하지 않거나 build manifest의 Bundle digest가 실제 Champion/Challenger Bundle hash와 다르거나 execution receipt의 case·bundle·run·attempt·환경·예산·점수가 quality receipt와 다르면 paired evaluation 저장과 Stable 승격이 실패합니다. receipt 또는 source trace를 다른 관측에 재사용할 수도 없습니다.

보호된 evaluator 공개키·suite hash와 호스트 process-attestation 공개키·정확한 pin 정책만 `evolutionBenchmarkAuthorities` 설정에 둡니다. evaluator 및 host attestation 개인키는 설정이나 저장소에 넣지 않습니다.

```json
{
  "evolutionBenchmarkAuthorities": {
    "benchmark-key-prod-v1": {
      "evaluatorVersion": "benchmark-evaluator-v1",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "benchmarkSuites": {
        "engineering-bugfix-suite-v1": "sha256:<64-hex>"
      },
      "protectedProcessAuthorities": {
        "host-attestation-prod-v1": {
          "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
          "policy": {
            "evaluatorExecutableSha256": "sha256:<64-hex>",
            "evaluatorCommandSha256": "sha256:<64-hex>",
            "evaluatorIntegritySha256": "sha256:<64-hex>",
            "trustedRunnerExecutableSha256": "sha256:<64-hex>",
            "trustedRunnerCommandSha256": "sha256:<64-hex>",
            "trustedRunnerIntegritySha256": "sha256:<64-hex>"
          }
        }
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

# Stable, Trace, Outcome, Failure, Evaluation, 승격 감사 이력과 현재 진화 단계/경고 확인
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

`evolve bootstrap`은 빈 workload pointer에 기준 Bundle을 설치합니다. 새 바이너리의 source identity가 바뀌면, 정확한 감사 이력이 `system-bootstrap` 또는 이전 `system-baseline-upgrade`인 시스템 기준 Pointer만 새 기준 Bundle로 generation-CAS 전진시킵니다. 권위 전진은 workspace 설정의 숫자만 신뢰하지 않고, 현재 clean Git HEAD에서 다음 clean Git HEAD로의 strict ancestry를 직접 검증합니다. ancestor·sibling·동일 commit replay는 더 높은 `evolutionReleaseEpoch`를 선언해도 거부합니다. dirty Git과 plain config/environment non-Git identity는 정상 작업을 막지 않지만 observation-only이며 승격 증거를 만들지 않습니다. 수동 평가로 승격한 Stable Pointer는 자동으로 덮지 않고 실패 폐쇄하며, 기존 run pin과 과거 Bundle blob은 그대로 보존합니다.

shipped baseline의 release epoch는 감사·식별용 메타데이터일 뿐 전진 권위가 아닙니다. clean Git의 strict ancestry가 확인되지 않으면 같은 source의 config 변형, 처음 보는 과거 source, 기존 Bundle 재생은 더 높은 epoch를 선언해도 활성화할 수 없습니다. `evolve status`의 `health.stage`는 `baseline-only` → `collecting-outcomes` → `evaluated-challengers` → `promoted-challengers` 순으로 실제 권위 증거 단계를 표시하며, paired 평가나 oracle-locked 회귀 증거가 없으면 `health.warnings`에 명시합니다.

## 저장 구조

P0는 새 데이터베이스 의존성을 추가하지 않고 기존 파일 기반 원자 저장과 content-addressed registry를 사용합니다.

```text
.luna-swarm/evolution/
├─ genomes/
├─ bundles/
├─ product-authority/
│  ├─ components/
│  ├─ isolation-receipts/
│  └─ protected-evidence/
├─ traces/
├─ outcomes/
├─ failures/
├─ evaluations/
├─ stable-pointers.json
├─ stable-pointers.lock
└─ activation.lock

.luna-swarm/protected-evaluation/
├─ execution-receipts/
└─ quality-receipts/
```

모든 경로는 workspace realpath 안에 있어야 하며 symlink/junction 탈출을 거부합니다. Stable Pointer와 평가 등록 lock은 token으로 소유권을 확인하고, 살아 있는 PID를 시간만으로 탈취하지 않으며 종료된 소유자의 lock만 복구합니다.

## 현재 경계 밖이거나 추가 운영 검증이 필요한 단계

다음 항목은 P0가 제공한다고 주장하지 않습니다.

- source-code patch, workflow/topology 변경까지 포함한 무제한 후보 자동 변이
- protected 30×3 결과가 없는 후보의 자동 평가·Quality·Council 진행
- exact/tool replay 실행기
- 보호된 evaluator는 별도 hash-pinned 프로세스와 private execution closure로 구현했지만, 실제 30×3 corpus·개인키·승인된 durable 평가 job은 저장소에 포함하지 않았고 실제 승격 benchmark도 아직 수행하지 않음
- Shadow·Canary traffic router와 signed SLO 자동 rollback control loop는 구현했지만, 실제 production candidate 장시간 canary와 operator promotion drill은 아직 수행하지 않음
- MAP-Elites, Bayesian Optimization, contextual bandit
- Evolution REST API와 원격 배포 제어
- SQLite WAL registry migration

남은 기능과 운영 검증은 현재 불변 Bundle, objective Trace/Outcome, paired receipt, manual CAS 경계를 재사용해 별도 단계로 추가해야 합니다.

## 핵심 불변식

1. 실행 중 Bundle은 변경되지 않습니다.
2. legacy 학습과 동일 모델 투표만으로 Stable을 바꿀 수 없습니다.
3. 평가 점수는 실제 Outcome Receipt, 원본 Trace, 보호된 프로세스 execution receipt와 benchmark quality receipt에 결합됩니다.
4. 승격은 명시적인 operator action과 generation CAS를 요구합니다.
5. rollback은 Bundle blob을 수정하지 않고 pointer만 복구하며 실패 Bundle을 격리합니다.
6. legacy run에 증거 identity를 소급 생성하지 않습니다.
7. secret·PII·원시 채팅은 Evolution Trace에 저장하지 않습니다.
