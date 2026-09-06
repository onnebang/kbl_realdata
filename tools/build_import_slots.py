"""외국인·아시아쿼터 슬롯 실측 -> import_slot_season / import_rule_season (2026-09-05, 사용자 요청).

요청: "26-27시즌에는 용병제도가 조금 변경... 1쿼, 4쿼는 용병 2인 출전 불가, 아쿼는 가능,
2~3쿼는 아쿼+용병 2인 중에 2인 출전 가능(용병 2명 조합도 가능) ... 바뀌는 규정을 적용해서
시즌 리포트와 예상을 적어줘야 할 것 같아".

## 이 규정 변경의 크기를 무엇으로 재는가
"2·3쿼터가 중요해진다"가 아니다. 실측하면 2·3쿼터는 팀당 득점의 50.1%로 정확히 절반이고,
쿼터 득실차와 최종 득실차의 상관도 Q2+Q3 r=.642 / Q1+Q4 r=.623으로 사실상 같다. 바뀌는 구간이
승부처라서 중요한 게 아니라 그냥 절반이라서 중요하다.

진짜 크기는 슬롯 쪽에 있다. 25-26 정규시즌에 외국인 2명이 동시에 코트에 선 시간은 리그 전체
170초(전체 코트시간의 0.013%)였고, 그마저 한 경기 Q4의 연속 두 스틴트라 교체 순서 복원 오차로
보는 게 맞다. 반대로 외국인 1명이 코트에 있던 시간은 98.75%다. 즉 외국인 슬롯은 이미 포화였고,
규정 변경은 비어 있던 시간을 채우는 게 아니라 **팀당 최대 20분의 외국인 시간을 새로 만든다.**

## 슬롯을 어떻게 판정하는가 (25-26엔 등록 구분이 DB에 없다)
season_roster는 26-27만 있다. 그래서 25-26은 코트 위 동시 출전 구조로 복원한다:
  · 비국내 후보 = players.name에 공백이 있거나 '라건아'(귀화 선수라 이름에 공백이 없다).
    단 26-27 명부 note가 'flag0 국내'인 선수는 제외한다(에디 다니엘 - 공백 이름의 국내 선수).
  · 그 후보들끼리의 동시 출전 초를 팀별로 재면, 아시아쿼터만 두 외국인 모두와 함께 뛰고
    외국인끼리는 0초다. 팀에서 동시 출전 합이 가장 큰 후보 = 아시아쿼터.
  · 남은 후보를 출전분 내림차순으로 1옵션 / 2옵션(시즌 중 교체된 대체 외국인은 2옵션에 합산).
검증: 이렇게 뽑은 분류가 roster_changes의 26-27 role(아시아쿼터 8 · 외국인 10, 총 18명)과
100% 일치했다. 라벨 없이도 슬롯이 복원된다는 뜻이다.

주의 - 1옵션/2옵션은 이 스크립트가 정한 운영 정의(출전분 많은 쪽 = 1옵션)이지 등록 구분이
아니다. 실제로 삼성은 25-26 출전분이 칸터 > 니콜슨인데 26-27 등록상 칸터가 2옵션이다.
화면은 이 점을 밝혀야 한다.

## 사용
    python build_import_slots.py --season 2025-2026
    python build_import_slots.py --season 2025-2026 --dry-run
"""
import argparse
import math
import os
import sys
from collections import defaultdict

import psycopg2
from psycopg2.extras import Json, execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402

SEASON_CATEGORY = "정규시즌"
# 동시 출전을 "간선"으로 셀 최소 시간. 이보다 짧은 동시 출전은 교체 순서 복원 오차로 본다
# (25-26 리그 전체에서 그런 흔적은 해먼즈-로메로 170초 하나뿐이었다).
CO_EDGE_MIN_SEC = 300
QUARTER_MINUTES = 40  # 옛 규정에서 팀 외국인 출전분의 경기당 상한 = 색칠 방향을 정하는 기준
# 이름에 공백이 있어도 국내인 선수를 거르는 근거(26-27 명부). 시즌마다 늘어날 수 있어 하드코딩
# 대신 명부에서 읽는다.
DOMESTIC_FLAG = "flag0 국내"
NATURALIZED = ("라건아",)  # 귀화 선수 - 외국인 슬롯을 쓰지만 이름에 공백이 없다

DDL = """
create table if not exists import_slot_season (
  season_name text not null,
  tcode       text not null,
  pcode       text not null,
  player_name text not null,
  slot        text not null check (slot in ('aq', 'import1', 'import2')),
  games       int  not null,
  minutes     numeric not null,
  mpg         numeric,
  per         numeric,
  pie40       numeric,
  pts40       numeric,
  fg_pct      numeric,
  q1_mpg      numeric,
  q2_mpg      numeric,
  q3_mpg      numeric,
  q4_mpg      numeric,
  primary key (season_name, tcode, pcode)
);

create table if not exists import_rule_season (
  season_name  text primary key,
  team_games   int    not null,
  court_sec    bigint not null,
  import0_sec  bigint not null,
  import1_sec  bigint not null,
  import2_sec  bigint not null,
  quarter_pts  jsonb  not null,
  quarter_corr jsonb  not null,
  built_at     timestamptz not null default now()
);
"""

RLS = """
alter table import_slot_season enable row level security;
alter table import_rule_season enable row level security;
"""


def ensure_policy(cur, table):
    # 락다운(tools/lockdown_anon.sql) 이후로는 공개 읽기 정책을 만들지 않는다 - 서버는
    # service_role로 읽으므로 정책이 없어도 동작한다. 예전엔 이 줄이 배치를 돌릴 때마다
    # 락다운을 조용히 되돌려 테이블이 다시 anon 공개가 됐다(감사 실측).
    # """public read 정책 - 이미 있으면 넘어간다(create policy에 if not exists가 없다)."""
    cur.execute("select 1 from pg_policies where tablename = %s and policyname = %s", (table, "public read " + table))
    if not cur.fetchone():
        # 락다운(tools/lockdown_anon.sql) 이후로는 공개 읽기 정책을 만들지 않는다 - 서버는
        # service_role로 읽으므로 정책이 없어도 동작한다. 예전엔 이 줄이 배치를 돌릴 때마다
        # 락다운을 조용히 되돌려 테이블이 다시 anon 공개가 됐다(감사 실측).
        # cur.execute('create policy "public read %s" on %s for select using (true)' % (table, table))


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 0 or syy <= 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def split_slots(members, pair_sec, minutes, team_games, tcode, names):
    """비국내 선수들을 {아시아쿼터} / {외국인} 두 집합으로 가른다. 아시아쿼터 pcode 집합을 돌려준다.

    간선(=함께 코트에 선 시간 CO_EDGE_MIN_SEC 이상)은 아쿼-외국인 사이에만 생긴다. 성분마다
    2-색칠하고, 성분별 색 조합을 전부 시도해 외국인 쪽 합계가 40분×경기 수에 가장 가까운 조합을
    고른다. 간선이 없는 외톨이(=아쿼와 겹친 적 없는 단기 대체 외국인)도 이 최적화가 처리한다.
    """
    adj = {p: set() for p in members}
    for i in range(len(members)):
        for j in range(i + 1, len(members)):
            a, b = sorted((members[i], members[j]))
            if pair_sec.get((a, b), 0) >= CO_EDGE_MIN_SEC:
                adj[members[i]].add(members[j])
                adj[members[j]].add(members[i])

    comps = []            # [(색0 목록, 색1 목록)]
    color = {}
    for start in members:
        if start in color:
            continue
        color[start] = 0
        stack = [start]
        side = ([start], [])
        while stack:
            cur = stack.pop()
            for nb in adj[cur]:
                if nb not in color:
                    color[nb] = 1 - color[cur]
                    side[color[nb]].append(nb)
                    stack.append(nb)
                elif color[nb] == color[cur]:
                    # 홀수 사이클 = 외국인끼리 함께 뛴 셈이 된다. 이 데이터에선 안 나오지만
                    # 나오면 조용히 넘기지 말고 알린다.
                    print("  !! %s 색칠 충돌: %s - %s" % (tcode, names[cur], names[nb]))
        comps.append(side)

    if len(comps) > 10:
        # 조합 폭발 방지. 이 리그 규모에선 성분이 3개를 넘은 적이 없다.
        print("  !! %s 성분 %d개 - 브루트포스 생략, 출전분 적은 쪽을 아쿼로" % (tcode, len(comps)))
        return {p for side in comps for p in min(side, key=lambda g: sum(minutes[q] for q in g))}

    target = QUARTER_MINUTES * team_games
    best, best_gap = None, None
    for mask in range(1 << len(comps)):
        imports = []
        for k, side in enumerate(comps):
            imports += side[1] if (mask >> k) & 1 else side[0]
        gap = abs(sum(minutes[p] for p in imports) - target)
        if best_gap is None or gap < best_gap:
            best, best_gap = set(imports), gap
    return {p for p in members if p not in best}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2025-2026")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    season = args.season

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()

    cur.execute(
        "select gmkey, home_tcode, away_tcode from games "
        "where season_name = %s and season_category = %s and is_ended = true",
        (season, SEASON_CATEGORY),
    )
    games = cur.fetchall()
    if not games:
        sys.exit("경기가 없다: %s %s" % (season, SEASON_CATEGORY))
    gmkeys = [g[0] for g in games]
    side_of = {}  # (gmkey, tcode) -> 'home'/'away'
    for gm, ht, at in games:
        side_of[(gm, ht)] = "home"
        side_of[(gm, at)] = "away"
    print("%s %s: %d경기" % (season, SEASON_CATEGORY, len(games)))

    # ── 1. 박스스코어 집계 ────────────────────────────────────────────────────────
    cur.execute(
        """select s.pcode, s.tcode, p.name, s.min_played, s.pts, s.per, s.pie,
                  s.fgm, s.fga, s.tpm, s.tpa
             from game_player_stats s
             join players p on p.pcode = s.pcode
            where s.gmkey = any(%s) and coalesce(s.min_played, 0) > 0""",
        (gmkeys,),
    )
    box = defaultdict(lambda: {"name": "", "g": 0, "min": 0.0, "pts": 0.0, "perw": 0.0, "pie": 0.0,
                               "fgm": 0, "fga": 0, "tpm": 0, "tpa": 0})
    for pcode, tcode, name, mn, pts, per, pie, fgm, fga, tpm, tpa in cur.fetchall():
        b = box[(tcode, pcode)]
        b["name"] = name
        b["g"] += 1
        mn = float(mn or 0)
        b["min"] += mn
        b["pts"] += float(pts or 0)
        b["perw"] += float(per or 0) * mn  # PER은 경기 단위 값이라 출전분 가중평균
        b["pie"] += float(pie or 0)        # PIE는 경기 지분이라 합산 후 분당 정규화
        b["fgm"] += int(fgm or 0)
        b["fga"] += int(fga or 0)
        b["tpm"] += int(tpm or 0)
        b["tpa"] += int(tpa or 0)

    # ── 2. 비국내 후보 ───────────────────────────────────────────────────────────
    cur.execute("select pcode from season_roster where note like %s", ("%" + DOMESTIC_FLAG + "%",))
    domestic_flagged = {r[0] for r in cur.fetchall() if r[0]}
    cand = set()
    for (tcode, pcode), b in box.items():
        if pcode in domestic_flagged:
            continue
        if " " in b["name"] or b["name"] in NATURALIZED:
            cand.add(pcode)
    print("비국내 후보 %d명 (명부 국내 플래그로 제외: %d명)" % (len(cand), len(domestic_flagged)))

    # ── 3. 스틴트 - 동시 출전 구조 · 쿼터별 출전 · 코트 위 외국인 수 ────────────────
    cur.execute(
        "select gmkey, home_lineup, away_lineup, quarters, duration_sec "
        "from lineup_stints where gmkey = any(%s)",
        (gmkeys,),
    )
    stints = cur.fetchall()
    print("스틴트 %d행" % len(stints))

    pair_sec = defaultdict(int)      # (pcodeA, pcodeB) -> 동시 코트 초 (같은 팀 쌍만 생긴다)
    q_sec = defaultdict(int)         # (pcode, quarter) -> 코트 초
    court_sec = 0

    for gmkey, home_lu, away_lu, quarters, dur in stints:
        q = (quarters or ["?"])[0]
        dur = int(dur or 0)
        # 한 스틴트 행이 양 팀 라인업을 같이 들고 있다. 팀-사이드마다 따로 세야 코트시간이
        # 팀-경기당 40분이 된다(한 번만 세면 절반이 된다).
        for lu in (home_lu, away_lu):
            if not lu:
                continue
            court_sec += dur
            for pc in lu:
                q_sec[(pc, q)] += dur
            on = [pc for pc in lu if pc in cand]
            for i in range(len(on)):
                for j in range(i + 1, len(on)):
                    a, b = sorted((on[i], on[j]))
                    pair_sec[(a, b)] += dur

    # ── 4. 팀별 슬롯 판정 ────────────────────────────────────────────────────────
    team_of = {}
    for (tcode, pcode) in box:
        if pcode in cand:
            team_of.setdefault(pcode, tcode)
    by_team = defaultdict(list)
    for pcode, tcode in team_of.items():
        by_team[tcode].append(pcode)

    rows = []
    for tcode, members in sorted(by_team.items()):
        gp_team = sum(1 for _, ht, at in games if ht == tcode or at == tcode)
        aq_set = split_slots(members, pair_sec, {p: box[(tcode, p)]["min"] for p in members}, gp_team, tcode,
                             {p: box[(tcode, p)]["name"] for p in members})
        imports = sorted(
            (p for p in members if p not in aq_set),
            key=lambda p: box[(tcode, p)]["min"],
            reverse=True,
        )
        for pc in members:
            b = box[(tcode, pc)]
            slot = "aq" if pc in aq_set else ("import1" if imports and pc == imports[0] else "import2")
            mn = b["min"]
            fga_all = b["fga"] + b["tpa"]
            rows.append((
                season, tcode, pc, b["name"], slot, b["g"], round(mn, 2),
                round(mn / b["g"], 2) if b["g"] else None,
                round(b["perw"] / mn, 2) if mn > 0 else None,
                round(b["pie"] / mn * 40, 2) if mn > 0 else None,
                round(b["pts"] / mn * 40, 2) if mn > 0 else None,
                round((b["fgm"] + b["tpm"]) / fga_all, 4) if fga_all > 0 else None,
                round(q_sec.get((pc, "Q1"), 0) / 60 / gp_team, 2),
                round(q_sec.get((pc, "Q2"), 0) / 60 / gp_team, 2),
                round(q_sec.get((pc, "Q3"), 0) / 60 / gp_team, 2),
                round(q_sec.get((pc, "Q4"), 0) / 60 / gp_team, 2),
            ))

    # ── 4-b. 코트 위 '외국인' 수 (아시아쿼터 제외) ────────────────────────────────
    # 규정이 제한하는 대상은 외국인 2명이다. 후보 전체로 세면 "아시아쿼터 + 외국인"이 전부
    # 2명으로 잡혀 절반이 넘게 나오는데, 그건 원래 허용되던 조합이라 규정 변경과 무관하다.
    # 슬롯 판정이 끝난 지금 다시 센다.
    import_pcodes = {r[2] for r in rows if r[4] != "aq"}
    nonkor_sec = defaultdict(int)   # 코트 위 외국인 수 -> 초 (팀-사이드 기준)
    two_detail = defaultdict(int)   # (gmkey, quarter) -> 초 - 노이즈인지 확인하려고 구간을 남긴다
    for gmkey, home_lu, away_lu, quarters, dur in stints:
        q = (quarters or ["?"])[0]
        dur = int(dur or 0)
        for lu in (home_lu, away_lu):
            if not lu:
                continue
            n_imp = sum(1 for pc in lu if pc in import_pcodes)
            nonkor_sec[n_imp] += dur
            if n_imp >= 2:
                two_detail[(gmkey, q)] += dur

    # ── 5. 쿼터 무게 - 득점 배분과 최종 득실차 상관 ─────────────────────────────────
    cur.execute(
        """select gmkey, quarter, home_score, away_score, event_order
             from game_events
            where gmkey = any(%s) and quarter in ('Q1','Q2','Q3','Q4')""",
        (gmkeys,),
    )
    last = {}
    for gmkey, q, hs, aws, order in cur.fetchall():
        key = (gmkey, q)
        if key not in last or order > last[key][0]:
            last[key] = (order, hs or 0, aws or 0)
    qpts = defaultdict(list)
    qmargin = defaultdict(list)
    finals = {}
    for gmkey in gmkeys:
        seq = [last.get((gmkey, "Q%d" % i)) for i in range(1, 5)]
        if any(s is None for s in seq):
            continue
        prev_h = prev_a = 0
        ms = []
        for _, h, a in seq:
            qpts["h"].append(h - prev_h)
            qpts["a"].append(a - prev_a)
            ms.append((h - prev_h) - (a - prev_a))
            prev_h, prev_a = h, a
        finals[gmkey] = sum(ms)
        for i, m in enumerate(ms):
            qmargin[i + 1].append((m, sum(ms)))
    quarter_pts = {}
    for i in range(4):
        vals = [qpts["h"][j] for j in range(i, len(qpts["h"]), 4)] + [qpts["a"][j] for j in range(i, len(qpts["a"]), 4)]
        quarter_pts["Q%d" % (i + 1)] = round(sum(vals) / len(vals), 2) if vals else None
    quarter_corr = {}
    for i in (1, 2, 3, 4):
        xs = [m for m, f in qmargin[i]]
        ys = [f for m, f in qmargin[i]]
        r = pearson(xs, ys)
        quarter_corr["Q%d" % i] = round(r, 3) if r is not None else None
    for label, idx in (("Q2+Q3", (2, 3)), ("Q1+Q4", (1, 4))):
        xs = [sum(qmargin[i][k][0] for i in idx) for k in range(len(qmargin[1]))]
        ys = [qmargin[1][k][1] for k in range(len(qmargin[1]))]
        r = pearson(xs, ys)
        quarter_corr[label] = round(r, 3) if r is not None else None

    team_games = len(games) * 2
    print("\n코트시간 %.0f초 · 외국인 0명 %.2f%% / 1명 %.2f%% / 2명 %.4f%%" % (
        court_sec,
        nonkor_sec[0] / court_sec * 100,
        nonkor_sec[1] / court_sec * 100,
        sum(v for k, v in nonkor_sec.items() if k >= 2) / court_sec * 100,
    ))
    if two_detail:
        # 구간 목록을 통째로 찍으면 몇백 줄이 된다. 노이즈 여부는 "몇 초 · 몇 경기"로 판단한다.
        print("외국인 2명 동시 %d초 · %d구간 · %d경기: %s" % (
            sum(two_detail.values()), len(two_detail),
            len({g for g, _ in two_detail}),
            sorted(two_detail.items(), key=lambda kv: -kv[1])[:5]))
    print("쿼터 득점(팀당) %s" % quarter_pts)
    print("쿼터-최종 득실차 상관 %s" % quarter_corr)
    print("슬롯 %d행" % len(rows))

    if args.dry_run:
        for r in sorted(rows, key=lambda r: (r[1], r[4])):
            print("  %-4s %-8s %-8s %5.1f분 PER %s" % (r[1], r[4], r[3], r[6], r[8]))
        conn.close()
        return

    cur.execute(DDL)
    cur.execute(RLS)
    ensure_policy(cur, "import_slot_season")
    ensure_policy(cur, "import_rule_season")
    cur.execute("delete from import_slot_season where season_name = %s", (season,))
    execute_values(
        cur,
        """insert into import_slot_season
             (season_name, tcode, pcode, player_name, slot, games, minutes, mpg,
              per, pie40, pts40, fg_pct, q1_mpg, q2_mpg, q3_mpg, q4_mpg)
           values %s""",
        rows,
    )
    cur.execute(
        """insert into import_rule_season
             (season_name, team_games, court_sec, import0_sec, import1_sec, import2_sec,
              quarter_pts, quarter_corr)
           values (%s, %s, %s, %s, %s, %s, %s, %s)
           on conflict (season_name) do update set
             team_games = excluded.team_games, court_sec = excluded.court_sec,
             import0_sec = excluded.import0_sec, import1_sec = excluded.import1_sec,
             import2_sec = excluded.import2_sec, quarter_pts = excluded.quarter_pts,
             quarter_corr = excluded.quarter_corr, built_at = now()""",
        (season, team_games, court_sec, nonkor_sec[0], nonkor_sec[1],
         sum(v for k, v in nonkor_sec.items() if k >= 2), Json(quarter_pts), Json(quarter_corr)),
    )
    conn.commit()
    print("저장 완료")
    conn.close()


if __name__ == "__main__":
    main()
