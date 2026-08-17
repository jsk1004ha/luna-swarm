# Luna Swarm 결과

57 immutable leaf claim(s) passed evidence-lineage validation; final critic issues remain explicit caveats.

## 답변

## Verified claims

- 30/60/90일 권고안은 0~30일 수정·shadow 평가·에스컬레이션 실패 정의, 31~60일 독립 재시험·세그먼트 검증·자동 발송 비활성 유지, 61~90일 전 게이트 통과 시에만 5% canary를 수행하는 순서다.
  - support: 원문의 8주 수정·재검증 일정과 shadow→게이트 통과→5% canary 순서를 일정화한 위험팀 권고다. 실제 수행 여부는 미관측이다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. 교차 테넌트 2/50 Critical, 내부 메모 3/100 High, 보존 90일 대 30일 High, prompt hash 17% 누락 Medium, 전면 출시 차단과 독립 재시험 요구를 확인했다.
  - check: 에스컬레이션 점검: ‘에스컬레이션’은 평균 비율만 일치했고 ‘에스컬레이션 실패’, ‘세그먼트’, ‘원인’은 일치가 없었다. 실패 사건·꼬리위험 평가 불가를 명시하고 정의·모니터링·중단 조건을 위험팀 권고로 구분했다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용·예산·8주 일정, Critical 0, PII 0%, 환각 <0.10%, 로그 ≥99.9%, CSAT 비열등, EU 제외, 상담원 검토 필수 5% canary와 rollback을 확인했다.
- 현재 Critical 발견 1건, PII 노출률 0.25%, prompt hash 완전성 환산 83%도 각각 0건, 0%, 99.9% 이상 게이트를 충족하지 못한다.
  - support: evidence/02-security-review.md의 발견·누락률과 evidence/04-finance-and-launch-gates.md의 필수 게이트를 대조했다. 완전성은 100%-17%=83%로 환산했다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - check: test-or-verification: 이번 수정 시도에서 KPI·비용·게이트 격차를 원수치로 재계산했다. 특히 0.92%-x<0.10%의 해가 x>0.82%p임을 확인했다.
  - evidence: 이번 수정 시도의 evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함과 합성 재현 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, Medium prompt hash 17% 누락; 전면 출시 차단 및 수정 후 독립 재시험 요구.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - evidence: 이번 수정 시도의 재현 계산: 10.2-18.0=-7.8분, -7.8/18.0=-43.33%; 8.1-9.6=-1.5시간, -1.5/9.6=-15.625%; 4.31-4.18=+0.13점, 0.13/4.18=+3.11%; 12.8%-14.2%=-1.4%p, -1.4/14.2=-9.86%; 0.42+1.35=1.77; 1.77-8.20=-6.43, -6.43/8.20=-78.41%; prompt hash 완전성=100%-17%=83%; 0.92%-x<0.10%이면 x>0.82%p.
- 생산성·CSAT·예상 비용 개선은 고심각도 실패를 상쇄하지 않는다.
  - support: 환각 11/1,200 중 환불 정책 오안내 4건, PII 노출 3/1,200, 교차 테넌트 반환 2/50과 내부 메모 노출 3/100이 관측됐다. 자동 발송은 미시험이고 한 고객사가 거부했으며 일본어 표본은 42건뿐이다.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md 직접 read: bytesRead=810, redactions=0. 상담원 24/32의 시간 감소 평가, 6/32의 단정적 톤 지적, EU 레지던시 요구 2/5와 미검증, 자동 발송 거부 1곳, 대표성 제한을 확인했다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 4주, 국내 SMB 티켓 1,200건, 상담원 32명, KPI 원수치, 환각 11건, PII 3건, 일본어 42건과 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 결함 1건과 재현 2/50, High 내부 메모 노출 3/100, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단을 확인했다.
  - check: counterexample-search: 이번 시도에서 ‘자동 발송’, ‘환각’, ‘prompt hash’, ‘대표성’, ‘rollback’을 evidence 전체에서 검색하고 네 파일 전체 read와 대조했다. 고심각도 사건, 자동 발송 미시험·거부, 소표본, 대표성 제한 및 rollback 운영성 미검증을 확인했다.
- CSAT 점추정치는 +0.13점이지만 비열등성 한계, 신뢰구간과 판정 규칙이 없어 정식 CSAT 게이트 통과는 검증할 수 없다.
  - support: 파일럿 문서는 두 점수만 제시하고 재무 문서는 비열등을 요구하지만 통계적 판정 기준은 제공하지 않는다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - check: counterexample-search: 이번 수정 시도의 네 파일 전체 read에서 Critical/High 결함, PII·환각 사건, 로그 누락, 보존 불일치, EU 미검증, 자동 발송 미시험·거부, 표본·대표성 제한과 rollback 조건을 대조했다. 별도 반증 키워드 search는 host의 dynamic tool request failed로 끝나 성공을 주장하지 않는다.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - check: evidence-provenance: 각 KPI 행에 정의, 단위, 기간/모집단, 기준값, 파일럿값, 변화량, 비교 가능성과 실제 파일명을 연결하고 실측·예상·환산을 구분했다.
- 승인 총예산은 USD 120,000이고 수정 예상비는 USD 46,000이며, 수정·재검증 예상 기간은 8주다. USD 74,000은 수정비가 총예산에 포함된다는 조건의 명목 차액일 뿐 확정 가용액이 아니다.
  - support: 금액과 기간은 evidence/04-finance-and-launch-gates.md의 확인 사실이며 포함 관계와 실제 집행액은 제시되지 않았다.
  - check: test-or-verification: KPI, 비용, 감사 로그 완전성 및 조건부 예산 차액을 원수치로 재계산해 문서 수치와 대조했다.
  - evidence: 재계산 결과: 10.2-18.0=-7.8분(-43.3%), 8.1-9.6=-1.5시간(-15.6%), 4.31-4.18=+0.13점(+3.1%), 12.8%-14.2%=-1.4%p(상대 -9.9%), 0.42+1.35=1.77, 8.20-1.77=6.43(78.4%), prompt hash 완전성=100%-17%=83%, 조건부 예산 차액=120,000-46,000=74,000.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.
- 일정 원장: evidence/01-pilot-metrics.md의 파일럿은 2026-06-01~06-28의 4주였고, evidence/04-finance-and-launch-gates.md의 수정·재검증 예상 기간은 8주다. 따라서 약 60일 이전에는 수정 완료와 독립 재시험이 핵심 선행조건이며, canary 기간 자체는 제시되지 않았다.
  - support: 8주는 약 56일이므로 60일 구간에 배치할 수 있지만, 작업 시작일과 세부 일정은 미확정이다.
  - evidence: 30/60/90일 합성 근거: 30일은 수정·shadow 중간 통제, 약 56일인 8주 시점은 독립 재시험과 필수 게이트 판정, 이후는 조건부 5% canary와 rollback으로 연결했다. 책임 주체와 30/90일 의사결정 시점은 실행 가능성을 위한 제안이며 원문에 확정 배정된 정보가 아니다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - evidence: evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명, KPI 기준·파일럿·변화량, 환각 11건, PII 노출 3건, 일본어 42건, 자동 발송 미시험을 확인했다.
- 결론은 제공된 로컬 문서 시점의 증거에 한정되며 문서 최신성, 수정·독립 재시험·shadow·canary·rollback 준비 및 비용 집행은 검증되지 않았다.
  - support: 이번 작업에서는 read/search만 수행했으며 외부 조회, 파일 수정, 배포 또는 승인 행위를 수행하지 않았다.
  - check: 권한·비변경 확인: 허용된 로컬 read/search만 사용했으며 네트워크, 파일 쓰기, 배포, 외부 조치, 승인 또는 자기 검토를 수행하지 않았다.
- 평균 개선과 별개로 중대한 환각 11건 중 4건은 환불 자격 오안내였고 PII 노출은 3건이었다. 일본어 42건과 통계적으로 비대표적인 고객 피드백 때문에 꼬리위험과 세그먼트 성능을 평균 KPI로 일반화할 수 없다.
  - support: 사건과 표본 한계는 evidence/01-pilot-metrics.md 및 evidence/03-customer-feedback.md에 직접 기록되어 있다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 네 KPI, 환각 11건(0.92%), 환불 오안내 4건, PII 3건(0.25%), 일본어 42건, 상담원 검토 보조 모드 및 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md 직접 read: bytesRead=810, redactions=0. EU 레지던시 요구 고객 2/5와 미검증, 자동 발송 명시적 거부 고객 1곳, 대표성 제한을 확인했다.
  - evidence: 이번 시도의 위험·임계값 검색: ‘PII’, ‘환각’, ‘90일’, ‘내부 메모’, ‘prompt hash’, ‘대표성’. 각 결과는 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0이었다.
  - check: counterexample-search: 평균 KPI·비용 가정에 반하는 교차 테넌트, 내부 메모, PII, 환각, 로그 누락, 자동 발송 미시험·거부, EU 미검증, 일본어 소표본, 대표성 제한 및 에스컬레이션 실패 자료 부재를 확인했다.
- 60일 실행안: 목표는 약 8주의 수정·재검증을 완료하고 독립 시험 결과로 출시 게이트를 판정하는 것이다. 산출물은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 4.18 대비 비열등, EU 레지던시 미검증 고객 제외 증거다. 제안 책임 주체는 독립 보안 시험자, 품질 담당, 개인정보 담당, 프로그램 책임자이며 모든 기준을 충족할 때만 5% canary를 승인한다.
  - support: 현재 관찰값인 PII 0.25%, 환각 0.92%, 교차 테넌트 재현 2/50, prompt hash 누락 17%는 필수 게이트에 미달한다. 예산은 USD 46,000의 승인·포함 관계가 확인될 때까지 조건부다.
  - check: 게이트 검증: 현재 관찰값을 Critical 0건, PII 0%, 환각 0.10% 미만, 로그 99.9% 이상, CSAT 4.18 대비 비열등, EU 요구 고객 제외 조건과 대조했다.
  - evidence: 30/60/90일 합성 근거: 30일은 수정·shadow 중간 통제, 약 56일인 8주 시점은 독립 재시험과 필수 게이트 판정, 이후는 조건부 5% canary와 rollback으로 연결했다. 책임 주체와 30/90일 의사결정 시점은 실행 가능성을 위한 제안이며 원문에 확정 배정된 정보가 아니다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - evidence: evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 캐시 결함, High 내부 메모 노출, High 보존기간 불일치, Medium 감사 로그 불완전, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
  - evidence: evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명, KPI 기준·파일럿·변화량, 환각 11건, PII 노출 3건, 일본어 42건, 자동 발송 미시험을 확인했다.
- KPI 원장: 최초 응답시간 중앙값은 18.0분→10.2분(-43.3%), 해결시간 중앙값은 9.6시간→8.1시간(-15.6%), CSAT는 4.18/5→4.31/5(+0.13), 에스컬레이션 비율은 14.2%→12.8%(-1.4%p)였다.
  - support: evidence/01-pilot-metrics.md의 4주·1,200건·상담원 32명 보조 모드 파일럿 표를 전사했다. 자동 발송과 충분한 다국어 표본에는 일반화할 수 없다.
  - check: test-or-verification: 네 문서를 상대경로로 각각 read했고 bytesRead=965/1091/810/1148, redactions=0을 관찰했다. 최초 절대경로 read는 브로커 오류 후 상대경로로 복구했다.
  - evidence: evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명, KPI 기준·파일럿·변화량, 환각 11건, PII 노출 3건, 일본어 42건, 자동 발송 미시험을 확인했다.
- 계산 변화량은 최초 응답시간 -7.8분/-43.3%, 해결시간 -1.5시간/-15.6%, CSAT +0.13점/+3.1%, 에스컬레이션 -1.4%p/상대 -9.9%다.
  - support: 파일럿값에서 기준값을 차감하고 상대 변화율을 기준값 대비로 재계산했다.
  - check: test-or-verification: KPI, 비용, 감사 로그 완전성 및 조건부 예산 차액을 원수치로 재계산해 문서 수치와 대조했다.
  - evidence: evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; KPI 네 항목, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험을 확인했다.
  - evidence: 재계산 결과: 10.2-18.0=-7.8분(-43.3%), 8.1-9.6=-1.5시간(-15.6%), 4.31-4.18=+0.13점(+3.1%), 12.8%-14.2%=-1.4%p(상대 -9.9%), 0.42+1.35=1.77, 8.20-1.77=6.43(78.4%), prompt hash 완전성=100%-17%=83%, 조건부 예산 차액=120,000-46,000=74,000.
- 보안·개인정보 위험은 교차 테넌트 캐시 결함(Critical), 내부 메모 노출(High), PII 교차 티켓 노출(Critical·위험팀 추론), 보존기간 불일치(High), EU 레지던시 미검증(High·위험팀 추론), 감사 로그 불완전(Medium)이다. 요구 통제의 완료는 관찰되지 않았다.
  - support: 발견 사항과 원문 심각도는 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md에 근거한다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 네 KPI, 환각 11건(0.92%), 환불 오안내 4건, PII 3건(0.25%), 일본어 42건, 상담원 검토 보조 모드 및 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md 직접 read: bytesRead=810, redactions=0. EU 레지던시 요구 고객 2/5와 미검증, 자동 발송 명시적 거부 고객 1곳, 대표성 제한을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. 교차 테넌트 2/50 Critical, 내부 메모 3/100 High, 보존 90일 대 30일 High, prompt hash 17% 누락 Medium, 전면 출시 차단과 독립 재시험 요구를 확인했다.
  - evidence: 이번 시도의 위험·임계값 검색: ‘PII’, ‘환각’, ‘90일’, ‘내부 메모’, ‘prompt hash’, ‘대표성’. 각 결과는 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0이었다.
- 보조 모드 예상 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 즉 78.4% 낮지만 실제 파일럿 비용이 아니라 기간·모집단이 없는 재무 가정이다.
  - support: evidence/04-finance-and-launch-gates.md는 추론비 USD 0.42와 필수 검토비 USD 1.35의 합을 예상 처리비로 명시한다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - evidence: 이번 수정 시도의 재현 계산: 10.2-18.0=-7.8분, -7.8/18.0=-43.33%; 8.1-9.6=-1.5시간, -1.5/9.6=-15.625%; 4.31-4.18=+0.13점, 0.13/4.18=+3.11%; 12.8%-14.2%=-1.4%p, -1.4/14.2=-9.86%; 0.42+1.35=1.77; 1.77-8.20=-6.43, -6.43/8.20=-78.41%; prompt hash 완전성=100%-17%=83%; 0.92%-x<0.10%이면 x>0.82%p.
  - check: evidence-provenance: 각 KPI 행에 정의, 단위, 기간/모집단, 기준값, 파일럿값, 변화량, 비교 가능성과 실제 파일명을 연결하고 실측·예상·환산을 구분했다.
- 보조 모드 예상 처리비는 USD 1.77/티켓으로 기존 USD 8.20 대비 78.4% 절감 가정이다. 승인 예산 USD 120,000에서 수정 예상비 USD 46,000을 단순 차감한 잔액은 USD 74,000이며 실제 집행과 추가 비용은 검증되지 않았다.
  - support: 비용·예산·8주 일정은 evidence/04-finance-and-launch-gates.md에 근거하고 USD 74,000은 산술 결과다.
  - check: 현재값·산술 대조: 교차 테넌트 2건>0, PII 0.25%>0%, 환각 0.92%≥0.10%, prompt hash 추정 완전성 83%<99.9%다. CSAT의 정식 비열등 검정은 없다. (8.20-1.77)/8.20=78.4146%이며 120,000-46,000=74,000이다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용·예산·8주 일정, Critical 0, PII 0%, 환각 <0.10%, 로그 ≥99.9%, CSAT 비열등, EU 제외, 상담원 검토 필수 5% canary와 rollback을 확인했다.
- 분석 대상은 정확히 4개이며 파일명은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md이다.
  - support: 이번 시도의 ^# 검색이 네 경로와 fileInventoryComplete=true, filesSearched=4, truncated=false를 반환했고 네 파일을 각각 다시 읽었다.
  - evidence: 이번 시도의 인벤터리·섹션 검색(^#): evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; fileInventoryComplete=true, filesSearched=4, truncated=false, redactions=0.
  - check: test-or-verification: 이번 시도에서 인벤터리 검색 후 네 파일을 각각 다시 read하여 접근 상태, bytesRead, redactions 및 본문을 확인했다.
- T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.
  - support: 직접 제공된 T05 artifact의 requirementIds는 R-02부터 R-11까지이며 R-01 claim 또는 보고서 위치가 없다. 이는 추적성 미해결 결함이다.
  - evidence: 직접 제공된 dependency artifact task-T05-8a4148231d87-result revision 1: ‘보류’ 결정과 KPI·위험·비용·30/60/90일 계획을 포함한다. 최상위 requirementIds와 claims는 R-02~R-11만 연결하며 verificationStatus는 unverified다.
  - check: requirements-coverage: 이번 시도에서 T05의 claims, requirementIds와 deliverables를 R-01~R-11에 재매핑했다. R-01 연결 부재를 확인했고 T01 원장은 제공 입력에 없어 대조 불가로 기록했다.
- 평균 에스컬레이션 비율은 개선됐지만 에스컬레이션 실패 사건의 정의·건수·원인·세그먼트별 결과는 제공되지 않아 실패 꼬리위험을 평가할 수 없다. 위험팀은 canary 전에 승인된 에스컬레이션 조건을 충족했으나 적시에 사람에게 전달되지 않은 사건을 정의하고, 전체 canary와 세그먼트별로 모니터링하며, 중대 실패 1건 발생 시 중단·수동 rollback하도록 권고한다.
  - support: ‘에스컬레이션’ 검색은 평균 비율 한 건만 반환했고 ‘에스컬레이션 실패’, ‘세그먼트’, ‘원인’ 검색은 네 파일에서 일치가 없었다. 사건 정의·중대성 분류·임계값·책임 주체는 위험팀 권고다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 네 KPI, 환각 11건(0.92%), 환불 오안내 4건, PII 3건(0.25%), 일본어 42건, 상담원 검토 보조 모드 및 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 부재 검색: ‘에스컬레이션 실패’, ‘세그먼트’, ‘원인’. 각 검색은 filesSearched=4, fileInventoryComplete=true, matches=[], truncated=false, redactions=0이었다.
  - evidence: 이번 시도의 검색: ‘에스컬레이션’, ‘자동 발송’, ‘시험하지 않았다’, ‘명시적으로 거부’, ‘rollback’, ‘상담원 검토’. 각 결과는 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0이었다. 에스컬레이션 관련 일치는 평균 비율 행뿐이었다.
  - check: 에스컬레이션 점검: ‘에스컬레이션’은 평균 비율만 일치했고 ‘에스컬레이션 실패’, ‘세그먼트’, ‘원인’은 일치가 없었다. 실패 사건·꼬리위험 평가 불가를 명시하고 정의·모니터링·중단 조건을 위험팀 권고로 구분했다.
- 전면 출시 보류는 비용 절감 전망보다 출시 차단 결론과 미충족 안전 게이트를 우선한 가역적 결정이다. 제한 출시는 모든 게이트를 통과한 뒤 5% canary에만 조건부로 허용한다.
  - support: 예상 절감률은 보조 모드 가정이고 실제 집행자료가 아니며, 보안 검토는 명시적으로 전면 출시를 차단한다.
  - check: 게이트 검증: 현재 관찰값을 Critical 0건, PII 0%, 환각 0.10% 미만, 로그 99.9% 이상, CSAT 4.18 대비 비열등, EU 요구 고객 제외 조건과 대조했다.
  - check: adversarial-risk-review: 승인 예산과 수정 예상비의 포함 관계, 일회성 여부, 누락 비용, 자동 발송 미시험, EU 레지던시 미검증, 대표성 제한, 책임 주체의 제안 성격과 rollback 조건을 별도 표시했다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - evidence: evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 캐시 결함, High 내부 메모 노출, High 보존기간 불일치, Medium 감사 로그 불완전, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
- SRC-01은 4주·1,200건·상담원 32명의 파일럿 범위, 네 KPI의 기준값·파일럿값·변화량, 환각 11건·PII 노출 3건, 일본어 표본 부족 및 자동 발송 미시험을 기록한다.
  - support: evidence/01-pilot-metrics.md 재읽기와 KPI·환각·PII·기간·자동 발송 검색에 직접 근거한다.
  - evidence: 이번 시도의 기본 주제 검색: KPI, 보안, 개인정보, 품질, 비용, 예산, 일정. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였다. '비용' 정확어는 0건이었고 '처리비'와 '예상비' 검색으로 비용 표현을 확인했다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명; 최초 응답시간 18.0→10.2분(-43.3%), 해결시간 9.6→8.1시간(-15.6%), CSAT 4.18→4.31(+0.13), 에스컬레이션 14.2%→12.8%(-1.4%p); 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
- 고심각도 위험별 진입 게이트에는 지표 또는 판정 조건, 적용 범위, 권고 책임 주체, 판정 시점과 미충족 조치를 연결했다. 원문에 없는 내부 메모·자동 발송·에스컬레이션 실패의 세부 조건은 위험팀 권고로 구분했다.
  - support: 원문 임계값과 수정 요구를 보존했으며 독립 재시험 및 canary 최소 표본·관찰 기간은 미정으로 유지했다.
  - check: 자동 발송 게이트 점검: 별도 안전성 시험, 고객 동의, 적용 범위, 권고 책임 주체, 활성화 전 판정, 미충족 시 비활성화의 여섯 속성을 독립 claim과 deliverable에 명시했다. 이 조건은 위험팀 권고이며 완료된 시험으로 주장하지 않았다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. 교차 테넌트 2/50 Critical, 내부 메모 3/100 High, 보존 90일 대 30일 High, prompt hash 17% 누락 Medium, 전면 출시 차단과 독립 재시험 요구를 확인했다.
  - check: 에스컬레이션 점검: ‘에스컬레이션’은 평균 비율만 일치했고 ‘에스컬레이션 실패’, ‘세그먼트’, ‘원인’은 일치가 없었다. 실패 사건·꼬리위험 평가 불가를 명시하고 정의·모니터링·중단 조건을 위험팀 권고로 구분했다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용·예산·8주 일정, Critical 0, PII 0%, 환각 <0.10%, 로그 ≥99.9%, CSAT 비열등, EU 제외, 상담원 검토 필수 5% canary와 rollback을 확인했다.
- 판정 근거는 제공된 로컬 evidence/ 자료로 제한되며 최신성, 외부 대표성, 수정·재시험·배포 등 관찰되지 않은 조치의 실제 수행 여부는 검증되지 않았다.
  - support: 이번 시도에는 로컬 read/search만 사용했다. 문서 자체도 자동 발송 미시험, EU 레지던시 미검증 및 피드백 대표성 제한을 명시한다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명; 최초 응답시간 18.0→10.2분(-43.3%), 해결시간 9.6→8.1시간(-15.6%), CSAT 4.18→4.31(+0.13), 에스컬레이션 14.2%→12.8%(-1.4%p); 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md read: bytesRead=810, redactions=0. 상담원 24/32가 초안 시간 감소, 6명은 단정적 톤, 2명은 차이 없음; 고객사 2/5가 EU 레지던시 요구, 서울 리전만 사용해 미검증; 한 고객사가 자동 발송 거부; 통계적 대표성은 보장되지 않음.
  - check: 권한·비변경 확인: 이번 시도에는 허용된 로컬 read/search만 사용했으며 네트워크, 외부 자료, 파일 쓰기 또는 승인 행위를 수행하지 않았다.
- SRC-04는 기존 처리비 USD 8.20/티켓과 보조 모드 예상 처리비 USD 1.77/티켓, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주, 전면 출시 게이트 및 5% canary rollback 경로를 기록한다.
  - support: evidence/04-finance-and-launch-gates.md 재읽기와 처리비·예상비·예산·기간·게이트·rollback 검색에 직접 근거한다.
  - evidence: 이번 시도의 기본 주제 검색: KPI, 보안, 개인정보, 품질, 비용, 예산, 일정. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였다. '비용' 정확어는 0건이었고 '처리비'와 '예상비' 검색으로 비용 표현을 확인했다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 0.10% 미만, 로그 완전성 99.9% 이상, CSAT 비열등 및 5% canary/rollback 경로.
- 현재 출시 결정은 보류다. 수정 후 독립 재시험과 모든 필수 게이트 통과 전에는 전면 출시 또는 고객 대상 제한 출시를 정당화할 수 없다.
  - support: 보안 검토가 전면 출시를 명시적으로 차단하고 여러 필수 게이트가 현재 관찰값 기준 실패했다. 이는 네 문서를 결합한 연구팀 판단이다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - evidence: 이번 수정 시도의 반증 검토: 생산성·CSAT 개선과 비용 가정에 반해 Critical/High 결함, PII 노출, 환각 게이트 초과, 로그 누락, 보존기간 불일치, EU 레지던시 미검증, 자동 발송 미시험·거부, 일본어 표본 부족, 피드백 대표성 제한이 존재한다.
  - check: counterexample-search: 이번 수정 시도의 네 파일 전체 read에서 Critical/High 결함, PII·환각 사건, 로그 누락, 보존 불일치, EU 미검증, 자동 발송 미시험·거부, 표본·대표성 제한과 rollback 조건을 대조했다. 별도 반증 키워드 search는 host의 dynamic tool request failed로 끝나 성공을 주장하지 않는다.
  - evidence: 이번 수정 시도의 evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함과 합성 재현 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, Medium prompt hash 17% 누락; 전면 출시 차단 및 수정 후 독립 재시험 요구.
- SRC-03은 상담원·고객 피드백, EU 데이터 레지던시의 계약 요구와 미검증 상태, 자동 발송 거부 및 통계적 대표성 제한을 기록한다.
  - support: evidence/03-customer-feedback.md 재읽기와 레지던시·자동 발송·검증되지·대표성 검색에 직접 근거한다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md read: bytesRead=810, redactions=0. 상담원 24/32가 초안 시간 감소, 6명은 단정적 톤, 2명은 차이 없음; 고객사 2/5가 EU 레지던시 요구, 서울 리전만 사용해 미검증; 한 고객사가 자동 발송 거부; 통계적 대표성은 보장되지 않음.
- SRC-02는 교차 테넌트 캐시 결함(Critical), 내부 메모 노출과 보존기간 불일치(High), 감사 로그 불완전(Medium), 현재 전면 출시 차단 결론을 기록한다.
  - support: evidence/02-security-review.md 재읽기와 보안·개인정보·기간·누락·차단·불일치 검색에 직접 근거한다.
  - evidence: 이번 시도의 기본 주제 검색: KPI, 보안, 개인정보, 품질, 비용, 예산, 일정. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였다. '비용' 정확어는 0건이었고 '처리비'와 '예상비' 검색으로 비용 표현을 확인했다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md read: bytesRead=1091, redactions=0. 교차 테넌트 결함은 합성 재현 50회 중 2회, 내부 메모 노출은 100건 중 3건, 로그 보존 90일 대 승인 상한 30일, prompt hash 17% 누락; 보안 결론은 전면 출시 차단 및 수정 후 독립 재시험 필요.
- 이번 시도의 광범위 '.' 검색은 matchCount=1000에서 truncated=true, filesSearched=2로 종료되어 전체 본문 검색 근거로 사용할 수 없었다. 이후 좁은 검색은 filesSearched=4와 truncated=false를 반환해 주제별 관찰을 보완했다.
  - support: 광범위 검색의 실제 truncation 결과를 evidence ordinal 7에 별도로 기록했고, 좁은 검색 결과는 ordinals 5와 6에 기록했다.
  - evidence: 이번 시도의 광범위 '.' 검색 요약: 네 파일의 인벤터리는 반환됐지만 matchCount=1000, truncated=true, filesSearched=2, fileInventoryComplete=true, redactions=0이었다. 따라서 이 검색은 전체 본문 완전성 근거로 사용하지 않았다.
  - evidence: 이번 시도의 기본 주제 검색: KPI, 보안, 개인정보, 품질, 비용, 예산, 일정. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였다. '비용' 정확어는 0건이었고 '처리비'와 '예상비' 검색으로 비용 표현을 확인했다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
- 문서에는 canary 위반 시 수동 프로세스 rollback이 명시됐지만 유출 이후 데이터 회수 가능성은 입증되지 않았다.
  - support: rollback 경로 자체는 evidence/04-finance-and-launch-gates.md의 직접 증거다. 이미 노출된 PII 또는 교차 테넌트 정보가 운영 rollback으로 회수된다고 볼 근거가 없다는 부분은 직접 진술이 아닌 감사 추론이며 미검증 위험으로만 사용했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 결함 1건과 재현 2/50, High 내부 메모 노출 3/100, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단을 확인했다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용 USD 8.20/0.42/1.35/1.77, 총예산 USD 120,000, 수정비 USD 46,000, 8주 일정, 필수 게이트와 shadow→5% canary→rollback 경로를 확인했다.
  - check: counterexample-search: 이번 시도에서 ‘자동 발송’, ‘환각’, ‘prompt hash’, ‘대표성’, ‘rollback’을 evidence 전체에서 검색하고 네 파일 전체 read와 대조했다. 고심각도 사건, 자동 발송 미시험·거부, 소표본, 대표성 제한 및 rollback 운영성 미검증을 확인했다.
- 전면 출시는 명시적 보안 차단과 다수 필수 게이트 실패 때문에 기각하며, 제한 출시도 현재는 동일 결함이 고객에게 영향을 줄 수 있고 자동 발송이 미시험이므로 기각한다. 향후 5% canary는 현재 결정이 아니라 전 게이트 통과 후의 재심 경로다.
  - support: evidence/02-security-review.md의 출시 차단, evidence/01-pilot-metrics.md의 자동 발송 미시험, evidence/04-finance-and-launch-gates.md의 shadow→전 게이트 통과→5% canary 경로를 대조했다.
  - evidence: evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
  - check: counterexample-search: 생산성·CSAT·비용의 긍정 증거에 반하는 보안 차단, PII·환각 사건, 로그 누락, 보존 불일치, EU 미검증, 자동 발송 미시험·거부, 다국어 소표본과 대표성 제한을 네 파일 전체 read에서 확인했다. 별도 결합 키워드 검색 두 건은 dynamic tool request failed였으므로 검색 성공을 주장하지 않는다.
  - evidence: evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; KPI 네 항목, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험을 확인했다.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.
- 확대는 모든 진입 게이트 통과 후 상담원 검토 필수 5% canary에서만 검토한다. canary 중 어느 필수 게이트라도 위반하면 즉시 이전 수동 프로세스로 rollback한다.
  - support: 5% canary와 즉시 rollback은 evidence/04-finance-and-launch-gates.md에 명시되어 있다. 최소 표본과 관찰 기간은 제공되지 않았다.
  - evidence: 이번 시도의 검색: ‘에스컬레이션’, ‘자동 발송’, ‘시험하지 않았다’, ‘명시적으로 거부’, ‘rollback’, ‘상담원 검토’. 각 결과는 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0이었다. 에스컬레이션 관련 일치는 평균 비율 행뿐이었다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용·예산·8주 일정, Critical 0, PII 0%, 환각 <0.10%, 로그 ≥99.9%, CSAT 비열등, EU 제외, 상담원 검토 필수 5% canary와 rollback을 확인했다.
- 90일 실행안: 60일 게이트가 전부 통과된 경우에만 상담원 검토가 필수인 5% canary를 수행하고 EU 레지던시 요구 고객은 제외한다. 제안 책임 주체는 제품·지원운영·신뢰성 운영이며, 게이트 위반 시 즉시 이전 수동 프로세스로 rollback한다. canary 운영 기간·추가 인프라비·독립 시험비는 문서에 없어 조건부 미확정 항목이며, 90일 시점에는 확대·유지·rollback 중 하나를 결정한다.
  - support: 5% canary와 rollback은 evidence/04-finance-and-launch-gates.md의 권고 경로다. 자동 발송은 시험되지 않았고 한 고객사가 거부했으므로 90일 계획에도 포함하지 않는다.
  - evidence: 30/60/90일 합성 근거: 30일은 수정·shadow 중간 통제, 약 56일인 8주 시점은 독립 재시험과 필수 게이트 판정, 이후는 조건부 5% canary와 rollback으로 연결했다. 책임 주체와 30/90일 의사결정 시점은 실행 가능성을 위한 제안이며 원문에 확정 배정된 정보가 아니다.
  - check: adversarial-risk-review: 승인 예산과 수정 예상비의 포함 관계, 일회성 여부, 누락 비용, 자동 발송 미시험, EU 레지던시 미검증, 대표성 제한, 책임 주체의 제안 성격과 rollback 조건을 별도 표시했다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - evidence: evidence/03-customer-feedback.md read: bytesRead=810, redactions=0. 상담원 피드백, EU 레지던시 미검증, 자동 발송 거부, 제한적 보조 모드 선호와 통계적 대표성 제한을 확인했다.
  - evidence: evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명, KPI 기준·파일럿·변화량, 환각 11건, PII 노출 3건, 일본어 42건, 자동 발송 미시험을 확인했다.
- 네 파일은 모두 접근 가능했고 Markdown과 한국어 본문이 정상적으로 읽혔으며 각 read 결과의 redactions는 0이었다. 범위 내 누락 또는 중복 경로는 관찰되지 않았다.
  - support: 재읽기 결과는 각각 bytesRead 965, 1091, 810, 1148 및 redactions=0을 반환했고 인벤터리는 네 고유 경로와 fileInventoryComplete=true를 반환했다. 내용 중복성은 별도 해시 비교를 하지 않아 판정하지 않았다.
  - evidence: 이번 시도의 인벤터리·섹션 검색(^#): evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; fileInventoryComplete=true, filesSearched=4, truncated=false, redactions=0.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 0.10% 미만, 로그 완전성 99.9% 이상, CSAT 비열등 및 5% canary/rollback 경로.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명; 최초 응답시간 18.0→10.2분(-43.3%), 해결시간 9.6→8.1시간(-15.6%), CSAT 4.18→4.31(+0.13), 에스컬레이션 14.2%→12.8%(-1.4%p); 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md read: bytesRead=810, redactions=0. 상담원 24/32가 초안 시간 감소, 6명은 단정적 톤, 2명은 차이 없음; 고객사 2/5가 EU 레지던시 요구, 서울 리전만 사용해 미검증; 한 고객사가 자동 발송 거부; 통계적 대표성은 보장되지 않음.
  - evidence: 이번 시도의 evidence/02-security-review.md read: bytesRead=1091, redactions=0. 교차 테넌트 결함은 합성 재현 50회 중 2회, 내부 메모 노출은 100건 중 3건, 로그 보존 90일 대 승인 상한 30일, prompt hash 17% 누락; 보안 결론은 전면 출시 차단 및 수정 후 독립 재시험 필요.
- 자동 발송은 별도 안전성 시험 통과와 대상 고객의 명시적 동의를 모두 충족해야만 활성화할 수 있다. 적용 범위는 자동 발송 후보 고객·사용 사례 전체, 권고 책임 주체는 제품 안전 책임자와 고객 계약 책임자, 판정 시점은 활성화 전이며 미충족 시 계속 비활성화하고 상담원 검토 보조 모드를 유지해야 한다.
  - support: 원문은 자동 발송이 시험되지 않았고 고객 한 곳이 명시적으로 거부했음을 기록한다. 안전성 시험·동의 결합 조건과 책임 주체는 위험팀 권고이며 원문 게이트가 아니다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 네 KPI, 환각 11건(0.92%), 환불 오안내 4건, PII 3건(0.25%), 일본어 42건, 상담원 검토 보조 모드 및 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md 직접 read: bytesRead=810, redactions=0. EU 레지던시 요구 고객 2/5와 미검증, 자동 발송 명시적 거부 고객 1곳, 대표성 제한을 확인했다.
  - check: 자동 발송 게이트 점검: 별도 안전성 시험, 고객 동의, 적용 범위, 권고 책임 주체, 활성화 전 판정, 미충족 시 비활성화의 여섯 속성을 독립 claim과 deliverable에 명시했다. 이 조건은 위험팀 권고이며 완료된 시험으로 주장하지 않았다.
  - evidence: 이번 시도의 검색: ‘에스컬레이션’, ‘자동 발송’, ‘시험하지 않았다’, ‘명시적으로 거부’, ‘rollback’, ‘상담원 검토’. 각 결과는 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0이었다. 에스컬레이션 관련 일치는 평균 비율 행뿐이었다.
- 30일 실행안: 목표는 외부 전면 출시 차단을 유지하면서 Critical 캐시 결함, 내부 메모 노출, 90일 보존 불일치와 prompt hash 누락을 수정하고 내부 shadow 평가를 가동하는 것이다. 제안 책임 주체는 엔지니어링, 보안, 개인정보 담당이며, 선행조건은 수정 범위·독립 재시험 기준·USD 46,000의 승인 및 총예산 포함 여부 확정이다. 30일 의사결정 게이트는 수정 증거, 회귀시험 준비도와 예산 확정 여부이며 미충족 시 계속 보류한다.
  - support: 책임 주체는 문서의 결함 영역을 기준으로 한 실행 제안이지 문서에 확정된 조직 배정이 아니다. 외부 출시 차단과 shadow 평가는 원문 권고에 따른다.
  - check: 게이트 검증: 현재 관찰값을 Critical 0건, PII 0%, 환각 0.10% 미만, 로그 99.9% 이상, CSAT 4.18 대비 비열등, EU 요구 고객 제외 조건과 대조했다.
  - evidence: 30/60/90일 합성 근거: 30일은 수정·shadow 중간 통제, 약 56일인 8주 시점은 독립 재시험과 필수 게이트 판정, 이후는 조건부 5% canary와 rollback으로 연결했다. 책임 주체와 30/90일 의사결정 시점은 실행 가능성을 위한 제안이며 원문에 확정 배정된 정보가 아니다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - evidence: evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 캐시 결함, High 내부 메모 노출, High 보존기간 불일치, Medium 감사 로그 불완전, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
- 판단에 사용한 자료는 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md의 네 로컬 문서뿐이다.
  - support: 네 파일을 직접 read했고 제목 검색에서 filesSearched=4, fileInventoryComplete=true, truncated=false를 확인했다.
  - evidence: evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
  - evidence: 제목 검색 결과: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0.
  - evidence: evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; KPI 네 항목, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험을 확인했다.
  - evidence: evidence/03-customer-feedback.md 직접 read: bytesRead=810, redactions=0. 상담원 24/32의 시간 감소 평가, 6/32의 단정적 톤 지적, EU 레지던시 요구 고객 2/5와 미검증, 자동 발송 거부 고객 1곳, 피드백의 대표성 제한을 확인했다.
  - check: test-or-verification: 이번 실행에서 네 파일을 직접 read해 bytesRead=965/1091/810/1148, 각 redactions=0을 확인했다.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.
  - check: evidence-provenance: 제목 검색은 네 파일, filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0을 반환했다. 외부 자료는 사용하지 않았다.
- 결론은 제공된 로컬 자료에만 근거하며 최신성, 실제 수정·재시험·배포 및 비용 집행은 검증되지 않았다.
  - support: 이번 수정 시도에는 허용된 로컬 read/search만 사용했고 파일 쓰기나 외부 자료 조회를 수행하지 않았다.
  - check: 권한·비변경 확인: 이번 수정 시도에는 로컬 read/search만 사용했으며 네트워크, 외부 자료, 파일 쓰기, 배포, 승인 또는 자기 검토를 수행하지 않았다. 이전 G3 거절을 현재 통과로 해석하지 않았다.
  - evidence: 이번 수정 시도의 제목 검색 결과: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0.
- T05가 표시한 네 출처 파일은 evidence 디렉터리에 존재하며 이번 시도에서 모두 직접 읽었다.
  - support: 검색 결과 filesSearched=4, fileInventoryComplete=true, truncated=false였고 각 read는 965/1091/810/1148 bytesRead, redactions=0을 반환했다.
  - evidence: 이번 시도의 evidence/03-customer-feedback.md 직접 read: bytesRead=810, redactions=0. 상담원 24/32의 시간 감소 평가, 6/32의 단정적 톤 지적, EU 레지던시 요구 2/5와 미검증, 자동 발송 거부 1곳, 대표성 제한을 확인했다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 4주, 국내 SMB 티켓 1,200건, 상담원 32명, KPI 원수치, 환각 11건, PII 3건, 일본어 42건과 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 결함 1건과 재현 2/50, High 내부 메모 노출 3/100, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단을 확인했다.
  - evidence: 이번 시도의 evidence 검색 결과: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용 USD 8.20/0.42/1.35/1.77, 총예산 USD 120,000, 수정비 USD 46,000, 8주 일정, 필수 게이트와 shadow→5% canary→rollback 경로를 확인했다.
  - check: evidence-provenance: 이번 시도에서 네 파일을 직접 read하고 evidence 검색으로 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0을 확인했다. 외부 자료는 사용하지 않았다.
- 주제 색인은 KPI→SRC-01/SRC-04, 보안→SRC-02/SRC-04, 개인정보→SRC-01/SRC-02/SRC-03/SRC-04, 품질→SRC-01/SRC-03/SRC-04, 비용·예산→SRC-04, 일정→SRC-01/SRC-04로 구성된다.
  - support: 기본 및 확장 주제 검색이 각각 네 파일을 모두 검사했으며 일치와 불일치를 관찰했다.
  - evidence: 이번 시도의 기본 주제 검색: KPI, 보안, 개인정보, 품질, 비용, 예산, 일정. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였다. '비용' 정확어는 0건이었고 '처리비'와 '예상비' 검색으로 비용 표현을 확인했다.
  - check: evidence-provenance: 이번 시도에서 KPI·보안·개인정보·품질·비용·예산·일정 및 확장 동의어를 검색하고 각 검색의 filesSearched=4, truncated=false를 확인했다.
  - evidence: 이번 시도의 확장·반증 검색: 환각, PII, 레지던시, 자동 발송, 처리비, 예상비, 기간, 게이트, 누락, 검증되지, 대표성, 차단, 불일치, rollback. 각 검색은 filesSearched=4, fileInventoryComplete=true, truncated=false였으며 미시험·미검증·대표성 제한·출시 차단·보존기간 불일치·로그 누락·rollback을 확인했다.
- 비용 원장: evidence/04-finance-and-launch-gates.md의 기존 처리비는 USD 8.20/티켓, HelioDesk 추론비는 USD 0.42/티켓, 필수 상담원 검토비는 USD 1.35/티켓이며 합산 예상 처리비는 USD 1.77/티켓이다. 모두 보조 모드의 반복성 티켓당 변동비로 해석되며 실제 청구액은 검증되지 않았다.
  - support: USD 0.42와 USD 1.35의 합은 USD 1.77이고, 기존 대비 티켓당 USD 6.43 및 78.4%의 단순 절감이다. 합산액과 구성비를 동시에 총비용에 더하면 중복 산정된다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - check: 산술 검증: 0.42+1.35=1.77, 8.20-1.77=6.43, 6.43/8.20 반올림=78.4%를 대조했다. 구성비와 합산비의 중복 산정 가능성을 표시했다.
  - evidence: 결정적 산술 대조: USD 0.42+USD 1.35=USD 1.77/티켓; USD 8.20-USD 1.77=USD 6.43/티켓; USD 6.43÷USD 8.20=78.4%. USD 120,000-USD 46,000=USD 74,000은 수정비가 승인 예산에 포함된다는 조건에서만 성립한다.
- 중대한 환각률 0.92%는 '<0.10%' 게이트를 실패하며, 통과하려면 0.82%p를 초과해 감소해야 한다.
  - support: 0.92%-x<0.10%를 만족하려면 x>0.82%p이다. 엄격 부등호 때문에 정확히 0.82%p 감소한 0.10%도 통과가 아니다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - check: finding-repair: 비교 가능성 문구를 '전후 변화는 계산할 수 없고'로 수정해 표·주장·결측 목록과 일치시켰다. 환각 게이트는 엄격 부등호를 반영해 '0.82%p 초과 감소 필요'로 표, 주장, 계산 근거와 위험 표에 일관되게 표시했다.
  - check: test-or-verification: 이번 수정 시도에서 KPI·비용·게이트 격차를 원수치로 재계산했다. 특히 0.92%-x<0.10%의 해가 x>0.82%p임을 확인했다.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - evidence: 이번 수정 시도의 재현 계산: 10.2-18.0=-7.8분, -7.8/18.0=-43.33%; 8.1-9.6=-1.5시간, -1.5/9.6=-15.625%; 4.31-4.18=+0.13점, 0.13/4.18=+3.11%; 12.8%-14.2%=-1.4%p, -1.4/14.2=-9.86%; 0.42+1.35=1.77; 1.77-8.20=-6.43, -6.43/8.20=-78.41%; prompt hash 완전성=100%-17%=83%; 0.92%-x<0.10%이면 x>0.82%p.
- T05의 핵심 KPI 변화량은 원수치와 일치한다.
  - support: 4주간 국내 SMB 티켓 1,200건과 동일 상담원 32명 모집단에서 최초 응답시간 -7.8분/-43.3%, 해결시간 -1.5시간/-15.6%, CSAT +0.13점/상대 +3.1%, 에스컬레이션 -1.4%p/상대 -9.9%로 재계산됐다. 상대 CSAT와 상대 에스컬레이션 변화는 계산값이며 원문 표는 절대 변화만 제시한다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 4주, 국내 SMB 티켓 1,200건, 상담원 32명, KPI 원수치, 환각 11건, PII 3건, 일본어 42건과 자동 발송 미시험을 확인했다.
  - check: test-or-verification—재계산: 10.2-18.0=-7.8; -7.8/18=-43.33%. 8.1-9.6=-1.5; -1.5/9.6=-15.625%. 4.31-4.18=0.13; 0.13/4.18=3.11%. 12.8-14.2=-1.4%p; -1.4/14.2=-9.86%. 11/1,200=0.9167%; 3/1,200=0.25%; 100%-17%=83%.
- 동일한 4주·1,200건·32명 파일럿에서 최초 응답시간은 18.0분에서 10.2분, 해결시간은 9.6시간에서 8.1시간, CSAT는 4.18에서 4.31, 에스컬레이션 비율은 14.2%에서 12.8%로 변했다.
  - support: evidence/01-pilot-metrics.md에 기간, 모집단, 기준값과 파일럿값이 함께 명시돼 있다.
  - check: test-or-verification: 이번 수정 시도에서 KPI·비용·게이트 격차를 원수치로 재계산했다. 특히 0.92%-x<0.10%의 해가 x>0.82%p임을 확인했다.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - check: evidence-provenance: 각 KPI 행에 정의, 단위, 기간/모집단, 기준값, 파일럿값, 변화량, 비교 가능성과 실제 파일명을 연결하고 실측·예상·환산을 구분했다.
- 안정적인 파일별 식별자는 SRC-01=evidence/01-pilot-metrics.md, SRC-02=evidence/02-security-review.md, SRC-03=evidence/03-customer-feedback.md, SRC-04=evidence/04-finance-and-launch-gates.md로 정의한다.
  - support: 완전한 인벤터리의 서로 다른 네 경로에 식별자를 일대일로 고정했다.
  - evidence: 이번 시도의 인벤터리·섹션 검색(^#): evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; fileInventoryComplete=true, filesSearched=4, truncated=false, redactions=0.
  - check: 출처 식별자 검증: SRC-01~SRC-04가 이번 인벤터리의 네 고유 경로와 일대일 대응하는지 확인했다.
- 예상 보조 모드 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 78.4% 낮지만 실제 파일럿 청구액이 아닌 재무 가정이다.
  - support: evidence/04-finance-and-launch-gates.md의 추론비 USD 0.42와 필수 검토비 USD 1.35를 합산하고 기존 처리비와 비교했다.
  - check: test-or-verification: KPI, 비용, 감사 로그 완전성 및 조건부 예산 차액을 원수치로 재계산해 문서 수치와 대조했다.
  - evidence: 재계산 결과: 10.2-18.0=-7.8분(-43.3%), 8.1-9.6=-1.5시간(-15.6%), 4.31-4.18=+0.13점(+3.1%), 12.8%-14.2%=-1.4%p(상대 -9.9%), 0.42+1.35=1.77, 8.20-1.77=6.43(78.4%), prompt hash 완전성=100%-17%=83%, 조건부 예산 차액=120,000-46,000=74,000.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.
- 원수치로 재계산한 변화량은 최초 응답시간 -7.8분/-43.3%, 해결시간 -1.5시간/-15.6%, CSAT +0.13점/+3.1%, 에스컬레이션 -1.4%p/상대 -9.9%이다.
  - support: 절대 변화는 파일럿값-기준값, 상대 변화율은 절대 변화/기준값으로 계산했다.
  - check: test-or-verification: 이번 수정 시도에서 KPI·비용·게이트 격차를 원수치로 재계산했다. 특히 0.92%-x<0.10%의 해가 x>0.82%p임을 확인했다.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - evidence: 이번 수정 시도의 재현 계산: 10.2-18.0=-7.8분, -7.8/18.0=-43.33%; 8.1-9.6=-1.5시간, -1.5/9.6=-15.625%; 4.31-4.18=+0.13점, 0.13/4.18=+3.11%; 12.8%-14.2%=-1.4%p, -1.4/14.2=-9.86%; 0.42+1.35=1.77; 1.77-8.20=-6.43, -6.43/8.20=-78.41%; prompt hash 완전성=100%-17%=83%; 0.92%-x<0.10%이면 x>0.82%p.
- 세 선택지 중 단일 결정은 ‘보류’다. 수정과 독립 재시험에서 모든 필수 게이트가 통과될 때 재심한다.
  - support: 보안 검토가 전면 출시를 명시적으로 차단하며 현재 Critical, PII, 환각 및 감사 로그 관측값이 출시 게이트를 충족하지 못한다.
  - check: test-or-verification: 현재 관측값을 Critical 0건, PII 0%, 환각률 <0.10%, prompt hash 완전성 ≥99.9%, CSAT 비열등 및 EU 대상 제외 게이트와 대조했다.
  - evidence: evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
  - evidence: 반대 증거 검토: 생산성·CSAT 개선과 예상 비용 절감에 반해 Critical/High 결함, PII 노출, 환각 게이트 초과, 감사 로그 누락, 보존기간 불일치, EU 미검증, 자동 발송 미시험·거부, 일본어 소표본 및 피드백 대표성 제한이 존재한다.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.
- ‘보류’ 결정은 관측된 필수 게이트 상태와 일치한다.
  - support: Critical 발견 0건 게이트에 대해 Critical 결함 1건이 존재하고, PII 0.25%는 0% 게이트를, 환각 0.92%는 0.10% 미만 게이트를, prompt hash 완전성 83%는 99.9% 이상 게이트를 충족하지 못한다. CSAT는 점추정치가 개선됐지만 비열등성 판정 자료가 없다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 4주, 국내 SMB 티켓 1,200건, 상담원 32명, KPI 원수치, 환각 11건, PII 3건, 일본어 42건과 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 결함 1건과 재현 2/50, High 내부 메모 노출 3/100, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단을 확인했다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용 USD 8.20/0.42/1.35/1.77, 총예산 USD 120,000, 수정비 USD 46,000, 8주 일정, 필수 게이트와 shadow→5% canary→rollback 경로를 확인했다.
  - check: test-or-verification—게이트: Critical 0건 대비 Critical 결함 1건=실패; PII 0% 대비 0.25%=실패; 환각 <0.10% 대비 0.92%=실패; prompt hash ≥99.9% 대비 83%=실패; CSAT 비열등성=판정 자료 부족.
- 분석 대상은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md의 정확히 네 로컬 파일이다.
  - support: 이번 수정 시도에 네 파일을 각각 다시 read했고, 제목 검색은 네 경로와 filesSearched=4, fileInventoryComplete=true, truncated=false를 반환했다.
  - check: test-or-verification: 이번 수정 시도에서 네 파일을 각각 다시 read했고 bytesRead 965, 1091, 810, 1148과 redactions=0을 확인했다. 제목 검색은 네 파일, filesSearched=4, fileInventoryComplete=true, truncated=false를 반환했다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - evidence: 이번 수정 시도의 evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함과 합성 재현 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, Medium prompt hash 17% 누락; 전면 출시 차단 및 수정 후 독립 재시험 요구.
  - evidence: 이번 수정 시도의 evidence/03-customer-feedback.md read: bytesRead=810, redactions=0. 상담원 24/32가 초안 시간 감소, 6/32는 단정적 톤, 2/32는 차이 없음; 고객사 2/5가 EU 레지던시 요구, 서울 리전만 사용해 미검증; 한 고객사가 자동 발송을 거부; 대표성은 보장되지 않음.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - evidence: 이번 수정 시도의 제목 검색 결과: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md; filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0.
- 인계 준비 판정은 ‘미준비’다.
  - support: 판정 근거는 제출물 내부에서 관찰 가능한 R-01 추적 누락, T01 원장 부재, Critical·PII·환각·감사 로그 게이트 실패와 CSAT 비열등성 미검증으로 한정했다. 보완 후 독립 재시험과 출처·요구사항 재대조가 필요하다.
  - check: readiness-verification: 인계 미준비 근거를 R-01 누락, T01 부재, 네 필수 게이트 실패와 CSAT 미검증으로 한정했다. rollback 이후 데이터 회수 문제는 직접 증거가 아닌 감사 추론으로 명시했다. 파일 수정, 네트워크, 배포 또는 승인을 수행하지 않았다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 4주, 국내 SMB 티켓 1,200건, 상담원 32명, KPI 원수치, 환각 11건, PII 3건, 일본어 42건과 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 결함 1건과 재현 2/50, High 내부 메모 노출 3/100, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단을 확인했다.
  - evidence: 직접 제공된 dependency artifact task-T05-8a4148231d87-result revision 1: ‘보류’ 결정과 KPI·위험·비용·30/60/90일 계획을 포함한다. 최상위 requirementIds와 claims는 R-02~R-11만 연결하며 verificationStatus는 unverified다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용 USD 8.20/0.42/1.35/1.77, 총예산 USD 120,000, 수정비 USD 46,000, 8주 일정, 필수 게이트와 shadow→5% canary→rollback 경로를 확인했다.
- 평균 KPI는 최초 응답시간 18.0→10.2분(-43.3%), 해결시간 9.6→8.1시간(-15.6%), CSAT 4.18→4.31(+0.13), 에스컬레이션 비율 14.2%→12.8%(-1.4%p)로 개선됐다.
  - support: evidence/01-pilot-metrics.md의 4주·1,200건·상담원 32명 보조 모드 파일럿 결과다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 네 KPI, 환각 11건(0.92%), 환불 오안내 4건, PII 3건(0.25%), 일본어 42건, 상담원 검토 보조 모드 및 자동 발송 미시험을 확인했다.
  - check: test-or-verification: 이번 시도에서 네 파일을 다시 read해 bytesRead=965/1091/810/1148, redactions=0을 관찰했다. 파일 쓰기·네트워크·승인 행위는 수행하지 않았다.
- 현재 전면 출시는 보류해야 한다. evidence/02-security-review.md가 전면 출시 차단을 명시하고, Critical·PII·환각·로그 관측값이 evidence/04-finance-and-launch-gates.md의 임계값을 충족하지 못한다.
  - support: 이번 시도에서 네 문서를 다시 읽고 PII·환각·prompt hash와 출시 경로를 검색·대조했다.
  - evidence: 이번 시도의 evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 네 KPI, 환각 11건(0.92%), 환불 오안내 4건, PII 3건(0.25%), 일본어 42건, 상담원 검토 보조 모드 및 자동 발송 미시험을 확인했다.
  - evidence: 이번 시도의 evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. 교차 테넌트 2/50 Critical, 내부 메모 3/100 High, 보존 90일 대 30일 High, prompt hash 17% 누락 Medium, 전면 출시 차단과 독립 재시험 요구를 확인했다.
  - check: 현재값·산술 대조: 교차 테넌트 2건>0, PII 0.25%>0%, 환각 0.92%≥0.10%, prompt hash 추정 완전성 83%<99.9%다. CSAT의 정식 비열등 검정은 없다. (8.20-1.77)/8.20=78.4146%이며 120,000-46,000=74,000이다.
  - evidence: 이번 시도의 위험·임계값 검색: ‘PII’, ‘환각’, ‘90일’, ‘내부 메모’, ‘prompt hash’, ‘대표성’. 각 결과는 filesSearched=4, fileInventoryComplete=true, truncated=false, redactions=0이었다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용·예산·8주 일정, Critical 0, PII 0%, 환각 <0.10%, 로그 ≥99.9%, CSAT 비열등, EU 제외, 상담원 검토 필수 5% canary와 rollback을 확인했다.
- 주요 위험은 Critical 교차 테넌트 데이터 혼선, High 내부 메모 노출, High 보존기간 불일치, High 수준으로 취급해야 할 실제 PII 노출, 품질상 중대한 환각 0.92%, Medium 감사 로그 불완전성이다. EU 레지던시와 자동 발송은 미검증 범위다.
  - support: 심각도 명칭 중 교차 테넌트·내부 메모·보존기간·감사 로그는 보안 검토 원문을 따랐다. 파일럿 PII 사건의 High 분류는 영향에 따른 전략적 우선순위 제안이며 원문이 직접 부여한 등급은 아니다.
  - check: adversarial-risk-review: 승인 예산과 수정 예상비의 포함 관계, 일회성 여부, 누락 비용, 자동 발송 미시험, EU 레지던시 미검증, 대표성 제한, 책임 주체의 제안 성격과 rollback 조건을 별도 표시했다.
  - evidence: evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 캐시 결함, High 내부 메모 노출, High 보존기간 불일치, Medium 감사 로그 불완전, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
  - evidence: evidence/03-customer-feedback.md read: bytesRead=810, redactions=0. 상담원 피드백, EU 레지던시 미검증, 자동 발송 거부, 제한적 보조 모드 선호와 통계적 대표성 제한을 확인했다.
  - evidence: evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 1,200건, 상담원 32명, KPI 기준·파일럿·변화량, 환각 11건, PII 노출 3건, 일본어 42건, 자동 발송 미시험을 확인했다.
- 품질·보안 비율은 기준값이 없어 전후 변화량을 계산할 수 없고 출시 게이트와의 격차만 판정할 수 있다.
  - support: 환각률, PII 노출률, 교차 테넌트 재현률과 prompt hash 완전성에는 이전 상태의 동일 정의 기준값이 제시되지 않았다.
  - evidence: 이번 수정 시도의 evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론비 USD 0.42, 검토비 USD 1.35, 예상 합계 USD 1.77, 절감률 78.4%; 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주; Critical 0건, PII 0%, 환각률 <0.10%, 로그 완전성 ≥99.9%, CSAT 비열등 및 5% canary/rollback 경로.
  - check: finding-repair: 비교 가능성 문구를 '전후 변화는 계산할 수 없고'로 수정해 표·주장·결측 목록과 일치시켰다. 환각 게이트는 엄격 부등호를 반영해 '0.82%p 초과 감소 필요'로 표, 주장, 계산 근거와 위험 표에 일관되게 표시했다.
  - evidence: 이번 수정 시도의 evidence/02-security-review.md read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함과 합성 재현 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, Medium prompt hash 17% 누락; 전면 출시 차단 및 수정 후 독립 재시험 요구.
  - evidence: 이번 수정 시도의 evidence/01-pilot-metrics.md read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; 18.0→10.2분, 9.6→8.1시간, CSAT 4.18→4.31, 에스컬레이션 14.2%→12.8%; 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험.
  - check: evidence-provenance: 각 KPI 행에 정의, 단위, 기간/모집단, 기준값, 파일럿값, 변화량, 비교 가능성과 실제 파일명을 연결하고 실측·예상·환산을 구분했다.
- 동일한 4주·1,200건·상담원 32명 파일럿에서 최초 응답시간은 18.0분에서 10.2분, 해결시간은 9.6시간에서 8.1시간, CSAT는 4.18에서 4.31, 에스컬레이션 비율은 14.2%에서 12.8%로 개선됐다.
  - support: evidence/01-pilot-metrics.md에 모집단과 기준값·파일럿값이 함께 제시돼 있다.
  - check: test-or-verification: KPI, 비용, 감사 로그 완전성 및 조건부 예산 차액을 원수치로 재계산해 문서 수치와 대조했다.
  - evidence: evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; KPI 네 항목, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험을 확인했다.
- 비용·예산·일정 수치는 원문 및 산술과 일치하지만 실제 사업 실적은 아니다.
  - support: USD 0.42+1.35=1.77, USD 8.20-1.77=6.43이며 절감률은 78.4%다. 총예산 USD 120,000, 수정 예상비 USD 46,000, 수정·재검증 기간 8주는 원문과 일치한다. 조건부 차액 USD 74,000은 수정비 포함 관계와 추가 비용이 불명확해 가용 잔액으로 확정할 수 없다.
  - check: test-or-verification—재계산: 10.2-18.0=-7.8; -7.8/18=-43.33%. 8.1-9.6=-1.5; -1.5/9.6=-15.625%. 4.31-4.18=0.13; 0.13/4.18=3.11%. 12.8-14.2=-1.4%p; -1.4/14.2=-9.86%. 11/1,200=0.9167%; 3/1,200=0.25%; 100%-17%=83%.
  - check: test-or-verification—비용: 0.42+1.35=1.77; 8.20-1.77=6.43; 6.43/8.20=78.4%. 120,000-46,000=74,000은 포함 관계가 성립할 때만 가능한 조건부 차액이다.
  - evidence: 이번 시도의 evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 비용 USD 8.20/0.42/1.35/1.77, 총예산 USD 120,000, 수정비 USD 46,000, 8주 일정, 필수 게이트와 shadow→5% canary→rollback 경로를 확인했다.
- 예산 원장: evidence/04-finance-and-launch-gates.md에는 2026년 하반기 총 프로그램 예산 USD 120,000이 승인되었고, 보안·개인정보 수정비 USD 46,000은 예상액으로 제시된다. USD 46,000의 별도 승인 여부, 총예산 포함 여부, 집행 여부는 명시되지 않았다.
  - support: 포함된다고 가정할 때만 산술상 USD 74,000이 남지만 이는 가용 잔액으로 확정할 수 없다. 수정비는 프로젝트성 일회 비용으로 보이지만 문서가 반복성을 명시하지 않아 조건부로 분류했다.
  - check: adversarial-risk-review: 승인 예산과 수정 예상비의 포함 관계, 일회성 여부, 누락 비용, 자동 발송 미시험, EU 레지던시 미검증, 대표성 제한, 책임 주체의 제안 성격과 rollback 조건을 별도 표시했다.
  - evidence: evidence/04-finance-and-launch-gates.md read: bytesRead=1148, redactions=0. 티켓당 USD 8.20/0.42/1.35/1.77, 78.4% 절감, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 게이트, shadow·5% canary·rollback 경로를 확인했다.
  - check: 산술 검증: 0.42+1.35=1.77, 8.20-1.77=6.43, 6.43/8.20 반올림=78.4%를 대조했다. 구성비와 합산비의 중복 산정 가능성을 표시했다.
  - evidence: 결정적 산술 대조: USD 0.42+USD 1.35=USD 1.77/티켓; USD 8.20-USD 1.77=USD 6.43/티켓; USD 6.43÷USD 8.20=78.4%. USD 120,000-USD 46,000=USD 74,000은 수정비가 승인 예산에 포함된다는 조건에서만 성립한다.
- 재심은 착수 후 약 60일인 독립 재시험 완료 시점에 수행하며, 모든 필수 게이트가 통과된 경우에만 상담원 검토 필수 5% canary를 검토한다. canary 중 게이트 위반 시 즉시 기존 수동 프로세스로 rollback한다.
  - support: 8주 재검증 기간과 5% canary·rollback 경로는 evidence/04-finance-and-launch-gates.md에 명시돼 있다. 60일 배치는 8주를 30/60/90일 계획에 반영한 실행 추론이다.
  - check: test-or-verification: 현재 관측값을 Critical 0건, PII 0%, 환각률 <0.10%, prompt hash 완전성 ≥99.9%, CSAT 비열등 및 EU 대상 제외 게이트와 대조했다.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.
- 현재 Critical 발견은 0건 게이트에 실패하고, PII 0.25%는 0% 게이트에 실패하며, 중대한 환각률 0.92%는 0.10% 미만 게이트에 실패하고, prompt hash 완전성 환산 83%는 99.9% 이상 게이트에 실패한다.
  - support: evidence/01-pilot-metrics.md와 evidence/02-security-review.md의 관측값을 evidence/04-finance-and-launch-gates.md의 임계값과 대조했다. 완전성 83%는 17% 누락에서 환산했다.
  - check: test-or-verification: 현재 관측값을 Critical 0건, PII 0%, 환각률 <0.10%, prompt hash 완전성 ≥99.9%, CSAT 비열등 및 EU 대상 제외 게이트와 대조했다.
  - evidence: evidence/02-security-review.md 직접 read: bytesRead=1091, redactions=0. Critical 교차 테넌트 결함 2/50, High 내부 메모 노출 3/100, High 보존기간 90일 대 승인 상한 30일, prompt hash 17% 누락, 전면 출시 차단 및 독립 재시험 요구를 확인했다.
  - evidence: evidence/01-pilot-metrics.md 직접 read: bytesRead=965, redactions=0. 2026-06-01~06-28, 국내 SMB 티켓 1,200건, 상담원 32명; KPI 네 항목, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%), 일본어 42건, 자동 발송 미시험을 확인했다.
  - evidence: 재계산 결과: 10.2-18.0=-7.8분(-43.3%), 8.1-9.6=-1.5시간(-15.6%), 4.31-4.18=+0.13점(+3.1%), 12.8%-14.2%=-1.4%p(상대 -9.9%), 0.42+1.35=1.77, 8.20-1.77=6.43(78.4%), prompt hash 완전성=100%-17%=83%, 조건부 예산 차액=120,000-46,000=74,000.
  - evidence: evidence/04-finance-and-launch-gates.md 직접 read: bytesRead=1148, redactions=0. 기존 USD 8.20/티켓, 추론 USD 0.42, 검토 USD 1.35, 합계 USD 1.77, 예산 USD 120,000, 수정 예상비 USD 46,000, 8주 일정, 필수 출시 게이트와 5% canary·rollback 경로를 확인했다.

## Requirement coverage

- R-01: evidence/의 분석 대상이 정확히 네 문서인지 확인하고 네 문서를 실제 읽기·검색한 관찰 증거와 실제 파일명을 기록한다.
  - 분석 대상은 정확히 4개이며 파일명은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md이다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 인계 준비 판정은 ‘미준비’다.
- R-02: 모든 주요 사실, 수치, 위험, 계산 및 권고를 확인된 파일명과 추적 가능하게 연결한다.
  - 현재 Critical 발견 1건, PII 노출률 0.25%, prompt hash 완전성 환산 83%도 각각 0건, 0%, 99.9% 이상 게이트를 충족하지 못한다.; 일정 원장: evidence/01-pilot-metrics.md의 파일럿은 2026-06-01~06-28의 4주였고, evidence/04-finance-and-launch-gates.md의 수정·재검증 예상 기간은 8주다. 따라서 약 60일 이전에는 수정 완료와 독립 재시험이 핵심 선행조건이며, canary 기간 자체는 제시되지 않았다.; 60일 실행안: 목표는 약 8주의 수정·재검증을 완료하고 독립 시험 결과로 출시 게이트를 판정하는 것이다. 산출물은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 4.18 대비 비열등, EU 레지던시 미검증 고객 제외 증거다. 제안 책임 주체는 독립 보안 시험자, 품질 담당, 개인정보 담당, 프로그램 책임자이며 모든 기준을 충족할 때만 5% canary를 승인한다.; KPI 원장: 최초 응답시간 중앙값은 18.0분→10.2분(-43.3%), 해결시간 중앙값은 9.6시간→8.1시간(-15.6%), CSAT는 4.18/5→4.31/5(+0.13), 에스컬레이션 비율은 14.2%→12.8%(-1.4%p)였다.; 보안·개인정보 위험은 교차 테넌트 캐시 결함(Critical), 내부 메모 노출(High), PII 교차 티켓 노출(Critical·위험팀 추론), 보존기간 불일치(High), EU 레지던시 미검증(High·위험팀 추론), 감사 로그 불완전(Medium)이다. 요구 통제의 완료는 관찰되지 않았다.; 보조 모드 예상 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 즉 78.4% 낮지만 실제 파일럿 비용이 아니라 기간·모집단이 없는 재무 가정이다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; SRC-01은 4주·1,200건·상담원 32명의 파일럿 범위, 네 KPI의 기준값·파일럿값·변화량, 환각 11건·PII 노출 3건, 일본어 표본 부족 및 자동 발송 미시험을 기록한다.; SRC-04는 기존 처리비 USD 8.20/티켓과 보조 모드 예상 처리비 USD 1.77/티켓, 승인 예산 USD 120,000, 수정 예상비 USD 46,000, 재검증 8주, 전면 출시 게이트 및 5% canary rollback 경로를 기록한다.; SRC-03은 상담원·고객 피드백, EU 데이터 레지던시의 계약 요구와 미검증 상태, 자동 발송 거부 및 통계적 대표성 제한을 기록한다.; SRC-02는 교차 테넌트 캐시 결함(Critical), 내부 메모 노출과 보존기간 불일치(High), 감사 로그 불완전(Medium), 현재 전면 출시 차단 결론을 기록한다.; 판단에 사용한 자료는 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md의 네 로컬 문서뿐이다.; T05가 표시한 네 출처 파일은 evidence 디렉터리에 존재하며 이번 시도에서 모두 직접 읽었다.; 주제 색인은 KPI→SRC-01/SRC-04, 보안→SRC-02/SRC-04, 개인정보→SRC-01/SRC-02/SRC-03/SRC-04, 품질→SRC-01/SRC-03/SRC-04, 비용·예산→SRC-04, 일정→SRC-01/SRC-04로 구성된다.; 비용 원장: evidence/04-finance-and-launch-gates.md의 기존 처리비는 USD 8.20/티켓, HelioDesk 추론비는 USD 0.42/티켓, 필수 상담원 검토비는 USD 1.35/티켓이며 합산 예상 처리비는 USD 1.77/티켓이다. 모두 보조 모드의 반복성 티켓당 변동비로 해석되며 실제 청구액은 검증되지 않았다.; 동일한 4주·1,200건·32명 파일럿에서 최초 응답시간은 18.0분에서 10.2분, 해결시간은 9.6시간에서 8.1시간, CSAT는 4.18에서 4.31, 에스컬레이션 비율은 14.2%에서 12.8%로 변했다.; 세 선택지 중 단일 결정은 ‘보류’다. 수정과 독립 재시험에서 모든 필수 게이트가 통과될 때 재심한다.; 분석 대상은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md의 정확히 네 로컬 파일이다.; 평균 KPI는 최초 응답시간 18.0→10.2분(-43.3%), 해결시간 9.6→8.1시간(-15.6%), CSAT 4.18→4.31(+0.13), 에스컬레이션 비율 14.2%→12.8%(-1.4%p)로 개선됐다.; 현재 전면 출시는 보류해야 한다. evidence/02-security-review.md가 전면 출시 차단을 명시하고, Critical·PII·환각·로그 관측값이 evidence/04-finance-and-launch-gates.md의 임계값을 충족하지 못한다.; 동일한 4주·1,200건·상담원 32명 파일럿에서 최초 응답시간은 18.0분에서 10.2분, 해결시간은 9.6시간에서 8.1시간, CSAT는 4.18에서 4.31, 에스컬레이션 비율은 14.2%에서 12.8%로 개선됐다.
- R-03: 전면 출시, 제한 출시, 보류 중 정확히 하나를 최종 결정으로 제시하고 다른 두 선택지의 기각 근거를 밝힌다.
  - T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 전면 출시는 명시적 보안 차단과 다수 필수 게이트 실패 때문에 기각하며, 제한 출시도 현재는 동일 결함이 고객에게 영향을 줄 수 있고 자동 발송이 미시험이므로 기각한다. 향후 5% canary는 현재 결정이 아니라 전 게이트 통과 후의 재심 경로다.; 세 선택지 중 단일 결정은 ‘보류’다. 수정과 독립 재시험에서 모든 필수 게이트가 통과될 때 재심한다.; ‘보류’ 결정은 관측된 필수 게이트 상태와 일치한다.
- R-04: 핵심 KPI의 정의, 단위, 기간 또는 모집단, 기준값, 파일럿값, 절대 변화와 적용 가능한 상대 변화율 또는 퍼센트포인트를 표로 제시한다.
  - 현재 Critical 발견 1건, PII 노출률 0.25%, prompt hash 완전성 환산 83%도 각각 0건, 0%, 99.9% 이상 게이트를 충족하지 못한다.; CSAT 점추정치는 +0.13점이지만 비열등성 한계, 신뢰구간과 판정 규칙이 없어 정식 CSAT 게이트 통과는 검증할 수 없다.; 계산 변화량은 최초 응답시간 -7.8분/-43.3%, 해결시간 -1.5시간/-15.6%, CSAT +0.13점/+3.1%, 에스컬레이션 -1.4%p/상대 -9.9%다.; 보조 모드 예상 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 즉 78.4% 낮지만 실제 파일럿 비용이 아니라 기간·모집단이 없는 재무 가정이다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 현재 출시 결정은 보류다. 수정 후 독립 재시험과 모든 필수 게이트 통과 전에는 전면 출시 또는 고객 대상 제한 출시를 정당화할 수 없다.; 중대한 환각률 0.92%는 '<0.10%' 게이트를 실패하며, 통과하려면 0.82%p를 초과해 감소해야 한다.; T05의 핵심 KPI 변화량은 원수치와 일치한다.; 동일한 4주·1,200건·32명 파일럿에서 최초 응답시간은 18.0분에서 10.2분, 해결시간은 9.6시간에서 8.1시간, CSAT는 4.18에서 4.31, 에스컬레이션 비율은 14.2%에서 12.8%로 변했다.; 원수치로 재계산한 변화량은 최초 응답시간 -7.8분/-43.3%, 해결시간 -1.5시간/-15.6%, CSAT +0.13점/+3.1%, 에스컬레이션 -1.4%p/상대 -9.9%이다.; 품질·보안 비율은 기준값이 없어 전후 변화량을 계산할 수 없고 출시 게이트와의 격차만 판정할 수 있다.; 동일한 4주·1,200건·상담원 32명 파일럿에서 최초 응답시간은 18.0분에서 10.2분, 해결시간은 9.6시간에서 8.1시간, CSAT는 4.18에서 4.31, 에스컬레이션 비율은 14.2%에서 12.8%로 개선됐다.
- R-05: 보안·개인정보·품질 위험을 근거, 영향, 심각도, 완화 상태 및 잔여 위험과 함께 정리한다.
  - 생산성·CSAT·예상 비용 개선은 고심각도 실패를 상쇄하지 않는다.; 평균 개선과 별개로 중대한 환각 11건 중 4건은 환불 자격 오안내였고 PII 노출은 3건이었다. 일본어 42건과 통계적으로 비대표적인 고객 피드백 때문에 꼬리위험과 세그먼트 성능을 평균 KPI로 일반화할 수 없다.; 보안·개인정보 위험은 교차 테넌트 캐시 결함(Critical), 내부 메모 노출(High), PII 교차 티켓 노출(Critical·위험팀 추론), 보존기간 불일치(High), EU 레지던시 미검증(High·위험팀 추론), 감사 로그 불완전(Medium)이다. 요구 통제의 완료는 관찰되지 않았다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 평균 에스컬레이션 비율은 개선됐지만 에스컬레이션 실패 사건의 정의·건수·원인·세그먼트별 결과는 제공되지 않아 실패 꼬리위험을 평가할 수 없다. 위험팀은 canary 전에 승인된 에스컬레이션 조건을 충족했으나 적시에 사람에게 전달되지 않은 사건을 정의하고, 전체 canary와 세그먼트별로 모니터링하며, 중대 실패 1건 발생 시 중단·수동 rollback하도록 권고한다.; 고심각도 위험별 진입 게이트에는 지표 또는 판정 조건, 적용 범위, 권고 책임 주체, 판정 시점과 미충족 조치를 연결했다. 원문에 없는 내부 메모·자동 발송·에스컬레이션 실패의 세부 조건은 위험팀 권고로 구분했다.; 전면 출시는 명시적 보안 차단과 다수 필수 게이트 실패 때문에 기각하며, 제한 출시도 현재는 동일 결함이 고객에게 영향을 줄 수 있고 자동 발송이 미시험이므로 기각한다. 향후 5% canary는 현재 결정이 아니라 전 게이트 통과 후의 재심 경로다.; 자동 발송은 별도 안전성 시험 통과와 대상 고객의 명시적 동의를 모두 충족해야만 활성화할 수 있다. 적용 범위는 자동 발송 후보 고객·사용 사례 전체, 권고 책임 주체는 제품 안전 책임자와 고객 계약 책임자, 판정 시점은 활성화 전이며 미충족 시 계속 비활성화하고 상담원 검토 보조 모드를 유지해야 한다.; ‘보류’ 결정은 관측된 필수 게이트 상태와 일치한다.; 현재 전면 출시는 보류해야 한다. evidence/02-security-review.md가 전면 출시 차단을 명시하고, Critical·PII·환각·로그 관측값이 evidence/04-finance-and-launch-gates.md의 임계값을 충족하지 못한다.; 현재 Critical 발견은 0건 게이트에 실패하고, PII 0.25%는 0% 게이트에 실패하며, 중대한 환각률 0.92%는 0.10% 미만 게이트에 실패하고, prompt hash 완전성 환산 83%는 99.9% 이상 게이트에 실패한다.
- R-06: 출시 진입·확대·중단에 사용할 측정 가능한 go/no-go 게이트와 미충족 시 조치를 제시한다.
  - 30/60/90일 권고안은 0~30일 수정·shadow 평가·에스컬레이션 실패 정의, 31~60일 독립 재시험·세그먼트 검증·자동 발송 비활성 유지, 61~90일 전 게이트 통과 시에만 5% canary를 수행하는 순서다.; 생산성·CSAT·예상 비용 개선은 고심각도 실패를 상쇄하지 않는다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 평균 에스컬레이션 비율은 개선됐지만 에스컬레이션 실패 사건의 정의·건수·원인·세그먼트별 결과는 제공되지 않아 실패 꼬리위험을 평가할 수 없다. 위험팀은 canary 전에 승인된 에스컬레이션 조건을 충족했으나 적시에 사람에게 전달되지 않은 사건을 정의하고, 전체 canary와 세그먼트별로 모니터링하며, 중대 실패 1건 발생 시 중단·수동 rollback하도록 권고한다.; 고심각도 위험별 진입 게이트에는 지표 또는 판정 조건, 적용 범위, 권고 책임 주체, 판정 시점과 미충족 조치를 연결했다. 원문에 없는 내부 메모·자동 발송·에스컬레이션 실패의 세부 조건은 위험팀 권고로 구분했다.; 문서에는 canary 위반 시 수동 프로세스 rollback이 명시됐지만 유출 이후 데이터 회수 가능성은 입증되지 않았다.; 전면 출시는 명시적 보안 차단과 다수 필수 게이트 실패 때문에 기각하며, 제한 출시도 현재는 동일 결함이 고객에게 영향을 줄 수 있고 자동 발송이 미시험이므로 기각한다. 향후 5% canary는 현재 결정이 아니라 전 게이트 통과 후의 재심 경로다.; 확대는 모든 진입 게이트 통과 후 상담원 검토 필수 5% canary에서만 검토한다. canary 중 어느 필수 게이트라도 위반하면 즉시 이전 수동 프로세스로 rollback한다.; 자동 발송은 별도 안전성 시험 통과와 대상 고객의 명시적 동의를 모두 충족해야만 활성화할 수 있다. 적용 범위는 자동 발송 후보 고객·사용 사례 전체, 권고 책임 주체는 제품 안전 책임자와 고객 계약 책임자, 판정 시점은 활성화 전이며 미충족 시 계속 비활성화하고 상담원 검토 보조 모드를 유지해야 한다.; ‘보류’ 결정은 관측된 필수 게이트 상태와 일치한다.; 현재 전면 출시는 보류해야 한다. evidence/02-security-review.md가 전면 출시 차단을 명시하고, Critical·PII·환각·로그 관측값이 evidence/04-finance-and-launch-gates.md의 임계값을 충족하지 못한다.; 재심은 착수 후 약 60일인 독립 재시험 완료 시점에 수행하며, 모든 필수 게이트가 통과된 경우에만 상담원 검토 필수 5% canary를 검토한다. canary 중 게이트 위반 시 즉시 기존 수동 프로세스로 rollback한다.; 현재 Critical 발견은 0건 게이트에 실패하고, PII 0.25%는 0% 게이트에 실패하며, 중대한 환각률 0.92%는 0.10% 미만 게이트에 실패하고, prompt hash 완전성 환산 83%는 99.9% 이상 게이트에 실패한다.
- R-07: 문서에서 확인되는 비용, 승인·미승인 예산, 반복성, 일정 및 의존성을 반영한 30/60/90일 실행안을 제시한다.
  - 승인 총예산은 USD 120,000이고 수정 예상비는 USD 46,000이며, 수정·재검증 예상 기간은 8주다. USD 74,000은 수정비가 총예산에 포함된다는 조건의 명목 차액일 뿐 확정 가용액이 아니다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 전면 출시 보류는 비용 절감 전망보다 출시 차단 결론과 미충족 안전 게이트를 우선한 가역적 결정이다. 제한 출시는 모든 게이트를 통과한 뒤 5% canary에만 조건부로 허용한다.; 비용 원장: evidence/04-finance-and-launch-gates.md의 기존 처리비는 USD 8.20/티켓, HelioDesk 추론비는 USD 0.42/티켓, 필수 상담원 검토비는 USD 1.35/티켓이며 합산 예상 처리비는 USD 1.77/티켓이다. 모두 보조 모드의 반복성 티켓당 변동비로 해석되며 실제 청구액은 검증되지 않았다.; 예상 보조 모드 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 78.4% 낮지만 실제 파일럿 청구액이 아닌 재무 가정이다.; 비용·예산·일정 수치는 원문 및 산술과 일치하지만 실제 사업 실적은 아니다.; 예산 원장: evidence/04-finance-and-launch-gates.md에는 2026년 하반기 총 프로그램 예산 USD 120,000이 승인되었고, 보안·개인정보 수정비 USD 46,000은 예상액으로 제시된다. USD 46,000의 별도 승인 여부, 총예산 포함 여부, 집행 여부는 명시되지 않았다.
- R-08: 문서 간 상충, 정의 차이, 결측 및 검증되지 않은 주장을 별도 불확실성 목록으로 분리하고 의사결정 영향을 표시한다.
  - 30/60/90일 권고안은 0~30일 수정·shadow 평가·에스컬레이션 실패 정의, 31~60일 독립 재시험·세그먼트 검증·자동 발송 비활성 유지, 61~90일 전 게이트 통과 시에만 5% canary를 수행하는 순서다.; 현재 Critical 발견 1건, PII 노출률 0.25%, prompt hash 완전성 환산 83%도 각각 0건, 0%, 99.9% 이상 게이트를 충족하지 못한다.; CSAT 점추정치는 +0.13점이지만 비열등성 한계, 신뢰구간과 판정 규칙이 없어 정식 CSAT 게이트 통과는 검증할 수 없다.; 평균 개선과 별개로 중대한 환각 11건 중 4건은 환불 자격 오안내였고 PII 노출은 3건이었다. 일본어 42건과 통계적으로 비대표적인 고객 피드백 때문에 꼬리위험과 세그먼트 성능을 평균 KPI로 일반화할 수 없다.; 60일 실행안: 목표는 약 8주의 수정·재검증을 완료하고 독립 시험 결과로 출시 게이트를 판정하는 것이다. 산출물은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 4.18 대비 비열등, EU 레지던시 미검증 고객 제외 증거다. 제안 책임 주체는 독립 보안 시험자, 품질 담당, 개인정보 담당, 프로그램 책임자이며 모든 기준을 충족할 때만 5% canary를 승인한다.; KPI 원장: 최초 응답시간 중앙값은 18.0분→10.2분(-43.3%), 해결시간 중앙값은 9.6시간→8.1시간(-15.6%), CSAT는 4.18/5→4.31/5(+0.13), 에스컬레이션 비율은 14.2%→12.8%(-1.4%p)였다.; 보조 모드 예상 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 즉 78.4% 낮지만 실제 파일럿 비용이 아니라 기간·모집단이 없는 재무 가정이다.; 보조 모드 예상 처리비는 USD 1.77/티켓으로 기존 USD 8.20 대비 78.4% 절감 가정이다. 승인 예산 USD 120,000에서 수정 예상비 USD 46,000을 단순 차감한 잔액은 USD 74,000이며 실제 집행과 추가 비용은 검증되지 않았다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 평균 에스컬레이션 비율은 개선됐지만 에스컬레이션 실패 사건의 정의·건수·원인·세그먼트별 결과는 제공되지 않아 실패 꼬리위험을 평가할 수 없다. 위험팀은 canary 전에 승인된 에스컬레이션 조건을 충족했으나 적시에 사람에게 전달되지 않은 사건을 정의하고, 전체 canary와 세그먼트별로 모니터링하며, 중대 실패 1건 발생 시 중단·수동 rollback하도록 권고한다.; 전면 출시 보류는 비용 절감 전망보다 출시 차단 결론과 미충족 안전 게이트를 우선한 가역적 결정이다. 제한 출시는 모든 게이트를 통과한 뒤 5% canary에만 조건부로 허용한다.; 현재 출시 결정은 보류다. 수정 후 독립 재시험과 모든 필수 게이트 통과 전에는 전면 출시 또는 고객 대상 제한 출시를 정당화할 수 없다.; 이번 시도의 광범위 '.' 검색은 matchCount=1000에서 truncated=true, filesSearched=2로 종료되어 전체 본문 검색 근거로 사용할 수 없었다. 이후 좁은 검색은 filesSearched=4와 truncated=false를 반환해 주제별 관찰을 보완했다.; 확대는 모든 진입 게이트 통과 후 상담원 검토 필수 5% canary에서만 검토한다. canary 중 어느 필수 게이트라도 위반하면 즉시 이전 수동 프로세스로 rollback한다.; 90일 실행안: 60일 게이트가 전부 통과된 경우에만 상담원 검토가 필수인 5% canary를 수행하고 EU 레지던시 요구 고객은 제외한다. 제안 책임 주체는 제품·지원운영·신뢰성 운영이며, 게이트 위반 시 즉시 이전 수동 프로세스로 rollback한다. canary 운영 기간·추가 인프라비·독립 시험비는 문서에 없어 조건부 미확정 항목이며, 90일 시점에는 확대·유지·rollback 중 하나를 결정한다.; 네 파일은 모두 접근 가능했고 Markdown과 한국어 본문이 정상적으로 읽혔으며 각 read 결과의 redactions는 0이었다. 범위 내 누락 또는 중복 경로는 관찰되지 않았다.; 30일 실행안: 목표는 외부 전면 출시 차단을 유지하면서 Critical 캐시 결함, 내부 메모 노출, 90일 보존 불일치와 prompt hash 누락을 수정하고 내부 shadow 평가를 가동하는 것이다. 제안 책임 주체는 엔지니어링, 보안, 개인정보 담당이며, 선행조건은 수정 범위·독립 재시험 기준·USD 46,000의 승인 및 총예산 포함 여부 확정이다. 30일 의사결정 게이트는 수정 증거, 회귀시험 준비도와 예산 확정 여부이며 미충족 시 계속 보류한다.; 주제 색인은 KPI→SRC-01/SRC-04, 보안→SRC-02/SRC-04, 개인정보→SRC-01/SRC-02/SRC-03/SRC-04, 품질→SRC-01/SRC-03/SRC-04, 비용·예산→SRC-04, 일정→SRC-01/SRC-04로 구성된다.; 중대한 환각률 0.92%는 '<0.10%' 게이트를 실패하며, 통과하려면 0.82%p를 초과해 감소해야 한다.; 예상 보조 모드 처리비 USD 1.77은 기존 USD 8.20보다 USD 6.43, 78.4% 낮지만 실제 파일럿 청구액이 아닌 재무 가정이다.; 세 선택지 중 단일 결정은 ‘보류’다. 수정과 독립 재시험에서 모든 필수 게이트가 통과될 때 재심한다.; ‘보류’ 결정은 관측된 필수 게이트 상태와 일치한다.; 인계 준비 판정은 ‘미준비’다.; 평균 KPI는 최초 응답시간 18.0→10.2분(-43.3%), 해결시간 9.6→8.1시간(-15.6%), CSAT 4.18→4.31(+0.13), 에스컬레이션 비율 14.2%→12.8%(-1.4%p)로 개선됐다.; 주요 위험은 Critical 교차 테넌트 데이터 혼선, High 내부 메모 노출, High 보존기간 불일치, High 수준으로 취급해야 할 실제 PII 노출, 품질상 중대한 환각 0.92%, Medium 감사 로그 불완전성이다. EU 레지던시와 자동 발송은 미검증 범위다.; 품질·보안 비율은 기준값이 없어 전후 변화량을 계산할 수 없고 출시 게이트와의 격차만 판정할 수 있다.; 예산 원장: evidence/04-finance-and-launch-gates.md에는 2026년 하반기 총 프로그램 예산 USD 120,000이 승인되었고, 보안·개인정보 수정비 USD 46,000은 예상액으로 제시된다. USD 46,000의 별도 승인 여부, 총예산 포함 여부, 집행 여부는 명시되지 않았다.; 재심은 착수 후 약 60일인 독립 재시험 완료 시점에 수행하며, 모든 필수 게이트가 통과된 경우에만 상담원 검토 필수 5% canary를 검토한다. canary 중 게이트 위반 시 즉시 기존 수동 프로세스로 rollback한다.; 현재 Critical 발견은 0건 게이트에 실패하고, PII 0.25%는 0% 게이트에 실패하며, 중대한 환각률 0.92%는 0.10% 미만 게이트에 실패하고, prompt hash 완전성 환산 83%는 99.9% 이상 게이트에 실패한다.
- R-09: 결론, 핵심 근거, 차단 조건, 책임 주체 및 다음 의사결정 시점을 즉시 파악할 수 있는 한국어 경영진 보고서를 작성한다.
  - 승인 총예산은 USD 120,000이고 수정 예상비는 USD 46,000이며, 수정·재검증 예상 기간은 8주다. USD 74,000은 수정비가 총예산에 포함된다는 조건의 명목 차액일 뿐 확정 가용액이 아니다.; 일정 원장: evidence/01-pilot-metrics.md의 파일럿은 2026-06-01~06-28의 4주였고, evidence/04-finance-and-launch-gates.md의 수정·재검증 예상 기간은 8주다. 따라서 약 60일 이전에는 수정 완료와 독립 재시험이 핵심 선행조건이며, canary 기간 자체는 제시되지 않았다.; 60일 실행안: 목표는 약 8주의 수정·재검증을 완료하고 독립 시험 결과로 출시 게이트를 판정하는 것이다. 산출물은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 4.18 대비 비열등, EU 레지던시 미검증 고객 제외 증거다. 제안 책임 주체는 독립 보안 시험자, 품질 담당, 개인정보 담당, 프로그램 책임자이며 모든 기준을 충족할 때만 5% canary를 승인한다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 전면 출시 보류는 비용 절감 전망보다 출시 차단 결론과 미충족 안전 게이트를 우선한 가역적 결정이다. 제한 출시는 모든 게이트를 통과한 뒤 5% canary에만 조건부로 허용한다.; 90일 실행안: 60일 게이트가 전부 통과된 경우에만 상담원 검토가 필수인 5% canary를 수행하고 EU 레지던시 요구 고객은 제외한다. 제안 책임 주체는 제품·지원운영·신뢰성 운영이며, 게이트 위반 시 즉시 이전 수동 프로세스로 rollback한다. canary 운영 기간·추가 인프라비·독립 시험비는 문서에 없어 조건부 미확정 항목이며, 90일 시점에는 확대·유지·rollback 중 하나를 결정한다.; 30일 실행안: 목표는 외부 전면 출시 차단을 유지하면서 Critical 캐시 결함, 내부 메모 노출, 90일 보존 불일치와 prompt hash 누락을 수정하고 내부 shadow 평가를 가동하는 것이다. 제안 책임 주체는 엔지니어링, 보안, 개인정보 담당이며, 선행조건은 수정 범위·독립 재시험 기준·USD 46,000의 승인 및 총예산 포함 여부 확정이다. 30일 의사결정 게이트는 수정 증거, 회귀시험 준비도와 예산 확정 여부이며 미충족 시 계속 보류한다.; 비용·예산·일정 수치는 원문 및 산술과 일치하지만 실제 사업 실적은 아니다.; 재심은 착수 후 약 60일인 독립 재시험 완료 시점에 수행하며, 모든 필수 게이트가 통과된 경우에만 상담원 검토 필수 5% canary를 검토한다. canary 중 게이트 위반 시 즉시 기존 수동 프로세스로 rollback한다.
- R-10: 전체 작업을 읽기 전용으로 수행하여 제공된 파일을 변경하지 않는다.
  - 생산성·CSAT·예상 비용 개선은 고심각도 실패를 상쇄하지 않는다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 문서에는 canary 위반 시 수동 프로세스 rollback이 명시됐지만 유출 이후 데이터 회수 가능성은 입증되지 않았다.; 전면 출시는 명시적 보안 차단과 다수 필수 게이트 실패 때문에 기각하며, 제한 출시도 현재는 동일 결함이 고객에게 영향을 줄 수 있고 자동 발송이 미시험이므로 기각한다. 향후 5% canary는 현재 결정이 아니라 전 게이트 통과 후의 재심 경로다.; 안정적인 파일별 식별자는 SRC-01=evidence/01-pilot-metrics.md, SRC-02=evidence/02-security-review.md, SRC-03=evidence/03-customer-feedback.md, SRC-04=evidence/04-finance-and-launch-gates.md로 정의한다.; 세 선택지 중 단일 결정은 ‘보류’다. 수정과 독립 재시험에서 모든 필수 게이트가 통과될 때 재심한다.; ‘보류’ 결정은 관측된 필수 게이트 상태와 일치한다.; 인계 준비 판정은 ‘미준비’다.; 재심은 착수 후 약 60일인 독립 재시험 완료 시점에 수행하며, 모든 필수 게이트가 통과된 경우에만 상담원 검토 필수 5% canary를 검토한다. canary 중 게이트 위반 시 즉시 기존 수동 프로세스로 rollback한다.
- R-11: 확인된 네 로컬 문서 이외의 자료나 존재하지 않는 출처를 사용하지 않고 관찰되지 않은 완료 또는 안전성을 주장하지 않는다.
  - 30/60/90일 권고안은 0~30일 수정·shadow 평가·에스컬레이션 실패 정의, 31~60일 독립 재시험·세그먼트 검증·자동 발송 비활성 유지, 61~90일 전 게이트 통과 시에만 5% canary를 수행하는 순서다.; 생산성·CSAT·예상 비용 개선은 고심각도 실패를 상쇄하지 않는다.; 승인 총예산은 USD 120,000이고 수정 예상비는 USD 46,000이며, 수정·재검증 예상 기간은 8주다. USD 74,000은 수정비가 총예산에 포함된다는 조건의 명목 차액일 뿐 확정 가용액이 아니다.; 일정 원장: evidence/01-pilot-metrics.md의 파일럿은 2026-06-01~06-28의 4주였고, evidence/04-finance-and-launch-gates.md의 수정·재검증 예상 기간은 8주다. 따라서 약 60일 이전에는 수정 완료와 독립 재시험이 핵심 선행조건이며, canary 기간 자체는 제시되지 않았다.; 결론은 제공된 로컬 문서 시점의 증거에 한정되며 문서 최신성, 수정·독립 재시험·shadow·canary·rollback 준비 및 비용 집행은 검증되지 않았다.; 평균 개선과 별개로 중대한 환각 11건 중 4건은 환불 자격 오안내였고 PII 노출은 3건이었다. 일본어 42건과 통계적으로 비대표적인 고객 피드백 때문에 꼬리위험과 세그먼트 성능을 평균 KPI로 일반화할 수 없다.; 보안·개인정보 위험은 교차 테넌트 캐시 결함(Critical), 내부 메모 노출(High), PII 교차 티켓 노출(Critical·위험팀 추론), 보존기간 불일치(High), EU 레지던시 미검증(High·위험팀 추론), 감사 로그 불완전(Medium)이다. 요구 통제의 완료는 관찰되지 않았다.; 보조 모드 예상 처리비는 USD 1.77/티켓으로 기존 USD 8.20 대비 78.4% 절감 가정이다. 승인 예산 USD 120,000에서 수정 예상비 USD 46,000을 단순 차감한 잔액은 USD 74,000이며 실제 집행과 추가 비용은 검증되지 않았다.; T05는 R-02~R-11을 보고서 구역과 연결하지만 R-01은 최상위 requirementIds와 개별 claims에서 모두 누락했다.; 평균 에스컬레이션 비율은 개선됐지만 에스컬레이션 실패 사건의 정의·건수·원인·세그먼트별 결과는 제공되지 않아 실패 꼬리위험을 평가할 수 없다. 위험팀은 canary 전에 승인된 에스컬레이션 조건을 충족했으나 적시에 사람에게 전달되지 않은 사건을 정의하고, 전체 canary와 세그먼트별로 모니터링하며, 중대 실패 1건 발생 시 중단·수동 rollback하도록 권고한다.; 전면 출시 보류는 비용 절감 전망보다 출시 차단 결론과 미충족 안전 게이트를 우선한 가역적 결정이다. 제한 출시는 모든 게이트를 통과한 뒤 5% canary에만 조건부로 허용한다.; 고심각도 위험별 진입 게이트에는 지표 또는 판정 조건, 적용 범위, 권고 책임 주체, 판정 시점과 미충족 조치를 연결했다. 원문에 없는 내부 메모·자동 발송·에스컬레이션 실패의 세부 조건은 위험팀 권고로 구분했다.; 판정 근거는 제공된 로컬 evidence/ 자료로 제한되며 최신성, 외부 대표성, 수정·재시험·배포 등 관찰되지 않은 조치의 실제 수행 여부는 검증되지 않았다.; 이번 시도의 광범위 '.' 검색은 matchCount=1000에서 truncated=true, filesSearched=2로 종료되어 전체 본문 검색 근거로 사용할 수 없었다. 이후 좁은 검색은 filesSearched=4와 truncated=false를 반환해 주제별 관찰을 보완했다.; 문서에는 canary 위반 시 수동 프로세스 rollback이 명시됐지만 유출 이후 데이터 회수 가능성은 입증되지 않았다.; 확대는 모든 진입 게이트 통과 후 상담원 검토 필수 5% canary에서만 검토한다. canary 중 어느 필수 게이트라도 위반하면 즉시 이전 수동 프로세스로 rollback한다.; 90일 실행안: 60일 게이트가 전부 통과된 경우에만 상담원 검토가 필수인 5% canary를 수행하고 EU 레지던시 요구 고객은 제외한다. 제안 책임 주체는 제품·지원운영·신뢰성 운영이며, 게이트 위반 시 즉시 이전 수동 프로세스로 rollback한다. canary 운영 기간·추가 인프라비·독립 시험비는 문서에 없어 조건부 미확정 항목이며, 90일 시점에는 확대·유지·rollback 중 하나를 결정한다.; 네 파일은 모두 접근 가능했고 Markdown과 한국어 본문이 정상적으로 읽혔으며 각 read 결과의 redactions는 0이었다. 범위 내 누락 또는 중복 경로는 관찰되지 않았다.; 자동 발송은 별도 안전성 시험 통과와 대상 고객의 명시적 동의를 모두 충족해야만 활성화할 수 있다. 적용 범위는 자동 발송 후보 고객·사용 사례 전체, 권고 책임 주체는 제품 안전 책임자와 고객 계약 책임자, 판정 시점은 활성화 전이며 미충족 시 계속 비활성화하고 상담원 검토 보조 모드를 유지해야 한다.; 30일 실행안: 목표는 외부 전면 출시 차단을 유지하면서 Critical 캐시 결함, 내부 메모 노출, 90일 보존 불일치와 prompt hash 누락을 수정하고 내부 shadow 평가를 가동하는 것이다. 제안 책임 주체는 엔지니어링, 보안, 개인정보 담당이며, 선행조건은 수정 범위·독립 재시험 기준·USD 46,000의 승인 및 총예산 포함 여부 확정이다. 30일 의사결정 게이트는 수정 증거, 회귀시험 준비도와 예산 확정 여부이며 미충족 시 계속 보류한다.; 판단에 사용한 자료는 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md의 네 로컬 문서뿐이다.; 결론은 제공된 로컬 자료에만 근거하며 최신성, 실제 수정·재시험·배포 및 비용 집행은 검증되지 않았다.; T05가 표시한 네 출처 파일은 evidence 디렉터리에 존재하며 이번 시도에서 모두 직접 읽었다.; 분석 대상은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md의 정확히 네 로컬 파일이다.; 인계 준비 판정은 ‘미준비’다.; 주요 위험은 Critical 교차 테넌트 데이터 혼선, High 내부 메모 노출, High 보존기간 불일치, High 수준으로 취급해야 할 실제 PII 노출, 품질상 중대한 환각 0.92%, Medium 감사 로그 불완전성이다. EU 레지던시와 자동 발송은 미검증 범위다.; 비용·예산·일정 수치는 원문 및 산술과 일치하지만 실제 사업 실적은 아니다.; 예산 원장: evidence/04-finance-and-launch-gates.md에는 2026년 하반기 총 프로그램 예산 USD 120,000이 승인되었고, 보안·개인정보 수정비 USD 46,000은 예상액으로 제시된다. USD 46,000의 별도 승인 여부, 총예산 포함 여부, 집행 여부는 명시되지 않았다.

## 요구사항 커버리지

- [x] R-01: Verified by 3 immutable claim(s) and 8 linked evidence item(s).
- [x] R-02: Verified by 21 immutable claim(s) and 49 linked evidence item(s).
- [x] R-03: Verified by 4 immutable claim(s) and 12 linked evidence item(s).
- [x] R-04: Verified by 12 immutable claim(s) and 16 linked evidence item(s).
- [x] R-05: Verified by 11 immutable claim(s) and 25 linked evidence item(s).
- [x] R-06: Verified by 13 immutable claim(s) and 24 linked evidence item(s).
- [x] R-07: Verified by 7 immutable claim(s) and 14 linked evidence item(s).
- [x] R-08: Verified by 29 immutable claim(s) and 53 linked evidence item(s).
- [x] R-09: Verified by 9 immutable claim(s) and 16 linked evidence item(s).
- [x] R-10: Verified by 9 immutable claim(s) and 17 linked evidence item(s).
- [x] R-11: Verified by 28 immutable claim(s) and 58 linked evidence item(s).

## 주의점

- 2026년 하반기 승인 예산 USD 120,000에 수정 예상비 USD 46,000이 포함되는지, USD 46,000이 별도 승인되었는지 알 수 없다.
- 8주 일정의 시작일, canary 기간·최소 표본·통계적 검정력과 확대 단계가 제시되지 않았다.
- 8주 일정의 시작일·세부 마일스톤·canary 기간·전면 출시일은 제시되지 않았다.
- 8주 일정의 시작일과 canary 최소 표본·기간·확대 기준이 없다.
- 광범위 검색은 truncated=true/filesSearched=2였으므로 전체 본문 완전성 근거가 아니다.
- 내부 메모 노출 0건·DLP 통과 조건과 역할 수준 책임 주체는 위험팀 권고다.
- 네 문서의 2026-08-17 현재 최신성과 작성 이후 변경 여부는 검증되지 않았다.
- 네 문서의 현재 최신성과 작성 이후 변경 여부는 검증되지 않았다.
- 네 파일의 내용 동일성·중복 여부를 별도 해시로 계산하지 않았으며 고유 경로 기준 중복 없음만 확인했다.
- 독립 재시험, canary 운영, EU 리전, DLP, 추가 인프라와 rollback 준비 비용이 제시되지 않아 추가 필요 예산을 산정할 수 없다.
- 독립 재시험과 5% canary의 최소 표본, 통계적 검정력, 관찰 기간과 확대 단계는 원문에 없다.
- 문서 생성 이후 변경 여부와 2026-08-17 현재 최신성은 검증되지 않았다.
- 문서의 2026-08-17 현재 최신성과 작성 이후 변경 여부는 검증되지 않았다.
- 별도 반증 키워드 검색 두 건은 도구 오류로 완료되지 않았으며 성공한 전체 파일 read와 제목 검색을 근거로 사용했다.
- 별도 반증 키워드 search는 도구 오류로 완료되지 않아 성공한 네 파일 read와 제목 검색만 이번 시도의 검색·검증 근거로 사용했다.
- 보안 수정, 독립 재시험, shadow 평가, 5% canary와 rollback 준비의 실제 수행 여부는 검증되지 않았다.
- 보안 수정, 독립 재시험, shadow 평가, canary 또는 rollback의 실제 수행 여부는 검증되지 않았다.
- 보안 수정, 독립 재시험, shadow 평가, canary, rollback의 실제 수행 여부와 문서 최신성은 관찰되지 않았다.
- 보안·개인정보 수정, 독립 재시험, 내부 shadow 평가, 5% canary와 rollback 준비의 실제 수행 여부는 관찰되지 않았다.
- 보안·개인정보 수정, 독립 재시험, shadow 평가, canary 및 rollback의 실제 수행 여부는 관찰되지 않았다.
- 보안·개인정보 수정, 독립 재시험, shadow 평가, canary, rollback 훈련과 비용 집행은 관찰되지 않았다.
- 비용 수치는 문서가 제시한 재무 가정이며 실제 청구·집행 자료로 독립 검증되지 않았다.
- 비용 수치는 재무 가정일 뿐 실제 청구·집행 자료로 검증되지 않았다. 파일럿과 같은 1,200건에 적용한 절감액도 실제 수요·고정비·추가 비용 없이는 확정할 수 없다.
- 수정 예상비 USD 46,000의 승인 여부, 총예산 포함 여부, 일회성 여부와 추가 비용이 명시되지 않았다.
- 수정 예상비 USD 46,000이 일회성인지 반복 가능 비용인지 문서에 명시되지 않았다.
- 에스컬레이션 실패 정의, 중대 실패 0건과 1건 중단 조건, 모니터링 범위와 책임 주체는 위험팀 권고이며 원문 게이트가 아니다.
- 예상 처리비 USD 1.77과 78.4% 절감은 재무 가정이며 실제 청구·집행 자료가 아니다.
- 의존 artifact T01의 verificationStatus는 unverified이며 본 작업은 그 결론을 승인하지 않고 현재 직접 read 결과와 함께 사용했다.
- 의존 artifact들의 verificationStatus는 unverified이며 본 결과는 이를 승인하지 않는다. G0/G2/G3 및 reviewer 수락도 관찰되지 않았다.
- 이 수정본에 대한 새 게이트 검토·수락 여부는 관찰되지 않았다.
- 이 작업자는 이전 G3 거절 이후 수정본만 산출했으며, 새 관리자 수락이나 게이트 통과 여부는 아직 관찰되지 않았다.
- 이전 G3 상태는 rejected이며 관리자 수락과 verifier 통과가 관찰되지 않았다. 이번 수정본의 G0/G2/G3 또는 reviewer 수락 여부도 아직 검증되지 않았다.
- 일본어 42건과 5개 고객사 피드백은 외부 대표성을 보장하지 않는다.
- 일본어 티켓은 42건뿐이고 5개 고객사의 피드백은 통계적 대표성을 보장하지 않는다.
- 일본어 표본은 42건뿐이고 고객 피드백은 통계적 대표성을 보장하지 않는다.
- 일본어 표본은 42건뿐이며 고객 피드백은 통계적 대표성을 보장하지 않는다.
- 자동 발송 안전성 시험+명시적 고객 동의 조건과 책임 주체는 위험팀 권고이며 수행 여부는 미검증이다.
- 자동 발송은 시험되지 않았고 한 고객사가 거부했다. 안전성 시험 기준·최소 표본·고객 동의 절차는 원문에 없다.
- 자동 발송은 시험되지 않았고 EU 데이터 레지던시는 검증되지 않았다.
- 자동 발송은 시험되지 않았고 EU 데이터 레지던시는 검증되지 않았다. 일본어 표본은 42건뿐이며 고객 피드백은 통계적 대표성을 보장하지 않는다.
- 제안 책임 주체는 실행안 합성을 위한 역할 배정이며 문서에서 확정된 담당자나 조직이 아니다.
- 중대한 환각률, PII 노출률, 교차 테넌트 재현률 및 감사 로그 완전성의 동일 정의 기준값이 없어 전후 변화량은 계산할 수 없다.
- 중대한 환각률, PII 노출률, 교차 테넌트 재현률과 prompt hash 완전성의 동일 정의 기준값이 없어 전후 변화량은 계산할 수 없다.
- 책임 주체 표시는 보완 경로를 위한 역할 제안이며 원문에 확정된 조직 또는 개인 배정이 아니다.
- 책임 주체와 일부 운영 게이트는 실행 가능성을 위한 제안이며 원문에 확정된 조직 배정이나 임계값이 아니다.
- 티켓당 USD 1.77과 78.4% 절감은 예상 가정이며 측정 기간·모집단·실제 청구 또는 집행 자료가 없다.
- 판정은 제공된 로컬 evidence/ 네 문서로 제한된다. 외부 자료, 최신성 및 관찰되지 않은 조치는 검증되지 않았다.
- 평균 에스컬레이션 비율 외에 실패 사건의 정의·건수·원인·중대성·세그먼트별 결과가 없어 실패 꼬리위험은 평가할 수 없다.
- 품질·보안 지표의 동일 정의 기준값이 없어 전후 변화량을 계산할 수 없다.
- CSAT 비열등 마진·신뢰구간·검정 결과가 없어 공식 비열등성은 판정할 수 없다.
- CSAT 비열등성 한계, 신뢰구간, 표준오차, 검정력과 판정 규칙이 없다.
- CSAT 비열등성 한계, 신뢰구간, 표준오차와 유의성 검정이 없어 정식 통과 판정이 불가능하다.
- CSAT 비열등성 한계, 신뢰구간, 표준오차와 판정 규칙이 제공되지 않았다.
- EU 데이터 레지던시는 검증되지 않았고 자동 발송은 시험되지 않았으며 한 고객사가 명시적으로 거부했다.
- Final critic: 30/60/90일 계획의 책임 주체는 문서에 확정된 담당자가 아니라 보고서 작성자의 제안임을 표시하고, USD 46,000의 승인·총예산 포함 여부 및 추가 시험·인프라 비용을 30일 게이트로 남겨야 한다.
- Final critic: 5% canary는 모든 진입 게이트 통과 후에만 허용해야 한다. rollback은 추가 노출을 중단할 뿐 이미 유출된 PII나 교차 테넌트 정보를 회수한다는 증거가 없음을 명시해야 한다.
- Final critic: 루트 summary의 '합성 불가'는 제공된 검증 자료로 경영진 보고서를 작성할 수 있다는 본문과 충돌한다. 최종 답변에서는 전면 출시 보류 결론을 직접 제시하되 절단 때문에 정확한 패킷 합집합은 재검증하지 못했다는 한계만 보존해야 한다.
- Final critic: 보안·개인정보·품질 위험 표에 현재 완화 상태를 '수정 계획만 존재하며 완료·독립 재시험 미관찰'로 명시하고 잔여 위험을 별도 열로 제시해야 한다.
- Final critic: 최종 보고서에서는 KPI를 원문 정의에 맞춰 '중앙값' 등으로 고정하고 '평균' 표현을 제거해야 한다.
- Final critic: conflicts 배열이 비어 있으므로 최종 보고서의 별도 불확실성 구역에 정의 차이, 검색 성공·실패 범위, 비용 포함 관계, CSAT 비열등성 미판정, 심각도 추론 차이를 명시해야 한다.
- Final critic: Failed criterion: counterexample-search — 반례 자체는 충분히 수집했지만 conflicts가 비어 있다. KPI를 '중앙값'과 '평균'으로 혼용하고, PII 심각도를 High와 Critical로 다르게 추론하며, prompt hash 83%를 전체 감사 로그 완전성과 동일시할 위험이 남아 있다.
- Final critic: Failed criterion: requirement-traceability — R-01~R-11을 뒷받침할 자료는 존재하지만 루트 합성은 중복이 심하고 일부 T03/T06 내용이 절단되었다고 스스로 명시한다. 최종 보고서에서 각 표·위험·권고를 실제 파일명에 직접 연결해야 한다.
- Final critic: PII 사건의 심각도는 문서가 직접 부여한 등급과 감사자가 제안한 등급을 분리해야 한다. 교차 테넌트 Critical 결함과 중복 집계하지 않아야 한다.
- Final critic: prompt hash 17% 누락에서 계산한 83%는 해당 필드의 완전성 환산값이다. 전체 감사 로그 완전성 83%라는 확정 표현은 정의가 동일하다는 근거가 없으면 피해야 한다.
- PII 사건과 교차 테넌트 캐시 결함의 인과관계는 확인되지 않았다.
- R-01의 상세 요구사항 정의가 별도 원장으로 제공되지 않아 T05의 추적 누락 이상은 평가할 수 없다.
- rollback이 이미 노출된 정보를 회수할 수 없다는 우려는 감사 추론이며, 실제 containment 또는 회수 가능성을 보여주는 자료는 제공되지 않았다.
- search 도구가 브로커 오류를 반환해 용어 전수검색은 완료하지 못했다. 네 파일은 모두 직접 읽었지만 검색 기반 반증 검증은 제한된다.
- T01 출처 원장 artifact가 제공되지 않아 보고서 파일명·수치·출처의 원장 등재 여부를 검증하지 못했다.
- USD 46,000은 예상 수정비이고 USD 74,000은 단순 산술 잔액이다. 실제 집행과 추가 비용은 검증되지 않았다.
- USD 46,000의 총예산 포함 여부, 승인·집행 여부와 추가 시험·인프라·EU·DLP 비용이 불명확하다.
- USD 74,000은 승인 예산과 수정 예상비의 명목 차액일 뿐 다른 비용 항목이 없어 실제 가용 잔액으로 확정할 수 없다.

## 다음 행동

- 30/60/90일 실행안: 0~30일—외부 출시 차단 유지, 캐시 키·DLP·30일 보존·감사 로그 수정, 내부 shadow 평가, 독립 재시험 기준과 예산 포함 관계 확정. 제안 책임은 엔지니어링·보안·개인정보·프로그램 책임자이며 30일 중간 점검에서 수정 증거가 없으면 보류를 유지한다. 31~60일—8주 일정에 맞춰 독립 재시험을 완료하고 Critical 0건, PII 0%, 환각 <0.10%, prompt hash ≥99.9%, CSAT 비열등을 판정한다. EU 요구 고객과 자동 발송은 제외한다. 하나라도 실패하거나 판정 불가이면 고객 대상 canary를 금지한다. 61~90일—전 게이트 통과 시에만 상담원 검토 필수 5% canary를 수행한다. 게이트 위반 시 즉시 기존 수동 프로세스로 rollback하며, 90일 시점에 확대·유지·rollback 중 하나를 결정한다. canary 최소 표본과 관찰 기간은 별도 확정이 필요하다.
- 30/60/90일 실행안: 0~30일—USD 46,000 예상 범위에서 캐시·보존·DLP·감사 로그 수정, 내부 shadow 평가, 에스컬레이션 실패 정의와 자동 발송 안전성 계획 수립. 31~60일—8주 일정에 맞춰 독립 재시험, 일본어·EU·에스컬레이션 세그먼트 검증, 자동 발송 비활성 유지. 61~90일—전 게이트 통과 시에만 상담원 검토 필수 5% canary, 위반 즉시 수동 rollback. 승인 예산 USD 120,000에서 단순 잔액은 USD 74,000이나 실제 집행·추가 비용은 미검증이다.
- 30/60/90일 실행안: 0~30일에는 전면 출시를 동결하고 USD 46,000 수정 예상비를 기준으로 캐시 키, DLP, 30일 보존과 감사 로그를 수정하며 내부 shadow 평가를 시작한다. 승인 예산 USD 120,000과 수정 예상비의 명목 차액은 USD 74,000이지만 다른 비용 항목이 없어 실제 가용 잔액으로 확정하지 않는다. 31~60일에는 문서의 8주 일정에 맞춰 독립 재시험을 완료하고 모든 게이트를 재측정한다. EU 요구 고객과 자동 발송은 제외한다. 61~90일에는 모든 게이트를 통과한 경우에만 상담원 검토 필수 5% canary를 시작하고 위반 즉시 기존 수동 프로세스로 rollback한다. 하나라도 실패하거나 미검증이면 보류를 유지한다.
- 30일: 결함 수정·내부 shadow·예산 범위 확정. 제안 책임은 엔지니어링/보안/개인정보. 수정 증거와 예산 미확정 시 보류 유지.
- 60일: 독립 재시험과 전 게이트 판정. 제안 책임은 독립 시험자/품질/개인정보/프로그램 책임자. 하나라도 미달이면 canary 금지.
- 90일: 전 게이트 통과를 선행조건으로 5% canary, 상담원 검토, EU 요구 고객 제외, 위반 즉시 수동 프로세스 rollback. 추가 비용과 canary 기간은 미확정이며 확대·유지·rollback을 결정.
- 결정: 전면 출시 보류. 모든 필수 게이트 통과 후에만 상담원 검토 필수 5% canary 제한 출시.
- 경영진 결정: ‘보류’. 전면 출시와 현재 시점의 제한 출시를 모두 기각한다. 핵심 차단 조건은 교차 테넌트 Critical 결함, PII 0.25%, 중대한 환각 0.92%, 감사 로그 완전성 환산 83%, 보존기간 불일치다. 제안 책임 주체는 보안 책임자, 개인정보 책임자, 품질 책임자와 프로그램 책임자이며 이는 문서에 확정된 인사 배정이 아닌 실행 추론이다. 다음 공식 의사결정은 착수 후 약 60일, 즉 8주 독립 재시험 완료 시점이다. 모든 필수 게이트를 통과하지 못하면 보류를 유지한다.
- 계산 근거: 절대 변화=파일럿값-기준값, 상대 변화율=(파일럿값-기준값)/기준값×100, 비율 지표의 수준 차이는 퍼센트포인트로 표시했다. 10.2-18.0=-7.8 및 -7.8/18.0=-43.3%; 8.1-9.6=-1.5 및 -1.5/9.6=-15.6%; 4.31-4.18=+0.13 및 0.13/4.18=+3.1%; 12.8%-14.2%=-1.4%p 및 -1.4/14.2=-9.9%; USD 0.42+1.35=1.77, 1.77-8.20=-6.43, -6.43/8.20=-78.4%. 환각률은 0.92%-x<0.10%이므로 x>0.82%p여야 한다.
- 고심각도 출시 게이트:
| 위험 | 임계값·조건 | 범위 | 책임 주체 | 판정 시점 | 미충족 조치 |
|---|---|---|---|---|---|
| 교차 테넌트 | Critical 0건 | 캐시·응답 경로 | 보안 책임자(권고) | canary 전·중 | 보류/즉시 rollback |
| 내부 메모 | 노출 0건 및 격리·DLP 통과(권고) | 외부 콘텐츠·내부 메모 인젝션 | 보안 책임자(권고) | canary 전 | 보류·재수정 |
| PII | 누출률 0% | 전체 시험·canary 티켓 | 개인정보·보안 책임자(권고) | canary 전·중 | 보류/즉시 rollback |
| 보존기간 | 원문 로그 ≤30일 | 전체 원문 로그 | 개인정보 책임자(권고) | canary 전 | 배포 금지·시정 |
| 환각 | 중대한 환각률 <0.10% | 독립 품질 시험·canary | 품질 책임자(권고) | canary 전·중 | 보류/즉시 rollback |
| EU 레지던시 | 검증 완료 또는 대상 제외 | 요구 고객 데이터 | 계약·데이터 책임자(권고) | 고객 포함 전 | 계속 제외 |
| 자동 발송 | 안전성 시험 통과+명시적 고객 동의(권고) | 후보 고객·사용 사례 전체 | 제품 안전·계약 책임자(권고) | 활성화 전 | 계속 비활성화 |
| 에스컬레이션 실패 | 정의 확정+중대 실패 0건(권고) | 전체 및 세그먼트별 canary | 운영·품질 책임자(권고) | canary 전·중 | 중대 실패 1건 시 rollback |
- 공통 확대·중단 게이트: 위 조건과 prompt hash 완전성 ≥99.9%, CSAT 4.18 대비 비열등을 모두 충족한 뒤 상담원 검토 필수 5% canary를 시작한다. 확대 최소 표본·관찰 기간은 원문에 없어 미정이다. 어느 필수 게이트라도 위반하면 즉시 이전 수동 프로세스로 rollback한다.
- 단일 출시 결정, 대안별 기각 근거, KPI 표, 위험·게이트 표, 비용·예산·일정, 30/60/90일 실행안과 불확실성 목록을 포함한 한국어 경영진 보고서. supplied local evidence only; freshness and unobserved actions remain unverified
- 대안별 기각 근거: 전면 출시는 evidence/02-security-review.md가 명시적으로 차단하고 evidence/04-finance-and-launch-gates.md의 필수 안전 게이트 여러 개가 현재 실패하므로 기각한다. 제한 출시도 현재 결함이 고객 데이터와 정책 안내에 영향을 줄 수 있고 자동 발송이 시험되지 않았으므로 지금은 기각한다. 다만 수정·독립 재시험 후 전 게이트 통과 시의 상담원 검토 필수 5% canary는 재심 경로로 유지한다. 보류는 안전 문제를 먼저 제거하면서 생산성·비용 개선 가능성을 보존하는 가역적 선택이다.
- 미해결 결함 및 보완 경로:
- R-01 추적 누락: T05 작성 측이 보고서 위치와 근거 파일을 연결해야 한다.
- T01 출처 원장 부재: 원장 artifact가 제공된 뒤 파일명·수치·출처를 재대조해야 한다.
- Critical·PII·환각·로그 게이트 실패: 보안·개인정보·품질 수정 후 독립 재시험이 필요하다.
- CSAT 비열등성 미검증: 품질 검증 측이 임계값, 분모, 신뢰구간과 판정 결과를 제공해야 한다.
- rollback 운영성 미검증: canary 표본·기간, 탐지 기준, 복구시간과 유출 후 containment 절차를 검증해야 한다. 데이터 회수 불가 가능성은 원문 진술이 아닌 감사 추론이다.
- 인계 준비 판정: 미준비. 위 실질 결함이 해소되고 요구사항·출처 재대조가 완료될 때 재판정한다.
- 반례 점검표:
| 낙관적 주장 | 관측 반례 또는 미검증 가정 | 영향 |
|---|---|---|
| 응답·해결시간 개선 | 환각 11건, 환불 오안내 4건 | 평균 생산성이 정책 오류를 가림 |
| CSAT 개선 | 비열등성 한계·신뢰구간 없음; 일본어 42건 | 통계 게이트와 일반화 미입증 |
| 78.4% 절감 | 실제 청구가 아닌 가정; 추가 수정·시험비 미제공 | 사업성 과대평가 가능 |
| 제한 운영 가능 | 자동 발송 미시험, 고객 1곳 거부 | 자동화 확대 근거 없음 |
| rollback 경로 존재 | 훈련·복구시간·유출 후 containment 증거 없음 | 운영 복구 효과 미검증 |
| 보안 수정 가능 | 수정 및 독립 재시험 결과 미관측 | 완화 완료가 아닌 계획 단계 |
- 불확실성 목록: 문서의 현재 최신성과 작성 이후 변경은 미검증이다. 보안 수정, 독립 재시험, shadow 평가, canary 및 rollback 준비의 실제 수행 여부는 미관측이다. CSAT 비열등성 한계·신뢰구간·판정 규칙이 없다. 품질·보안 지표의 동일 정의 기준값이 없어 전후 변화량을 계산할 수 없다. 비용은 가정이며 실제 청구·집행액, 추가 시험·EU 리전·DLP·인프라·canary 비용이 없다. USD 46,000의 승인·총예산 포함·일회성 여부가 불명확하다. 8주 시작일, canary 기간·최소 표본·확대 단계가 없다. EU 레지던시는 미검증이고 자동 발송은 미시험이며 한 고객사가 거부했다. 일본어 표본은 42건뿐이고 고객 피드백은 통계적 대표성을 보장하지 않는다.
- 비교 가능성 판정: 네 운영 KPI는 동일 기간·모집단·교차 참여 상담원 조건이 명시돼 직접 비교 가능하다. 보안 재현시험은 모집단과 시험 방식이 달라 운영 KPI와 비교할 수 없다. 비용은 예상 모델이며 기간·표본·실제 청구 자료가 없어 실측 파일럿 성과로 취급할 수 없다. 품질·보안 비율은 기준값이 없어 전후 변화는 계산할 수 없고, 출시 게이트와의 격차만 판정할 수 있다.
- 비용·예산 원장: evidence/04-finance-and-launch-gates.md 기준 반복 변동비는 기존 USD 8.20/티켓, 추론 USD 0.42/티켓, 검토 USD 1.35/티켓, 합산 USD 1.77/티켓이다. 2026년 하반기 승인 총예산은 USD 120,000이고 수정 예상비 USD 46,000의 승인·포함·반복성은 미확정이다.
- 비용·예산·일정: evidence/04-finance-and-launch-gates.md 기준 기존 처리비는 USD 8.20/티켓, HelioDesk 추론비는 USD 0.42, 필수 검토비는 USD 1.35, 합산 예상 처리비는 USD 1.77이다. 예상 절감은 USD 6.43/티켓, 78.4%이나 실제 청구 자료가 아닌 보조 모드 가정이다. 승인 총예산은 USD 120,000, 수정 예상비는 USD 46,000, 수정·재검증은 8주다. 명목 차액 USD 74,000은 수정비의 총예산 포함 여부와 추가 시험·인프라 비용이 확인되지 않아 가용 잔액으로 확정하지 않는다.
- 사실·계산·추론 구분: 확인 사실은 네 파일의 KPI, 사건, 비용 가정, 예산, 8주 일정과 게이트다. 계산값은 KPI 상대 변화, prompt hash 완전성 83%, 비용 차이 USD 6.43 및 조건부 예산 차액 USD 74,000이다. 책임 주체 배정, 자동 발송의 안전성 시험+고객 동의 조건, 30/60/90일 세부 배치는 실행을 위한 경영 추론이다. 생산성·CSAT 개선과 예상 비용 절감은 긍정 증거지만 출시 차단 안전 증거와 의사결정상 상충한다. 동일 정의의 직접 충돌 원수치는 발견되지 않았다.
- 상충·결측 목록: 직접 충돌하는 동일 정의의 원수치는 발견되지 않았다. 다만 생산성·CSAT 개선 및 78.4% 예상 절감과 현재 보안 출시 차단이 의사결정상 충돌한다. CSAT 비열등성 한계·신뢰구간, 품질·보안 기준값, 호출 총수, 비용 측정 기간·모집단·실제 집행액, EU 레지던시 시험, 자동 발송 시험과 충분한 일본어 표본이 결측이다. 고객 피드백은 대표성이 보장되지 않는다.
- 에스컬레이션 실패 전용 게이트: canary 전 승인된 에스컬레이션 조건과 실패 사건 정의를 확정하고 독립 검증에서 중대 실패 0건을 확인한다(위험팀 권고; 원문 임계값 없음). 범위는 전체 canary와 언어·정책·고객 세그먼트별 모니터링, 책임은 고객지원 운영·품질 책임자(권고), 판정은 canary 전과 운영 중이며 중대 실패 1건 발생 시 즉시 canary 중단·수동 rollback한다. 최소 표본과 관찰 기간은 미정이다.
- 완전성 판정: evidence/ 인벤터리상 네 경로가 전부이며 모두 재읽기 성공, Markdown/한국어 표시 정상, redactions=0이다. 경로 누락·중복은 관찰되지 않았다. 광범위 검색 truncation은 좁은 전수 검색으로 보완했지만 내용 동일성, 최신성, 외부 대표성 및 후속 조치 실행 여부는 미검증이다.
- 요구사항-보고서 추적표, KPI 재계산 결과, 출처 대조표, 반례 점검표, 미해결 결함 및 인계 준비 판정을 포함한 최종 검증 패킷. supplied local evidence only; freshness and unobserved actions remain unverified
- 요구사항-보고서 추적표:
| 요구사항 | T05 보고서 위치(0부터) | 근거 파일 | 상태 |
|---|---|---|---|
| R-01 | 연결 없음 | 없음 | 미해결—T05 추적 누락 |
| R-02 | deliverables[1], [3] | evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md | 충족 |
| R-03 | deliverables[1], [2] | evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md | 충족 |
| R-04 | deliverables[3] | evidence/01-pilot-metrics.md | 충족 |
| R-05 | deliverables[2], [4] | evidence/01-pilot-metrics.md, evidence/02-security-review.md | 충족 |
| R-06 | deliverables[4], [6] | evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md | 충족, 후속 실행 미관측 |
| R-07 | deliverables[5] | evidence/04-finance-and-launch-gates.md | 충족, 실제 비용 미검증 |
| R-08 | deliverables[4] | evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md | 충족 |
| R-09 | deliverables[5], [6] | evidence/04-finance-and-launch-gates.md | 충족, 시작일 미제공 |
| R-10 | deliverables[1], [2], [6] | evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md | 충족 |
| R-11 | deliverables[0], [5], [7], [8] | 네 evidence 파일 | 충족, 최신성 미검증 |
- 위험 및 go/no-go 게이트:
| 영역 | 위험/관찰 | 심각도 | 현재 판정 | Go 조건 |
|---|---|---|---|---|
| 보안 | tenant_id 없는 캐시 키; 타 테넌트 문장 2/50 | Critical | No-Go | Critical 0건, 캐시 무효화·키 변경·회귀시험·독립 재시험 완료 |
| 개인정보 | 내부 메모 노출 3/100 | High | No-Go | 외부 콘텐츠 격리·출력 DLP 후 독립 재시험 |
| 개인정보 | 로그 90일 보존 대 승인 상한 30일 | High | No-Go | 실제 보존기간을 승인 상한과 일치시킴 |
| 개인정보 | PII 노출 3/1,200=0.25% | 문서상 심각도 미지정, 필수 게이트 차단 | No-Go | 0% |
| 품질 | 중대한 환각 11/1,200=0.92% | 원문상 중대한 사건 | No-Go | 0.10% 미만; 0.82%p 초과 감소 필요 |
| 감사 | prompt hash 완전성 환산 83% | Medium | No-Go | 99.9% 이상 |
| 품질 | CSAT 4.31 대 4.18 | 개선 점추정치 | 미검증 | 사전 정의한 비열등성 기준과 통계 검증 통과 |
| 계약 | EU 요구 고객 2/5, 서울 리전만 검증 | 계약 위험 | 대상 제외 | 검증 전 해당 고객 제외; 포함 전 EU 레지던시 검증 |
- 위험·go/no-go 게이트 표:
| 영역 | 확인된 위험 | 심각도 | 현재 판정 | Go 조건·책임 주체(제안) | 미충족 조치 |
|---|---|---|---|---|---|
| 보안 | tenant_id 없는 캐시 키, 타 테넌트 문장 2/50 | Critical, 원문 | No-Go | Critical 0건 및 캐시 무효화·키 변경·회귀·독립 재시험 / 보안 책임자 | 보류; canary 중이면 즉시 rollback |
| 개인정보 | 내부 메모 노출 3/100 | High, 원문 | No-Go | 콘텐츠 격리·출력 DLP 후 독립 재시험 / 보안 책임자 | 보류·재수정 |
| 개인정보 | 고객 PII 노출 3/1,200=0.25% | 원문 심각도 미지정, 필수 게이트 차단 | No-Go | 누출률 0% / 개인정보·보안 책임자 | 보류; 위반 시 rollback |
| 개인정보 | 실제 보존 90일, 승인 상한 30일 | High, 원문 | No-Go | 원문 로그 ≤30일 및 시정 증거 / 개인정보 책임자 | 고객 배포 금지 |
| 품질 | 중대한 환각 11/1,200=0.92%, 환불 오안내 4건 | 원문은 ‘중대한’ 사건, 필수 게이트 차단 | No-Go | <0.10% / 품질 책임자 | 보류; 위반 시 rollback |
| 감사 | prompt hash 17% 누락, 완전성 환산 83% | Medium, 원문 | No-Go | ≥99.9% / 보안·신뢰성 책임자 | 보류 |
| 품질 | CSAT 4.31 대 4.18 | 개선 점추정치 | 미검증 | 사전 정의한 비열등성 판정 통과 / 품질 책임자 | canary 금지 |
| 계약 | EU 요구 고객 2/5, 서울 리전만 검증 | 심각도 미지정, 대상 제외 게이트 | 대상 제외 | 레지던시 검증 전 해당 고객 제외 / 계약·데이터 책임자 | 계속 제외 |
| 자동 발송 | 미시험, 고객 1곳 명시적 거부 | High, 경영 추론 | No-Go | 별도 안전성 시험과 고객 동의가 확인될 때까지 비활성 / 제품·계약 책임자 | 상담원 검토 보조 모드 유지 |
- 일정 원장: evidence/01-pilot-metrics.md의 파일럿은 2026-06-01~06-28 4주이며, evidence/04-finance-and-launch-gates.md의 수정·재검증은 8주다. canary 기간과 전면 출시일은 제시되지 않았다.
- 자동 발송 전용 게이트: 판정 조건=별도 안전성 시험 통과와 대상 고객의 명시적 동의를 모두 충족(위험팀 권고); 범위=자동 발송 후보 고객·사용 사례 전체; 책임=제품 안전 책임자와 고객 계약 책임자(권고); 시점=기능 활성화 전; 실패 조치=계속 비활성화하고 상담원 검토 보조 모드 유지. 현재는 미시험이고 한 고객사가 거부했으므로 활성화 불가다.
- 정확한 파일명 목록, 파일별 관찰 기록, 주제 색인, 접근·형식 이상 및 완전성 판정을 포함한 출처 원장. supplied local evidence only; freshness and unobserved actions remain unverified
- 주제 색인: KPI=SRC-01/SRC-04; 보안=SRC-02/SRC-04; 개인정보=SRC-01/SRC-02/SRC-03/SRC-04; 품질=SRC-01/SRC-03/SRC-04; 비용·예산=SRC-04; 일정=SRC-01/SRC-04.
- 출시 결정: 전면 출시 ‘보류’. 수정·독립 재시험 전에는 내부 shadow 평가만 수행하고, 전 게이트 통과 후 상담원 검토 필수 5% canary에 진입한다.
- 출시 판단: 보류. evidence/02-security-review.md의 명시적 전면 출시 차단과 evidence/04-finance-and-launch-gates.md 대비 다수 게이트 실패가 해소될 때까지 고객 대상 출시를 진행하지 않는다.
- 출처 대조표:
| T05 항목 | 직접 확인 출처 | 결과 |
|---|---|---|
| 모집단·KPI·품질 사건 | evidence/01-pilot-metrics.md | 일치 |
| 보안·개인정보 결함과 출시 차단 | evidence/02-security-review.md | 일치 |
| 상담원·고객 피드백, EU, 자동 발송 거부 | evidence/03-customer-feedback.md | 일치 |
| 비용·예산·일정·게이트·rollback | evidence/04-finance-and-launch-gates.md | 일치 |
| T01 출처 원장 등재 여부 | 제공되지 않음 | 미해결—대조 불가 |
- 파일 원장: SRC-01=evidence/01-pilot-metrics.md; SRC-02=evidence/02-security-review.md; SRC-03=evidence/03-customer-feedback.md; SRC-04=evidence/04-finance-and-launch-gates.md.
- 파일명 인용이 포함된 KPI 비교표, 계산 근거, 비교 가능성 판정과 상충·결측 목록을 포함한 연구팀 성과 보고. supplied local evidence only; freshness and unobserved actions remain unverified
- 파일명별 비용·예산·일정 원장과 단계별 목표, 책임, 의존성, 예산 상태 및 의사결정 시점을 포함한 전략팀 실행성 보고. supplied local evidence only; freshness and unobserved actions remain unverified
- 파일명별 위험 등록부, 심각도 근거, 완화 상태, 잔여 위험과 진입·확대·중단 게이트를 포함한 위험팀 보고. supplied local evidence only; freshness and unobserved actions remain unverified
- 파일명별 위험 등록부:
| 위험·파일 | 영향 | 발생 조건 | 심각도·근거 | 완화 상태 | 잔여 위험 | 불확실성 |
|---|---|---|---|---|---|---|
| 교차 테넌트 캐시, evidence/02-security-review.md | 타 고객 정보 반환 | tenant_id 없는 키, 2/50 재현 | Critical, 원문 명시 | 캐시 무효화·키 변경·회귀시험 요구; 완료 미검증 | Critical | 수정 후 재현율 미상 |
| 내부 메모 노출, evidence/02-security-review.md | 비공개 메모 공개 | 인젝션 3/100 | High, 원문 명시 | 콘텐츠 격리·DLP 요구; 완료 미검증 | High | 통제 후 노출률 미상 |
| PII 노출, evidence/01-pilot-metrics.md | 개인정보 유출 | 다른 티켓 답변 3/1,200 | Critical, 위험팀 추론·게이트 0% | 완료 증거 없음 | Critical | 캐시 결함과 인과관계 미상 |
| 보존기간 불일치, evidence/02-security-review.md | 승인 범위 초과 보관 | 원문 로그 90일, 상한 30일 | High, 원문 명시 | 시정 완료 증거 없음 | High | 기존 로그 처리 미상 |
| 환각·환불 오안내, evidence/01-pilot-metrics.md | 정책 오안내·고객 피해 | 11/1,200, 오안내 4건 | High, 위험팀 추론 | 근거 링크·불확실성 표시 제안; 효과 미시험 | High | 수정 후 비율 미상 |
| EU 레지던시, evidence/03-customer-feedback.md | 계약 요구 미충족 | 요구 고객 2/5, 서울만 시험 | High, 위험팀 추론 | 검증 전 제외 | High | 구성·일정 미상 |
| 자동 발송, evidence/01-pilot-metrics.md 및 evidence/03-customer-feedback.md | 검토 없는 오류 확산 | 미시험, 고객 1곳 거부 | High, 위험팀 추론 | 현재 시험·동의 없음 | High | 안전성 기준·표본 미정 |
| 감사 로그, evidence/02-security-review.md | 17% 호출 재현 불가 | 비동기 flush 실패 | Medium, 원문 명시 | 완료 증거 없음 | Medium | 누락 호출 내용 미상 |
| 일본어·대표성, evidence/01-pilot-metrics.md 및 evidence/03-customer-feedback.md | 세그먼트 오판 | 일본어 42건, 고객사 5곳 | Medium, 위험팀 추론 | 추가 평가 없음 | Medium | 세그먼트 오류율 미상 |
| 에스컬레이션 실패, evidence/01-pilot-metrics.md | 필요한 사람 개입 누락 가능성 | 정의·사건·원인 자료 없음 | 미판정 | 평균 비율만 관측 | 평가 불가 | 사건·세그먼트 꼬리위험 전체 미상 |
- 파일별 관찰: SRC-01은 파일럿 KPI·품질 사건·시험 범위, SRC-02는 보안·개인정보 결함과 출시 차단, SRC-03은 상담원/고객 피드백·EU 레지던시·대표성 한계, SRC-04는 단위 경제성·예산·일정·출시 게이트·rollback을 담당한다.
- 평균 KPI와 분리한 에스컬레이션 불확실성: 평균 에스컬레이션 비율은 14.2%에서 12.8%로 개선됐지만, 에스컬레이션 실패의 정의·건수·원인·중대성·세그먼트별 결과가 없다. 따라서 비율 감소가 적절한 자동 해결인지 필요한 사람 개입의 누락인지 판정할 수 없다.
- 핵심 KPI 표:
| KPI | 기준값 | 파일럿값 | 변화량 |
|---|---:|---:|---:|
| 최초 응답시간 중앙값 | 18.0분 | 10.2분 | -43.3%(-7.8분) |
| 해결시간 중앙값 | 9.6시간 | 8.1시간 | -15.6%(-1.5시간) |
| CSAT | 4.18/5 | 4.31/5 | +0.13 |
| 에스컬레이션 비율 | 14.2% | 12.8% | -1.4%p |
- 핵심 KPI 표:
| KPI | 기준값 | 파일럿값 | 변화량 | 판정·근거 |
|---|---:|---:|---:|---|
| 최초 응답시간 중앙값 | 18.0분 | 10.2분 | -7.8분 / -43.3% | 개선; evidence/01-pilot-metrics.md |
| 해결시간 중앙값 | 9.6시간 | 8.1시간 | -1.5시간 / -15.6% | 개선; evidence/01-pilot-metrics.md |
| CSAT | 4.18/5 | 4.31/5 | +0.13점 / +3.1% | 점추정 개선, 정식 비열등성 미검증; evidence/01-pilot-metrics.md, evidence/04-finance-and-launch-gates.md |
| 에스컬레이션 비율 | 14.2% | 12.8% | -1.4%p / 상대 -9.9% | 개선, 실패 사건 자료는 없음; evidence/01-pilot-metrics.md |
| 중대한 환각률 | 미제공 | 0.92%(11/1,200) | 전후 변화 계산 불가 | <0.10% 게이트 실패; evidence/01-pilot-metrics.md, evidence/04-finance-and-launch-gates.md |
| PII 노출률 | 미제공 | 0.25%(3/1,200) | 전후 변화 계산 불가 | 0% 게이트 실패; evidence/01-pilot-metrics.md, evidence/04-finance-and-launch-gates.md |
| prompt hash 완전성 | 미제공 | 83% 환산 | 전후 변화 계산 불가 | ≥99.9% 게이트 실패; evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md |
- KPI 비교표:
| 지표명 | 정의 | 단위 | 기간/모집단 | 기준값 | 파일럿값 | 변화량 | 비교 가능성 | 근거 파일명 |
|---|---|---|---|---:|---:|---|---|---|
| 최초 응답시간 중앙값 | 최초 응답까지의 중앙시간 | 분 | 2026-06-01~06-28; 국내 SMB 티켓 1,200건; 상담원 32명 | 18.0 | 10.2 | -7.8분; -43.3% | 직접 비교 가능 | evidence/01-pilot-metrics.md |
| 해결시간 중앙값 | 티켓 해결까지의 중앙시간 | 시간 | 동일 파일럿 | 9.6 | 8.1 | -1.5시간; -15.6% | 직접 비교 가능 | evidence/01-pilot-metrics.md |
| CSAT | 고객 만족도 점수 | 5점 척도 | 동일 파일럿 | 4.18 | 4.31 | +0.13점; +3.1% | 점추정 비교 가능, 비열등성 판정 불가 | evidence/01-pilot-metrics.md; evidence/04-finance-and-launch-gates.md |
| 에스컬레이션 비율 | 상위 지원으로 이관된 티켓 비율 | % | 동일 파일럿 | 14.2% | 12.8% | -1.4%p; 상대 -9.9% | 직접 비교 가능 | evidence/01-pilot-metrics.md |
| 중대한 환각률 | 중대한 환각 답변/전체 티켓 | % | 동일 파일럿 1,200건 | 미제공 | 0.92% (11건) | 전후 변화 계산 불가; <0.10% 통과에는 0.82%p 초과 감소 필요 | 기준 결측; 게이트 비교만 가능 | evidence/01-pilot-metrics.md; evidence/04-finance-and-launch-gates.md |
| PII 노출률 | 다른 티켓 답변에 고객 PII가 노출된 사건/전체 티켓 | % | 동일 파일럿 1,200건 | 미제공 | 0.25% (3건) | 전후 변화 계산 불가; 0% 통과에는 0.25%p 감소 필요 | 기준 결측; 게이트 비교만 가능 | evidence/01-pilot-metrics.md; evidence/04-finance-and-launch-gates.md |
| 교차 테넌트 재현률 | 합성 재현에서 타 테넌트 문장이 반환된 비율 | % | 보안 합성 재현 50회 | 미제공 | 4.0% (2/50), Critical 발견 1건 | 전후 변화 계산 불가; Critical 0건 게이트 실패 | 운영 KPI와 모집단·시험 방식이 달라 상호 비교 불가 | evidence/02-security-review.md; evidence/04-finance-and-launch-gates.md |
| prompt hash 완전성 | prompt hash가 존재하는 호출 비율 | % | 파일럿 호출; 호출 수 미제공 | 미제공 | 83.0% 환산 | 전후 변화 계산 불가; 99.9%까지 최소 +16.9%p 필요 | 기준·호출 수 결측; 게이트 비교만 가능 | evidence/02-security-review.md; evidence/04-finance-and-launch-gates.md |
| 티켓당 처리비 | 추론비와 필수 상담원 검토비 합계 | USD/티켓 | 기간·모집단 미제공 | USD 8.20 | USD 1.77 예상값 | -USD 6.43; -78.4% | 모델 비교만 가능, 실측 파일럿 비교 불가 | evidence/04-finance-and-launch-gates.md |
- KPI 재계산 결과:
| KPI | 기준값 | 파일럿값 | 재계산 변화량 | 검증 결과 |
|---|---:|---:|---:|---|
| 최초 응답시간 중앙값 | 18.0분 | 10.2분 | -7.8분; -43.33% | 일치 |
| 해결시간 중앙값 | 9.6시간 | 8.1시간 | -1.5시간; -15.625% | 일치 |
| CSAT | 4.18/5 | 4.31/5 | +0.13점; 상대 +3.11% | 수치 일치, 비열등성 미검증 |
| 에스컬레이션 비율 | 14.2% | 12.8% | -1.4%p; 상대 -9.86% | 일치 |
| 중대한 환각률 | 미제공 | 11/1,200=0.9167% | 전후 변화 불가 | 반올림 0.92%; 게이트 실패 |
| PII 노출률 | 미제공 | 3/1,200=0.25% | 전후 변화 불가 | 게이트 실패 |
| prompt hash 완전성 | 미제공 | 100%-17%=83% | 전후 변화 불가 | 게이트 실패 |
| 보조 모드 처리비 | USD 8.20 | USD 1.77 | -USD 6.43; -78.4% | 산술 일치, 재무 가정 |
