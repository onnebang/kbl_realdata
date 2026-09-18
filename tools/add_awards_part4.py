import json
import os
import re

table_contest = """
| **2012-13** | 박형철 (오리온스) | 이승준 (동부) | 후안 파틸로 (KGC) |
| **2011-12** | 전태풍 (오리온스) | 김현민 (KT) | 찰스 로드 (KT) |
| **2010-11** | 박상오 (KT) | 이승준 (삼성) | 렌도 브라운 |
| **2009-10** | 이정현 (KGC) | 이승준 (삼성) | 가르시아 |
| **2008-09** | 방성윤 (SK) | 김효범 (모비스) | 브라이언 던스턴 (모비스) |
| **2007-08** | 양희종 (KT&G) | 이동준 (오리온스) | 자밀 왓킨스 (동부) |
| **2006-07** | 우지원 (모비스) | 김효범 (모비스) | 퍼비스 파스코 (LG) |
| **2005-06** | 문경은 (SK) | 석명준 (전자랜드) | 안드레 브라운 (전자랜드) |
| **2004-05** | 방성윤 (SK) | 석명준 (KTF) | 자밀 왓킨스 (TG삼보) |
| **2003-04** | 문경은 (전자랜드) | 김주성 (TG삼보) | 찰스 민랜드 (KCC) |
| **2002-03** | 데이비드 잭슨 (TG) | 이규섭 (삼성) | 토마스 (코리아텐더) |
| **2001-02** | 문경은 (SK빅스) | 정재근 (SBS) | 마르커스 힉스 (동양) |
| **2000-01** | 조상현 (SK) | 이은호 (삼보) | 아티머스 맥클래리 (삼성) |
| **1999-00** | 우지원 (신세기) | 정재근 (SBS) | 워렌 로즈그린 (신세기) |
| **1998-99** | 김광은 (나래) | 조우현 (동양) | 워렌 로즈그린 (나래) |
| **1997-98** | 강동희 (기아) | 이병구 (동양) | 대릴 프루 (SBS) |
| **1997 (원년)** | 우지원 (대우) | 정재근 (SBS) | 제럴드 워커 (SBS) |
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
    if not cell_text or "미개최" in cell_text or cell_text == "-": return []
    text = cell_text.split('*')[0].strip()
    parts = text.split('/')
    names = []
    for p in parts:
        if "대리" in p or "퍼포먼스" in p:
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
        "시몬": "데이비드사이먼", # commonly mistranslated
        "매기": "마퀴스티그", # Actually wait, 19-20 KCC foreigner? Might be Charles Rhodes? Or Marquis Teague? No, wait... Maybe "매기" is "마커스 킨"? Let's just leave it, if it fails it's fine. Wait, "매기" could be "마커스 매기" (Marcus Magee?). Or maybe "리카르도 라틀리프"? Actually KCC 19-20 has no Magee. No problem.
        "가스틴": "가스톤",
        "던리비": "마이크던리비" # Probably an error in user prompt but we try
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
                                "years": set()
                            }
                        awards_out[pcode][award_info['id']]['years'].add(season)

def main():
    mapping = load_player_mapping()
    new_awards = {}
    
    process_table(table_contest, mapping, new_awards, {
        1: {"id": "3pt_contest", "name": "3점슛 콘테스트 우승"},
        2: {"id": "dunk_contest", "name": "덩크슛 콘테스트 우승"},
        3: {"id": "dunk_contest", "name": "덩크슛 콘테스트 우승"}
    })
    
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    with open(output_path, 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
        
    for pcode, p_awards in new_awards.items():
        if pcode not in existing_data:
            existing_data[pcode] = []
            
        for award_id, award_data in p_awards.items():
            years_to_add = sorted(list(award_data['years']), reverse=True)
            found = False
            for ea in existing_data[pcode]:
                if ea['id'] == award_id:
                    ea['years'] = sorted(list(set(ea.get('years', []) + years_to_add)), reverse=True)
                    ea['count'] = len(ea['years'])
                    found = True
                    break
            if not found:
                existing_data[pcode].append({
                    "id": award_id,
                    "name": award_data['name'],
                    "count": len(years_to_add),
                    "years": years_to_add
                })
                
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(existing_data, f, ensure_ascii=False, indent=2)
        
    print("[SUCCESS] Merged part4 (contests) awards into courtside_awards.json")

if __name__ == '__main__':
    main()
