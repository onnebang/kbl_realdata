import urllib.request
import json
import urllib.parse


def fetch_namu(title):
    url = f"https://namu.wiki/raw/{urllib.parse.quote(title)}"
    req = urllib.request.Request(
        url,
        headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        }
    )
    try:
        resp = urllib.request.urlopen(req)
        text = resp.read().decode('utf-8')
        with open(f"scratch/{title.replace(':', '_').replace('/', '_')}.txt", "w", encoding="utf-8") as f:
            f.write(text)
        print(f"[{title}] SUCCESS!")
    except Exception as e:
        print(f"[{title}] FAILED: {e}")

fetch_namu("KBL/기록")
fetch_namu("틀:KBL 역대 개인 통산 득점 순위")
fetch_namu("틀:KBL 통산 득점 순위")
fetch_namu("틀:KBL 역대 개인 통산 리바운드 순위")
fetch_namu("틀:KBL 역대 개인 통산 어시스트 순위")
