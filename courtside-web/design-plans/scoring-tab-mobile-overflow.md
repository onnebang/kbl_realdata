# 득점 분석 필터 탭 바가 모바일에서 뷰포트를 넘어 페이지 전체를 가로로 넘치게 하는 문제 수정

Written against: eebad4d3bab42c5ac1f45d7bd235eb6d7816cf22

## Evidence chain

- Surface: `courtside-web/components/ScoringInfographicStudio.module.css`의 `.tabGroup`(득점 분석 위젯 필터 탭 바), `courtside-web/app/players/[pcode]/page.tsx`의 선수 프로필 페이지 어디서든 렌더됨
- Problem: `ScoringInfographicStudio.module.css:256-282`의 `@media (max-width: 768px)` 블록은 `.studioToolbar`를 `flex-direction: column; align-items: stretch;`로 세로 배치하고, `.tabGroup`에 `flex-wrap: nowrap; overflow-x: auto;`만 추가했다. 사용자가 제공한 모바일 스크린샷(확대 상태/축소 상태 2장)에서 "시즌별 // BY SEASON" 등 4개 탭 버튼이 자기 박스 안에서 스크롤되지 않고 뷰포트 밖으로 실제로 번져 나가, 페이지 전체가 가로로 넘치는 것이 확인됐다(축소 스크린샷에서 4개 탭 전부가 원래 클리핑됐어야 할 위치까지 정상 레이아웃으로 드러남 - 스크롤 클리핑이 아니라 진짜 페이지 오버플로다). `.tabGroup`엔 `min-width: 0`이 없어, 중첩된 flex 컨테이너가 `overflow-x: auto`를 갖고도 부모가 준 stretch 폭 대신 내용물 최소 폭(4개 버튼의 `white-space: nowrap` 텍스트 폭 합)만큼 늘어날 수 있다.
- Design evidence: `courtside-web/app/globals.css:100-146`의 `.nav-main`/`.nav-bar-inner` - 주석(100-109행)에 "12개 링크가 한 줄 overflow-x라 375px에서 3.5개만 닿고 스크롤 단서가 없었다"는 동일한 문제 클래스를 실측하고 고친 기록이 있다. 그 수정은 `overflow-x: auto; scrollbar-width: none;`에 더해 `min-width: 0`을 조상 flex 체인에 명시하고(`.nav-more { flex: 1; min-width: 0; }` 등 그리드/플렉스 축소 안전장치), 스크롤 가능함을 알리는 우측 페이드 마스크(`mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent)`)를 붙였다.
- Owner: `app/globals.css`의 `.nav-main` 패턴이 이 문제 클래스의 검증된 원본 구현(owner). `ScoringInfographicStudio.module.css`의 `.tabGroup`은 같은 문제를 이번에 독립적으로 다시 만든 소비자다.
- Scope and affected surfaces: `.tabGroup` 선택자 하나. 이 컴포넌트를 쓰는 모든 곳(선수 프로필 페이지의 득점 분석 위젯, `hasTeamBreakdown` 값에 따라 3개 또는 4개 탭)이 함께 고쳐진다 - 별도 지점 수정 불필요.
- Uncertainty: 정확한 렌더링 실패 메커니즘(중첩 flex 컨테이너의 stretch-폭 계산과 내용물 최소 폭 간 상호작용)은 이 세션에서 라이브 브라우저로 재현 확인을 못 했다 - 코드 검토와 스크린샷 증거로만 진단함. `min-width: 0`은 이 문제 클래스의 표준 수정이라 위험 없이 적용 가능하지만, 적용 후 실제 기기/스크린샷으로 재확인 필요.

## Design decision

`.tabGroup`이 `.nav-main`과 똑같은 문제(좁은 화면에서 한 줄 내용물이 부모 폭을 넘음)를 겪고 있으므로, `.nav-main`이 이미 검증한 두 가지 장치를 그대로 이식한다: (1) `min-width: 0`으로 flex 아이템이 내용물 최소 폭 대신 부모가 준 stretch 폭을 실제로 쓰도록 강제해 오버플로가 페이지가 아니라 `.tabGroup` 자신의 스크롤 영역 안에 갇히게 하고, (2) 우측 페이드 마스크로 "더 스크롤할 탭이 있다"는 단서를 준다. 새 패턴을 발명하지 않고 이미 이 저장소가 같은 문제에 대해 갖고 있는 답을 재사용한다.

## Reuse

- 이미 검증된 가로 스크롤 칩 패턴: `overflow-x: auto; scrollbar-width: none;` + `min-width: 0` + `mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent)`
- Exemplar: `courtside-web/app/globals.css:136-146`(`.nav-main`)

새 프리미티브(CSS 변수·유틸리티 클래스 등) 도입 불필요 - 기존 선언을 그대로 복사하면 된다.

## Changes

1. `courtside-web/components/ScoringInfographicStudio.module.css:263-269`(`@media (max-width: 768px) { .tabGroup { ... } }`)
   - Change: 기존 `flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; padding-bottom: 2px;`에 `min-width: 0;`을 추가하고, `.nav-main`과 동일한 `-webkit-mask-image`/`mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent);`를 추가한다.
   - Preserve: `.tabGroup::-webkit-scrollbar { display: none; }` 규칙과 데스크톱(>=769px) 스타일은 그대로 둔다.
   - Verify: Chrome DevTools 모바일 에뮬레이션(375px, 390px 너비)에서 득점 분석 위젯의 탭 4개 행이 뷰포트 밖으로 번지지 않고, `.tabGroup` 안에서만 가로 스크롤되며, 오른쪽 끝에 페이드로 "더 있음" 단서가 보이는지 확인. 페이지 자체의 `document.documentElement.scrollWidth`가 `window.innerWidth`와 같아야 한다(페이지 레벨 가로 스크롤 없음).

## Scope

- Inherit: `ScoringInfographicStudio`를 쓰는 모든 선수 프로필 페이지(팀 소속 이력이 있어 "소속팀별" 탭까지 4개가 뜨는 선수, 3개만 뜨는 선수 둘 다).
- Verify: 3개 탭인 경우(내용 폭이 원래도 뷰포트 안에 들어올 수 있는 경우)에도 `min-width: 0`/마스크 추가로 인한 시각적 회귀(불필요한 스크롤바나 마스크 페이드)가 없는지 확인.
- Exclude: 이전 스크린샷에서 별개로 관찰된 "소속팀별" 도넛 차트의 세로 여백 이슈(`.canvasFrame`의 모바일 `aspect-ratio: auto` + `min-height` 조합)는 라이브 렌더링 증거 부족으로 이번 감사에서 findings로 채택되지 않았다 - 별도 확인 필요.

## Validation

- Product: 선수 프로필 페이지를 모바일 폭에서 열었을 때 득점 분석 위젯의 필터 탭이 화면 안에 온전히 들어오고, 스와이프로 나머지 탭에 접근할 수 있어야 한다.
- Interface: `/players/[pcode]` 라우트, 375px/390px/768px 경계 폭, 탭 3개인 선수와 4개인 선수 둘 다.
- System: `.nav-main`과 동일한 선언 패턴을 재사용했는지, 새로운 병렬 스크롤 구현을 만들지 않았는지 확인.
- Repository: `cd courtside-web && npx tsc --noEmit && npx eslint components/ScoringInfographicStudio.module.css` → 에러 없음(CSS 모듈이라 tsc/eslint는 실질적으로 영향 없음이 기대값이지만 회귀 없음 확인용으로 실행).

## Stop conditions

- Stop if 모바일 에뮬레이션으로 재확인했을 때도 여전히 페이지 레벨 오버플로가 남아 있다면(즉 `min-width: 0`만으로 해결되지 않는다면) - 이 경우 `.studioToolbar`/`.studioContainer`/`.panel` 조상 체인에도 `min-width: 0`이 필요한지 추가 진단이 필요하며, 이 플랜의 Change 범위를 넘어서는 조사이므로 여기서 멈추고 원인을 다시 보고한다.

## Design documentation

- After acceptance and validation: 별도 기록 불필요(이미 `globals.css`의 `.nav-main` 주석이 이 패턴의 근거 문서 역할을 하고 있음).
