-- "승부를 가른 순간" 페이지(/leaderboards/win-contribution)용 함수 4개 (2026-09-15)
--
-- 왜 페이지를 바꾸나(실측):
--   - 선수 시즌 WPA 합계와 시즌 득점의 상관 0.991(25-26, 177명) - 옛 순위표는 사실상 득점 순위였다.
--   - wpa_home이 0이 아닌 비율: 넣은 슛·자유투 91~94% / 실패 슛 11% / 턴오버 9% / 리바운드 2% / 스틸 1% /
--     어시스트 0%. 승률 모델이 점수·시간만 보기 때문에 '승리 기여'가 아니라 '득점이 언제 나왔나'다.
--   - 1점당 WPA(승부 가중)의 홀·짝 경기 분할 상관 0.36(23-24~25-26, 선수-시즌 89개, 반쪽당 200점 이상) - 약하다.
--   이 데이터가 확실히 말할 수 있는 건 '순간'이라, 장면·경기 중심으로 다시 짠다.
--
-- 규칙: 정규시즌 · 종료 경기만(라이브 잠정치 제외). 호출은 서버 전용 키로만 - 맨 아래에서 anon 실행을 회수한다.

-- 1) 시즌 최고의 한 방 - 한 경기에서 가장 큰 장면 하나씩, 득점한 팀 입장의 승률 상승 순.
create or replace function public.season_big_plays(p_season text, p_limit int default 12)
returns table (
  gmkey text, game_date date, event_order int, quarter text, clock_min int, clock_sec int,
  action_code text, pcode text, player_name text, tcode text, home_tcode text, away_tcode text,
  home_score int, away_score int, final_home int, final_away int,
  wpa double precision, prob_after double precision
)
language sql stable as $$
  select * from (
    select distinct on (e.gmkey)
           e.gmkey, g.game_date, e.event_order, e.quarter, e.clock_min::int, e.clock_sec::int,
           e.action_code, e.pcode, p.name, e.tcode, g.home_tcode, g.away_tcode,
           e.home_score, e.away_score, g.home_score, g.away_score,
           (case when e.tcode = g.home_tcode then e.wpa_home else -e.wpa_home end)::double precision as wpa,
           (case when e.tcode = g.home_tcode then e.home_win_prob else 1 - e.home_win_prob end)::double precision as prob_after
      from games g
      join game_events e on e.gmkey = g.gmkey
      left join players p on p.pcode = e.pcode
     where g.season_name = p_season and g.season_category = '정규시즌' and g.is_ended
       and e.pcode is not null and e.wpa_home is not null and e.tcode in (g.home_tcode, g.away_tcode)
     order by e.gmkey, (case when e.tcode = g.home_tcode then e.wpa_home else -e.wpa_home end) desc, e.event_order
  ) x
  order by x.wpa desc
  limit p_limit
$$;

-- 2) 가장 극적인 역전 - 이긴 팀 입장의 경기 중 최저 승률이 낮은 순. PRE(경기 전) 행은 뺀다.
create or replace function public.season_comebacks(p_season text, p_limit int default 6)
returns table (
  gmkey text, game_date date, home_tcode text, away_tcode text, final_home int, final_away int, winner_tcode text,
  min_prob double precision, min_quarter text, min_clock_min int, min_clock_sec int, min_home_score int, min_away_score int
)
language sql stable as $$
  with g as (
    select gmkey, game_date, home_tcode, away_tcode, home_score, away_score
      from games
     where season_name = p_season and season_category = '정규시즌' and is_ended and home_score <> away_score
  ), low as (
    select distinct on (e.gmkey)
           e.gmkey, e.quarter, e.clock_min, e.clock_sec, e.home_score, e.away_score,
           (case when g.home_score > g.away_score then e.home_win_prob else 1 - e.home_win_prob end)::double precision as prob
      from game_events e join g on g.gmkey = e.gmkey
     where e.home_win_prob is not null and e.quarter <> 'PRE'
     order by e.gmkey, (case when g.home_score > g.away_score then e.home_win_prob else 1 - e.home_win_prob end), e.event_order
  )
  select g.gmkey, g.game_date, g.home_tcode, g.away_tcode, g.home_score, g.away_score,
         case when g.home_score > g.away_score then g.home_tcode else g.away_tcode end,
         low.prob, low.quarter, low.clock_min::int, low.clock_sec::int, low.home_score, low.away_score
    from low join g on g.gmkey = low.gmkey
   order by low.prob, g.game_date
   limit p_limit
$$;

-- 3) 경기 승률 곡선(홈 기준) - 카드 미니 곡선용. 30초 칸마다 마지막 값 하나(경기당 ~90점).
--    경과초: Q1~Q4 600초씩, 연장 X1~X4 300초씩(lib/postgameReport.ts cumulativeElapsed와 같은 정의).
--    **경기당 1행(jsonb 배열)으로 돌려준다** - 점 단위 행으로 주면 18경기 ≈ 1,460행이 PostgREST 응답 상한 1,000행에서
--    조용히 잘려 카드 곡선이 비었다(첫 배포에서 실제로 겪음).
drop function if exists public.game_winprob_series(text[]);
create or replace function public.game_winprob_series(p_gmkeys text[])
returns table (gmkey text, points jsonb)
language sql stable as $$
  with ev as (
    select e.gmkey, e.event_order, e.home_win_prob,
           (case e.quarter when 'Q1' then 0 when 'Q2' then 600 when 'Q3' then 1200 when 'Q4' then 1800
                           when 'X1' then 2400 when 'X2' then 2700 when 'X3' then 3000 when 'X4' then 3300 end)
           + (case when e.quarter like 'Q%' then 600 else 300 end) - (coalesce(e.clock_min, 0) * 60 + coalesce(e.clock_sec, 0)) as elapsed
      from game_events e
     where e.gmkey = any(p_gmkeys) and e.home_win_prob is not null
       and e.quarter in ('Q1','Q2','Q3','Q4','X1','X2','X3','X4')
  )
  , bucket as (
    select distinct on (gmkey, elapsed / 30) gmkey, elapsed, home_win_prob
      from ev
     order by gmkey, elapsed / 30, event_order desc
  )
  select gmkey, jsonb_agg(jsonb_build_array(elapsed, round(home_win_prob::numeric, 4)) order by elapsed)
    from bucket
   group by gmkey
$$;

-- 4) 득점의 무게 - 선수별 시즌 득점과 WPA(득점한 팀 입장). 둘 다 같은 이벤트에서 세서 기준이 같다.
--    소속은 그 시즌 득점 이벤트가 가장 많은 팀.
create or replace function public.season_scoring_weight(p_season text, p_min_pts int default 200)
returns table (pcode text, player_name text, tcode text, games int, pts int, wpa double precision)
language sql stable as $$
  with ev as (
    select e.pcode, e.tcode, e.gmkey,
           case e.action_code when '205' then 3 when '203' then 1 else 2 end as pts,
           case when e.tcode = g.home_tcode then e.wpa_home else -e.wpa_home end as wpa
      from games g join game_events e on e.gmkey = g.gmkey
     where g.season_name = p_season and g.season_category = '정규시즌' and g.is_ended
       and e.action_code in ('201', '203', '205', '207') and e.pcode is not null and e.wpa_home is not null
       and e.tcode in (g.home_tcode, g.away_tcode)
  ), team as (
    select distinct on (pcode) pcode, tcode from ev group by pcode, tcode order by pcode, count(*) desc, tcode
  )
  select ev.pcode, p.name, team.tcode, count(distinct ev.gmkey)::int, sum(ev.pts)::int, sum(ev.wpa)::double precision
    from ev join team on team.pcode = ev.pcode left join players p on p.pcode = ev.pcode
   group by ev.pcode, p.name, team.tcode
  having sum(ev.pts) >= p_min_pts
$$;

revoke execute on function public.season_big_plays(text, int) from public, anon, authenticated;
revoke execute on function public.season_comebacks(text, int) from public, anon, authenticated;
revoke execute on function public.game_winprob_series(text[]) from public, anon, authenticated;
revoke execute on function public.season_scoring_weight(text, int) from public, anon, authenticated;
