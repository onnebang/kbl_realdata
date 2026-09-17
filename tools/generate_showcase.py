import json
import os

with open('D:/영상작업/축구/개발/kbl_realdata/courtside-web/lib/courtside_ovr_history.json', encoding='utf-8') as f:
    data = json.load(f)

from collections import defaultdict
grouped = defaultdict(list)
for row in data:
    grouped[row['pcode']].append(row)

target_names = ['라건아', '김선형', '오세근', '이정현', '최준용', '허웅', '하승진', '문경은', '전태풍']
results = {}

for pcode, history in grouped.items():
    if not history: continue
    sorted_history = sorted(history, key=lambda x: x['season'])
    name = sorted_history[-1].get('name', 'Unknown')
    if name in target_names:
        if name not in results or len(sorted_history) > len(results[name]):
            results[name] = sorted_history

output = "# 주요 선수 OVR 에이징 커브 쇼케이스\n\n"
output += "이번에 업데이트된 2K 스타일 시스템(플레이스타일 기반 에이징 커브 + 슈퍼스타 버퍼)이 어떻게 작동하는지 주요 선수들의 실제 궤적을 통해 확인합니다.\n\n"

for name in target_names:
    if name in results:
        h = results[name]
        play_style = h[-1].get("play_style", "N/A")
        
        icon = "⚖️"
        if play_style == "shooter": icon = "🎯"
        elif play_style == "athletic": icon = "⚡"
        
        output += f"### {name} ({icon} {play_style.upper()})\n"
        output += "| 시즌 | 나이 | OVR | (참고용 원본 Raw) |\n"
        output += "| :--- | :---: | :---: | :---: |\n"
        
        for season in h:
            ovr = season.get('OVR')
            raw = season.get('raw_ovr', 0)
            age = season.get('age')
            age_str = str(age) if age else "?"
            output += f"| {season['season']} | {age_str} | **{ovr}** | {raw:.1f} |\n"
        output += "\n---\n\n"

out_path = r'C:\Users\mwon0\.gemini\antigravity-ide\brain\ec0f83b9-0987-4963-af13-dd65290a4e33\ovr_showcase.md'
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(output)

print(f"Artifact created at {out_path}")
