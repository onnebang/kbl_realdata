"""
득점 분포 탐색기(사용자 요청 - r/dataisbeautiful "NBA 득점 진화 애니메이션" 레퍼런스,
"감독별/선수별/팀별/시즌별 득점 분포 형태") 데이터 집계.

이번에 새로 확인한 사실: raw/games/*/meta.json의 teams.home/away.staffs.manager.name에
감독 이름이 이미 들어있음(어떤 스크립트도 지금까지 안 썼던 필드) - 여기서 처음 추출.
슛 좌표(x,y,성공여부)는 이미 15시즌 전체 match-chart.json에 있고, 좌표계는
build_xpts_shot_quality.py 등에서 검증된 것(HOOP_LEFT/RIGHT, SCALE_M_PER_UNIT)을 그대로 씀.

집계 방식: 코트를 15x15 그리드로 나눠서(반코트, HOOP_RIGHT 기준으로 원정 슛도 미러링 -
teamZoneStats()의 "x = d==='2' ? 750-x : x" 관례와 동일) 감독/선수/팀/리그전체 x 시즌별로
셀당 (시도, 성공) 누적. 표본이 적은 (엔티티,시즌) 조합은 노이즈 방지로 제외.
"""
import json
import os
from collections import defaultdict

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
OUT_PATH = os.path.join(BASE, "..", "raw", "analysis", "scoring_distribution.json")

HOOP_RIGHT = (681, 205)
COURT_X = (345, 720)  # 반코트(HOOP_RIGHT 쪽)만 사용
COURT_Y = (27, 384)
GRID_COLS, GRID_ROWS = 15, 15
CELL_W = (COURT_X[1] - COURT_X[0]) / GRID_COLS
CELL_H = (COURT_Y[1] - COURT_Y[0]) / GRID_ROWS
MIN_ATTEMPTS = 30  # 이보다 적은 (엔티티,시즌) 조합은 노이즈라 제외

# build_live_replay_demo.py의 TEAM_META와 동일(2026-08-25 재확인된 실제 구단컬러) - 이 스크립트도
# 독립적으로 표시용 이름/컬러가 필요해서 같은 값을 복사(build_wpa_leaderboard_page.py와 같은 패턴).
TEAM_META = {
    "06": {"abbr": "KT", "color": "#1A1A1A", "name": "수원 KT"},
    "10": {"abbr": "MOB", "color": "#A6192E", "name": "울산 현대모비스"},
    "16": {"abbr": "DB", "color": "#1C8A43", "name": "원주 DB"},
    "30": {"abbr": "GOY", "color": "#1E2749", "name": "고양 오리온스"},
    "35": {"abbr": "SAM", "color": "#1428A0", "name": "서울 삼성"},
    "55": {"abbr": "SK", "color": "#E4002B", "name": "서울 SK"},
    "60": {"abbr": "KCC", "color": "#0C2340", "name": "전주 KCC"},
    "64": {"abbr": "GAS", "color": "#0072CE", "name": "대구 한국가스공사"},
    "65": {"abbr": "EL", "color": "#0060AF", "name": "인천 전자랜드"},
    "66": {"abbr": "SONO", "color": "#3FA9F5", "name": "고양 소노"},
    "70": {"abbr": "KGC", "color": "#C8102E", "name": "안양 정관장"},
    "50": {"abbr": "LG", "color": "#8E1B3D", "name": "창원 LG"},
    "73": {"abbr": "CRT", "color": "#FF6B00", "name": "고양 캐롯"},
}


def normalize_x(x, d):
    # teamZoneStats()와 동일 관례: d=='1'이면 이미 오른쪽 골대 근처 좌표, d=='2'면 왼쪽 골대
    # 근처 좌표라 750에서 빼서 오른쪽 기준으로 뒤집음.
    return x if d == "1" else 750 - x


class Agg:
    def __init__(self):
        # entity_key -> season -> cell_key -> [att, made]
        self.data = defaultdict(lambda: defaultdict(lambda: defaultdict(lambda: [0, 0])))
        self.meta = {}  # entity_key -> {name, tcode(선택)}

    def add(self, entity_key, season, x, y, d, made, display_name, tcode=None):
        nx = normalize_x(x, d)
        col = max(0, min(GRID_COLS - 1, int((nx - COURT_X[0]) / CELL_W)))
        row = max(0, min(GRID_ROWS - 1, int((y - COURT_Y[0]) / CELL_H)))
        cell = self.data[entity_key][season][f"{row}_{col}"]
        cell[0] += 1
        if made:
            cell[1] += 1
        if entity_key not in self.meta:
            self.meta[entity_key] = {"name": display_name, "tcode": tcode}

    def to_json(self):
        out = {}
        for ekey, seasons in self.data.items():
            season_out = {}
            for season, cells in seasons.items():
                total_att = sum(v[0] for v in cells.values())
                if total_att < MIN_ATTEMPTS:
                    continue
                total_made = sum(v[1] for v in cells.values())
                season_out[season] = {
                    "cells": {k: v for k, v in cells.items()},
                    "totalAtt": total_att, "totalMade": total_made,
                }
            if season_out:
                out[ekey] = {**self.meta[ekey], "seasons": season_out}
        return out


def main():
    coach_agg, player_agg, team_agg, league_agg = Agg(), Agg(), Agg(), Agg()

    gmkeys = sorted(os.listdir(GAMES_DIR))
    print(f"{len(gmkeys)}경기 처리 시작...", flush=True)
    processed = 0
    for i, gk in enumerate(gmkeys, 1):
        meta_path = os.path.join(GAMES_DIR, gk, "meta.json")
        chart_path = os.path.join(GAMES_DIR, gk, "match-chart.json")
        if not (os.path.exists(meta_path) and os.path.exists(chart_path)):
            continue
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        with open(chart_path, encoding="utf-8") as f:
            chart = json.load(f)

        g = meta["game"]
        season = g.get("seasonName")
        tcode_h, tcode_a = g.get("tcodeH"), g.get("tcodeA")
        teams = meta.get("teams", {})
        coach_h = teams.get("home", {}).get("staffs", {}).get("manager", {}).get("name")
        coach_a = teams.get("away", {}).get("staffs", {}).get("manager", {}).get("name")
        if not season or not tcode_h or not tcode_a:
            continue

        for player in chart.get("shootLog", []):
            pcode, pname, tcode = player.get("pcode"), player.get("pname"), player.get("tcode")
            if not pcode or not tcode:
                continue
            coach = coach_h if tcode == tcode_h else coach_a
            tmeta = TEAM_META.get(tcode, {"name": tcode})
            for log in player.get("logs", []):
                x, y, d, made = log["x"], log["y"], log["d"], log["o"] == "O"
                league_agg.add("league", season, x, y, d, made, "리그 전체")
                team_agg.add(tcode, season, x, y, d, made, tmeta["name"], tcode)
                player_agg.add(pcode, season, x, y, d, made, pname, tcode)
                if coach:
                    coach_agg.add(coach, season, x, y, d, made, coach)
        processed += 1
        if i % 500 == 0:
            print(f"  {i}/{len(gmkeys)}...", flush=True)

    out = {
        "grid": {"cols": GRID_COLS, "rows": GRID_ROWS,
                 "xMin": COURT_X[0], "xMax": COURT_X[1], "yMin": COURT_Y[0], "yMax": COURT_Y[1],
                 "hoopX": HOOP_RIGHT[0], "hoopY": HOOP_RIGHT[1]},
        "minAttempts": MIN_ATTEMPTS,
        "coach": coach_agg.to_json(),
        "player": player_agg.to_json(),
        "team": team_agg.to_json(),
        "league": league_agg.to_json(),
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"완료 - {processed}경기 처리, 감독 {len(out['coach'])}명, 선수 {len(out['player'])}명, "
          f"팀 {len(out['team'])}개 -> {OUT_PATH} ({size_kb:.0f}KB)", flush=True)


if __name__ == "__main__":
    main()
