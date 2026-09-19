import re
import urllib.parse
with open('scratch/kbl_main.js', 'r', encoding='utf-8') as f:
    text = f.read()
matches = re.findall(r'\"(/[^\"\s]+)\"', text)
endpoints = [m for m in matches if 'player' in m and 'stat' in m or 'history' in m or 'rank' in m or 'career' in m]
print(list(set(endpoints)))
