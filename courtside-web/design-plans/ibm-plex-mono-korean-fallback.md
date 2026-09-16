# IBM Plex Mono 스택에 섞인 한글이 시스템 폴백 서체로 깨지는 문제 수정

Written against: 8799917d53b6f0f0d2bd219b5dbfe18f71a84625

## Evidence chain

- Surface: `courtside-web/app/players/[pcode]/page.tsx`(득점 분석 패널의 `.scoringEyebrow`), `courtside-web/components/CourtHeroExpand.tsx`(3D 코트 모달의 `.hudSeason`)
- Problem: `.scoringEyebrow`(`player-profile.module.css:564-570`)와 `.hudSeason`(`court-hero-expand.module.css:63-71`)이 둘 다 `font-family: "IBM Plex Mono", monospace;`로 선언돼 있다. `.scoringEyebrow`는 `page.tsx:964,981,988,996`에서 `{careerPts.toLocaleString()}점`을 담아 매번 한글 "점"을 그 폰트 스택 안에 렌더링한다. `.hudSeason`은 `CourtHeroExpand.tsx:95`에서 `fmtLabel(progress.label)`을 담는데, "팀별" 탭(`groupBy === "team"`)일 때 `fmtLabel`은 `teamNameByTcode?.get(raw) ?? raw`를 반환해 "부산 KCC"류의 한글 포함 팀 이름을 그대로 넣는다(`CourtHeroExpand.tsx:66-67`). IBM Plex Mono에는 한글 글리프가 없어서 두 경우 모두 한글 부분만 브라우저 기본 시스템 모노스페이스로 조용히 떨어지고, 숫자·기호와 자간·굵기가 어긋나 보인다.
- Design evidence: `courtside-web/app/globals.css:1876-1879` 코드 주석 — "IBM Plex Mono에는 한글 글리프가 없어서 그때 브라우저 기본 monospace로 조용히 튄다. 폴백을 지어내지 말고 이름을 적어 준다 - 숫자는 계속 IBM Plex Mono, 한글만 Pretendard로 간다(글리프 단위 폴백)." 이 규칙은 같은 파일의 `:1728`, `:1882`, `:2665`, `:2904`에서 `font-family: "IBM Plex Mono", "Pretendard", monospace;` 3단 스택으로 이미 일관되게 적용돼 있다.
- Owner: `courtside-web/app/globals.css`가 이 폰트-폴백 규칙의 근거 출처. 실제 선언은 각 컴포넌트별 CSS 모듈(`player-profile.module.css`, `court-hero-expand.module.css`)에 로컬로 있다(이 저장소 관례 - `player-profile.module.css:1-6` 주석 참고, 전역 CSS를 직접 건드리지 않고 값만 복제).
- Scope and affected surfaces: `player-profile.module.css`의 `.scoringEyebrow`, `court-hero-expand.module.css`의 `.hudSeason` 딱 두 선택자. 두 선택자를 소비하는 모든 렌더링 지점(득점 분석 패널 4개 카드 캡션, 3D 코트 모달 HUD의 팀별 탭)이 함께 고쳐진다 - 별도 지점 수정 불필요.
- Uncertainty: 없음. 이미 같은 파일(`globals.css`)에 동일한 문제·동일한 수정 패턴이 4곳 존재해 교차 검증됨.

## Design decision

`.scoringEyebrow`와 `.hudSeason`의 `font-family` 선언에 `"Pretendard"`를 IBM Plex Mono와 시스템 monospace 사이에 끼워 넣는다. 브라우저의 글리프 단위 폴백 덕분에 숫자·기호는 계속 IBM Plex Mono로, IBM Plex Mono가 커버하지 못하는 한글 글리프만 자동으로 Pretendard로 렌더링된다 - 별도 조건 분기나 컴포넌트 로직 변경 없이 CSS 한 줄만으로 두 폰트가 같은 요소 안에서 자연스럽게 섞인다.

## Reuse

- 이미 검증된 폴백 스택 패턴: `font-family: "IBM Plex Mono", "Pretendard", monospace;`
- Exemplar: `courtside-web/app/globals.css:1880-1883`(`.replay-scoreboard-clock`) — 숫자 시계와 한글 "경기 시작 전"을 같은 요소에서 섞어 보여줘야 하는, 지금 고치려는 두 경우와 구조적으로 동일한 선례.

새 프리미티브(폰트 스택 변수 등) 도입 불필요 - 기존 문자열 패턴을 그대로 복사하면 된다.

## Changes

1. `courtside-web/app/players/[pcode]/player-profile.module.css:565`
   - Change: `font-family: "IBM Plex Mono", monospace;` → `font-family: "IBM Plex Mono", "Pretendard", monospace;`
   - Preserve: `font-style: italic`, `font-size: 11px`, `color: var(--ink-faint)` 등 나머지 선언은 그대로.
   - Verify: 선수 프로필 페이지에서 슛이 있는 선수(예: 실제 pcode)를 열어 득점 분석 패널의 "N점 //" 캡션 4곳(팀별/시즌별/슛 위치별/상대 연고지별)에서 "점" 글자가 숫자와 같은 굵기·자간의 모노스페이스 느낌으로(정확히는 Pretendard로, 시스템 기본 서체로 안 튀고) 보이는지 확인.

2. `courtside-web/components/court-hero-expand.module.css:64`
   - Change: `font-family: "IBM Plex Mono", monospace;` → `font-family: "IBM Plex Mono", "Pretendard", monospace;`
   - Preserve: `padding`, `border-radius: 999px`, `background: var(--surface-soft)`, `color: var(--ink-soft)`, `font-size: 11.5px` 등 나머지 선언은 그대로.
   - Verify: 팀이 둘 이상인 선수의 3D 코트 모달을 열고 "팀별" 탭으로 전환 - 빌드업 재생 중 HUD 칩에 뜨는 팀 이름(예: "부산 KCC")이 시스템 기본 서체로 안 튀고 자연스럽게 보이는지 확인. "시즌별"(예: "24-25")·"쿼터별"(예: "Q1") 탭은 원래 한글이 없어 이번 변경으로 시각적 차이가 없어야 함(회귀 없음 확인용).

## Scope

- Inherit: 두 선택자를 쓰는 모든 곳 - 득점 분석 패널 4개 카드, 3D 코트 모달 HUD(팀/시즌/쿼터 3개 탭 전부, 팀별 탭에서만 실제로 한글이 나타남).
- Verify: 라이트/다크 테마 둘 다(색상은 안 바뀌지만 서체 렌더링은 OS/브라우저 폰트 스택에 따라 달라질 수 있음 - Pretendard 웹폰트가 정상 로드되는지만 확인하면 충분).
- Exclude: 이 두 선택자 외의 다른 IBM Plex Mono 사용처(이미 `globals.css`에서 33곳 확인됨) - 이번 감사 범위(선수 프로필 3D 코트/득점 분석)에 없는 곳은 별도 감사 대상.

## Validation

- Product: 선수 프로필 페이지에서 득점 분석 패널과 3D 코트 모달을 열어 위 "Verify" 항목대로 육안 확인.
- Interface: `/players/[pcode]` 데스크톱·모바일(479px 이하 - `player-profile.module.css`에 이 폭 전용 미디어쿼리 존재) 두 폭에서 확인. 상태: 득점 분석 패널 렌더 상태, 3D 코트 모달의 재생 중(HUD 보임)·재생 종료 후(HUD 안 보임, 이 finding과 무관) 두 상태 중 재생 중 상태만 `.hudSeason`이 실제로 렌더됨.
- System: 두 곳 다 기존 `"IBM Plex Mono", "Pretendard", monospace"` 패턴을 그대로 재사용했는지 확인(새 폰트 스택 문자열을 새로 만들지 않았는지) - 병행 패턴이 생기면 안 됨.
- Repository: `grep -rn 'IBM Plex Mono", monospace' courtside-web/app/players/[pcode]/player-profile.module.css courtside-web/components/court-hero-expand.module.css` → 두 파일 모두 0건(전부 3단 스택으로 바뀌어 있어야 함).

## Stop conditions

- Stop if `teamNameByTcode`가 실제로는 한글을 포함하지 않는 값만 반환한다는 게 확인되면(예: 항상 2~3글자 영문 팀 코드만 전달) - 이 경우 `.hudSeason` 쪽 수정은 근거가 사라지므로 `.scoringEyebrow` 쪽만 적용하고 보고할 것.

## Design documentation

- After acceptance and validation: 별도 기록 없음(이미 `globals.css:1876-1879`에 이 규칙이 문서화돼 있고, 이번 수정은 그 규칙을 두 곳에 마저 적용한 것일 뿐, 새 결정이 아님).
