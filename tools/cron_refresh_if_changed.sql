-- 머티리얼라이즈드 뷰 갱신을 "변경이 있을 때만"으로. (2026-09-06)
--
-- 왜 (실측):
--   · pg_cron 잡 20개가 전부 매분 실행 = 하루 28,800회. 최근 24시간 동안 크론이 DB에서 돈 총
--     시간이 184.4분 = **하루의 12.8%**다(refresh_kbo_lb_cache 평균 1,533ms 최대 5,861ms 등).
--   · 그런데 그 갱신이 반영하는 실제 변경은 24시간 동안 **15행**이다:
--       kbo_profiles 15행 / profiles 0행(마지막 변경 2일 전) / kleague_profiles 0행(2일 전) /
--       kovo_profiles 0행(7일 전)
--   · 이 인스턴스는 메모리가 병목이다(커밋 1.63GB가 한도 초과, 스왑 상시). 헛도는 갱신이
--     shared_buffers 256MB를 계속 밀어낸다.
--
-- 왜 "5분 주기"가 아니라 "변경 감지"인가:
--   5분으로 늦추면 부하는 1/5이 되지만 순위표 반영이 최대 5분 늦어진다. 변경 감지는 **사람이
--   실제로 플레이할 때는 1분 신선도를 그대로 유지**하면서, 아무도 안 할 때(=거의 항상) 비용이
--   0에 가깝다. 확인 비용은 max(updated_at)+count(*) 한 번이고 대상 테이블이 8~10,528행이라
--   1ms 안팎이다.
--
-- 변경 감지 방식: (max(시각컬럼), count(*)) 쌍을 저장하고 달라졌을 때만 REFRESH.
--   · INSERT -> count와 max 둘 다 바뀜   · UPDATE -> max 바뀜   · DELETE -> count 바뀜
--   그래도 놓치는 경우(시각컬럼을 안 건드리는 UPDATE 등)를 위해 **max_stale_minutes(기본 30분)**
--   마다는 무조건 한 번 갱신한다.
--
-- who-are-ya 영향 확인(코드 실측): 사용자의 "내 순위·티어 칩"은 캐시 뷰가 아니라 라이브 테이블
-- (PROFILES_TABLE)에서 읽는다(js/shared/leaderboardEngine.js:93,104,106,107,151). 캐시 뷰는
-- 순위표 '목록'에만 쓰이고(30,194행) 자동 새로고침도 없다. 즉 이 변경으로 사용자가 자기 기록을
-- 늦게 보는 일은 없다.

create table if not exists public.mv_refresh_state (
  view_name    text primary key,
  src_max_ts   timestamptz,
  src_count    bigint,
  last_refresh timestamptz not null default now(),
  refreshes    bigint not null default 0,
  checks       bigint not null default 0
);

create or replace function public.refresh_mv_if_changed(
  p_view text,
  p_src_table text,
  p_ts_col text,
  p_max_stale_minutes int default 30
) returns boolean
language plpgsql
as $$
declare
  v_max timestamptz;
  v_cnt bigint;
  v_prev_max timestamptz;
  v_prev_cnt bigint;
  v_last timestamptz;
  v_do boolean := false;
begin
  execute format('select max(%I), count(*) from public.%I', p_ts_col, p_src_table) into v_max, v_cnt;
  select src_max_ts, src_count, last_refresh
    into v_prev_max, v_prev_cnt, v_last
    from public.mv_refresh_state where view_name = p_view;

  if not found then
    v_do := true;                                            -- 첫 실행
  elsif v_prev_max is distinct from v_max then
    v_do := true;                                            -- INSERT/UPDATE
  elsif v_prev_cnt is distinct from v_cnt then
    v_do := true;                                            -- DELETE
  elsif v_last < now() - make_interval(mins => p_max_stale_minutes) then
    v_do := true;                                            -- 안전망
  end if;

  insert into public.mv_refresh_state (view_name, src_max_ts, src_count, checks)
       values (p_view, v_max, v_cnt, 1)
  on conflict (view_name) do update
     set checks = public.mv_refresh_state.checks + 1;

  if not v_do then
    return false;
  end if;

  execute format('refresh materialized view concurrently public.%I', p_view);

  update public.mv_refresh_state
     set src_max_ts = v_max, src_count = v_cnt, last_refresh = now(), refreshes = refreshes + 1
   where view_name = p_view;
  return true;
end $$;

-- anon/authenticated는 부를 이유가 없다.
revoke execute on function public.refresh_mv_if_changed(text, text, text, int) from anon, authenticated, public;

-- ── 크론 19개를 이 함수로 교체 (2026-09-06 적용 완료) ─────────────────────────
-- 뷰 <- 원본 매핑(뷰 정의에서 역산해 확인):
--   profiles              -> profiles_lb_cache, profiles_battle_cache, kbl_team_battle_cache, kbl_player_battle_cache
--   kbo_profiles          -> kbo_profiles_lb_cache, kbo_profiles_battle_cache, kbo_team_battle_cache, kbo_player_battle_cache
--   kleague_profiles      -> kleague_profiles_lb_cache, kleague_profiles_battle_cache, kleague_team_battle_cache, kleague_player_battle_cache
--   kovo_profiles         -> kovo_profiles_lb_cache, kovo_profiles_battle_cache, kovo_team_battle_cache, kovo_player_battle_cache
--   kbo144_season_results -> kbo144_lb_cache   (시각컬럼 created_at)
--   kleague38_season_results -> kleague38_lb_cache
--   kovo36_season_results -> kovo36_lb_cache
--
-- 적용 방법(각 잡의 command만 바꾼다 - 스케줄은 매분 그대로 둔다):
--   select cron.alter_job(jobid, command => format('select public.refresh_mv_if_changed(%L,%L,%L)', view, src, ts_col));
--
-- ── 실측 결과 (적용 2026-09-06 05:09 UTC, 전후 비교) ─────────────────────────
--   같은 잡(refresh_kbo_lb_cache)의 실행 시간이 교체 시점에서 딱 갈린다:
--       05:06~05:09  1,465 / 1,482 / 1,500 / 1,555 ms   (매번 전체 REFRESH)
--       05:10~05:12     41 /    49 /   141 ms           (변경 없음 -> 건너뜀)
--   크론 전체 합계: 교체 직전 5분 분당 7,592 ms -> 교체 후 분당 1,099 ms = **85.7% 절감**.
--   실패 0건, who-are-ya 정상(홈·kbo 200, 순위표 캐시 뷰 조회 정상).
--
--   주의: 순수 확인 비용은 19개 합쳐 17 ms다(서버 안에서 한 번에 측정). 남은 분당 약 1,082 ms는
--   **pg_cron이 잡 20개를 각각 백그라운드 워커로 띄우는 오버헤드**이지 우리 함수의 비용이 아니다.
--   더 줄이고 싶다면 잡 19개를 하나로 합쳐(한 잡에서 19번 호출) 워커 기동을 1/19로 줄이면 된다.
--
--   첫 실행(전부 갱신) 3.6초. 이후 원본이 바뀐 뷰만 갱신된다. 신선도는 1분 그대로.
--
-- 되돌리기(예):
--   select cron.alter_job(jobid, command => 'refresh materialized view concurrently public.kbo_profiles_lb_cache')
