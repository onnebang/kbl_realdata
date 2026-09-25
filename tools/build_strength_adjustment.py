"""조정 전망 - 로스터를 다시 조립해 팀 전력 델타를 낸다 (2026-09-05, 사용자 요청).

요청: "가스공사, kcc, db, 삼성은 타격이 큰걸로 나오는데, 주전선수들의 군/해외행의 이탈과
바뀐 용병제도를 포함해서 시즌 전망의 AI 예상순위를 변경해줘 ... 바뀐 규정에 대한 데이터가
부족해서 정확도가 낮습니다. (하지만 낮아도 제공 해줘야돼, 이게 제일 재밌단 말야)"

## 먼저: 이건 측정이 아니라 시나리오다
이 프로젝트는 앞서 "이탈로 다음 시즌 득실차 변화를 설명한 R²가 0.001"이라는 실측을 근거로
승수 환산을 거부했다. 그 실측은 여전히 유효하다. 사용자가 그걸 알고도 재미로 보고 싶다고
명시했으므로 만들되, **지어낸 것과 잰 것을 파일과 화면 양쪽에서 분리한다.**

잰 것(전부 이 저장소 데이터):
  · 팀 분가중 PER 1점 = 경기당 득실차 4.435점 (150 팀-시즌, R²=0.947)
  · 시간축을 한 시즌 밀면 산술이 3.3~3.7배 과대 -> 축소율 0.30 (out-of-sample)
  · 경기당 득실차 1점 = 54경기 1.86승 (R²=0.891) -> p=0.5 근처 로짓 기울기 0.1378
  · KBL 첫 시즌 비국내 선수 195명(300분+)의 PER 분포: 10% 17.1 / 25% 20.8 / 50% 24.1 /
    75% 28.1 / 90% 30.7. 아시아쿼터 첫 시즌 중앙값 16.2
  · 25-26 국내 500분+ 65명 분가중 PER 13.28
  · 팀별 뎁스 = 그 팀 잔류 선수 중 출전분 9~14위의 분가중 PER (4.9 ~ 12.0으로 팀마다 크게 다름)

지어낸 것(사용자가 준 스카우팅 + 내 가정):
  · 신입 7명의 등급 -> 위 분포의 분위수에 배치 (tools/data/import_scouting_*.csv)
  · 규정 변경으로 외국인 2옵션이 경기당 10분(2·3쿼터 20분의 절반)을 더 뛴다는 가정
  · 그 10분을 국내 로테이션(13.28)에서 가져온다는 가정

## 왜 "PER - 리그 대체수준" 방식을 안 쓰는가
그 방식은 리그 평균 대체수준(13.01)을 쓰는데, 확정 결장 13명 전원의 PER이 그 아래라
**10팀 전부가 이득을 본다**는 결과가 나온다(이전 워크플로 실측). 실제로는 빠진 자리를 그 팀이
가진 다음 선수로 메워야 하고 그 뎁스는 팀마다 4.9~12.0으로 갈린다. 그래서 로스터를 통째로
다시 조립하고 남는 분을 팀별 뎁스로 채운다.

## 조립 규칙
  · 26-27 명부에 있고 25-26 기록이 있는 선수 -> 그 선수의 25-26 출전분과 PER 그대로
    (이적해 온 선수도 옛 팀 기록을 들고 온다. 26-27 출전분을 25-26과 같다고 보는 가정이다)
  · 확정 결장 13명 -> 0분
  · 외국인/아시아쿼터 세 슬롯 -> 26-27 등록 선수가 그 팀 25-26 같은 슬롯의 출전분을 물려받고,
    PER은 (같은 팀 잔류) 자기 25-26 값 / (복귀·이적) 마지막 KBL 시즌 값 / (신입) 스카우팅 사전확률
  · 남는 분 -> 그 팀 뎁스 PER
  · 아시아쿼터를 등록하지 않은 팀(26-27 KCC)은 그 슬롯 분이 통째로 뎁스로 간다

## 신인 드래프트 이후 (2026-11-09)
드래프트 선수는 KBL 기록이 없어 이 조립에서 "남는 분"으로 흘러 팀 뎁스 PER로 채워진다.
그게 타당한 처리인지 실측했다 - 최근 시즌 신인의 분가중 PER은 11.0이고 팀 뎁스는 7.2~12.0
(평균 9.8)이라 거의 같은 자리다. 신인이 국내 출전시간에서 차지한 몫은 시즌마다 1.4~14.0%
(25-26은 9.0%, 500분 이상 6명)였다. 그러니 드래프트가 끝나면 특별한 코드 변경 없이
    fetch_kbl_roster.py -> import_roster.py -> build_roster_changes.py -> 이 스크립트
순서로 다시 돌리기만 하면 된다. (신인을 스카우팅 등급으로 따로 다루고 싶으면
tools/data/import_scouting_*.csv 와 같은 방식으로 표를 하나 더 두면 되지만, 위 실측을 보면
뎁스로 채우는 것과 큰 차이가 없다.)

## 사용
    python build_strength_adjustment.py --season 2026-2027
    python build_strength_adjustment.py --season 2026-2027 --dry-run
"""
import argparse
import csv
import io
import os
import sys
from collections import defaultdict

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402
from cache_invalidate import revalidate  # noqa: E402

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
SEASON_CATEGORY = "정규시즌"

# ── 실측 계수 (전부 이 저장소 데이터에서 잰 값) ─────────────────────────────────────
PER_TO_MARGIN = 4.435          # 팀 분가중 PER 1점 = 경기당 득실차 (150 팀-시즌, R²=0.947)
SHRINK = 0.30                  # 시간축을 밀면 산술이 3.3배 과대 (out-of-sample 기울기 0.307)
DOMESTIC_ROTATION_PER = 13.28  # 25-26 국내 500분+ 65명 분가중 PER
TEAM_MIN_PER_GAME = 200.0      # 5명 × 40분
DEPTH_RANK_FROM, DEPTH_RANK_TO = 9, 14  # 팀 뎁스로 볼 출전분 순위 구간

# ── 가정 (실측이 아니다 - 화면이 반드시 밝혀야 한다) ──────────────────────────────
RULE_EXTRA_MIN = 10.0          # 규정 변경으로 외국인 2옵션이 더 뛴다고 가정하는 경기당 분

# 신입 선수 등급 -> PER. KBL 첫 시즌 비국내 선수 195명(300분+) PER 분포의 분위수.
TIER_PER = {"특급": 30.7, "상급": 28.1, "중급": 24.1, "역할": 20.8, "아쿼중급": 16.2}
TIER_NOTE = {
    "특급": "첫 시즌 상위 10%",
    "상급": "첫 시즌 상위 25%",
    "중급": "첫 시즌 중앙값",
    "역할": "첫 시즌 하위 25%",
    "아쿼중급": "아시아쿼터 첫 시즌 중앙값",
}

# 다음 시즌 PER 회귀 - (그룹, 공백여부) -> (절편, 기울기, 표본).
# 15시즌 300분+ 시즌쌍을 직접 회귀한 값. 공백이 있으면 평균 회귀가 훨씬 세다.
PER_CARRY = {
    ("import", False): (4.65, 0.789, 131),
    ("import", True): (12.29, 0.491, 38),
    ("domestic", False): (3.76, 0.690, 824),
    ("domestic", True): (4.48, 0.573, 162),
}


def carry(per, group, gapped):
    """지난 시즌 PER을 다음 시즌 기대 PER로. 회귀 계수는 PER_CARRY(실측)."""
    a, b, _ = PER_CARRY[(group, gapped)]
    return a + b * per


SLOT_OF = {"아시아쿼터": "aq", "외국인 1옵션": "import1", "외국인 2옵션": "import2"}
SLOT_LABEL = {"aq": "아시아쿼터", "import1": "외국인 1옵션", "import2": "외국인 2옵션"}

DDL = """
create table if not exists strength_adjustment_team (
  season_name   text not null,
  tcode         text not null,
  per_prev      numeric not null,
  per_next      numeric not null,
  d_per_roster  numeric not null,
  d_per_depart  numeric not null,
  d_per_slot    numeric not null,
  d_per_other   numeric not null,
  d_per_rule    numeric not null,
  d_margin_roster numeric not null,
  d_margin_depart numeric not null,
  d_margin_slot   numeric not null,
  d_margin_other  numeric not null,
  d_margin_rule   numeric not null,
  d_margin_total  numeric not null,
  depth_per     numeric not null,
  known_minutes numeric not null,
  total_minutes numeric not null,
  primary key (season_name, tcode)
);

create table if not exists strength_adjustment_player (
  season_name text not null,
  tcode       text not null,
  slot        text not null,
  player_name text not null,
  pcode       text,
  minutes     numeric not null,
  per         numeric not null,
  per_source  text not null,
  prev_name   text,
  prev_per    numeric,
  tier        text,
  evidence    text,
  primary key (season_name, tcode, slot)
);
"""


def ensure_policy(cur, table):
    cur.execute("alter table %s enable row level security" % table)
    cur.execute("select 1 from pg_policies where tablename = %s and policyname = %s",
                (table, "public read " + table))
    if not cur.fetchone():
        # 락다운(tools/lockdown_anon.sql) 이후로는 공개 읽기 정책을 만들지 않는다 - 서버는
        # service_role로 읽으므로 정책이 없어도 동작한다. 예전엔 이 줄이 배치를 돌릴 때마다
        # 락다운을 조용히 되돌려 테이블이 다시 anon 공개가 됐다(감사 실측).
        # cur.execute('create policy "public read %s" on %s for select using (true)' % (table, table))
        pass


def short_season(season):
    """2025-2026 -> 25-26 (화면 표기 규약)."""
    a, b = season.split("-")
    return "%s-%s" % (a[2:], b[2:])


def prev_season(season):
    a = int(season.split("-")[0])
    return "%d-%d" % (a - 1, a)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2026-2027")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    season, prev = args.season, prev_season(args.season)

    path = os.path.join(DATA_DIR, "import_scouting_%s.csv" % season.replace("-", "_"))
    scout = {}
    if os.path.exists(path):
        with io.open(path, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                tier = (r.get("tier") or "").strip()
                if tier not in TIER_PER:
                    sys.exit("모르는 등급 %r (%s) - 허용: %s" % (tier, r.get("player_name"), sorted(TIER_PER)))
                scout[(r["player_name"] or "").strip()] = (tier, (r.get("evidence") or "").strip())
        print("스카우팅 입력 %d명: %s" % (len(scout), ", ".join(sorted(scout))))
    else:
        print("스카우팅 파일 없음(%s) - 신입 선수는 첫 시즌 중앙값으로" % os.path.basename(path))

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()

    # 직전 시즌 선수별 출전분·PER
    cur.execute("""
        select s.tcode, s.pcode, p.name, sum(s.min_played),
               sum(s.min_played * s.per) / nullif(sum(s.min_played), 0)
          from game_player_stats s
          join games g on g.gmkey = s.gmkey
          join players p on p.pcode = s.pcode
         where g.season_name = %s and g.season_category = %s and coalesce(s.min_played, 0) > 0
         group by 1, 2, 3""", (prev, SEASON_CATEGORY))
    prev25, team_total = {}, defaultdict(float)
    for tc, pc, nm, mn, per in cur.fetchall():
        prev25[pc] = {"tcode": tc, "name": nm, "min": float(mn), "per": float(per)}
        team_total[tc] += float(mn)
    if not prev25:
        sys.exit("%s 기록이 없다" % prev)

    # 마지막 KBL 정규시즌 기록(복귀 선수용)
    cur.execute("""
        with x as (
          select s.pcode, g.season_name,
                 sum(s.min_played) mn,
                 sum(s.min_played * s.per) / nullif(sum(s.min_played), 0) per
            from game_player_stats s join games g on g.gmkey = s.gmkey
           where g.season_category = %s and coalesce(s.min_played, 0) > 0
           group by 1, 2)
        select pcode, season_name, mn, per from x
         where (pcode, season_name) in (select pcode, max(season_name) from x group by 1)""",
                (SEASON_CATEGORY,))
    last_kbl = {r[0]: {"season": r[1], "min": float(r[2]), "per": float(r[3])} for r in cur.fetchall()}

    cur.execute("select pcode from roster_departure where season_name = %s", (season,))
    gone = {r[0] for r in cur.fetchall()}

    # 비국내 여부 - 슬롯 표에 있으면 확정, 없으면 이름에 공백(이 저장소가 쓰는 판정과 같다).
    cur.execute("select distinct pcode from import_slot_season")
    slot_pcodes = {r[0] for r in cur.fetchall()}

    def group_of(pcode, name):
        if pcode and pcode in slot_pcodes:
            return "import"
        return "import" if (" " in (name or "") or name == "라건아") else "domestic"

    cur.execute("select tcode, pcode, player_name, note from season_roster where season_name = %s", (season,))
    roster = cur.fetchall()
    roster_pcodes = {r[1] for r in roster if r[1]}

    cur.execute("select tcode, slot, sum(minutes), sum(minutes * per) / nullif(sum(minutes), 0) "
                "from import_slot_season where season_name = %s group by 1, 2", (prev,))
    slot25 = {(r[0], r[1]): (float(r[2]), float(r[3] or 0)) for r in cur.fetchall()}
    cur.execute("select tcode, slot, player_name, minutes from import_slot_season where season_name = %s "
                "order by minutes desc", (prev,))
    slot25_who = defaultdict(list)
    for tc, sl, nm, mn in cur.fetchall():
        slot25_who[(tc, sl)].append(nm)

    # 팀 뎁스 = 잔류(26-27 명부 O, 결장 X) 선수 중 출전분 9~14위의 분가중 PER
    depth = {}
    for tc in team_total:
        kept = sorted(
            [v for pc, v in prev25.items() if v["tcode"] == tc and pc not in gone and pc in roster_pcodes],
            key=lambda v: -v["min"])[DEPTH_RANK_FROM - 1:DEPTH_RANK_TO]
        m = sum(v["min"] for v in kept)
        # 뎁스도 같은 회귀를 통과시킨다(대부분 국내 선수라 국내 계수).
        depth[tc] = (carry(sum(v["min"] * v["per"] for v in kept) / m, "domestic", False)
                     if m > 0 else DOMESTIC_ROTATION_PER)

    team_rows, player_rows = [], []
    for tc in sorted(team_total):
        tot = team_total[tc]
        mine = [r for r in roster if r[0] == tc]
        used = wsum = 0.0
        i2_per = None

        # ── 순차 분해용 중간 단계 ────────────────────────────────────────────────
        # (1) 이탈만: 25-26 그 팀 명단에서 확정 결장자만 빼고, 빈 분은 팀 뎁스로 메운다.
        own = [(pc, v) for pc, v in prev25.items() if v["tcode"] == tc]
        # 기준선 = "25-26 로스터를 그대로 뒀을 때의 투영". 실측값이 아니라 투영값이라야
        # 아래 델타에서 평균 회귀 성분이 상쇄된다.
        base_w = sum(v["min"] * carry(v["per"], group_of(pc, v["name"]), False) for pc, v in own)
        dep_min = sum(v["min"] for pc, v in own if pc in gone)
        dep_w = sum(v["min"] * carry(v["per"], group_of(pc, v["name"]), False) for pc, v in own if pc in gone)
        per_prev0 = sum(v["min"] * v["per"] for _, v in own) / tot   # 화면 표시용 25-26 실측
        per_base = base_w / tot
        per_after_dep = (base_w - dep_w + dep_min * depth[tc]) / tot
        # (2) 이탈 + 슬롯 교체: 슬롯 출전분은 그대로 두고 그 자리의 PER만 바꾼다.
        slot_swap_w = 0.0

        for _, pc, nm, note in mine:
            slot = SLOT_OF.get((note or "").split("|")[0].strip())
            if not slot:
                continue
            mins, old_raw = slot25.get((tc, slot), (0.0, 0.0))
            old_per = carry(old_raw, "import", False) if old_raw else 0.0
            if pc and pc in prev25 and prev25[pc]["tcode"] == tc and pc not in gone:
                raw = prev25[pc]["per"]
                per = carry(raw, "import", False)
                src, tier, ev = "%s 실적 %.1f → 투영 %.1f" % (short_season(prev), raw, per), None, None
            elif pc and pc in last_kbl:
                lk = last_kbl[pc]
                gapped = lk["season"] != prev
                per = carry(lk["per"], "import", gapped)
                src = "%s 실적 %.1f → 투영 %.1f%s" % (
                    short_season(lk["season"]), lk["per"], per, " · 공백 후 복귀" if gapped else "")
                tier = ev = None
            else:
                tier, ev = scout.get(nm, ("중급", ""))
                per, src = TIER_PER[tier], "스카우팅 사전확률(%s)" % TIER_NOTE[tier]
            used += mins
            wsum += mins * per
            slot_swap_w += mins * (per - old_per)
            if slot == "import2":
                i2_per = per
            player_rows.append((season, tc, slot, nm, pc, round(mins, 1), round(per, 2), src,
                                " · ".join(slot25_who.get((tc, slot), [])) or None,
                                round(old_raw, 2) if mins > 0 else None, tier, ev or None))

        for _, pc, nm, note in mine:
            if SLOT_OF.get((note or "").split("|")[0].strip()):
                continue  # 위에서 슬롯으로 셌다
            if pc and pc in prev25 and pc not in gone:
                v = prev25[pc]
                used += v["min"]
                wsum += v["min"] * carry(v["per"], group_of(pc, v["name"]), False)

        rest = max(0.0, tot - used)
        per_next = (wsum + rest * depth[tc]) / tot
        per_prev = per_prev0
        per_after_slot = per_after_dep + slot_swap_w / tot

        # 델타의 기준선은 투영-대-투영(per_base)이다. 실측(per_prev0)과 빼면 평균 회귀가 섞인다.
        d_per_depart = per_after_dep - per_base
        d_per_slot = per_after_slot - per_after_dep
        d_per_other = per_next - per_after_slot   # 국내 영입·미계약·신인 등 나머지 로스터 이동
        d_per_roster = per_next - per_prev
        d_per_rule = ((RULE_EXTRA_MIN / TEAM_MIN_PER_GAME) * (i2_per - DOMESTIC_ROTATION_PER)) if i2_per else 0.0
        k = PER_TO_MARGIN * SHRINK
        mr, mu = d_per_roster * k, d_per_rule * k
        team_rows.append((season, tc, round(per_prev, 3), round(per_next, 3), round(d_per_roster, 3),
                          round(d_per_depart, 3), round(d_per_slot, 3), round(d_per_other, 3),
                          round(d_per_rule, 3), round(mr, 3), round(d_per_depart * k, 3),
                          round(d_per_slot * k, 3), round(d_per_other * k, 3), round(mu, 3),
                          round(mr + mu, 3), round(depth[tc], 2), round(used, 1), round(tot, 1)))

    mean = sum(r[14] for r in team_rows) / len(team_rows)
    print("\n리그 평균 Δ합계 %+0.2f점 - 순위는 차이로만 정해지므로 화면은 이 값을 뺀 상대 델타를 쓴다.\n" % mean)
    print("%-4s %6s %6s %8s %8s %8s %8s %8s   %s"
          % ("팀", "25-26", "26-27", "Δ이탈", "Δ슬롯", "Δ기타", "Δ규정", "상대Δ", "뎁스 / 잔류분"))
    for r in sorted(team_rows, key=lambda r: -r[14]):
        print("%-4s %6.2f %6.2f %+8.2f %+8.2f %+8.2f %+8.2f %+8.2f   %5.2f / %.0f분(%.0f%%)"
              % (r[1], r[2], r[3], r[10], r[11], r[12], r[13], r[14] - mean,
                 r[15], r[16], r[16] / r[17] * 100))

    if args.dry_run:
        conn.close()
        return

    cur.execute(DDL)
    ensure_policy(cur, "strength_adjustment_team")
    ensure_policy(cur, "strength_adjustment_player")
    cur.execute("delete from strength_adjustment_team where season_name = %s", (season,))
    cur.execute("delete from strength_adjustment_player where season_name = %s", (season,))
    execute_values(cur, """insert into strength_adjustment_team
        (season_name, tcode, per_prev, per_next, d_per_roster, d_per_depart, d_per_slot,
         d_per_other, d_per_rule, d_margin_roster, d_margin_depart, d_margin_slot,
         d_margin_other, d_margin_rule, d_margin_total, depth_per, known_minutes,
         total_minutes) values %s""", team_rows)
    execute_values(cur, """insert into strength_adjustment_player
        (season_name, tcode, slot, player_name, pcode, minutes, per, per_source, prev_name,
         prev_per, tier, evidence) values %s""", player_rows)
    conn.commit()
    print("\n저장 완료 - 팀 %d행 · 슬롯 %d행" % (len(team_rows), len(player_rows)))
    revalidate(["manual:build", "batch:daily", f"season:{season}"])
    conn.close()


if __name__ == "__main__":
    main()
