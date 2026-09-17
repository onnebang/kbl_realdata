import json
import os

with open('D:/영상작업/축구/개발/kbl_realdata/courtside-web/lib/courtside_ovr_history.json', encoding='utf-8') as f:
    data = json.load(f)

from collections import defaultdict
grouped = defaultdict(list)
for row in data:
    grouped[row['pcode']].append(row)

target_names = [
    '김보배', '강지훈', '유기상', '문정현', # Early 20s
    '송교창', '변준형', '하윤기', # Mid-Late 20s
    '이대성', '이승현', '김종규' # Early-Mid 30s
]
results = {}

for pcode, history in grouped.items():
    if not history: continue
    sorted_history = sorted(history, key=lambda x: x['season'])
    name = sorted_history[-1].get('name', 'Unknown')
    if name in target_names:
        if name not in results or len(sorted_history) > len(results[name]):
            results[name] = sorted_history

output = "# OVR 에이징 커브: 연령대별 추가 쇼케이스\n\n"

for name in target_names:
    if name in results:
        h = results[name]
        play_style = h[-1].get("play_style", "N/A")
        
        icon = "⚖️"
        if play_style == "shooter": icon = "🎯"
        elif play_style == "athletic": icon = "⚡"
        
        output += f"### {name} ({icon} {play_style.upper()})\n"
        output += "| 시즌 | 나이 | OVR |\n"
        output += "| :--- | :---: | :---: |\n"
        
        for season in h:
            ovr = season.get('OVR')
            age = season.get('age')
            age_str = str(age) if age else "?"
            output += f"| {season['season']} | {age_str} | **{ovr}** |\n"
        output += "\n---\n\n"

out_path = r'C:\Users\mwon0\.gemini\antigravity-ide\brain\ec0f83b9-0987-4963-af13-dd65290a4e33\ovr_showcase.md'
with open(out_path, 'w', encoding='utf-8') as f:
    f.write(output)

print(f"Artifact created at {out_path}")
