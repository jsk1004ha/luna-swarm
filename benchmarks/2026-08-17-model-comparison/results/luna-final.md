# Luna Swarm 결과

38 immutable leaf claim(s) passed evidence-lineage validation; final critic issues remain explicit caveats.

## 답변

## Verified claims

- 04의 필수 게이트는 교차 테넌트 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 비열등, EU 레지던시 검증이다. 현재 문서상 여러 게이트의 요구 조건과 관측값이 불일치하거나 검증되지 않았다.
  - support: 04의 게이트와 01~03의 관측값을 대조한 결과다.
  - evidence: read 성공: evidence/02-security-review.md. 2026-07-03 검토일, Critical/High/Medium 발견사항과 전면 출시 차단 결론이 포함돼 있다.
  - evidence: search(path="evidence/03-customer-feedback.md", query="EU")가 5~6행의 EU 요구 및 서울 리전 미검증 문구를 반환했다.
  - evidence: read 성공: evidence/03-customer-feedback.md. 상담원 피드백, EU 레지던시 요구·미검증, 자동 발송 거부, 대표성 한계가 포함돼 있다.
  - evidence: search(path="evidence/04-finance-and-launch-gates.md", query="99.9%")가 24행의 prompt hash 게이트를 반환했다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
- 현재 안전한 결정은 전면 출시 보류이며, 이는 보안 문서의 직접 차단 결론과 관측된 게이트 위반·미검증 상태를 종합한 inference다.
  - support: evidence/02-security-review.md의 차단 결론과 evidence/04-finance-and-launch-gates.md의 필수 게이트를 대조했다. 독립 재시험 성공은 주장하지 않는다.
  - evidence: 선행 read 기록상 evidence/04-finance-and-launch-gates.md에는 비용·예산·8주 일정·출시 게이트·canary/rollback 경로가 포함된다.
  - evidence: 선행 read 기록상 evidence/02-security-review.md에는 Critical/High/Medium 발견사항, 전면 출시 차단, 독립 재시험 필요가 포함된다.
- 비용 근거는 티켓당 기존 USD 8.20, 추론비 USD 0.42, 필수 상담원 검토비 USD 1.35, 합산 USD 1.77이며, 78.4% 절감률은 상담원 검토를 유지하는 보조 모드 기준이다.
  - support: 04의 단위 경제성에 근거한다.
  - evidence: search(path="evidence/04-finance-and-launch-gates.md", query="USD")가 5~8행 및 15~16행의 비용·예산 값을 반환했다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
- 파일럿 대표성 공백은 국내 SMB, 4주, 티켓 1,200건, 상담원 32명, 일본어 티켓 42건, 고객사 5곳이며, 피드백은 통계적 대표성을 보장하지 않는다. EU 요구 고객 2곳은 서울 리전만 사용해 레지던시가 검증되지 않았다.
  - support: evidence/01-pilot-metrics.md 및 evidence/03-customer-feedback.md의 표본·운영 조건과 한계.
  - evidence: 실제 read 성공: evidence/03-customer-feedback.md. EU 레지던시 요구, 서울 리전만 사용, 자동 발송 거부 사례, 피드백 대표성 한계가 기록돼 있다.
  - evidence: 실제 read 성공: evidence/01-pilot-metrics.md. 4주 국내 SMB 파일럿, 티켓 1,200건, 상담원 32명, KPI, 환각·환불 오안내·PII 노출, 자동 발송 미시험이 기록돼 있다.
- 01-pilot-metrics.md의 주제 검색은 KPI(5행), 환각(14행), 자동 발송(19행), 해결시간(8행), CSAT(9행), 에스컬레이션 비율(10행), PII(16행)에서 매칭됐다.
  - support: 파일별 search 결과의 실제 query·line·preview다.
  - evidence: search 성공: evidence/01-pilot-metrics.md. KPI→5행, 최초 응답시간→7행, 해결시간 중앙값→8행, CSAT→9행, 에스컬레이션 비율→10행, 환각→14행, PII→16행, 자동 발송→19행. 각 결과는 line·column·preview를 반환했다.
- 04-finance-and-launch-gates.md는 기존 처리비 USD 8.20, 추론비 USD 0.42, 검토비 USD 1.35, 합산 USD 1.77, 보조 모드 기준 절감률 78.4%, 총 예산 USD 120,000, 수정 예상비 USD 46,000, 수정·재검증 기간 8주를 제시한다.
  - support: 04의 5~17행 본문과 USD·8주 검색 결과에 직접 근거한다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md, bytesRead=1148. 본문에는 단위 경제성(5~10행), 예산·일정(15~17행), 전면 출시 게이트(19~26행), canary·rollback 경로(28행)가 있다.
  - evidence: search 성공: evidence/04-finance-and-launch-gates.md. USD→5~8행 및 15~16행, 8주→17행, 전면 출시→19행, 99.9%→24행, 비열등→25행, rollback→28행. 각 결과는 line·column·preview를 반환했다.
- 03-customer-feedback.md는 상담원 32명 중 24명이 작성시간 감소를 보고했고, 고객사 5곳 중 2곳이 EU 데이터 레지던시를 요구하지만 서울 리전만 사용해 검증되지 않았으며, 피드백은 통계적 대표성을 보장하지 않는다고 명시한다.
  - support: 03의 read 본문 및 EU·대표성 검색 결과에 직접 근거한다.
  - evidence: read 성공: evidence/03-customer-feedback.md, bytesRead=810. 본문에는 상담원·고객 피드백(3~8행)과 통계적 대표성 한계(10행)가 있다.
  - evidence: search 성공: evidence/03-customer-feedback.md. EU→5~6행, 대표성→10행. 각 결과는 line·column·preview를 반환했다.
- 보류 결론은 문서의 직접 보안 차단 결론과 현재 관찰된 게이트 위반·미검증 상태를 종합한 inference다. 수정 후 독립 재시험의 성공을 주장하지 않는다.
  - support: evidence/02-security-review.md의 전면 출시 차단 및 evidence/04-finance-and-launch-gates.md의 게이트.
  - evidence: 실제 read 성공: evidence/04-finance-and-launch-gates.md. 비용·예산·8주 일정, 전면 출시 게이트, 내부 shadow·5% canary·rollback 경로가 기록돼 있다.
  - evidence: 실제 read 성공: evidence/02-security-review.md. 문서 심각도별 보안·개인정보 발견사항, 재현 수치, 전면 출시 차단, 수정 후 독립 재시험 필요가 기록돼 있다.
- 선행 산출물은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md 네 문서의 실제 read와 inventory/search 성공을 기록한다.
  - support: 수락된 K2·K3 dependency artifact의 evidence-provenance 기록이다.
  - evidence: 선행 read 기록상 evidence/04-finance-and-launch-gates.md에는 비용·예산·8주 일정·출시 게이트·canary/rollback 경로가 포함된다.
  - evidence: 선행 read 기록상 evidence/02-security-review.md에는 Critical/High/Medium 발견사항, 전면 출시 차단, 독립 재시험 필요가 포함된다.
  - evidence: 선행 read 기록상 evidence/01-pilot-metrics.md에는 파일럿 조건, KPI, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함된다.
  - evidence: 선행 read 기록상 evidence/03-customer-feedback.md에는 EU 레지던시 요구·미검증 및 대표성 한계가 포함된다.
  - evidence: K2·K3 선행 산출물의 inventory 기록은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md 네 파일과 실제 read/search 성공을 제시한다.
- 03-customer-feedback.md의 EU 검색은 5~6행, 대표성 검색은 10행에서 매칭됐다.
  - support: 파일별 search 결과의 실제 line·preview다.
  - evidence: search 성공: evidence/03-customer-feedback.md. EU→5~6행, 대표성→10행. 각 결과는 line·column·preview를 반환했다.
- 파일럿 조건은 2026-06-01~2026-06-28 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여이며, 최초 응답시간은 18.0분에서 10.2분으로 7.8분 감소, 해결시간은 9.6시간에서 8.1시간으로 1.5시간 감소, CSAT는 4.18/5에서 4.31/5로 0.13 상승, 에스컬레이션 비율은 14.2%에서 12.8%로 1.4%p 감소했다.
  - support: evidence/01-pilot-metrics.md의 KPI와 파일럿 조건 및 산술 차이.
  - evidence: 선행 read 기록상 evidence/01-pilot-metrics.md에는 파일럿 조건, KPI, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함된다.
- 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았으므로, 파일럿 KPI와 78.4% 절감률을 전면 자동화 성능으로 일반화할 수 없다.
  - support: evidence/01-pilot-metrics.md와 evidence/04-finance-and-launch-gates.md의 운영 범위 기록.
  - evidence: 선행 read 기록상 evidence/04-finance-and-launch-gates.md에는 비용·예산·8주 일정·출시 게이트·canary/rollback 경로가 포함된다.
  - evidence: 선행 read 기록상 evidence/01-pilot-metrics.md에는 파일럿 조건, KPI, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함된다.
- 자동 발송 성능은 비교할 수 없다. 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았다. 따라서 보조 모드의 절감률이나 KPI를 전면 자동화에 적용할 수 없다.
  - support: 01의 운영 조건과 04의 절감률 적용 범위에 근거한다.
  - evidence: search(path="evidence/01-pilot-metrics.md", query="자동 발송")가 19행의 자동 발송 미시험 문구를 반환했다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
- 이번 재검증에서 evidence/ 디렉터리의 네 문서를 실제 inventory 및 read로 확인했다.
  - support: 실제 search inventory와 네 파일의 read 결과.
  - evidence: 실제 read 성공: evidence/03-customer-feedback.md. EU 레지던시 요구, 서울 리전만 사용, 자동 발송 거부 사례, 피드백 대표성 한계가 기록돼 있다.
  - evidence: 실제 read 성공: evidence/04-finance-and-launch-gates.md. 비용·예산·8주 일정, 전면 출시 게이트, 내부 shadow·5% canary·rollback 경로가 기록돼 있다.
  - evidence: 실제 search(path="evidence", query="HelioDesk") 결과는 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md 네 파일이며 fileInventoryComplete=true, filesSearched=4였다.
  - evidence: 실제 read 성공: evidence/01-pilot-metrics.md. 4주 국내 SMB 파일럿, 티켓 1,200건, 상담원 32명, KPI, 환각·환불 오안내·PII 노출, 자동 발송 미시험이 기록돼 있다.
  - evidence: 실제 read 성공: evidence/02-security-review.md. 문서 심각도별 보안·개인정보 발견사항, 재현 수치, 전면 출시 차단, 수정 후 독립 재시험 필요가 기록돼 있다.
- KPI 변화량은 최초 응답시간 중앙값 18.0분→10.2분, -7.8분(-43.3%); 해결시간 중앙값 9.6시간→8.1시간, -1.5시간(-15.6%); CSAT 4.18/5→4.31/5, +0.13/5; 에스컬레이션 비율 14.2%→12.8%, -1.4%p다.
  - support: 01의 KPI 표와 값의 산술 차이에 근거한다. 상대 변화율은 문서 표기값을 따랐고, 절대 변화량은 기준값과 파일럿값의 차이로 계산했다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
  - evidence: search(path="evidence/01-pilot-metrics.md", query="KPI")가 5행의 KPI 표를 반환했다.
- 주요 출시 위험은 Critical 교차 테넌트 캐시 결함(50회 중 2회 타 테넌트 요약 반환), High 내부 메모 노출(100건 중 3건), 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%)이다.
  - support: 01과 02의 보안·품질 사건 기록에 근거한다.
  - evidence: read 성공: evidence/02-security-review.md. 2026-07-03 검토일, Critical/High/Medium 발견사항과 전면 출시 차단 결론이 포함돼 있다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
  - evidence: search(path="evidence/02-security-review.md", query="Critical")가 7행의 교차 테넌트 캐시 결함을 반환했다.
- EU 요구 고객 2곳은 서울 리전만 사용해 EU 레지던시가 미검증이며, 파일럿 대표성과 CSAT 비열등성 검정도 확인되지 않았다.
  - support: evidence/01-pilot-metrics.md와 evidence/03-customer-feedback.md의 표본·대표성·EU 기록 및 evidence/04의 게이트.
  - evidence: 선행 read 기록상 evidence/04-finance-and-launch-gates.md에는 비용·예산·8주 일정·출시 게이트·canary/rollback 경로가 포함된다.
  - evidence: 선행 read 기록상 evidence/01-pilot-metrics.md에는 파일럿 조건, KPI, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함된다.
  - evidence: 선행 read 기록상 evidence/03-customer-feedback.md에는 EU 레지던시 요구·미검증 및 대표성 한계가 포함된다.
- 현재 문서 기준 안전한 의사결정은 전면 출시 보류다. 보안 문서가 전면 출시 차단을 명시하고, 독립 재시험과 모든 출시 게이트 통과 전에는 5% canary조차 시작하지 않도록 권고한다.
  - support: 전면 출시 차단은 직접 문서 근거이며, 보류 판단은 해당 결론·게이트·미검증 항목을 종합한 inference다.
  - evidence: read 성공: evidence/02-security-review.md. 2026-07-03 검토일, Critical/High/Medium 발견사항과 전면 출시 차단 결론이 포함돼 있다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
- 요구된 산출물은 파일명 기반 추적성이 있는 한국어 경영진 보고서이며 Work Order의 첫 deliverable 문구를 그대로 보존했다.
  - support: 현재 출력의 deliverables 첫 항목과 Work Order deliverable을 대조한 결정적 점검이다.
  - check: schema-conformance: 요구된 필드와 claim별 requirementIds/evidenceRefs 구조를 수동 점검했다. 별도 schema validator는 실행하지 않았다.
- 비용 근거는 기존 티켓당 USD 8.20, 추론비 USD 0.42, 필수 상담원 검토비 USD 1.35, 합산 USD 1.77이며, 승인된 2026년 하반기 총 프로그램 예산은 USD 120,000, 수정 예상비는 USD 46,000, 수정·재검증 예상 기간은 8주다.
  - support: evidence/04-finance-and-launch-gates.md의 비용·예산·일정 기록.
  - evidence: 선행 read 기록상 evidence/04-finance-and-launch-gates.md에는 비용·예산·8주 일정·출시 게이트·canary/rollback 경로가 포함된다.
- 02-security-review.md는 Critical 교차 테넌트 캐시 키 결함, 50회 중 2회 다른 테넌트 요약 반환, 100건 중 3건 내부 메모 노출, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락을 기록하고 24행에서 전면 출시 차단과 독립 재시험 필요성을 명시한다.
  - support: 02의 7~24행 본문과 Critical·내부 메모·90일·prompt hash·출시 차단 검색 결과에 직접 근거한다.
  - evidence: search 성공: evidence/02-security-review.md. Critical→7행, tenant_id→8행, 내부 메모→12~13행, 90일→17행, prompt hash→21행, 전면 출시 차단→24행. PII query는 matches=[]를 반환했다.
  - evidence: read 성공: evidence/02-security-review.md, bytesRead=1091. 본문에는 Critical/High/Medium 발견사항(7~23행)과 전면 출시 차단 결론(24행)이 있다.
- 승인된 2026년 하반기 총 프로그램 예산은 USD 120,000, 보안·개인정보 수정 예상비는 USD 46,000, 수정 및 재검증 예상 기간은 8주다. 단순 차액은 USD 74,000이나 기타 비용·잔여 집행계획은 확인되지 않았다.
  - support: 04의 예산·일정 값과 단순 산술 차이에 근거한다.
  - evidence: search(path="evidence/04-finance-and-launch-gates.md", query="USD")가 5~8행 및 15~16행의 비용·예산 값을 반환했다.
  - evidence: search(path="evidence/04-finance-and-launch-gates.md", query="8주")가 17행의 수정·재검증 기간을 반환했다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
- R1~R8 각각에 대해 근거 파일 또는 미충족·미검증 사유를 보고서 추적표에 연결했다.
  - support: 현재 출력의 요구사항 추적표를 점검한 결과다.
  - check: traceability-check: PASS. R1~R8 각각에 claim 또는 보고서 추적표를 연결했고, 미검증 항목은 보류·불확실성으로 표시했다.
- 02-security-review.md의 주제 검색은 Critical(7행), 내부 메모(12~13행), prompt hash(21행), 전면 출시 차단(24행), 90일(17행)에서 매칭됐다. PII query는 매칭 0건이었다.
  - support: 파일별 search 결과의 실제 query·line·preview이며, PII 0건도 검색 결과에 기록돼 있다.
  - evidence: search 성공: evidence/02-security-review.md. Critical→7행, tenant_id→8행, 내부 메모→12~13행, 90일→17행, prompt hash→21행, 전면 출시 차단→24행. PII query는 matches=[]를 반환했다.
- 04의 전면 출시 게이트는 교차 테넌트 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 비열등, EU 레지던시 검증 완료다. 권고 경로는 내부 shadow 평가 후 필수 상담원 검토 5% canary이며, 위반 시 수동 프로세스로 rollback한다.
  - support: 04의 19~28행 본문과 전면 출시·99.9%·비열등·rollback 검색 결과에 직접 근거한다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md, bytesRead=1148. 본문에는 단위 경제성(5~10행), 예산·일정(15~17행), 전면 출시 게이트(19~26행), canary·rollback 경로(28행)가 있다.
  - evidence: search 성공: evidence/04-finance-and-launch-gates.md. USD→5~8행 및 15~16행, 8주→17행, 전면 출시→19행, 99.9%→24행, 비열등→25행, rollback→28행. 각 결과는 line·column·preview를 반환했다.
- evidence/에는 01-pilot-metrics.md, 02-security-review.md, 03-customer-feedback.md, 04-finance-and-launch-gates.md 네 파일이 있으며 네 파일 모두 read에 성공했다.
  - support: 실제 evidence inventory와 네 파일의 read 결과에 근거한다.
  - evidence: read 성공: evidence/02-security-review.md. 2026-07-03 검토일, Critical/High/Medium 발견사항과 전면 출시 차단 결론이 포함돼 있다.
  - evidence: read 성공: evidence/03-customer-feedback.md. 상담원 피드백, EU 레지던시 요구·미검증, 자동 발송 거부, 대표성 한계가 포함돼 있다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
  - evidence: search(path="evidence", query="HelioDesk")가 fileInventoryComplete=true, filesSearched=4로 네 파일을 반환했다: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md.
- 네 파일 모두 본문 read에 성공했다: 01은 965 bytes, 02는 1,091 bytes, 03은 810 bytes, 04는 1,148 bytes다.
  - support: 각 파일의 read 결과와 bytesRead에 근거한다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md, bytesRead=1148. 본문에는 단위 경제성(5~10행), 예산·일정(15~17행), 전면 출시 게이트(19~26행), canary·rollback 경로(28행)가 있다.
  - evidence: read 성공: evidence/02-security-review.md, bytesRead=1091. 본문에는 Critical/High/Medium 발견사항(7~23행)과 전면 출시 차단 결론(24행)이 있다.
  - evidence: read 성공: evidence/01-pilot-metrics.md, bytesRead=965. 본문에는 파일럿 기간·표본, KPI 표(7~10행), 품질 사건(14~17행), 보조 모드 및 자동 발송 미시험(19행)이 있다.
  - evidence: read 성공: evidence/03-customer-feedback.md, bytesRead=810. 본문에는 상담원·고객 피드백(3~8행)과 통계적 대표성 한계(10행)가 있다.
- 문서가 부여한 보안 심각도는 교차 테넌트 캐시 키 결함 Critical, 프롬프트 인젝션 내부 메모 노출 High, 데이터 보존기간 불일치 High, 감사 로그 불완전 Medium이다.
  - support: evidence/02-security-review.md의 발견사항 라벨.
  - evidence: 실제 read 성공: evidence/02-security-review.md. 문서 심각도별 보안·개인정보 발견사항, 재현 수치, 전면 출시 차단, 수정 후 독립 재시험 필요가 기록돼 있다.
- 추가 위험평가상 환각·환불 오안내와 PII 노출은 전면 출시 게이트를 직접 위반하는 고위험 품질·개인정보 위험이다. 파일럿에서 중대한 환각은 11건(0.92%), 환불 자격 오안내는 4건, 다른 티켓의 PII 노출은 3건(0.25%)이었다.
  - support: 고위험 평가는 문서의 출시 기준에 대한 inference이며, 관찰값은 evidence/01-pilot-metrics.md와 evidence/04-finance-and-launch-gates.md에 있다.
  - evidence: 실제 read 성공: evidence/04-finance-and-launch-gates.md. 비용·예산·8주 일정, 전면 출시 게이트, 내부 shadow·5% canary·rollback 경로가 기록돼 있다.
  - evidence: 실제 read 성공: evidence/01-pilot-metrics.md. 4주 국내 SMB 파일럿, 티켓 1,200건, 상담원 32명, KPI, 환각·환불 오안내·PII 노출, 자동 발송 미시험이 기록돼 있다.
- 현재 전면 출시 필수 기준은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, 기존 CSAT 4.18 대비 비열등, EU 레지던시 검증이다.
  - support: evidence/04-finance-and-launch-gates.md의 필수 게이트.
  - evidence: 실제 read 성공: evidence/04-finance-and-launch-gates.md. 비용·예산·8주 일정, 전면 출시 게이트, 내부 shadow·5% canary·rollback 경로가 기록돼 있다.
- evidence/ 검색 결과의 fileInventoryComplete가 true이고 filesSearched가 4이며, 다음 네 파일만 반환됐다: 01-pilot-metrics.md, 02-security-review.md, 03-customer-feedback.md, 04-finance-and-launch-gates.md.
  - support: evidence/에 대한 HelioDesk 검색의 실제 inventory 결과다.
  - evidence: search(path="evidence", query="HelioDesk") 결과: files=[evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md], fileInventoryComplete=true, filesSearched=4, truncated=false. 이는 실제 evidence/ inventory 결과다.
  - check: acceptance check—directory and count: PASS. 실제 search inventory가 네 파일을 반환했고 문서 수는 정확히 4개다.
- 현재 제공 문서만 기준으로 한 안전한 결론은 전면 출시 보류다. 이는 02가 직접 명시한 전면 출시 차단과 04의 미충족 여부를 확인해야 하는 게이트에 근거한 증거 기반 판단이다.
  - support: 전면 출시 차단은 직접 문서 근거이고, 보류 결론은 그 근거와 출시 게이트를 종합한 inference다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md, bytesRead=1148. 본문에는 단위 경제성(5~10행), 예산·일정(15~17행), 전면 출시 게이트(19~26행), canary·rollback 경로(28행)가 있다.
  - evidence: search 성공: evidence/02-security-review.md. Critical→7행, tenant_id→8행, 내부 메모→12~13행, 90일→17행, prompt hash→21행, 전면 출시 차단→24행. PII query는 matches=[]를 반환했다.
  - evidence: read 성공: evidence/02-security-review.md, bytesRead=1091. 본문에는 Critical/High/Medium 발견사항(7~23행)과 전면 출시 차단 결론(24행)이 있다.
  - evidence: search 성공: evidence/04-finance-and-launch-gates.md. USD→5~8행 및 15~16행, 8주→17행, 전면 출시→19행, 99.9%→24행, 비열등→25행, rollback→28행. 각 결과는 line·column·preview를 반환했다.
- 문서가 제시한 동일 파일럿 범위는 2026-06-01~2026-06-28 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여다. 이 범위에서 기존 프로세스와 HelioDesk 상담원 보조값을 비교했다.
  - support: 01-pilot-metrics.md의 측정 조건에 근거한다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
- 01-pilot-metrics.md의 KPI 표는 최초 응답시간 18.0분→10.2분(-43.3%), 해결시간 9.6시간→8.1시간(-15.6%), CSAT 4.18/5→4.31/5(+0.13), 에스컬레이션 14.2%→12.8%(-1.4%p)를 기록한다.
  - support: 01의 7~10행 read 본문과 KPI 관련 search preview에 직접 기재돼 있다.
  - evidence: search 성공: evidence/01-pilot-metrics.md. KPI→5행, 최초 응답시간→7행, 해결시간 중앙값→8행, CSAT→9행, 에스컬레이션 비율→10행, 환각→14행, PII→16행, 자동 발송→19행. 각 결과는 line·column·preview를 반환했다.
  - evidence: read 성공: evidence/01-pilot-metrics.md, bytesRead=965. 본문에는 파일럿 기간·표본, KPI 표(7~10행), 품질 사건(14~17행), 보조 모드 및 자동 발송 미시험(19행)이 있다.
- 04-finance-and-launch-gates.md의 주제 검색은 USD(5~8행, 15~16행), 8주(17행), 전면 출시(19행), 99.9%(24행), 비열등(25행), rollback(28행)에서 매칭됐다.
  - support: 파일별 search 결과의 실제 query·line·preview다.
  - evidence: search 성공: evidence/04-finance-and-launch-gates.md. USD→5~8행 및 15~16행, 8주→17행, 전면 출시→19행, 99.9%→24행, 비열등→25행, rollback→28행. 각 결과는 line·column·preview를 반환했다.
- 주요 위험은 Critical 교차 테넌트 캐시 결함, High 내부 메모 노출과 보존기간 불일치, 감사 로그 불완전, 중대한 환각 0.92%, PII 노출 0.25%이며, 필수 출시 게이트 일부와 관측값이 불일치한다.
  - support: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md의 사건·게이트 대조.
  - evidence: 선행 read 기록상 evidence/04-finance-and-launch-gates.md에는 비용·예산·8주 일정·출시 게이트·canary/rollback 경로가 포함된다.
  - evidence: 선행 read 기록상 evidence/02-security-review.md에는 Critical/High/Medium 발견사항, 전면 출시 차단, 독립 재시험 필요가 포함된다.
  - evidence: 선행 read 기록상 evidence/01-pilot-metrics.md에는 파일럿 조건, KPI, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함된다.
- CSAT 4.31/5는 기준 4.18/5보다 높지만, 출시 게이트가 요구하는 통계적 비열등성 판정·마진·검정 결과는 문서에 없다. 따라서 CSAT 게이트 통과는 미확인이다.
  - support: KPI 값과 출시 게이트 문구를 대조한 결과다.
  - evidence: read 성공: evidence/01-pilot-metrics.md. 2026-06-01~06-28 4주, 1,200건, 상담원 32명, KPI 표, 품질 사건, 보조 모드 및 자동 발송 미시험이 포함돼 있다.
  - evidence: read 성공: evidence/04-finance-and-launch-gates.md. 단위 비용, 예산, 8주 일정, 필수 출시 게이트, 5% canary와 rollback 경로가 포함돼 있다.
- 01-pilot-metrics.md는 중대한 환각 11건(0.92%), 환불 자격 오안내 4건, 다른 티켓의 고객 PII 노출 3건(0.25%)을 기록하며, 일본어 티켓은 42건으로 일반화 근거가 부족하다고 명시한다. 파일럿은 상담원 검토 보조 모드였고 자동 발송은 시험하지 않았다.
  - support: 01의 품질 사건 및 운영 방식 본문과 환각·PII·자동 발송 검색 결과에 직접 근거한다.
  - evidence: search 성공: evidence/01-pilot-metrics.md. KPI→5행, 최초 응답시간→7행, 해결시간 중앙값→8행, CSAT→9행, 에스컬레이션 비율→10행, 환각→14행, PII→16행, 자동 발송→19행. 각 결과는 line·column·preview를 반환했다.
  - evidence: read 성공: evidence/01-pilot-metrics.md, bytesRead=965. 본문에는 파일럿 기간·표본, KPI 표(7~10행), 품질 사건(14~17행), 보조 모드 및 자동 발송 미시험(19행)이 있다.

## Requirement coverage

- R1: evidence/의 실제 목록과 네 문서의 파일명을 확인하고 보고서 근거로 표시한다.
  - 요구된 산출물은 파일명 기반 추적성이 있는 한국어 경영진 보고서이며 Work Order의 첫 deliverable 문구를 그대로 보존했다.; 네 파일 모두 본문 read에 성공했다: 01은 965 bytes, 02는 1,091 bytes, 03은 810 bytes, 04는 1,148 bytes다.; evidence/ 검색 결과의 fileInventoryComplete가 true이고 filesSearched가 4이며, 다음 네 파일만 반환됐다: 01-pilot-metrics.md, 02-security-review.md, 03-customer-feedback.md, 04-finance-and-launch-gates.md.
- R2: 전면 출시·제한 출시·보류 중 정확히 하나를 명확히 결정한다.
  - 현재 안전한 결정은 전면 출시 보류이며, 이는 보안 문서의 직접 차단 결론과 관측된 게이트 위반·미검증 상태를 종합한 inference다.; EU 요구 고객 2곳은 서울 리전만 사용해 EU 레지던시가 미검증이며, 파일럿 대표성과 CSAT 비열등성 검정도 확인되지 않았다.; 문서가 부여한 보안 심각도는 교차 테넌트 캐시 키 결함 Critical, 프롬프트 인젝션 내부 메모 노출 High, 데이터 보존기간 불일치 High, 감사 로그 불완전 Medium이다.; 추가 위험평가상 환각·환불 오안내와 PII 노출은 전면 출시 게이트를 직접 위반하는 고위험 품질·개인정보 위험이다. 파일럿에서 중대한 환각은 11건(0.92%), 환불 자격 오안내는 4건, 다른 티켓의 PII 노출은 3건(0.25%)이었다.; 현재 전면 출시 필수 기준은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, 기존 CSAT 4.18 대비 비열등, EU 레지던시 검증이다.; 주요 위험은 Critical 교차 테넌트 캐시 결함, High 내부 메모 노출과 보존기간 불일치, 감사 로그 불완전, 중대한 환각 0.92%, PII 노출 0.25%이며, 필수 출시 게이트 일부와 관측값이 불일치한다.
- R3: 핵심 KPI의 기준값·파일럿값·변화량과 정의·단위·기간·표본을 표로 제시한다.
  - 파일럿 조건은 2026-06-01~2026-06-28 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여이며, 최초 응답시간은 18.0분에서 10.2분으로 7.8분 감소, 해결시간은 9.6시간에서 8.1시간으로 1.5시간 감소, CSAT는 4.18/5에서 4.31/5로 0.13 상승, 에스컬레이션 비율은 14.2%에서 12.8%로 1.4%p 감소했다.; 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았으므로, 파일럿 KPI와 78.4% 절감률을 전면 자동화 성능으로 일반화할 수 없다.; 자동 발송 성능은 비교할 수 없다. 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았다. 따라서 보조 모드의 절감률이나 KPI를 전면 자동화에 적용할 수 없다.; KPI 변화량은 최초 응답시간 중앙값 18.0분→10.2분, -7.8분(-43.3%); 해결시간 중앙값 9.6시간→8.1시간, -1.5시간(-15.6%); CSAT 4.18/5→4.31/5, +0.13/5; 에스컬레이션 비율 14.2%→12.8%, -1.4%p다.; 문서가 제시한 동일 파일럿 범위는 2026-06-01~2026-06-28 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여다. 이 범위에서 기존 프로세스와 HelioDesk 상담원 보조값을 비교했다.; CSAT 4.31/5는 기준 4.18/5보다 높지만, 출시 게이트가 요구하는 통계적 비열등성 판정·마진·검정 결과는 문서에 없다. 따라서 CSAT 게이트 통과는 미확인이다.
- R4: 보안·개인정보·품질 위험을 심각도, 출시 차단 기준, 완화·격리·롤백 조건과 함께 제시한다.
  - 현재 안전한 결정은 전면 출시 보류이며, 이는 보안 문서의 직접 차단 결론과 관측된 게이트 위반·미검증 상태를 종합한 inference다.; EU 요구 고객 2곳은 서울 리전만 사용해 EU 레지던시가 미검증이며, 파일럿 대표성과 CSAT 비열등성 검정도 확인되지 않았다.; 추가 위험평가상 환각·환불 오안내와 PII 노출은 전면 출시 게이트를 직접 위반하는 고위험 품질·개인정보 위험이다. 파일럿에서 중대한 환각은 11건(0.92%), 환불 자격 오안내는 4건, 다른 티켓의 PII 노출은 3건(0.25%)이었다.; 현재 전면 출시 필수 기준은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, 기존 CSAT 4.18 대비 비열등, EU 레지던시 검증이다.; 주요 위험은 Critical 교차 테넌트 캐시 결함, High 내부 메모 노출과 보존기간 불일치, 감사 로그 불완전, 중대한 환각 0.92%, PII 노출 0.25%이며, 필수 출시 게이트 일부와 관측값이 불일치한다.
- R5: 문서에 근거한 비용·예산·일정을 반영한 30/60/90일 실행안을 제시한다.
  - 04의 필수 게이트는 교차 테넌트 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 비열등, EU 레지던시 검증이다. 현재 문서상 여러 게이트의 요구 조건과 관측값이 불일치하거나 검증되지 않았다.; 비용 근거는 티켓당 기존 USD 8.20, 추론비 USD 0.42, 필수 상담원 검토비 USD 1.35, 합산 USD 1.77이며, 78.4% 절감률은 상담원 검토를 유지하는 보조 모드 기준이다.; 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았으므로, 파일럿 KPI와 78.4% 절감률을 전면 자동화 성능으로 일반화할 수 없다.; 자동 발송 성능은 비교할 수 없다. 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았다. 따라서 보조 모드의 절감률이나 KPI를 전면 자동화에 적용할 수 없다.; 주요 출시 위험은 Critical 교차 테넌트 캐시 결함(50회 중 2회 타 테넌트 요약 반환), High 내부 메모 노출(100건 중 3건), 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%)이다.; 현재 문서 기준 안전한 의사결정은 전면 출시 보류다. 보안 문서가 전면 출시 차단을 명시하고, 독립 재시험과 모든 출시 게이트 통과 전에는 5% canary조차 시작하지 않도록 권고한다.; 비용 근거는 기존 티켓당 USD 8.20, 추론비 USD 0.42, 필수 상담원 검토비 USD 1.35, 합산 USD 1.77이며, 승인된 2026년 하반기 총 프로그램 예산은 USD 120,000, 수정 예상비는 USD 46,000, 수정·재검증 예상 기간은 8주다.; 승인된 2026년 하반기 총 프로그램 예산은 USD 120,000, 보안·개인정보 수정 예상비는 USD 46,000, 수정 및 재검증 예상 기간은 8주다. 단순 차액은 USD 74,000이나 기타 비용·잔여 집행계획은 확인되지 않았다.
- R6: 상충·불완전·검증되지 않은 정보와 결론 영향도를 별도 불확실성으로 분리한다.
  - 파일럿 대표성 공백은 국내 SMB, 4주, 티켓 1,200건, 상담원 32명, 일본어 티켓 42건, 고객사 5곳이며, 피드백은 통계적 대표성을 보장하지 않는다. EU 요구 고객 2곳은 서울 리전만 사용해 레지던시가 검증되지 않았다.; 01-pilot-metrics.md의 주제 검색은 KPI(5행), 환각(14행), 자동 발송(19행), 해결시간(8행), CSAT(9행), 에스컬레이션 비율(10행), PII(16행)에서 매칭됐다.; 선행 산출물은 evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md 네 문서의 실제 read와 inventory/search 성공을 기록한다.; 03-customer-feedback.md의 EU 검색은 5~6행, 대표성 검색은 10행에서 매칭됐다.; 파일럿 조건은 2026-06-01~2026-06-28 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여이며, 최초 응답시간은 18.0분에서 10.2분으로 7.8분 감소, 해결시간은 9.6시간에서 8.1시간으로 1.5시간 감소, CSAT는 4.18/5에서 4.31/5로 0.13 상승, 에스컬레이션 비율은 14.2%에서 12.8%로 1.4%p 감소했다.; 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았으므로, 파일럿 KPI와 78.4% 절감률을 전면 자동화 성능으로 일반화할 수 없다.; 자동 발송 성능은 비교할 수 없다. 파일럿은 상담원 검토를 항상 거치는 보조 모드였고 자동 발송은 시험하지 않았다. 따라서 보조 모드의 절감률이나 KPI를 전면 자동화에 적용할 수 없다.; 이번 재검증에서 evidence/ 디렉터리의 네 문서를 실제 inventory 및 read로 확인했다.; KPI 변화량은 최초 응답시간 중앙값 18.0분→10.2분, -7.8분(-43.3%); 해결시간 중앙값 9.6시간→8.1시간, -1.5시간(-15.6%); CSAT 4.18/5→4.31/5, +0.13/5; 에스컬레이션 비율 14.2%→12.8%, -1.4%p다.; 비용 근거는 기존 티켓당 USD 8.20, 추론비 USD 0.42, 필수 상담원 검토비 USD 1.35, 합산 USD 1.77이며, 승인된 2026년 하반기 총 프로그램 예산은 USD 120,000, 수정 예상비는 USD 46,000, 수정·재검증 예상 기간은 8주다.; 02-security-review.md의 주제 검색은 Critical(7행), 내부 메모(12~13행), prompt hash(21행), 전면 출시 차단(24행), 90일(17행)에서 매칭됐다. PII query는 매칭 0건이었다.; evidence/에는 01-pilot-metrics.md, 02-security-review.md, 03-customer-feedback.md, 04-finance-and-launch-gates.md 네 파일이 있으며 네 파일 모두 read에 성공했다.; 네 파일 모두 본문 read에 성공했다: 01은 965 bytes, 02는 1,091 bytes, 03은 810 bytes, 04는 1,148 bytes다.; 문서가 부여한 보안 심각도는 교차 테넌트 캐시 키 결함 Critical, 프롬프트 인젝션 내부 메모 노출 High, 데이터 보존기간 불일치 High, 감사 로그 불완전 Medium이다.; 문서가 제시한 동일 파일럿 범위는 2026-06-01~2026-06-28 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여다. 이 범위에서 기존 프로세스와 HelioDesk 상담원 보조값을 비교했다.; 04-finance-and-launch-gates.md의 주제 검색은 USD(5~8행, 15~16행), 8주(17행), 전면 출시(19행), 99.9%(24행), 비열등(25행), rollback(28행)에서 매칭됐다.
- R7: 외부 자료나 존재하지 않는 출처를 사용하지 않는다.
  - 04의 필수 게이트는 교차 테넌트 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 비열등, EU 레지던시 검증이다. 현재 문서상 여러 게이트의 요구 조건과 관측값이 불일치하거나 검증되지 않았다.; 현재 안전한 결정은 전면 출시 보류이며, 이는 보안 문서의 직접 차단 결론과 관측된 게이트 위반·미검증 상태를 종합한 inference다.; 비용 근거는 티켓당 기존 USD 8.20, 추론비 USD 0.42, 필수 상담원 검토비 USD 1.35, 합산 USD 1.77이며, 78.4% 절감률은 상담원 검토를 유지하는 보조 모드 기준이다.; 파일럿 대표성 공백은 국내 SMB, 4주, 티켓 1,200건, 상담원 32명, 일본어 티켓 42건, 고객사 5곳이며, 피드백은 통계적 대표성을 보장하지 않는다. EU 요구 고객 2곳은 서울 리전만 사용해 레지던시가 검증되지 않았다.; 04-finance-and-launch-gates.md는 기존 처리비 USD 8.20, 추론비 USD 0.42, 검토비 USD 1.35, 합산 USD 1.77, 보조 모드 기준 절감률 78.4%, 총 예산 USD 120,000, 수정 예상비 USD 46,000, 수정·재검증 기간 8주를 제시한다.; 03-customer-feedback.md는 상담원 32명 중 24명이 작성시간 감소를 보고했고, 고객사 5곳 중 2곳이 EU 데이터 레지던시를 요구하지만 서울 리전만 사용해 검증되지 않았으며, 피드백은 통계적 대표성을 보장하지 않는다고 명시한다.; 보류 결론은 문서의 직접 보안 차단 결론과 현재 관찰된 게이트 위반·미검증 상태를 종합한 inference다. 수정 후 독립 재시험의 성공을 주장하지 않는다.; 주요 출시 위험은 Critical 교차 테넌트 캐시 결함(50회 중 2회 타 테넌트 요약 반환), High 내부 메모 노출(100건 중 3건), 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락, 중대한 환각 11건(0.92%), PII 노출 3건(0.25%)이다.; EU 요구 고객 2곳은 서울 리전만 사용해 EU 레지던시가 미검증이며, 파일럿 대표성과 CSAT 비열등성 검정도 확인되지 않았다.; 현재 문서 기준 안전한 의사결정은 전면 출시 보류다. 보안 문서가 전면 출시 차단을 명시하고, 독립 재시험과 모든 출시 게이트 통과 전에는 5% canary조차 시작하지 않도록 권고한다.; 02-security-review.md는 Critical 교차 테넌트 캐시 키 결함, 50회 중 2회 다른 테넌트 요약 반환, 100건 중 3건 내부 메모 노출, 원문 로그 90일 대 승인 상한 30일, prompt hash 17% 누락을 기록하고 24행에서 전면 출시 차단과 독립 재시험 필요성을 명시한다.; 승인된 2026년 하반기 총 프로그램 예산은 USD 120,000, 보안·개인정보 수정 예상비는 USD 46,000, 수정 및 재검증 예상 기간은 8주다. 단순 차액은 USD 74,000이나 기타 비용·잔여 집행계획은 확인되지 않았다.; 04의 전면 출시 게이트는 교차 테넌트 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, CSAT 비열등, EU 레지던시 검증 완료다. 권고 경로는 내부 shadow 평가 후 필수 상담원 검토 5% canary이며, 위반 시 수동 프로세스로 rollback한다.; 현재 제공 문서만 기준으로 한 안전한 결론은 전면 출시 보류다. 이는 02가 직접 명시한 전면 출시 차단과 04의 미충족 여부를 확인해야 하는 게이트에 근거한 증거 기반 판단이다.; 01-pilot-metrics.md의 KPI 표는 최초 응답시간 18.0분→10.2분(-43.3%), 해결시간 9.6시간→8.1시간(-15.6%), CSAT 4.18/5→4.31/5(+0.13), 에스컬레이션 14.2%→12.8%(-1.4%p)를 기록한다.; 주요 위험은 Critical 교차 테넌트 캐시 결함, High 내부 메모 노출과 보존기간 불일치, 감사 로그 불완전, 중대한 환각 0.92%, PII 노출 0.25%이며, 필수 출시 게이트 일부와 관측값이 불일치한다.; CSAT 4.31/5는 기준 4.18/5보다 높지만, 출시 게이트가 요구하는 통계적 비열등성 판정·마진·검정 결과는 문서에 없다. 따라서 CSAT 게이트 통과는 미확인이다.; 01-pilot-metrics.md는 중대한 환각 11건(0.92%), 환불 자격 오안내 4건, 다른 티켓의 고객 PII 노출 3건(0.25%)을 기록하며, 일본어 티켓은 42건으로 일반화 근거가 부족하다고 명시한다. 파일럿은 상담원 검토 보조 모드였고 자동 발송은 시험하지 않았다.
- R8: 읽기 전용 증거에 기반해 경영진이 즉시 판단할 수 있는 구체적 보고서를 제시한다.
  - 보류 결론은 문서의 직접 보안 차단 결론과 현재 관찰된 게이트 위반·미검증 상태를 종합한 inference다. 수정 후 독립 재시험의 성공을 주장하지 않는다.; R1~R8 각각에 대해 근거 파일 또는 미충족·미검증 사유를 보고서 추적표에 연결했다.; 추가 위험평가상 환각·환불 오안내와 PII 노출은 전면 출시 게이트를 직접 위반하는 고위험 품질·개인정보 위험이다. 파일럿에서 중대한 환각은 11건(0.92%), 환불 자격 오안내는 4건, 다른 티켓의 PII 노출은 3건(0.25%)이었다.; 현재 전면 출시 필수 기준은 Critical 0건, PII 누출률 0%, 중대한 환각률 0.10% 미만, prompt hash 완전성 99.9% 이상, 기존 CSAT 4.18 대비 비열등, EU 레지던시 검증이다.

## 요구사항 커버리지

- [x] R1: Verified by 3 immutable claim(s) and 7 linked evidence item(s).
- [x] R2: Verified by 6 immutable claim(s) and 7 linked evidence item(s).
- [x] R3: Verified by 6 immutable claim(s) and 6 linked evidence item(s).
- [x] R4: Verified by 5 immutable claim(s) and 6 linked evidence item(s).
- [x] R5: Verified by 8 immutable claim(s) and 12 linked evidence item(s).
- [x] R6: Verified by 16 immutable claim(s) and 25 linked evidence item(s).
- [x] R7: Verified by 18 immutable claim(s) and 25 linked evidence item(s).
- [x] R8: Verified by 4 immutable claim(s) and 4 linked evidence item(s).

## 주의점

- 02-security-review.md에서 PII라는 문자열은 검색되지 않았지만, PII 관련 직접 사건은 01의 16행과 04의 20행에 존재한다.
- 검색은 지정된 주제어에 대한 targeted search이며, 문서 내용의 의미적 완전성을 보장하는 일반 자연어 검색은 아니다.
- 문서의 보안 테스트 범위가 전체 공격면을 대표하는지와 잔여 취약점이 없는지는 확인되지 않았다.
- 수정 후 독립 재시험, 보안·개인정보 통제의 실제 유효성, 자동 발송 성능은 확인되지 않았다.
- 수정 후 독립 재시험과 개인정보 통제의 실제 유효성 검증 결과가 없다.
- 예산 세부 배분, 운영·재시험·canary 비용, 정확한 일정과 담당자는 확인되지 않았다.
- 예산 USD 120,000과 수정비 USD 46,000 외의 운영·재시험·canary 비용 및 실제 잔여 예산 집행계획은 미확인이다.
- 이 통합 응답에서는 직접 read/search를 수행하지 않았고, 실제 read/search 수행 사실은 수락된 K2·K3 선행 산출물에 기록된 내용을 근거로 한다.
- 이번 시도는 inventory와 전체 read만 수행했으며 별도 topic regex search는 수행하지 않아 검색 완전성을 주장하지 않는다.
- 자동 발송 성능은 파일럿에서 시험되지 않았고, 보조 모드 KPI를 자동화 성능으로 일반화할 수 없다.
- 자동 발송은 시험되지 않았으므로 전면 자동화의 품질·비용·안전성은 미확인이다.
- 전면 출시 보류는 문서의 직접 결론과 게이트를 종합한 inference이며, 새로운 외부 검증 결과가 아니다.
- 정확한 30/60/90일 일정은 문서에 없고, 확인 가능한 일정은 수정·재검증 예상 8주뿐이다.
- 파일럿 결과의 인과성·통계적 대표성 및 다른 고객군·언어·기간으로의 일반화 가능성은 확인되지 않았다.
- 파일럿 문서는 동일 기간·표본·상담원 조건을 제시하지만, 인과효과·통계적 유의성·CSAT 비열등성 검정의 세부 방법은 제공하지 않는다.
- 파일럿은 상담원 검토 보조 모드였고 자동 발송을 시험하지 않았으므로 전면 자동화 성능은 추론할 수 없다.
- 피드백은 방향성 증거이며 통계적 대표성을 보장하지 않는다.
- CSAT 비열등성 검정 방법·마진·통계 결과가 제공되지 않았다.
- EU 데이터 레지던시 검증, 독립 보안 재시험, 실제 출시 게이트 통과 여부는 제공 문서만으로 확인되지 않는다.
- EU 데이터 레지던시 검증, 보안 수정 완료, 독립 재시험 결과, 실제 출시 게이트 통과 여부는 확인되지 않았다.
- EU 레지던시, 다국어·고객군·기간 대표성, 통계적 유의성은 확인되지 않았다.
- Final critic: 최종 보고서에서 tenant_id 캐시 키 변경, DLP, flush 수정, 개별 rollback 트리거 등은 문서 사실이 아니라 제안 조치임을 명시해야 한다.
- Final critic: Failed criterion: decision-safety — 현재 보류 결론은 안전하지만, 일부 제안 통제와 rollback 조건이 문서 직접 사실처럼 읽힐 수 있고 KPI 표의 1,200건이 모든 지표의 유효 분모인 것처럼 보일 위험이 있다.
- Final critic: Failed criterion: test-or-verification — 문서 대조와 산술 검증은 수행됐지만 독립 보안 재시험, 자동 발송 시험, 수정 통제 효과, 실제 gate 통과는 검증되지 않았다. 이 제한은 보고서에 유지되어야 한다.
- Final critic: KPI별 유효 분모가 문서에 없으면 1,200건은 전체 파일럿 범위로 표시하고, 지표별 표본·응답 수는 미확인으로 구분해야 한다.
- Final critic: read/search 수행 주체와 시점을 ‘호스트 검증된 선행 receipt에 근거’로 통일해야 하며, 현재 재검증자가 직접 도구를 실행했다는 표현은 피해야 한다.
- G0·G2·G3의 정식 pass/fail 정의가 제공되지 않아 형식적 gate 판정은 수행하지 않았다.
- G0·G2·G3의 정식 pass/fail 정의와 세부 비용·인력 배분은 제공되지 않았다.
- G0·G2·G3의 형식적 pass/fail 정의가 Work Order에 없어 해당 gate의 독립 판정은 수행하지 않았다.

## 다음 행동

- 30/60/90일 실행안 — 30일: 자동 발송을 금지하고 내부 shadow를 유지하면서 캐시 키, DLP·콘텐츠 격리, 보존기간, 감사 flush를 수정하고 환각·PII 회귀 테스트를 준비한다. 60일: 문서상 수정·재검증 예상 8주에 맞춰 독립 재시험과 표본·고객군·언어 범위 확장 평가를 수행하고, 모든 게이트 통과 시에만 5% canary를 시작한다. 90일: canary의 게이트 위반·rollback 발생 여부와 CSAT·품질·보안 지표를 검토해 전면·제한·보류를 재결정한다. 재무 근거는 총 예산 USD 120,000, 보안·개인정보 수정 예상비 USD 46,000이며 세부 비용 배분은 미제공이다.
- 경영진 보고서

결정: 보류

HelioDesk AI 고객지원 코파일럿은 현재 전면 출시를 보류한다. evidence/02-security-review.md가 전면 출시 차단을 명시하고 있으며, 교차 테넌트 결함, PII·환각 기준 초과, 데이터 보존기간 불일치, 감사 로그 불완전, EU 레지던시 및 CSAT 비열등성 미검증이 남아 있다. 현재 허용 범위는 고객 대면 자동 발송이 아닌 내부 shadow와 상담원 검토 중심의 평가다. 5% canary도 모든 필수 게이트 통과와 즉시 수동 rollback 준비 후에만 조건부 검토한다.

KPI 표

근거 파일: evidence/01-pilot-metrics.md. 기간은 2026-06-01~2026-06-28, 4주이며 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여 조건이다.

| KPI 정의 | 단위 | 기준값 | 파일럿값 | 변화량 | 기간·표본 | 판정 |
|---|---|---:|---:|---:|---|---|
| 최초 응답시간 중앙값 | 분 | 18.0 | 10.2 | -7.8분, -43.3% | 4주·1,200건 | 조건상 비교 가능 |
| 해결시간 중앙값 | 시간 | 9.6 | 8.1 | -1.5시간, -15.6% | 4주·1,200건 | 조건상 비교 가능 |
| CSAT | 5점 만점 | 4.18 | 4.31 | +0.13/5 | 4주·1,200건 | 비열등성 검정 미확인 |
| 에스컬레이션 비율 | % | 14.2% | 12.8% | -1.4%p | 4주·1,200건 | 조건상 비교 가능 |

위 결과는 상담원 검토가 수행된 보조 모드 결과다. 자동 발송은 시험되지 않았으므로 전면 자동화 성능·비용·안전성으로 해석하지 않는다.

위험 및 go/no-go 게이트

| 위험 | 심각도 | 관측값 | 기준 | 격리·완화 | rollback 조건 |
|---|---|---|---|---|---|
| 교차 테넌트 캐시 결함 | Critical | 50회 중 2회 타 테넌트 요약 반환 | 독립 재시험 0건 | tenant 식별자를 포함한 캐시 키, 캐시 응답 중지, 회귀 테스트 | 1건 이상 재현 시 수동 복귀 |
| 내부 메모 노출 | High | 100건 중 3건 | 노출 0건 | 외부 콘텐츠 격리, 출력 DLP, 상담원 검토, 자동 발송 차단 | 단일 재노출 시 경로 격리 및 수동 복귀 |
| 데이터 보존기간 불일치 | High | 실제 90일, 승인 상한 30일 | 실제·승인 기준 일치 | 보존정책 수정·삭제 검증 | 상한 위반 재확인 시 수동 처리 |
| 중대한 환각·환불 오안내 | 고위험 품질 | 환각 11건(0.92%), 환불 오안내 4건 | 환각률 0.10% 미만 및 재발 없음 | 정책 근거 연결, 불확실성 표시, 필수 검토 | 기준 초과 또는 오안내 1건 이상 시 자동 응답 중지 |
| PII 노출 | 고위험 개인정보 | 3건(0.25%) | 누출률 0% | 출력 DLP, 테넌트 격리, 필수 검토 | PII 1건 이상이면 즉시 수동 복귀 |
| prompt hash 불완전 | Medium 및 추적성 차단 | 17% 누락 | 완전성 99.9% 이상 | flush 수정, 재처리, 회귀 테스트 | 99.9% 미만이면 rollback |
| EU 데이터 레지던시 | 미검증 고위험 | EU 요구 고객 2곳, 서울 리전만 사용 | 레지던시 검증 완료 | 검증 전 해당 고객 제외 | 미검증 상태에서 EU 고객 출시 금지 |

전면 출시 go/no-go: Critical 0건, PII 0%, 중대한 환각률 0.10% 미만, prompt hash 99.9% 이상, CSAT 비열등성, EU 레지던시 검증을 독립적으로 확인하기 전에는 No-Go다. 현재는 여러 기준이 불일치하거나 미검증이므로 보류한다.

제한 출시 판단: 현재 고객 대면 제한 출시는 승인하지 않는다. 내부 shadow만 허용한다. 필수 게이트 통과 후에만 필수 상담원 검토를 포함한 5% canary를 조건부 검토하며, 게이트 위반 시 이전 수동 프로세스로 rollback한다.

비용·예산·일정

근거 파일: evidence/04-finance-and-launch-gates.md.

| 항목 | 확인값 | 제한 |
|---|---:|---|
| 기존 상담 처리비 | 티켓당 USD 8.20 | 문서 기재값 |
| 추론비 | 티켓당 USD 0.42 | 보조 모드 기준 |
| 필수 상담원 검토비 | 티켓당 USD 1.35 | 보조 모드 기준 |
| 합산 예상 처리비 | 티켓당 USD 1.77 | 보조 모드 기준 |
| 단순 절감률 | 78.4% | 전면 자동화에 적용 불가 |
| 승인 총 프로그램 예산 | 2026년 하반기 USD 120,000 | 문서 기재값 |
| 보안·개인정보 수정 예상비 | USD 46,000 | 세부 배분 미제공 |
| 단순 잔여 차액 | USD 74,000 | 기타 비용·집행계획 미확인 |
| 수정·재검증 예상 기간 | 8주 | 정확한 시작·종료일 미확인 |

30/60/90일 실행안은 문서의 확정 일정이 아니라, 문서상 8주 수정·재검증 순서에 기반한 조건부 실행안이다.

- 0~30일: 자동 발송을 금지하고 내부 shadow를 유지한다. 캐시 키, DLP·콘텐츠 격리, 보존기간, 감사 flush를 수정하고 환각·PII 회귀시험을 준비한다. 수정 예상비는 USD 46,000이나 세부 배분은 미확인이다.
- 31~60일: 독립 재시험과 표본·고객군·언어 범위 확장 평가를 수행하고 CSAT 비열등성을 검정한다. 모든 게이트 통과 전에는 canary를 시작하지 않는다.
- 61~90일: 조건부 canary의 게이트 위반·rollback 여부와 CSAT·품질·보안 지표를 검토해 전면·제한·보류를 재결정한다. 하나라도 미충족·미검증이면 보류를 유지한다. 실제 담당자·정확한 일정·운영비는 문서에 없다.

불확실성 및 결론 영향

- 자동 발송이 시험되지 않았다. 영향도: 높음. 보조 모드 KPI·비용을 전면 자동화로 일반화할 수 없다.
- 수정된 통제의 실제 유효성과 독립 재시험 결과가 없다. 영향도: 매우 높음.
- 보안 시험 범위가 전체 공격면을 대표하는지와 잔여 취약점의 완전성은 확인되지 않았다. 영향도: 높음.
- EU 레지던시와 CSAT 비열등성 검정이 미검증이다. 영향도: 높음.
- 파일럿은 국내 SMB·4주·1,200건·상담원 32명으로 일반화가 제한된다. 영향도: 중간~높음.
- 예산 세부 배분, 운영·재시험·canary 비용, 정확한 일정과 담당자는 확인되지 않았다. 영향도: 중간.
- G0·G2·G3의 정식 pass/fail 정의가 없어 형식적 gate 통과는 주장하지 않는다.

요구사항 추적

| 요구사항 | 상태 | 근거 또는 미충족 사유 |
|---|---|---|
| R1 | 충족 | 본 한국어 경영진 보고서와 파일명 기반 산출물 제공 |
| R2 | 충족 | 위험별 심각도와 go/no-go·격리·rollback 조건 제공; evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md |
| R3 | 충족 | 기준값·파일럿값·변화량·정의·단위·기간·표본 제공; evidence/01-pilot-metrics.md |
| R4 | 충족 | 보안·개인정보·품질 위험 및 출시 게이트 제공; evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/04-finance-and-launch-gates.md |
| R5 | 충족 | 비용·예산·8주 일정 및 조건부 30/60/90일 실행안 제공 |
| R6 | 충족 | 네 문서의 선행 read/search 기록과 파일명 연결 제공 |
| R7 | 충족 | 상충·불완전·미검증 정보와 결론 영향도를 별도 절로 분리 |
| R8 | 충족 | 요구사항별 근거 파일 또는 미충족 사유를 추적표에 연결 |
- 누락·해석 불가 항목은 독립 보안 재시험 결과, 자동 발송 성능, EU 데이터 레지던시 검증 결과, 실제 전면 출시 게이트 통과 여부다.
- 문서별 read는 네 파일 모두 성공했고, 문서별 주제 search는 파일명·검색어·매칭 행·preview와 함께 기록됐다.
- 불확실성 목록 — 보안 테스트는 문서에 기록된 합성 재현 50회, 공격 시나리오 100건, 파일럿 로그 분석 범위에 한정되며 전체 공격면·테스트 커버리지·잔여 취약점의 완전성은 확인되지 않았다. 수정된 통제의 실제 유효성, 독립 재시험 결과, 자동 발송 성능, PII 통제 효과, EU 레지던시 준수는 확인되지 않았다. 파일럿은 국내 SMB·4주·상담원 검토 보조 모드이고 자동 발송은 시험하지 않았으며, 일본어 42건과 고객사 5곳으로 일반화가 제한된다. G0·G2·G3의 형식적 pass/fail 정의는 Work Order에 없다. 이번 재검증에서는 inventory와 전체 파일 read는 수행했지만 별도 topic regex search는 수행하지 않았으므로 의미적 검색 완전성은 주장하지 않는다.
- 비교 불가·충돌 목록 — (1) 보조 모드 KPI·78.4% 절감률과 전면 자동화 성능은 비교 불가: 자동 발송 미시험. (2) 중대한 환각 0.92%는 게이트 0.10% 미만과 불일치. (3) PII 노출 0.25%는 게이트 0%와 불일치. (4) 교차 테넌트 오류 2/50은 게이트 0건과 불일치. (5) prompt hash 17% 누락은 게이트 99.9% 이상과 불일치. (6) EU 요구 고객 5곳 중 2곳이 있으나 서울 리전만 사용해 EU 레지던시는 미검증. (7) 상담원 32명 중 24명의 시간 감소 응답은 방향성 증거이며 통계적 대표성은 문서상 보장되지 않음. (8) CSAT 4.31/5는 기준보다 높지만 비열등성 검정 결과가 없어 게이트 통과 미확인. 근거: evidence/01-pilot-metrics.md, evidence/02-security-review.md, evidence/03-customer-feedback.md, evidence/04-finance-and-launch-gates.md.
- 비용·예산·일정 근거표 — 근거: evidence/04-finance-and-launch-gates.md, 5~17행. | 항목 | 확인값 | 해석/제한 |
|---|---:|---|
| 기존 상담 처리비 | 티켓당 USD 8.20 | 문서 기재값 |
| 추론비 | 티켓당 USD 0.42 | 보조 모드 비용 |
| 필수 상담원 검토비 | 티켓당 USD 1.35 | 보조 모드 필수 비용 |
| 합산 예상 처리비 | 티켓당 USD 1.77 | 보조 모드 기준 |
| 단순 절감률 | 78.4% | 전면 자동화에 적용 불가 |
| 승인 총 프로그램 예산 | 2026년 하반기 USD 120,000 | 문서 기재값 |
| 보안·개인정보 수정 예상비 | USD 46,000 | 단순 잔여 차액 USD 74,000; 기타 비용 미확인 |
| 수정·재검증 기간 | 8주 | 정확한 시작일·종료일 미확인 |
| 30/60/90일 계획 | 미확인 | 문서에는 8주와 shadow→게이트 통과→5% canary 순서만 있음 |
- 선택지별 결정 조건 — 전면 출시: 모든 필수 게이트 통과, 독립 재시험 완료, 대표성 공백을 보완한 shadow 평가, EU 요구 고객 레지던시 검증 완료. 제한 출시: 현재는 고객 대면 제한 출시를 승인하지 않고 내부 shadow만 허용한다. 5% canary는 모든 필수 게이트 통과 후 필수 상담원 검토·영향 tenant 격리·즉시 수동 rollback이 준비된 경우에만 허용한다. 보류: 현재 선택이며 Critical·PII·환각·보존·감사 로그·EU 레지던시 중 하나라도 미해결 또는 미검증이면 유지한다.
- 실제 evidence/ 목록, 문서 수·형식·파일명, 문서별 읽기·검색 결과, 핵심 근거 위치, 누락·해석 불가 항목을 포함한 증거 원장
- 실제 inventory 결과는 4개 파일, fileInventoryComplete=true, filesSearched=4이며 추가 파일은 반환되지 않았다.
- 심각도별 go/no-go 게이트 — Critical: 교차 테넌트 재현 0건과 PII 0%를 독립 재시험으로 확인하기 전 전면 출시 No-Go. High: 환각률 0.10% 미만, 환불 오안내 재발 없음, 보존기간 승인 기준 일치, 내부 메모 노출 0건을 확인하기 전 No-Go. 추적성: prompt hash 99.9% 이상을 확인하기 전 No-Go. EU: 레지던시 검증 전 EU 요구 고객은 제외한다. CSAT는 기존 4.18 대비 비열등이어야 한다. 모든 문서상 게이트 통과 후에만 필수 상담원 검토 5% canary를 허용하며, canary 중 게이트 위반 시 즉시 이전 수동 프로세스로 rollback한다.
- 위험 레지스터 — 문서 심각도와 추가 평가를 구분한다. 문서상 Critical: 교차 테넌트 캐시 키 결함(evidence/02-security-review.md), 50회 중 2회 다른 테넌트 요약 반환. 제안 차단 기준은 독립 재시험에서 0건, 완화는 캐시 무효화·tenant_id 포함 키 스키마 변경·회귀 테스트, 격리는 캐시 기반 응답과 영향을 받는 tenant 경로의 즉시 중지, rollback 트리거는 재현 1건 이상이며 절차는 이전 수동 프로세스로 즉시 복귀한다. 문서상 High: 프롬프트 인젝션 내부 메모 노출(evidence/02-security-review.md), 100건 중 3건. 제안 차단 기준은 내부 메모 노출 0건, 완화는 외부 콘텐츠 격리·출력 DLP·필수 상담원 검토, 격리는 공격 입력 경로와 자동 발송을 차단, rollback 트리거는 단일 재노출이며 수동 프로세스로 복귀한다. 문서상 High: 데이터 보존기간 불일치(evidence/02-security-review.md), 실제 90일 대 승인 상한 30일. 제안 차단 기준은 승인 기준과 실제 보존기간의 일치 확인, 완화는 보존정책 수정·삭제 검증·영향평가 재확인, 격리는 원문 로그 저장과 신규 고객 데이터 처리를 중지, rollback 트리거는 30일 상한 위반이 재확인되는 경우이며 복귀 절차는 승인된 수동 처리로 전환한다. 문서상 Medium: 감사 로그 불완전(evidence/02-security-review.md), prompt hash 17% 누락. 추가 평가상 고위험 추적성 차단 항목으로 관리하며, 기준은 99.9% 이상, 완화는 비동기 flush 수정과 재처리·회귀 테스트, 격리는 hash가 없는 호출의 자동화 사용을 금지, rollback 트리거는 99.9% 미만 또는 재현 불가능 호출 발생이며 수동 프로세스로 복귀한다. 추가 평가상 고위험 품질: 중대한 환각 11건(0.92%)과 환불 오안내 4건(evidence/01-pilot-metrics.md). 기준은 중대한 환각률 0.10% 미만, 완화는 정책 근거 링크·확실하지 않음 표시·필수 상담원 검토·재시험, 격리는 환불 관련 자동 발송과 해당 정책 범위를 차단, rollback 트리거는 0.10% 이상 또는 환불 오안내 1건 이상이며 수동 답변으로 복귀한다. 추가 평가상 고위험 개인정보: PII 노출 3건(0.25%)(evidence/01-pilot-metrics.md). 기준은 0%, 완화는 출력 DLP·테넌트 격리·필수 검토, 격리는 영향을 받은 데이터 유형·tenant·응답 경로, rollback 트리거는 PII 1건 이상이며 즉시 수동 프로세스로 복귀한다.
- 위험·게이트 요약 — Critical: 교차 테넌트 캐시 결함, 출시 차단. High: 내부 메모 노출, 보존기간 불일치, 환불 정책 오안내·환각 사건. Medium: 감사 로그 불완전. 출시 전 독립 재시험, 모든 게이트 통과, 필수 상담원 검토 5% canary, 위반 시 수동 프로세스 rollback이 문서상 안전 경로다.
- 파일명 근거가 연결된 위험 레지스터, 심각도별 go/no-go 게이트, 선택지별 결정 조건, 불확실성 목록
- 파일명 근거가 연결된 KPI 비교표, 비교 불가·충돌 목록, 비용·예산·일정 근거표
- 파일명 기반 추적성이 있는 한국어 경영진 보고서
- 핵심 근거 위치는 01의 KPI 7~10행·품질 14~19행, 02의 발견사항 7~23행·결론 24행, 03의 EU 5~6행·대표성 10행, 04의 재무 5~17행·게이트 19~28행이다.
- 핵심 KPI 표 — 최초 응답시간 중앙값: 기존 18.0분, HelioDesk 보조 10.2분, -43.3%; 해결시간 중앙값: 기존 9.6시간, 보조 8.1시간, -15.6%; CSAT: 기존 4.18/5, 보조 4.31/5, +0.13; 에스컬레이션 비율: 기존 14.2%, 보조 12.8%, -1.4%p. 근거는 evidence/01-pilot-metrics.md이며, 보조 모드 결과를 자동 발송 성능으로 해석하지 않는다.
- KPI 비교표 — 근거: evidence/01-pilot-metrics.md, 5~10행. 비교 조건: 2026-06-01~06-28, 4주, 국내 SMB 티켓 1,200건, 동일 상담원 32명 교차 참여. | KPI | 기준값 | 파일럿값 | 변화량 | 상태 |
|---|---:|---:|---:|---|
| 최초 응답시간 중앙값 | 18.0분 | 10.2분 | -7.8분, -43.3% | 조건상 비교 가능 |
| 해결시간 중앙값 | 9.6시간 | 8.1시간 | -1.5시간, -15.6% | 조건상 비교 가능 |
| CSAT | 4.18/5 | 4.31/5 | +0.13/5 | 비열등성 판정 미확인 |
| 에스컬레이션 비율 | 14.2% | 12.8% | -1.4%p | 조건상 비교 가능 |
