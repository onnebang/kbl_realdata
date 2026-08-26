"""
선수 프로필/기록 사이트 데이터 집계(2026-08-27, 사용자 요청 "선수 프로필, 선수별로 활약을
저장할 수 있는 사이트" - Showstone류 참고 요청 중 세 번째 항목).

전체 4207경기의 player-stat.json을 선수별로 모아서:
- seasons: 시즌별 평균(전체 커리어, 가벼움 - 시즌 하나당 한 행)
- recentGames: 최근 30경기 게임로그(전체 커리어를 다 담으면 페이지 용량이 너무 커짐 -
  참고한 대시보드도 L5/L10/L15/L30 식으로 "최근 N경기" 창을 쓰지 전체 커리어를 한 번에
  안 보여줌. 30경기면 그 필터들을 전부 커버하면서 용량은 선수당 상수로 고정됨).

표본 필터: 커리어 전체 10경기 미만인 선수는 제외(콜업 1~2경기짜리 노이즈 - 이 프로젝트의
기존 관례인 MIN_ATTEMPTS/ROLLING_WINDOW 표본 필터와 같은 이유).

선수 사진: player-stat.json에 실제 kbl.or.kr 사진 URL(`player.img`)이 있지만, 이 페이지는
587명 전원을 한 정적 파일에 담아야 해서(득점 분포 탐색기처럼 "선택 시 서버에서 더 받아오기"가
안 되는 순수 정적 페이지) 전부 base64로 심으면 용량이 감당 안 됨(embed_team_logos.py는 팀
13개라 가능했던 방식) - 그래서 팀 배지(이미 embed_team_logos.py가 심어둔 로고 재사용)와
등번호로 대체.
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "player_profiles.json")

MIN_CAREER_GAMES = 10
RECENT_GAMES_CAP = 30


def pct(made, att):
    return round(made / att * 100, 1) if att else None


def main():
    # career[pcode] -> {"name","ename","backNum","pos","tcode"(최신), "games": [행,...] 날짜순}
    career = defaultdict(lambda: {"name": None, "ename": None, "backNum": None, "pos": None,
                                    "tcode": None, "games": []})

    gmkeys = sorted(os.listdir(GAMES_DIR))
    print(f"{len(gmkeys)}경기 처리 시작...", flush=True)
    processed = 0
    for i, gk in enumerate(gmkeys, 1):
        meta_path = os.path.join(GAMES_DIR, gk, "meta.json")
        pstat_path = os.path.join(GAMES_DIR, gk, "player-stat.json")
        if not (os.path.exists(meta_path) and os.path.exists(pstat_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        with open(pstat_path, encoding="utf-8") as f:
            pstat = json.load(f)

        g = meta["game"]
        gameDate, season = g.get("gameDate"), g.get("seasonName")
        tcode_h, tcode_a = g.get("tcodeH"), g.get("tcodeA")
        if not gameDate or not season:
            continue

        for row in pstat:
            p, rec = row["player"], row["records"]
            pcode = p.get("pcode")
            if not pcode or rec.get("playMin", 0) == 0 and rec.get("playSec", 0) == 0:
                continue  # 출전 안 한(DNP) 로스터 등록분은 게임로그에서 제외
            tcode = p.get("tcode")
            opp_tcode = tcode_a if tcode == tcode_h else tcode_h
            is_home = tcode == tcode_h
            c = career[pcode]
            c["name"], c["ename"], c["backNum"], c["pos"], c["tcode"] = \
                p.get("pname"), p.get("ename"), p.get("backNum"), p.get("pos"), tcode
            c["games"].append({
                "gmkey": gk, "gameDate": gameDate, "season": season, "opponentTcode": opp_tcode,
                "isHome": is_home, "tcode": tcode, "win": None,  # 아래서 team-record 조인 후 채움
                "min": round(rec.get("playMin", 0) + rec.get("playSec", 0) / 60, 1),
                "pts": rec.get("score", 0), "reb": rec.get("rb", 0), "ast": rec.get("ast", 0),
                "stl": rec.get("stl", 0), "blk": rec.get("bs", 0), "tov": rec.get("to", 0),
                "fgm": rec.get("fg", 0), "fga": rec.get("fgA", 0),
                "tpm": rec.get("threep", 0), "tpa": rec.get("threepA", 0),
                "ftm": rec.get("ft", 0), "fta": rec.get("ftA", 0),
                "netrtg": rec.get("netrtg"), "pie": rec.get("pie"),
            })
        processed += 1
        if i % 700 == 0:
            print(f"  {i}/{len(gmkeys)}...", flush=True)

    # 승/패는 team-record.json(두 팀 스코어)에서 다시 계산 - player-stat.json엔 팀 승패가
    # 직접 없어서, 같은 경기의 team-record를 한 번 더 읽어야 함(경기당 1회, 이미 위 루프에서
    # 이 경기를 처리한 게 확인된 경우만).
    print("승/패 계산 중(팀 스코어 조인)...", flush=True)
    game_result = {}  # gmkey -> {tcode: won(bool)}
    for gk in gmkeys:
        tr_path = os.path.join(GAMES_DIR, gk, "team-record.json")
        if not os.path.exists(tr_path):
            continue
        with open(tr_path, encoding="utf-8") as f:
            tr = json.load(f)
        if len(tr) != 2:
            continue
        s0, s1 = tr[0]["records"].get("score"), tr[1]["records"].get("score")
        if s0 is None or s1 is None or s0 == s1:
            continue
        t0, t1 = tr[0]["tcode"], tr[1]["tcode"]
        game_result[gk] = {t0: s0 > s1, t1: s1 > s0}

    out_players = {}
    for pcode, c in career.items():
        games = sorted(c["games"], key=lambda x: x["gameDate"])
        if len(games) < MIN_CAREER_GAMES:
            continue
        for gm in games:
            res = game_result.get(gm["gmkey"])
            gm["win"] = res.get(gm["tcode"]) if res else None
        # season 요약(전체 커리어, 시즌당 1행 - 가벼움)
        by_season = defaultdict(list)
        for gm in games:
            by_season[gm["season"]].append(gm)
        seasons = []
        for season, sg in sorted(by_season.items()):
            gp = len(sg)
            seasons.append({
                "season": season, "tcode": sg[-1]["tcode"], "gp": gp,
                "minPg": round(sum(g["min"] for g in sg) / gp, 1),
                "ptsPg": round(sum(g["pts"] for g in sg) / gp, 1),
                "rebPg": round(sum(g["reb"] for g in sg) / gp, 1),
                "astPg": round(sum(g["ast"] for g in sg) / gp, 1),
                "stlPg": round(sum(g["stl"] for g in sg) / gp, 1),
                "blkPg": round(sum(g["blk"] for g in sg) / gp, 1),
                "tovPg": round(sum(g["tov"] for g in sg) / gp, 1),
                "fgPct": pct(sum(g["fgm"] for g in sg), sum(g["fga"] for g in sg)),
                "tpPct": pct(sum(g["tpm"] for g in sg), sum(g["tpa"] for g in sg)),
                "ftPct": pct(sum(g["ftm"] for g in sg), sum(g["fta"] for g in sg)),
            })
        recent = games[-RECENT_GAMES_CAP:]
        out_players[pcode] = {
            # tcode는 "gmkeys 스캔 순서상 마지막"이 아니라 실제 날짜순 최신 경기 기준(트레이드된
            # 선수의 현재 소속팀이 안 틀리게) - games는 위에서 이미 gameDate로 정렬됨.
            "name": c["name"], "ename": c["ename"], "backNum": c["backNum"], "pos": c["pos"],
            "tcode": games[-1]["tcode"], "careerGp": len(games), "seasons": seasons, "recentGames": recent,
        }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out_players, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"완료 - {processed}경기 처리, 선수 {len(out_players)}명(10경기 미만 제외) -> "
          f"{OUT_PATH} ({size_kb:.0f}KB)", flush=True)


if __name__ == "__main__":
    main()
