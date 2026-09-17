import json
import os

def extract_pcode(photo_url):
    if not photo_url:
        return None
    basename = photo_url.split('/')[-1]
    pcode = basename.split('.')[0]
    return pcode if pcode.isdigit() else None

def migrate():
    input_path = 'D:/영상작업/축구/개발/legacy-kbl/data/kbl_players_enriched.json'
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    
    with open(input_path, 'r', encoding='utf-8') as f:
        legacy_data = json.load(f)
        
    awards_data = {}
    
    for player in legacy_data:
        pcode = extract_pcode(player.get('photo_url'))
        if not pcode:
            continue
            
        awards = []
        
        # 1. Championships
        champs = player.get('championship_seasons', [])
        if champs:
            awards.append({
                "id": "champ",
                "name": "챔피언결정전 우승",
                "count": len(champs),
                "years": [c['season'] for c in champs]
            })
            
        # 2. Runner-ups
        runnerups = player.get('runnerup_seasons', [])
        if runnerups:
            awards.append({
                "id": "runner_up",
                "name": "챔피언결정전 준우승",
                "count": len(runnerups),
                "years": [c['season'] for c in runnerups]
            })
            
        # 3. Milestones
        milestones = player.get('milestones', [])
        for ms in milestones:
            # milestone format is just a string, e.g., "1000득점"
            # We treat them as individual awards with count=1
            awards.append({
                "id": "milestone",
                "name": ms,
                "count": 1,
                "years": []
            })
            
        if awards:
            awards_data[pcode] = awards
            
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(awards_data, f, ensure_ascii=False, indent=2)
        
    print(f"[SUCCESS] Migrated {len(awards_data)} players' awards to {output_path}")

if __name__ == '__main__':
    migrate()
