# GPT-5.6-Luna vs GPT-5.6-Sol 실제 실행 비교

동일한 로컬 증거와 실행 제한에서 HelioDesk AI 고객지원 코파일럿의 출시 결정을 작성하는 진단용 단일 paired benchmark입니다. 네트워크와 파일 쓰기는 금지하며, 두 모델 모두 같은 Luna Swarm 하네스·조직 규모·reasoning 설정을 사용합니다.

비교 지표:

- `final.md`의 고정 100점 근거 보존 점수
- 실행 상태와 validation 결과
- wall-clock 시간
- model calls, retries, rate-limit events
- App Server가 실제 제공한 input/cached/cache-write/output/reasoning/total tokens
- 토큰 영수증이 누락된 backend call 수

단일 실행이므로 모델 승격 근거가 아니라 실제 작동 진단과 대략적인 품질·효율 비교에 사용합니다.

## 2026-08-17 실제 계정 결과

두 실행 모두 완료됐습니다. 사전등록 scorer v1 기준 `gpt-5.6-luna`와 `gpt-5.6-sol`은 각각 95점으로 동점이었습니다. 결과 확인 뒤 한국어 숫자 순서를 보정한 v2 sensitivity는 Luna 100점, Sol 95점이지만 승자 판정에는 사용하지 않습니다. Luna는 1,840,095 tokens / 28:08.051 / 36 calls, Sol은 8,593,105 tokens / 45:00.533 / 56 calls를 사용했습니다. retry와 rate-limit event는 양쪽 모두 0이었고 모든 호출에서 App Server token usage가 계측됐습니다.

전체 비교와 생성물은 [results/comparison.md](results/comparison.md)에 있습니다. 이 결과는 단일 bounded local-evidence synthesis 진단이며 일반적인 모델 우열이나 자동 승격 근거가 아닙니다.

재현 시 두 모델에 각각 `config.luna.json`, `config.sol.json`을 사용하고 `mission.txt`의 바이트를 그대로 `--goal`에 전달합니다. workspace에는 `evidence/` 네 파일만 복사하고 별도의 `.luna-swarm` 상태 디렉터리를 사용해야 합니다. 실행 후 다음 명령으로 동일한 고정 채점을 수행합니다.

```bash
node benchmarks/2026-08-17-model-comparison/score-report.mjs <run-directory>/final.md 1
node benchmarks/2026-08-17-model-comparison/score-report.mjs <run-directory>/final.md 2
```

첫 명령이 사전등록 primary이고, 두 번째는 결과 확인 뒤 추가한 표현순서 sensitivity입니다.
