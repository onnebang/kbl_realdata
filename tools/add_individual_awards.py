import json
import os
import re

# Markdown tables from user
table_mvp = """
| **2025-26** | 송교창 (KCC) | *외국인 MVP 미선정 또는 통합 | 허웅 (KCC) |
| **2024-25** | 자밀 워니 (SK) *통합 | - | 이관희 (LG) |
| **2023-24** | 이선 알바노 (DB) | 디드릭 로슨 (DB) | 허웅 (KCC) |
| **2022-23** | 김선형 (SK) | 자밀 워니 (SK) | 오세근 (KGC) |
| **2021-22** | 최준용 (SK) | 자밀 워니 (SK) | 김선형 (SK) |
| **2020-21** | 송교창 (KCC) | 숀 롱 (현대모비스) | 제러드 설린저 (KGC) |
| **2019-20** | 허훈 (KT) | 자밀 워니 (SK) | *(코로나19로 PO 미개최)* |
| **2018-19** | 이정현 (KCC) | 제임스 메이스 (LG) | 이대성 (현대모비스) |
| **2017-18** | 두경민 (DB) | 디온테 버튼 (DB) | 테리코 화이트 (SK) |
| **2016-17** | 오세근 (KGC) | 리카르도 라틀리프 (삼성) | 오세근 (KGC) |
| **2015-16** | 양동근 (모비스) | 안드레 에밋 (KCC) | 이승현 (오리온) |
| **2014-15** | 양동근 (모비스) | 리카르도 라틀리프 (모비스) | 양동근 (모비스) |
| **2013-14** | 문태종 (LG) | 다지white헤드 (SK) / 데이비드 사이먼 | 양동근 (모비스) |
| **2012-13** | 김선형 (SK) | 리온 윌리엄스 (오리온스) | 양동근 (모비스) |
| **2011-12** | 윤호영 (동부) | 크리스 윌리엄스 (오리온스) | 오세근 (KGC) |
| **2010-11** | 박상오 (KT) | 에런 헤인즈 (삼성) | 하승진 (KCC) |
| **2009-10** | 함지훈 (모비스) | 던스턴 (모비스) | 함지훈 (모비스) |
| **2008-09** | 주희정 (KT&G) | 테렌스 레더 (삼성) | 추승균 (KCC) |
| **2007-08** | 김주성 (동부) | 테렌스 레더 (삼성) | 김주성 (동부) |
| **2006-07** | 양동근 (모비스) | 피트 마이클 (오리온스) | 양동근 (모비스) |
| **2005-06** | 양동근 / 서장훈 (공동) | 크리스 윌리엄스 (모비스) | 강혁 (삼성) |
| **2004-05** | 신기성 (TG삼보) | 아비 스토리 (LG) | 김주성 (TG삼보) |
| **2003-04** | 김주성 (TG삼보) | 찰스 민랜드 (KCC) | 이상민 (KCC) |
| **2002-03** | 김병철 (동양) | 마르커스 힉스 (동양) | 데이비드 잭슨 (TG) |
| **2001-02** | 김승현 (동양) | 마르커스 힉스 (동양) | 마르커스 힉스 (동양) |
| **2000-01** | 조성원 (LG) | 아티머스 맥클래리 (삼성) | 주희정 (삼성) |
| **1999-00** | 서장훈 (SK) | 조니 맥도웰 (현대) | 서장훈 (SK) |
| **1998-99** | 이상민 (현대) | 조니 맥도웰 (현대) | 조성원 (현대) |
| **1997-98** | 이상민 (현대) | 조니 맥도웰 (현대) | 허재 (기아) *역대유일 준우승팀 MVP |
| **1997** | 강동희 (기아) | 클리프 리드 (기아) | 기아민 (기아) |
"""

table_rookie_dpoy = """
| **2023-24** | 유기상 (LG) | 오재현 (SK) |
| **2022-23** | 론제이 아바리엔토스 (현대모비스) | 문성곤 (KGC) |
| **2021-22** | 이우석 (현대모비스) | 문성곤 (KGC) |
| **2020-21** | 오재현 (SK) | 문성곤 (KGC) |
| **2019-20** | 김훈 (DB) | 문성곤 (KGC) |
| **2018-19** | 변준형 (KGC) | 신명호 (KCC) |
| **2017-18** | 안영준 (SK) | 이승현 (오리온) |
| **2016-17** | 강상재 (전자랜드) | 이승현 (오리온) |
| **2015-16** | 정성우 (LG) | 신명호 (KCC) |
| **2014-15** | 이승현 (오리온스) | 양동근 (모비스) |
| **2013-14** | 김종규 (LG) | 신명호 (KCC) |
| **2012-13** | 최부경 (SK) | 신명호 (KCC) |
| **2011-12** | 오세근 (KGC) | 진경석 (KT) |
| **2010-11** | 박찬희 (KGC) | 이현민 (오리온스) |
| **2009-10** | 박성진 (전자랜드) | 신명호 (KCC) |
| **2008-09** | 하승진 (KCC) | 김효범 (모비스) |
| **2007-08** | 김태술 (SK) | 김주성 (동부) |
| **2006-07** | 이현민 (LG) | 김주성 (동부) |
| **2005-06** | 방성윤 (SK) | 김주성 (동부) |
| **2004-05** | 양동근 (모비스) | 김주성 (TG삼보) |
| **2003-04** | 이현호 (삼성) | 김주성 (TG삼보) |
| **2002-03** | 송영진 (LG) | 김주성 (TG) |
| **2001-02** | 김승현 (동양) | 조우현 (LG) |
| **2000-01** | 이정래 (LG) | 장창곤 (SK) |
| **1999-00** | 김성철 (SBS) | 신기성 (삼보) |
| **1998-99** | 신기성 (나래) | 유도훈 (현대) |
| **1997-98** | 주희정 (나래) | 강동희 (기아) |
| **1997** | 이인구 (현대) | 박재현 (기아) |
"""

table_allstar = """
| **2023-24** | 고양 소노 아레나 | 자밀 워니 (SK) |
| **2022-23** | 수원 KT 소닉붐 아레나 | 하윤기 (KT) |
| **2021-22** | 대구체육관 | 허웅 (DB) |
| **2020-21** | *(코로나19 여파로 올스타전 미개최)* | - |
| **2019-20** | 인천삼산월드체육관 | 김선형 (SK) |
| **2018-19** | 창원체육관 | 마커스 랜드리 (KT) |
| **2017-18** | 잠실학생체육관 | 디온테 버튼 (DB) |
| **2016-17** | 사직실내체육관 | 오세근 (KGC) |
| **2015-16** | 잠실실내체육관 | 김선형 (SK) |
| **2014-15** | 잠실실내체육관 | 김선형 (SK) |
| **2013-14** | 잠실학생체육관 | 김선형 (SK) |
| **2012-13** | 잠실실내체육관 | 후안 파틸로 (KGC) |
| **2011-12** | 잠실실내체육관 | 문태영 (LG) |
| **2010-11** | 잠실실내체육관 | 김효범 (SK) |
| **2009-10** | 잠실실내체육관 | 이승준 (삼성) |
| **2008-09** | 잠실학생체육관 | 이동준 (오리온스) |
| **2007-08** | 잠실학생체육관 | 김주성 (동부) |
| **2006-07** | 울산동천체육관 | 조상현 (LG) |
| **2005-06** | 잠실실내체육관 | 서장훈 (삼성) |
| **2004-05** | 잠실실내체육관 | 찰스 민랜드 (KCC) |
| **2003-04** | 잠실실내체육관 | 문경은 (전자랜드) |
| **2002-03** | 잠실실내체육관 | 마르커스 힉스 (동양) |
| **2001-02** | 잠실실내체육관 | 안드레 페리 (삼보) |
| **2000-01** | 잠실실내체육관 | 아티머스 맥클래리 (삼성) |
| **1999-00** | 잠실실내체육관 | 워렌 로즈그린 (신세기) |
| **1998-99** | 잠실실내체육관 | 제럴드 워커 (SBS) |
| **1997-98** | 잠실실내체육관 | 강동희 (기아) |
| **1997** | 올림픽제2체육관 | 제럴드 워커 (SBS) |
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
    # Remove extra tags like "*통합", "*역대유일..."
    text = cell_text.split('*')[0].strip()
    # Split by / for multiple winners
    parts = text.split('/')
    names = []
    for p in parts:
        # Extract name before parenthesis
        m = re.match(r'([가-힣a-zA-Z\s]+)\s*\(', p.strip())
        if m:
            names.append(m.group(1).strip())
        else:
            names.append(p.strip())
    # Clean up empty strings or known bad strings
    return [n for n in names if n and "미선정" not in n]

def load_player_mapping():
    legacy_path = 'D:/영상작업/축구/개발/legacy-kbl/data/kbl_players_enriched.json'
    with open(legacy_path, 'r', encoding='utf-8') as f:
        legacy_data = json.load(f)
    
    # name to pcode list (some names might be duplicate)
    mapping = {}
    for player in legacy_data:
        photo_url = player.get('photo_url')
        if not photo_url: continue
        basename = photo_url.split('/')[-1]
        pcode = basename.split('.')[0]
        if not pcode.isdigit(): continue
        
        name = player.get('name')
        if not name: continue
        
        # We might need to map both Korean and English if available, but legacy json only has Korean names
        # Let's map normalized name (no spaces)
        norm_name = name.replace(" ", "")
        if norm_name not in mapping:
            mapping[norm_name] = []
        mapping[norm_name].append(pcode)
        
    return mapping

def find_pcode(name, mapping):
    norm_name = name.replace(" ", "")
    # Hardcoded fixes for typos/variations in prompt
    fixes = {
        "다지white헤드": "다지화이트헤드", # if it exists, otherwise it will fail gracefully
        "기아민": "기아민", # Maybe typo for something else, we just look for exact match
        "던스턴": "브라이언던스턴",
        "에런헤인즈": "애런헤인즈"
    }
    if norm_name in fixes:
        norm_name = fixes[norm_name]

    if norm_name in mapping:
        # If multiple, just pick first for now, usually it's unique enough for famous award winners
        return mapping[norm_name][0]
    
    # Try partial match (like last name only for foreigners)
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
    
    process_table(table_mvp, mapping, new_awards, {
        1: {"id": "regular_mvp", "name": "정규리그 MVP"},
        2: {"id": "regular_mvp", "name": "정규리그 MVP"}, # Foreigner MVP merged into regular_mvp
        3: {"id": "po_mvp", "name": "플레이오프 MVP"}
    })
    
    process_table(table_rookie_dpoy, mapping, new_awards, {
        1: {"id": "rookie", "name": "신인선수상"},
        2: {"id": "dpoy", "name": "최우수 수비상"}
    })
    
    process_table(table_allstar, mapping, new_awards, {
        2: {"id": "allstar_mvp", "name": "올스타전 MVP"}
    })
    
    # Load existing awards
    output_path = os.path.join(os.path.dirname(__file__), '..', 'courtside-web', 'lib', 'courtside_awards.json')
    with open(output_path, 'r', encoding='utf-8') as f:
        existing_data = json.load(f)
        
    # Merge
    for pcode, p_awards in new_awards.items():
        if pcode not in existing_data:
            existing_data[pcode] = []
            
        # Add new awards
        for award_id, award_data in p_awards.items():
            years = sorted(list(award_data['years']))
            # Check if it already exists (e.g. maybe milestone has it)
            found = False
            for ea in existing_data[pcode]:
                if ea['id'] == award_id:
                    # Merge years
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
        
    print("[SUCCESS] Merged individual awards into courtside_awards.json")

if __name__ == '__main__':
    main()
