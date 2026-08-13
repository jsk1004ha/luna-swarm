# Luna Swarm 구현 감사 보고서 — 2026-08-13

이 문서는 사용자 제공 Phase 0~7 요구사항을 기준으로 한 로컬 구현·검증 기록입니다. 코드 병합 준비 상태와 전체 제품 출시 상태를 분리해 판정합니다.

## 1. 기준 SHA와 최종 SHA

- 사용자 지정 감사 기준: `adbbfcafe7e36d11731aef2965f7f209b2500c0a`
- 작업 시작 시 최신 `origin/main`: `398637d0f8ba37b3130801fa066bc61895795fae`
- 작업 시작 시 최신 GitHub Actions: [31696979979](https://github.com/jsk1004ha/luna-swarm/actions/runs/31696979979), `398637d`, 실패
- 최종 SHA: 이 보고서를 포함하는 로컬 `main` 커밋. 정확한 SHA는 최종 인계에서 `git rev-parse HEAD` 결과로 기록합니다.
- 환경: Windows 11 `10.0.26200`, PowerShell `7.6.3`, Node `22.16.0`, npm `10.9.2`, Git `2.50.1.windows.1`, Codex CLI `0.146.0`

기준선 clean snapshot에서는 `npm ci`, `npm run check`, `npm run build`, `npm audit`가 통과했고, `npm test`는 서버 `271/272`에서 실패했습니다. 최신 원격 CI도 비-Git 임시 workspace가 ambient `GITHUB_SHA`를 source identity로 오인해 `legacy_unpinned` 대신 `pinned`가 된 동일 계열 회귀로 실패했습니다.

## 2. 수정한 P0/P1/P2 항목

### P0 완료

- Stable Pointer reader/writer의 정상 atomic rename 경합을 bounded retry로 처리하고 symlink·junction·hardlink 방어를 유지했습니다.
- Stable Pointer 쓰기에 temp fdatasync, atomic replace, 가능한 플랫폼의 parent directory fsync를 적용했습니다.
- 비-Git workspace의 ambient `GITHUB_SHA` 신뢰를 제거했습니다. 명시적 `sourceIdentity`/`LUNA_SOURCE_COMMIT`이 없으면 본 작업은 계속하되 Evolution은 `legacy_unpinned`, `promotionEligible=false`입니다.
- gateway 오류 분류를 사용자 취소 → 내부 deadline → auth/rate/transport → 일반 AbortError → permanent 순서로 고쳤습니다.
- adaptive permit 다음에 durable launch lease를 획득하게 해 pause/cancel/cap 하향과 backoff permit 불변식을 복구했습니다.
- run manifest의 exclusive create, revision/generation CAS, state/event/final/directive/lease fencing으로 기존 run-id 덮어쓰기와 세대 혼합을 차단했습니다.
- Blackboard를 run generation별 namespace로 분리하고 publish 경계에 generation fencing을 추가했습니다.
- pre-manifest legacy Blackboard를 generation namespace로 원자 이전하며 중단 복구와 symlink/conflict 거부를 추가했습니다.
- legacy accepted/partial team packet에 누락된 immutable `TEAM_REPORT` artifact/message를 재개 시 idempotent backfill합니다.
- verified prompt module을 context truncation에서 분리해 정확한 byte/hash를 보존하고, module 자체가 예산을 넘으면 backend 호출 전에 실패시킵니다.
- App Server stdin backpressure를 bounded FIFO writer로 처리하고 async `EPIPE`를 shard-local transport failure로 회수합니다.
- 정책·출력 검증 오류가 transport circuit을 오염시키지 않게 하고 malformed protocol 응답은 circuit에 반영되는 `AppServerTransportError`로 통일했습니다.
- Gateway와 direct App Server의 same-thread FIFO lock을 abort-aware하게 만들어 대기 중 취소가 predecessor 종료를 기다리지 않고 waiter·permit·occupancy를 즉시 회수합니다.
- Supervisor 종료 시 shard permit waiter와 same-thread lock waiter를 모두 즉시 거부하고 active 호출만 bounded drain 대상으로 유지합니다.
- Stable Pointer·run state·quarantine의 directory fsync에서 지원 불가 오류만 제한적으로 허용하고 `EIO`·`ENOSPC`·권한 오류는 성공으로 숨기지 않습니다.

### P1 부분 완료

- 논리 조직을 고정 128명이 아닌 `auto` 또는 14~256명으로 산정하고 실제 `maxConcurrency`와 분리했습니다.
- revisioned staffing plan의 headcount, reviewer slots, DAG/capability/template/plugin/registry hash와 cell allocation을 정의하고 검증합니다.
- 구조화 메시지와 exact artifact reference 기반 `TEAM_REPORT`를 런타임 Blackboard에 연결했습니다.
- 느린 독립 sibling subtree가 준비된 parent 합성을 막지 않는 completion-driven team synthesis를 연결했습니다.
- content-addressed prompt-module registry/loader를 실제 worker·manager·validator prompt 경계에 연결했습니다. 실행 중 promotion은 현재 run에 영향을 주지 않습니다.
- Genome parent/protected-gate 검증과 global/workload quarantine 저장소를 추가했습니다.
- canonical case/build/environment/budget identity와 실패 Champion을 보존하는 paired outcome primitive를 추가했습니다.
- bounded multi-shard App Server supervisor에 thread affinity, per-shard inflight/queue, startup single-flight, circuit/cooldown, failure isolation, lock 회수와 bounded shutdown을 구현했습니다.

### P2 및 미완료

- 외부 Tool Broker, MAC/서명 capability, 실제 shell/network/file receipt, worktree 격리, Single Committer는 미구현입니다.
- declarative plugin manifest는 hash·검증 경계까지 있으나 optional plugin department를 실제 roster에 배치하는 런타임 경로는 미완료입니다.
- prompt-module 외 topology/workflow/scheduler/context/tool/memory/meeting/reducer component 전체 loader는 미완료입니다.
- Candidate Factory, Shadow/Canary traffic, SLO 기반 자동 rollback/quarantine E2E는 미완료입니다.
- 독립 evaluator 계약과 서명 quality receipt primitive는 있으나 별도 격리 프로세스/서비스 운용은 검증하지 않았습니다.

## 3. 주요 아키텍처 변화

1. **Generation authority**: run manifest를 권위로 삼고 모든 주요 mutation을 generation에 결박했습니다. Blackboard는 `blackboard-v2/generations/<generation>` 아래에 저장됩니다.
2. **Source provenance**: Git HEAD + dirty/untracked digest 또는 명시적 Luna source identity만 Evolution 실행 근거가 됩니다. 증명 불가 상태는 본 작업을 막지 않고 승격만 차단합니다.
3. **Execution/control split**: adaptive concurrency permit과 durable launch lease를 분리하고, 실제 backend send 직전에 durable 상태를 재확인합니다.
4. **Bounded transport**: App Server stdio writer와 shard supervisor가 queue/inflight/backpressure/circuit/shutdown을 유한하게 관리합니다.
5. **Dynamic organization**: `lab-128@2`는 저장 호환용 계약 이름으로 남기고 실제 roster는 mission staffing plan으로 정합니다.
6. **Artifact-first reporting**: team synthesis 결과는 문자열만이 아니라 exact child/task inputs를 가진 immutable Blackboard artifact와 구조화 메시지로 전달됩니다.
7. **Executable Evolution slice**: Stable Pointer가 선택한 prompt module의 canonical bytes가 실제 모델 prompt를 변경합니다. hash 불일치·unknown schema·budget 초과는 fail-closed입니다.
8. **Evaluation identity**: case, candidate build, environment, budget, run/attempt identity를 분리해 Champion 실패도 비교 증거로 보존할 수 있게 했습니다.

## 4. 변경 파일

- CI·패키징·문서: `.github/workflows/ci.yml`, `package.json`, `README.md`, `examples/luna-swarm.config.json`, `docs/HARNESS_V2.ko.md`, `docs/EVOLUTION_HARNESS_V2.ko.md`
- App Server·gateway: `src/backend/agent-backend.ts`, `src/backend/app-server-client.ts`, `src/backend/app-server-supervisor.ts`, `src/backend/codex-app-server.ts`, `src/runtime/gateway.ts`, `src/util.ts`
- CLI·설정·상태: `src/cli.ts`, `src/config.ts`, `src/store.ts`, `src/types.ts`
- Harness v2: `src/harness-v2/blackboard.ts`, `contracts.ts`, `messages.ts`, `organization-registry.ts`, `staffing-plan.ts`, `index.ts`
- Evolution runtime/components: `src/evolution/runtime.ts`, `source-identity.ts`, `domain/canonical.ts`, `components/*`
- Evolution registry/evaluation: `src/evolution/registry/{stable-pointer-store,bundle-store,genome-store,quarantine-store}.ts`, `src/evolution/evaluation/{index,case-identity,paired-outcome}.ts`
- Orchestration: `src/orchestrator.ts`
- 회귀·통합 테스트: `test/unit/{app-server-supervisor,app-server,blackboard-v2,directives,evolution-bundle-v2,evolution-case-identity-v3,evolution-component-v2,evolution-genome-quarantine-v2,evolution-outcome-authority-v3,evolution-runtime-v2,gateway,messages-v2,orchestrator,organization-v2,staffing-plan-v2,store}.test.ts`, 관련 helper/worker fixtures

## 5. 추가한 회귀·통합·chaos 테스트

- Stable Pointer: 4개 프로세스 bootstrap 단일 승자, 2,400회 외부 reader + 96회 atomic replace, symlink/hardlink 공격
- source identity: clean/dirty/untracked Git, non-Git, ambient `GITHUB_SHA`, explicit source, source drift resume
- gateway: caller cancel no-retry, deadline retry, pause 이후 backend 0, cap 하향, backoff permit 0, same-thread 대기 취소 즉시 회수, late cleanup
- run store/Blackboard: 동일 run-id 다중 프로세스 create, stale generation write 차단, legacy artifact migration, directive/lease fencing
- TEAM_REPORT: legacy root/child backfill, idempotent retry, child report input closure
- prompt component: Champion/Challenger의 실제 prompt 차이, run pin 유지, 큰 module exact 보존, oversized fail-before-send
- App Server: stdin false→drain FIFO, queue/message byte 제한, async EPIPE, stale child generation, malformed response circuit, half-open 회복, same-thread 대기 취소, shard 격리와 shutdown waiter 회수/drain
- Genome/Evaluation: parent/protected-gate/quarantine, canonical case identity, 실패 Champion 포함, signed quality receipt 기반 수동 CAS primitive
- 조직: 14/128/256 roster, staffing-plan hash/revision, capability/plugin manifest 검증

## 6. 실행한 명령과 정확한 결과

최종 working tree 검증:

| 명령 | 결과 |
|---|---|
| `npm run check` | PASS — server TypeScript + UI TypeScript |
| `npm test` | PASS — server `342/342`, UI `32/32` |
| `npm run build` | PASS — server compile + Vite UI build |
| `npm audit --audit-level=high` | PASS — vulnerability `0` |
| `git diff --check` | PASS — whitespace error `0` |
| `npm ls --workspaces --depth=0` | PASS |
| `npm pack --dry-run --json` | PASS — 420 files, forbidden workspace/runtime artifact `0` |
| tarball temp install + `luna-swarm --help` | PASS — `luna-swarm-0.1.0.tgz` |
| App Server/supervisor focused suite | PASS — `37/37` |
| Gateway/App Server/supervisor 동시성 suite | PASS — `56/56` |
| final independent architecture/code review | APPROVE — CRITICAL `0`, HIGH `0`, 로컬 merge-ready |

GitHub Actions는 외부 push 금지 조건 때문에 새 커밋으로 재실행하지 않았습니다. 최신 원격 run은 여전히 실패 상태입니다.

## 7. 실제 live 검증과 mock 검증의 구분

Deterministic mock E2E:

- elapsed `3.94s`
- final status `completed`, state revision `65`
- task `3/3 accepted`, team `4`, model calls `25`
- logical agents `17`, observed active calls 최대 `6`
- queue p95 `1ms`, retries `0`, rate-limit events `0`
- Blackboard heads `33`, structured `TEAM_REPORT` messages `4`, events `159`, `final.md` 생성 확인
- non-Git source identity가 없으므로 Evolution은 `legacy_unpinned`, `promotionEligible=false`

이 결과는 mock backend 결과입니다. 실제 ChatGPT 계정, 실제 모델 응답 품질, 과금, 실제 App Server 128/256 동시성을 검증하지 않습니다. App Server 회귀는 로컬 child-process fake RPC로 검증했습니다.

## 8. 성능 및 단일 모델 비교 결과

- Mock E2E의 호출·queue 지표만 수집했습니다. live throughput/p50/p95/p99/RSS/FD/429 용량 보고서는 없습니다.
- 8→16→32→64→128→256 실제 stdio transport soak를 실행하지 않았습니다.
- 강한 단일 모델, 기존 Luna Swarm Champion, 새 Challenger 간 matched-pair 품질·비용·신뢰구간 비교를 실행하지 않았습니다.
- 따라서 “128/256 실사용 가능”, “자동 진화”, “강한 단일 모델보다 우수”를 주장하지 않습니다.

## 9. 남아 있는 미검증 영역

- 최신 GitHub Actions green 및 로컬 Node 20.19 실제 실행
- 실계정 App Server smoke와 128/256 shard soak
- 외부 Tool Broker, credential isolation, domain/path enforcement, G1 command receipt
- 작업별 Git worktree와 Single Committer 통합 E2E
- 실제 원출처 retrieval/snapshot/citation 연구 E2E
- Candidate Factory와 durable Shadow/Canary/automatic rollback 상태기계
- plugin-defined department의 실제 roster allocation
- prompt 외 모든 Evolution component의 실행 loader
- crash/resume 50개 지점, 1,000 seeded chaos run
- coverage threshold와 mutation testing
- 실제 단일 모델/Champion/Challenger benchmark

## 10. 배포 가능 여부

**NO-GO**

최종 독립 architecture/code 재검토에서 CRITICAL/HIGH 잔여가 없어 로컬 코드 merge-readiness는 승인됐습니다. 다만 사용자 완료 조건 중 최신 원격 CI green, live shard soak, Tool Broker/worktree E2E, Canary rollback E2E, 실제 연구 E2E, benchmark 비교가 충족되지 않았으므로 전체 제품 출시는 완료로 판정할 수 없습니다.

## 11. 다음 우선순위

1. 이 로컬 커밋을 허가된 시점에 원격에 올려 Node 20.19/22 CI matrix를 green으로 확인합니다.
2. host-controlled Tool Broker를 read/search 전용 최소 slice부터 구현하고 capability 인증·replay ledger·receipt·credential 격리를 검증합니다.
3. coding worktree + Single Committer로 작은 patch의 구현→test receipt→독립 감사→통합 E2E를 완성합니다.
4. protected benchmark registry와 별도 evaluator runner를 실제 trust domain으로 분리합니다.
5. Shadow/Canary traffic, SLO, 자동 rollback/quarantine 상태기계를 구현합니다.
6. 명시적 허가 후 실제 계정에서 소규모 smoke부터 8→256 단계 soak를 수행합니다.
7. matched-pair 단일 모델/Champion/Challenger benchmark와 coverage/mutation/chaos 보고서를 추가합니다.
