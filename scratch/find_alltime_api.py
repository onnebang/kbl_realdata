import requests
headers = {"Channel": "WEB", "TeamCode": "XX", "lang": "ko"}
# Try some endpoints
endpoints = [
    "https://api.kbl.or.kr/player/rank/history",
    "https://api.kbl.or.kr/player/history-rank",
    "https://api.kbl.or.kr/stats/player/career",
    "https://api.kbl.or.kr/stats/player/total",
    "https://api.kbl.or.kr/stats/history/player",
    "https://api.kbl.or.kr/history/player",
    "https://api.kbl.or.kr/player/career",
    "https://api.kbl.or.kr/rank/player/career"
]

for ep in endpoints:
    res = requests.get(ep, headers=headers)
    print(ep, res.status_code)
