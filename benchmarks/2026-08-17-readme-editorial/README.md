# Luna Swarm README editorial run · 2026-08-17

이 디렉터리는 README 개편을 Luna Swarm 자체에 맡긴 실제 계정 실행의 재현 입력과 적용 기록입니다. 실행은 저장소를 수정하지 않는 `read`/`search` 전용 감사로 제한했고, 최종 편집과 Git 반영은 실행 밖의 단일 committer가 수행했습니다.

## 실행 계약

| 항목 | 값 |
|---|---|
| 모델 | `gpt-5.6-luna` |
| 최종 실행 ID | `readme-editorial-luna-v4-20260817` |
| 상태 | `partial` |
| 논리 조직 / 실제 동시성 | 14 / 2 |
| 작업 | 3 (`accepted` 1, `failed` 1, `blocked` 1) |
| 모델 호출 | 18 |
| exact total tokens | 1,499,669 |
| input / cached input | 1,451,799 / 858,368 |
| output / reasoning output | 47,870 / 21,668 |
| retries / rate limits | 0 / 0 |
| 최대 queue wait | 44,805 ms |

입력은 [mission.txt](mission.txt), 실행 한도는 [config.luna.json](config.luna.json)에 고정했습니다. 외부 네트워크와 이미지 자료는 사용하지 않았습니다.

## 실행 결과를 그대로 과장하지 않은 이유

Luna는 10개의 immutable leaf claim을 보존했지만 R1·R2가 미충족이었고 final critic 이슈 9건이 남아 release를 차단했습니다. 따라서 이 실행을 “README 자동 작성 성공”이나 제품 승격 증거로 부르지 않습니다. 다음 검증된 지적만 편집 입력으로 사용했습니다.

- 기본 Swarm의 Host Tool Broker는 `read`/`search` 전용이며 일반 write·shell·network 권한을 뜻하지 않는다.
- Single Committer는 opt-in CodingPipeline 경계의 실제 Git E2E이고 일반 Work Order 자동 코딩과 구분해야 한다.
- protected evaluator와 Shadow/Canary는 로컬 구현·통합 증거와 장시간 production 검증을 분리해 표시해야 한다.
- HelioDesk v1은 95/95 동점이고 v2는 사후 sensitivity이며, v7도 공식 승자가 없다.
- 저장공간 5 GiB 정책과 보고서 120개 한도는 로컬 구현·테스트 범위이지 외부 장기 내구성 보장이 아니다.
- 반복된 README/docs 문구를 서로 독립된 증거처럼 세지 않아야 한다.

## 실제로 반영한 편집

1. 상단 hero, 신뢰 배지, 빠른 탐색 링크와 작은 실행 다이어그램을 추가했습니다.
2. 구현 상태를 `로컬 검증 / 제한적 실계정 / opt-in / 출시 차단`으로 분리했습니다.
3. 긴 Luna/Sol 비교는 접기 영역으로 이동해 5분 시작을 더 빨리 찾게 했습니다.
4. 권위 경계 표와 문서 지도를 추가하고 오래된 Harness 문서의 상태 충돌을 정정했습니다.
5. production 출시 판정은 계속 `NO-GO`로 유지했습니다.

## 관찰된 실패와 후속 수정

- v1은 설정 최소 조직 크기(14명)를 위반해 모델 호출 전에 중단됐습니다.
- v2·v3는 restricted planner가 부정형 권한 문구를 task contract에 반복하면서 deterministic capability gate에 걸렸습니다.
- planner contract를 “원래 목표의 **긍정적으로 요청된** 미지원 권한만 보존하고, 읽기 전용 금지문에서 새 권한 요구를 만들지 말 것”으로 좁혔습니다. report/audit/synthesis task의 `kind`도 중립 taxonomy를 사용하도록 고정했습니다.
- v4는 architect repair 뒤 실행됐습니다. 잘못된 Host Tool 경로·요청은 Broker가 fail-closed로 거부했고, 유효한 read-only receipt는 작업별로 보존됐습니다.

이 기록은 한 번의 진단 실행입니다. README 품질 우위, 일반 모델 성능, Evolution 자동 승격을 주장하지 않습니다.
