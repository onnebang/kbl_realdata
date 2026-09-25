"""개막 전 로스터 변화 산출 - season_roster(확정 로스터) x 지난 시즌 출전 기록 -> roster_changes.

왜 필요한가: 개막 전 스카우팅 인사이트는 "직전 경기"가 지난 시즌 플레이오프라서, 이미 팀을
떠난 선수를 "이 선수를 막아야 한다"고 가리킨다(실측: 26-27 예정 경기의 프리뷰가 25-26 소속
기준으로 나옴). import_roster.py로 확정 로스터가 들어오면 이 스크립트가 팀별 잔류/영입/이탈/
신입을 지난 시즌 성적과 함께 roster_changes에 통째로 다시 써 넣고, 웹은 이걸로
  1. /preseason 개막 리포트("외국인 이동 지도")를 그리고
  2. 프리뷰 인사이트에서 'out' 선수를 걸러낸다.

판정 규칙(전부 문서화 - 웹 캡션에 그대로 인용):
  stay  로스터에 있고 지난 시즌에도 같은 팀에서 뛰었다
  in    로스터에 있고 지난 시즌엔 다른 팀에서 뛰었다(prev_tcode) = 이적
  back  로스터에 있고 지난 시즌엔 KBL 기록이 아예 없는데 그 전엔 있다 = 공백 후 복귀.
        KBL은 상무(군) 복무 기간의 경기가 KBL 기록에 남지 않아 그 2시즌이 통째로 비고, 장기
        부상도 같은 모양으로 빈다. 둘 다 "영입"이 아니라 "복귀"다(요청). 다만 어느 쪽인지는
        DB 어디에도 없으므로 사유는 적지 않고 공백 시즌 수만 note에 남긴다.
        외국인 선수의 재영입(패리스 배스 23-24 → 26-27)도 같은 모양이라 같은 판정을 쓰되,
        note에 '재영입'이라고 적어 국내 선수의 복귀와 구분한다.
  new   로스터에 있고 KBL 출전 기록이 전혀 없다(pcode 없음 - 첫 경기 때 자동 연결)
  out   지난 시즌 그 팀에서 MIN_GP_FOR_OUT 경기 이상 뛰었는데 그 팀의 이번 시즌 로스터에 없다.
        다른 팀 로스터에 있으면 next_tcode(이적), 없으면 리그 이탈.
        ! 다른 팀 로스터에서 이름이 확인되면(= 이적) 추측 없이 항상 out을 만든다.
        ! 어느 로스터에도 없는 경우는 그 팀의 국내 로스터가 들어온 뒤에만 판정한다(팀별로
          role이 없는 행 = 국내 선수가 하나라도 있는지로 확인). 아직이면 외국인(is_foreign_name)
          만 판정하고 국내 선수는 건너뛴다 - 국내 로스터가 들어오면 자동으로 전체 판정이 된다.

주의: prev_* 성적은 정규시즌+플레이오프 합산 평균이다(season_name만으로 집계). 웹의 시즌
전망표는 정규시즌 전적을 쓰므로 분모가 다르고, 화면 캡션에서 그 사실을 밝힌다.

사용:
    python build_roster_changes.py --season 2026-2027
    python build_roster_changes.py --season 2026-2027 --dry-run   # DB에 쓰지 않고 결과만
"""
import argparse
import os
import sys

import psycopg2
from psycopg2.extras import execute_values

from cache_invalidate import revalidate

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from import_roster import load_database_url  # noqa: E402  (같은 .env.supabase 해석)

MIN_GP_FOR_OUT = 5            # 이보다 적게 뛴 지난 시즌 선수(단기 대체 외국인 등)는 "이탈"로 세지 않음

# 외국인 판별: 한글 표기에 공백이 있으면 외국인("레이션 해먼즈"), 없으면 국내("이정현").
# 실측으로 확인한 근거 - 25-26 출전자 중 공백이 있는 국내 선수는 0명. 다만 귀화 선수는 공백
# 없는 한글 이름을 쓰므로 휴리스틱이 뚫린다(라건아). 그 예외만 명시적으로 적어둔다.
NATURALIZED_FOREIGN = {"라건아"}


def is_foreign_name(name):
    return (" " in (name or "")) or (name in NATURALIZED_FOREIGN)


def prev_season_name(season):
    """'2026-2027' -> '2025-2026'."""
    a, b = season.split("-")
    return "%d-%d" % (int(a) - 1, int(b) - 1)


def season_gap(last_season, prev):
    """마지막으로 뛴 시즌과 직전 시즌 사이에 통째로 빠진 시즌 수(1 이상).

    '2024-2025'가 마지막이고 직전이 '2025-2026'이면 25-26 한 시즌을 통으로 쉰 것 = 1.
    상무 복무는 보통 두 시즌에 걸친다."""
    return int(prev.split("-")[0]) - int(last_season.split("-")[0])


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


def fetch_departures(cur, season):
    """이 시즌에 등록은 돼 있지만 뛰지 않는 선수(tools/load_departures.py가 채운 표).

    pcode -> (tcode, player_name, reason, detail). 명부에는 없는 사실이라 사람이 확인해 넣는다."""
    cur.execute("""
        select pcode, tcode, player_name, reason, detail
        from roster_departure where season_name = %s
    """, (season,))
    return {r[0]: {"tcode": r[1], "name": r[2], "reason": r[3], "detail": r[4]} for r in cur.fetchall()}


REASON_LABEL = {
    "military": "군 입대",
    "overseas": "해외 진출",
    "unsigned": "FA 미계약",
    "retired": "은퇴",
    "other": "이탈",
}


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
    # 팀별 여러 행이면 가장 많이 뛴 팀을 대표로. 출전 수가 같으면(시즌 중 이적 선수에게
    # 실제로 일어난다) tcode로 2차 정렬 - 안 그러면 Postgres 반환 순서에 따라 stay/in
    # 분류가 실행마다 달라진다(실측 지적).
    for pcode in rows:
        rows[pcode].sort(key=lambda r: (-r["gp"], r["tcode"]))
    return rows


def fetch_names_to_pcodes(cur, names):
    """이름 -> pcode 목록. 동명이인 판별용(import_roster.py는 동명이인을 pcode 미연결로 남긴다)."""
    if not names:
        return {}
    cur.execute("select name, array_agg(pcode) from players where name = any(%s) group by name",
                (list(names),))
    return dict(cur.fetchall())


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
    # import_roster.py는 동명이인을 "모호함"으로 두고 pcode를 비운다. 그 행을 그대로 "신입 ·
    # KBL 출전 기록 없음"으로 발표하면, 같은 이름의 기존 선수가 있는데도 신인이라고 단언하게
    # 된다(그리고 그 선수는 옛 팀에서 "이탈"로 또 한 번 발표된다). 이름이 players에 이미
    # 있으면 신입으로 부르지 않고 확인 필요로 표시한다.
    name_pcodes = fetch_names_to_pcodes(cur, {r[2] for r in fetch_roster(cur, season)})

    # 이 시즌에 못 뛰는 선수는 로스터 판정에서 통째로 뺀다 - 명부에 남아 있다고 전력이 아니다.
    departures = fetch_departures(cur, season)

    roster_by_team = {}
    team_of_pcode = {}
    for tcode, pcode, name, note in roster:
        if pcode and pcode in departures:
            continue
        roster_by_team.setdefault(tcode, []).append((pcode, name, note))
        if pcode:
            team_of_pcode[pcode] = tcode

    # 지난 시즌에 없던 로스터 선수 -> 복귀인지(그 전 시즌 기록) 신입인지
    unseen = [pcode for pcode in team_of_pcode if pcode not in stats]
    last_before = fetch_last_season_before(cur, prev, unseen)  # prev 미만 시즌에서 찾는다

    out_rows = []

    def row(tcode, pcode, name, change, role, prev_tcode=None, next_tcode=None, prev_season=None, st=None,
            note=None, reason=None):
        st = st or {}
        out_rows.append((season, tcode, pcode, name, change, role, prev_tcode, next_tcode, prev_season,
                         st.get("gp"), st.get("ppg"), st.get("rpg"), st.get("apg"), st.get("mpg"), note, reason))

    # 1) 로스터 기준: stay / in / new
    for tcode, members in roster_by_team.items():
        for pcode, name, note in members:
            role = role_from_note(note)
            if not pcode:
                existing = name_pcodes.get(name) or []
                if existing:
                    # 이름은 이미 있는데 연결이 안 된 상태 = 동명이인이거나 표기 차이.
                    row(tcode, None, name, "new", role,
                        note="동명이인 확인 필요 - players에 같은 이름 %d명(%s). 확인 전까지 KBL 첫 시즌으로 단정하지 않음"
                             % (len(existing), ",".join(existing[:3])))
                else:
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
                gap = season_gap(last["season"], prev)
                kind = "재영입" if is_foreign_name(name) else "복귀"
                row(tcode, pcode, name, "back", role, prev_tcode=last["tcode"], prev_season=last["season"], st=last,
                    note="%s 시즌 이후 %d시즌 공백 · KBL %s" % (last["season"], gap, kind))
            else:
                # pcode는 있는데(과거 players 테이블 등재) 출전 기록이 없는 경우 - 사실상 신입
                row(tcode, pcode, name, "new", role, note="pcode는 있으나 KBL 출전 기록 없음")

    # 팀별로 "국내 선수 로스터가 들어왔는가" - import_roster.py가 외국인 행에만 role을 남기므로
    # role이 없는 행이 하나라도 있으면 그 팀은 국내 로스터까지 받은 것으로 본다. 예전엔 팀
    # 로스터 행수(<=9)로 판단했는데, 국내 로스터가 부분 입력된 팀(예: 10명)이 그 순간 "완비"로
    # 넘어가면서 아직 안 들어온 선수들을 무더기로 "리그 이탈"이라고 발표하는 절벽이 있었다.
    domestic_loaded = {
        tcode: any(role_from_note(note) is None for _, _, note in members)
        for tcode, members in roster_by_team.items()
    }

    # 1-b) 확인된 이탈(군 입대·해외 진출·미계약) - 문턱 없이 무조건 내보낸다.
    # 지난 시즌 출전이 적은 어린 선수도 있어서 아래 MIN_GP_FOR_OUT에 걸리면 "사라졌다"는 사실
    # 자체가 화면에서 없어진다.
    for pcode, d in sorted(departures.items()):
        st_rows = stats.get(pcode)
        st = None
        prev_season_of = None
        if st_rows:
            st = st_rows[0]
            prev_season_of = prev
        else:
            last = fetch_last_season_before(cur, prev, [pcode]).get(pcode)
            if last:
                st = last
                prev_season_of = last["season"]
        label = REASON_LABEL.get(d["reason"], "이탈")
        row(d["tcode"], pcode, d["name"], "out", None, prev_season=prev_season_of, st=st,
            note=(label + (" · " + d["detail"] if d["detail"] else "")), reason=d["reason"])

    # 2) 지난 시즌 기준: out (로스터가 들어온 팀만 판정 가능)
    for pcode, st_rows in stats.items():
        if pcode in departures:
            continue  # 위에서 이유를 달아 이미 내보냈다
        for st in st_rows:
            tcode = st["tcode"]
            if tcode not in roster_by_team or st["gp"] < MIN_GP_FOR_OUT:
                continue
            if team_of_pcode.get(pcode) == tcode:
                continue  # stay
            foreign_only_stage = not domestic_loaded.get(tcode, False)
            next_tcode = team_of_pcode.get(pcode)
            # 다른 팀 로스터에 이름이 있으면 이적이 확정적이라 추측이 필요 없다. 그 외에는
            # 국내 로스터가 아직 안 들어온 팀의 국내 선수를 "이탈"로 발표할 수 없다.
            if next_tcode is None and foreign_only_stage and not is_foreign_name(st["name"]):
                continue
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
    order = {"in": 0, "back": 1, "new": 2, "stay": 3, "out": 4}
    for tcode in sorted(by_team, key=lambda t: abbr.get(t, t)):
        print("  [%s]" % abbr.get(tcode, tcode))
        for r in sorted(by_team[tcode], key=lambda r: (order[r[4]], -(r[9] or 0))):
            _, _, pcode, name, change, role, prev_t, next_t, prev_s, gp, ppg, rpg, apg, mpg, note, reason = r
            extra = ""
            if change in ("in", "back"):
                extra = " <- %s" % abbr.get(prev_t, prev_t)
            elif change == "out" and next_t:
                extra = " -> %s" % abbr.get(next_t, next_t)
            line = "    %-4s %-14s %s" % (change, name, (role or "").ljust(8))
            if gp:
                line += " %s %2d경기 %4.1f점 %4.1fR %4.1fA" % (prev_s, gp, ppg, rpg, apg)
            print(line + extra + ("  (%s)" % note if note and change in ("in", "back", "new") else ""))

    if args.dry_run:
        print("\n--dry-run: DB에 쓰지 않았다.")
        return

    cur.execute("delete from roster_changes where season_name = %s", (args.season,))
    execute_values(cur, """
        insert into roster_changes
          (season_name, tcode, pcode, player_name, change, role, prev_tcode, next_tcode, prev_season_name,
           prev_gp, prev_ppg, prev_rpg, prev_apg, prev_mpg, note, reason)
        values %s
    """, rows)
    conn.commit()
    print("\nroster_changes 재생성 완료: %d행" % len(rows))
    # 2026-09-25(revalidateTag 연동) - 오늘 삼성/정관장 로스터 사진이 코드 수정 뒤에도 최대
    # 1시간 안 보였던 그 버그(rosterChangeReport_v2 캐시가 안 풀려서)의 근본 수정.
    revalidate(["manual:build", "batch:daily", f"season:{args.season}"])


if __name__ == "__main__":
    main()
