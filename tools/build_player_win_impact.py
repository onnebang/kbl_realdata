"""선수별 "결정적 순간 득점" 집계 -> player_win_impact (2026-09-04, 사용자 요청).

요청: "클러치 프로필에서, 승률에 + 되는 행동이 재미있는데, 클러치가 아니더라도, 승률
올랐던 내용들에 대해서 표시".

## 먼저 알아야 할 것 - 이 지표는 "행동별 승률 기여"가 아니다
game_events.wpa_home은 라이브 승률 모델의 P(i) - P(i-1)이고(tools/build_wpa.py), 그 모델의
입력은 (점수차, 잔여시간, 스케일 점수차, 넷레이팅, 시너지)뿐이다. 실측(2026-09-04):

  · wpa_home이 정확히 0인 행이 2,425,147행 중 2,039,952행(84.1%).
  · 리그 전체 action_code별 합: 201(2점) +8,653.93 / 205(3점) +4,508.25 / 203(자유투) +2,443.36 /
    207(덩크) +519.33. 나머지 전 코드는 합이 |16| 미만(어시스트 +1.19, 스틸 -0.10, 블록 +0.60,
    수비리바운드 +0.69, 3점실패 -15.01).
  · 비득점 행에 가끔 붙는 nonzero wpa는 공로가 아니다. 최근 300경기 표본에서 그런 행 4,157건이
    **전부** 직전 행 대비 점수 변화가 0이었다 - 시계가 확률 버킷을 넘어간 감쇠분이 마침 그 자리에
    있던 행에 얹힌 것이다(평균 절댓값 0.010). "수비 리바운드로 승률 -0.22"로 표시하면 완전히
    틀린 해석이 된다. → **득점 4코드(201/203/205/207)만 집계한다.**
  · 커리어 wpa와 커리어 득점의 상관이 0.997(R^2=0.994), 기울기 0.0258. 즉 이 값은 새 지표가
    아니라 **레버리지로 가중한 득점**이다. 원점수에 더하는 유일한 정보는 가비지타임 할인이다
    (워니: 21점차+ 구간이 득점의 3.5%인데 wpa로는 0.2%). 그래서 점수차 구간을 같이 굽는다.
  · 이 지표는 구조적으로 단조 비음수다. 리그에서 커리어 값이 의미 있게 음수인 선수가 한 명도
    없다(최저 이호준 -0.035). 슛 실패에 페널티가 없기 때문. 진짜 부호가 있는 값이 필요하면
    온코트 양면 WPA를 봐야 한다(워니 +27.7 / 김선형 +42.8 / 조은후 -1.3) - 그것도 같이 굽는다.
  · 상위 순간을 그냥 절댓값으로 정렬하면 주전은 10개 중 10개가 전부 클러치다(워니·김선형 모두).
    사용자가 원한 건 정확히 그 반대라 **클러치와 클러치 밖 순간을 따로 저장한다.**
    클러치 밖 최고치는 클러치 최고치의 35~42% 수준이라 한 목록에 섞으면 절대 못 올라온다.
  · wpa_home이 NULL인 4,182행은 경기 수와 정확히 일치하는 '경기 시작' 합성행(pcode NULL)이라
    선수 집계에서는 NULL이 0건이다.

## 클러치 정의
supabase RPC player_clutch_profile과 글자 그대로 같다:
  4쿼터 또는 연장, 피리어드 잔여 300초 이하,
  그 순간 점수차 5점 이내(득점 이벤트는 득점 반영 전 기준)

## 사용
    python build_player_win_impact.py
    python build_player_win_impact.py --skip-oncourt   # 온코트 양면 WPA는 건너뛰기(느림)
"""
import argparse
import os
import sys

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402
from cache_invalidate import revalidate  # noqa: E402

TOP_MOMENTS = 5          # 클러치 / 클러치 밖 각각
MIN_SCORES = 20          # 득점 이벤트가 이보다 적으면 "커리어 임팩트"가 문장이 안 된다
STATEMENT_TIMEOUT_MS = 900000

# psycopg2가 퍼센트 기호를 자리표시자로 읽으므로 SQL 안의 LIKE 와일드카드는 두 번 겹쳐 쓴다.
BASE_SQL = """
with ev as (
  select
    e.gmkey, e.quarter, e.clock_min, e.clock_sec, e.action_code, e.pcode,
    e.home_score, e.away_score,
    g.game_date, g.season_name, g.home_tcode, g.away_tcode, e.tcode,
    case when e.tcode = g.home_tcode then e.wpa_home else -e.wpa_home end as wpa_team,
    case e.action_code when '205' then 3 when '203' then 1 else 2 end as pts_val
  from game_events e
  join games g on g.gmkey = e.gmkey
  where e.pcode is not null and e.action_code in ('201', '203', '205', '207')
    and e.wpa_home is not null
),
flagged as (
  select ev.*,
    abs((home_score - away_score) - case when tcode = home_tcode then pts_val else -pts_val end) as margin_before,
    (
      (quarter = 'Q4' or quarter like 'X%%')
      and (clock_min * 60 + clock_sec) <= 300
      and abs((home_score - away_score) - case when tcode = home_tcode then pts_val else -pts_val end) <= 5
    ) as is_clutch
  from ev
),
tot as (
  select pcode,
    count(distinct gmkey)::int as games,
    count(*)::int as scores,
    sum(pts_val)::int as pts,
    sum(wpa_team) as wpa_total,
    coalesce(sum(wpa_team) filter (where is_clutch), 0) as wpa_clutch,
    count(*) filter (where is_clutch)::int as scores_clutch,
    coalesce(sum(pts_val) filter (where is_clutch), 0)::int as pts_clutch
  from flagged group by pcode
),
acts as (
  select f.pcode, jsonb_agg(jsonb_build_object(
           'code', f.action_code, 'label', coalesce(a.label, f.action_code),
           'n', f.n, 'pts', f.pts, 'wpa', round(f.wpa::numeric, 4)) order by f.wpa desc) as by_action
  from (select pcode, action_code, count(*)::int n, sum(pts_val)::int pts, sum(wpa_team) wpa
        from flagged group by pcode, action_code) f
  left join action_codes a on a.code = f.action_code
  group by f.pcode
),
quarters as (
  select pcode, jsonb_agg(jsonb_build_object('quarter', q, 'n', n, 'pts', pts, 'wpa', round(wpa::numeric, 4))
                          order by q) as by_quarter
  from (select pcode, case when quarter like 'X%%' then 'OT' else quarter end as q,
               count(*)::int n, sum(pts_val)::int pts, sum(wpa_team) wpa
        from flagged group by 1, 2) x
  group by pcode
),
margins as (
  select pcode, jsonb_agg(jsonb_build_object('bucket', b, 'n', n, 'pts', pts, 'wpa', round(wpa::numeric, 4))
                          order by ord) as by_margin
  from (select pcode,
               case when margin_before <= 5 then '0-5' when margin_before <= 10 then '6-10'
                    when margin_before <= 20 then '11-20' else '21+' end as b,
               case when margin_before <= 5 then 1 when margin_before <= 10 then 2
                    when margin_before <= 20 then 3 else 4 end as ord,
               count(*)::int n, sum(pts_val)::int pts, sum(wpa_team) wpa
        from flagged group by 1, 2, 3) x
  group by pcode
),
ranked as (
  select f.*, coalesce(a.label, f.action_code) as action_label,
         row_number() over (partition by f.pcode, f.is_clutch order by f.wpa_team desc) as rn
  from flagged f left join action_codes a on a.code = f.action_code
),
moms as (
  select pcode,
    coalesce(jsonb_agg(m order by w desc) filter (where cl), '[]'::jsonb) as moments_clutch,
    coalesce(jsonb_agg(m order by w desc) filter (where not cl), '[]'::jsonb) as moments_open
  from (
    select pcode, is_clutch as cl, wpa_team as w, jsonb_build_object(
      'gmkey', gmkey, 'game_date', game_date, 'season_name', season_name,
      'quarter', quarter, 'clock_min', clock_min, 'clock_sec', clock_sec,
      'action_label', action_label, 'tcode', tcode,
      'home_tcode', home_tcode, 'away_tcode', away_tcode,
      'home_score', home_score, 'away_score', away_score,
      'margin', margin_before, 'wpa', round(wpa_team::numeric, 4), 'clutch', is_clutch) as m
    from ranked where rn <= %(top)s
  ) z group by pcode
)
insert into player_win_impact
  (pcode, games, scores, pts, wpa_total, wpa_clutch, scores_clutch, pts_clutch,
   by_action, by_quarter, by_margin, moments_clutch, moments_open, updated_at)
select t.pcode, t.games, t.scores, t.pts,
       round(t.wpa_total::numeric, 4), round(t.wpa_clutch::numeric, 4), t.scores_clutch, t.pts_clutch,
       coalesce(a.by_action, '[]'::jsonb), coalesce(q.by_quarter, '[]'::jsonb),
       coalesce(mg.by_margin, '[]'::jsonb),
       coalesce(m.moments_clutch, '[]'::jsonb), coalesce(m.moments_open, '[]'::jsonb), now()
from tot t
left join acts a on a.pcode = t.pcode
left join quarters q on q.pcode = t.pcode
left join margins mg on mg.pcode = t.pcode
left join moms m on m.pcode = t.pcode
join players p on p.pcode = t.pcode
where t.scores >= %(minscores)s
"""

# 온코트 양면 WPA - 이 선수가 라인업 배열에 들어 있는 동안 난 모든 wpa를 그 팀 관점으로 합산.
# 위 지표와 달리 실제로 음수가 나온다(실측: 워니 +27.7 / 김선형 +42.8 / 조은후 -1.3).
# 0인 행은 합에 영향이 없으니 nonzero만 훑는다(381,013행).
ONCOURT_SQL = """
with e as (
  select home_lineup, away_lineup, wpa_home as w
  from game_events
  where wpa_home is not null and wpa_home <> 0
),
side as (
  select unnest(home_lineup) as pcode, w from e where home_lineup is not null
  union all
  select unnest(away_lineup) as pcode, -w from e where away_lineup is not null
)
update player_win_impact t
set oncourt_wpa = round(s.total::numeric, 4),
    oncourt_pos = round(s.pos::numeric, 4),
    oncourt_neg = round(s.neg::numeric, 4),
    oncourt_events = s.n
from (
  select pcode, sum(w) as total, coalesce(sum(w) filter (where w > 0), 0) as pos,
         coalesce(sum(w) filter (where w < 0), 0) as neg, count(*)::int as n
  from side group by pcode
) s
where s.pcode = t.pcode
"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-oncourt", action="store_true")
    args = ap.parse_args()

    conn = psycopg2.connect(load_database_url())
    conn.autocommit = False
    cur = conn.cursor()
    cur.execute("set statement_timeout = %s", (STATEMENT_TIMEOUT_MS,))

    cur.execute("delete from player_win_impact")
    cur.execute(BASE_SQL, {"top": TOP_MOMENTS, "minscores": MIN_SCORES})
    inserted = cur.rowcount
    conn.commit()
    print("player_win_impact 재생성: %d행" % inserted)

    if not args.skip_oncourt:
        print("온코트 양면 WPA 집계 중(배열 unnest라 느림)...")
        cur.execute(ONCOURT_SQL)
        print("  갱신 %d행" % cur.rowcount)
        conn.commit()

    # player_win_impact 전체 재생성이라 개별 pcode를 파이썬에서 추적 안 함 - lib/winImpact.ts의
    # 캐시가 player:${pcode}와 TAG.build를 같이 태그하므로 manual:build 하나로 전부 풀린다.
    revalidate(["manual:build"])

    # 검산. 셋 다 0이어야 한다.
    cur.execute("""
        select
          count(*) filter (where jsonb_array_length(moments_clutch) = 0
                             and jsonb_array_length(moments_open) = 0),
          count(*) filter (where pts <> (select coalesce(sum((x->>'pts')::int), 0)
                                         from jsonb_array_elements(by_action) x)),
          count(*) filter (where pts <> (select coalesce(sum((x->>'pts')::int), 0)
                                         from jsonb_array_elements(by_margin) x))
        from player_win_impact
    """)
    a, b, c = cur.fetchone()
    print("  검산: 순간 전무 %d행 · 행동합!=총득점 %d행 · 구간합!=총득점 %d행 (셋 다 0이어야 함)" % (a, b, c))

    cur.execute("""
        select p.name, w.games, w.pts, w.wpa_total, w.wpa_clutch,
               jsonb_array_length(w.moments_clutch), jsonb_array_length(w.moments_open),
               w.oncourt_wpa,
               round(coalesce((select (x->>'pts')::numeric from jsonb_array_elements(w.by_margin) x
                       where x->>'bucket' = '21+'), 0) / nullif(w.pts, 0) * 100, 1),
               round(coalesce((select (x->>'wpa')::numeric from jsonb_array_elements(w.by_margin) x
                       where x->>'bucket' = '21+'), 0) / nullif(w.wpa_total, 0) * 100, 1)
        from player_win_impact w join players p on p.pcode = w.pcode
        order by w.wpa_total desc limit 8
    """)
    print("\n상위 8명 (경기/득점/wpa합/클러치 · 순간 클러치-밖 · 온코트 · 21점차+ 득점%->wpa%)")
    for name, g, pts, tot, cl, nc, no, onc, gp, gw in cur.fetchall():
        print("  %-12s %4d %6d %8.2f %7.2f  %d-%d  온코트 %+8.2f  가비지 %s -> %s"
              % (name, g, pts, tot, cl, nc, no, onc or 0, gp, gw))
    conn.close()


if __name__ == "__main__":
    main()
