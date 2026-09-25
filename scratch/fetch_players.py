import urllib.request
import json

req = urllib.request.Request(
    'https://api.kbl.or.kr/match/S49G14N4/player-stat', 
    headers={'Channel':'WEB', 'TeamCode':'XX', 'lang':'ko'}
)
res = urllib.request.urlopen(req)
data = json.loads(res.read().decode('utf-8'))

with open('scratch/fetch_players.txt', 'w', encoding='utf-8') as f:
    for p in data:
        player = p['player']
        f.write(f"{player.get('pcode', '')}\t{player.get('pname', '')}\t{player.get('tname', '')}\n")
