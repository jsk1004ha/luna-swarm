# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-08-17
- Primary product surfaces: 웹 기반 회사 운영 대시보드, 회장 명령석, 에이전트 상세 인스펙터, 회사 보고서 문서함, 전문 역량·스킬·학습 근거, 실시간 이벤트 스트림
- Evidence reviewed: `README.md`, `docs/ARCHITECTURE.ko.md`, `src/types.ts`, `src/organization.ts`, `src/store.ts`, `ui/src/App.tsx`, `ui/src/styles.css`, `ui/src/components/OrgView.tsx`, `ui/src/pixi/HQCanvas.tsx`, 사용자가 제공한 `luna-swarm-command-center.zip`의 `client/src/pages/Home.tsx`와 `client/src/index.css`, 기존 mock 운영 화면

## Brand

- Personality: Linear/Notion 계열의 밝고 차분한 생산성 워크스페이스, 책임선이 보이는 회사, 고밀도이지만 빠르게 판독되는 운영 도구
- Trust signals: 실제 상태와 행동의 일관된 매핑, 마지막 동기화 시각, 실데이터/데모 모드 표시, 명확한 차단 신호
- Avoid: ZIP 커맨드센터와 별개의 앱 셸이나 중첩 레이아웃, 기존 UI를 위에 덮는 cascade overlay, 의미 없는 랜덤 이동, 과도한 네온/유리 효과, 강한 그림자, 100명을 동일한 DOM 카드로 나열하는 화면, 픽셀 사무실을 유일한 정보 구조로 삼는 것, 사람 사진·캐릭터 스프라이트·HQ 배경을 포함한 래스터 이미지 에셋

## Product goals

- Goals: 100명 이상의 에이전트가 어느 부서에서 무엇을 하는지 3초 안에 파악하게 한다. 문제 에이전트를 한 번의 클릭으로 조사하게 한다. 회의·검증·팀·최종 결과를 실제 회사 문서함처럼 추적하게 한다. 저장된 Luna Swarm 실행을 별도 설정 없이 웹에서 관찰하게 한다. 진행 중인 프로젝트에 자연어 회장 지시를 넣고 다음 안전한 체크포인트부터 조직 전체에 반영하게 한다.
- Non-goals: 대시보드에서 checksummed 실행 상태를 직접 수정하거나, 이미 실행 중인 호출을 중단·재작성하거나, 승인·재시도·취소를 임의로 수행하지 않는다. 명시적인 회장 지시 큐만 쓰기 경로로 둔다. Pixel Agents의 캐릭터나 가구 에셋을 복제하지 않는다.
- Success signals: 128~256명에서 60fps에 가까운 캔버스 이동, 부서/상태 필터와 검색의 즉각 반영, 선택 대상과 우측 상세의 일치, 실데이터가 없을 때도 144명 데모로 제품 가치를 확인 가능

## Personas and jobs

- Primary personas: 대규모 에이전트 실행을 지휘하는 개발자·운영자, 결과를 기다리는 의뢰인/리더
- User jobs: 전체 처리량 확인, 차단/실패 식별, 특정 태스크·에이전트 찾기, 부서별 병목 비교, 최근 사건 추적, 진행 중인 조직에 우선순위·방향 지시
- Key contexts of use: 로컬 개발 중 보조 모니터, 장시간 실행 관찰, 실행 종료 후 회고

## Information architecture

- Primary navigation: ZIP의 `workspace-shell` 안에서 좌측 내비게이션(Overview/Organization/Task board/Reports/Activity) → `app-topbar`의 실행 선택·검색·일시정지 → `content-area`의 실행 요약·책임 조직도·업무·문서·사건 → 같은 셸의 에이전트 또는 보고서 상세 drawer와 operator directive 순서를 유지한다.
- Core routes/screens: 기본은 `조직` 운영 콘솔이며 `업무 DAG`와 `Reports` 문서 레지스트리는 같은 실행을 보는 보조 뷰다. Activity는 시간순 사건을, Reports는 제출·결정·검증된 구조화 문서를 답한다. `/api/snapshot`, `/api/stream`, `/health`는 읽기 전용 데이터 표면이며 명시적 제어 API만 사용자 명령을 받는다.
- Content hierarchy: 실행 상태와 전체 진행률 → 회장실/운영본부/기능 조직의 책임선 → 부서와 실제 직원 → 업무·의존성 → 경영/팀/작업/회의/검증 보고서 → 선택 문서의 요약·근거·참조 → 실행 기록

## Design principles

- 상태를 행동으로 번역한다: `working`은 타이핑, `researching`은 문서 탐색, `reviewing`은 검토, `waiting`은 대기, `blocked`는 구조 신호, `done`은 완료로 보인다.
- 밀도는 계층으로 푼다: 멀리서는 부서의 색과 활동량, 가까이서는 좌석과 개별 직원, 선택 시에만 상세 텍스트를 드러낸다.
- 장식보다 신뢰를 우선한다: 에이전트는 실제 상태 변화에 반응하며 의미 없는 이동을 하지 않는다.
- ZIP 원본을 확장한다: 새 기능은 제공된 `Home.tsx`의 DOM 계층과 `index.css`의 클래스·토큰·밀도·카드·drawer 문법 안에 추가한다. 별도 앱 셸, 평행한 내비게이션, 전역 스타일 덮어쓰기 레이어를 만들지 않는다.
- 모든 제어는 상태를 드러낸다: 새 버튼과 입력에는 기본·호버·포커스·비활성·로딩·성공·오류 상태를 같은 컴포넌트 문법으로 제공한다.
- Tradeoffs: 조직 책임과 검증 흐름은 가벼운 DOM으로, 공간 행동은 Pixi 2D로 분리한다. 기본 화면은 조직 운영 콘솔로 두고, 100명 이상의 개별 이동이 필요한 경우에만 본사 뷰를 연다.

## Visual language

- Color: `#f7f7f5` 앱 셸, `#ffffff` 패널, `#d9d9d5` 경계, 보라 `#6466d9` 선택·주요 동작, 초록 `#22865f` 성공·진행을 중심으로 한다. 상태는 초록(작업/완료), 파랑(조사), 호박(검토/대기), 청록(Ready), 진홍(Needs review/차단), 회색(유휴)을 사용한다. `Ready`는 청록색 테두리 원, `Needs review`는 진홍색 마름모와 굵은 라벨로 중복 표현해 빨강·주황 구분에 의존하지 않는다. Pixi 본사 캔버스 내부만 어두운 공간 표현을 유지한다.
- Typography: ZIP 스타일의 `Space Grotesk`/`Manrope`/`IBM Plex Mono` 스택과 크기 계층을 유지한다. 네트워크 폰트가 없을 때는 같은 선언의 산세리프·모노 fallback으로 읽을 수 있어야 한다.
- Spacing/layout rhythm: ZIP의 240px sidebar, 상단 `app-topbar`, 최대 1440px `content-area`, 16px 카드 gap과 6–9px radius를 기준으로 한다. 선택 상세는 동일 페이지 위의 `agent-drawer`로 열며 중앙에 기존 Inspector 셸을 다시 삽입하지 않는다.
- Shape/radius/elevation: 입력과 작은 제어는 4~6px, 주요 카드는 8~9px 라운드와 1px 중립 경계를 쓴다. 상시 카드에는 그림자를 거의 쓰지 않고 오버레이·드로어에만 낮은 중립 그림자를 사용한다. 선택 카드는 연한 보라 배경과 보라 경계로 표시한다.
- Motion: 180~260ms 인터페이스 전환, 캐릭터의 작업 상태는 낮은 진폭의 루프. 차단 펄스는 느리고 제한적. `prefers-reduced-motion`에서는 루프를 정지한다.
- Result arrival: 새 작업 산출물은 문서 아이콘과 `결과 생성됨` 라벨로 한 번만 도착 애니메이션을 실행한다. 검증 중은 청록, 승인된 결과는 민트, 부분 결과는 호박, 최종 보고서는 밝은 민트와 별도 `FINAL` 배지로 구분하며 색만으로 상태를 전달하지 않는다.
- Imagery/iconography: 래스터 이미지 에셋을 사용하지 않는다. ZIP의 로고와 summary cover도 CSS 도형으로 표현하고, DOM은 안정적인 이니셜·색상 배지, Pixi는 부서색·상태색·방향 노치로 구성한 기하학적 마커를 사용한다. 방·복도·문·포드·책상·모니터·의자·회의실·서가·incident room·카페는 배경 이미지 없이 구조화된 Pixi 오브젝트로 렌더링한다.

## Office world and employee identity

- Aesthetic direction: `Luna Headquarters — 살아 있는 운영 본부`. 부서별 상태 상자가 아니라 고정 좌석, 팀 포드, 회의실, 로비, 카페, 서가, incident room, review booth, mail room이 연결된 실제 회사 층으로 읽혀야 한다.
- Spatial grammar: 전체 면적의 10–15%는 공용 공간과 복도다. 주 통로는 32 world px, 보조 통로는 24 world px 이상이며 각 부서는 고유한 가구 문법과 최소 한 개의 기능적 랜드마크를 갖는다.
- Stable identity: `agent.id`에서 이름과 외형을 결정한다. snapshot 순서, 상태 변화, 페이지 재접속이 이름·좌석·외형을 바꾸지 않는다.
- Avatar system: `agent.id`에서 16개 안정적 색상·도형 변형을 선택한다. DOM 배지는 이니셜과 색상, Pixi 마커는 중심 기호와 방향 노치로 구분한다. 부서색은 정체성에, 상태색은 링·중심 기호·모니터에만 사용하며 사진형 외형을 만들지 않는다.
- Density hierarchy: 전체 줌에서는 방·활동량·실루엣, 중간 줌에서는 팀 포드·개인 포즈, 상세 줌에서는 이름·역할 소품을 보여준다. 선택·호버된 직원 이름은 줌과 무관하게 표시한다.
- Motion budget: 모든 직원에게 무한 이동을 주지 않는다. 선택/최근 상태 변경 직원과 보고 캡슐을 합쳐 최대 24개만 이동 애니메이션하고, routine 말풍선은 최대 20개로 제한하며 나머지는 정적 상태 포즈로 둔다.

## Components

- Existing components to reuse: 화면 구조의 기준은 ZIP에서 옮긴 `ui/src/pages/Home.tsx`와 `ui/src/styles.css`다. 기존 `HQCanvas`와 API/store/schema 로직은 그 셸 안에서 기능 단위로 재사용하되, 과거 `TopBar`·`ViewNav`·`DirectoryPanel`·`InspectorPanel`을 두 번째 레이아웃으로 중첩하지 않는다.
- New/changed components: 전역 검색, 현재 실행 summary, 조직도, task queue, live activity, operator directive, agent drawer는 ZIP의 기존 DOM/class 계약을 유지한다. `ReportsView`는 같은 밝은 card/table 문법을, `ReportDrawer`는 기존 우측 drawer 문법을 확장한다. Luna 연결은 그 요소의 값과 handler만 실제 REST/WebSocket/control API로 교체한다.
- Variants and states: 실데이터/데모, 연결/재연결, 선택/호버, 전체/부서 집중, 상태 필터, 검색 결과, 현재 프로젝트 지시/새 실제 실행/새 모의 실행
- Token/component ownership: ZIP `index.css`를 옮긴 `ui/src/styles.css`가 모든 DOM 시각 토큰과 클래스 계약을 소유한다. `ui/src/pages/Home.tsx`가 단일 UI 셸을, `ui/src/pixi/renderScene.ts`와 `ui/src/map/officeMap.ts`가 이미지 없는 Pixi 장면만 소유한다. 이후 UI도 기존 selector/token을 우선 확장하며 별도 전역 테마를 만들지 않는다.

## Accessibility

- Target standard: WCAG 2.2 AA에 준하는 대비와 키보드 경로
- Keyboard/focus behavior: 검색, 필터, 부서, roster, 상세 닫기 순으로 논리적 포커스. Enter/Space로 필터와 직원 선택.
- Contrast/readability: 상태는 색뿐 아니라 모양·라벨·아이콘으로 중복 표현한다.
- Screen-reader semantics: 캔버스 옆에 회사/필터 결과 요약과 키보드로 선택 가능한 직원 roster를 제공한다.
- Reduced motion and sensory considerations: 감소 모션 환경에서 캔버스 루프 동작을 정지하고 상태 변화를 정적인 링으로 표시한다.

## Responsive behavior

- Supported breakpoints/devices: 1440px 이상 최적, 1024~1439px 지원, 720~1023px 축약, 719px 이하 관찰용 모바일
- Layout adaptations: ZIP 계약대로 820px 이하에서는 sidebar를 감추고 콘텐츠·상단 바를 축약하며, 560px 이하에서는 summary cover를 감추고 조직도·업무 표·directive를 모바일 밀도로 바꾼다. 상세는 모든 크기에서 `agent-drawer`가 담당하고 본사도 같은 `content-area` 안에서만 열린다.
- Touch/hover differences: 터치에서는 첫 탭이 선택과 툴팁을 함께 수행하며, 캔버스 드래그/휠로 팬·줌한다.

## Interaction states

- Loading: 빈 회사 골격과 “조직 연결 중” 표시
- Empty: 자동 144명 데모 또는 명시적으로 빈 실행 안내
- Error: 마지막 정상 스냅샷을 유지하고 연결 배지만 경고 상태로 바꾼다.
- Success: 완료 에이전트의 화면과 링을 민트색으로 고정한다.
- Output created: 중앙 결과 리본에 최신 작업·팀·최종 산출물을 지속 표시하고 `aria-live=polite`로 알린다. 조직 카드와 실행 기록에도 문서 배지를 중복 표시하며, 직원을 선택하면 결과 탭에서 요약·산출물·증거/검증 개수를 확인한다.
- Output reviewing: 작업자가 결과를 저장했지만 감사가 끝나지 않은 경우 `검증 중`으로 표시하며 완료로 오인시키지 않는다.
- Output final: 최종 경영 보고서는 일반 작업 산출물과 다른 `FINAL` 배지와 고정된 완료 상태로 표시한다.
- Reports loading: 마지막 정상 문서 목록을 유지하고 갱신 중임을 상단 동기화 상태로 표시한다.
- Reports empty: 실행에서 아직 발행된 문서가 없음을 알리고 작업 제출·Council 결정·검증 시 문서가 생성된다고 안내한다.
- Reports filter empty: 현재 필터와 일치하는 문서가 없음을 표시하고 한 번에 필터를 초기화할 수 있다.
- Reports stale: 문서를 지우지 않고 마지막 정상 snapshot 기준임을 문서함 상단과 발행 시각에 함께 표시한다.
- Reports detail: 보고서 유형·상태·문서 ID, 실제 작성 주체, 요약, 구조화된 섹션, artifact/gate/reviewer 참조를 순서대로 보여준다. raw prompt, chain-of-thought, sealed memo, secret은 포함하지 않는다.
- Disabled: 비활성 필터는 낮은 대비와 `aria-disabled`를 사용한다.
- Command queued: 지시가 저장된 실행 ID와 “다음 안전 체크포인트부터 반영” 문구를 즉시 표시한다.
- Command disabled: 데모 모드이거나 실행이 종료된 경우 `현재 프로젝트에 지시`를 비활성화하고 새 프로젝트 시작 모드는 유지한다.
- Command error: 입력을 보존한 채 서버의 거부 사유를 명확히 표시한다.
- Offline/slow network, if applicable: WebSocket 재연결 때 마지막 정상 snapshot과 마지막 동기화 시각을 유지하고, 서버는 실행별 sequence 이후 사건을 replay한다.

## Capabilities, skills, and learning evidence

- Canvas density is unchanged. Specialist roles and memory counts are not drawn as avatar badges.
- The selected-agent inspector shows only runtime-proven fields: assigned specialist ID, actually selected skill IDs, and recalled-memory count. It never infers capability from prose.
- `메모리 조회` does not mean `업무에 적용` or `학습 완료`. The UI deliberately uses action counts instead of intelligence, expertise, or percentage scores.
- Raw memory text, skill input/output, prompts, model reasoning, and secrets never enter the dashboard contract.
- Footer metrics expose calls, retries, skill invocations, memory recalls, and persisted experience count. Demo mode shows zero rather than fabricating learning evidence.
- A missing `harness_selected` event renders `기록 없음`; it is not treated as zero competence.
- Search may index safe specialist/skill IDs, but never memory text.
- 각 하네스 결정은 정책 버전, 재현 가능한 결정 ID, 안전한 선택 근거 라벨, 위험 등급, 필수 검증 게이트를 남긴다. 이는 체인오브쏘트가 아니라 운영 감사용 메타데이터다.
- 고위험·검증·최종 판정 호출은 `독립 검증`, `증거 출처`, `반례 탐색`, `요구사항 추적` 게이트를 목적에 맞게 강제한다. 확인할 수 없는 게이트는 성공으로 꾸미지 않고 결과 스키마의 기존 이슈/한계 필드에 남긴다.
- 하네스 탭의 지속 개선 영역은 활성 정책 버전, 표본/holdout 수, 검증 개선폭과 rollback 횟수만 표시한다. 새 경험은 즉시 능력 향상으로 표현하지 않고 `표본 수집`·`승격`·`보류`·`롤백` 상태를 구분한다.

## Content voice

- Tone: 짧고 운영 중심이며, 회사 메타포는 자연스럽게 사용한다.
- Terminology: 에이전트=직원, department=부서, task=업무, blocked=차단, waiting=대기. 원본 기술 상태도 상세에서 함께 표시한다.
- Microcopy rules: 숫자와 상태를 먼저 제시하고 장식적 문장을 피한다.

## Implementation constraints

- Framework/styling system: Node HTTP/API 서버 + React/TypeScript/Vite + ZIP 기반 단일 `Home` DOM shell + 선택형 PixiJS 구조화 오피스
- Design-token constraints: 새 UI 토큰은 `ui/src/styles.css`의 ZIP custom properties에만 정의한다. 새 기능 UI는 ZIP의 밝은 surface, primary, semantic status 색, spacing, radius 계약을 따르고 기존 UI 스타일 파일을 다시 합치거나 덮어쓰지 않는다.
- Performance constraints: DPR 최대 1.25, ticker 최대 30fps, 한 층 개별 에이전트 최대 144, 애니메이션 최대 24, routine bubble 최대 20, 정적 오피스 레이어 1회 mount, 진행률-only snapshot에서 동적 장면 재생성 금지. 직원 마커는 런타임 이미지 로드 없이 Graphics로 만든다. Capability summary는 task별 최신 `harness_selected` event만 사용한다. 결과 계약은 최신 60개, 보고서 레지스트리는 최신 120개로 제한하고 요약·항목 문자열을 서버에서 길이 제한한다. 결과 도착 애니메이션은 새 ID에 한 번만 실행한다.
- Compatibility constraints: Node.js 20+, 최신 Chromium/Edge/Firefox/Safari. 명령 활성 서버는 loopback에만 bind하고 Host/Origin 및 안전한 run ID를 검증한다. 회장 지시는 append-only `commands.jsonl`에 기록하고 실행 상태 snapshot을 직접 수정하지 않는다. 현재 모델 호출은 시작 시 캡처한 지시 snapshot을 끝까지 사용하며 새 지시는 다음 planning/DAG/validation/synthesis/judge 체크포인트부터 적용한다. 마지막 judge 중 도착한 지시는 종료 barrier가 새 judge checkpoint를 만든다. 명령 append와 `commands.closed` 전환은 PID·시각·고유 토큰을 가진 실행별 파일 락으로 직렬화하며 죽은 소유자의 락만 자동 회수한다. 브라우저 요청 ID는 idempotency key로 사용하고, 재개 시 끊긴 마지막 명령 레코드와 누락된 `directive_queued` 감사 이벤트를 복원한다. 지시를 한 건도 담을 수 없는 context 설정은 시작 전에 거부한다.
- Test/screenshot expectations: 타입체크, 서버 단위 테스트, 128명 이상 assertion, 144명 이름 uniqueness, 동일 agent id의 이니셜·색상·도형 변형 안정성, 저장소 래스터 이미지 0건, `Home`의 ZIP 핵심 class 계약, `render_game_to_text` 상태 검증, 실제 브라우저 데스크톱/축소 화면 육안 검사. 보고서는 실제 output/Work Order/Council에서만 생성되고 sealed memo가 노출되지 않아야 한다. 유형·상태·부서·검색 필터, 안정 정렬, 상세 drawer, empty/filter-empty/stale 상태를 검증한다. 1440×1000과 390×844에서 문서 수평 overflow 0, 단일 app shell, 상단 제어 및 directive/drawer 겹침 0을 확인한다.

## Open questions

- [x] pause/resume/cancel/concurrency/operator instruction을 durable control plane과 실행 lease 경계 안에 추가
- [ ] 토큰·비용 데이터가 RunState에 추가되면 KPI에 노출할지 / 코어 모델 / 정보 우선순위에 영향
- [ ] 256명 초과 실행에서 좌석 페이지 또는 부서 클러스터 전환을 도입할지 / 프론트엔드 / 확장성에 영향
