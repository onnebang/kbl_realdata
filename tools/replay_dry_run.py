"""
라이브 수집기 드라이런 하네스 (Phase 1의 실질적 산출물, 2026-09-02).

10월 개막 전에 "예정 -> 진행중 -> 종료"의 전 구간이 실제로 동작하는지 증명하기 위해,
이미 끝난 진짜 경기 하나를 골라 그 문자중계를 live_collector.py의 **바로 그 코드 경로로**
다시 흘려보낸다. 새 시뮬레이터를 만드는 게 아니라 live_collector의 ReplaySource /
GameIngestor / poll_cycle / reconcile_finished_game을 그대로 호출한다 - 드라이런이 라이브
경로를 증명하려면 같은 코드를 타야 의미가 있다.

만드는 것(전부 합성, 반드시 지워짐):
  games              DRYRUN-<source> 1행 (같은 팀, 날짜는 오늘, 스코어 NULL, is_ended=false)
  pregame_features   source 행을 gmkey만 바꿔 복사(승률 컨텍스트가 현실적이어야 함)
  game_events        리플레이가 적재
  game_team_stats / game_player_stats / shot_log
                     '경기 종료 정산이 만들어낼 공식 데이터'를 흉내내기 위해 종료 시점에
                     source에서 복사(3막 전체가 제대로 그려지는지 보려면 박스스코어가 필요).

절대 하지 않는 것:
  - 합성 gmkey를 정산 배치에 넘기지 않는다(live_collector.SYNTHETIC_PREFIX 가드).
  - 진짜 source 경기의 데이터를 건드리지 않는다. **기본값으로 정산 배치를 진짜 source에
    대해 돌리지 않는다**(--reconcile-source로 명시해야 함) - 그 경로는 fetch_one_game(
    force=True)로 raw/games/<source>/*.json 5개를 오늘 응답으로 되돌릴 수 없게 덮어쓰고,
    이관 스크립트가 진짜 games 행에 UPSERT한다. 켜더라도 raw를 먼저 백업하고 끝나면
    복원하며, 전/후 지문을 비교해 불변을 확인한다.
  - 끝나고 합성 행을 남기지 않는다(--keep을 명시하지 않는 한 자동 정리 + 재조회로 확인).
    정리는 **try/finally 안**에 있다 - 재생이나 검증 도중 예외가 나도 합성 행이 프로덕션
    DB에 남지 않는다(예전엔 성공 경로 끝에만 있어서 예외 한 번에 그대로 남았다).

사용법:
  python replay_dry_run.py --setup-only                 # 예정 상태 행만 만들고 종료(사이트 확인)
  python replay_dry_run.py --reuse --speed 1 --stop-after 240
                                                        # 실시간 배속으로 4분치만 재생(진행중 확인)
  python replay_dry_run.py --reuse --speed 60 --start-elapsed 240
                                                        # 이어서 빨리 감기 -> 종료까지
  python replay_dry_run.py --verify-only                # 검증만(멱등성/승률대조/불량폴링)
  python replay_dry_run.py --cleanup                    # 합성 행 삭제 + 삭제 확인
  python replay_dry_run.py                              # 전 과정 한 번에(생성->재생->검증->정리)
  python replay_dry_run.py --reconcile-source           # + 진짜 정산 경로까지 검증(백업/복원 포함)
"""
import argparse
import json
import os
import shutil
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
if BASE not in sys.path:
    sys.path.insert(0, BASE)

import live_collector as lc          # noqa: E402
import migrate_game_events_to_supabase as mge  # noqa: E402

DEFAULT_SOURCE = "S47G03N16"

# 합성 행이 들어갈 수 있는 테이블 전부 - 정리(cleanup)와 행수 비교가 이 목록 하나만 보면
# 되도록 한 곳에 모음. games는 FK 때문에 반드시 마지막.
CHILD_TABLES = ["game_events", "game_player_stats", "game_team_stats",
                "shot_log", "lineup_stints", "pregame_features", "game_summary_tags"]
COUNT_TABLES = ["games"] + CHILD_TABLES


def target_key(source):
    return lc.SYNTHETIC_PREFIX + source


def say(msg):
    print(f"[dryrun] {msg}", flush=True)


# ---------------------------------------------------------------------------
# DB 유틸
# ---------------------------------------------------------------------------

def table_counts(cur):
    counts = {}
    for t in COUNT_TABLES:
        cur.execute(f"select count(*) from {t}")
        counts[t] = cur.fetchone()[0]
    return counts


def copyable_columns(cur, table):
    """identity/생성 컬럼(shot_log.shot_id 등)은 명시 INSERT가 불가능하므로 제외."""
    cur.execute("""
        select column_name from information_schema.columns
        where table_schema='public' and table_name=%s
          and is_identity='NO' and is_generated='NEVER'
        order by ordinal_position
    """, (table,))
    return [r[0] for r in cur.fetchall()]


def copy_game_rows(cur, table, source, target):
    """source 경기의 행을 gmkey만 바꿔 target으로 복사."""
    cols = copyable_columns(cur, table)
    others = [c for c in cols if c != "gmkey"]
    cur.execute(
        f"insert into {table} (gmkey, {', '.join(others)}) "
        f"select %s, {', '.join(others)} from {table} where gmkey=%s",
        (target, source))
    return cur.rowcount


def source_fingerprint(cur, source):
    """진짜 source 경기가 정말로 안 건드려졌는지 확인할 지문 - 스코어/종료여부뿐 아니라
    이벤트/박스스코어 행수와 승률 타임라인 합계까지 본다(값이 조용히 바뀌는 것도 잡히게)."""
    cur.execute("""select season_name, season_category, game_date, game_start, home_tcode,
                          away_tcode, home_coach_id, away_coach_id, home_score, away_score,
                          is_ended, stadium, attendance from games where gmkey=%s""", (source,))
    game = cur.fetchone()
    # sum(real)은 float4로 누적돼서 **합산 순서에 따라 값이 달라진다**(Postgres가 집계를
    # 병렬화하면 순서가 바뀜). 실제로 이 검증이 처음엔 "원본이 변경됨!"으로 오탐했는데,
    # 628행을 한 행씩 대조해보니 14개 컬럼 전부 동일했고 차이는 오직 sum()의 float4 누적
    # 오차(422.6090 vs 422.6100)였다. numeric으로 올려서 정확·순서무관하게 합산.
    cur.execute("""select count(*), sum(home_score), sum(away_score),
                          round(sum(home_win_prob::numeric), 6),
                          round(sum(objective_prob::numeric), 6),
                          round(sum(coalesce(wpa_home,0)::numeric), 6)
                   from game_events where gmkey=%s""", (source,))
    events = cur.fetchone()
    cur.execute("select count(*) from game_player_stats where gmkey=%s", (source,))
    n_box = cur.fetchone()[0]
    cur.execute("select count(*) from shot_log where gmkey=%s", (source,))
    n_shot = cur.fetchone()[0]
    return {"game": game, "events": events, "box": n_box, "shots": n_shot}


# ---------------------------------------------------------------------------
# 1. 합성 경기 생성
# ---------------------------------------------------------------------------

def setup(conn, source, target):
    with conn.cursor() as cur:
        cur.execute("""select season_category, home_tcode, away_tcode, game_start, stadium
                       from games where gmkey=%s""", (source,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"source 경기 {source}가 games에 없음")
        season_category, home_tcode, away_tcode, game_start, stadium = row

        # 홈 화면 기본 진입이 '가장 최신 시즌'이라(app/page.tsx의 seasons[0]) 그 시즌에
        # 오늘 날짜로 넣어야 별도 필터 없이 카드가 보인다.
        cur.execute("select season_name from seasons order by season_name desc limit 1")
        season_name = cur.fetchone()[0]
        today = lc.kst_today()

        cur.execute("""
            insert into games (gmkey, season_name, season_category, game_date, game_start,
                home_tcode, away_tcode, home_score, away_score, is_ended, stadium)
            values (%s, %s, %s, %s, %s, %s, %s, null, null, false, %s)
            on conflict (gmkey) do update set
                season_name=excluded.season_name, game_date=excluded.game_date,
                game_start=excluded.game_start, home_score=null, away_score=null,
                is_ended=false, stadium=excluded.stadium
        """, (target, season_name, season_category, today, game_start or "19:00:00",
              home_tcode, away_tcode, f"드라이런(가상) · 원본 {source}"))

        cur.execute("delete from pregame_features where gmkey=%s", (target,))
        n_pf = copy_game_rows(cur, "pregame_features", source, target)
        # 진짜 예정 경기라면 sync_upcoming_games.py가 pregame_features.home_win_prob에
        # 경기 전 모델 예측을 넣어둔다(홈 카드의 "예상 승률"이 읽는 값). 과거 경기 행에는
        # 그 컬럼이 비어 있으므로, 같은 의미의 값 - 그 경기 game_events의 event_order=0
        # (PRE) 행 - 을 복사해 예정 상태를 현실적으로 재현한다.
        cur.execute("""
            update pregame_features set home_win_prob =
                (select home_win_prob from game_events where gmkey=%s and event_order=0)
            where gmkey=%s and home_win_prob is null
        """, (source, target))
    conn.commit()
    say(f"합성 경기 생성: {target} ({season_name} / {today} / {home_tcode} vs {away_tcode}, "
        f"스코어 NULL = 예정), pregame_features {n_pf}행 복사")
    return {"season_name": season_name, "game_date": today,
            "home_tcode": home_tcode, "away_tcode": away_tcode}


def simulate_official_box(conn, source, target):
    """경기 종료 정산이 만들어낼 공식 데이터를 흉내낸다 - 진짜 라이브에서는
    reconcile_finished_game()이 KBL에서 받아 채우는 부분인데, 합성 gmkey는 KBL에 존재하지
    않으므로 source의 확정 박스스코어/슛좌표를 그대로 복사한다. 3막(경기후 리포트)이
    박스스코어 없이는 반쪽만 그려져서, '종료 상태의 사이트'를 제대로 확인하려면 필요."""
    made = {}
    with conn.cursor() as cur:
        for t in ("game_team_stats", "game_player_stats", "shot_log"):
            cur.execute(f"delete from {t} where gmkey=%s", (target,))
            made[t] = copy_game_rows(cur, t, source, target)
    conn.commit()
    say(f"종료 정산 시뮬레이션(공식 박스스코어 복사): {made}")
    return made


# ---------------------------------------------------------------------------
# 2. 리플레이
# ---------------------------------------------------------------------------

def build_ingestor(conn, target, model):
    with conn.cursor() as cur:
        games = lc.select_target_games(cur, None, target)
        if not games:
            raise SystemExit(f"{target} 행이 없음 - 먼저 --setup-only로 생성하세요")
        g = games[0]
        ctx = lc.load_pregame_context(cur, [target])[target]
        valid = lc.load_valid_pcodes(cur)
    conn.commit()
    say(f"경기 전 컨텍스트: netrtgDiff={ctx['netrtgDiff']:.4f}, synergyDiff={ctx['synergyDiff']:.4f}"
        + (" [중립 폴백]" if ctx["neutral"] else ""))
    return g, lc.GameIngestor(target, g["home_tcode"], g["away_tcode"], ctx, model, valid)


def replay(conn, source, target, model, speed, start_elapsed, stop_after, interval,
           reconcile=True, meta_isended=True):
    g, ingestor = build_ingestor(conn, target, model)
    src = lc.ReplaySource(source, speed=speed, raw_log_gmkey=target, raw_log=True,
                          start_elapsed=start_elapsed, meta_isended=meta_isended)
    if not meta_isended:
        say("최악 시나리오 모드 - 응답에 isEnded를 아예 넣지 않음. 종료 판정이 "
            "001/009 휴리스틱만으로 되는지 실제 루프에서 확인한다.")
    say(f"재생 시작: {source} -> {target}, 배속 x{speed}, 시작지점 {start_elapsed:.0f}초, "
        f"경기 총 길이 {src.total_elapsed}초, 폴링 간격 {interval}초"
        + (f", {stop_after}초 뒤 중단" if stop_after else ""))

    pending = {target}
    began = time.time()
    last = None
    while pending:
        # live_collector의 실제 폴링 루프를 그대로 사용(에러 처리 포함).
        summaries = lc.poll_cycle(conn, {target: ingestor}, pending, src, schedule=None,
                                  reconcile=reconcile)
        last = summaries[-1] if summaries else last
        if stop_after and (time.time() - began) >= stop_after:
            say(f"--stop-after {stop_after}초 도달 - 재생 중단(경기 시계 "
                f"{src.sim_elapsed():.0f}/{src.total_elapsed}초 지점, 이어서 재개 가능)")
            return {"ingestor": ingestor, "source": src, "last": last,
                    "stopped_at": src.sim_elapsed(), "finished": False}
        if not pending:
            break
        time.sleep(interval)
    say(f"재생 완료 - 최종 {last['home_score']}-{last['away_score']}")
    return {"ingestor": ingestor, "source": src, "last": last,
            "stopped_at": src.total_elapsed, "finished": True}


# ---------------------------------------------------------------------------
# 3. 검증
# ---------------------------------------------------------------------------

def _events_digest(conn, target):
    with conn.cursor() as cur:
        cur.execute("""select count(*), md5(string_agg(t::text, '|' order by event_order)) from
                       (select * from game_events where gmkey=%s order by event_order) t""", (target,))
        out = cur.fetchone()
    conn.commit()
    return out


def verify_idempotency(conn, source, target, model):
    """**정확히 같은 스냅샷**을 두 번 적재해서 행수도 내용도 안 바뀌는지 본다.

    두 번 다 '기억(_written 메모)을 비운 새 Ingestor'를 쓴다 - 그래야 2회차가 전 행을 진짜로
    다시 UPSERT한다(메모 덕에 아무것도 안 써서 통과하는 가짜 검증 방지). 2회차의 written이
    전체 행수와 같아야 진짜 재적재를 한 것.

    (1차 시도에서 이 검증이 잘못돼 있었음 - 중간까지만 재생된 상태의 DB와 '전체 스냅샷'을
    비교해서, 이벤트가 165->628로 늘어난 정상 동작을 실패로 보고했다. 같은 입력을 두 번
    넣어야 멱등성 검증이 된다.)"""
    src = lc.ReplaySource(source, speed=1.0, raw_log=False)
    src.finish_now()  # 전체 이벤트를 한 번에(뭉텅이 도착 케이스도 겸사겸사 재현)
    snap = src(target)

    _, ing1 = build_ingestor(conn, target, model)
    with conn.cursor() as cur:
        s1 = ing1.ingest(cur, snap)
    conn.commit()
    before = _events_digest(conn, target)

    _, ing2 = build_ingestor(conn, target, model)
    with conn.cursor() as cur:
        s2 = ing2.ingest(cur, snap)
    conn.commit()
    after = _events_digest(conn, target)

    ok = before == after and s2["written"] == before[0]
    say(f"[검증3 멱등성] 같은 스냅샷 2회 적재(1회차 {s1['written']}행, 2회차 {s2['written']}행 "
        f"UPSERT) -> 행수 {before[0]} -> {after[0]}, 내용 md5 "
        f"{'동일' if before[1] == after[1] else '변경됨!'} => {'통과' if ok else '실패'}")
    return {"ok": ok, "before": before, "after": after, "rewritten": s2["written"]}


def verify_end_detection(source):
    """종료 판정 규칙 검증 - 드라이런 1회차에서 진짜 버그를 잡은 지점이라 회귀 테스트로 고정.
    009는 '경기 종료'가 아니라 '피리어드 종료'(정규경기당 4개).

    2026-09-02 확장 - '부정 증거가 긍정 신호를 거부한다'(lc.detect_ended 재설계)를 회귀로
    고정한다. 예전 구현은 signals 리스트에서 1을 먼저 만나면 즉시 True를 돌려줘서,
    playingQuarter 같은 부정 증거가 stale한 isEnded=1을 절대 못 막았다. 그 오판은
    is_ended 단조 + pending 제거 + select_target_games 필터 때문에 되돌릴 수 없었다."""
    path = os.path.join(lc.RAW_DIR, "games", source, "text-cast.json")
    with open(path, encoding="utf-8") as f:
        events = lc.normalise_events(json.load(f))
    with open(os.path.join(lc.RAW_DIR, "games", source, "meta.json"), encoding="utf-8") as f:
        g = json.load(f)["game"]
    home_t, away_t = g["tcodeH"], g["tcodeA"]
    nines = [i for i, e in enumerate(events) if e.get("a") == lc.GAME_OVER_CODE]
    q1_end, q2_end = events[:nines[0] + 1], events[:nines[1] + 1]
    # Q2를 '뛰는 중'인 구간(마지막 001이 마지막 009보다 뒤) - 문자중계 자체가 "아직 진행 중"을
    # 말하는 상태. 여기에 isEnded=1이 오면 그건 stale/premature 신호로 보고 거부해야 한다.
    q2_mid = events[:nines[1]]
    full = events

    def check(name, evts, meta, sched, expect, prev_n=None):
        h, a = lc.tally_score(evts, home_t, away_t)
        got, why, held = lc.detect_ended({"meta": meta}, evts, sched, h, a, prev_n)
        ok = got == expect
        say(f"[검증6 종료판정] {name}: {got} (기대 {expect}) {'OK' if ok else '실패!'}"
            + (f" - {why or held}" if (why or held) else ""))
        return ok

    results = [
        check("Q1 종료(009)까지 · isEnded 신호 없음", q1_end, None, None, False),
        check("Q2 종료(009)까지 · isEnded 신호 없음", q2_end, None, None, False),
        check("Q2 종료까지 · meta.isEnded=0", q2_end, {"game": {"isEnded": 0}}, None, False),
        check("경기 전체 · isEnded 신호 없음(휴리스틱)", full, None, None, True),
        check("경기 전체 · meta.isEnded=0(명시 신호가 휴리스틱보다 우선)",
              full, {"game": {"isEnded": 0}}, None, False),
        check("경기 전체 · meta.isEnded='1'(문자열)", full, {"game": {"isEnded": "1"}}, None, True),
        check("경기 전체 · playingQuarter='Q4'(그 쿼터를 뛰는 중이면 종료 아님)",
              full, {"game": {"playingQuarter": "Q4"}}, None, False),
        check("경기 전체 · playingQuarter='X'(경기 전/후 공통값이라 무시 -> 휴리스틱)",
              full, {"game": {"playingQuarter": "X"}}, None, True),
        # --- 이하 2026-09-02 추가: 거부(veto) 규칙 회귀 ---
        check("Q2 진행 중 · schedule.isEnded=1 (stale 신호를 문자중계가 거부해야 함)",
              q2_mid, None, {"isEnded": 1}, False),
        check("Q2 진행 중 · meta.isEnded=1 + playingQuarter='Q2' (이중 거부)",
              q2_mid, {"game": {"isEnded": 1, "playingQuarter": "Q2"}}, None, False),
        check("경기 전체 · meta.isEnded=1 + 직전 폴링보다 이벤트 증가(한 주기 더 확인)",
              full, {"game": {"isEnded": 1}}, None, False, prev_n=len(full) - 5),
        check("경기 전체 · meta.isEnded=1 + 이벤트 증가 없음(확정)",
              full, {"game": {"isEnded": 1}}, None, True, prev_n=len(full)),
        check("경기 전체 · 휴리스틱 조건 충족 + 이벤트 증가(한 주기 더 확인)",
              full, None, None, False, prev_n=len(full) - 3),
        check("Q2 종료 직후 · schedule.isEnded=1 + 증가 없음(몰수/중단 - Q4 미만이라도 존중)",
              q2_end, None, {"isEnded": 1}, True, prev_n=len(q2_end)),
    ]
    # 동점 케이스는 실제 이벤트로는 만들 수 없어서(83-79로 끝난 경기) 스코어만 직접 넘김.
    tie_got, _, _ = lc.detect_ended({"meta": None}, full, None, 80, 80, len(full))
    say(f"[검증6 종료판정] 경기 전체 · 동점 80-80(연장 예정): {tie_got} (기대 False) "
        f"{'OK' if tie_got is False else '실패!'}")
    results.append(tie_got is False)

    # --- 확정 게이트(lc.end_gate) 회귀 - "한 주기 판정"과 "실제 종료 커밋"의 분리 ---
    # detect_ended가 True를 줘도 그 자체로 is_ended가 서면 안 된다. 되돌릴 수 없는
    # 결정이므로 연속 END_CONFIRM_MIN_POLLS주기 유지가 필요하다.
    def gate_seq(name, steps, expect):
        """steps = [(ended, held, grew), ...] - 주기별 detect_ended 결과.
        expect = 커밋이 일어난 주기 인덱스(1-based) 또는 None."""
        state, fired = {"clean": 0, "veto": 0}, None
        for i, (e, h, g) in enumerate(steps, 1):
            commit, _ = lc.end_gate(state, e, h, g)
            if commit and fired is None:
                fired = i
        ok = fired == expect
        say(f"[검증7 확정게이트] {name}: 커밋 주기 {fired} (기대 {expect}) "
            f"{'OK' if ok else '실패!'}")
        return ok

    meta_end = {"game": {"isEnded": 1}}
    got1, _, _ = lc.detect_ended({"meta": meta_end}, full, None, 83, 79, len(full))
    got2, _, held2 = lc.detect_ended({"meta": {"game": {"isEnded": 1, "playingQuarter": "Q4"}}},
                                     full, None, 83, 79, len(full))
    results += [
        gate_seq("깨끗한 isEnded=1 1주기만: 커밋 안 됨",
                 [(got1, None, False)], None),
        gate_seq("깨끗한 isEnded=1 2주기 연속: 2주기째 커밋",
                 [(got1, None, False)] * 2, 2),
        gate_seq("isEnded=1 + playingQuarter=Q4(거부): 3주기 전엔 커밋 안 됨",
                 [(got2, held2, False)] * 2, None),
        gate_seq(f"isEnded=1 + 거부가 {lc.END_CONFIRM_POLLS}주기 유지: 탈출구 발동",
                 [(got2, held2, False)] * lc.END_CONFIRM_POLLS, lc.END_CONFIRM_POLLS),
        gate_seq("거부 중 이벤트가 늘면 카운터 리셋(경기 진행 중)",
                 [(got2, held2, False), (got2, held2, True)] * 3, None),
        gate_seq("1주기 종료 신호 뒤 신호 소멸 -> 다시 처음부터",
                 [(got1, None, False), (False, None, True), (got1, None, False)], None),
    ]
    say(f"[검증7 확정게이트] 첫 주기 커밋 금지 / {lc.END_CONFIRM_MIN_POLLS}주기 확정 / "
        f"거부 탈출구 {lc.END_CONFIRM_POLLS}주기")
    say(f"[검증6 종료판정] 009 개수 {len(nines)}개(쿼터마다 1개) => "
        f"{'통과' if all(results) else '실패'}")
    return {"ok": all(results), "nines": len(nines)}


def verify_winprob(conn, source, target, n=5):
    """같은 이벤트에 대해 (라이브 수집기가 계산한 target 값) vs (배치가 계산해 이미 저장돼
    있는 source 값)을 비교. 같은 모델·같은 피처라 사실상 일치해야 하고, 남는 차이는
    경기 전 컨텍스트의 출처 차이(배치=raw JSON의 float64, 라이브=pregame_features의
    real/float4)에서만 올 수 있다."""
    with conn.cursor() as cur:
        cur.execute("select max(event_order) from game_events where gmkey=%s", (target,))
        n_max = cur.fetchone()[0]
        if n_max is None:
            return {"ok": False, "rows": [], "note": "target 이벤트 없음"}
        picks = sorted({0, 1, n_max // 4, n_max // 2, (3 * n_max) // 4, n_max})
        cur.execute("""
            select t.event_order, t.quarter, t.clock_min, t.clock_sec,
                   t.home_score, t.away_score, s.home_score, s.away_score,
                   t.home_win_prob, s.home_win_prob, t.objective_prob, s.objective_prob
            from game_events t join game_events s
              on s.gmkey=%s and s.event_order=t.event_order
            where t.gmkey=%s and t.event_order = any(%s)
            order by t.event_order
        """, (source, target, picks))
        rows = cur.fetchall()
    conn.commit()
    say("[검증4 승률 대조] event / 스코어(target|source) / home_win_prob(target vs source) / objective(target vs source)")
    worst = 0.0
    for r in rows:
        d_wp = abs((r[8] or 0) - (r[9] or 0))
        d_op = abs((r[10] or 0) - (r[11] or 0))
        worst = max(worst, d_wp, d_op)
        say(f"   #{r[0]:<4} {r[1]:>3} {str(r[2]):>2}:{str(r[3]):0>2}  "
            f"{r[4]}-{r[5]} | {r[6]}-{r[7]}   "
            f"{r[8]} vs {r[9]} (Δ{d_wp:.4f})   {r[10]} vs {r[11]} (Δ{d_op:.4f})")
    say(f"   최대 절대오차 {worst:.4f}")
    return {"ok": worst <= 0.001, "rows": rows, "worst": worst}


def verify_bad_poll(conn, target, model):
    """불량 폴링(빈 응답 / 깨진 JSON 모양 / HTTP 예외)에 루프가 죽지 않는지 - 실제
    live_collector.poll_cycle을 그대로 호출해서 확인한다."""
    _, ingestor = build_ingestor(conn, target, model)
    with conn.cursor() as cur:
        cur.execute("select count(*) from game_events where gmkey=%s", (target,))
        before = cur.fetchone()[0]
    conn.commit()

    cases = [
        ("HTTP 예외", lambda gk: (_ for _ in ()).throw(RuntimeError("KBL API 500 (모의)"))),
        ("빈 응답", lambda gk: {"events": [], "meta": None, "player_stat": None}),
        ("events가 리스트가 아님", lambda gk: {"events": {"error": "maintenance"},
                                              "meta": "??", "player_stat": 0}),
        ("필드 깨진 이벤트", lambda gk: {"events": [{"q": None}, {"nope": 1}, "문자열",
                                                    {"q": "Q1", "m": "x", "s": None}],
                                         "meta": {"game": {"isEnded": "??"}},
                                         "player_stat": "garbage"}),
        ("None 응답", lambda gk: None),
    ]
    results = []
    for name, fn in cases:
        pending = {target}
        try:
            summaries = lc.poll_cycle(conn, {target: ingestor}, pending, fn, reconcile=False)
            crashed = False
        except Exception as e:  # noqa: BLE001  여기 들어오면 실패
            summaries, crashed = [{"error": repr(e)}], True
        s = summaries[0] if summaries else {}
        results.append({"case": name, "crashed": crashed,
                        "handled": (not crashed) and (s.get("error") is not None
                                                      or s.get("started") is False)})
        say(f"[검증5 불량폴링] {name}: {'죽음!' if crashed else '처리됨'} "
            f"({s.get('error') or ('이벤트 0건으로 무시' if not s.get('started') else s)})")

    with conn.cursor() as cur:
        cur.execute("select count(*) from game_events where gmkey=%s", (target,))
        after = cur.fetchone()[0]
        cur.execute("select home_score, away_score, is_ended from games where gmkey=%s", (target,))
        gstate = cur.fetchone()
    conn.commit()
    ok = all(r["handled"] for r in results) and before == after
    say(f"[검증5 불량폴링] 이벤트 {before} -> {after}(불변), games {gstate} => "
        f"{'통과' if ok else '실패'}")
    return {"ok": ok, "results": results, "before": before, "after": after}


# ---------------------------------------------------------------------------
# 4. 정리
# ---------------------------------------------------------------------------

def snapshot_source_raw(source):
    """정산 배치를 진짜 source gmkey로 돌리기 전에 raw/games/<source>/를 통째로 백업.

    reconcile_finished_game()은 fetch_one_game(source, force=True)를 부른다 - 즉 **오늘의
    KBL API 응답으로 원본 파일 5개를 되돌릴 수 없게 덮어쓴다**. 드라이런은 검증 도구지
    데이터 마이그레이션이 아니므로, 원본을 건드릴 거면 되돌릴 수단을 먼저 만들어둬야 한다."""
    src = os.path.join(lc.RAW_DIR, "games", source)
    if not os.path.isdir(src):
        return None
    bak = os.path.join(lc.RAW_DIR, "games", f".bak-dryrun-{source}")
    shutil.rmtree(bak, ignore_errors=True)
    shutil.copytree(src, bak)
    return bak


def restore_source_raw(source, bak):
    src = os.path.join(lc.RAW_DIR, "games", source)
    shutil.rmtree(src, ignore_errors=True)
    shutil.copytree(bak, src)
    shutil.rmtree(bak, ignore_errors=True)
    say(f"원본 raw/games/{source}/ 복원 완료(백업본 삭제)")


def cleanup(conn, target, quiet=False):
    deleted = {}
    with conn.cursor() as cur:
        for t in CHILD_TABLES:
            cur.execute(f"delete from {t} where gmkey=%s", (target,))
            deleted[t] = cur.rowcount
        cur.execute("delete from games where gmkey=%s", (target,))
        deleted["games"] = cur.rowcount
    conn.commit()

    # 삭제 확인 - 지웠다고 믿지 말고 다시 조회한다.
    leftovers = {}
    with conn.cursor() as cur:
        for t in COUNT_TABLES:
            cur.execute(f"select count(*) from {t} where gmkey like %s",
                        (lc.SYNTHETIC_PREFIX + "%",))
            c = cur.fetchone()[0]
            if c:
                leftovers[t] = c
    conn.commit()

    log_dir = os.path.join(lc.LIVE_LOG_DIR, target)
    if os.path.isdir(log_dir):
        shutil.rmtree(log_dir, ignore_errors=True)
    # 종료 신호 확정 카운터(raw/live_state/<target>.json)도 합성 산출물이므로 같이 지운다.
    lc.clear_end_state(target)

    if not quiet:
        say(f"정리 완료 - 삭제 행수 {deleted}")
        say(f"재조회 결과 남은 DRYRUN 행: {leftovers or '없음(0건)'}")
    return {"deleted": deleted, "leftovers": leftovers}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="라이브 수집기 드라이런(끝난 경기 재생)")
    ap.add_argument("--source", default=DEFAULT_SOURCE, help=f"원본 경기 gmkey(기본 {DEFAULT_SOURCE})")
    ap.add_argument("--speed", type=float, default=60.0, help="재생 배속(기본 60)")
    ap.add_argument("--start-elapsed", type=float, default=0.0, help="경기 시계 N초 지점부터 이어서 재생")
    ap.add_argument("--stop-after", type=float, default=None, help="벽시계 N초 뒤 재생 중단(구간 재생)")
    ap.add_argument("--interval", type=float, default=3.0, help="폴링 간격(초, 기본 3)")
    ap.add_argument("--setup-only", action="store_true", help="합성 경기(예정 상태)만 만들고 종료")
    ap.add_argument("--reuse", action="store_true", help="이미 만들어둔 합성 경기를 그대로 사용(재생성 안 함)")
    ap.add_argument("--verify-only", action="store_true", help="검증만 실행")
    ap.add_argument("--cleanup", action="store_true", help="합성 행 삭제만 실행")
    ap.add_argument("--keep", action="store_true", help="끝나고 합성 행을 지우지 않음(사이트 확인용)")
    ap.add_argument("--counts", action="store_true", help="테이블 행수만 출력(전/후 비교용)")
    ap.add_argument("--no-reconcile", action="store_true", help="종료 정산 단계 생략")
    ap.add_argument("--reconcile-source", action="store_true",
                    help="정산 배치를 **진짜 source gmkey**로 한 번 실행해 경로를 검증한다"
                         "(기본 꺼짐). 켜면 raw/games/<source>/를 먼저 백업하고, 지문이 달라지면"
                         " 자동 복원한다. 그래도 프로덕션 행을 실제로 건드리는 경로다.")
    ap.add_argument("--no-meta-isended", action="store_true",
                    help="응답에 isEnded를 아예 넣지 않음 - 종료 판정이 001/009 휴리스틱만으로 "
                         "되는지 확인하는 최악 시나리오")
    args = ap.parse_args()

    lc.load_env_supabase()
    target = target_key(args.source)
    conn = lc.get_conn()
    conn.autocommit = False
    # 자동 정리를 try/finally로 옮긴다(2026-09-02). 예전엔 정리가 성공 경로 맨 끝에만 있어서,
    # 재생이나 검증 중 예외가 하나라도 나면 합성 games/game_events/pregame_features 행이
    # **프로덕션 DB에 그대로 남았다** - 모듈 docstring의 "절대 남기지 않는다"와 정면으로
    # 어긋난다. 이제 어떤 경로로 빠져나가든 정리가 돈다(--keep / --stop-after 중단은 예외).
    need_cleanup = False
    keep_reason = None
    try:
        if args.counts:
            with conn.cursor() as cur:
                print(json.dumps(table_counts(cur), indent=2))
            conn.commit()
            return

        if args.cleanup:
            cleanup(conn, target)
            return

        model = None
        if not args.setup_only:
            import joblib
            say("승률 모델 로딩...")
            model = joblib.load(mge.MODEL_PATH)

        if args.verify_only:
            verify_end_detection(args.source)
            verify_winprob(conn, args.source, target)
            verify_idempotency(conn, args.source, target, model)
            verify_bad_poll(conn, target, model)
            return

        if not args.reuse:
            setup(conn, args.source, target)
        need_cleanup = True
        if args.keep:
            # --keep은 '남겨두고 눈으로 확인하겠다'는 명시적 의사표시다. 재생/검증 도중
            # 예외가 나도 그 의사를 존중해야 하므로 여기서 미리 세운다(예전엔 성공 경로
            # 맨 끝에서 세워서, 예외가 나면 --keep을 줬는데도 지워졌다).
            keep_reason = "--keep"
        if args.setup_only:
            keep_reason = "--setup-only(사이트에서 '예정' 상태 확인용)"
            say(f"예정 상태로 대기 중 - 사이트에서 /games/{target} 확인 후 "
                f"`--reuse`로 재생을 시작하세요.")
            return

        before_fp = None
        with conn.cursor() as cur:
            before_fp = source_fingerprint(cur, args.source)
        conn.commit()

        result = replay(conn, args.source, target, model, args.speed, args.start_elapsed,
                        args.stop_after, args.interval, reconcile=not args.no_reconcile,
                        meta_isended=not args.no_meta_isended)

        if result["finished"] and not args.no_reconcile and args.reconcile_source:
            # 합성 gmkey는 정산 배치에서 자동으로 걸러진다(SYNTHETIC_PREFIX 가드). 진짜
            # 경로를 증명하려면 source gmkey로 실제로 돌려보는 수밖에 없는데, 그건
            # **프로덕션 데이터를 건드리는 행위**다(fetch_one_game(force=True)가 원본 JSON
            # 5개를 오늘 응답으로 덮어쓰고, 두 이관 스크립트가 진짜 games 행에 UPSERT).
            # 그래서 (a) 기본으로 끄고, (b) 켜더라도 raw를 백업한 뒤 돌리고, (c) 지문이
            # 달라지면 raw를 되돌린다. 예전엔 백업도 롤백도 없이 무조건 돌린 뒤 '변경됨!'을
            # 출력만 했다.
            bak = snapshot_source_raw(args.source)
            say(f"정산 배치를 진짜 source gmkey로 실행(경로 검증) - 원본 백업: {bak}")
            try:
                res = lc.reconcile_finished_game(args.source)
                say(f"   정산 결과: ok={res.get('ok')} {res.get('why') or ''}")
                with conn.cursor() as cur:
                    after_fp = source_fingerprint(cur, args.source)
                conn.commit()
                same = before_fp == after_fp
                say(f"[검증2 원본 불변] source {args.source}: {'동일' if same else '변경됨!'}")
                if not same:
                    say(f"   before={before_fp}")
                    say(f"   after ={after_fp}")
            finally:
                if bak:
                    restore_source_raw(args.source, bak)

        if result["finished"] and not args.no_reconcile:
            simulate_official_box(conn, args.source, target)

        if result["finished"]:
            verify_end_detection(args.source)
            verify_winprob(conn, args.source, target)
            verify_idempotency(conn, args.source, target, model)
            verify_bad_poll(conn, target, model)

        # --stop-after로 중간에 멈춘 재생은 "이어서 재개할 것"이 전제라 자동 정리하면 안 된다
        # (실제로 --speed 1 구간 검증에서 4분치를 재생해놓고 그대로 지워버린 적 있음).
        # 끝까지 간 재생만 기본 자동 정리 - 합성 행이 DB에 남는 사고를 막는 기본값은 유지.
        if not args.keep and not result["finished"]:   # --keep은 위(재생 전)에서 이미 세움
            keep_reason = "재생이 중간에 멈춤(--stop-after)"
    finally:
        try:
            if need_cleanup and not keep_reason:
                # 예외로 빠져나온 경우 트랜잭션이 abort 상태일 수 있어 DELETE가 바로 죽는다.
                try:
                    conn.rollback()
                except Exception:  # noqa: BLE001
                    pass
                cleanup(conn, target)
            elif need_cleanup:
                say(f"{keep_reason} - 합성 행을 남겨둠. 확인/재개가 끝나면 반드시 "
                    f"`python replay_dry_run.py --cleanup --source {args.source}` 실행할 것.")
        finally:
            conn.close()


if __name__ == "__main__":
    main()
