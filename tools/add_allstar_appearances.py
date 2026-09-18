import json
import os
import urllib.request
import time

def api_get(path):
    url = f"https://api.kbl.or.kr{path}"
    headers = {
        "Channel": "WEB",
        "TeamCode": "XX",
        "lang": "ko"
    }
    req = urllib.request.Request(url, headers=headers)
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            time.sleep(1)
    return None

def get_season_name(season_code, game_date, season_name1):
    # Some seasons have seasonName1 like "2025-2026", some "1997"
    if "-" in season_name1:
        parts = season_name1.split("-")
        y1 = parts[0]
        y2 = parts[1]
        return f"{y1}-{y2[-2:]}"
    
    year = int(season_name1)
    if year == 1997 and season_code == 1:
        return "1997"
    
    next_year = year + 1
    return f"{year}-{str(next_year)[-2:]}"

def main():
    print("Fetching game list 1997-2026...")
    # Fetch all games (this might be large, but we only need AS)
    # Actually, the API might not allow 30 years at once if it's too large. Let's try.
    games = api_get("/match/list?fromDate=19970101&toDate=20261231&tcodeList=all")
    if not games:
        print("Failed to fetch games")
        return
        
    as_games = [g for g in games if g.get('seasonCategory') == 'AS']
    print(f"Found {len(as_games)} All-Star games")
    
    appearances = {} # pcode -> set of season names
    
    for idx, g in enumerate(as_games):
        gmkey = g['gmkey']
        season = get_season_name(g['seasonCode'], g['gameDate'], g['seasonName1'])
        
        print(f"Fetching boxscore for {gmkey} ({season})... [{idx+1}/{len(as_games)}]")
        stats = api_get(f"/match/{gmkey}/player-stat")
        if stats:
            for s in stats:
                p = s.get('player', {})
                pcode = p.get('pcode')
                if pcode:
                    if pcode not in appearances:
                        appearances[pcode] = set()
                    appearances[pcode].add(season)
        time.sleep(0.3)
        
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    with open(output_path, 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
        
    for pcode, seasons in appearances.items():
        if pcode not in existing_data:
            existing_data[pcode] = []
            
        years_to_add = sorted(list(seasons), reverse=True)
        
        found = False
        for ea in existing_data[pcode]:
            if ea['id'] == 'allstar':
                # Merge
                merged = list(set(ea.get('years', []) + years_to_add))
                merged.sort(reverse=True)
                ea['years'] = merged
                ea['count'] = len(merged)
                found = True
                break
        
        if not found:
            existing_data[pcode].append({
                "id": "allstar",
                "name": "올스타전 출전",
                "count": len(years_to_add),
                "years": years_to_add
            })
            
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(existing_data, f, ensure_ascii=False, indent=2)
        
    print("[SUCCESS] Merged All-Star appearances into courtside_awards.json")

if __name__ == '__main__':
    main()
