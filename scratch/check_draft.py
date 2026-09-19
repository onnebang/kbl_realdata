import json
import os

target_players = ["강현수", "박준형", "송재환", "안세준", "양준", "우상현", "조혁재", "지용현"]

found_players = []

file_paths = [
    r"D:\영상작업\축구\개발\legacy-kbl\data\kbl_draft_combine_2018_2025.json",
    r"D:\영상작업\축구\개발\legacy-kbl\data\kbl_draft_combine_api_2022_2025.json"
]

for path in file_paths:
    print(f"Checking {path}")
    if os.path.exists(path):
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            
            # structure might be a list or dict
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                items = data.get('data', [])
                if not items:
                    items = list(data.values())
                    if items and isinstance(items[0], list):
                        items = [j for i in items for j in i]
            
            for item in items:
                # Need to gracefully find names depending on schema
                name = item.get('name', '') or item.get('player_name', '')
                if not name and 'info' in item:
                    name = item['info'].get('name', '')
                
                if name in target_players:
                    found_players.append(item)

with open(r'd:\영상작업\축구\개발\kbl_realdata\scratch\draft_output.json', 'w', encoding='utf-8') as f:
    json.dump(found_players, f, ensure_ascii=False, indent=2)
