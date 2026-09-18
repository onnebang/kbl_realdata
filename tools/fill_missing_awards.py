import json
import os

def load_player_mapping():
    legacy_path = 'D:/영상작업/축구/개발/legacy-kbl/data/kbl_players_enriched.json'
    with open(legacy_path, 'r', encoding='utf-8') as f:
        legacy_data = json.load(f)
    
    mapping = {}
    for player in legacy_data:
        photo_url = player.get('photo_url')
        if not photo_url: continue
        basename = photo_url.split('/')[-1]
        pcode = basename.split('.')[0]
        if not pcode.isdigit(): continue
        
        name = player.get('name').replace(" ", "")
        if name not in mapping:
            mapping[name] = []
        mapping[name].append(pcode)
    return mapping

def find_pcode(name, mapping):
    name = name.replace(" ", "")
    fixes = {
        "JD카굴랑안": "JD카굴랑안", # Assuming exact match
        "케빈켐바오": "케빈콰이암바오",
        "케빈콰이암바오": "케빈콰이암바오",
    }
    name = fixes.get(name, name)
    if name in mapping:
        return mapping[name][0]
    for k, v in mapping.items():
        if name in k or k in name:
            return v[0]
    return None

def main():
    mapping = load_player_mapping()
    
    # Missing awards data
    missing_data = [
        # 2024-25
        ("JD카굴랑안", "rookie", "신인선수상", "2024-25"),
        ("박준영", "sixth_man", "식스맨상", "2024-25"),
        ("양준석", "mip", "기량발전상", "2024-25"),
        ("전희철", "coy", "감독상", "2024-25"),
        # 2025-26
        ("케빈콰이암바오", "rookie", "신인선수상", "2025-26"),
        ("서명진", "mip", "기량발전상", "2025-26"),
        ("조상현", "coy", "감독상", "2025-26"),
        ("아셈마레이", "dpoy", "최우수수비상", "2025-26"),
    ]
    
    db_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    with open(db_path, 'r', encoding='utf-8') as f:
        db = json.load(f)
        
    added = 0
    for name, award_id, award_name, season in missing_data:
        pcode = find_pcode(name, mapping)
        if not pcode:
            # Maybe coach not in players json
            print(f"Pcode not found for {name}")
            continue
            
        if pcode not in db:
            db[pcode] = []
            
        found = False
        for award in db[pcode]:
            if award['id'] == award_id:
                if season not in award.get('years', []):
                    award['years'] = sorted(list(set(award.get('years', []) + [season])), reverse=True)
                    award['count'] = len(award['years'])
                found = True
                break
        
        if not found:
            db[pcode].append({
                "id": award_id,
                "name": award_name,
                "count": 1,
                "years": [season]
            })
        added += 1
        print(f"Added {award_name} ({season}) to {name} ({pcode})")
            
    with open(db_path, 'w', encoding='utf-8') as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
        
    print(f"Done. Added {added} missing awards.")

if __name__ == '__main__':
    main()
