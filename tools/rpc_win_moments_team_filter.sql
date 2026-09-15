-- season_big_plays/season_comebacks에 선택적 팀 필터(p_tcode) 추가 (2026-09-15)
--
-- 왜: 팀 페이지에 "이 팀의 결정적 순간" 미리보기를 붙이면서(요청: 감독·승부를 가른 순간을
-- 팀 페이지로 자연스럽게 유도), 리그 top-12/top-6에 안 걸리는 팀도 자기 팀 안에서의 최고
-- 장면을 봐야 한다. p_tcode 기본값 null이면 기존 호출(리그 전체)과 완전히 동일 - 시그니처
-- 확장이라 기존 호출부(lib/winMoments.ts)는 그대로 둬도 깨지지 않는다.
create or replace function public.season_big_plays(p_season text, p_limit int default 12, p_tcode text default null)
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
       and (p_tcode is null or g.home_tcode = p_tcode or g.away_tcode = p_tcode)
     order by e.gmkey, (case when e.tcode = g.home_tcode then e.wpa_home else -e.wpa_home end) desc, e.event_order
  ) x
  order by x.wpa desc
  limit p_limit
$$;

create or replace function public.season_comebacks(p_season text, p_limit int default 6, p_tcode text default null)
returns table (
  gmkey text, game_date date, home_tcode text, away_tcode text, final_home int, final_away int, winner_tcode text,
  min_prob double precision, min_quarter text, min_clock_min int, min_clock_sec int, min_home_score int, min_away_score int
)
language sql stable as $$
  with g as (
    select gmkey, game_date, home_tcode, away_tcode, home_score, away_score
      from games
     where season_name = p_season and season_category = '정규시즌' and is_ended and home_score <> away_score
       and (p_tcode is null or home_tcode = p_tcode or away_tcode = p_tcode)
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

revoke execute on function public.season_big_plays(text, int, text) from public, anon, authenticated;
revoke execute on function public.season_comebacks(text, int, text) from public, anon, authenticated;
