# -*- coding: utf-8 -*-
"""역대 기록(Record Book) 3단계 - 연속 기록: 연속 출장(gp)과 경기 간 연속 야투·3점·자유투 성공/실패.

설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md

raw/games 전체를 날짜·시작시각 순으로 훑는 상태기계다(정산이 순서 없이 와도 안 틀어지게 매번 전체를 다시 계산한다).
- 연속 출장(공식 방식, 2026-10-10 점프볼 보도 '이정현 699경기 연속 출전'을 그대로 재현): 정규시즌 경기에서 선수 명단(player-stat 행)에 올라 뛰면 +1, 명단에 올랐는데 한 분도
  못 뛰면 끊김, 명단에 없던 경기(부상·군 복무·이적 준비 등)는 건너뜀. 이적은 상관없고 플레이오프·챔프전은 세지도 끊지도 않는다.
- 보드 행 7개(`BOARD`): 연속 하나당 한 행. period = 'A:<시작 gmkey>'(지금 이어지는 중) / 'E:<시작 gmkey>'(끝남), gmkey = 연속의 마지막 경기.
- 로그(record_streak_log): 최근 LOG_KEEP_DAYS일 경기의 (선수, 종류)별 전·후 길이와 alive 표시 - 웹이 "이 경기 직전 연속 상태"를 읽는다.
- 한 경기 안 연속 슛 6개 보드는 여기가 아니라 record_book.single_shot_candidates(선수-경기 후보)다.
역사 자료(raw/games)가 충분히 있을 때만 갱신한다(`have_history`) - 클라우드 수집기처럼 오늘 경기뿐인 환경이 부분 자료로 테이블을 덮어쓰지 못하게.
"""
import collections
import datetime
import json
import os

import record_book as rb

KINDS = ("gp", "xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss")
BOARD = {
    "gp": "pg.streak_gp.max",
    "xfg_made": "pg.xfg_made.max", "xfg_miss": "pg.xfg_miss.max",
    "xtp_made": "pg.xtp_made.max", "xtp_miss": "pg.xtp_miss.max",
    "xft_made": "pg.xft_made.max", "xft_miss": "pg.xft_miss.max",
}
STREAK_BOARDS = rb.STREAK_BOARDS
MIN_ROW = 6               # 이보다 짧은 연속은 보드 행 후보가 아니다(보관 순위가 어차피 훨씬 높다)
LOG_KEEP_DAYS = 120       # 로그는 이 기간(최근 경기 날짜 기준)만
RAW_HISTORY_MIN = 5000    # raw/games에 이 수 이상의 경기 폴더가 있어야 전체 재계산을 한다
LOG_COLUMNS = rb.LOG_COLUMNS


def have_history(raw_dir=None):
    """전체 재계산을 할 만큼 raw 역사가 있는가(클라우드처럼 오늘 경기뿐이면 False)."""
    try:
        return len(os.listdir(raw_dir or rb.RAW_GAMES)) >= RAW_HISTORY_MIN
    except OSError:
        return False


def raw_order(raw_dir=None):
    """대상 경기(정규시즌·플레이오프·챔프전, 종료)의 gmkey를 (날짜, 시작시각, gmkey) 순으로."""
    raw_dir = raw_dir or rb.RAW_GAMES
    out = []
    for gmkey in os.listdir(raw_dir):
        try:
            with open(os.path.join(raw_dir, gmkey, "meta.json"), encoding="utf-8") as f:
                g = json.load(f)["game"]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if g.get("seasonCategoryName") not in rb.ELIGIBLE_CATEGORIES or not g.get("isEnded"):
            continue
        out.append((str(g.get("gameDate")), str(g.get("gameStart") or ""), gmkey))
    return [k for _, _, k in sorted(out)]


def iter_games(raw_dir=None):
    """raw 경기를 날짜순으로 하나씩(이벤트 포함 - 한꺼번에 메모리에 올리지 않는다)."""
    raw_dir = raw_dir or rb.RAW_GAMES
    for gmkey in raw_order(raw_dir):
        g = rb.load_game(gmkey, raw_dir)
        if g is not None:
            yield g


def _new_run():
    return {"len": 0, "start": -1, "end": -1, "tc": ""}


def compute(games, keep_days=LOG_KEEP_DAYS):
    """날짜순 경기 dict iterable(이벤트 포함) -> (보드 행, 로그 행). 행은 아직 보관 순위로 자르지 않았다. keep_days=None이면 로그를 자르지 않는다(검증 픽스처용)."""
    info = []                                        # 경기 번호 -> 가벼운 경기 정보
    names = {}
    gp = {}                                          # pcode -> {"len", "start", "last", "tc"} - 정규시즌 연속 출장
    runs = {}                                        # (pcode, kind) -> {"made": run, "miss": run}
    last_seen = {}                                   # pcode -> 마지막 출전 경기 번호(어느 종류의 경기든)
    rows, log = [], []
    latest_log = {}

    def add_log(lg, pcode, kind, before, after, start_n):
        row = {"gmkey": lg["gmkey"], "pcode": pcode, "kind": kind, "before_len": before, "after_len": after,
               "start_gmkey": info[start_n]["gmkey"], "game_date": lg["date"], "game_start": lg["start"], "alive": False}
        log.append(row)
        latest_log[(pcode, kind)] = row

    def emit(kind, pcode, run, alive):
        if run["len"] < MIN_ROW:
            return
        g = info[run["end"]]
        period = ("A:" if alive else "E:") + info[run["start"]]["gmkey"]
        rows.append(rb._row(g, BOARD[kind], "G", pcode, period, run["len"], names.get(pcode, pcode), run["tc"]))

    for n, g in enumerate(games):
        lg = {k: g[k] for k in ("gmkey", "date", "start", "season", "category", "home", "away", "names", "has_ot")}
        info.append(lg)
        by_pcode = {p["pcode"]: p for p in g["players"]}
        regular = g["category"] == "정규시즌"
        for p in g["players"]:
            names[p["pcode"]] = p["pname"]
            if rb.played_seconds(p["rec"]) > 0:
                last_seen[p["pcode"]] = n
        # --- 연속 출장 (정규시즌만): 명단에 올라 뛰면 +1, 명단에 올랐는데 못 뛰면 끊김, 명단에 없으면 그대로
        if regular:
            for p in g["players"]:
                pc, tc = p["pcode"], p["tcode"]
                st = gp.get(pc)
                if rb.played_seconds(p["rec"]) > 0:
                    before = st["len"] if st else 0
                    start = st["start"] if st else n
                    gp[pc] = {"len": before + 1, "start": start, "last": n, "tc": tc}
                    add_log(lg, pc, "gp", before, before + 1, start)
                elif st:
                    emit("gp", pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, False)
                    add_log(lg, pc, "gp", st["len"], 0, st["start"])
                    del gp[pc]
        # --- 경기 간 연속 슛
        ok, bad = rb.shot_sequences(g)
        for pcode, kinds in bad.items():                                  # 게이트 탈락: 그 종목 연속을 끊는다(모르는 구간을 이어 붙이지 않는다)
            for kind in kinds:
                st = runs.pop((pcode, kind), None)
                for res in ("made", "miss"):
                    if st and st[res]["len"] > 0:
                        add_log(lg, pcode, f"x{kind}_{res}", st[res]["len"], 0, st[res]["start"])
                        emit(f"x{kind}_{res}", pcode, st[res], False)
        for pcode, kinds in ok.items():
            tc = by_pcode[pcode]["tcode"]
            for kind, seq in kinds.items():
                if not seq:
                    continue
                st = runs.setdefault((pcode, kind), {"made": _new_run(), "miss": _new_run()})
                before = {res: st[res]["len"] for res in st}
                starts = {res: st[res]["start"] for res in st}
                for s in seq:
                    cur, oth = ("made", "miss") if s else ("miss", "made")
                    if st[oth]["len"] > 0:
                        emit(f"x{kind}_{oth}", pcode, st[oth], False)
                        st[oth] = _new_run()
                    if st[cur]["len"] == 0:
                        st[cur] = {"len": 1, "start": n, "end": n, "tc": tc}
                    else:
                        st[cur]["len"] += 1
                        st[cur]["end"] = n
                        st[cur]["tc"] = tc
                for res in ("made", "miss"):
                    after = st[res]["len"]
                    if before[res] or after:
                        add_log(lg, pcode, f"x{kind}_{res}", before[res], after, st[res]["start"] if after else starts[res])

    # --- 마무리: 아직 열려 있는 연속을 행으로(지금 이어지는 중이면 A:, 아니면 E:)
    last_date = info[-1]["date"] if info else ""
    cutoff = ""
    if keep_days is not None and last_date:
        cutoff = (datetime.date.fromisoformat(last_date) - datetime.timedelta(days=keep_days)).isoformat()
    for pc, st in gp.items():
        seen = last_seen.get(pc)
        alive = seen is not None and info[seen]["date"] >= cutoff       # 최근 120일 안에 뛰었으면 '지금 이어지는 중'(명단에 없던 경기는 끊지 않는다)
        emit("gp", pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, alive)
        if alive and (pc, "gp") in latest_log:
            latest_log[(pc, "gp")]["alive"] = True
    for (pc, kind), st in runs.items():
        seen = last_seen.get(pc)
        alive_p = seen is not None and info[seen]["date"] >= cutoff
        for res in ("made", "miss"):
            if st[res]["len"] > 0:
                emit(f"x{kind}_{res}", pc, st[res], alive_p)
                if alive_p and (pc, f"x{kind}_{res}") in latest_log:
                    latest_log[(pc, f"x{kind}_{res}")]["alive"] = True
    if cutoff:
        log = [r for r in log if r["game_date"] >= cutoff]
    return rows, log


def build(raw_dir=None, keep=rb.KEEP_RANK, games=None):
    """연속 보드 행(보관 순위로 자른 것)과 로그. games를 주면 raw 대신 그것으로(테스트)."""
    rows, log = compute(iter_games(raw_dir) if games is None else games)
    unique = {}
    for r in rows:                               # 한 경기 안에서 시작·끝난 같은 길이 이상의 연속이 여럿이면 PK가 같다 - 큰 쪽 하나만(upsert가 임의로 고르지 않게)
        k = rb.pk(r)
        if k not in unique or r["value"] > unique[k]["value"]:
            unique[k] = r
    return rb.retain(list(unique.values()), keep), log


def write(store, rows, log):
    """미리 계산한 연속 보드 7개와 로그로 통째로 교체한다(멱등). 호출부가 락과 트랜잭션을 잡는다."""
    store.replace_board_rows(STREAK_BOARDS, rows)
    store.replace_log(log)
    return {"rows": len(rows), "log": len(log)}


def refresh(store, raw_dir=None, keep=rb.KEEP_RANK, games=None):
    """계산 + 교체를 한 번에(테스트·스크립트용). 오래 걸리는 계산을 DB 연결을 연 채로 하지 않으려면 build()를 먼저 하고 write()만 연결 안에서 한다."""
    rows, log = build(raw_dir, keep, games)
    return write(store, rows, log)
