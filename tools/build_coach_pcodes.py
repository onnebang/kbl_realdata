import json
import os
import sqlite3

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

def main():
    mapping = load_player_mapping()
    # To get coaches, we can just read from Supabase or just use the json we dumped or sqlite?
    # Actually we can just map ALL coaches that have names. Since we just want Name -> Pcode, 
    # we can just write a generic Name to Pcode dictionary for coaches.
    # But wait, some names might have duplicates. (e.g. 이정현). But coaches are usually older players.
    # Let's just create a static map for the current coaches or all players.
    # Actually, we can just export the `mapping` where len(v) == 1, plus some manual overrides.
    
    coach_pcodes = {}
    # Here are some known coaches who were players
    coaches_to_find = [
        "김주성", "조상현", "전희철", "전창진", "이상범", "유재학", "이상민", "추승균", "김진", "문경은",
        "강동희", "은희석", "서동철", "김승기", "조동현", "김상식", "유도훈", "현주엽", "김태술", "양동근", "신기성"
    ]
    
    # We just create a map from Name -> Pcode for all unique names in legacy data
    out_map = {}
    for k, v in mapping.items():
        if len(v) == 1:
            out_map[k] = v[0]
        else:
            # multiple matches. e.g. "이정현". Coach Lee Jung-hyun doesn't exist yet, but if he does we need specific.
            # Just take the first one for now, or don't include.
            out_map[k] = v[0]
            
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'coach_pcodes.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(out_map, f, ensure_ascii=False, indent=2)
        
    print(f"Created coach_pcodes.json with {len(out_map)} entries.")

if __name__ == '__main__':
    main()
