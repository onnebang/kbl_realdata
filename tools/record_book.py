# -*- coding: utf-8 -*-
"""역대 기록(Record Book) - 팀·선수의 쿼터/경기 최다·최소 기록 TOP15 보관소(record_entries) 관리.

설계: docs/superpowers/specs/2026-10-08-record-book-design.md
2단계(2026-10-10): docs/superpowers/specs/2026-10-10-record-book-phase2-design.md - 순간 기록 14개 보드(`moment_candidates`)

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
        "players": [{"pcode": r["player"]["pcode"], "pname": r["player"]["pname"], "tcode": r["player"]["tcode"], "rec": r.get("records") or {},
                     "starter": r.get("startFlag")}
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


def quarter_points(g):
    """(tcode, 쿼터) -> 선수 귀속 이벤트 득점."""
    out = collections.defaultdict(int)
    for e in g["events"]:
        a, q, tc, name = e.get("a"), e.get("q"), e.get("t"), e.get("p")
        if a in PTS_BY_CODE and q and tc and name:
            out[(tc, q)] += PTS_BY_CODE[a]
    return out


def quarters_match_official(g, team_pts=None):
    """게이트 1 - Q1~Q4 이벤트 득점이 공식 쿼터 점수와 같고, 쿼터 합 + 연장 합이 팀 최종 점수와 같다."""
    team_pts = quarter_points(g) if team_pts is None else team_pts
    for tc in (g["home"], g["away"]):
        q = g["quarters"][tc]
        if any(not isinstance(v, int) for v in q["q"]):
            return False
        if any(team_pts.get((tc, f"Q{i}"), 0) != want for i, want in enumerate(q["q"], 1)):
            return False
        final = (g["teams"].get(tc) or {}).get("score")
        if isinstance(final, int) and sum(q["q"]) + sum(v for v in q["ot"] if isinstance(v, int)) != final:
            return False
    return True


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
    if not quarters_match_official(g, team_pts):
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
    return official_candidates(g) + event_candidates(g) + moment_candidates(g)


# ---------------------------------------------------------------------------
# 2단계 후보 - 순간 기록 14개 보드 (설계 2026-10-10-record-book-phase2-design.md §3-§4)
# ---------------------------------------------------------------------------

PERIOD_LEN = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600, "X1": 300, "X2": 300, "X3": 300, "X4": 300}
PERIOD_START = {"Q1": 0, "Q2": 600, "Q3": 1200, "Q4": 1800, "X1": 2400, "X2": 2700, "X3": 3000, "X4": 3300}
CLOCK_TRUSTED_FROM = 31          # S31(2017-18)부터 중계 시각이 믿을 만하다 - 초 단위 보드(N초 득점·팀 런)는 이 시즌 이후만
BURST_WINDOWS = (10, 35, 60)     # N초 득점 창(초)
MINUTES_TOLERANCE = 3            # 재구성한 코트 시간과 공식 출전 시간의 허용 오차(초)
SUB_IN, SUB_OUT = "101", "102"
FOUL_CODES = ("215", "216")      # 개인 파울 - 합이 공식 foul과 96% 일치(2026-10-10 실측)
CAT_ORDER = ("pts", "reb", "ast", "stl", "blk")
CAT_CODES = {"reb": ("209", "210"), "ast": ("211",), "stl": ("212",), "blk": ("213",)}
CAT_OFFICIAL = {"pts": "score", "reb": "rb", "ast": "ast", "stl": "stl", "blk": "bs"}


def season_number(gmkey):
    """'S49G01N9' -> 49(시즌 번호). 못 읽으면 0."""
    head = gmkey.split("G", 1)[0]
    return int(head[1:]) if head[1:].isdigit() else 0


def event_time(e):
    """이벤트의 경기 시작 후 초(쿼터 시작 오프셋 + 쿼터 안 경과). 쿼터나 시각을 모르면 None."""
    q, m, s = e.get("q"), e.get("m"), e.get("s")
    if q not in PERIOD_LEN or not isinstance(m, int) or not isinstance(s, int):
        return None
    return PERIOD_START[q] + PERIOD_LEN[q] - (m * 60 + s)


def ordered_events(g):
    """이벤트를 n 순서로(없으면 입력 순서 그대로 - 안정 정렬)."""
    return sorted(g["events"], key=lambda e: e.get("n", 0))


def played_seconds(rec):
    return (rec.get("playMin") or 0) * 60 + (rec.get("playSec") or 0)


def official_moment_candidates(g):
    """점수차·벤치 득점·무득점 리바/어시·클럽(트리플더블·쿼드러플더블·5x5). 공식 기록만 쓰므로 이벤트 게이트가 없다."""
    rows = []
    h, a = g["home"], g["away"]
    hs, as_ = (g["teams"].get(h) or {}).get("score"), (g["teams"].get(a) or {}).get("score")
    if isinstance(hs, int) and isinstance(as_, int) and hs != as_:
        win = h if hs > as_ else a
        rows.append(_row(g, "tg.margin.max", "G", win, "", abs(hs - as_), g["names"][win], win))
    for p in g["players"]:
        rec = p["rec"]
        cats = [rec.get(CAT_OFFICIAL[c]) for c in CAT_ORDER]
        if played_seconds(rec) <= 0 or not all(isinstance(v, int) for v in cats):
            continue
        score, reb, ast = cats[0], cats[1], cats[2]
        found = []
        if p.get("starter") == 0 and score > 0:
            found.append(("pg.benchpts.max", score))
        if score == 0 and reb > 0:
            found.append(("pg.nopts_reb.max", reb))
        if score == 0 and ast > 0:
            found.append(("pg.nopts_ast.max", ast))
        n10 = sum(1 for v in cats if v >= 10)
        if n10 >= 3:
            found.append(("pg.club_td.max", 1))
        if n10 >= 4:
            found.append(("pg.club_qd.max", 1))
        if all(v >= 5 for v in cats):
            found.append(("pg.club_x5.max", 1))
        rows += [_row(g, board, "G", p["pcode"], "", v, p["pname"], p["tcode"]) for board, v in found]
    return rows


def moment_candidates(g):
    """2단계 보드 전부 - 공식 보드는 늘, 이벤트 보드는 게이트 1을 통과한 경기만."""
    return official_moment_candidates(g)


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
        official, events, moments = official_candidates(g), event_candidates(g), moment_candidates(g)
        stats["games"] += 1
        stats["event_games"] += 1 if events else 0
        stats["candidates"] += len(official) + len(events) + len(moments)
        col.add(official)
        col.add(events)
        col.add(moments)
    return col.result(), stats


# ---------------------------------------------------------------------------
# 저장소 - MemoryStore(테스트) / PgStore(운영)
# ---------------------------------------------------------------------------

class MemoryStore:
    def __init__(self, rows=()):
        self._rows = {pk(r): dict(r) for r in rows}

    def all_rows(self):
        return [dict(r) for r in self._rows.values()]

    def replace_all(self, rows):
        self._rows = {pk(r): dict(r) for r in rows}

    def delete_game(self, gmkey):
        gone = [k for k, r in self._rows.items() if r["gmkey"] == gmkey]
        boards = {(self._rows[k]["board"], self._rows[k]["bucket"]) for k in gone}
        for k in gone:
            del self._rows[k]
        return boards

    def upsert(self, rows):
        for r in rows:
            self._rows[pk(r)] = dict(r)

    def board_rows(self, board, bucket):
        return [dict(r) for r in self._rows.values() if r["board"] == board and r["bucket"] == bucket]

    def delete_rows(self, rows):
        for r in rows:
            self._rows.pop(pk(r), None)


class PgStore:
    """psycopg2 커서 하나로 같은 인터페이스. 트랜잭션은 호출부(commit/rollback)가 관리한다."""

    _COLS = ", ".join(ROW_COLUMNS)

    def __init__(self, cur):
        self.cur = cur

    def lock(self):
        self.cur.execute("select pg_advisory_xact_lock(%s)", (LOCK_KEY,))

    def _fetch(self, sql, params=()):
        self.cur.execute(sql, params)
        return [dict(zip(ROW_COLUMNS, r)) for r in self.cur.fetchall()]

    def all_rows(self):
        rows = self._fetch(f"select {self._COLS} from record_entries")
        for r in rows:
            r["game_date"] = r["game_date"].isoformat() if hasattr(r["game_date"], "isoformat") else str(r["game_date"])
        return rows

    def replace_all(self, rows):
        self.cur.execute("delete from record_entries")
        self.upsert(rows)

    def delete_game(self, gmkey):
        self.cur.execute("delete from record_entries where gmkey = %s returning board, bucket", (gmkey,))
        return {(b, k) for b, k in self.cur.fetchall()}

    def upsert(self, rows):
        rows = list({pk(r): r for r in rows}.values())     # 같은 키가 한 문장에 두 번 있으면 ON CONFLICT DO UPDATE가 실패한다
        if not rows:
            return
        from psycopg2.extras import execute_values
        updates = ", ".join(f"{c} = excluded.{c}" for c in ROW_COLUMNS if c not in PK_COLUMNS)
        execute_values(
            self.cur,
            f"insert into record_entries ({self._COLS}) values %s on conflict ({', '.join(PK_COLUMNS)}) do update set {updates}",
            [tuple(r[c] for c in ROW_COLUMNS) for r in rows],
            page_size=500,
        )

    def board_rows(self, board, bucket):
        rows = self._fetch(f"select {self._COLS} from record_entries where board = %s and bucket = %s", (board, bucket))
        for r in rows:
            r["game_date"] = r["game_date"].isoformat() if hasattr(r["game_date"], "isoformat") else str(r["game_date"])
        return rows

    def delete_rows(self, rows):
        for r in rows:
            self.cur.execute("delete from record_entries where board = %s and bucket = %s and gmkey = %s and subject = %s and period = %s", pk(r))


def apply_game(store, gmkey, candidates, keep=KEEP_RANK):
    """한 경기를 반영한다(멱등): 그 경기 기존 행 삭제 -> 후보 삽입 -> 영향받은 보드·구간의 순위 > keep 삭제."""
    affected = set(store.delete_game(gmkey))
    store.upsert(candidates)
    affected |= {(r["board"], r["bucket"]) for r in candidates}
    pruned = 0
    for board, bucket in sorted(affected):
        drop = [r for rank, r in rank_sorted(store.board_rows(board, bucket)) if rank > keep]
        store.delete_rows(drop)
        pruned += len(drop)
    return {"candidates": len(candidates), "pruned": pruned, "boards": len(affected)}


def diff_rows(expected, actual):
    """--verify: 두 행 집합을 PK + value로 비교 -> (없는 것, 남는 것, 값이 다른 것)."""
    e, a = {pk(r): r["value"] for r in expected}, {pk(r): r["value"] for r in actual}
    missing = sorted(set(e) - set(a))
    extra = sorted(set(a) - set(e))
    changed = sorted(k for k in set(e) & set(a) if e[k] != a[k])
    return missing, extra, changed


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _summary(rows):
    by = collections.Counter((r["board"], r["bucket"]) for r in rows)
    log(f"보관 행 {len(rows)}개 / 보드·구간 {len(by)}개 (최대 {max(by.values()) if by else 0}행)")


def _revalidate():
    try:
        from cache_invalidate import revalidate
        revalidate(["records"])
    except Exception as e:  # noqa: BLE001 - 캐시 무효화는 best-effort
        log(f"캐시 무효화 건너뜀: {e}")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rebuild", action="store_true", help="raw/games 전체로 record_entries 교체")
    ap.add_argument("--gmkeys", help="이 경기들만 반영(콤마 구분, 멱등)")
    ap.add_argument("--verify", action="store_true", help="raw에서 다시 계산한 것과 테이블 비교")
    ap.add_argument("--dry-run", action="store_true", help="--rebuild: DB를 건드리지 않고 계산만")
    ap.add_argument("--dump", help="--rebuild --dry-run: 보관 행을 JSON으로 저장할 경로")
    ap.add_argument("--keep", type=int, default=KEEP_RANK, help=f"보드·구간별 보관 순위 (기본 {KEEP_RANK})")
    args = ap.parse_args(argv)
    if not (args.rebuild or args.gmkeys or args.verify):
        ap.error("--rebuild, --gmkeys, --verify 중 하나가 필요하다")

    if args.rebuild or args.verify:
        rows, stats = build_all(keep=args.keep)
        log(f"경기 {stats['games']}개(이벤트 검증 통과 {stats['event_games']}개), 후보 {stats['candidates']}개")
        _summary(rows)
        if len(rows) > MAX_ROWS:
            log(f"!!! 보관 행이 {MAX_ROWS}개를 넘는다 - 정의 오류로 보고 중단")
            return 1
        if args.dump:
            with open(args.dump, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False)
            log(f"저장: {args.dump}")
        if args.dry_run:
            return 0

    from sync_upcoming_games import get_conn
    conn = get_conn()
    try:
        cur = conn.cursor()
        store = PgStore(cur)
        if args.rebuild:
            store.lock()
            store.replace_all(rows)
            conn.commit()
            log(f"교체 완료: {len(rows)}행")
            _revalidate()
        elif args.verify:
            missing, extra, changed = diff_rows(rows, store.all_rows())
            log(f"검증: 없는 행 {len(missing)} / 남는 행 {len(extra)} / 값이 다른 행 {len(changed)}")
            for label, ks in (("없음", missing), ("남음", extra), ("다름", changed)):
                for k in ks[:10]:
                    log(f"  {label}: {k}")
            return 0 if not (missing or extra or changed) else 1
        else:
            failed = 0
            for gmkey in [x.strip() for x in args.gmkeys.split(",") if x.strip()]:
                g = load_game(gmkey)
                if g is None:
                    log(f"{gmkey}: raw 파일이 없거나 대상 경기가 아니라 건너뜀")
                    failed += 1
                    continue
                store.lock()
                res = apply_game(store, gmkey, game_candidates(g))
                conn.commit()
                log(f"{gmkey}: {res}")
            _revalidate()
            return 1 if failed else 0
        return 0
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
