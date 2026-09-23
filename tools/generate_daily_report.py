"""
간단한 일일 HTML 리포트 (2026-08-24, 사용자 요청 - "일단 간단한 html 리포트로 진행해보자").
predict_upcoming_games.py가 만든 예측 + 최근 며칠 결과를 정적 HTML 한 장으로 렌더링.
외부 라이브러리/네트워크 없이 인라인 CSS만 씀 - 로컬에서 그냥 더블클릭으로 열어보는 용도.

daily_batch.py 맨 마지막에 붙여서 매일 자동 재생성됨. 예측 대상 경기가 없으면(오프시즌 등)
"예정된 경기 없음"만 조용히 보여줌 - 데이터 없다고 에러내지 않음.
"""
import datetime
import html
import json
import os

import fetch_kbl_data as fkd

BASE = os.path.dirname(os.path.abspath(__file__))
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
REPORTS_DIR = os.path.join(BASE, "..", "reports")
OUT_PATH = os.path.join(REPORTS_DIR, "daily_report.html")
RECENT_DAYS = 7

CSS = """
body { margin:0; background:#f6f1e7; color:#211d17; font-family:"Segoe UI","Malgun Gothic",sans-serif; line-height:1.6; }
.wrap { max-width:720px; margin:0 auto; padding:32px 20px 80px; }
h1 { font-size:22px; margin:0 0 4px; }
.sub { color:#6b6153; font-size:13px; margin:0 0 28px; }
h2 { font-size:16px; margin:32px 0 12px; padding-bottom:6px; border-bottom:2px solid rgba(33,29,23,0.12); }
.card { background:#fff; border:1px solid rgba(33,29,23,0.13); border-radius:10px; padding:14px 16px; margin-bottom:10px; }
.matchup { display:flex; justify-content:space-between; align-items:baseline; font-size:14.5px; font-weight:600; }
.meta { color:#6b6153; font-size:12px; margin-top:2px; }
.bar-row { display:flex; align-items:center; gap:8px; margin-top:10px; }
.bar-track { flex:1; height:10px; border-radius:6px; background:#efe8d9; overflow:hidden; display:flex; }
.bar-home { background:#c97124; height:100%; }
.bar-away { background:#2f5d4e; height:100%; }
.bar-label { font-family:monospace; font-size:11.5px; color:#6b6153; white-space:nowrap; }
.result-row { display:flex; justify-content:space-between; font-size:13.5px; padding:8px 0; border-bottom:1px solid rgba(33,29,23,0.08); }
.result-row:last-child { border-bottom:none; }
.winner { font-weight:700; }
.empty { color:#96897390; font-size:13.5px; padding:16px 0; }
.footer { margin-top:40px; padding-top:14px; border-top:1px solid rgba(33,29,23,0.1); color:#96897390; font-size:11.5px; font-family:monospace; }
"""


def esc(s):
    return html.escape(str(s)) if s is not None else ""


def load_predictions():
    path = os.path.join(ANALYSIS_DIR, "upcoming_predictions.json")
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def fetch_recent_results(days=RECENT_DAYS):
    today = datetime.date.today()
    past = today - datetime.timedelta(days=days)
    try:
        games = fkd.fetch_game_list(past.strftime("%Y%m%d"), today.strftime("%Y%m%d"))
    except Exception:
        return []
    ended = [g for g in games if g.get("isEnded") == 1
             and g.get("seasonCategory") in fkd.TRACKED_CATEGORIES]
    ended.sort(key=lambda g: (g["gameDate"], g["gmkey"]), reverse=True)
    return ended


def render_prediction_card(p):
    if p.get("homeWinProb") is None:
        return f"""<div class="card">
  <div class="matchup"><span>{esc(p['homeTname'])} vs {esc(p['awayTname'])}</span></div>
  <div class="meta">{esc(p['gameDate'])} {esc(p.get('stadium') or '')}</div>
  <div class="meta">{esc(p.get('note') or '예측 불가')}</div>
</div>"""
    home_pct = p["homeWinProb"] * 100
    away_pct = 100 - home_pct
    return f"""<div class="card">
  <div class="matchup"><span>{esc(p['homeTname'])} (홈)</span><span>{esc(p['awayTname'])} (원정)</span></div>
  <div class="meta">{esc(p['gameDate'])} {esc(p.get('gameStart') or '')} · {esc(p.get('stadium') or '')}</div>
  <div class="bar-row">
    <span class="bar-label">{home_pct:.0f}%</span>
    <div class="bar-track"><div class="bar-home" style="width:{home_pct:.1f}%"></div><div class="bar-away" style="width:{away_pct:.1f}%"></div></div>
    <span class="bar-label">{away_pct:.0f}%</span>
  </div>
</div>"""


def render_result_row(g):
    home_win = (g.get("scoreH") or 0) > (g.get("scoreA") or 0)
    home_cls = "winner" if home_win else ""
    away_cls = "" if home_win else "winner"
    return f"""<div class="result-row">
  <span>{esc(g['gameDate'])}</span>
  <span class="{home_cls}">{esc(g['tnameH'])} {esc(g.get('scoreH'))}</span>
  <span>:</span>
  <span class="{away_cls}">{esc(g.get('scoreA'))} {esc(g['tnameA'])}</span>
</div>"""


def main():
    predictions = load_predictions()
    recent = fetch_recent_results()

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    pred_html = "".join(render_prediction_card(p) for p in predictions) if predictions else \
        '<div class="empty">예정된 경기 없음.</div>'
    recent_html = "".join(render_result_row(g) for g in recent) if recent else \
        '<div class="empty">최근 경기 없음.</div>'

    doc = f"""<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"><title>KBL 일일 리포트</title>
<style>{CSS}</style></head><body><div class="wrap">
<h1>KBL 승률예측 일일 리포트</h1>
<p class="sub">생성 시각: {now_str}</p>

<h2>예정 경기 예측</h2>
{pred_html}

<h2>최근 {RECENT_DAYS}일 결과</h2>
{recent_html}

<div class="footer">daily_batch.py → generate_daily_report.py 자동 생성 · RandomForest 홀드아웃 정확도 64.3%</div>
</div></body></html>"""

    os.makedirs(REPORTS_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        f.write(doc)
    print(f"리포트 생성 완료 -> {OUT_PATH} (예측 {len(predictions)}건, 최근결과 {len(recent)}건)", flush=True)


if __name__ == "__main__":
    main()
