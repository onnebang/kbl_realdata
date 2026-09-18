import json
import os
import re

table_new_awards = """
| **2025-26** | 에디 다니엘 (SK) | (당해 수상자) | (당해 수상자) |
| **2024-25** | (당해 수상자) | (당해 수상자) | (당해 수상자) |
| **2023-24** | 박인웅 (DB) | 이정현 (소노) | 김주성 (DB) |
| **2022-23** | 박찬희 (원주 DB) | 하윤기 (KT) | 조상현 (LG) |
| **2021-22** | 이관희 (LG) | 구탕 (LG) | 전희철 (SK) |
| **2020-21** | 장민국 (삼성) | 서명진 (현대모비스) | 전창진 (KCC) |
| **2019-20** | 최성원 (SK) | 김낙현 (전자랜드) | 이상범 (DB) |
| **2018-19** | 김선형 (SK) | 양홍석 (KT) | 유재학 (현대모비스) |
| **2017-18** | 김주성 (DB) | 김주성 (DB) *특수시상 | 이상범 (DB) |
| **2016-17** | 정병국 (전자랜드) | 송교창 (KCC) | 이상민 (삼성) |
| **2015-16** | 신명호 (KCC) | 권희철 / 이재도 | 추승균 (KCC) |
| **2014-15** | 유병훈 (LG) | 이재도 (KT) | 유재학 (모비스) |
| **2013-14** | 주희정 (SK) | 변화석 / 장재석 | 김진 (LG) |
| **2012-13** | 변기훈 (SK) | 박형철 (오리온스) | 문경은 (SK) |
| **2011-12** | 이정현 (KGC) | 김태홍 (동부) | 강동희 (동부) |
| **2010-11** | 이현호 (전자랜드) | 김동욱 (삼성) | 전창진 (KT) |
| **2009-10** | 박종천 (모비스) | 박구영 (모비스) | 유재학 (모비스) |
| **2008-09** | 함지훈 (모비스) | 이한권 (전자랜드) | 유재학 (모비스) |
| **2007-08** | 김일두 (KT&G) | 강대협 (동부) | 전창진 (동부) |
| **2006-07** | 우지원 (모비스) | 양희종 / 김태술 | 유재학 (모비스) |
| **2005-06** | 이창수 (울산 모비스) | 표명일 (KCC) | 유재학 (모비스) |
| **2004-05** | 이병석 (울산 모비스) | 김도수 (오리온스) | 전창진 (TG삼보) |
| **2003-04** | 표명일 (TG삼보) | 황진원 (코리아텐더) | 전창진 (TG삼보) |
| **2002-03** | 박규현 (창원 LG) | 조동현 (SK) | 김진 (동양) |
| **2001-02** | 정재근 (안양 SBS) | 최민철 (동양) | 김진 (동양) |
| **2000-01** | 강혁 (수원 삼성) | 조우현 (LG) | 김동광 (삼성) |
| **1999-00** | 황문용 (삼보 엑써스) | 신기성 (삼보) | 최종규 (골드뱅크) |
| **1998-99** | 신종석 (수원 삼성) | 은희석 (SBS) | 신선우 (현대) |
| **1997-98** | 김용식 (경남 LG) | 이병구 / 구본근 | 신선우 (현대) |
| **1997** | 김유택 (부산 기아) | 노기석 (기아) | 최인선 (기아) |
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
    if not cell_text or "(당해 수상자)" in cell_text or cell_text == "-": return []
    text = cell_text.split('*')[0].strip()
    parts = text.split('/')
    names = []
    for p in parts:
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
        "구탕": "저스틴구탕"
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
    
    process_table(table_new_awards, mapping, new_awards, {
        1: {"id": "sixth_man", "name": "식스맨상"},
        2: {"id": "mip", "name": "기량발전상"},
        3: {"id": "coy", "name": "감독상"}
    })
    
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    with open(output_path, 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
        
    for pcode, p_awards in new_awards.items():
        if pcode not in existing_data:
            existing_data[pcode] = []
            
        for award_id, award_data in p_awards.items():
            years = sorted(list(award_data['years']))
            found = False
            for ea in existing_data[pcode]:
                if ea['id'] == award_id:
                    ea['years'] = sorted(list(set(ea.get('years', []) + years)))
                    ea['count'] = len(ea['years'])
                    found = True
                    break
            if not found:
                existing_data[pcode].append({
                    "id": award_id,
                    "name": award_data['name'],
                    "count": len(years),
                    "years": years
                })
                
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(existing_data, f, ensure_ascii=False, indent=2)
        
    print("[SUCCESS] Merged part2 awards into courtside_awards.json")

if __name__ == '__main__':
    main()
