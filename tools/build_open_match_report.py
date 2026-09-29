"""프리시즌(오픈매치/컵대회) 외국선수·아시아쿼터 활약상 리포트.

    python build_open_match_report.py                         # 기본: 최신 시즌 OPEN MATCH DAY
    python build_open_match_report.py --category 컵대회       # 다른 분류
    python build_open_match_report.py --season 2026-2027

## 왜 스크립트로 만드나

이 리포트의 예전 버전(om_stats_report.md, 2026-09-29)은 **정규시즌 숫자를 프리시즌 활약상으로
적어둔 상태**였다 - 옆에 있던 생성 스크립트가 `season_category = 'OM'`으로 조회했는데 실제
저장값은 'OPEN MATCH DAY'라 항상 0건을 돌려줬고(그래서 커밋에서 빠졌다), 남은 표에는 선수당
27~39경기 같은 숫자가 적혀 있었다(오픈매치는 전체 10경기, 선수당 최대 2경기). 재현 가능한
생성 경로가 없는 리포트는 다음 사람이 검증할 수 없으므로 스크립트로 고정한다.

## 원천과 정의

- 경기/스탯: raw/games/<gmkey>/{meta,player-stat}.json (공식 API 캐시). DB를 안 쓴다 -
  로컬 SQLite엔 프리시즌이 적재되지 않고(정규/PO/챔프만), Supabase는 크리덴셜이 필요하다.
- 외국선수 판정: player.playerFlag (0=국내/1=외국/2=아시아쿼터). 공식 값이라 신규 영입도
  자동 포함된다 - export_training_table.FOREIGN_FLAGS 참고.
- 야투 필드 의미(실측 240/240 확인): fg/fgA = **2점**, threep/threepA = 3점,
  fgt/fgtA = 전체 야투. score == 2*fg + 3*threep + ft.
- 동시 출전 표본: raw/stints/<gmkey>.json(build_lineup_stints.py 산출)에서 한 팀 라인업에
  외국/아쿼가 몇 명 있었는지로 구간을 나눠 시간·득실을 잰다.

## 읽는 사람이 오해하면 안 되는 것

프리시즌은 표본이 작고(팀당 2경기) **정규시즌 외국인 동시출전 규정을 따르지 않는다** -
아래 표에 3명 동시 출전 구간이 실제로 잡힌다. 그래서 이 숫자는 "정규시즌 2인 출전 시너지"의
대리지표로 쓸 수 없다. 리포트 머리에 표본 크기를 항상 같이 찍는다.
"""
import argparse
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from export_training_table import FOREIGN_FLAGS

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
STINTS_DIR = os.path.join(BASE, "..", "raw", "stints")
OUT_MD = os.path.join(BASE, "..", "om_stats_report.md")
OUT_CSV = os.path.join(BASE, "..", "om_stats_formatted.csv")

# 한 팀 라인업 5명 중 외국/아쿼가 이만큼 있으면 "동시 출전" 구간으로 센다.
DUO = 2
# 100포제션 환산용 - KBL 한 경기 팀 포제션은 대략 분당 2.0(analyze_avg_possession_length.py
# 계열 실측 범위). 스틴트엔 포제션 수가 없어 분으로만 환산하므로 어림값임을 표에 밝힌다.
POSS_PER_MIN = 2.0


def load_games(season, category):
    """(gmkey -> meta['game']) - 분류/시즌이 맞고 종료된 경기만."""
    out = {}
    for gmkey in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            g = json.load(f)["game"]
        if g.get("seasonCategoryName") != category or not g.get("isEnded"):
            continue
        if season and g.get("seasonName") != season:
            continue
        out[gmkey] = g
    return out


def latest_season(category):
    seasons = {g.get("seasonName") for g in load_games(None, category).values()}
    return max(seasons) if seasons else None


def collect_players(games):
    """(tcode, pcode) -> 누적 스탯. 외국/아시아쿼터만."""
    agg = defaultdict(lambda: defaultdict(float))
    for gmkey in games:
        path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            rows = json.load(f)
        for row in rows:
            p, r = row["player"], row["records"]
            if p.get("playerFlag") not in FOREIGN_FLAGS:
                continue
            a = agg[(p["tcode"], p["pcode"])]
            a["_name"] = p["pname"]
            a["_team"] = p["tname"]
            a["_asia"] = 1.0 if p.get("playerFlag") == "2" else 0.0
            a["g"] += 1
            a["min"] += (r.get("playMin") or 0) + (r.get("playSec") or 0) / 60
            for k, src in (("pts", "score"), ("reb", "rb"), ("ast", "ast"), ("stl", "stl"),
                           ("blk", "bs"), ("to", "to"), ("fg", "fg"), ("fga", "fgA"),
                           ("tp", "threep"), ("tpa", "threepA"), ("ft", "ft"), ("fta", "ftA")):
                a[k] += r.get(src) or 0
            # netrtg는 경기당 값이라 출전분 가중평균이 맞다(단순평균은 3분 뛴 경기를 35분 경기와 같게 본다)
            mins = (r.get("playMin") or 0) + (r.get("playSec") or 0) / 60
            if r.get("netrtg") is not None and mins > 0:
                a["_net_w"] += r["netrtg"] * mins
                a["_net_m"] += mins
    return agg


def collect_duo_stints(games):
    """tcode -> {n외국인: [분, 득점, 실점]}. 스틴트 파일이 없는 경기는 건너뛴다."""
    flags = {}
    for gmkey in games:
        path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for row in json.load(f):
                flags[row["player"]["pcode"]] = row["player"].get("playerFlag")

    def qsec(clock):
        q, m, s = clock
        qi = int(q[1]) if q.startswith("Q") else 4 + int(q[1])
        return qi, m * 60 + s

    agg = defaultdict(lambda: defaultdict(lambda: [0.0, 0, 0]))
    missing = 0
    for gmkey in games:
        path = os.path.join(STINTS_DIR, f"{gmkey}.json")
        if not os.path.exists(path):
            missing += 1
            continue
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        for st in d["stints"]:
            q0, s0 = qsec(st["startClock"])
            q1, s1 = qsec(st["endClock"])
            # 쿼터를 넘는 스틴트는 시작 쿼터의 잔여분만 센다(보수적 - 넘어간 쪽을 두 번 세지 않는다)
            dur = (s0 - s1) if q0 == q1 else s0
            if dur <= 0:
                continue
            for tcode, own, opp, key in ((d["homeCode"], st["homePts"], st["awayPts"], "homeLineup"),
                                         (d["awayCode"], st["awayPts"], st["homePts"], "awayLineup")):
                nf = sum(1 for pc in st[key] if flags.get(pc) in FOREIGN_FLAGS)
                r = agg[tcode][nf]
                r[0] += dur / 60
                r[1] += own
                r[2] += opp
    return agg, missing


def fmt(v, nd=1):
    return f"{v:.{nd}f}"


PLAYER_COLS = ["선수", "구분", "경기", "출전(분)", "득점", "리바", "어시", "스틸", "블록",
               "턴오버", "2점(성공/시도)", "3점(성공/시도)", "자유투(성공/시도)", "NetRtg"]


def md_row(cells, ncol):
    """셀 개수를 헤더와 맞춰서만 한 줄을 만든다. 예전엔 format 문자열에 플레이스홀더를 하나
    빼먹었는데 str.format이 남는 인자를 조용히 버려서 턴오버 열이 사라진 채 나머지 열이 한 칸씩
    밀린 표가 나왔다(값은 그럴싸해서 눈으로는 안 잡힌다)."""
    assert len(cells) == ncol, f"열 {ncol}개인데 셀 {len(cells)}개: {cells}"
    return "| " + " | ".join(str(c) for c in cells) + " |"


def render(season, category, games, players, duo, missing_stints):
    dates = sorted(g.get("gameDate") for g in games.values())
    per_player_max = max((int(a["g"]) for a in players.values()), default=0)
    L = []
    L.append(f"# KBL {season} {category} 외국선수·아시아쿼터 활약상")
    L.append("")
    L.append(f"`tools/build_open_match_report.py` 생성. 원천: `raw/games/` 공식 API 캐시.")
    L.append("")
    L.append(f"- 경기 수: **{len(games)}경기** ({dates[0]} ~ {dates[-1]})" if dates else "- 경기 없음")
    L.append(f"- 집계 대상: 외국선수·아시아쿼터 **{len(players)}명**, 선수당 최대 **{per_player_max}경기**")
    L.append("- 모든 값은 **경기당 평균**(야투는 합계 기준 성공률). `fg`=2점, `3P`=3점 — "
             "공식 필드 의미를 실측 확인한 값이다.")
    L.append("")
    L.append("> **표본 경고**: 선수당 최대 "
             f"{per_player_max}경기다. 정규시즌 스탯과 비교하거나 이 숫자로 예측 피처를 만들면 "
             "노이즈를 신호로 오인한다. 프리시즌은 정규시즌 외국인 동시출전 규정도 따르지 않는다"
             "(아래 동시출전 표에 3명 구간이 실제로 잡힌다).")
    L.append("")

    by_team = defaultdict(list)
    for (tcode, pcode), a in players.items():
        by_team[(tcode, a["_team"])].append((pcode, a))
    for (tcode, tname), rows in sorted(by_team.items(), key=lambda x: x[0][1]):
        L.append(f"## {tname}")
        L.append("")
        ncol = len(PLAYER_COLS)
        L.append(md_row(PLAYER_COLS, ncol))
        L.append("|" + "---|" * ncol)
        for _, a in sorted(rows, key=lambda x: -x[1]["pts"] / max(x[1]["g"], 1)):
            g = a["g"]
            net = a["_net_w"] / a["_net_m"] if a["_net_m"] else None
            L.append(md_row([
                a["_name"], "아시아쿼터" if a["_asia"] else "외국", f"{g:.0f}",
                fmt(a["min"] / g), fmt(a["pts"] / g), fmt(a["reb"] / g), fmt(a["ast"] / g),
                fmt(a["stl"] / g), fmt(a["blk"] / g), fmt(a["to"] / g),
                f"{fmt(a['fg'] / g)}/{fmt(a['fga'] / g)}",
                f"{fmt(a['tp'] / g)}/{fmt(a['tpa'] / g)}",
                f"{fmt(a['ft'] / g)}/{fmt(a['fta'] / g)}",
                fmt(net) if net is not None else "-",
            ], ncol))
        L.append("")

    L.append(f"## 외국선수 동시 출전 구간 (라인업 스틴트 기준)")
    L.append("")
    if missing_stints:
        L.append(f"> 스틴트 파일이 없는 경기 {missing_stints}건은 제외됨 "
                 "(`build_lineup_stints.py` 먼저 실행).")
        L.append("")
    league = defaultdict(lambda: [0.0, 0, 0])
    for tcode, buckets in duo.items():
        for nf, (mn, pf, pa) in buckets.items():
            t = league[nf]
            t[0] += mn
            t[1] += pf
            t[2] += pa
    L.append("| 동시 출전 외국선수 | 총 시간(분) | 득점 | 실점 | 분당 마진 |")
    L.append("|---|---|---|---|---|")
    for nf in sorted(league):
        mn, pf, pa = league[nf]
        L.append(f"| {nf}명 | {fmt(mn)} | {pf} | {pa} | {(pf - pa) / mn:+.2f} |" if mn else
                 f"| {nf}명 | 0 | - | - | - |")
    L.append("")
    L.append(f"### 팀별 {DUO}명 이상 동시 출전")
    L.append("")
    L.append(f"| 팀 | 시간(분) | 마진 | 100포제션당(어림) |")
    L.append("|---|---|---|---|")
    team_names = {}
    for (tcode, tname) in by_team:
        team_names[tcode] = tname
    rows = []
    for tcode, buckets in duo.items():
        mn = sum(v[0] for nf, v in buckets.items() if nf >= DUO)
        marg = sum(v[1] - v[2] for nf, v in buckets.items() if nf >= DUO)
        if mn > 0:
            rows.append((team_names.get(tcode, tcode), mn, marg))
    for tname, mn, marg in sorted(rows, key=lambda x: -x[1]):
        poss = mn * POSS_PER_MIN
        L.append(f"| {tname} | {fmt(mn)} | {marg:+d} | {marg / poss * 100:+.1f} |")
    L.append("")
    L.append(f"포제션은 분당 {POSS_PER_MIN} 어림값 환산이다(스틴트에 포제션 수가 없음). "
             "표본이 팀당 100포제션 안팎이라 100포제션당 값의 표준오차는 ±20 이상 — "
             "**순위로 읽지 말 것.**")
    L.append("")
    return "\n".join(L)


def render_csv(players):
    head = ("team,player,type,games,min,pts,reb,ast,stl,blk,to,"
            "fg2m,fg2a,fg3m,fg3a,ftm,fta,netrtg")
    lines = [head]
    for (tcode, pcode), a in sorted(players.items(), key=lambda x: (x[1]["_team"], -x[1]["pts"])):
        g = a["g"]
        net = a["_net_w"] / a["_net_m"] if a["_net_m"] else ""
        lines.append(",".join(str(x) for x in [
            a["_team"], a["_name"], "asia" if a["_asia"] else "import", int(g),
            round(a["min"] / g, 1), round(a["pts"] / g, 1), round(a["reb"] / g, 1),
            round(a["ast"] / g, 1), round(a["stl"] / g, 1), round(a["blk"] / g, 1),
            round(a["to"] / g, 1), round(a["fg"] / g, 1), round(a["fga"] / g, 1),
            round(a["tp"] / g, 1), round(a["tpa"] / g, 1), round(a["ft"] / g, 1),
            round(a["fta"] / g, 1), round(net, 1) if net != "" else ""]))
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--category", default="OPEN MATCH DAY",
                    help="games.seasonCategoryName 값 (기본 'OPEN MATCH DAY')")
    ap.add_argument("--season", default=None, help="예: 2026-2027 (생략 시 해당 분류의 최신 시즌)")
    args = ap.parse_args()

    season = args.season or latest_season(args.category)
    if not season:
        print(f"'{args.category}' 분류의 종료된 경기가 raw/games에 없다.")
        return 1
    games = load_games(season, args.category)
    if not games:
        print(f"{season} '{args.category}' 경기 없음.")
        return 1
    players = collect_players(games)
    duo, missing = collect_duo_stints(games)

    md = render(season, args.category, games, players, duo, missing)
    with open(OUT_MD, "w", encoding="utf-8") as f:
        f.write(md)
    with open(OUT_CSV, "w", encoding="utf-8") as f:
        f.write(render_csv(players))
    print(f"{season} {args.category} {len(games)}경기 / 외국·아쿼 {len(players)}명")
    print(f"-> {os.path.normpath(OUT_MD)}")
    print(f"-> {os.path.normpath(OUT_CSV)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
