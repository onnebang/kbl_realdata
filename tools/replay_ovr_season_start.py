"""시즌 초반 리플레이 검증 - 과거 시즌을 N경기까지만 잘라 build_courtside_ovr를 돌려, 진행 중 시즌 처리
(백분위 풀 격리 + live_cap 상한 점진 완화)가 의도대로 동작하는지 확인한다.

2026-10-06 개막 직후 전원 OVR 폭락 사고는 파이프라인이 "시즌 1~2경기" 상태로 한 번도 돌려진 적이 없어서
났다. 이 스크립트가 그 상태(와 라운드별 중간 상태, 시즌 종료 편입)를 과거 시즌 데이터로 재현한다. 원본
raw/kbl_realdata.db는 건드리지 않고(복사본을 자름), 결과 JSON도 임시 파일로 보낸다.

경기 수 N(리그 전체 정규시즌 경기, 10팀 기준 45경기 = 1라운드)별 검사:
  1) 확정 시즌(시즌 이전) 행이 N=0 결과와 완전히 같다 - 올 시즌 일부 경기가 과거 값을 오염시키지 않는다.
  2) 진행 중 시즌 행이 N=0 예상치에서 live_cap(진행률)+반올림 1 이내로만 움직인다.
  3) N이 커질수록 시즌 종료 후 일반 행 값(마지막 N)과의 차이가 줄어든다 - 편입 시 단차 확인용 지표(표로만 출력).
검사 1·2가 어긋나면 종료코드 1.

사용: python replay_ovr_season_start.py [--season 2025-2026] [N ...]    (N 기본: 0 7 45 90 135 180 225 270)
      마지막 N이 시즌 전체 경기 수 이상이면 "시즌 종료 후 일반 행" 기준값으로 쓴다.
"""
import argparse
import contextlib
import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_courtside_ovr as bco

REAL_DB = bco.DB_PATH
FIELDS = ['OVR', 'OFF', 'DEF', 'attributes', 'role', 'role2', 'badges', 'projected', 'team']


def truncate_db(dst, season, n):
    """season 정규시즌을 (날짜, gmkey)순 앞 n경기만 남기고, 그 이후 시즌/플레이오프는 전부 지운 복사본을 만든다."""
    shutil.copyfile(REAL_DB, dst)
    c = sqlite3.connect(dst)
    c.execute("DELETE FROM games WHERE season_name > ?", (season,))
    keep = [r[0] for r in c.execute(
        "SELECT gmkey FROM games WHERE season_name = ? AND season_category = '정규시즌' ORDER BY game_date, gmkey", (season,))][:n]
    c.execute("CREATE TEMP TABLE keep (gmkey TEXT)")
    c.executemany("INSERT INTO keep VALUES (?)", [(g,) for g in keep])
    c.execute("DELETE FROM games WHERE season_name = ? AND gmkey NOT IN (SELECT gmkey FROM keep)", (season,))
    c.commit()
    team_games = c.execute(
        "SELECT MAX(n) FROM (SELECT COUNT(*) n FROM (SELECT home_tcode t FROM games WHERE season_name = ? AND season_category = '정규시즌'"
        " UNION ALL SELECT away_tcode FROM games WHERE season_name = ? AND season_category = '정규시즌') GROUP BY t)",
        (season, season)).fetchone()[0] or 0
    c.close()
    return team_games


def season_roster(season):
    """리플레이용 가짜 로스터 - 그 시즌 정규시즌에 실제로 뛴 선수 전원(진짜 로스터는 시즌 전 시점 값이라 과거 시즌엔 없다)."""
    c = sqlite3.connect(REAL_DB)
    rows = c.execute(
        "SELECT DISTINCT gps.pcode, gps.pname FROM player_game_stats gps JOIN games g ON gps.gmkey = g.gmkey"
        " WHERE g.season_name = ? AND g.season_category = '정규시즌'", (season,)).fetchall()
    c.close()
    return {p: {"team": "replay", "name": n} for p, n in rows}


def run(season, n, roster, workdir):
    db = os.path.join(workdir, f"replay_{n}.db")
    team_games = truncate_db(db, season, n)
    bco.DB_PATH = db
    bco.HISTORY_OUT_PATH = os.path.join(workdir, f"replay_{n}.json")
    bco.PROJECTION_SEASON = season
    bco.load_next_season_roster = lambda s: dict(roster)
    bco.load_departed_projection_targets = lambda s: {}
    bco.OFF_ROSTER_ESTIMATE_TARGETS = {}
    with contextlib.redirect_stdout(io.StringIO()):
        bco.compute_ovr()
    with open(bco.HISTORY_OUT_PATH, encoding="utf-8") as f:
        rows = {(r["pcode"], r["season"]): r for r in json.load(f)}
    os.remove(db)
    return rows, team_games


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2025-2026")
    ap.add_argument("ns", nargs="*", type=int, default=[0, 7, 45, 90, 135, 180, 225, 270])
    args = ap.parse_args()
    season, ns = args.season, sorted(set(args.ns) | {0})
    roster = season_roster(season)

    results, progress = {}, {}
    with tempfile.TemporaryDirectory() as workdir:
        for n in ns:
            rows, tg = run(season, n, roster, workdir)
            results[n], progress[n] = rows, tg / bco.REGULAR_SEASON_GAMES
            print(f"N={n:>3} 완료 (팀당 최대 {tg}경기)", flush=True)

    ref = results[0]
    final = results[ns[-1]]
    settled_keys = [k for k in ref if k[1] < season]
    live_keys = [k for k in ref if k[1] == season]
    seasoned = {k[0] for k in settled_keys}  # 이전 시즌 기록이 있는 선수(없으면 신인/신규 - 예상치가 바닥값·스카우팅 값)
    print(f"\n{season} 리플레이 - 확정 시즌 행 {len(settled_keys)}개, 올 시즌 예상치 행 {len(live_keys)}개 "
          f"(경력자 {sum(1 for k in live_keys if k[0] in seasoned)}명, 기준: N=0)")
    print(f"{'N':>4} {'진행률':>6} {'상한':>5} {'확정행변경':>9} {'max|Δ예상|':>10} {'mean|Δ예상|':>11} {'상한초과':>8} "
          f"{'종료차(경력)':>11} {'종료차(신인)':>11} {'max종료차(경력)':>14}")
    ok = True
    for n in ns[1:]:
        cur, p = results[n], progress[n]
        settled_changed = sum(
            1 for k in settled_keys if k not in cur or any(cur[k].get(f) != ref[k].get(f) for f in FIELDS))
        live_now = p < 1.0 and n < ns[-1]
        cap = bco.live_cap(p) if live_now else float("inf")
        d = [abs(cur[k]["OVR"] - ref[k]["OVR"]) for k in live_keys if k in cur]
        over = sum(1 for x in d if x > cap + 1.0) if live_now else 0
        gv = [abs(cur[k]["OVR"] - final[k]["OVR"]) for k in live_keys if k in cur and k in final and k[0] in seasoned]
        gr = [abs(cur[k]["OVR"] - final[k]["OVR"]) for k in live_keys if k in cur and k in final and k[0] not in seasoned]
        print(f"{n:>4} {p:>6.1%} {cap if live_now else float('nan'):>5.2f} {settled_changed:>9} "
              f"{max(d, default=0):>10.1f} {sum(d) / max(1, len(d)):>11.2f} {over:>8} "
              f"{sum(gv) / max(1, len(gv)):>11.2f} {sum(gr) / max(1, len(gr)):>11.2f} {max(gv, default=0):>14.1f}")
        if live_now and (settled_changed or over):
            ok = False
    settle_shift = sorted(abs(results[ns[-1]][k]["OVR"] - ref[k]["OVR"]) for k in settled_keys if k in results[ns[-1]])
    if progress[ns[-1]] >= 1.0 and settle_shift:
        print(f"\n시즌 확정 편입 시(N={ns[-1]}) 과거 시즌 OVR 이동 - 평균 {sum(settle_shift) / len(settle_shift):.2f}, "
              f"95% {settle_shift[int(0.95 * len(settle_shift))]}, 최대 {settle_shift[-1]} "
              f"(0이 아닌 행 {sum(1 for x in settle_shift if x)}/{len(settle_shift)}) - 새 시즌이 백분위 풀에 들어와 생기는 정상 이동")
    last_live = max((n for n in ns if n and progress[n] < 1.0), default=None)
    if last_live:
        cur = results[last_live]
        worst = sorted((k for k in live_keys if k in cur and k in final and k[0] in seasoned),
                       key=lambda k: -abs(cur[k]["OVR"] - final[k]["OVR"]))[:8]
        print(f"\nN={last_live}에서 종료값과 가장 벌어진 경력자(예상치 -> 진행중 -> 종료):")
        for k in worst:
            print(f"  {cur[k]['name']}: {ref[k]['OVR']} -> {cur[k]['OVR']} -> {final[k]['OVR']}")
    print("\n결과:", "통과" if ok else "실패 - 확정행변경/상한초과가 0이어야 한다")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
