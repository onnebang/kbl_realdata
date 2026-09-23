# -*- coding: utf-8 -*-
"""경기 전 스타팅 라인업 조회 - player-stat의 startFlag를 읽는다.

**이 모듈이 존재하는 이유와 미검증 구간**

KBL API엔 "라인업" 전용 엔드포인트가 없다(실측: /match/{gmkey}는 teams.staffs에 감독·코치만
주고 선수 명단은 종료 경기에서도 안 준다). 선수 단위 정보는 player-stat에만 있고, 거기
`startFlag`(0/1)가 선발 여부다 - 종료 경기 S47G04N5 실측으로 24명 중 팀당 5명이 1.

**아직 모르는 것: player-stat이 티오프 몇 분 전에 채워지는가.**
- 미래 경기(T-14시간, 2026-09-24 00:18 실측): player-stat = [] (빈 배열)
- 종료 경기: 24명 + startFlag 정상
- 그 사이 어느 시점에 채워지는지는 **한 번도 관측된 적이 없다.**

사용자는 "30분 전에 나온다"고 보고 있지만 이 코드베이스에서 검증된 바 없으므로, 추측으로
파이프라인을 짜지 않고 이 스크립트로 먼저 실측한다(--watch). 2026-09-24 프리시즌 10경기가
첫 관측 기회다.

사용법:
  python fetch_starting_lineups.py --gmkey S49G14N1         # 지금 한 번 조회
  python fetch_starting_lineups.py --today                  # 오늘 예정 경기 전부 한 번
  python fetch_starting_lineups.py --today --watch          # 채워질 때까지 주기 관측(기록 남김)

--watch는 raw/lineup_probe/<gmkey>.jsonl 에 매 폴링 결과를 append 한다. 나중에 "티오프
몇 분 전에 나왔나"를 이 로그로 확정할 수 있다.
"""
import argparse
import datetime
import json
import os
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import fetch_kbl_data as fkd  # noqa: E402

PROBE_DIR = os.path.join(BASE, "..", "raw", "lineup_probe")
KST = datetime.timezone(datetime.timedelta(hours=9))


def fetch_lineup(gmkey):
    """player-stat에서 선발/출전명단을 뽑는다.

    반환: {"available": bool, "starters": {tcode: [pcode]}, "dressed": {tcode: [pcode]},
           "n_rows": int}
    available=False면 아직 API가 명단을 안 주는 상태(빈 배열).
    """
    rows = fkd.fetch_endpoint(gmkey, "player-stat")
    out = {"available": False, "starters": {}, "dressed": {}, "n_rows": len(rows or [])}
    if not rows:
        return out
    for r in rows:
        p = r.get("player") or {}
        pcode, tcode = p.get("pcode"), p.get("tcode")
        if not pcode or not tcode:
            continue
        out["dressed"].setdefault(tcode, []).append(pcode)
        if r.get("startFlag") == 1:
            out["starters"].setdefault(tcode, []).append(pcode)
    # 양 팀 모두 선발 5명이 찍혔을 때만 "라인업 확정"으로 본다 - 경기 중엔 startFlag가
    # 그대로 남으므로 이 조건은 경기 시작 후에도 참이다(그때는 호출할 일이 없지만).
    out["available"] = (len(out["starters"]) == 2
                        and all(len(v) == 5 for v in out["starters"].values()))
    return out


def today_games():
    """오늘 예정(미종료) 경기. TRACKED_CATEGORIES 전체 - 프리시즌(OM)도 포함."""
    d = datetime.datetime.now(KST).strftime("%Y%m%d")
    games = fkd.fetch_game_list(d, d)
    return [g for g in games
            if g.get("isEnded") == 0 and g.get("seasonCategory") in fkd.TRACKED_CATEGORIES]


def tipoff_dt(g):
    """gameStart("1400") + gameDate("20260924") -> KST datetime. 없으면 None."""
    gs, gd = g.get("gameStart"), str(g.get("gameDate") or "")
    if not gs or len(gd) != 8:
        return None
    gs = str(gs).zfill(4)
    try:
        return datetime.datetime(int(gd[:4]), int(gd[4:6]), int(gd[6:]),
                                 int(gs[:2]), int(gs[2:]), tzinfo=KST)
    except ValueError:
        return None


def probe_once(g, write_log=False):
    gmkey = g["gmkey"]
    now = datetime.datetime.now(KST)
    tip = tipoff_dt(g)
    mins_to_tip = round((tip - now).total_seconds() / 60.0, 1) if tip else None
    try:
        res = fetch_lineup(gmkey)
        err = None
    except Exception as e:  # noqa: BLE001
        res, err = {"available": False, "starters": {}, "dressed": {}, "n_rows": 0}, str(e)
    rec = {"ts": now.isoformat(), "gmkey": gmkey, "minsToTip": mins_to_tip,
           "available": res["available"], "nRows": res["n_rows"],
           "starters": res["starters"], "error": err}
    if write_log:
        os.makedirs(PROBE_DIR, exist_ok=True)
        with open(os.path.join(PROBE_DIR, f"{gmkey}.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return rec, res


def describe(g, rec, res):
    tip = tipoff_dt(g)
    head = "%s %s vs %s  tip=%s" % (
        g["gmkey"], g.get("tnameH"), g.get("tnameA"),
        tip.strftime("%H:%M") if tip else "?")
    if rec["error"]:
        return head + "  ERROR " + rec["error"]
    # minsToTip은 "티오프까지 남은 분"이라 양수가 경기 전 - 표시는 관례대로 T-30분 꼴로 뒤집는다.
    when = ("T%+.0f분" % -rec["minsToTip"]) if rec["minsToTip"] is not None else "T?"
    if not rec["available"]:
        return "%s  [%s] 아직 없음 (player-stat %d행)" % (head, when, rec["nRows"])
    parts = []
    for tcode, pcodes in sorted(res["starters"].items()):
        parts.append("%s:%s" % (tcode, ",".join(pcodes)))
    return "%s  [%s] 선발확정 %s" % (head, when, " | ".join(parts))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gmkey", help="이 경기 하나만 조회")
    ap.add_argument("--today", action="store_true", help="오늘 예정 경기 전부")
    ap.add_argument("--watch", action="store_true",
                    help="전 경기 라인업이 나올 때까지 주기 폴링하며 raw/lineup_probe에 기록")
    ap.add_argument("--interval", type=int, default=300, help="--watch 폴링 간격(초, 기본 300)")
    ap.add_argument("--start-before", type=int, default=90,
                    help="--watch에서 티오프 몇 분 전부터 폴링할지(기본 90)")
    args = ap.parse_args()

    if args.gmkey:
        d = str(datetime.datetime.now(KST).strftime("%Y%m%d"))
        games = [g for g in fkd.fetch_game_list(d, d) if g["gmkey"] == args.gmkey]
        if not games:  # 오늘이 아닐 수도 있으니 최소 정보로 구성
            games = [{"gmkey": args.gmkey, "tnameH": "?", "tnameA": "?",
                      "gameStart": None, "gameDate": None}]
    elif args.today:
        games = today_games()
    else:
        ap.error("--gmkey 또는 --today 중 하나는 필요")

    if not games:
        print("대상 경기 없음.", flush=True)
        return

    if not args.watch:
        for g in games:
            rec, res = probe_once(g, write_log=False)
            print(describe(g, rec, res), flush=True)
        return

    print("watch 시작: %d경기, 간격 %d초, 티오프 %d분 전부터 (기록: raw/lineup_probe/)"
          % (len(games), args.interval, args.start_before), flush=True)
    done = set()
    while len(done) < len(games):
        now = datetime.datetime.now(KST)
        active = False
        for g in games:
            if g["gmkey"] in done:
                continue
            tip = tipoff_dt(g)
            if tip is not None:
                mins = (tip - now).total_seconds() / 60.0
                if mins > args.start_before:
                    active = True      # 아직 이른 경기가 남아 있음
                    continue
                if mins < -30:         # 티오프 30분 지나도 못 봤으면 포기
                    print("  %s: 티오프 +30분 경과 - 관측 종료" % g["gmkey"], flush=True)
                    done.add(g["gmkey"])
                    continue
            rec, res = probe_once(g, write_log=True)
            print("  " + describe(g, rec, res), flush=True)
            if rec["available"]:
                done.add(g["gmkey"])
            else:
                active = True
        if len(done) >= len(games):
            break
        if not active:
            print("폴링할 경기 없음 - 종료.", flush=True)
            break
        time.sleep(args.interval)
    print("watch 종료.", flush=True)


if __name__ == "__main__":
    main()
