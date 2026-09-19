import json

new_records = [
  {
    "pcode": None,
    "name": "스코티 제임스",
    "season": "2026-2027",
    "team": "고양 소노",
    "position": "C/F",
    "OVR": 88,
    "OFF": 89,
    "DEF": 87,
    "archetype": "글래스 클리너",
    "badges": { "finishing": 1, "shooting": 1, "playmaking": 0, "defense": 0 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "다리우스 베즐리",
    "season": "2026-2027",
    "team": "울산 현대모비스",
    "position": "F/C",
    "OVR": 86,
    "OFF": 84,
    "DEF": 88,
    "archetype": "림 프로텍터",
    "badges": { "finishing": 1, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "존 무니",
    "season": "2026-2027",
    "team": "안양 정관장",
    "position": "C",
    "OVR": 85,
    "OFF": 84,
    "DEF": 86,
    "archetype": "림 프로텍터",
    "badges": { "finishing": 1, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "루이스 킹",
    "season": "2026-2027",
    "team": "부산 KCC",
    "position": "F",
    "OVR": 84,
    "OFF": 88,
    "DEF": 80,
    "archetype": "슬래셔",
    "badges": { "finishing": 1, "shooting": 1, "playmaking": 0, "defense": 0 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "아치 굿윈",
    "season": "2026-2027",
    "team": "창원 LG",
    "position": "G/F",
    "OVR": 82,
    "OFF": 85,
    "DEF": 78,
    "archetype": "샷 크리에이터",
    "badges": { "finishing": 1, "shooting": 0, "playmaking": 1, "defense": 0 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "트레이 포터",
    "season": "2026-2027",
    "team": "수원 KT",
    "position": "C",
    "OVR": 80,
    "OFF": 77,
    "DEF": 83,
    "archetype": "림 프로텍터",
    "badges": { "finishing": 0, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "제리 아바디아노",
    "season": "2026-2027",
    "team": "울산 현대모비스",
    "position": "G",
    "OVR": 72,
    "OFF": 68,
    "DEF": 76,
    "archetype": "락다운 디펜더",
    "badges": { "finishing": 0, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  }
]

# Eddie Daniel Override
eddie_records = [
  {
    "pcode": "291846",
    "name": "에디 다니엘",
    "season": "2025-2026",
    "team": "서울 SK",
    "position": "F/C",
    "OVR": 78,
    "OFF": 75,
    "DEF": 81,
    "archetype": "수비형 빅맨",
    "badges": { "finishing": 0, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": False
  },
  {
    "pcode": "291846",
    "name": "에디 다니엘",
    "season": "2026-2027",
    "team": "서울 SK",
    "position": "F/C",
    "OVR": 80,
    "OFF": 77,
    "DEF": 83,
    "archetype": "수비형 빅맨",
    "badges": { "finishing": 0, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  }
]
new_records.extend(eddie_records)

with open('courtside-web/lib/courtside_ovr_history.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

# Remove old Eddie Daniel records
data = [d for d in data if d.get('pcode') != '291846']
data = [d for d in data if not (d.get('pcode') is None and d.get('name') in [r['name'] for r in new_records])]
data.extend(new_records)

with open('courtside-web/lib/courtside_ovr_history.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("done")
