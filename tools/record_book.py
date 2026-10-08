# -*- coding: utf-8 -*-
"""역대 기록(Record Book) - 팀·선수의 쿼터/경기 최다·최소 기록 TOP15 보관소(record_entries) 관리.

설계: docs/superpowers/specs/2026-10-08-record-book-design.md

- 공식 자료(player-stat / team-record / meta.teamrecords)로 만드는 보드는 이벤트에 의존하지 않는다.
- 이벤트(text-cast)로 만드는 보드(선수 쿼터, 팀 쿼터 리바·어시·스틸·블락)는 **검증 게이트**를 통과한 값만 후보가 된다:
  (1) 양 팀 이벤트 득점이 공식 쿼터 점수와 같다  (2) 그 선수/팀의 경기 전체 합계가 공식 합계와 같다.
  옛 경기(2006~09)는 이벤트가 중복·누락돼 공식과 어긋난다 - 김승현 2007-03-23 공식 11어시스트인데 이벤트는 15개.

사용:
    python record_book.py --rebuild --dry-run     # DB 없이 전체 계산, 요약만 출력
    python record_book.py --rebuild               # raw/games 전체 -> record_entries 교체(한 트랜잭션)
    python record_book.py --gmkeys S49G01N9       # 그 경기만 반영(멱등) - 경기 종료 정산이 호출
    python record_book.py --verify                # raw에서 다시 계산한 것과 테이블이 같은지 비교

DB 접속은 sync_upcoming_games.get_conn()과 같은 규약(tools/.env.supabase의 DATABASE_URL).
"""
import argparse
import collections
import json
import os
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
# raw 경로 - 별도 git 작업트리에서 개발·테스트할 때(raw/는 gitignore라 거기엔 없다) RECORD_BOOK_RAW로 메인 트리의 raw/games를 가리킨다.
RAW_GAMES = os.environ.get("RECORD_BOOK_RAW") or os.path.join(BASE, "..", "raw", "games")

ELIGIBLE_CATEGORIES = ("정규시즌", "플레이오프", "챔피언결정전")
REG_PERIODS = ("Q1", "Q2", "Q3", "Q4")
OT_PERIODS = ("X1", "X2", "X3", "X4")
KEEP_RANK = 15            # (board, bucket)마다 순위 <= 15(동률 포함)만 보관
MAX_ROWS = 20000          # --rebuild 안전장치: 이보다 많으면 정의 오류로 보고 중단
LOCK_KEY = 7340211        # pg_advisory_xact_lock - 증분 반영끼리(노트북/클라우드) 직렬화

PLAYER_METRICS = ("pts", "reb", "ast", "stl", "blk", "tpm", "to")
TEAM_EVENT_METRICS = ("reb", "ast", "stl", "blk")
TEAM_GAME_MAX_METRICS = ("fgm", "fgmiss", "tpm", "reb", "ast", "stl", "blk")

# 이벤트 코드 -> 종목 (lib/boxEvents.ts applyBoxEvent와 같은 정의, 팀 합계 3,864팀경기 대조로 확정).
PTS_BY_CODE = {"201": 2, "207": 2, "205": 3, "203": 1}
COUNT_CODES = {"reb": ("209", "210"), "ast": ("211",), "stl": ("212",), "blk": ("213",), "tpm": ("205",), "to": ("214",)}
PLAYER_OFFICIAL = {"pts": "score", "reb": "rb", "ast": "ast", "stl": "stl", "blk": "bs", "tpm": "threep", "to": "to"}
TEAM_OFFICIAL = {"pts": "score", "reb": "rb", "ast": "ast", "stl": "stl", "blk": "bs"}

ROW_COLUMNS = ("board", "bucket", "gmkey", "subject", "period", "value", "game_date", "game_start",
               "season_name", "category", "subject_name", "tcode", "opp_tcode", "is_ot")
PK_COLUMNS = ("board", "bucket", "gmkey", "subject", "period")


def log(msg):
    print(f"[record_book] {msg}", flush=True)


# ---------------------------------------------------------------------------
# raw 파일 -> 경기 dict
# ---------------------------------------------------------------------------

def parse_game(meta, player_stat, team_record, events):
    """공식 4종 JSON + 이벤트 -> 경기 dict. 대상 경기가 아니면 None."""
    g = meta["game"]
    if g.get("seasonCategoryName") not in ELIGIBLE_CATEGORIES or not g.get("isEnded"):
        return None
    d, s = str(g["gameDate"]), str(g.get("gameStart") or "")
    home, away = g["tcodeH"], g["tcodeA"]
    tr = meta.get("teamrecords") or {}
    quarters = {}
    for side, tc in (("home", home), ("away", away)):
        rec = tr.get(side) or {}
        quarters[tc] = {"q": [rec.get(f"scoreq{i}") for i in range(1, 5)], "ot": list(rec.get("scoreeq") or [])}
    return {
        "gmkey": g["gmkey"],
        "date": f"{d[:4]}-{d[4:6]}-{d[6:8]}",
        "start": f"{s[:2]}:{s[2:4]}" if len(s) >= 4 else "",
        "season": g.get("seasonName") or "",
        "category": g["seasonCategoryName"],
        "home": home,
        "away": away,
        "names": {home: g.get("tnameH") or home, away: g.get("tnameA") or away},
        "quarters": quarters,
        "has_ot": any(q["ot"] for q in quarters.values()),
        "players": [{"pcode": r["player"]["pcode"], "pname": r["player"]["pname"], "tcode": r["player"]["tcode"], "rec": r.get("records") or {}}
                    for r in player_stat],
        "teams": {t["tcode"]: t.get("records") or {} for t in team_record},
        "events": events,
    }


def load_game(gmkey, raw_dir=RAW_GAMES):
    """raw/games/<gmkey>/ 4종 파일을 읽어 경기 dict로. 파일이 없거나 깨졌거나 대상이 아니면 None."""
    d = os.path.join(raw_dir, gmkey)
    try:
        def read(name):
            with open(os.path.join(d, name), encoding="utf-8") as f:
                return json.load(f)
        return parse_game(read("meta.json"), read("player-stat.json"), read("team-record.json"), read("text-cast.json"))
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _row(g, board, bucket, subject, period, value, subject_name, tcode):
    return {
        "board": board, "bucket": bucket, "gmkey": g["gmkey"], "subject": subject, "period": period, "value": int(value),
        "game_date": g["date"], "game_start": g["start"], "season_name": g["season"], "category": g["category"],
        "subject_name": subject_name, "tcode": tcode, "opp_tcode": g["away"] if tcode == g["home"] else g["home"],
        "is_ot": g["has_ot"],
    }


# ---------------------------------------------------------------------------
# 후보 만들기 - 공식 자료
# ---------------------------------------------------------------------------

def official_candidates(g):
    """선수 경기 / 팀 경기 / 팀 쿼터 득점 보드. 이벤트를 쓰지 않아 검증 게이트가 필요 없다."""
    rows = []
    for p in g["players"]:
        for m in PLAYER_METRICS:
            v = p["rec"].get(PLAYER_OFFICIAL[m])
            if isinstance(v, int) and v > 0:
                rows.append(_row(g, f"pg.{m}.max", "G", p["pcode"], "", v, p["pname"], p["tcode"]))
    for tc in (g["home"], g["away"]):
        rec, name = g["teams"].get(tc) or {}, g["names"][tc]
        if isinstance(rec.get("score"), int):
            rows.append(_row(g, "tg.pts.max", "G", tc, "", rec["score"], name, tc))
            rows.append(_row(g, "tg.pts.min", "G", tc, "", rec["score"], name, tc))
        vals = {"fgm": rec.get("fgt"), "tpm": rec.get("threep"), "reb": rec.get("rb"), "ast": rec.get("ast"), "stl": rec.get("stl"), "blk": rec.get("bs")}
        if isinstance(rec.get("fgt"), int) and isinstance(rec.get("fgtA"), int):
            vals["fgmiss"] = rec["fgtA"] - rec["fgt"]
        for m in TEAM_GAME_MAX_METRICS:
            if isinstance(vals.get(m), int) and vals[m] > 0:
                rows.append(_row(g, f"tg.{m}.max", "G", tc, "", vals[m], name, tc))
        q = g["quarters"][tc]
        # 쿼터 점수 합(+연장)이 팀 최종 점수와 다르면 그 팀의 쿼터 보드는 건너뛴다 - 2009-01-21 S13G01N167은 연장 점수 배열이
        # 양 팀 똑같이 [6,9,13]으로 잘못 들어 있어(공식 팀 기록은 135-132) 합이 안 맞는다. 5,682경기 중 이 한 경기뿐이다.
        ot_sum = sum(v for v in q["ot"] if isinstance(v, int))
        if any(not isinstance(v, int) for v in q["q"]) or (isinstance(rec.get("score"), int) and sum(q["q"]) + ot_sum != rec["score"]):
            continue
        for i, v in enumerate(q["q"], 1):
            if v > 0:
                rows.append(_row(g, "tq.pts.max", f"Q{i}", tc, f"Q{i}", v, name, tc))
            rows.append(_row(g, "tq.pts.min", f"Q{i}", tc, f"Q{i}", v, name, tc))
        for k, v in enumerate(q["ot"], 1):
            if isinstance(v, int) and v > 0:       # 연장 최소 보드는 만들지 않는다(0점이 흔하다)
                rows.append(_row(g, "tq.pts.max", "OT", tc, f"X{k}", v, name, tc))
    return rows


# ---------------------------------------------------------------------------
# 후보 만들기 - 이벤트 + 검증 게이트
# ---------------------------------------------------------------------------

def player_index(g):
    """(pname, tcode) -> pcode. 같은 팀에 동명이인이 있으면 None(그 이름은 건너뛴다)."""
    idx = {}
    for p in g["players"]:
        k = (p["pname"], p["tcode"])
        idx[k] = None if k in idx else p["pcode"]
    return idx


def _bucket(period, ot_ok):
    if period in REG_PERIODS:
        return period
    return "OT" if (period in OT_PERIODS and ot_ok) else None


def event_candidates(g):
    """선수 쿼터 전 종목 + 팀 쿼터 리바·어시·스틸·블락. 게이트를 통과한 값만."""
    teams = (g["home"], g["away"])
    team_pts = collections.defaultdict(int)       # (tcode, period)
    p_cnt = collections.defaultdict(int)          # (name, tcode, period, metric)
    p_tot = collections.defaultdict(int)          # (name, tcode, metric)
    t_cnt = collections.defaultdict(int)          # (tcode, period, metric)
    t_tot = collections.defaultdict(int)          # (tcode, metric)
    labels = set()
    for e in g["events"]:
        a, q, tc, name = e.get("a"), e.get("q"), e.get("t"), e.get("p")
        if not (a and q and tc and name):         # 선수 귀속 이벤트만(팀 리바운드 218 등은 제외)
            continue
        labels.add(q)
        pts = PTS_BY_CODE.get(a, 0)
        if pts:
            team_pts[(tc, q)] += pts
            p_cnt[(name, tc, q, "pts")] += pts
            p_tot[(name, tc, "pts")] += pts
        for m, codes in COUNT_CODES.items():
            if a in codes:
                p_cnt[(name, tc, q, m)] += 1
                p_tot[(name, tc, m)] += 1
                if m in TEAM_EVENT_METRICS:
                    t_cnt[(tc, q, m)] += 1
                    t_tot[(tc, m)] += 1

    # 게이트 1 - 경기: Q1~Q4 이벤트 득점이 공식 쿼터 점수와 같고, 쿼터 합 + 연장 합이 팀 최종 점수와 같다.
    for tc in teams:
        q = g["quarters"][tc]
        if any(not isinstance(v, int) for v in q["q"]):
            return []
        if any(team_pts.get((tc, f"Q{i}"), 0) != want for i, want in enumerate(q["q"], 1)):
            return []
        final = (g["teams"].get(tc) or {}).get("score")
        if isinstance(final, int) and sum(q["q"]) + sum(v for v in q["ot"] if isinstance(v, int)) != final:
            return []
    # 연장은 따로 검증 - 라벨이 X1~X4이고 연장별 이벤트 득점이 공식 scoreeq와 같을 때만 OT 후보를 만든다.
    ot_ok = True
    for label in labels:
        if label in REG_PERIODS:
            continue
        if label not in OT_PERIODS:
            ot_ok = False
            continue
        k = int(label[1])
        for tc in teams:
            ot = g["quarters"][tc]["ot"]
            if k > len(ot) or not isinstance(ot[k - 1], int) or team_pts.get((tc, label), 0) != ot[k - 1]:
                ot_ok = False

    rows = []
    pidx = player_index(g)
    by_pcode = {p["pcode"]: p for p in g["players"]}
    # 게이트 2 - 항목: 경기 전체 이벤트 합계 == 공식 합계.
    for (name, tc, period, m), v in p_cnt.items():
        bucket = _bucket(period, ot_ok)
        pcode = pidx.get((name, tc))
        if v <= 0 or bucket is None or not pcode:
            continue
        p = by_pcode[pcode]
        if p_tot[(name, tc, m)] != p["rec"].get(PLAYER_OFFICIAL[m]):
            continue
        rows.append(_row(g, f"pq.{m}.max", bucket, pcode, period, v, p["pname"], tc))
    for (tc, period, m), v in t_cnt.items():
        bucket = _bucket(period, ot_ok)
        if v <= 0 or bucket is None:
            continue
        if t_tot[(tc, m)] != (g["teams"].get(tc) or {}).get(TEAM_OFFICIAL[m]):
            continue
        rows.append(_row(g, f"tq.{m}.max", bucket, tc, period, v, g["names"][tc], tc))
    return rows


def game_candidates(g):
    return official_candidates(g) + event_candidates(g)


# ---------------------------------------------------------------------------
# 순위 / 보관
# ---------------------------------------------------------------------------

def pk(r):
    return tuple(r[c] for c in PK_COLUMNS)


def rank_sorted(rows):
    """한 (board, bucket)의 행을 좋은 순으로 정렬하고 공동 순위(1224)를 붙여 [(rank, row)]로 돌려준다."""
    if not rows:
        return []
    sign = -1 if rows[0]["board"].endswith(".max") else 1
    ordered = sorted(rows, key=lambda r: (sign * r["value"], r["game_date"], r["game_start"], r["gmkey"], r["period"], r["subject"]))
    out, last, rank = [], None, 0
    for i, r in enumerate(ordered):
        if r["value"] != last:
            rank, last = i + 1, r["value"]
        out.append((rank, r))
    return out


def retain(rows, keep=KEEP_RANK):
    """(board, bucket)마다 순위 <= keep(동률 포함)인 행만."""
    groups = collections.defaultdict(list)
    for r in rows:
        groups[(r["board"], r["bucket"])].append(r)
    kept = []
    for rs in groups.values():
        kept.extend(r for rank, r in rank_sorted(rs) if rank <= keep)
    return kept


def all_quarters(rows):
    """'전체(1~4Q 묶음)' 보드 = Q1~Q4 항목의 합집합(연장 제외). 테이블에는 저장하지 않는다."""
    return [r for r in rows if r["bucket"] in REG_PERIODS]


class Collector:
    """전체 빌드용 스트리밍 수집기 - 보드·구간별로 쌓다가 커지면 순위 > keep을 잘라 메모리를 묶는다
    (부분 집합의 순위는 최종 순위보다 좋거나 같으므로 거기서 잘린 행은 최종에서도 잘린다)."""

    def __init__(self, keep=KEEP_RANK, prune_at=1000):
        self.keep, self.prune_at = keep, prune_at
        self.groups = collections.defaultdict(list)

    def add(self, rows):
        for r in rows:
            g = self.groups[(r["board"], r["bucket"])]
            g.append(r)
            if len(g) > self.prune_at:
                self.groups[(r["board"], r["bucket"])] = [x for rank, x in rank_sorted(g) if rank <= self.keep]

    def result(self):
        return retain([r for g in self.groups.values() for r in g], self.keep)


def build_all(raw_dir=RAW_GAMES, keep=KEEP_RANK, only=None):
    """raw/games 전체 -> (보관 행, 통계). only: gmkey 부분 집합(테스트용)."""
    col = Collector(keep)
    stats = {"games": 0, "event_games": 0, "candidates": 0}
    for gmkey in sorted(only if only is not None else os.listdir(raw_dir)):
        g = load_game(gmkey, raw_dir)
        if g is None:
            continue
        official, events = official_candidates(g), event_candidates(g)
        stats["games"] += 1
        stats["event_games"] += 1 if events else 0
        stats["candidates"] += len(official) + len(events)
        col.add(official)
        col.add(events)
    return col.result(), stats


# (Task 2가 이 아래에 저장소·반영·CLI를 이어 붙인다)
