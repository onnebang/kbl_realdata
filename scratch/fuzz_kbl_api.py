import requests
import json
headers = {"Channel": "WEB", "TeamCode": "XX", "lang": "ko"}
# Since KBL API for all-time is probably something like /record/player/history -> /history/player etc.
endpoints = [
    "https://api.kbl.or.kr/record/player/history",
    "https://api.kbl.or.kr/player/history",
    "https://api.kbl.or.kr/player/record/history",
    "https://api.kbl.or.kr/player/all-time",
    "https://api.kbl.or.kr/stats/history",
    "https://api.kbl.or.kr/record/history",
    "https://api.kbl.or.kr/record/player/all-time"
]

for ep in endpoints:
    res = requests.get(ep, headers=headers)
    if res.status_code == 200:
        print("FOUND:", ep)
        print(res.text[:200])
