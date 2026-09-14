# -*- coding: utf-8 -*-
"""감독 프로필 집계 3종(정규시즌·감독-시즌 단위) - courtside-web lib/coachPage.ts가 읽는다.

    python tools/build_coach_profile.py

측정 워크플로우 결과(scratchpad/coach_results/coach_r10·r23·r22)의 definition·sql을 그대로 옮긴 것.
  coach_season_record   : F. 승/패·득실·넷마진(+홈/원정 원자료). verdict weak - '감독 효과' 아님.
  coach_season_style    : D. 포팩터 8축 원값 + 시즌 내 10팀 z(+리그 평균). 레이더 6축은 웹이 고른다.
  coach_challenge_usage : E. 챌린지(229) 사용 성향(2025-26 12/4 이후 187경기 윈도). 성공률·WPA 없음.
  coach_challenge_league: E. 같은 윈도의 리그 요약 한 줄.
  coach_timeout_tendency: 작전타임 '호출 성향'(2026-09-15). 결과 coach2_r03(ATO)의 부수 지표 - ATO 효율 자체는
                          verdict noise(감독-시즌 신뢰도 0.04)라 만들지 않고, 분할 r 0.59~0.77로 재현되는 세 가지만:
                          경기당 호출 · 호출 직전 상대 연속 득점 · 4쿼터 비중.
세 테이블 전부 RLS on + 정책 0(서버 전용, service_role만 읽는다). 절대 using(true) 정책을 붙이지 말 것.
idempotent: drop & create.

값의 정밀도: 결과 SQL은 round(,2)/(,3)이지만 웹이 시즌 행을 다시 가중 평균해 통산을 만들므로
평균 컬럼(pf/pa/net, 원값 8종)은 double로 둔다(반올림 누적 오차 방지). 표시 반올림은 웹이 한다.
"""
import sys
sys.path.insert(0, r"D:\영상작업\축구\개발\kbl_realdata\tools")
import psycopg2
from import_roster import load_database_url

# 경기당 마진 SD(2011-12~2025-26 팀-경기) - 결과 F definition의 하드코딩 값. 시즌이 추가되면 재계산.
MARGIN_SD = 12.64

DDL = """
drop table if exists coach_season_record;
create table coach_season_record (
  coach_id bigint not null, season_name text not null, tcode text not null,
  g int not null, w int not null, l int not null,
  wpct double precision not null, wpct_se double precision not null,
  pf double precision not null, pa double precision not null, net double precision not null, net_se double precision not null,
  home_g int not null, home_w int not null, away_g int not null, away_w int not null,
  primary key (coach_id, season_name, tcode)
);
alter table coach_season_record enable row level security;

drop table if exists coach_season_style;
create table coach_season_style (
  coach_id bigint not null, season_name text not null, tcode text not null, n int not null,
  tpar double precision, fb double precision, oreb_pct double precision, ast_pct double precision,
  pace double precision, tov_pct double precision, efg_pct double precision, ftr double precision,
  lg_tpar double precision, lg_fb double precision, lg_oreb double precision, lg_ast double precision,
  lg_pace double precision, lg_tov double precision, lg_efg double precision, lg_ftr double precision,
  z_tpar double precision, z_fb double precision, z_oreb double precision, z_ast double precision,
  z_pace double precision, z_ballcare double precision, z_efg double precision, z_ftr double precision,
  primary key (coach_id, season_name, tcode)
);
alter table coach_season_style enable row level security;

drop table if exists coach_challenge_usage;
create table coach_challenge_usage (
  coach_id bigint not null, season_name text not null, tcode text not null,
  games int not null, challenges int not null,
  per_game double precision not null, se_poisson double precision not null,
  all3_pct double precision not null, q4_pct double precision, clutch_pct double precision, trailing_pct double precision,
  primary key (coach_id, season_name, tcode)
);
alter table coach_challenge_usage enable row level security;

drop table if exists coach_challenge_league;
create table coach_challenge_league (
  season_name text primary key, window_from date not null, window_to date not null,
  games int not null, team_games int not null, challenges int not null,
  per_game double precision not null, per_team_game double precision not null, all3_pct double precision not null,
  q4_pct double precision not null, q4_under5 int not null, q4_under2 int not null,
  trailing_n int not null, tied_n int not null, leading_n int not null
);
alter table coach_challenge_league enable row level security;

drop table if exists coach_timeout_tendency;
create table coach_timeout_tendency (
  coach_id bigint not null, season_name text not null, tcode text not null,
  games int not null, timeouts int not null, per_game double precision not null,
  opp_run_mean double precision not null, q4_share double precision not null,
  primary key (coach_id, season_name, tcode)
);
alter table coach_timeout_tendency enable row level security;
"""

# F. 결과 sql 1)+2)에 tcode를 group by에 넣은 것(팀-시즌당 감독 1명이라 행 수는 같다 - 아래 assert).
SQL_RECORD = """
insert into coach_season_record
with tg as (
  select gmkey, season_name, home_tcode tcode, home_coach_id coach_id, true is_home, home_score pf, away_score pa
    from games where season_category='정규시즌' and is_ended and home_coach_id is not null and home_score is not null
  union all
  select gmkey, season_name, away_tcode, away_coach_id, false, away_score, home_score
    from games where season_category='정규시즌' and is_ended and away_coach_id is not null and away_score is not null
)
select coach_id, season_name, tcode,
       count(*) g, sum((pf>pa)::int) w, sum((pf<pa)::int) l,
       avg((pf>pa)::int) wpct,
       sqrt(avg((pf>pa)::int)*(1-avg((pf>pa)::int))/count(*)) wpct_se,
       avg(pf) pf, avg(pa) pa, avg(pf-pa) net,
       %s/sqrt(count(*)) net_se,
       sum(case when is_home then 1 else 0 end) home_g, sum(case when is_home and pf>pa then 1 else 0 end) home_w,
       sum(case when not is_home then 1 else 0 end) away_g, sum(case when not is_home and pf>pa then 1 else 0 end) away_w
from tg group by 1,2,3
"""

# D. 결과 sql 그대로 + 리그 평균 8개(툴팁용). 2026-27은 stats 0행이라 inner join으로 자연 제외.
SQL_STYLE = """
insert into coach_season_style
with fb as (
  select gmkey, tcode, count(*) as fb
  from game_events where action_code='217' and tcode is not null group by 1,2),
tg as (
  select g.season_name, g.gmkey, s.tcode,
    case when s.tcode=g.home_tcode then g.home_coach_id else g.away_coach_id end as coach_id,
    s.efg_pct, s.tov_pct, s.oreb_pct, s.ast_pct, s.pace,
    100.0*s.fta/(s.fga+s.tpa) as ftr,
    100.0*s.tpa/(s.fga+s.tpa) as tpar,
    coalesce(fb.fb,0) as fb
  from game_team_stats s
  join games g on g.gmkey=s.gmkey
  left join fb on fb.gmkey=s.gmkey and fb.tcode=s.tcode
  where g.season_category='정규시즌' and g.is_ended),
ts as (
  select season_name, tcode, coach_id, count(*) as n,
    avg(tpar) tpar, avg(fb) fb, avg(oreb_pct) oreb_pct, avg(ast_pct) ast_pct,
    avg(pace) pace, avg(tov_pct) tov_pct, avg(efg_pct) efg_pct, avg(ftr) ftr
  from tg group by 1,2,3)
select coach_id, season_name, tcode, n,
  tpar, fb, oreb_pct, ast_pct, pace, tov_pct, efg_pct, ftr,
  avg(tpar) over w, avg(fb) over w, avg(oreb_pct) over w, avg(ast_pct) over w,
  avg(pace) over w, avg(tov_pct) over w, avg(efg_pct) over w, avg(ftr) over w,
  (tpar    -avg(tpar)     over w)/stddev_samp(tpar)     over w,
  (fb      -avg(fb)       over w)/stddev_samp(fb)       over w,
  (oreb_pct-avg(oreb_pct) over w)/stddev_samp(oreb_pct) over w,
  (ast_pct -avg(ast_pct)  over w)/stddev_samp(ast_pct)  over w,
  (pace    -avg(pace)     over w)/stddev_samp(pace)     over w,
 -(tov_pct -avg(tov_pct)  over w)/stddev_samp(tov_pct)  over w,
  (efg_pct -avg(efg_pct)  over w)/stddev_samp(efg_pct)  over w,
  (ftr     -avg(ftr)      over w)/stddev_samp(ftr)      over w
from ts window w as (partition by season_name)
"""

# E. 윈도 = 시즌별로 229가 처음 기록된 날짜부터(2025-26: 12/4). is_ended 가드는 미래 일정이 분모에
# 들어오는 것을 막기 위한 것으로 2025-26 결과는 바꾸지 않는다.
# 비율의 분모 주의: q4/clutch/trailing은 "챌린지 1건당" 비율이므로 분모가 count(ch.gmkey)여야 한다.
# tgc left join ch 위에서 avg(case when ...)를 쓰면 챌린지 0건인 팀-경기(2025-26: 14건)까지 분모에
# 들어가 값이 희석된다(리그 0.3395 -> 0.3333, 전희철 0.3231 -> 0.2958). 챌린지 0건 감독은 NULL이 된다.
SQL_CH_BASE = """
with w as (
  select g.season_name, min(g.game_date) as first_dt
  from games g join game_events e on e.gmkey=g.gmkey and e.action_code='229'
  where g.season_category='정규시즌' group by 1),
tg as (
  select g.gmkey, g.season_name, g.game_date, g.home_tcode as tcode, g.home_coach_id as coach_id, 1 as is_home
  from games g join w on w.season_name=g.season_name where g.season_category='정규시즌' and g.is_ended and g.game_date>=w.first_dt
  union all
  select g.gmkey, g.season_name, g.game_date, g.away_tcode, g.away_coach_id, 0
  from games g join w on w.season_name=g.season_name where g.season_category='정규시즌' and g.is_ended and g.game_date>=w.first_dt),
ch as (
  select e.gmkey, e.tcode, e.quarter, e.clock_min,
         case when tg.is_home=1 then e.home_score-e.away_score else e.away_score-e.home_score end as margin,
         e.quarter in ('Q4','X1','X2','X3','X4') as q4
  from game_events e join tg on tg.gmkey=e.gmkey and tg.tcode=e.tcode where e.action_code='229'),
tgc as (
  select tg.*, (select count(*) from ch where ch.gmkey=tg.gmkey and ch.tcode=tg.tcode) as n_ch from tg)
"""

SQL_CH_COACH = SQL_CH_BASE + """
insert into coach_challenge_usage
select tgc.coach_id, tgc.season_name, tgc.tcode,
  count(distinct tgc.gmkey) games, count(ch.gmkey) challenges,
  count(ch.gmkey)::float/count(distinct tgc.gmkey) per_game,
  sqrt(count(ch.gmkey))/count(distinct tgc.gmkey) se_poisson,
  (select avg((n_ch>=3)::int) from tgc t2 where t2.coach_id=tgc.coach_id and t2.season_name=tgc.season_name and t2.tcode=tgc.tcode) all3_pct,
  sum(case when ch.q4 then 1 else 0 end)::float/nullif(count(ch.gmkey),0) q4_pct,
  sum(case when ch.q4 and ch.clock_min<5 then 1 else 0 end)::float/nullif(count(ch.gmkey),0) clutch_pct,
  sum(case when ch.margin<0 then 1 else 0 end)::float/nullif(count(ch.gmkey),0) trailing_pct
from tgc left join ch on ch.gmkey=tgc.gmkey and ch.tcode=tgc.tcode
where tgc.coach_id is not null
group by 1,2,3
"""

SQL_CH_LEAGUE = SQL_CH_BASE + """
insert into coach_challenge_league
select tgc.season_name, min(tgc.game_date), max(tgc.game_date),
  count(distinct tgc.gmkey) games, count(distinct (tgc.gmkey, tgc.tcode)) team_games, count(ch.gmkey) challenges,
  count(ch.gmkey)::float/count(distinct tgc.gmkey) per_game,
  count(ch.gmkey)::float/count(distinct (tgc.gmkey, tgc.tcode)) per_team_game,
  (select avg((n_ch>=3)::int) from tgc t2 where t2.season_name=tgc.season_name) all3_pct,
  sum(case when ch.q4 then 1 else 0 end)::float/nullif(count(ch.gmkey),0) q4_pct,
  sum(case when ch.q4 and ch.clock_min<5 then 1 else 0 end) q4_under5,
  sum(case when ch.q4 and ch.clock_min<2 then 1 else 0 end) q4_under2,
  sum(case when ch.margin<0 then 1 else 0 end) trailing_n,
  sum(case when ch.margin=0 then 1 else 0 end) tied_n,
  sum(case when ch.margin>0 then 1 else 0 end) leading_n
from tgc left join ch on ch.gmkey=tgc.gmkey and ch.tcode=tgc.tcode
group by 1
"""


# 작전타임 호출 성향. 측정 스크립트(ato_lib)는 포제션을 상태기계로 나눴지만 이 세 지표는 포제션이 필요 없다 -
# 작전타임(003) 이벤트 행의 누적 점수만으로 된다.
#   opp_run   = 호출 시점까지, 호출한 팀이 마지막으로 득점한 뒤 상대가 넣은 점수.
#               home_score가 같은 구간(= 홈이 득점하지 않은 구간) 안에서 away_score의 누적 최솟값을 빼면 된다.
#               점수는 줄지 않으므로 같은 home_score 값의 행은 연속이다.
#   per_game  = 호출 수 / 호출이 1건 이상 기록된 경기 수(측정 정의 그대로 - 2013-14는 27경기에 003 기록 자체가 없다).
#   q4_share  = 4쿼터 비중(연장 X1~X3 제외 - 리그 Q4 37.8% / OT 0.9%).
# 검산: 측정 CSV(ato_timing_coach_season.csv)와 25-26 감독 10명 네 값 전부 일치, 11-12는 3명이 호출 1~2건 차이
# (측정은 포제션 창을 못 잡은 작전타임 33건을 뺐다). 15시즌 전체 약 10초, 작전타임 32,988건.
SQL_TIMEOUT = """
insert into coach_timeout_tendency
with g as (
  select gmkey, season_name, home_tcode, away_tcode, home_coach_id, away_coach_id
  from games where season_category = '정규시즌' and is_ended
), ev as (
  select e.gmkey, e.quarter, e.action_code, e.tcode,
         e.away_score - min(e.away_score) over (partition by e.gmkey, e.home_score order by e.event_order) as run_vs_home,
         e.home_score - min(e.home_score) over (partition by e.gmkey, e.away_score order by e.event_order) as run_vs_away
  from game_events e join g on g.gmkey = e.gmkey
), tos as (
  select g.season_name, ev.gmkey, ev.tcode,
         case when ev.tcode = g.home_tcode then g.home_coach_id else g.away_coach_id end as coach_id,
         case when ev.tcode = g.home_tcode then ev.run_vs_home else ev.run_vs_away end as opp_run,
         ev.quarter = 'Q4' as q4
  from ev join g on g.gmkey = ev.gmkey
  where ev.action_code = '003' and ev.tcode in (g.home_tcode, g.away_tcode)
)
select coach_id, season_name, tcode,
       count(distinct gmkey) games, count(*) timeouts,
       count(*)::double precision / count(distinct gmkey) per_game,
       avg(opp_run)::double precision opp_run_mean,
       avg(q4::int)::double precision q4_share
from tos where coach_id is not null
group by 1, 2, 3
"""


def main():
    c = psycopg2.connect(load_database_url())
    c.autocommit = False
    cur = c.cursor()
    cur.execute(DDL)
    cur.execute(SQL_RECORD, (MARGIN_SD,))
    cur.execute(SQL_STYLE)
    cur.execute(SQL_CH_COACH)
    cur.execute(SQL_CH_LEAGUE)
    cur.execute(SQL_TIMEOUT)
    c.commit()

    counts = {}
    for t in ("coach_season_record", "coach_season_style", "coach_challenge_usage", "coach_challenge_league", "coach_timeout_tendency"):
        cur.execute("select count(*) from " + t)
        counts[t] = cur.fetchone()[0]
        print("%-24s %d행" % (t, counts[t]))

    # 정책이 하나라도 있으면 실패 - 이 저장소에서 배치가 공개 정책을 되살린 사고가 있었다.
    cur.execute("select tablename, policyname from pg_policies where tablename like 'coach_%%'")
    pol = cur.fetchall()
    assert not pol, "coach_* 테이블에 정책이 있으면 안 된다: %r" % (pol,)
    cur.execute("select relname, relrowsecurity from pg_class where relname like 'coach_%%' and relkind='r'")
    rls = dict(cur.fetchall())
    assert all(rls[t] for t in counts), "RLS off: %r" % rls

    # 팀-시즌당 감독 1명(결과 F coverage) → 감독-시즌 행 = 팀-시즌 수
    cur.execute("select count(*) from (select distinct season_name, tcode from coach_season_record) x")
    assert cur.fetchone()[0] == counts["coach_season_record"], "감독-시즌 != 팀-시즌"

    # 검산: 결과 파일 topBottom 값 재현
    def career(name):
        cur.execute(
            "select sum(g), sum(w), sum(l), sum(net*g)/sum(g) from coach_season_record r join coaches c on c.coach_id=r.coach_id where c.name=%s",
            (name,),
        )
        return cur.fetchone()

    g, w, l, net = career("전희철")
    print("전희철 %dG %d승 %d패 넷마진 %+.2f" % (g, w, l, net))
    assert (g, w, l, round(net, 2)) == (270, 180, 90, 4.17), (g, w, l, net)
    g, w, l, net = career("조상현")
    print("조상현 %dG %d승 %d패 넷마진 %+.2f" % (g, w, l, net))
    assert (g, w, l, round(net, 2)) == (216, 142, 74, 4.87), (g, w, l, net)
    g, w, l, net = career("유재학")
    print("유재학 %dG %d승 %d패 넷마진 %+.2f" % (g, w, l, net))
    assert (g, w, l) == (582, 369, 213), (g, w, l)

    cur.execute("select count(*), avg(z_tpar) from coach_season_style s join coaches c on c.coach_id=s.coach_id where c.name='김승기'")
    n, z = cur.fetchone()
    print("김승기 3PAr 통산 z %.2f n=%d" % (z, n))
    assert (n, round(z, 2)) == (9, 1.49), (n, z)

    cur.execute("select season_name, games, challenges, per_game, per_team_game, all3_pct, q4_pct, q4_under5, q4_under2, trailing_n, tied_n, leading_n from coach_challenge_league")
    for row in cur.fetchall():
        print("챌린지 리그", row)
        if row[0] == "2025-2026":
            assert (row[1], row[2], round(row[3], 2), round(row[4], 2), round(row[5], 2)) == (187, 757, 4.05, 2.02, 0.30), row
            # 분모 = 챌린지 757건(팀-경기 771이 아니다) - 위 SQL_CH_* 주석의 회귀 방지선.
            assert round(row[6], 3) == 0.339, row
            assert (row[9], row[10], row[11]) == (337, 48, 372), row
    cur.execute("select c.name, u.games, u.challenges, u.per_game, u.q4_pct from coach_challenge_usage u join coaches c on c.coach_id=u.coach_id where c.name in ('김효범','전희철') order by 1")
    for name, games, ch, pg, q4 in cur.fetchall():
        print("챌린지 %s %d경기 %d회 경기당 %.2f Q4 %.3f" % (name, games, ch, pg, q4))
        assert (name, ch, round(pg, 2), round(q4, 3)) in (("김효범", 88, 2.38, 0.352), ("전희철", 65, 1.76, 0.323)), (name, ch, pg, q4)

    # 작전타임 호출 성향 - 측정 CSV(ato_timing_coach_season.csv) 25-26 값 재현.
    cur.execute(
        "select c.name, t.timeouts, t.opp_run_mean, t.q4_share, t.per_game from coach_timeout_tendency t "
        "join coaches c on c.coach_id=t.coach_id where t.season_name='2025-2026' and c.name in ('양동근','조상현') order by 1"
    )
    for name, n_to, run, q4, pg in cur.fetchall():
        print("작전타임 %s %d회 상대런 %.4f Q4 %.4f 경기당 %.4f" % (name, n_to, run, q4, pg))
        assert (name, n_to, round(run, 4), round(q4, 4), round(pg, 4)) in (
            ("양동근", 234, 4.6966, 0.3547, 4.3333),
            ("조상현", 220, 3.2636, 0.3773, 4.0741),
        ), (name, n_to, run, q4, pg)
    cur.execute("select sum(timeouts) from coach_timeout_tendency where season_name <> '2026-2027'")
    total = cur.fetchone()[0]
    print("작전타임 15시즌 합 %d회" % total)
    assert total == 32988, total
    c.close()
    print("OK")


if __name__ == "__main__":
    main()
