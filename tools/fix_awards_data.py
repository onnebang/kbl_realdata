import json
import os
import re

# Table from user prompt
markdown_table = """
| **2025-26** | 서울 SK 나이츠 | 창원 LG 세이커스 | 부산 KCC 이지스 | 창원 LG 세이커스 |
| **2024-25** | 서울 SK 나이츠 | 창원 LG 세이커스 | 창원 LG 세이커스 | 서울 SK 나이츠 |
| **2023-24** | 원주 DB 프로미 | 창원 LG 세이커스 | 부산 KCC 이지스 | 수원 KT 소닉붐 |
| **2022-23** | 안양 KGC인삼공사 | 창원 LG 세이커스 | 안양 KGC인삼공사 | 서울 SK 나이츠 |
| **2021-22** | 서울 SK 나이츠 | 수원 KT 소닉붐 | 서울 SK 나이츠 | 안양 KGC인삼공사 |
| **2020-21** | 전주 KCC 이지스 | 울산 현대모비스 피버스 | 안양 KGC인삼공사 | 전주 KCC 이지스 |
| **2019-20** | 서울 SK / 원주 DB (공동) | *코로나19로 조기 종료 (플레이오프 미개최)* |
| **2018-19** | 울산 현대모비스 피버스 | 인천 전자랜드 엘리펀츠 | 울산 현대모비스 피버스 | 인천 전자랜드 엘리펀츠 |
| **2017-18** | 원주 DB 프로미 | 서울 SK 나이츠 | 서울 SK 나이츠 | 원주 DB 프로미 |
| **2016-17** | 안양 KGC인삼공사 | 고양 오리온 오리온스 | 안양 KGC인삼공사 | 서울 삼성 썬더스 |
| **2015-16** | 전주 KCC 이지스 | 울산 모비스 피버스 | 고양 오리온 오리온스 | 전주 KCC 이지스 |
| **2014-15** | 울산 모비스 피버스 | 원주 동부 프로미 | 울산 모비스 피버스 | 원주 동부 프로미 |
| **2013-14** | 창원 LG 세이커스 | 울산 모비스 피버스 | 울산 모비스 피버스 | 창원 LG 세이커스 |
| **2012-13** | 서울 SK 나이츠 | 울산 모비스 피버스 | 울산 모비스 피버스 | 서울 SK 나이츠 |
| **2011-12** | 원주 동부 프로미 | 안양 KGC인삼공사 | 안양 KGC인삼공사 | 원주 동부 프로미 |
| **2010-11** | 원주 동부 프로미 | 인천 전자랜드 엘리펀츠 | 전주 KCC 이지스 | 원주 동부 프로미 |
| **2009-10** | 울산 모비스 피버스 | 전주 KCC 이지스 | 울산 모비스 피버스 | 전주 KCC 이지스 |
| **2008-09** | 울산 모비스 피버스 | 서울 삼성 썬더스 | 전주 KCC 이지스 | 서울 삼성 썬더스 |
| **2007-08** | 원주 동부 프로미 | 서울 삼성 썬더스 | 원주 동부 프로미 | 서울 삼성 썬더스 |
| **2006-07** | 울산 모비스 피버스 | 창원 LG 세이커스 | 울산 모비스 피버스 | 부산 KTF 매직윙스 |
| **2005-06** | 울산 모비스 피버스 | 서울 삼성 썬더스 | 서울 삼성 썬더스 | 울산 모비스 피버스 |
| **2004-05** | 원주 TG삼보 엑써스 | 전주 KCC 이지스 | 원주 TG삼보 엑써스 | 전주 KCC 이지스 |
| **2003-04** | 원주 TG삼보 엑써스 | 전주 KCC 이지스 | 전주 KCC 이지스 | 원주 TG삼보 엑써스 |
| **2002-03** | 대구 동양 오리온스 | 창원 LG 세이커스 | 원주 TG 엑써스 | 대구 동양 오리온스 |
| **2001-02** | 대구 동양 오리온스 | 서울 SK 나이츠 | 대구 동양 오리온스 | 서울 SK 나이츠 |
| **2000-01** | 수원 삼성 썬더스 | 창원 LG 세이커스 | 수원 삼성 썬더스 | 창원 LG 세이커스 |
| **1999-00** | 대전 현대 걸리버스 | 청주 SK 나이츠 | 청주 SK 나이츠 | 대전 현대 걸리버스 |
| **1998-99** | 대전 현대 다이냇 | 부산 기아 엔터프라이즈 | 대전 현대 다이냇 | 부산 기아 엔터프라이즈 |
| **1997-98** | 대전 현대 다이냇 | 부산 기아 엔터프라이즈 | 대전 현대 다이냇 | 부산 기아 엔터프라이즈 |
| **1997 (초대)** | 부산 기아 엔터프라이즈 | 안양 SBS 스타즈 | 부산 기아 엔터프라이즈 | 원주 나래 블루버드 |
"""

def normalize_season(season_str):
    # '2025-26' -> '2025-2026'
    # '1997 (초대)' -> '1997'
    match = re.search(r'(\d{4})-(\d{2})', season_str)
    if match:
        y1 = int(match.group(1))
        y2 = int(match.group(2))
        if y2 < 50:
            y2 += 2000
        else:
            y2 += 1900
        return f"{y1}-{y2}"
    if '1997' in season_str:
        return '1997'
    return season_str

def normalize_team(team_str):
    if not team_str: return ""
    # Remove spaces and common words that might differ
    team_str = team_str.replace(" ", "").replace("(공동)", "")
    return team_str

championships = {}
for line in markdown_table.strip().split('\n'):
    parts = [p.strip() for p in line.split('|') if p.strip()]
    if len(parts) >= 2:
        raw_season = parts[0].replace('**', '')
        season = normalize_season(raw_season)
        
        reg_champ = parts[1]
        reg_runner_up = parts[2] if len(parts) > 2 else ""
        po_champ = parts[3] if len(parts) > 3 else ""
        po_runner_up = parts[4] if len(parts) > 4 else ""
        
        championships[season] = {
            "regular_champ": [normalize_team(t) for t in reg_champ.split('/')],
            "regular_runner_up": [normalize_team(t) for t in reg_runner_up.split('/')],
            "po_champ": [normalize_team(t) for t in po_champ.split('/')],
            "po_runner_up": [normalize_team(t) for t in po_runner_up.split('/')]
        }

def match_team(player_team, winning_teams):
    if not player_team: return False
    pt = normalize_team(player_team)
    for wt in winning_teams:
        if wt and (pt in wt or wt in pt):
            return True
    return False

def extract_pcode(photo_url):
    if not photo_url:
        return None
    basename = photo_url.split('/')[-1]
    pcode = basename.split('.')[0]
    return pcode if pcode.isdigit() else None

def fix():
    legacy_path = 'D:/영상작업/축구/개발/legacy-kbl/data/kbl_players_enriched.json'
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    
    with open(legacy_path, 'r', encoding='utf-8') as f:
        legacy_data = json.load(f)
        
    awards_data = {}
    
    for player in legacy_data:
        pcode = extract_pcode(player.get('photo_url'))
        if not pcode:
            continue
            
        awards_dict = {} # Use dict to group by award type
        
        # Preserve milestones
        for ms in player.get('milestones', []):
            if "milestone" not in awards_dict:
                awards_dict["milestone"] = []
            awards_dict["milestone"].append(ms) # Just keeping track, actually we handle this below

        player_awards = []
        
        # Calculate new championships based on regular_history
        reg_champs = []
        reg_runners = []
        for rh in player.get('regular_history', []):
            season = rh.get('season')
            team = rh.get('team')
            if season in championships:
                if match_team(team, championships[season]['regular_champ']):
                    if season not in reg_champs: reg_champs.append(season)
                if match_team(team, championships[season]['regular_runner_up']):
                    if season not in reg_runners: reg_runners.append(season)

        # Calculate new championships based on playoff_history
        po_champs = []
        po_runners = []
        for ph in player.get('playoff_history', []):
            season = ph.get('season')
            team = ph.get('team')
            if season in championships:
                if match_team(team, championships[season]['po_champ']):
                    if season not in po_champs: po_champs.append(season)
                if match_team(team, championships[season]['po_runner_up']):
                    if season not in po_runners: po_runners.append(season)
                    
        # Sort years
        reg_champs.sort()
        reg_runners.sort()
        po_champs.sort()
        po_runners.sort()

        if po_champs:
            player_awards.append({"id": "champ", "name": "챔피언결정전 우승", "count": len(po_champs), "years": po_champs})
        if reg_champs:
            player_awards.append({"id": "regular_champ", "name": "정규리그 1위", "count": len(reg_champs), "years": reg_champs})
        if po_runners:
            player_awards.append({"id": "runner_up", "name": "챔피언결정전 준우승", "count": len(po_runners), "years": po_runners})
        if reg_runners:
            player_awards.append({"id": "regular_runner_up", "name": "정규리그 2위", "count": len(reg_runners), "years": reg_runners})
            
        for ms in player.get('milestones', []):
            player_awards.append({"id": "milestone", "name": ms, "count": 1, "years": []})
            
        if player_awards:
            awards_data[pcode] = player_awards
            
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(awards_data, f, ensure_ascii=False, indent=2)
        
    print(f"[SUCCESS] Updated {len(awards_data)} players' awards to {output_path}")

if __name__ == '__main__':
    fix()
