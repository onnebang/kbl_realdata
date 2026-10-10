# -*- coding: utf-8 -*-
"""역대 기록(Record Book) 3단계 - 연속 기록: 연속 출장(gp)과 경기 간 연속 야투·3점·자유투 성공/실패.

설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md

raw/games 전체를 날짜·시작시각 순으로 훑는 상태기계다(정산이 순서 없이 와도 안 틀어지게 매번 전체를 다시 계산한다).
- 연속 출장(공식 방식, 2026-10-10 점프볼 보도 '이정현 699경기 연속 출전'을 그대로 재현): 정규시즌 경기에서 선수 명단(player-stat 행)에 올라 뛰면 +1, 명단에 올랐는데 한 분도
  못 뛰면 끊김, 명단에 없던 경기(부상·군 복무·이적 준비 등)는 건너뜀. 이적은 상관없고 플레이오프·챔프전은 세지도 끊지도 않는다.
- 선수 연속 경기 6종(4단계 A, 설계 `2026-10-11-record-book-phase4a-design.md`): 연속 출장과 같은 틀에 조건만 얹는다(`GAME_COND` - 득점 10+/20+·더블더블·리바운드 10+·3점슛 1+·어시스트 5+).
- 팀 연승·연패(`tw`/`tl`): 정규시즌 시즌 안에서 이어진 연속 승리/패배(공식 최종 점수, 시즌이 바뀌면 리셋). 로그의 pcode 칸에 팀 코드를 넣는다.
- 보드 행(`BOARD`): 연속 하나당 한 행. period = 'A:<시작 gmkey>'(지금 이어지는 중) / 'E:<시작 gmkey>'(끝남), gmkey = 연속의 마지막 경기.
- 로그(record_streak_log): 최근 LOG_KEEP_DAYS일 경기의 (선수, 종류)별 전·후 길이와 alive 표시 - 웹이 "이 경기 직전 연속 상태"를 읽는다.
- 한 경기 안 연속 슛 6개 보드는 여기가 아니라 record_book.single_shot_candidates(선수-경기 후보)다.
역사 자료(raw/games)가 충분히 있을 때만 갱신한다(`have_history`) - 클라우드 수집기처럼 오늘 경기뿐인 환경이 부분 자료로 테이블을 덮어쓰지 못하게.
"""
import collections
import datetime
import json
import os

import record_book as rb

def _ge(key, n):
    return lambda r: (r.get(key) or 0) >= n


def _double_double(r):
    """득점·리바운드·어시스트·스틸·블록 중 2개 이상이 10 이상(2단계 클럽과 같은 정의)."""
    return sum(1 for k in ("score", "rb", "ast", "stl", "bs") if (r.get(k) or 0) >= 10) >= 2


# 정규시즌 '명단 기준' 연속 경기 종류 -> 조건(공식 박스 records). 뛰었고(출전 시간 > 0) 조건을 채우면 +1, 명단에 올랐는데 못 뛰었거나 조건 미달이면 끊김, 명단에 없던 경기는 건너뜀.
# gp(연속 출장)는 조건이 없고 뛰기만 하면 된다.
GAME_COND = {
    "gp": lambda r: True,
    "cg_pts10": _ge("score", 10), "cg_pts20": _ge("score", 20), "cg_dd": _double_double,
    "cg_reb10": _ge("rb", 10), "cg_tpm1": _ge("threep", 1), "cg_ast5": _ge("ast", 5),
}
TEAM_KINDS = ("tw", "tl")      # 팀 시즌 내 연승 / 연패 - 로그의 pcode 칸에 팀 코드를 넣는다(선수 코드는 6자리 숫자, 팀 코드는 2자리라 겹치지 않는다)
KINDS = tuple(GAME_COND) + ("xfg_made", "xfg_miss", "xtp_made", "xtp_miss", "xft_made", "xft_miss") + TEAM_KINDS
BOARD = {
    "gp": "pg.streak_gp.max",
    "xfg_made": "pg.xfg_made.max", "xfg_miss": "pg.xfg_miss.max",
    "xtp_made": "pg.xtp_made.max", "xtp_miss": "pg.xtp_miss.max",
    "xft_made": "pg.xft_made.max", "xft_miss": "pg.xft_miss.max",
    "cg_pts10": "pg.cg_pts10.max", "cg_pts20": "pg.cg_pts20.max", "cg_dd": "pg.cg_dd.max",
    "cg_reb10": "pg.cg_reb10.max", "cg_tpm1": "pg.cg_tpm1.max", "cg_ast5": "pg.cg_ast5.max",
    "tw": "tg.win_streak.max", "tl": "tg.loss_streak.max",
}
STREAK_BOARDS = rb.STREAK_BOARDS
MIN_ROW = 6               # 이보다 짧은 연속은 보드 행 후보가 아니다(보관 순위가 어차피 훨씬 높다)
MIN_ROW_KIND = {**{k: 8 for k in GAME_COND if k != "gp"}, "tw": 6, "tl": 6}      # 선수 연속 경기 종류는 더 길어야 후보(10위 값이 15~55), 팀 연승·연패는 10위 값이 12
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
    game_runs = {k: {} for k in GAME_COND}           # 종류 -> pcode -> {"len", "start", "last", "tc"} - 정규시즌 명단 기준 연속(연속 출장 포함)
    team = {}                                        # tcode -> {"season", "tw": run, "tl": run, "last": 경기 번호} - 정규시즌 시즌 내 연승·연패
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
        if run["len"] < MIN_ROW_KIND.get(kind, MIN_ROW):
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
        # --- 연속 출장 + 연속 경기 6종 (정규시즌만): 명단에 올라 뛰고 조건을 채우면 +1, 명단에 올랐는데 못 뛰었거나 조건 미달이면 끊김, 명단에 없으면 그대로
        if regular:
            for p in g["players"]:
                pc, tc = p["pcode"], p["tcode"]
                played = rb.played_seconds(p["rec"]) > 0
                for kind, cond in GAME_COND.items():
                    runs_k = game_runs[kind]
                    st = runs_k.get(pc)
                    if played and cond(p["rec"]):
                        before = st["len"] if st else 0
                        start = st["start"] if st else n
                        runs_k[pc] = {"len": before + 1, "start": start, "last": n, "tc": tc}
                        add_log(lg, pc, kind, before, before + 1, start)
                    elif st:
                        emit(kind, pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, False)
                        add_log(lg, pc, kind, st["len"], 0, st["start"])
                        del runs_k[pc]
            # --- 팀 연승·연패: 공식 최종 점수로 승패가 갈린 정규시즌 경기, 시즌이 바뀌면 처음부터
            hs, as_ = (g["teams"].get(g["home"]) or {}).get("score"), (g["teams"].get(g["away"]) or {}).get("score")
            if isinstance(hs, int) and isinstance(as_, int) and hs != as_:
                for tc, won in ((g["home"], hs > as_), (g["away"], as_ > hs)):
                    names[tc] = g["names"].get(tc, tc)
                    st = team.get(tc)
                    if st and st["season"] != g["season"]:
                        for kind in TEAM_KINDS:
                            if st[kind]["len"] > 0:
                                emit(kind, tc, st[kind], False)
                        st = None
                    if st is None:
                        st = team[tc] = {"season": g["season"], "tw": _new_run(), "tl": _new_run(), "last": n}
                    cur_k, oth_k = ("tw", "tl") if won else ("tl", "tw")
                    if st[oth_k]["len"] > 0:
                        add_log(lg, tc, oth_k, st[oth_k]["len"], 0, st[oth_k]["start"])
                        emit(oth_k, tc, st[oth_k], False)
                        st[oth_k] = _new_run()
                    before = st[cur_k]["len"]
                    st[cur_k] = {"len": before + 1, "start": st[cur_k]["start"] if before else n, "end": n, "tc": tc}
                    st["last"] = n
                    add_log(lg, tc, cur_k, before, before + 1, st[cur_k]["start"])
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
    for kind, runs_k in game_runs.items():
        for pc, st in runs_k.items():
            seen = last_seen.get(pc)
            alive = seen is not None and info[seen]["date"] >= cutoff   # 최근 120일 안에 뛰었으면 '지금 이어지는 중'(명단에 없던 경기는 끊지 않는다)
            emit(kind, pc, {"len": st["len"], "start": st["start"], "end": st["last"], "tc": st["tc"]}, alive)
            if alive and (pc, kind) in latest_log:
                latest_log[(pc, kind)]["alive"] = True
    for tc, st in team.items():
        alive = info[st["last"]]["date"] >= cutoff
        for kind in TEAM_KINDS:
            if st[kind]["len"] > 0:
                emit(kind, tc, st[kind], alive)
                if alive and (tc, kind) in latest_log:
                    latest_log[(tc, kind)]["alive"] = True
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
