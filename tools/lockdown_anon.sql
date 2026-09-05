-- 공개(anon) 키가 볼 수 있는 범위를 라이브 문자중계에 필요한 것만으로 좁힌다. (2026-09-05)
--
-- ============================================================================
-- 실행 전에 반드시 확인할 것 - 순서를 어기면 사이트 전체가 읽기 불가가 된다
-- ============================================================================
--   1) courtside-web 배포에 SUPABASE_SERVICE_ROLE_KEY 환경변수가 들어가 있어야 한다.
--      없으면 lib/supabaseServer.ts가 공개 키로 폴백하고, 이 스크립트가 그 키를 막는 순간
--      서버 렌더가 전부 빈 화면이 된다.
--   2) 확인 방법: **프로덕션 도메인**의 /api/health 가 {"usingServerKey":true,"vercelEnv":"production"}
--      을 답해야 한다. 로그의 문구로 판단하지 마라 - 2026-09-05에 로그의 긍정 문구를 믿고 이
--      스크립트를 실행했다가 프로덕션 런타임은 여전히 공개 키여서(다른 배포/빌드의 로그였다)
--      사이트가 500/404/빈화면이 됐고, 아래 롤백 블록으로 즉시 되돌렸다. Vercel 환경변수는
--      추가 이후 만들어진 배포에만 들어가고 Production 스코프 체크가 따로 있다.
--   3) 이 스크립트는 코트사이드(KBL) 자산만 건드린다. kbo/kleague/kovo/kbl540/profiles 계열은
--      다른 앱의 것이라 손대지 않는다(아래 4절에 목록만 남겼다).
--
-- 왜 필요한가 (실측 2026-09-05):
--   프로덕션 청크에서 공개 키를 꺼내 PostgREST와 Realtime에 직접 붙는 것이 실증됐고,
--   정책이 전 테이블 `using (true)`라 240만 행 플레이바이플레이를 포함한 DB 전체가 읽힌다.
--   코드 쪽에서 키가 실리는 라우트는 0개로 줄였지만, 진행 중인 경기 페이지에서는 여전히
--   브라우저로 나가야 한다(문자중계). 그래서 그 키가 볼 수 있는 것을 줄이는 게 남은 절반이다.
--
-- 브라우저가 실제로 읽는 것은 세 테이블뿐이다(lib/useLiveGame.ts 전수 확인):
--   game_events(gmkey로 좁힘) · games(스코어/종료 여부) · players(pcode -> 이름)
--
-- 되돌리는 법: 4절의 롤백 블록.

begin;

-- ---------------------------------------------------------------------------
-- 1. 라이브 중계에 필요한 세 테이블은 그대로 둔다 (확인만)
-- ---------------------------------------------------------------------------
-- games / game_events / players 의 "public read" 정책은 유지한다.
-- 이 셋은 그대로 공개된다 - 완벽히 막을 수 없다는 전제를 지키되, 나머지를 닫는다.

-- ---------------------------------------------------------------------------
-- 2. 나머지 코트사이드 테이블의 공개 읽기 정책을 서버 전용으로 (SELECT 정책 삭제)
-- ---------------------------------------------------------------------------
-- service_role은 RLS를 우회하므로 정책이 없어도 서버는 그대로 읽는다.
-- 정책만 지우고 RLS는 켠 채로 둔다(테이블은 계속 보호된다).
do $$
declare
  t text;
  p text;
  keep constant text[] := array['games', 'game_events', 'players'];
  targets constant text[] := array[
    'teams', 'coaches', 'seasons', 'action_codes',
    'game_team_stats', 'game_player_stats', 'shot_log', 'lineup_stints',
    'pregame_features', 'lineup_combo', 'player_onoff', 'player_season_wpa',
    'game_summary_tags', 'xpts_zone_table', 'player_win_impact',
    'season_roster', 'roster_changes', 'roster_departure',
    'import_slot_season', 'import_rule_season',
    'departure_impact_team', 'departure_impact_player',
    'strength_adjustment_team', 'strength_adjustment_player',
    -- 2026-09-05 추가(시즌 에이스 국적). build_player_nationality.py가 만드는 공개 읽기 정책은
    -- 다른 테이블들과 같은 초기 상태이고, 닫는 건 이 스크립트 한 곳이 맡는다.
    'player_nationality'
  ];
begin
  foreach t in array targets loop
    if t = any(keep) then continue; end if;
    -- 그 테이블이 실제로 있을 때만
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = t and c.relkind = 'r') then
      raise notice '건너뜀(없음): %', t;
      continue;
    end if;
    for p in select policyname from pg_policies
              where schemaname = 'public' and tablename = t and cmd = 'SELECT' loop
      execute format('drop policy %I on public.%I', p, t);
      raise notice '삭제: %.%', t, p;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 3. RLS를 걸 수 없는 코트사이드 뷰 - 권한 자체를 회수한다
-- ---------------------------------------------------------------------------
-- 뷰/머티리얼라이즈드 뷰에는 RLS가 적용되지 않으므로 정책이 아니라 revoke가 답이다.
revoke select on public.seasons_with_regular_games from anon, authenticated;
-- 코드 참조 0건인 죽은 노출면(전수 grep 확인).
revoke select on public.team_season_running_avg from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. 코트사이드 RPC - 브라우저는 하나도 부르지 않는다
-- ---------------------------------------------------------------------------
-- Postgres는 함수 생성 시 EXECUTE를 PUBLIC에 기본 GRANT한다. 우리 코드가 부르는 6개는
-- 전부 서버에서만 호출된다(app/·lib/ 전수 grep).
-- get_kbl540_sim_stats는 다른 앱(kbl540)의 것이라 건드리지 않는다.
revoke execute on function public.player_clutch_profile from anon, authenticated, public;
revoke execute on function public.player_season_percentile_pool from anon, authenticated, public;
revoke execute on function public.season_zone_mix from anon, authenticated, public;
revoke execute on function public.team_best_units from anon, authenticated, public;
revoke execute on function public.team_season_four_factors from anon, authenticated, public;
revoke execute on function public.team_season_roster from anon, authenticated, public;
-- 2026-09-06: 창 인자가 붙어 시그니처가 (text, int)로 바뀌었다(tools/rpc_form_index_v2.sql).
revoke execute on function public.form_index_season(text, int) from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 5. 쓰기 권한 정리 - 지금도 RLS가 막고 있지만, grant 자체를 없애 이중으로
-- ---------------------------------------------------------------------------
-- (확인됨: 54개 테이블에 INSERT/UPDATE/DELETE grant가 있으나 RLS 정책이 전부 auth.uid()
--  스코프라 실제로는 쓸 수 없다. 그래도 "정책 하나 실수"에 기대지 않도록 grant를 없앤다.)
do $$
declare t text;
begin
  foreach t in array array[
    'teams','coaches','seasons','action_codes','games','game_events',
    'game_team_stats','game_player_stats','shot_log','lineup_stints','players',
    'pregame_features','lineup_combo','player_onoff','player_season_wpa',
    'game_summary_tags','xpts_zone_table','player_win_impact',
    'season_roster','roster_changes','roster_departure',
    'import_slot_season','import_rule_season',
    'departure_impact_team','departure_impact_player',
    'strength_adjustment_team','strength_adjustment_player',
    'player_nationality'
  ] loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
                where n.nspname='public' and c.relname=t and c.relkind='r') then
      execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

commit;

-- ---------------------------------------------------------------------------
-- 검증 (커밋 후 실행)
-- ---------------------------------------------------------------------------
-- select c.relname, has_table_privilege('anon', c.oid, 'SELECT') as anon_select
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--  where n.nspname = 'public' and c.relkind = 'r'
--    and c.relname in ('games','game_events','players','game_player_stats','shot_log')
--  order by 1;
-- -> games/game_events/players 는 true(정책 있음), 나머지는 정책이 없어 실제 조회가 0행이 된다.
--    (has_table_privilege는 grant만 보므로 true로 나올 수 있다 - 실제 확인은 anon 키로
--     curl "$URL/rest/v1/game_player_stats?select=gmkey&limit=1" -H "apikey: $KEY" 가 []인지.)

-- ---------------------------------------------------------------------------
-- 롤백
-- ---------------------------------------------------------------------------
-- 2절로 지운 정책을 되살리려면 (테이블 이름만 바꿔 반복):
--   create policy "public read game_player_stats" on public.game_player_stats for select using (true);
-- 3절:
--   grant select on public.seasons_with_regular_games to anon, authenticated;
-- 4절:
--   grant execute on function public.player_clutch_profile to anon, authenticated;

-- ===========================================================================
-- 이 스크립트가 건드리지 않은 것 - 다른 앱 소유라 확인이 필요하다
-- ===========================================================================
-- RLS를 걸 수 없는 머티리얼라이즈드 뷰 19개가 anon SELECT로 열려 있고, 그중에는 다른
-- 프로젝트 사용자의 UUID·닉네임·응원팀이 들어 있다:
--   kbo_profiles_lb_cache, kbo_profiles_battle_cache, profiles_lb_cache,
--   profiles_battle_cache, kleague_profiles_lb_cache, kleague_profiles_battle_cache,
--   kovo_profiles_lb_cache, kovo_profiles_battle_cache, kbo144_lb_cache,
--   kleague38_lb_cache, kovo36_lb_cache, 그리고 각 리그의 player/team battle 캐시.
-- 이 뷰들을 kbo/kleague/kovo/kbl540 앱이 공개 키로 직접 읽고 있다면 revoke가 그 앱들을
-- 깨뜨린다. 그래서 여기서는 손대지 않았다. 그 앱들도 서버에서만 읽는다면:
--   revoke select on public.kbo_profiles_lb_cache from anon, authenticated;  -- 등
-- 을 같은 방식으로 적용하면 된다.
