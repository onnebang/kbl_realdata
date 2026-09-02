"""개막 전 로스터 변화 산출 - season_roster(확정 로스터) x 지난 시즌 출전 기록 -> roster_changes.

왜 필요한가: 개막 전 스카우팅 인사이트는 "직전 경기"가 지난 시즌 플레이오프라서, 이미 팀을
떠난 선수를 "이 선수를 막아야 한다"고 가리킨다(실측: 26-27 예정 경기의 프리뷰가 25-26 소속
기준으로 나옴). import_roster.py로 확정 로스터가 들어오면 이 스크립트가 팀별 잔류/영입/이탈/
신입을 지난 시즌 성적과 함께 roster_changes에 통째로 다시 써 넣고, 웹은 이걸로
  1. /preseason 개막 리포트("외국인 이동 지도")를 그리고
  2. 프리뷰 인사이트에서 'out' 선수를 걸러낸다.

판정 규칙(전부 문서화 - 웹 캡션에 그대로 인용):
  stay  로스터에 있고 지난 시즌에도 같은 팀에서 뛰었다
  in    로스터에 있고 지난 시즌엔 다른 팀에서 뛰었다(prev_tcode) - 또는 지난 시즌엔 KBL에 없었지만
        그 전에 뛴 적이 있다(복귀, prev_season_name이 지난 시즌이 아님)
  new   로스터에 있고 KBL 출전 기록이 전혀 없다(pcode 없음 - 첫 경기 때 자동 연결)
  out   지난 시즌 그 팀에서 MIN_GP_FOR_OUT 경기 이상 뛰었는데 그 팀의 이번 시즌 로스터에 없다.
        다른 팀 로스터에 있으면 next_tcode(이적), 없으면 리그 이탈.
        ! 로스터가 외국인만 들어온 단계(팀당 FOREIGN_ONLY_ROSTER_MAX행 이하)에서는 국내 선수의
          이탈을 판정할 수 없으므로 외국인 표기(이름에 공백 - 한국 선수 이름엔 공백이 없음)만
          본다. 국내 로스터가 들어오면 같은 스크립트가 자동으로 전체 판정으로 바뀐다.

사용:
    python build_roster_changes.py --season 2026-2027
    python build_roster_changes.py --season 2026-2027 --dry-run   # DB에 쓰지 않고 결과만
"""
import argparse
import os
import sys

import psycopg2
from psycopg2.extras import execute_values

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402  (같은 .env.supabase 해석)

MIN_GP_FOR_OUT = 5            # 이보다 적게 뛴 지난 시즌 선수(단기 대체 외국인 등)는 "이탈"로 세지 않음
FOREIGN_ONLY_ROSTER_MAX = 9   # 팀 로스터 행이 이 이하면 외국인만 들어온 단계로 본다(외국인 최대 3명 + 여유)


def prev_season_name(season):
    """'2026-2027' -> '2025-2026'."""
    a, b = season.split("-")
    return "%d-%d" % (int(a) - 1, int(b) - 1)


def role_from_note(note):
    """import_roster.py가 note 첫 토큰에 넣은 '외국인 1옵션' 같은 구분(없으면 None)."""
    if not note:
        return None
    head = note.split("|")[0].strip()
    return head if head and ("외국인" in head or "아시아" in head) else None


def fetch_roster(cur, season):
    cur.execute("""
        select tcode, pcode, player_name, note from season_roster where season_name = %s
    """, (season,))
    return cur.fetchall()


def fetch_season_stats(cur, season):
    """지난 시즌 (pcode, tcode)별 출전 성적. 시즌 중 이적한 선수는 팀별로 두 행이 나온다."""
    cur.execute("""
        select gps.pcode, gps.tcode, p.name, count(*) gp,
               round(avg(gps.pts)::numeric, 1), round(avg(gps.reb)::numeric, 1),
               round(avg(gps.ast)::numeric, 1), round(avg(gps.min_played)::numeric, 1)
        from game_player_stats gps
        join games g on g.gmkey = gps.gmkey and g.season_name = %s
        join players p on p.pcode = gps.pcode
        group by gps.pcode, gps.tcode, p.name
    """, (season,))
    rows = {}
    for pcode, tcode, name, gp, ppg, rpg, apg, mpg in cur.fetchall():
        rows.setdefault(pcode, []).append(
            {"tcode": tcode, "name": name, "gp": gp, "ppg": ppg, "rpg": rpg, "apg": apg, "mpg": mpg})
    # 팀별 여러 행이면 가장 많이 뛴 팀을 대표로
    for pcode in rows:
        rows[pcode].sort(key=lambda r: -r["gp"])
    return rows


def fetch_last_season_before(cur, season, pcodes):
    """지난 시즌엔 없었던 로스터 선수의 '마지막 KBL 시즌'(복귀 판정용)."""
    if not pcodes:
        return {}
    cur.execute("""
        with ranked as (
          select gps.pcode, g.season_name, gps.tcode, count(*) gp,
                 round(avg(gps.pts)::numeric, 1) ppg, round(avg(gps.reb)::numeric, 1) rpg,
                 round(avg(gps.ast)::numeric, 1) apg, round(avg(gps.min_played)::numeric, 1) mpg,
                 row_number() over (partition by gps.pcode order by g.season_name desc, count(*) desc) rn
          from game_player_stats gps join games g on g.gmkey = gps.gmkey
          where gps.pcode = any(%s) and g.season_name < %s
          group by gps.pcode, g.season_name, gps.tcode
        )
        select pcode, season_name, tcode, gp, ppg, rpg, apg, mpg from ranked where rn = 1
    """, (list(pcodes), season))
    return {r[0]: {"season": r[1], "tcode": r[2], "gp": r[3], "ppg": r[4], "rpg": r[5], "apg": r[6], "mpg": r[7]}
            for r in cur.fetchall()}


def build(cur, season):
    prev = prev_season_name(season)
    roster = fetch_roster(cur, season)
    if not roster:
        sys.exit("season_roster에 %s 로스터가 없다 - import_roster.py로 먼저 적재해줘." % season)
    stats = fetch_season_stats(cur, prev)

    roster_by_team = {}
    team_of_pcode = {}
    for tcode, pcode, name, note in roster:
        roster_by_team.setdefault(tcode, []).append((pcode, name, note))
        if pcode:
            team_of_pcode[pcode] = tcode

    # 지난 시즌에 없던 로스터 선수 -> 복귀인지(그 전 시즌 기록) 신입인지
    unseen = [pcode for pcode in team_of_pcode if pcode not in stats]
    last_before = fetch_last_season_before(cur, prev, unseen)  # prev 미만 시즌에서 찾는다

    out_rows = []

    def row(tcode, pcode, name, change, role, prev_tcode=None, next_tcode=None, prev_season=None, st=None, note=None):
        st = st or {}
        out_rows.append((season, tcode, pcode, name, change, role, prev_tcode, next_tcode, prev_season,
                         st.get("gp"), st.get("ppg"), st.get("rpg"), st.get("apg"), st.get("mpg"), note))

    # 1) 로스터 기준: stay / in / new
    for tcode, members in roster_by_team.items():
        for pcode, name, note in members:
            role = role_from_note(note)
            if not pcode:
                row(tcode, None, name, "new", role, note="KBL 출전 기록 없음 - 첫 경기 때 pcode 자동 연결")
                continue
            st_rows = stats.get(pcode)
            if st_rows:
                main = st_rows[0]
                if main["tcode"] == tcode:
                    row(tcode, pcode, name, "stay", role, prev_season=prev, st=main)
                else:
                    row(tcode, pcode, name, "in", role, prev_tcode=main["tcode"], prev_season=prev, st=main,
                        note="%s 시즌 다른 팀에서 이적" % prev)
                continue
            last = last_before.get(pcode)
            if last:
                row(tcode, pcode, name, "in", role, prev_tcode=last["tcode"], prev_season=last["season"], st=last,
                    note="%s 시즌 이후 KBL 복귀" % last["season"])
            else:
                # pcode는 있는데(과거 players 테이블 등재) 출전 기록이 없는 경우 - 사실상 신입
                row(tcode, pcode, name, "new", role, note="pcode는 있으나 KBL 출전 기록 없음")

    # 2) 지난 시즌 기준: out (로스터가 들어온 팀만 판정 가능)
    for pcode, st_rows in stats.items():
        for st in st_rows:
            tcode = st["tcode"]
            if tcode not in roster_by_team or st["gp"] < MIN_GP_FOR_OUT:
                continue
            if team_of_pcode.get(pcode) == tcode:
                continue  # stay
            foreign_only_stage = len(roster_by_team[tcode]) <= FOREIGN_ONLY_ROSTER_MAX
            if foreign_only_stage and " " not in st["name"]:
                continue  # 국내 선수는 아직 판정 불가(로스터 미수신)
            next_tcode = team_of_pcode.get(pcode)
            row(tcode, pcode, st["name"], "out", None, next_tcode=next_tcode, prev_season=prev, st=st,
                note=("다른 팀으로 이적" if next_tcode else
                      ("리그 이탈(로스터 미포함)" if not foreign_only_stage else "외국인 교체 - 이번 시즌 로스터 미포함")))

    return out_rows, prev


def main():
    ap = argparse.ArgumentParser(description="개막 전 로스터 변화 산출")
    ap.add_argument("--season", required=True, help="이번 시즌명(예: 2026-2027)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()
    rows, prev = build(cur, args.season)

    cur.execute("select tcode, abbr from teams")
    abbr = dict(cur.fetchall())
    by_team = {}
    for r in rows:
        by_team.setdefault(r[1], []).append(r)
    print("%s 로스터 변화 (지난 시즌 %s 기준) - %d행" % (args.season, prev, len(rows)))
    order = {"in": 0, "new": 1, "stay": 2, "out": 3}
    for tcode in sorted(by_team, key=lambda t: abbr.get(t, t)):
        print("  [%s]" % abbr.get(tcode, tcode))
        for r in sorted(by_team[tcode], key=lambda r: (order[r[4]], -(r[9] or 0))):
            _, _, pcode, name, change, role, prev_t, next_t, prev_s, gp, ppg, rpg, apg, mpg, note = r
            extra = ""
            if change == "in":
                extra = " <- %s" % abbr.get(prev_t, prev_t)
            elif change == "out" and next_t:
                extra = " -> %s" % abbr.get(next_t, next_t)
            line = "    %-4s %-14s %s" % (change, name, (role or "").ljust(8))
            if gp:
                line += " %s %2d경기 %4.1f점 %4.1fR %4.1fA" % (prev_s, gp, ppg, rpg, apg)
            print(line + extra + ("  (%s)" % note if note and change in ("in", "new") else ""))

    if args.dry_run:
        print("\n--dry-run: DB에 쓰지 않았다.")
        return

    cur.execute("delete from roster_changes where season_name = %s", (args.season,))
    execute_values(cur, """
        insert into roster_changes
          (season_name, tcode, pcode, player_name, change, role, prev_tcode, next_tcode, prev_season_name,
           prev_gp, prev_ppg, prev_rpg, prev_apg, prev_mpg, note)
        values %s
    """, rows)
    conn.commit()
    print("\nroster_changes 재생성 완료: %d행" % len(rows))


if __name__ == "__main__":
    main()
