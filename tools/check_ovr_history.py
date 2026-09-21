"""OVR/수상 산출물 회귀 검사(DB 없이 JSON만). python check_ovr_history.py

build_courtside_ovr.py를 돌린 뒤 실행한다. 아래는 전부 실제로 한 번씩 터졌던 문제다.
"""
import collections
import json
import os

LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'courtside-web', 'lib')
with open(os.path.join(LIB, 'courtside_ovr_history.json'), encoding='utf-8') as f:
    history = json.load(f)
with open(os.path.join(LIB, 'courtside_awards.json'), encoding='utf-8') as f:
    awards = json.load(f)

# 1) (pcode, 시즌)은 유일해야 한다 - 동명이인(이정현 x2, 김주성 x2)을 이름으로 조인하면 행이 곱절로 불어났다.
dups = [k for k, n in collections.Counter((r['pcode'], r['season']) for r in history).items() if n > 1]
assert not dups, f"(pcode, season) 중복 {len(dups)}건: {dups[:5]}"

# 2) lib/ovr.ts는 배열이 (pcode, season) 오름차순이라고 가정하고 재정렬하지 않는다.
keys = [(r['pcode'], r['season']) for r in history]
assert keys == sorted(keys), "OVR 기록이 (pcode, season) 순으로 정렬돼 있지 않음"

# 3) 같은 수상이 한 선수에게 두 줄로 들어가면 안 된다(milestone은 이름별로 여러 줄이 정상).
for pcode, items in awards.items():
    ids = collections.Counter(a['id'] for a in items if a['id'] != 'milestone')
    twice = [i for i, n in ids.items() if n > 1]
    assert not twice, f"{pcode}: 수상 id 중복 {twice}"
    for a in items:
        assert a['count'] == len(a['years']) or a['id'] == 'milestone', f"{pcode} {a['id']}: count != len(years)"

# 4) 동명이인 이정현 - 소노(291488, 1999년생)와 DB(290381, 1987년생)의 수상이 섞이지 않았는지.
db_ids = {a['id'] for a in awards['290381']}
sono_ids = {a['id'] for a in awards['291488']}
assert 'mip' in sono_ids and 'mip' not in db_ids, "기량발전상(2023-24)은 소노 이정현 것"
assert 'regular_mvp' in db_ids and 'regular_mvp' not in sono_ids, "정규리그 MVP(2018-19)는 DB 이정현 것"
assert all(int(y[:4]) >= 2021 for a in awards['291488'] for y in a['years']), "소노 이정현 데뷔(2021) 이전 수상이 섞임"

print(f"통과: OVR {len(history)}행, 수상 {len(awards)}명")
