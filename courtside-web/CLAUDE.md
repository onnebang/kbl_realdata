@AGENTS.md

# courtside-web

KBL 승률 예측 시스템의 **운영 웹앱**(Next.js 16 / React 19 / three.js, Supabase 읽기 전용).
저장소 루트(`kbl_realdata`)는 데이터 수집 파이프라인이고, 이 폴더가 실제 배포되는 사이트다.
전체 프로젝트 맥락은 상위 `../CLAUDE.md` 참고.

## 배포

- **모노레포 주의**: git 루트는 `kbl_realdata`, Next 앱은 `courtside-web/` 안에 있음.
  Vercel GitHub 연동 시 **Root Directory를 반드시 `courtside-web`으로 지정**해야 함
  (`vercel link`를 이 폴더에서 실행하면 자동으로 잡힘). 자세한 절차는 `DEPLOY.md`.
- 환경변수는 딱 2개(`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `.env.local`
  값 그대로). **`tools/.env.supabase`의 `DATABASE_URL`은 여기 절대 넣지 말 것** — RLS 우회
  서버 크리덴셜이고 이 웹앱은 anon key(읽기 전용 RLS)만으로 동작함.

## 구조

- `app/` — Next.js App Router 페이지(games, players, teams, coaches, lineups, leaderboards,
  season-browser, preseason 등)
- `lib/` — 데이터 가공·시각화 모듈. 페이지 하나당 데이터 레이어 파일이 대응하는 패턴
  (예: `playerPageData.ts`+`playerProfile.ts`, `gameLineups.ts`, `court3d.ts`,
  `koreaMap.ts`, `seasonRibbon.ts` 등). 새 시각화 추가 시 이 폴더의 기존 모듈 패턴을 먼저 참고.
- `components/` — React 컴포넌트
- Supabase만 읽고, 데이터 적재/갱신은 전부 저장소 루트의 `tools/` 파이프라인이 담당(이 앱은
  쓰기 경로 없음).
