-- 뷰 갱신 크론 19개를 잡 1개로 합친다. (2026-09-06)
--
-- 왜: 변경 감지로 바꾼 뒤 실측하니 분당 7,592ms -> 1,099ms였는데, 순수 확인 비용은 19개 합쳐
-- **17ms**다. 남은 1,082ms는 전부 **pg_cron이 잡 19개를 각각 백그라운드 워커로 띄우는 오버헤드**다
-- (워커 하나당 약 57ms: 프로세스 기동 + DB 접속 + 로그 행 삽입). 잡을 하나로 합치면 워커 기동이
-- 1/19이 되고, 그 안에서 19번 호출하는 건 17ms면 끝난다.
--
-- 덤: cron.job_run_details 증가율도 1/19이 된다(하루 27,360행 -> 1,440행).

create or replace function public.refresh_all_leaderboard_mvs() returns int
language plpgsql
as $$
declare
  v_refreshed int := 0;
  r record;
begin
  for r in
    select * from (values
      -- 뷰,                              원본 테이블,               시각 컬럼
      ('profiles_lb_cache',              'profiles',                'updated_at'),
      ('profiles_battle_cache',          'profiles',                'updated_at'),
      ('kbl_team_battle_cache',          'profiles',                'updated_at'),
      ('kbl_player_battle_cache',        'profiles',                'updated_at'),
      ('kbo_profiles_lb_cache',          'kbo_profiles',            'updated_at'),
      ('kbo_profiles_battle_cache',      'kbo_profiles',            'updated_at'),
      ('kbo_team_battle_cache',          'kbo_profiles',            'updated_at'),
      ('kbo_player_battle_cache',        'kbo_profiles',            'updated_at'),
      ('kleague_profiles_lb_cache',      'kleague_profiles',        'updated_at'),
      ('kleague_profiles_battle_cache',  'kleague_profiles',        'updated_at'),
      ('kleague_team_battle_cache',      'kleague_profiles',        'updated_at'),
      ('kleague_player_battle_cache',    'kleague_profiles',        'updated_at'),
      ('kovo_profiles_lb_cache',         'kovo_profiles',           'updated_at'),
      ('kovo_profiles_battle_cache',     'kovo_profiles',           'updated_at'),
      ('kovo_team_battle_cache',         'kovo_profiles',           'updated_at'),
      ('kovo_player_battle_cache',       'kovo_profiles',           'updated_at'),
      ('kbo144_lb_cache',                'kbo144_season_results',   'created_at'),
      ('kleague38_lb_cache',             'kleague38_season_results','created_at'),
      ('kovo36_lb_cache',                'kovo36_season_results',   'created_at')
    ) as t(view_name, src_table, ts_col)
  loop
    -- 뷰 하나가 실패해도 나머지는 갱신되어야 한다. 실패는 삼키지 않고 경고로 남긴다.
    begin
      if public.refresh_mv_if_changed(r.view_name, r.src_table, r.ts_col) then
        v_refreshed := v_refreshed + 1;
      end if;
    exception when others then
      raise warning 'refresh_mv_if_changed(%) 실패: %', r.view_name, sqlerrm;
    end;
  end loop;
  return v_refreshed;
end $$;

revoke execute on function public.refresh_all_leaderboard_mvs() from anon, authenticated, public;
