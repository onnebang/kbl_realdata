import json

new_records = [
  {
    "pcode": None,
    "name": "스코티 제임스",
    "season": "2026-2027",
    "team": "고양 소노",
    "position": "C/F",
    "OVR": 95,
    "OFF": 97,
    "DEF": 92,
    "archetype": "스페이싱 빅맨",
    "badges": { "finishing": 1, "shooting": 1, "playmaking": 0, "defense": 0 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "다리우스 베즐리",
    "season": "2026-2027",
    "team": "울산 현대모비스",
    "position": "F/C",
    "OVR": 94,
    "OFF": 92,
    "DEF": 96,
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
    "OVR": 91,
    "OFF": 90,
    "DEF": 92,
    "archetype": "정통 빅맨",
    "badges": { "finishing": 1, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "루이스 킹",
    "season": "2026-2027",
    "team": "부산 KCC",
    "position": "F",
    "OVR": 90,
    "OFF": 94,
    "DEF": 85,
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
    "OVR": 89,
    "OFF": 93,
    "DEF": 84,
    "archetype": "돌파형 가드",
    "badges": { "finishing": 1, "shooting": 0, "playmaking": 1, "defense": 0 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "트레이 포터",
    "season": "2026-2027",
    "team": "수원 KT",
    "position": "C",
    "OVR": 85,
    "OFF": 80,
    "DEF": 90,
    "archetype": "수비형 빅맨",
    "badges": { "finishing": 0, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  },
  {
    "pcode": None,
    "name": "제리 아바디아노",
    "season": "2026-2027",
    "team": "울산 현대모비스",
    "position": "G",
    "OVR": 78,
    "OFF": 72,
    "DEF": 84,
    "archetype": "수비형 가드",
    "badges": { "finishing": 0, "shooting": 0, "playmaking": 0, "defense": 1 },
    "projected": True
  }
]

with open('courtside-web/lib/courtside_ovr_history.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

data = [d for d in data if not (d.get('pcode') is None and d.get('name') in [r['name'] for r in new_records])]
data.extend(new_records)

with open('courtside-web/lib/courtside_ovr_history.json', 'w', encoding='utf-8') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

print("done")
