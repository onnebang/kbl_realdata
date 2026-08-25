"""
가벼운 시즌 브라우저 데이터 (2026-08-25, 사용자 요청 - "작년시즌 전체 데이터를 볼 수 있게").

코트사이드(10경기)처럼 문자중계 재생+승률그래프+슛차트+선수사진을 전부 담으면 경기당 약
600KB, 283경기(2025-2026 정규시즌 270 + 플레이오프 13) 전부면 ~170MB - 아티팩트 한도(16MB)를
훨씬 넘고, 파일을 따로 불러오는 asset 기능도 이 계정엔 없음(확인 완료). 사용자가 직접
"가벼운 시즌 브라우저 + 박스스코어"를 선택 - ML 모델(승률 추론) 없이 이미 있는 원본 박스
스코어만 읽어서 훨씬 가볍게: 경기 목록(283개) + 클릭시 박스스코어(팀스탯+선수별 스탯).
"""
import json
import os

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
OUT_PATH = os.path.join(ANALYSIS_DIR, "season_browser_2025-2026.json")

TARGET_SEASON = "2025-2026"

PLAYER_FIELDS = ["score", "rb", "offr", "defr", "ast", "stl", "bs", "to", "foul",
                  "fg", "fgA", "threep", "threepA", "ft", "ftA", "playMin", "playSec", "per"]
TEAM_FIELDS = ["score", "fg", "fgA", "threep", "threepA", "ft", "ftA", "rb", "offr", "defr",
               "ast", "stl", "bs", "to", "foul", "offrtg", "defrtg", "netrtg"]


def build_one_game(gmkey):
    meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
    tr_path = os.path.join(GAMES_DIR, gmkey, "team-record.json")
    ps_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
    if not (os.path.exists(meta_path) and os.path.exists(tr_path) and os.path.exists(ps_path)):
        return None
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    with open(tr_path, encoding="utf-8") as f:
        tr = json.load(f)
    with open(ps_path, encoding="utf-8") as f:
        ps = json.load(f)

    g = meta["game"]
    home_tcode, away_tcode = g.get("tcodeH"), g.get("tcodeA")
    tr_by_tcode = {r["tcode"]: r["records"] for r in tr}
    if home_tcode not in tr_by_tcode or away_tcode not in tr_by_tcode:
        return None

    quarters = {}
    for side, tcode in (("home", home_tcode), ("away", away_tcode)):
        rec = meta.get("teamrecords", {}).get(side, {})
        quarters[tcode] = {
            "q": [rec.get(f"scoreq{i}") for i in range(1, 5)],
            "ot": rec.get("scoreeq") or [],
        }

    team_stats = {tcode: {k: tr_by_tcode[tcode].get(k) for k in TEAM_FIELDS} for tcode in (home_tcode, away_tcode)}

    players = {"home": [], "away": []}
    for row in ps:
        p = row["player"]
        side = "home" if p["tcode"] == home_tcode else "away" if p["tcode"] == away_tcode else None
        if side is None:
            continue
        rec = row["records"]
        entry = {"pcode": p["pcode"], "name": p["pname"], "pos": p.get("pos"), "backNum": p.get("backNum"),
                  "starter": row.get("startFlag") == 1}
        entry.update({k: rec.get(k) for k in PLAYER_FIELDS})
        players[side].append(entry)
    for side in players:
        players[side].sort(key=lambda r: (-int(r["starter"]), -(r["score"] or 0)))

    return {
        "gmkey": gmkey, "gameDate": g.get("gameDate"), "seasonCategoryName": g.get("seasonCategoryName"),
        "homeTcode": home_tcode, "awayTcode": away_tcode,
        "finalHome": tr_by_tcode[home_tcode].get("score"), "finalAway": tr_by_tcode[away_tcode].get("score"),
        "quarters": quarters, "teamStats": team_stats, "players": players,
    }


def main():
    print(f"{TARGET_SEASON} 시즌 게임 목록 스캔 중...", flush=True)
    gmkeys = []
    for gk in sorted(os.listdir(GAMES_DIR)):
        meta_path = os.path.join(GAMES_DIR, gk, "meta.json")
        if not os.path.exists(meta_path):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        if meta["game"].get("seasonName") == TARGET_SEASON:
            gmkeys.append((meta["game"].get("gameDate"), gk))
    gmkeys.sort()
    print(f"  {len(gmkeys)}경기 발견", flush=True)

    games = {}
    game_list = []
    fail = []
    for i, (gameDate, gk) in enumerate(gmkeys, 1):
        result = build_one_game(gk)
        if result is None:
            fail.append(gk)
            continue
        games[gk] = result
        game_list.append({
            "gmkey": gk, "gameDate": result["gameDate"], "seasonCategoryName": result["seasonCategoryName"],
            "homeTcode": result["homeTcode"], "awayTcode": result["awayTcode"],
            "finalHome": result["finalHome"], "finalAway": result["finalAway"],
        })
        if i % 50 == 0:
            print(f"  {i}/{len(gmkeys)}...", flush=True)

    out = {"season": TARGET_SEASON, "gameList": game_list, "games": games}
    os.makedirs(ANALYSIS_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    size_mb = os.path.getsize(OUT_PATH) / 1024 / 1024
    print(f"완료 - {len(game_list)}경기 (실패 {len(fail)}) -> {OUT_PATH} ({size_mb:.1f}MB)", flush=True)
    if fail:
        print("실패 목록:", fail[:20], flush=True)


if __name__ == "__main__":
    main()
