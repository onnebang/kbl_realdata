-- 슈팅 리포트 "KBL 슛의 15년" 탭용 함수 2개 (2026-09-15)
--
-- 이야기(실측, 정규시즌):
--   박스스코어 기준 3점 비중 27.8%(11-12) → 40.3%(25-26). 그런데 야투 1개당 득점은 15시즌 내내 0.99~1.06 사이에서
--   오르내릴 뿐 추세가 없다(3P% 31.5~34.6%, 2P% 50.1~53.8%, 공격 효율 106.7~113.8). "3점은 1.5배가 됐는데 효율은 그대로".
--
-- 출처를 나눈 이유:
--   - 3점/2점 시도·성공은 **박스스코어(game_team_stats)** - 좌표와 무관하다(fga는 2점만, 3점은 tpa).
--   - 2점 안에서 페인트존/중거리를 가르는 것만 **shot_log 좌표**(3m 기준).
--   - 골밑(1.2m)과 근거리를 따로 두지 않는다: 2017-18에 좌표 기록 방식이 바뀐 흔적이 있다 - 슛은 늘었는데 서로 다른
--     좌표 수가 24,870 → 22,379로 줄고, 0.5m 이내 기록이 1.8% → 4.8%로 세 배가 됐는데 골밑 성공률은 67.8 → 66.9%로
--     내렸다(정말 가까이서 던졌다면 올라야 한다). 1.2m 경계 부근 슛이 더 가깝게 찍히기 시작한 것으로 보여, 3m 안을
--     '페인트존' 하나로 합친다(합친 비중은 45.4% → 47.7%로 안정).
--   좌표 공식은 rpc_form_index_v2.sql과 같다: HOOP=(681,205) if d='1' else (69,205), 0.0413 m/unit, 3점 6.75m.

create or replace function public.league_shot_trend()
returns table (
  season_name text, team_games int,
  fga2 int, fgm2 int, fga3 int, fgm3 int, fta int, pts int, poss double precision,
  paint_a int, paint_m int, mid_a int, mid_m int
)
language sql stable as $$
  with box as (
    select g.season_name, count(*)::int team_games,
           sum(t.fga)::int fga2, sum(t.fgm)::int fgm2, sum(t.tpa)::int fga3, sum(t.tpm)::int fgm3,
           sum(t.fta)::int fta, sum(t.score)::int pts, sum(t.poss)::double precision poss
      from game_team_stats t join games g on g.gmkey = t.gmkey
     where g.season_category = '정규시즌' and g.is_ended
     group by 1
  ), zones as (
    select g.season_name,
           count(*) filter (where z.dist < 3.0)::int paint_a,
           count(*) filter (where z.dist < 3.0 and z.made)::int paint_m,
           count(*) filter (where z.dist >= 3.0 and z.dist < 6.75)::int mid_a,
           count(*) filter (where z.dist >= 3.0 and z.dist < 6.75 and z.made)::int mid_m
      from (
        select s.gmkey, s.made, sqrt(power(s.x - (case when s.d = '1' then 681 else 69 end), 2) + power(s.y - 205, 2)) * 0.0413 as dist
          from shot_log s
      ) z join games g on g.gmkey = z.gmkey
     where g.season_category = '정규시즌' and g.is_ended
     group by 1
  )
  select box.season_name, box.team_games, box.fga2, box.fgm2, box.fga3, box.fgm3, box.fta, box.pts, box.poss,
         coalesce(zones.paint_a, 0), coalesce(zones.paint_m, 0), coalesce(zones.mid_a, 0), coalesce(zones.mid_m, 0)
    from box left join zones on zones.season_name = box.season_name
   order by box.season_name
$$;

create or replace function public.season_team_shot_profile(p_season text)
returns table (
  tcode text, team_games int,
  fga2 int, fgm2 int, fga3 int, fgm3 int, pts int, poss double precision,
  paint_a int, paint_m int, mid_a int, mid_m int
)
language sql stable as $$
  with box as (
    select t.tcode, count(*)::int team_games,
           sum(t.fga)::int fga2, sum(t.fgm)::int fgm2, sum(t.tpa)::int fga3, sum(t.tpm)::int fgm3,
           sum(t.score)::int pts, sum(t.poss)::double precision poss
      from game_team_stats t join games g on g.gmkey = t.gmkey
     where g.season_name = p_season and g.season_category = '정규시즌' and g.is_ended
     group by 1
  ), zones as (
    select z.tcode,
           count(*) filter (where z.dist < 3.0)::int paint_a,
           count(*) filter (where z.dist < 3.0 and z.made)::int paint_m,
           count(*) filter (where z.dist >= 3.0 and z.dist < 6.75)::int mid_a,
           count(*) filter (where z.dist >= 3.0 and z.dist < 6.75 and z.made)::int mid_m
      from (
        select s.tcode, s.made, sqrt(power(s.x - (case when s.d = '1' then 681 else 69 end), 2) + power(s.y - 205, 2)) * 0.0413 as dist
          from shot_log s join games g on g.gmkey = s.gmkey
         where g.season_name = p_season and g.season_category = '정규시즌' and g.is_ended
      ) z
     group by 1
  )
  select box.tcode, box.team_games, box.fga2, box.fgm2, box.fga3, box.fgm3, box.pts, box.poss,
         coalesce(zones.paint_a, 0), coalesce(zones.paint_m, 0), coalesce(zones.mid_a, 0), coalesce(zones.mid_m, 0)
    from box left join zones on zones.tcode = box.tcode
$$;

revoke execute on function public.league_shot_trend() from public, anon, authenticated;
revoke execute on function public.season_team_shot_profile(text) from public, anon, authenticated;
