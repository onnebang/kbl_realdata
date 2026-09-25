"""
game_events(플레이바이플레이 + 승률 타임라인) 이관 - 28~29차에서 "별도 작업"으로 미뤄뒀던
부분. build_live_replay_demo.py의 build_one_game()이 딱 10개 데모 경기에만 돌리던 이벤트
루프 + 승률모델 추론 로직을 그대로 가져와서, pregame_training_table.json에 있는 전체
4182경기(4207경기 중 워밍업 구간 25경기 제외 - 그 경기들은 build_live_replay_demo.py도
똑같이 건너뜀)에 적용.

courtside 데모용 build_one_game()과 다른 점: combo/onoff/shotChart/pregameDetail 같은
UI용 부가 데이터는 안 만듦(그건 courtside 프로토타입 10경기 전용이라 여기선 불필요) -
이벤트 하나하나의 (쿼터/시각/액션/선수/팀/스코어/라인업/승률) 추출 + 모델 추론만.

실행 준비: migrate_to_supabase.py와 동일(DATABASE_URL, schema_supabase.sql 먼저 적용).
games/players/teams/action_codes가 이미 채워져 있어야 함(FK 참조) - 먼저
migrate_to_supabase.py부터 돌리고 이 스크립트를 돌릴 것.
"""
import argparse
import json
import math
import os
import sys

import joblib
import numpy as np

from cache_invalidate import revalidate

BASE = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE, "..", "raw", "games")
ANALYSIS_DIR = os.path.join(BASE, "..", "raw", "analysis")
MODEL_PATH = os.path.join(ANALYSIS_DIR, "live_winprob_model.joblib")

BATCH_SIZE = 5000

QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4", "X1", "X2", "X3", "X4", "EQ1", "EQ2", "EQ3", "EQ4"]
QUARTER_LEN_SEC = {"Q1": 600, "Q2": 600, "Q3": 600, "Q4": 600}  # 그 외(연장)는 기본 300
SCORE_CODES = {"201": 2, "205": 3, "203": 1, "207": 2}


def quarter_len(q):
    return QUARTER_LEN_SEC.get(q, 300)


def cumulative_elapsed(q, m, s):
    idx = QUARTER_ORDER.index(q) if q in QUARTER_ORDER else len(QUARTER_ORDER)
    prior = sum(quarter_len(qq) for qq in QUARTER_ORDER[:idx])
    remaining = m * 60 + s
    return prior + (quarter_len(q) - remaining)


def scaled_score_diff(score_diff, remaining_sec):
    return score_diff / math.sqrt(remaining_sec + 30)


def load_pregame_context():
    with open(os.path.join(ANALYSIS_DIR, "pregame_training_table.json"), encoding="utf-8") as f:
        rows = json.load(f)
    out = {}
    for r in rows:
        h_net, a_net = r["home"].get("home_netrtg"), r["away"].get("away_netrtg")
        h_syn, a_syn = r["home"].get("home_synergyOnOffRating"), r["away"].get("away_synergyOnOffRating")
        out[r["gmkey"]] = {
            "netrtgDiff": (h_net - a_net) if h_net is not None and a_net is not None else None,
            "synergyDiff": (h_syn - a_syn) if h_syn is not None and a_syn is not None else None,
        }
    return out


def build_roster_lookup(gmkey, home_tcode, away_tcode):
    pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
    with open(pstat_path, encoding="utf-8") as f:
        rows = json.load(f)
    name_to_pcode = {}
    starters = {home_tcode: [], away_tcode: []}
    for row in rows:
        p = row["player"]
        name_to_pcode[(p["tcode"], p["pname"])] = p["pcode"]
        if row.get("startFlag") == 1:
            starters[p["tcode"]].append(p["pcode"])
    return name_to_pcode, starters


def build_game_rows(gmkey, ctx):
    """build_live_replay_demo.py의 build_one_game() 이벤트 루프를 그대로 복제하되, 모델
    추론은 여기서 안 함(게임 하나당 predict_proba를 두 번씩 4182번 부르면 트리 앙상블
    모델의 "호출 1번당 고정 오버헤드"가 계산량보다 훨씬 커져서 게임당 ~2초, 전체 2시간+
    걸림 - 실측함). 대신 (rows, neutral_rows, meta_rows)만 반환하고, main()이 전체
    경기를 하나로 이어붙여서 predict_proba를 딱 한 번만 부름."""
    meta_path = os.path.join(GAMES_DIR, gmkey, "meta.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    g = meta["game"]
    home_tcode, away_tcode = g.get("tcodeH"), g.get("tcodeA")
    if not home_tcode or not away_tcode:
        return None

    text_path = os.path.join(GAMES_DIR, gmkey, "text-cast.json")
    if not os.path.exists(text_path):
        return None
    with open(text_path, encoding="utf-8") as f:
        events = json.load(f)
    if not events:
        return None

    pstat_path = os.path.join(GAMES_DIR, gmkey, "player-stat.json")
    if not os.path.exists(pstat_path):
        return None
    name_to_pcode, starters = build_roster_lookup(gmkey, home_tcode, away_tcode)
    lineup = {home_tcode: list(starters[home_tcode]), away_tcode: list(starters[away_tcode])}

    total_elapsed = cumulative_elapsed(events[-1]["q"], events[-1]["m"], events[-1]["s"])
    if total_elapsed <= 0:
        return None
    net = ctx["netrtgDiff"] if ctx["netrtgDiff"] is not None else 0.0
    syn = ctx["synergyDiff"] if ctx["synergyDiff"] is not None else 0.0

    def feat_row(score_diff, remaining_sec):
        return [score_diff, remaining_sec, scaled_score_diff(score_diff, remaining_sec), net, syn]

    rows = [feat_row(0, total_elapsed)]
    neutral_rows = [[0, total_elapsed, scaled_score_diff(0, total_elapsed), 0.0, 0.0]]
    meta_rows = [{
        "q": "PRE", "m": None, "s": None, "action": None, "pcode": None, "team": None,
        "homeScore": 0, "awayScore": 0,
        "homeLineup": list(lineup[home_tcode]), "awayLineup": list(lineup[away_tcode]),
    }]

    home_score, away_score = 0, 0
    for evt in events:
        code = evt.get("a")
        team = evt.get("t")
        player = evt.get("p")

        if code == "101" and team in lineup and player:
            pcode = name_to_pcode.get((team, player))
            if pcode and pcode not in lineup[team]:
                lineup[team].append(pcode)
        elif code == "102" and team in lineup and player:
            pcode = name_to_pcode.get((team, player))
            if pcode and pcode in lineup[team]:
                lineup[team].remove(pcode)

        if code in SCORE_CODES and team in (home_tcode, away_tcode):
            pts = SCORE_CODES[code]
            if team == home_tcode:
                home_score += pts
            else:
                away_score += pts

        elapsed = cumulative_elapsed(evt["q"], evt["m"], evt["s"])
        remaining = total_elapsed - elapsed
        score_diff = home_score - away_score
        rows.append(feat_row(score_diff, remaining))
        neutral_rows.append([score_diff, remaining, scaled_score_diff(score_diff, remaining), 0.0, 0.0])
        meta_rows.append({
            "q": evt["q"], "m": evt["m"], "s": evt["s"], "action": code or None,
            "pcode": name_to_pcode.get((team, player)) if player and team else None,
            "team": team or None,
            "homeScore": home_score, "awayScore": away_score,
            "homeLineup": list(lineup[home_tcode]), "awayLineup": list(lineup[away_tcode]),
        })

    return rows, neutral_rows, meta_rows


def assemble_events(gmkey, meta_rows, probs, probs_neutral):
    out = []
    for i, mr in enumerate(meta_rows):
        prob_home = float(probs[i])
        wpa_home = None if i == 0 else round(prob_home - float(probs[i - 1]), 4)
        out.append((
            gmkey, i, mr["q"], mr["m"], mr["s"], mr["action"], mr["pcode"], mr["team"],
            mr["homeScore"], mr["awayScore"], mr["homeLineup"], mr["awayLineup"],
            round(prob_home, 4), wpa_home, round(float(probs_neutral[i]), 4),
        ))
    return out


def get_conn():
    try:
        import psycopg2
    except ImportError:
        print("psycopg2가 없음 - `pip install psycopg2-binary` 먼저 실행하세요.", file=sys.stderr)
        sys.exit(1)
    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL 환경변수가 없음.", file=sys.stderr)
        sys.exit(1)
    return psycopg2.connect(url)


EVENT_COLS = ("quarter", "clock_min", "clock_sec", "action_code", "pcode", "tcode",
              "home_score", "away_score", "home_lineup", "away_lineup",
              "home_win_prob", "wpa_home", "objective_prob")


def load_events(cur, rows, replace=False):
    """replace=False(기본) - 지금까지의 동작 그대로 DO NOTHING. 전체 4182경기 재이관 시
    이미 넣은 행을 다시 쓰지 않아 훨씬 빠르고, 백필은 어차피 같은 값이라 무의미한 쓰기다.

    replace=True - Phase 1(라이브) 추가. 라이브 수집기가 경기 도중 넣어둔 값은 '잠정치'
    (진행중엔 최종 경기 길이를 몰라 remainingSec을 규정시간으로 추정하고, 라인업/pcode도
    아직 확정 박스스코어가 아님)이므로, 경기 종료 후 배치가 반드시 덮어써야 한다.
    DO NOTHING이면 그 잠정치가 영구히 남는다 - 그래서 종료 정산 경로(live_collector.py의
    reconcile_finished_game)만 이 플래그를 켠다."""
    from psycopg2.extras import execute_values
    conflict = "do nothing" if not replace else (
        "do update set " + ", ".join(f"{c}=excluded.{c}" for c in EVENT_COLS))
    for i in range(0, len(rows), BATCH_SIZE):
        chunk = rows[i:i + BATCH_SIZE]
        execute_values(cur, f"""
            insert into game_events (gmkey, event_order, quarter, clock_min, clock_sec,
                action_code, pcode, tcode, home_score, away_score, home_lineup, away_lineup,
                home_win_prob, wpa_home, objective_prob) values %s
            on conflict (gmkey, event_order) {conflict}
        """, chunk)


def scan_action_codes(gmkeys):
    """action_codes 시드(schema_supabase.sql의 ACTION_LABELS 32개)가 실제로는 전수가
    아니었음 - 600경기 표본만 봤을 때도 시드에 없는 "000" 코드가 발견됨(FK 위반으로
    실제 마이그레이션이 죽은 뒤 알게 됨). 표본을 믿는 대신 이번에 실제로 이관할 전체
    경기의 text-cast.json을 훑어서 진짜로 나오는 코드를 다 모음.

    DB 연결 없이 순수 파일 스캔만 하는 함수로 분리(원래는 커서를 받아서 여기서 바로
    조회+삽입까지 했는데, 4182개 파일을 읽는 동안(수십 초) DB 연결을 열어만 두고 아무
    쿼리도 안 보내다 보니 Supabase 풀러가 유휴 연결로 판단해 끊어버림 - 실제 Supabase
    프로젝트에 돌려보다 "SSL connection has been closed unexpectedly"로 발견함. 이제
    연결을 열기 *전에* 이 스캔부터 끝내고, 연결은 실제 조회/삽입 직전에만 염."""
    seen = set()
    for gk in gmkeys:
        path = os.path.join(GAMES_DIR, gk, "text-cast.json")
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            events = json.load(f)
        for e in events:
            c = e.get("a")
            if c:
                seen.add(c)
    return seen


def register_action_codes(cur, seen_codes):
    from psycopg2.extras import execute_values
    cur.execute("select code from action_codes")
    known = {r[0] for r in cur.fetchall()}
    unknown = sorted(seen_codes - known)
    if unknown:
        print(f"  시드에 없는 액션 코드 발견: {unknown} - 미확인 항목으로 등록", flush=True)
        execute_values(cur, "insert into action_codes (code, label) values %s on conflict do nothing",
                       [(c, f"미확인(코드 {c})") for c in unknown])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None, help="테스트용 - 앞에서부터 N경기만 이관")
    ap.add_argument("--gmkeys", default=None,
                    help="증분 모드(daily_batch용) - 콤마로 구분한 gmkey 목록만 이관. "
                         "pregame_training_table.json에 아직 없는 경기(어제 막 끝난 경기 - "
                         "테이블 재생성은 별도 무거운 작업)는 netrtg/synergy 컨텍스트를 중립(0)"
                         "으로 두고 이벤트/승률만 계산함.")
    ap.add_argument("--predict-chunk-games", type=int, default=500,
                     help="predict_proba를 몇 경기치씩 묶어서 부를지(전체를 한 번에 하면 "
                          "메모리를 너무 많이 씀 - 500경기치씩 나눠서 여러 번 호출)")
    ap.add_argument("--replace", action="store_true",
                    help="이미 있는 (gmkey,event_order) 행을 덮어씀(기본은 건너뜀). 라이브 "
                         "수집기가 넣어둔 잠정 이벤트를 경기 종료 후 공식 데이터로 정정하는 "
                         "경로(live_collector.reconcile_finished_game)가 사용.")
    ap.add_argument("--max-retries", type=int, default=5,
                     help="DB 연결이 끊기면 재연결해서 재시도할 최대 횟수(Session Pooler로 "
                          "오래 연결을 들고 있으면 가끔 끊김 - 실제로 겪음)")
    args = ap.parse_args()

    print("모델 로딩...", flush=True)
    model = joblib.load(MODEL_PATH)
    pregame_ctx = load_pregame_context()
    print(f"경기전 컨텍스트 있는 경기: {len(pregame_ctx)}개", flush=True)

    if args.gmkeys:
        # 증분 모드 - 지정한 경기만. pregame_ctx에 없어도 제외하지 않고(어제 경기는 테이블
        # 재생성 전이라 없는 게 정상) 중립 컨텍스트로 진행 - build_game_rows가 None을
        # 0.0으로 처리하는 기존 규칙 그대로.
        gmkeys = sorted(g.strip() for g in args.gmkeys.split(",") if g.strip())
        if not gmkeys:
            print("--gmkeys가 비어있음 - 할 일 없음.", flush=True)
            return
        for gk in gmkeys:
            pregame_ctx.setdefault(gk, {"netrtgDiff": None, "synergyDiff": None})
    else:
        gmkeys = sorted(pregame_ctx.keys())
    if args.limit:
        gmkeys = gmkeys[:args.limit]

    print("실제 등장하는 액션 코드 스캔 중(DB 연결 열기 전에 - 4182개 파일 읽는 동안 "
          "연결을 유휴 상태로 열어두면 Supabase 풀러가 끊어버림)...", flush=True)
    seen_codes = scan_action_codes(gmkeys)

    import time
    import psycopg2

    conn = get_conn()
    conn.autocommit = False
    cur = conn.cursor()

    def with_retry(op_name, fn):
        """fn(cur)을 실행하고, 연결이 죽어있으면(OperationalError/InterfaceError) 재연결
        후 재시도. Session Pooler로 오래 연결을 들고 있으면 실제로 가끔 끊김을 겪어서
        (SSL connection has been closed unexpectedly / server closed the connection
        unexpectedly - 4182경기 중 2000번째 부근에서 실제로 발생) 추가함. 이미 커밋된
        청크는 ON CONFLICT DO NOTHING이라 재시도가 곧 안전하게 이어서 하기임."""
        nonlocal conn, cur
        for attempt in range(1, args.max_retries + 1):
            try:
                return fn(cur)
            except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
                print(f"  [{op_name}] 연결 오류({e}) - 재연결 후 재시도 {attempt}/{args.max_retries}", flush=True)
                try:
                    conn.close()
                except Exception:
                    pass
                time.sleep(min(2 ** attempt, 20))
                conn = get_conn()
                conn.autocommit = False
                cur = conn.cursor()
        raise RuntimeError(f"{op_name} - {args.max_retries}회 재시도 후에도 실패")

    total_events = 0
    skipped = 0
    try:
        with_retry("액션코드 등록", lambda c: (register_action_codes(c, seen_codes), conn.commit()))

        # 게임을 predict-chunk-games개씩 묶어서: (1) 각 게임의 이벤트 루프를 먼저 다
        # 돌려 rows/neutral_rows/meta_rows를 모으고 (2) 묶음 전체를 한 번에 이어붙여
        # predict_proba를 딱 2번(실제/중립)만 불러 트리 앙상블의 호출당 오버헤드를
        # 회피 (3) 게임별로 결과를 다시 잘라서 DB에 적재.
        for chunk_start in range(0, len(gmkeys), args.predict_chunk_games):
            chunk_gmkeys = gmkeys[chunk_start:chunk_start + args.predict_chunk_games]
            built = []  # (gmkey, rows, neutral_rows, meta_rows)
            for gk in chunk_gmkeys:
                result = build_game_rows(gk, pregame_ctx[gk])
                if result is None:
                    skipped += 1
                    continue
                built.append((gk, *result))

            if not built:
                continue

            all_rows, all_neutral, offsets = [], [], []
            pos = 0
            for gk, rows, neutral_rows, meta_rows in built:
                all_rows.extend(rows)
                all_neutral.extend(neutral_rows)
                offsets.append(pos)
                pos += len(rows)

            X = np.array(all_rows, dtype=float)
            X_neutral = np.array(all_neutral, dtype=float)
            probs_all = model.predict_proba(X)[:, 1]
            probs_neutral_all = model.predict_proba(X_neutral)[:, 1]

            chunk_event_rows = []
            for idx, (gk, rows, neutral_rows, meta_rows) in enumerate(built):
                start = offsets[idx]
                end = start + len(rows)
                chunk_event_rows.extend(assemble_events(
                    gk, meta_rows, probs_all[start:end], probs_neutral_all[start:end]))

            def do_insert(c, rows=chunk_event_rows):
                load_events(c, rows, replace=args.replace)
                conn.commit()
            with_retry("이벤트 적재", do_insert)
            total_events += len(chunk_event_rows)

            done = min(chunk_start + args.predict_chunk_games, len(gmkeys))
            print(f"  {done}/{len(gmkeys)}경기 처리, 누적 이벤트 {total_events}건...", flush=True)

        print(f"완료 - {len(gmkeys)}경기 중 {skipped}경기 건너뜀(text-cast/player-stat 없음), "
              f"이벤트 {total_events}건 적재.")
        # 2026-09-25(revalidateTag 연동) - migrate_to_supabase.py와 같은 이유(경기 종료 직후
        # 정산 배치 커밋과 courtside-web 캐시 사이의 공백을 없앰).
        revalidate([f"game:{gm}" for gm in gmkeys] + ["batch:daily"])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
