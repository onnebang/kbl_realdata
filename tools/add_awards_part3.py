import json
import os
import re

table_round_mvp = """
| **2025-26** | 허웅 (KCC) | 이정현 (소노) | 이선 알바노 (DB) | 자밀 워니 (SK) | 이정현 (소노) | 헨리 엘런슨 (DB) |
| **2024-25** | 자밀 워니 (SK) | 자밀 워니 (SK) | 칼 타마요 (LG) | 자밀 워니 (SK) | 안영준 (SK) | 박지훈 (정관장) |
| **2023-24** | 디드릭 로슨 (DB) | 아셈 마레이 (LG) | 패리스 배스 (KT) | 이정현 (소노) | 강상재 (DB) | 이정현 (소노) |
| **2022-23** | 전성현 (캐롯) | 변준형 (KGC) | 전성현 (캐롯) | 이대성 (가스공사) | 김선형 (SK) | 자밀 워니 (SK) |
| **2021-22** | 이대성 (오리온) | 양홍석 (KT) | 변준형 (KGC) | 김선형 (SK) | 허웅 (DB) | 최준용 (SK) |
| **2020-21** | 송교창 (KCC) | 국내선수 통합 | 허훈 (KT) | 이대성 (오리온) | 양동근 (은퇴) / 숀 롱 | 안영준 (SK) |
| **2019-20** | 허훈 (KT) | 최준용 (SK) | 송교창 (KCC) | 두경민 (DB) | 쉰들러 / 코로나 조기종료 | - |
| **2018-19** | 가디 벤자민 (KT) | 이정현 (KCC) | 함지훈 (모비스) | 박찬희 (전자랜드) | 이관희 (삼성) | 이대성 (모비스) |
| **2017-18** | 오세근 (KGC) | 오세근 (KGC) | 디온테 버튼 (DB) | 두경민 (DB) | 버튼 (DB) / 오세근 | 두경민 (DB) |
| **2016-17** | 김태술 (삼성) | 이정현 (KGC) | 오세근 (KGC) | 이승현 (오리온) | 박찬희 (전자랜드) | 오세근 (KGC) |
| **2015-16** | 이정현 (KGC) | 양동근 (모비스) | 김주성 (동부) | 웬델 맥키네스 (동부) | 안드레 에밋 (KCC) | 에밋 (KCC) |
"""

def normalize_season(season_str):
    match = re.search(r'(\d{4})-(\d{2})', season_str)
    if match:
        y1 = int(match.group(1))
        y2 = int(match.group(2))
        if y2 < 50: y2 += 2000
        else: y2 += 1900
        return f"{y1}-{y2}"
    if '1997' in season_str: return '1997'
    return season_str

def extract_names(cell_text):
    if not cell_text or "미개최" in cell_text or cell_text == "-" or "국내선수 통합" in cell_text or "은퇴" in cell_text or "조기종료" in cell_text: 
        # Handle special cases specifically if needed, but for now just skip unparseable
        if "은퇴" in cell_text: # "양동근 (은퇴) / 숀 롱" -> extract 숀 롱
            pass
        elif "조기종료" in cell_text:
            return []
            
    text = cell_text.split('*')[0].strip()
    parts = text.split('/')
    names = []
    for p in parts:
        if "은퇴" in p or "조기종료" in p or "통합" in p:
            continue
        m = re.match(r'([가-힣a-zA-Z\s]+)\s*\(', p.strip())
        if m:
            names.append(m.group(1).strip())
        else:
            names.append(p.strip())
    return [n for n in names if n]

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
        
        name = player.get('name')
        if not name: continue
        
        norm_name = name.replace(" ", "")
        if norm_name not in mapping:
            mapping[norm_name] = []
        mapping[norm_name].append(pcode)
        
    return mapping

def find_pcode(name, mapping):
    norm_name = name.replace(" ", "")
    fixes = {
        "버튼": "디온테버튼",
        "에밋": "안드레에밋",
        "쉰들러": "마커스쉰들러" # just in case, though maybe missing
    }
    if norm_name in fixes:
        norm_name = fixes[norm_name]

    if norm_name in mapping:
        return mapping[norm_name][0]
    
    for k, v in mapping.items():
        if norm_name in k or k in norm_name:
            return v[0]
            
    return None

def process_table(table_str, mapping, awards_out, cols_map):
    for line in table_str.strip().split('\n'):
        parts = [p.strip() for p in line.split('|') if p.strip()]
        if len(parts) < 2: continue
        
        raw_season = parts[0].replace('**', '')
        season = normalize_season(raw_season)
        
        for col_idx, award_info in cols_map.items():
            if col_idx < len(parts):
                names = extract_names(parts[col_idx])
                for name in names:
                    pcode = find_pcode(name, mapping)
                    if pcode:
                        if pcode not in awards_out:
                            awards_out[pcode] = {}
                        if award_info['id'] not in awards_out[pcode]:
                            awards_out[pcode][award_info['id']] = {
                                "id": award_info['id'],
                                "name": award_info['name'],
                                "years": []
                            }
                        awards_out[pcode][award_info['id']]['years'].append(season)

def main():
    mapping = load_player_mapping()
    new_awards = {}
    
    process_table(table_round_mvp, mapping, new_awards, {
        1: {"id": "round_mvp", "name": "라운드 MVP"},
        2: {"id": "round_mvp", "name": "라운드 MVP"},
        3: {"id": "round_mvp", "name": "라운드 MVP"},
        4: {"id": "round_mvp", "name": "라운드 MVP"},
        5: {"id": "round_mvp", "name": "라운드 MVP"},
        6: {"id": "round_mvp", "name": "라운드 MVP"}
    })
    
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    with open(output_path, 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
        
    for pcode, p_awards in new_awards.items():
        if pcode not in existing_data:
            existing_data[pcode] = []
            
        for award_id, award_data in p_awards.items():
            years_to_add = award_data['years']
            found = False
            for ea in existing_data[pcode]:
                if ea['id'] == award_id:
                    ea['years'].extend(years_to_add)
                    ea['years'].sort(reverse=True) # Sort descending for display
                    ea['count'] = len(ea['years'])
                    found = True
                    break
            if not found:
                years_to_add.sort(reverse=True)
                existing_data[pcode].append({
                    "id": award_id,
                    "name": award_data['name'],
                    "count": len(years_to_add),
                    "years": years_to_add
                })
                
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(existing_data, f, ensure_ascii=False, indent=2)
        
    print("[SUCCESS] Merged part3 (round mvps) awards into courtside_awards.json")

if __name__ == '__main__':
    main()
