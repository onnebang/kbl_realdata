import json
import os

rookies_ovr = [
  {
    "pcode": "291854",
    "name": "안세준",
    "season": "2024-2025",
    "ovr": 68,
    "tier": "C",
    "desc": "2025 드래프트 자원. 좋은 슛 터치와 사이즈를 겸비한 포워드",
    "percentile": 80.0
  },
  {
    "pcode": "291852",
    "name": "송재환",
    "season": "2024-2025",
    "ovr": 67,
    "tier": "C",
    "desc": "2025 드래프트 자원. 리바운드 가담이 뛰어난 장신 가드",
    "percentile": 78.0
  },
  {
    "pcode": "291758",
    "name": "강현수",
    "season": "2024-2025",
    "ovr": 67,
    "tier": "C",
    "desc": "2024 드래프트 자원. 폭발적인 스피드와 고감도 3점슛 장착",
    "percentile": 78.0
  },
  {
    "pcode": "291864",
    "name": "우상현",
    "season": "2024-2025",
    "ovr": 66,
    "tier": "C",
    "desc": "2025 드래프트 자원. 탄탄한 득점력을 갖춘 가드 자원",
    "percentile": 76.0
  },
  {
    "pcode": "291868",
    "name": "지용현",
    "season": "2024-2025",
    "ovr": 65,
    "tier": "C",
    "desc": "2025 드래프트 자원. 2m의 신장과 긴 윙스팬을 갖춘 빅맨",
    "percentile": 74.0
  },
  {
    "pcode": "291757",
    "name": "박준형",
    "season": "2024-2025",
    "ovr": 65,
    "tier": "C",
    "desc": "상무/군복무 자원 추정. 수비와 리바운드에 강점을 지닌 포워드",
    "percentile": 74.0
  },
  {
    "pcode": "291762",
    "name": "양준",
    "season": "2024-2025",
    "ovr": 63,
    "tier": "D",
    "desc": "2024 드래프트 자원 (고려대). 높이를 활용한 골밑 자원",
    "percentile": 68.0
  },
  {
    "pcode": "291768",
    "name": "조혁재",
    "season": "2024-2025",
    "ovr": 61,
    "tier": "D",
    "desc": "2024 드래프트 자원 (성균관대). 활동량을 앞세운 롤 플레이어",
    "percentile": 62.0
  }
]

file_path = 'data/courtside_ovr_history.json'

with open(file_path, 'r', encoding='utf-8') as f:
    data = json.load(f)

for r in rookies_ovr:
    # check if exist
    exists = any(x['pcode'] == r['pcode'] and x['season'] == r['season'] for x in data)
    if not exists:
        data.append(r)

with open(file_path, 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("Added rookie OVR records successfully.")
