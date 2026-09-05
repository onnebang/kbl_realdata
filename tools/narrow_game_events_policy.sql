-- game_events 공개 읽기 정책을 "아직 끝나지 않은 경기"로 좁힌다. (2026-09-06)
--
-- 왜: 오픈 전 감사(high)에서 확인된 가장 쉬운 유출 경로. 브라우저 청크에 실리는 공개 키로
--   GET /rest/v1/game_events?select=*&order=gmkey,event_order&offset=N  을 1,000행씩 돌리면
-- 15시즌 240만 행(home_win_prob / wpa_home / objective_prob = 우리 모델 출력 포함)이 무인증으로
-- 통째로 내려온다. 코드가 실제로 브라우저에서 필요로 하는 건 **진행 중인 경기 하나**뿐이다
-- (lib/useLiveGame.ts:165/174 realtime filter gmkey=eq, :231 폴링 gmkey=eq).
--
-- 종료 경기 리플레이/AI 리포트는 서버(service_role)가 렌더하므로 영향 없다.
-- Realtime postgres_changes도 같은 RLS를 따르므로 라이브 중계는 그대로 동작한다.
-- 예정 경기(is_ended=false/NULL)의 event_order=0 경기 전 행도 계속 읽힌다(coalesce).
--
-- 실행 전 확인: 프로덕션 /api/health 가 readyForLockdown:true (서버가 service_role).
begin;
create policy "public read live game_events" on public.game_events
  for select to anon, authenticated
  using (exists (select 1 from public.games g
                  where g.gmkey = game_events.gmkey and coalesce(g.is_ended, false) = false));
drop policy "public read game_events" on public.game_events;
commit;

-- 검증(공개 키로): 종료 경기 → [] , 예정/진행 경기 → 행 있음
--   curl "$URL/rest/v1/game_events?select=gmkey&gmkey=eq.S47G01N1&limit=3" -H "apikey: $ANON"   -> []
--   curl "$URL/rest/v1/game_events?select=gmkey&gmkey=eq.<26-27 gmkey>&limit=3" -H "apikey: $ANON" -> [{...}]
--   curl "$URL/rest/v1/game_events?select=gmkey,home_win_prob&limit=3" -H "apikey: $ANON"      -> 예정 경기 행만
-- 그리고 라이브 경기 페이지(진행 중일 때)의 문자중계가 갱신되는지.
--
-- 롤백:
--   begin;
--   create policy "public read game_events" on public.game_events for select using (true);
--   drop policy "public read live game_events" on public.game_events;
--   commit;
