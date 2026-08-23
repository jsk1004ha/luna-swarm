# Harness v3: 분산 역량 포트폴리오와 검증 가능한 협업

Harness v3는 한 에이전트의 prompt에 많은 skill을 밀어 넣는 방식 대신, task 전체에 필요한 역량을 작은 포트폴리오로 고정한 뒤 worker·manager·독립 validator가 서로 다른 skill을 소유하도록 배분합니다. 목표는 협업 관점의 다양성을 늘리면서 중복 instruction과 권위 혼선을 줄이는 것입니다.

## 구현된 경계

- task 포트폴리오는 기본 최대 8개, 설정 가능한 상한은 10개입니다.
- 한 에이전트가 받는 full skill body는 기본 2개, 검증 가능한 최대 4개입니다.
- 같은 skill body는 하나의 owner에게만 전달됩니다. 동료에게는 portfolio ID, owner, companion skill ID와 artifact handoff 책임만 전달됩니다.
- 포트폴리오와 skill content hash는 run state에 저장되어 retry와 resume에서 재선택되지 않습니다.
- worker, manager, validator는 각각 독립된 specialist와 skill 묶음을 받습니다. 보안 task에서는 실행자와 remediation verifier가 분리됩니다.
- 분배 전 각 참여자가 받을 관련 skill body와 실제 owner body의 차이는 `RunHarnessState.rawSkillInstructionCharsAvoided`에 렌더링 전 raw 문자 수로 누적됩니다. token 추정치로 사용하지 않습니다.
- Harness v3 handoff는 raw prompt·chat·chain-of-thought·credential을 허용하지 않고, kind·revision·SHA-256이 고정된 artifact reference만 소비합니다. 산출물 kind와 gate receipt artifact가 계약과 정확히 일치해야 handoff receipt가 만들어집니다.

설정 예시:

```json
{
  "maxSkillsPerCall": 3,
  "skillPortfolio": {
    "enabled": true,
    "maxUniquePerTask": 8,
    "maxPerAgent": 2,
    "maxInstructionCharsPerAgent": 4000
  }
}
```

`maxSkillsPerCall`은 legacy 및 task가 아닌 호출의 호환 상한입니다. task 호출에서는 더 좁은 `skillPortfolio.maxPerAgent`가 우선합니다.

## 반복 작업의 skill 후보화

반복 성공을 즉시 active skill로 승격하지 않습니다. `synthesizeWorkflowRecipeCandidate`는 다음 조건을 모두 만족할 때만 수동 승격 대상 후보를 만듭니다.

- accepted observation 3개 이상
- 서로 다른 mission 2개 이상
- 동일한 bounded opaque step ID, loop ID, stop-condition ID, recovery ID, gate ID 계약
- 모든 recipe·step·loop·stop·recovery·gate·capability ID가 host-owned registry의 정확한 종류로 등록됨
- 모든 source authority의 교집합 안에 있는 capability만 사용
- stale 또는 unknown artifact reference 없음

후보 상태는 항상 `candidate`, activation은 `manual-promotion-required`입니다. 보호 평가와 운영자 승격 없이 SkillCatalog에 자동 등록되지 않습니다.

## 모든 작업의 Blue/Red 적대적 보증 루프

`luna-harness-v3-adversarial`부터 보안 키워드가 없는 일반 작업도 다음 순서를 필수로 거칩니다.

1. Blue Team이 immutable artifact를 제출합니다.
2. 별도 `security-attack` 팀의 `V1` Red Team이 다섯 공격 축으로 artifact를 깨려고 시도합니다.
3. 하나라도 구체적 실패 조건을 재현하면 Red의 거부는 다수결로 덮을 수 없고 Blue 재작업으로 전환됩니다.
4. 새 artifact revision에는 같은 결과를 재사용하지 않고 fresh Red re-attack을 수행합니다.
5. host Judge가 Red report, G0/G2/G3, manager/quorum, Council을 함께 확인한 뒤에만 승인합니다.

Red는 기존 blind validator 한 자리를 대체하므로 정상 경로의 모델 호출 수를 늘리지 않습니다. Blue·Red·manager는 서로 다른 고정 agent slot과 thread를 사용하며, Red는 다른 심사표나 Blue의 내부 추론 대신 immutable artifact와 Work Order 범위만 받습니다. 모델은 계속 동일한 `gpt-luna` 계열 backend를 사용합니다.

Red 프롬프트는 불편함·평판·완곡함 때문에 공격 강도를 낮추지 말라고 명시합니다. 다만 도구 권위는 프롬프트가 아니라 host가 통제합니다. 대상·파일·network·side effect·호출 상한은 Work Order 밖으로 넓어지지 않으며, 관찰하지 않은 exploit이나 test 성공을 꾸며낼 수 없습니다.

보안 전문 작업은 이 일반 루프 위에 더 강한 engagement와 finding 계약을 추가합니다.

- `application-security-red-team`은 위협 경계, 공격 전제, local/disposable reproduction, 증거 hash를 생산합니다.
- `security-remediation-verifier`는 producer와 독립적으로 patch와 regression을 검증합니다.
- live target은 Ed25519 서명 engagement, exact resource, 물리적으로 symlink/junction을 통과하지 않는 workspace scope, time/method/rate cap, stop condition, live 권위 allowlist가 모두 일치해야 합니다.
- credential은 prompt 문자열이 아니라 opaque handle ID로만 표현합니다.
- persistence, stealth/evasion, credential exfiltration, destructive action, third-party targeting, scope escape, denial of service는 engagement에서도 허용되지 않습니다.
- CWE/공격 분류, 재현 evidence, severity 근거, remediation, regression 결과, engagement에 허가된 독립 verifier의 Ed25519 서명이 없는 finding은 완료 증거가 아닙니다. Finding과 verifier 권위는 engagement ID뿐 아니라 서명된 exact manifest hash에도 결합됩니다.

이 계약은 취약점 탐지·재현·수정 검증을 위한 권위 모델입니다. 일반 Red Team의 사고 강도는 제한하지 않지만, 임의 공격 runner나 무제한 네트워크 권한을 제공하지 않습니다.

## 브라우저·비전 관찰

새 host-owned adapter는 관찰 결과를 모델이 만든 주장과 분리하고 HMAC receipt로 고정합니다.

- `browser-observe`: credential-free·script-disabled·same-origin provider에서 exact-origin의 snapshot/extract만 허용하고 redirect마다 origin을 재검증합니다. cookie, credential, 임의 header/body, POST, click, type, submit, upload, download, code execution은 거부합니다.
- `vision-inspect`: workspace 내부의 stable regular single-link 파일만 읽고 symlink/junction/hardlink, byte·pixel·frame 초과를 거부합니다.
- 두 결과 모두 untrusted content로 표시됩니다. HMAC receipt는 host context hash와 canonical input/output hash에 결합되며, verifier가 실제 결과 material을 다시 hash하므로 다른 세션으로의 재결합이나 결과 변조는 검증에서 실패합니다.

현재 adapter와 계약은 구현되어 있지만 일반 Swarm/App Server에는 자동 등록하지 않습니다. 실제 provider, 허용 도메인, Work Order capability, 비용·호출 상한을 host가 명시적으로 구성하기 전까지 일반 실행은 기존 `read`/`search` 전용입니다.

## 검증 불변식

1. 같은 task와 catalog에서 portfolio ID와 assignment가 결정적이어야 합니다.
2. 한 포트폴리오 안에서 full skill body owner가 중복되면 안 됩니다.
3. resume 시 Harness snapshot이 없거나 run-level policy, catalog version 또는 skill content hash가 달라지면 명시적 migration 없이 fail closed 해야 합니다.
4. artifact handoff는 알려진 최신 revision을 정확히 모두 소비하고, expected output kind와 독립 gate artifact를 정확히 충족해야 합니다.
5. security engagement의 signature, target, time, mode, method, cap 중 하나라도 다르면 실행 권위가 없어야 합니다.
6. browser/vision 결과는 항상 untrusted이며 receipt 검증을 통과해야 합니다.
7. workflow recipe candidate가 source capability 교집합을 넓히면 안 됩니다.

## 참고 자료

- [OpenAI, A practical guide to building agents](https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/)
- [Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic, Harness design for long-running apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)
- [Hermes Agent, Work with skills](https://hermes-agent.nousresearch.com/docs/guides/work-with-skills/)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)
- [NIST AI 100-2 E2025](https://csrc.nist.gov/pubs/ai/100/2/e2025/final)
- [MITRE ATLAS](https://atlas.mitre.org/)
- [OpenAI, Computer-Using Agent](https://openai.com/index/computer-using-agent/)
