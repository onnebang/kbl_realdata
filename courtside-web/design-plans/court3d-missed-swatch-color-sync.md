# 3D 코트 "실패" 범례 색을 실제 마커 색과 동기화

Written against: 8799917d53b6f0f0d2bd219b5dbfe18f71a84625

## Evidence chain

- Surface: `courtside-web/components/CourtHeroExpand.tsx`(3D 코트 모달 하단 범례), `courtside-web/components/Court3DScene.tsx`(실제 슛 마커 렌더링)
- Problem: `Court3DScene.tsx:270`은 실패(미스) 슛 마커의 색을 `0xe7eaf2`(밝은 회백색)로 그린다. 그런데 범례에서 "실패"를 설명하는 `.swatchRing`(`CourtHeroExpand.tsx:142`)의 테두리 색은 `court-hero-expand.module.css:165-172`에 `border: 1.5px solid #9aa0ac;`로 하드코딩돼 있다 - 이번 세션의 가시성 개편(코트 바닥을 밝게 바꾸며 미스 마커도 더 밝게 조정)에서 마커 색은 바뀌었지만 범례 스와치는 같이 바뀌지 않아, 사용자가 범례를 보고 기대하는 색과 실제 코트에서 보이는 색이 서로 다르다.
- Design evidence: 별도 토큰 문서가 아니라 같은 컴포넌트 쌍(`CourtHeroExpand`가 그리는 범례 ↔ `Court3DScene`이 그리는 실제 마커) 안의 내적 모순 - 범례는 정의상 그것이 가리키는 시각 요소와 같은 색이어야 한다("성공" 스와치는 `<span className={styles.swatchFill} style={{ background: accentColor }} />`로 이미 `accentColor` prop을 그대로 재사용해 항상 동기화되도록 만들어져 있다 - `CourtHeroExpand.tsx:139`. "실패" 스와치만 값을 하드코딩해 이 패턴에서 벗어나 있다).
- Owner: 미스 마커의 실제 색은 `Court3DScene.tsx`가 소유(`0xe7eaf2`). 범례는 `court-hero-expand.module.css`가 소유하지만 값은 `Court3DScene.tsx`를 따라가야 한다.
- Scope and affected surfaces: `court-hero-expand.module.css`의 `.swatchRing` 선택자 하나. `CourtHeroExpand`를 호출하는 두 곳(`app/players/[pcode]/page.tsx`의 커리어 3D 코트, `app/teams/[tcode]/page.tsx`의 시즌 3D 코트) 모두 같은 컴포넌트를 공유하므로 함께 고쳐진다.
- Uncertainty: 없음. 두 값(마커 색, 스와치 색) 모두 현재 코드에 리터럴로 존재해 직접 대조 가능.

## Design decision

`.swatchRing`의 하드코딩된 테두리 색을 `Court3DScene.tsx`의 실제 미스 마커 색(`0xe7eaf2` → CSS `#e7eaf2`)과 동일하게 맞춘다. "성공" 스와치처럼 prop으로 전달해 구조적으로 항상 동기화되게 만드는 방법도 있지만, 미스 마커 색은 accentColor와 달리 선수/팀마다 달라지는 값이 아니라 이 컴포넌트가 내부에서 고정으로 쓰는 상수이므로, 두 파일에 있는 리터럴 값을 일치시키는 것으로 문제가 완전히 해결된다 - prop 추가는 이 근본 원인에 비해 과한 변경이다.

## Reuse

- 기존 리터럴 값 그대로 재사용: `Court3DScene.tsx:270`의 `0xe7eaf2`를 CSS 16진값 `#e7eaf2`로 그대로 옮겨 적는다(변환·재계산 없음).
- Exemplar: `CourtHeroExpand.tsx:139`의 `.swatchFill`(성공 스와치) - `accentColor`를 그대로 재사용해 마커와 항상 일치시키는 이미 검증된 동기화 패턴. 이번엔 값이 컴포넌트 내부 상수라 prop화까지는 필요 없지만, "범례는 실제 렌더 값을 그대로 따라간다"는 동일한 원칙을 적용한다.

새 프리미티브 불필요.

## Changes

1. `courtside-web/components/court-hero-expand.module.css:172`
   - Change: `border: 1.5px solid #9aa0ac;` → `border: 1.5px solid #e7eaf2;`
   - Preserve: `.swatchRing`의 나머지 선언(`display`, `width`, `height`, `border-radius`, `margin-right`, `vertical-align`)은 그대로.
   - Verify: 3D 코트 모달을 열어(빌드업 재생이 끝난 뒤든 "건너뛰기"를 누른 뒤든) 실제로 렌더된 미스 마커(밝은 회백색 와이어프레임 구)와 하단 범례의 "실패" 스와치 링 색이 육안으로 같은 톤인지 대조.

## Scope

- Inherit: `CourtHeroExpand`를 쓰는 두 호출부 모두(`app/players/[pcode]/page.tsx`, `app/teams/[tcode]/page.tsx`) - 컴포넌트가 하나라 자동으로 함께 반영됨.
- Verify: 라이트/다크 테마 둘 다 - `.swatchRing`은 테마 토큰이 아니라 고정 리터럴이라 테마와 무관하게 항상 같은 색이어야 하며, 이번 수정 후에도 그 성질은 유지돼야 함(의도적 - 미스 마커 자체가 테마에 안 따라가는 고정 색이므로).
- Exclude: `.swatchFill`(성공 스와치)은 이미 `accentColor`로 정상 동기화돼 있어 범위 밖. 3D 코트 바닥·라인·관중석 등 이번 세션에서 바뀐 다른 색상들은 범례로 표시되는 대상이 아니므로 범위 밖.

## Validation

- Product: 3D 코트 모달을 열어 범례와 실제 마커 색이 일치하는지 확인.
- Interface: `/players/[pcode]`(팀이 하나뿐이거나 여럿이거나 무관 - 미스 마커는 항상 존재) 및 `/teams/[tcode]`의 3D 코트 모달. 재생 중(HUD 보임)과 재생 종료 후(자유 회전) 두 상태 모두에서 범례는 항상 하단에 보이므로 두 상태 다 확인.
- System: 이 수정이 `.swatchFill`의 prop 기반 동기화 패턴을 침범하거나 중복 패턴을 새로 만들지 않는지 확인(그대로 리터럴 값 정정 하나로 끝나야 함).
- Repository: `grep -n "9aa0ac" courtside-web/components/court-hero-expand.module.css` → 0건(이전 값이 더 이상 남아있지 않아야 함), `grep -n "0xe7eaf2" courtside-web/components/Court3DScene.tsx` → 1건(마커 색은 그대로 유지되는지 확인용, 이번 변경으로 건드리지 않음).

## Stop conditions

- Stop if `Court3DScene.tsx`의 미스 마커 색이 이후 다시 바뀐다면(예: 접근성 재검토로 다른 회색톤 채택) - 이 계획은 "지금 시점의 마커 색과 범례를 일치시키는 것"이 목적이므로, 마커 색 자체를 바꾸는 결정은 별도 계획으로 다뤄야 함.

## Design documentation

- After acceptance and validation: 별도 기록 없음(디자인 토큰이나 새 규칙을 만드는 변경이 아니라, 이미 있던 두 값의 불일치를 정정하는 것).
