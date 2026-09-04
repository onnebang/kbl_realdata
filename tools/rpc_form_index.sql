-- 폼 지수(최근 5경기 슛 질 대비 결과) 집계를 Postgres로 내린다. (2026-09-05)
--
-- 왜: courtside-web/lib/formIndex.ts가 이 계산을 웹에서 했다. 실측(감사) 프로덕션 11초,
--     53왕복, 48,469행, 5.2MB. 그중 shot_log 37,621행을 1,000행씩 38번 받는데 실제로 쓰는 건
--     4,068행(89% 낭비)이다. 같은 집계를 여기서 하면 1왕복 92행 168ms다.
--
-- 이 함수는 lib/formIndex.ts의 classifyShot과 **한 글자도 다르면 안 된다.** 옮겨 온 상수:
--     HOOP_RIGHT = (681, 205) when d = '1' else HOOP_LEFT = (69, 205)
--     SCALE_M_PER_UNIT = 0.0413,  THREE_PT_M = 6.75
--     zone: [0,1.2) rim / [1.2,3.0) close / [3.0,5.0) midShort / [5.0,6.75) midLong / [6.75,) three
--     value = (dist >= 6.75 ? 3 : 2)
--     ROLLING_WINDOW = 5, MIN_RECENT_GAMES = 3, MIN_ATTEMPTS = 15
--
-- 그대로 옮긴 두 가지 규칙(바꾸면 값이 달라진다):
--   1) "최근 5경기"는 game_player_stats 행 기준이라 **결장(min_played=0) 경기도 포함**한다.
--      TS 쪽이 min_played를 안 보므로 여기서도 보지 않는다.
--   2) 대표 팀은 그 시즌 그 선수가 가장 많이 뛴 팀(mode). 동률이면 tcode 오름차순으로 고정 -
--      TS 쪽은 Map 순회 순서에 의존해 비결정적이었다. 이쪽이 더 낫고, 실측상 동률 사례는 없다.
--
-- SECURITY INVOKER(기본)로 둔다 - 호출자의 RLS를 그대로 따른다. anon EXECUTE는
-- tools/lockdown_anon.sql이 회수한다(웹은 서버에서만 부른다).

create or replace function form_index_season(p_season text)
returns table (
  pcode text,
  player_name text,
  tcode text,
  games int,
  attempts bigint,
  actual_pts bigint,
  expected_pts numeric,
  last_game_date date
)
language sql
stable
as $$
with ranked as (
  -- 선수별 그 시즌 경기(결장 포함)를 최신순으로. gmkey를 2차 키로 둬서 같은 날 두 경기가
  -- 있어도 결과가 흔들리지 않게 한다.
  select gps.pcode,
         gps.gmkey,
         g.game_date,
         row_number() over (partition by gps.pcode order by g.game_date desc, gps.gmkey desc) as rn
    from game_player_stats gps
    join games g on g.gmkey = gps.gmkey
   where g.season_name = p_season
),
win as (
  select * from ranked where rn <= 5            -- ROLLING_WINDOW
),
elig as (
  select w.pcode,
         count(*)::int as games,
         max(w.game_date) as last_game_date
    from win w
   group by w.pcode
  having count(*) >= 3                          -- MIN_RECENT_GAMES
),
shots as (
  select w.pcode,
         s.made,
         sqrt(power(s.x - (case when s.d = '1' then 681 else 69 end), 2)
            + power(s.y - 205, 2)) * 0.0413 as dist
    from win w
    join elig e on e.pcode = w.pcode
    join shot_log s on s.gmkey = w.gmkey and s.pcode = w.pcode
),
zoned as (
  select sh.pcode,
         sh.made,
         case when sh.dist < 1.2  then 'rim'
              when sh.dist < 3.0  then 'close'
              when sh.dist < 5.0  then 'midShort'
              when sh.dist < 6.75 then 'midLong'
              else 'three' end as zone,
         case when sh.dist >= 6.75 then 3 else 2 end as val
    from shots sh
),
team_mode as (
  select t.pcode, t.tcode from (
    select gps.pcode, gps.tcode,
           row_number() over (partition by gps.pcode order by count(*) desc, gps.tcode) as rn
      from game_player_stats gps
      join games g on g.gmkey = gps.gmkey
     where g.season_name = p_season
     group by gps.pcode, gps.tcode
  ) t where t.rn = 1
)
select z.pcode,
       p.name as player_name,
       tm.tcode,
       e.games,
       count(*) as attempts,
       sum(case when z.made then z.val else 0 end)::bigint as actual_pts,
       sum(x.expected_pts_per_shot) as expected_pts,
       e.last_game_date
  from zoned z
  join elig e on e.pcode = z.pcode
  join xpts_zone_table x on x.zone = z.zone
  left join players p on p.pcode = z.pcode
  left join team_mode tm on tm.pcode = z.pcode
 group by z.pcode, p.name, tm.tcode, e.games, e.last_game_date
having count(*) >= 15;                          -- MIN_ATTEMPTS
$$;

-- 웹은 서버에서만 부른다. 다만 EXECUTE 회수는 **여기서 하지 않는다** - 배포가 아직 공개 키로
-- 폴백 중이면 그 순간 폼 지수 페이지가 500이 된다(실제로 겪었다). 회수는 순서를 지키는
-- tools/lockdown_anon.sql이 다른 RPC들과 함께 맡는다.
