import json
from collections import defaultdict

with open('D:/영상작업/축구/개발/kbl_realdata/courtside-web/lib/courtside_ovr_history.json', encoding='utf-8') as f:
    data = json.load(f)

# Group by pcode
grouped = defaultdict(list)
for row in data:
    grouped[row['pcode']].append(row)

target_names = ['김선형', '이정현', '오세근', '라건아', '최준용', '허웅', '하승진', '문경은', '전태풍']
results = {}

for pcode, history in grouped.items():
    if not history: continue
    sorted_history = sorted(history, key=lambda x: x['season'])
    name = sorted_history[-1].get('name', 'Unknown')
    if name in target_names:
        if name not in results or len(sorted_history) > len(results[name]):
            results[name] = sorted_history

for name in target_names:
    if name in results:
        h = results[name]
        print(f'\n[{name}] Play Style: {h[-1].get("play_style", "N/A")}')
        for season in h:
            print(f"  {season['season']} (Age {season.get('age', '?')}): OVR {season.get('OVR')} (Raw: {season.get('raw_ovr', 0):.1f})")
