# GPT-5.6-Luna vs GPT-5.6-Sol coding diagnostic

동일한 Codex CLI wrapper, clean Git snapshot, prompt, reasoning effort, 실행 방식,
시간 제한과 사전 고정한 회귀 테스트에서 모델만 바꾸는 3-pair 코딩 진단입니다.

과제는 `CodexAppServerBackend`에서 `turn/start` 응답보다 먼저 도착한
`rawResponse/completed`가 다른 turn의 token usage를 오염시키는 실제 race를
수정하는 것입니다. 평가 테스트는 실행 전에 해시로 고정했고 원본 코드에서
실제로 실패함을 확인했습니다. 다만 아래 격리 한계 때문에 후보가 테스트를 볼 수
없었다고 보증할 수 없어 protected hidden suite라는 표현은 사용하지 않습니다.

이 비교는 underlying Luna/Sol 모델의 bounded coding 능력을 측정합니다. 현재
일반 Luna Swarm Work Order는 read-only이고 별도 `CodingPipeline`에 모델-backed
executor가 연결되지 않았으므로, 결과를 Luna Swarm 전체 코딩 성능이나 Evolution
승격 근거로 확대하지 않습니다.

## 고정 실행

```powershell
node benchmarks/2026-08-17-coding-comparison/run-candidate.mjs gpt-5.6-luna 1 v5
node benchmarks/2026-08-17-coding-comparison/score-candidate.mjs luna-r1-v5
```

실행 순서와 파일 해시는 [preregistration.v5.json](preregistration.v5.json)에 있습니다.
최초 사전등록과 모델 호출 전 Windows launcher 실패도 삭제하지 않고 함께 보존합니다.
첫 점수 생성 전에 발견된 Windows `npx` launcher 오류는 채점 기준을 바꾸지 않은
[preregistration.v5-score-hotfix.json](preregistration.v5-score-hotfix.json)으로 기록했습니다.
후보는 `src/backend/codex-app-server.ts`, `test/unit/app-server.test.ts`,
`test/fixtures/fake-codex.mjs`만 수정할 수 있습니다.

Primary gate는 사전 고정한 race 테스트, 기존 App Server focused suite, TypeScript
typecheck, 변경 scope입니다. 네 gate 중 하나라도 실패하면 속도나 토큰 효율을
비교하지 않습니다.

Windows Codex Desktop 0.146의 중첩 `workspace-write`가 실제 patch 도구에는
read-only로 전달되어 첫 Luna 시도는 인프라 실패로 제외했습니다. v5는 원격을
제거한 일회성 clone에서 Codex sandbox를 우회하고, 실행 뒤 전체 변경 경로를
검사합니다. 따라서 이 결과는 모델 수준 진단이며 production sandbox나
Evolution 승격 증거가 아닙니다. 실제 독립 감사에서 한 run이 workspace 밖 로컬
스크립트에 접근했으므로 host 격리 부재가 확인됐습니다. transcript에서 평가 파일
열람·웹 접근은 발견하지 못했지만, 비접근을 증명하지는 못합니다. 공개 테스트 변경
무결성과 blind 정성 점수도 없으므로 100점은 자동 gate 점수입니다. CLI가 제공하지
않는 `total_tokens`는 추정하지 않고 `null`로 기록합니다. 이 v5 runner는 재사용하지
말고 credential-free VM/container 또는 제한 계정의 protected runner를 준비한 뒤
새 protocol로 사전등록해야 합니다.
