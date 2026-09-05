-- 폼 지수 v2 - 창 크기를 인자로 받고, 100슛당 비교가 가능하도록. (2026-09-06)
--
-- 왜 바꾸나 (사용자 제보 + 실측):
--   제보: "최근 5경기만 보여주다 보니 시즌 종결자인 자밀 워니가 폼이 안 좋게 나온다.
--          최근 1/3/5경기도 좋지만 시즌별 데이터처럼 더 다양하게 보여줘야 할 것 같다."
--
--   창을 넓히는 것만으로는 해결되지 않는다(실측): 워니는 W=5에서 92명 중 92위,
--   W=10에서 125명 중 125위, **시즌 전체에서도 152명 중 146위**다. 창은 원인이 아니었다.
--
--   진짜 원인은 지표가 **정규화되지 않은 원시 합계**라는 것이다. 25-26 정규시즌에서 100시도
--   이상 101명을 재보면 워니는 시도 1,091개로 전체 1위인데(2위와 큰 차이), 합계 −31.6으로
--   90위다. 같은 값을 100슛당으로 바꾸면 −2.89로 **62위**가 된다. 반대로 양홍석(237시도,
--   −21.4/100슛)·문정현(334시도, −22.2/100슛)은 합계로는 워니와 비슷해 보이지만 효율로는
--   훨씬 나쁘다. 즉 원시 합계는 "많이 던진 사람"과 "못 던진 사람"을 구분하지 못한다.
--
--   그래서 이 버전은 (a) 창을 인자로 받아 1/3/5/10경기와 시즌 전체를 모두 볼 수 있게 하고,
--   (b) attempts를 그대로 돌려줘 화면이 100슛당으로 정규화할 수 있게 한다.
--   ("75포제션"도 검토했지만 game_team_stats.poss 기준 주전 75포제션 ≈ 1.1경기라 지금 창보다
--    오히려 좁아진다. 사용자가 원한 건 창이 아니라 볼륨 보정이라고 판단했다.)
--
-- 계산 규칙은 v1과 한 글자도 다르지 않다(존 경계·상수·결장 포함 규칙 전부 동일):
--     HOOP_RIGHT = (681, 205) when d = '1' else HOOP_LEFT = (69, 205)
--     SCALE_M_PER_UNIT = 0.0413,  THREE_PT_M = 6.75
--     zone: [0,1.2) rim / [1.2,3.0) close / [3.0,5.0) midShort / [5.0,6.75) midLong / [6.75,) three
--     value = (dist >= 6.75 ? 3 : 2)
--
-- **먼저 옛 함수를 지운다.** create or replace로 인자를 추가하면 1-인자 함수가 그대로 남아
-- 오버로드가 둘이 되고, PostgREST가 인자 이름으로 함수를 고르다 PGRST203(ambiguous)을 낸다.
drop function if exists public.form_index_season(text);

create or replace function form_index_season(p_season text, p_window int default 5)
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
  -- 선수별 그 시즌 경기(결장 포함)를 최신순으로. gmkey를 2차 키로 둬 같은 날 두 경기가 있어도
  -- 결과가 흔들리지 않게 한다.
  select gps.pcode,
         gps.gmkey,
         g.game_date,
         row_number() over (partition by gps.pcode order by g.game_date desc, gps.gmkey desc) as rn
    from game_player_stats gps
    join games g on g.gmkey = gps.gmkey
   where g.season_name = p_season
),
win as (
  -- p_window <= 0 이면 시즌 전체(창 제한 없음).
  select * from ranked where p_window <= 0 or rn <= p_window
),
elig as (
  select w.pcode,
         count(*)::int as games,
         max(w.game_date) as last_game_date
    from win w
   group by w.pcode
  -- 최소 경기 수는 창 크기에 비례해야 한다. 창이 1경기인데 3경기를 요구하면 아무도 안 남는다.
  having count(*) >= least(3, greatest(1, case when p_window <= 0 then 3 else p_window end))
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
-- 최소 시도수도 창에 비례한다. 5경기 기준 15개를 창 1경기에 그대로 요구하면 표가 비어버린다.
having count(*) >= case when p_window <= 0 then 60 else greatest(4, p_window * 3) end;
$$;

-- 웹은 서버 전용 키로만 부른다. anon EXECUTE 회수는 tools/lockdown_anon.sql이 맡는다
-- (여기서 회수하면 배포가 아직 공개 키로 폴백 중일 때 폼 지수 페이지가 500이 된다 - 실제로 겪었다).
-- 락다운을 이미 적용한 뒤라면 이 파일을 실행한 다음 아래를 한 번 더 돌려야 한다:
--   revoke execute on function public.form_index_season(text, int) from anon, authenticated, public;
