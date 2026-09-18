import json
import os
import re

table_round = """
| **2025-26** | 허웅 (KCC) | 이정현 (소노) | 이선 알바노 (DB) | 자밀 워니 (SK) | 이정현 (소노) | 헨리 엘런슨 (DB) |
| **2024-25** | 자밀 워니 (SK) | 자밀 워니 (SK) | 칼 타마요 (LG) | 자밀 워니 (SK) | 안영준 (SK) | 박지훈 (정관장) |
| **2023-24** | 디드릭 로슨 (DB) | 아셈 마레이 (LG) | 패리스 배스 (KT) | 이정현 (소노) | 강상재 (DB) | 이정현 (소노) |
| **2022-23** | 전성현 (캐롯) | 변준형 (KGC) | 전성현 (캐롯) | 이대성 (가스공사) | 김선형 (SK) | 자밀 워니 (SK) |
| **2021-22** | 이대성 (오리온) | 양홍석 (KT) | 변준형 (KGC) | 김선형 (SK) | 허웅 (DB) | 최준용 (SK) |
| **2020-21** | 송교창 (KCC) | 국내선수 통합 | 허훈 (KT) | 이대성 (오리온) | 양동근 (은퇴행사) / 숀 롱 | 안영준 (SK) |
| **2019-20** | 허훈 (KT) | 최준용 (SK) | 송교창 (KCC) | 두경민 (DB) | *공석 (코로나19 종료)* | *공석 (코로나19 종료)* |
| **2018-19** | 가디 벤자민 (KT) | 이정현 (KCC) | 함지훈 (모비스) | 박찬희 (전자랜드) | 이관희 (삼성) | 이대성 (모비스) |
| **2017-18** | 오세근 (KGC) | 오세근 (KGC) | 디온테 버튼 (DB) | 두경민 (DB) | 버튼 (DB) / 오세근 | 두경민 (DB) |
| **2016-17** | 김태술 (삼성) | 이정현 (KGC) | 오세근 (KGC) | 이승현 (오리온) | 박찬희 (전자랜드) | 오세근 (KGC) |
| **2015-16** | 애런 헤인즈 (오리온) | 양동근 (모비스) | 김주성 (동부) | 웬델 맥키네스 (동부) | 안드레 에밋 (KCC) | 안드레 에밋 (KCC) |
"""

text_month = """
* **1997시즌 (원년)**
  - 2월: 제럴드 워커 (SBS)
  - 3월: 클리프 리드 (기아)
* **1997-98시즌**
  - 11월: 이상민 (현대)
  - 12월: 조니 맥도웰 (현대)
  - 1월: 박재현 (기아)
  - 2월: 문경은 (삼성)
* **1998-99시즌**
  - 11월: 서장훈 (SK)
  - 12월: 조니 맥도웰 (현대)
  - 1월: 이상민 (현대)
  - 2월: 주희정 (삼성)
* **1999-00시즌**
  - 11월: 서장훈 (SK)
  - 12월: 조니 맥도웰 (현대)
  - 1월: 재키 존스 (현대)
  - 2월: 강혁 (삼성)
* **2000-01시즌**
  - 11월: 아티머스 맥클래리 (삼성)
  - 12월: 조성원 (LG)
  - 1월: 강동희 (기아)
  - 2월: 재키 존스 (SK)
* **2001-02시즌**
  - 11월: 김승현 (동양)
  - 12월: 마르커스 힉스 (동양)
  - 1월: 조니 맥도웰 (SK빅스)
  - 2월: 서장훈 (SK)
* **2002-03시즌**
  - 11월: 마르커스 힉스 (동양)
  - 12월: 김병철 (동양)
  - 1월: 데이비드 잭슨 (TG)
  - 2월: 현주엽 (코리아텐더)
* **2003-04시즌**
  - 11월: 김주성 (TG)
  - 12월: 찰스 민랜드 (KCC)
  - 1월: 이상민 (KCC)
  - 2월: 김주성 (TG)
* **2004-05시즌**
  - 11월: 아비 스토리 (LG)
  - 12월: 신기성 (TG삼보)
  - 1월: 자밀 왓킨스 (TG삼보)
  - 2월: 서장훈 (삼성)
* **2005-06시즌**
  - 11월: 크리스 윌리엄스 (모비스)
  - 12월: 양동근 (모비스)
  - 1월: 서장훈 (삼성)
  - 2월: 피트 마이클 (오리온스)
* **2006-07시즌**
  - 11월: 피트 마이클 (오리온스)
  - 12월: 퍼비스 파스코 (LG)
  - 1월: 양동근 (모비스)
  - 2월: 단테 존스 (KT&G)
* **2007-08시즌**
  - 11월: 김주성 (동부)
  - 12월: 테렌스 레더 (삼성)
  - 1월: 주희정 (KT&G)
  - 2월: 김주성 (동부)
* **2008-09시즌**
  - 11월: 브라이언 던스턴 (모비스)
  - 12월: 테렌스 레더 (삼성)
  - 1월: 주희정 (KT&G)
  - 2월: 함지훈 (모비스)
* **2009-10시즌**
  - 10·11월: 함지훈 (모비스)
  - 12월: 문태영 (LG)
  - 1월: 김주성 (동부)
  - 2·3월: 양동근 (모비스)
* **2010-11시즌**
  - 10·11월: 박상오 (KT)
  - 12월: 문태영 (LG)
  - 1월: 에런 헤인즈 (삼성)
  - 2·3월: 하승진 (KCC)
* **2011-12시즌**
  - 10월: 김주성 (동부)
  - 11월: 크리스 윌리엄스 (오리온스)
  - 12월: 오세근 (KGC)
  - 1월: 윤호영 (동부)
  - 2·3월: 양동근 (모비스)
* **2012-13시즌**
  - 10월: 김선형 (SK)
  - 11월: 리온 윌리엄스 (오리온스)
  - 12월: 애런 헤인즈 (SK)
  - 1월: 양동근 (모비스)
  - 2·3월: 로드 벤슨 (현대모비스)
* **2013-14시즌**
  - 10월: 박상오 (SK)
  - 11월: 김종규 (LG)
  - 12월: 문태종 (LG)
  - 1월: 양동근 (모비스)
  - 2·3월: 함지훈 (모비스)
* **2014-15시즌**
  - 10월: 김주성 (동부)
  - 11월: 트로이 길렌워터 (오리온스)
  - 12월: 리카르도 라틀리프 (모비스)
  - 1월: 김선형 (SK)
  - 2·3월: 애런 헤인즈 (SK)
"""

def normalize_season(season_str):
    if '1997' in season_str and '98' not in season_str: return '1997'
    match = re.search(r'(\d{4})-(\d{2,4})', season_str)
    if match:
        y1 = int(match.group(1))
        y2 = int(match.group(2))
        if y2 < 50: y2 += 2000
        elif y2 < 100: y2 += 1900
        return f"{y1}-{y2}"
    return season_str

def extract_names(cell_text):
    if not cell_text or "공석" in cell_text or "국내선수 통합" in cell_text or "은퇴" in cell_text: return []
    text = cell_text.split('*')[0].strip()
    parts = text.split('/')
    names = []
    for p in parts:
        if "은퇴" in p or "공석" in p: continue
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
        
        name = player.get('name').replace(" ", "")
        if name not in mapping:
            mapping[name] = []
        mapping[name].append(pcode)
        
    return mapping

def find_pcode(name, mapping):
    name = name.replace(" ", "")
    if name in mapping: return mapping[name][0]
    for k, v in mapping.items():
        if name in k or k in name: return v[0]
    return None

def process_data(mapping):
    awards_out = {}
    
    # Process round MVPs
    for line in table_round.strip().split('\n'):
        parts = [p.strip() for p in line.split('|') if p.strip()]
        if len(parts) < 2: continue
        season = normalize_season(parts[0].replace('**', ''))
        
        for col_idx in range(1, 7):
            if col_idx < len(parts):
                names = extract_names(parts[col_idx])
                for name in names:
                    pcode = find_pcode(name, mapping)
                    if pcode:
                        if pcode not in awards_out: awards_out[pcode] = {}
                        if "round_mvp" not in awards_out[pcode]:
                            awards_out[pcode]["round_mvp"] = {"id": "round_mvp", "name": "라운드 MVP", "years": set()}
                        awards_out[pcode]["round_mvp"]["years"].add(season)
                        
    # Process month MVPs (convert to round MVP conceptually or '월간 MVP' but let's use round_mvp for UI simplicity or month_mvp)
    # The UI already has `round_mvp` which says "라운드". Let's add a new ID `month_mvp` for 월간 MVP and map it in UI.
    current_season = ""
    for line in text_month.strip().split('\n'):
        line = line.strip()
        if line.startswith('* **'):
            s_match = re.search(r'\*\s*\*\*(.*?)\*\*', line)
            if s_match:
                current_season = normalize_season(s_match.group(1))
        elif line.startswith('-'):
            # - 2월: 제럴드 워커 (SBS)
            m = re.match(r'-\s*[^:]+:\s*(.+)', line)
            if m:
                names = extract_names(m.group(1))
                for name in names:
                    pcode = find_pcode(name, mapping)
                    if pcode:
                        if pcode not in awards_out: awards_out[pcode] = {}
                        if "month_mvp" not in awards_out[pcode]:
                            awards_out[pcode]["month_mvp"] = {"id": "month_mvp", "name": "이달의 선수상 (월간 MVP)", "years": set()}
                        awards_out[pcode]["month_mvp"]["years"].add(current_season)
                        
    return awards_out

def main():
    mapping = load_player_mapping()
    new_awards = process_data(mapping)
    
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
        
    print("[SUCCESS] Merged part5 awards into courtside_awards.json")

if __name__ == '__main__':
    main()
