# 제외 실행

`runtime-security-luna-v1-20260817`은 모델 비교에서 제외한다. Mission preflight 한 번은 완료됐지만 planning 전에 원문 mission의 명사구 `일반 Swarm 실행`이 command-execution 요구로 분류되어 `mission_capability_blocked`로 종료됐다. 이는 모델 결과나 품질 실패가 아니라 read-only capability classifier와 benchmark 문구의 충돌이다.

Sol에는 v1 mission을 보내지 않았다. 결과를 보기 전에 `실행`을 `동작`, `실행 결과`를 `검증 사실`로 바꾸고 의미·rubric·evidence·설정은 유지한 `mission.v2.txt`와 별도 `preregistration.v2.json`을 고정한다. v1에서 발생한 Luna preflight 호출과 토큰은 primary pair에 포함하지 않고 이 제외 기록에만 보존한다.

`runtime-security-luna-v2-20260817`도 planning에서 제외됐다. 원문 capability gate는 통과했지만 architect가 생성한 `복구 실행`이라는 명사구를 command 실행으로 오인했고, 한 차례 repair 뒤에도 deterministic plan gate가 작업을 거부했다. 이 실행 역시 worker·validator·최종 결과에 도달하지 않아 모델 품질 비교에 포함하지 않으며 Sol에는 v2를 보내지 않았다.

재현을 통해 `semanticCapabilityDemandForText`의 bare Korean command noun false positive를 수정했다. `복구 실행 경계를 분석한다`와 `복구 실행은 수행하지 않는다`는 read-only로 남고 `복구 스크립트를 실행해줘`와 `저장소 검증 명령을 실행하라`는 command-execution을 계속 요구하는 회귀 테스트를 추가했다. v3는 새 빌드 hash와 별도 preregistration/run ID를 사용한다.

`runtime-security-luna-v3-20260817`도 planning에서 제외됐다. Bare noun 수정은 작동했지만 architect의 `파일을 생성·수정·삭제하지 않는다`와 `쓰기·명령 실행 없음` 같은 묶음 후치 부정을 앞쪽 긍정 action으로 잘못 해석했다. 한 차례 repair가 같은 의미를 `workspace-write·command-execution 불필요`로 표현했지만 deterministic gate는 다시 거부했다. worker 이후 품질 경로에는 도달하지 않았고 Sol에는 v3를 보내지 않았다.

v4에서는 점(`·`) 또는 슬래시로 연결된 Korean action 목록 끝의 `하지 않음`, `금지`, `불필요`, `없음`, `요구하지`, `사용하지`를 해당 묶음에만 적용한다. `파일을 수정하고 삭제하지 마`처럼 긍정과 부정이 접속된 혼합 의도는 workspace-write 요구로 유지하는 회귀도 함께 고정했다.

`runtime-security-luna-v4-20260817`도 planning에서 제외됐다. Mission preflight와 세 planner는 통과했지만 architect가 canonical capability 이름을 사용해 `command-execution·workspace-write·네트워크 불가`라고 쓴 부분에서 `workspace-write`의 `write`가 자연어 동사로 재해석됐다. 자동 repair도 같은 제한을 더 명확히 반복해 동일 deterministic gate에서 종료됐다. 실제 wall time은 329,558ms였으며 Sol에는 v4를 보내지 않았다.

v5에서는 canonical capability identifier를 자연어 action scan에서 제외하고, `네트워크·쓰기·코드 실행 권한 없음`처럼 권한 목록 전체에 붙는 후치 부정을 인식한다. canonical identifier를 제거해도 자연어 `파일을 수정하고 삭제하지 마`는 계속 workspace-write/command-execution으로 판정되는 양성 회귀를 함께 유지한다.

`runtime-security-luna-v6-20260817`은 v5에서 드러난 bounded reference repair, partial final, Host Tool call budget을 반영한 첫 follow-up이었지만 worker 실행 전에 deterministic plan gate가 중단했다. architect가 `증거 매트릭스를 작성하고 ... 파일에 저장하지 않는 구조화된 핸드오프`라고 명시했는데 classifier가 informational output인 `매트릭스`를 알지 못해 앞의 `작성`과 주변의 `기능`/`파일`을 workspace mutation으로 잘못 결합했다. wall time은 301,852 ms였으며 Sol에는 v6를 보내지 않았다.

v7에서는 report/analysis와 같은 비영속 informational output vocabulary에 matrix/table/checklist/register/inventory/catalog/hand-off 및 한국어 대응어를 추가한다. 단, `매트릭스 파일을 생성`, `Write the matrix to docs`처럼 명시적 persistence target이 있으면 workspace-write+command-execution을 계속 요구한다. mission, evidence, config, rubric, scorer는 바꾸지 않는다.
