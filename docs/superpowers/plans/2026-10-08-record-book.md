# 역대 기록(Record Book) 구현 계획 — 1단계

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** KBL 역대 TOP10(팀·선수의 쿼터/경기/연장별 최다·최소 기록)를 Supabase `record_entries`에 보관하고, 라이브 중계의 알림·패널과 경기 후 AI 리포트에 쓴다.

**Architecture:** 파이썬(`tools/record_book.py`)이 `raw/games`의 공식 자료 + 검증 게이트를 통과한 중계 이벤트로 보드별 순위 ≤ 15 후보를 만들어 `record_entries`에 보관하고, 경기 종료 정산 훅이 그 경기만 멱등 반영한다. 웹은 테이블을 10분 캐시로 읽어 "그 경기 이전" 기준 TOP10 요약(`RecordContext`)을 만들고, 순수 엔진(`lib/records.ts`)이 이벤트를 훑어 TOP10에 닿은 순간·임박 구간을 뽑아 기존 기록 워치 패널·토스트·경기 후 리포트에 싣는다.

**Tech Stack:** Python 3.11(venv `D:\영상작업\축구\개발\.venv`), psycopg2, Supabase Postgres, Next.js 16 / React / TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-record-book-design.md` (승인됨)

## Global Constraints

- **보드 모델**: 보드 키 = `대상(p|t)` + `단위(q|g)` + `.종목.` + `방향(max|min)` (예: `pq.ast.max`). 구간 `Q1`~`Q4`, `OT`, `ALL`, `G`. `ALL`은 Q1~Q4의 합집합(연장 제외)이며 **테이블에 저장하지 않는다**. 팀 득점 `최소` 보드는 `OT`를 만들지 않는다. 총 93보드(저장 80).
- **종목**: 선수 쿼터 `pts·reb·ast·stl·blk·tpm·to` 최다 / 선수 경기 같은 7종 / 팀 쿼터 `pts` 최다·최소 + `reb·ast·stl·blk` 최다 / 팀 경기 `pts` 최다·최소 + `fgm·fgmiss·tpm·reb·ast·stl·blk` 최다.
- **이벤트 코드**: pts = 201·207(2점), 205(3점), 203(1점) / reb = 209+210(선수 귀속분만, 팀 리바운드 218 제외) / ast 211 / stl 212 / blk 213 / to 214 / tpm 205 / fgm 201·205·207 / fgmiss 202·206·208.
- **순위**: 공동 순위(1224). TOP10 = 순위 ≤ 10. 보관 = (보드, 구간)마다 순위 ≤ 15(동률 포함). `--rebuild`가 20,000행을 넘으면 중단한다.
- **대상 경기**: 정규시즌·플레이오프·챔피언결정전의 종료 경기. 오픈매치·올스타 제외. 예정 경기에는 이 기능이 없다.
- **검증 게이트**: 이벤트 기반 보드는 (1) 양 팀 Q1~Q4 이벤트 득점 = 공식 쿼터 점수, 쿼터 합 + 연장 합 = 팀 최종 점수 (2) 그 선수/팀의 경기 전체 이벤트 합계 = 공식 합계 — 둘 다 통과한 값만. 연장 라벨이 `X1`~`X4`가 아니면 연장 후보 없음. 공식 쿼터 점수 보드도 쿼터 합(+연장)이 팀 최종 점수와 같을 때만.
- **웹 규칙**: "그 경기 이전" = `(game_date, game_start)`가 더 이른 항목만(같은 시각·자기 자신 제외). 경기일이 오늘로부터 60일 초과면 기능 끔. 종료 경기는 테이블에 있는(`validated`) 항목만 기록으로 주장, 라이브(진행 중)는 전부 "잠정". 읽기 실패·테이블 없음 → 기록 UI만 사라진다(`soft`), 에러를 빈 값으로 삼켜 캐시에 굳히지 않는다.
- **알림 문구**: `KBL 신기록(종전 N개)` / `KBL 타이 기록(공동 1위)` / `KBL 역대 [공동 ]N위`, 턴오버는 `KBL` 대신 `불명예`. 신기록을 깬 뒤에는 값이 오를 때마다 다시 알린다. 토스트는 TOP10 전부(실측: 경기당 평균 0.55개), 임박은 패널 전용. UI 카피는 한국어.
- **보안**: `record_entries`는 RLS를 켜고 정책을 만들지 않으며 `anon`/`authenticated` 권한을 회수한다(서버 서비스 키와 `DATABASE_URL` 스크립트만 접근).
- **운영 주의**: 수집기가 **메인 작업트리**에서 돌고 있다 — 브랜치를 전환하지 말고, `tools/live_collector.py`·`tools/daily_batch.py`는 Task 3의 절차(복사본에서 검증 후 적용)를 따른다. 정산 훅은 실패해도 정산 결과(`ok`)를 바꾸지 않는다(타임아웃 300초).
- **도구 주의**: 이 환경의 셸은 명령 안의 `\\`를 `\`로 합친다 — 정규식처럼 백슬래시가 든 코드는 **Write/Edit 도구로만** 쓴다(`node -e`·heredoc 금지). 작업트리 파일은 CRLF — Edit 도구는 LF 문자열로 매칭하므로 그대로 쓰면 된다. Python은 반드시 venv 인터프리터: `PY="D:/영상작업/축구/개발/.venv/Scripts/python.exe"` (Anaconda 금지, 모델·numpy 버전이 다르다).
- **커밋/푸시**: 각 Task 끝의 로컬 커밋은 이 계획의 실행 승인에 포함된다. **DB 변경(Task 11)과 `git push`(Task 12)는 실행 직전에 사용자에게 한 번 더 확인한다.**

---

## 파일 지도

| 파일 | 역할 | Task |
|---|---|---|
| `tools/record_book.py` | 후보 계산·검증 게이트·순위/보관·저장소·반영·CLI | 1, 2 |
| `tools/test_record_book.py` | 위의 단위 테스트(합성 경기, 선택적 실데이터 단언) | 1, 2, 4 |
| `tools/live_collector.py`, `tools/daily_batch.py` | 정산 훅(비치명) | 3 |
| `tools/test_record_book_hook.py` | 훅 회귀 테스트 | 3 |
| `tools/schema_record_book.sql`, `tools/rollback_record_book.sql` | 테이블 DDL / 롤백 | 4 |
| `courtside-web/lib/records.ts` | 라이브 엔진(순수 함수) | 5 |
| `courtside-web/lib/recordBook.ts` | 서버: 테이블 읽기 + "그 경기 이전" TOP10 요약 | 6 |
| `courtside-web/lib/cachePolicy.ts` | `TAG.records` | 6 |
| `tools/dump_record_fixtures.py`, `courtside-web/lib/__fixtures__/recordParity/*.json` | 대조·빈도 픽스처 도구와 10경기 픽스처 | 7 |
| `courtside-web/lib/records.parity.test.ts`, `records.replay.test.ts` | 파이썬↔웹 정의 대조, 허훈 경기 재현 | 7 |
| `courtside-web/components/MilestoneWatch.tsx`, `GameReplay.tsx` | "🏆 역대 기록" 그룹, 토스트·패널 연결 | 8 |
| `courtside-web/lib/postgameReport.ts`, `app/games/[gmkey]/page.tsx` | 경기 후 "역대 기록" 섹션, 페이지 연결 | 9 |
| `courtside-web/lib/records.frequency.test.ts`, 스펙·README | 빈도 실측(게이트 테스트), 문서 정정 | 10 |

---

### Task 1: 파이썬 후보 계산과 순위 (`record_book.py` 1부)

**Files:**
- Create: `tools/record_book.py` (1부: 상수, raw 읽기, 공식·이벤트 후보, 순위·보관, 수집기)
- Create: `tools/test_record_book.py` (합성 경기 테스트)

**Interfaces:**
- Produces (Task 2 이후가 쓴다):
  - `parse_game(meta, player_stat, team_record, events) -> dict | None`, `load_game(gmkey, raw_dir=RAW_GAMES) -> dict | None`
  - `official_candidates(g) -> list[dict]`, `event_candidates(g) -> list[dict]`, `game_candidates(g)`
  - 행 dict 키 = `ROW_COLUMNS` = `board, bucket, gmkey, subject, period, value, game_date, game_start, season_name, category, subject_name, tcode, opp_tcode, is_ot`; 키 열 `PK_COLUMNS` = 앞의 5개
  - `rank_sorted(rows) -> [(rank, row)]`, `retain(rows, keep=KEEP_RANK)`, `all_quarters(rows)`, `Collector`, `build_all(raw_dir=RAW_GAMES, keep=KEEP_RANK, only=None) -> (rows, stats)`, `pk(row)`

- [ ] **Step 1: 테스트 파일 작성 (1부)**

<!-- create: tools/test_record_book.py -->
~~~python
# -*- coding: utf-8 -*-
"""record_book.py 단위 테스트 - DB·raw 없이 합성 경기로 돈다(마지막 실데이터 테스트만 RECORD_BOOK_SLOW=1일 때).

실행:  python test_record_book.py
       RECORD_BOOK_SLOW=1 python test_record_book.py   # raw/games 전체(1~2분)로 알려진 기록 단언
"""
import json
import os
import random
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import record_book as rb  # noqa: E402


# ---------------------------------------------------------------------------
# 합성 경기 - 홈 H(선수 p1 득점, p2 어시), 원정 A(선수 q1)
# ---------------------------------------------------------------------------

def ev(q, name, tc, a, n=1):
    return [{"q": q, "p": name, "t": tc, "a": a} for _ in range(n)]


def base_events():
    """H: 쿼터마다 p1이 2점슛 10개(20점), p2가 어시스트 q 번째 쿼터에 q개. A: 쿼터마다 q1이 2점슛 9개(18점)."""
    out = []
    for i, q in enumerate(rb.REG_PERIODS, 1):
        out += ev(q, "가드", "H", "201", 10) + ev(q, "도우미", "H", "211", i) + ev(q, "원정", "A", "201", 9)
    return out


def make_game(**over):
    g = {
        "gmkey": "S99G01N1", "date": "2026-10-08", "start": "19:00", "season": "2026-2027", "category": "정규시즌",
        "home": "H", "away": "A", "names": {"H": "홈팀", "A": "원정팀"},
        "quarters": {"H": {"q": [20, 20, 20, 20], "ot": []}, "A": {"q": [18, 18, 18, 18], "ot": []}},
        "has_ot": False,
        "players": [
            {"pcode": "p1", "pname": "가드", "tcode": "H", "rec": {"score": 80, "rb": 0, "ast": 0, "stl": 0, "bs": 0, "threep": 0, "to": 0}},
            {"pcode": "p2", "pname": "도우미", "tcode": "H", "rec": {"score": 0, "rb": 0, "ast": 10, "stl": 0, "bs": 0, "threep": 0, "to": 0}},
            {"pcode": "q1", "pname": "원정", "tcode": "A", "rec": {"score": 72, "rb": 0, "ast": 0, "stl": 0, "bs": 0, "threep": 0, "to": 0}},
        ],
        "teams": {
            "H": {"score": 80, "fgt": 40, "fgtA": 70, "threep": 0, "rb": 0, "ast": 10, "stl": 0, "bs": 0},
            "A": {"score": 72, "fgt": 36, "fgtA": 80, "threep": 0, "rb": 0, "ast": 0, "stl": 0, "bs": 0},
        },
        "events": base_events(),
    }
    g.update(over)
    return g


def by_board(rows, board, bucket=None):
    return [r for r in rows if r["board"] == board and (bucket is None or r["bucket"] == bucket)]


# ---------------------------------------------------------------------------
# parse_game / load_game
# ---------------------------------------------------------------------------

def _meta(category="정규시즌", ended=1, eq=None):
    return {"game": {"gmkey": "S99G01N2", "seasonCategoryName": category, "isEnded": ended, "gameDate": "20261008", "gameStart": "1900",
                     "tcodeH": "H", "tcodeA": "A", "tnameH": "홈팀", "tnameA": "원정팀", "seasonName": "2026-2027"},
            "teamrecords": {"home": {"scoreq1": 20, "scoreq2": 20, "scoreq3": 20, "scoreq4": 20, "scoreeq": eq or []},
                            "away": {"scoreq1": 18, "scoreq2": 18, "scoreq3": 18, "scoreq4": 18, "scoreeq": eq or []}}}


def test_parse_game_skips_ineligible():
    assert rb.parse_game(_meta("OPEN MATCH DAY"), [], [], []) is None
    assert rb.parse_game(_meta("올스타"), [], [], []) is None
    assert rb.parse_game(_meta(ended=0), [], [], []) is None
    g = rb.parse_game(_meta("플레이오프"), [], [], [])
    assert g["category"] == "플레이오프" and g["date"] == "2026-10-08" and g["start"] == "19:00" and g["season"] == "2026-2027"
    assert g["quarters"]["H"]["q"] == [20, 20, 20, 20] and g["has_ot"] is False


def test_parse_game_detects_ot():
    g = rb.parse_game(_meta(eq=[11, 14]), [], [], [])
    assert g["has_ot"] is True and g["quarters"]["H"]["ot"] == [11, 14]


def test_load_game_reads_four_files_and_tolerates_missing():
    with tempfile.TemporaryDirectory() as d:
        gd = os.path.join(d, "S99G01N2")
        os.makedirs(gd)
        files = {"meta.json": _meta(), "player-stat.json": [{"player": {"pcode": "p1", "pname": "가드", "tcode": "H"}, "records": {"score": 4}}],
                 "team-record.json": [{"tcode": "H", "records": {"score": 80}}], "text-cast.json": [{"n": 1, "q": "Q1", "p": "가드", "t": "H", "a": "201"}]}
        for name, body in files.items():
            with open(os.path.join(gd, name), "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
        g = rb.load_game("S99G01N2", d)
        assert g["players"][0]["pcode"] == "p1" and g["teams"]["H"]["score"] == 80 and len(g["events"]) == 1
        assert rb.load_game("NOPE", d) is None
        os.remove(os.path.join(gd, "text-cast.json"))
        assert rb.load_game("S99G01N2", d) is None


# ---------------------------------------------------------------------------
# 공식 보드
# ---------------------------------------------------------------------------

def test_official_candidates():
    rows = rb.official_candidates(make_game())
    pts = by_board(rows, "pg.pts.max")
    assert sorted((r["subject"], r["value"]) for r in pts) == [("p1", 80), ("q1", 72)]
    assert [r["value"] for r in by_board(rows, "pg.ast.max")] == [10]               # 0인 값은 최다 보드 후보가 아니다
    assert sorted(r["value"] for r in by_board(rows, "tg.pts.max")) == [72, 80] and sorted(r["value"] for r in by_board(rows, "tg.pts.min")) == [72, 80]
    assert sorted(r["value"] for r in by_board(rows, "tg.fgmiss.max")) == [30, 44]  # fgtA - fgt
    assert sorted(r["value"] for r in by_board(rows, "tg.fgm.max")) == [36, 40]
    q = by_board(rows, "tq.pts.max")
    assert len(q) == 8 and {r["bucket"] for r in q} == set(rb.REG_PERIODS)
    assert len(by_board(rows, "tq.pts.min")) == 8
    one = by_board(rows, "tq.pts.max", "Q1")[0]
    assert one["subject_name"] in ("홈팀", "원정팀") and one["opp_tcode"] in ("H", "A") and one["game_start"] == "19:00" and one["is_ot"] is False


def test_official_quarter_rows_skipped_when_sums_disagree():
    g = make_game(has_ot=True)
    g["quarters"]["H"]["ot"] = [6, 9, 13]                  # 80점 팀인데 쿼터 80 + 연장 28 = 108 != 80 -> 홈의 쿼터 보드만 빠진다
    rows = rb.official_candidates(g)
    assert not [r for r in rows if r["board"].startswith("tq.") and r["tcode"] == "H"]
    assert len([r for r in rows if r["board"] == "tq.pts.max" and r["tcode"] == "A"]) == 4
    assert by_board(rows, "tg.pts.max")                    # 경기 보드는 공식 최종 점수라 영향 없다


def test_official_ot_boards_have_no_min():
    g = make_game(has_ot=True)
    g["quarters"]["H"]["ot"] = [11, 0]
    g["quarters"]["A"]["ot"] = [9, 12]
    g["teams"]["H"]["score"], g["teams"]["A"]["score"] = 91, 93        # 쿼터 + 연장 합과 같아야 쿼터 보드가 만들어진다
    rows = rb.official_candidates(g)
    ot = by_board(rows, "tq.pts.max", "OT")
    assert sorted((r["tcode"], r["period"], r["value"]) for r in ot) == [("A", "X1", 9), ("A", "X2", 12), ("H", "X1", 11)]   # 0점 연장은 후보가 아니다
    assert not [r for r in rows if r["board"] == "tq.pts.min" and r["bucket"] == "OT"]
    assert all(r["is_ot"] for r in rows)


# ---------------------------------------------------------------------------
# 이벤트 보드 + 검증 게이트
# ---------------------------------------------------------------------------

def test_event_candidates_pass_gates():
    g = make_game()
    g["players"][1]["rec"]["ast"] = 10
    g["teams"]["H"]["ast"] = 10
    rows = rb.event_candidates(g)
    ast = sorted((r["bucket"], r["value"]) for r in by_board(rows, "pq.ast.max"))
    assert ast == [("Q1", 1), ("Q2", 2), ("Q3", 3), ("Q4", 4)] and all(r["subject"] == "p2" for r in by_board(rows, "pq.ast.max"))
    assert sorted(r["value"] for r in by_board(rows, "pq.pts.max") if r["subject"] == "p1") == [20, 20, 20, 20]
    assert sorted((r["bucket"], r["value"]) for r in by_board(rows, "tq.ast.max")) == [("Q1", 1), ("Q2", 2), ("Q3", 3), ("Q4", 4)]


def test_gate1_quarter_score_mismatch_drops_everything():
    g = make_game(events=base_events() + ev("Q2", "가드", "H", "201", 1))   # H의 2쿼터가 22점으로 공식(20)과 다르다
    assert rb.event_candidates(g) == []


def test_gate1_final_score_mismatch_drops_everything():
    g = make_game()
    g["teams"]["H"]["score"] = 81
    assert rb.event_candidates(g) == []


def test_gate2_item_total_mismatch_drops_only_that_item():
    g = make_game()
    g["players"][1]["rec"]["ast"] = 11       # 도우미 어시스트 이벤트 합 10 != 공식 11
    g["teams"]["H"]["ast"] = 10
    rows = rb.event_candidates(g)
    assert not by_board(rows, "pq.ast.max")
    assert by_board(rows, "pq.pts.max")      # 득점은 그대로
    assert by_board(rows, "tq.ast.max")      # 팀 어시스트는 팀 합계가 맞아 살아 있다


def test_team_events_count_only_player_attributed():
    g = make_game()
    g["players"][1]["rec"]["ast"] = 10
    g["teams"]["H"]["ast"] = 10
    g["events"] = g["events"] + [{"q": "Q1", "p": None, "t": "H", "a": "218"}, {"q": "Q1", "p": None, "t": "H", "a": "211"}]
    rows = rb.event_candidates(g)
    assert sorted(r["value"] for r in by_board(rows, "tq.ast.max")) == [1, 2, 3, 4]   # 선수 귀속이 아닌 이벤트는 세지 않는다


def test_ot_bucket_and_label_gate():
    g = make_game(has_ot=True)
    g["quarters"]["H"]["ot"] = [4]
    g["quarters"]["A"]["ot"] = [2]
    g["teams"]["H"]["score"], g["teams"]["A"]["score"] = 84, 74
    g["players"][0]["rec"]["score"], g["players"][2]["rec"]["score"] = 84, 74
    g["events"] = base_events() + ev("X1", "가드", "H", "201", 2) + ev("X1", "원정", "A", "201", 1)
    rows = rb.event_candidates(g)
    ot = [r for r in by_board(rows, "pq.pts.max", "OT")]
    assert sorted((r["subject"], r["period"], r["value"]) for r in ot) == [("p1", "X1", 4), ("q1", "X1", 2)]
    # 모르는 라벨(EQ1)이면 연장 후보만 사라지고 정규 쿼터는 그대로
    g["events"] = base_events() + ev("EQ1", "가드", "H", "201", 2) + ev("EQ1", "원정", "A", "201", 1)
    rows = rb.event_candidates(g)
    assert not by_board(rows, "pq.pts.max", "OT") and by_board(rows, "pq.pts.max", "Q1")


def test_duplicate_names_on_a_team_are_skipped():
    g = make_game()
    g["players"].append({"pcode": "p3", "pname": "가드", "tcode": "H", "rec": {"score": 0}})
    rows = rb.event_candidates(g)
    assert not [r for r in rows if r["board"].startswith("pq.") and r["tcode"] == "H" and r["subject_name"] == "가드"]


# ---------------------------------------------------------------------------
# 순위 / 보관 / 반영
# ---------------------------------------------------------------------------

def mk(board, bucket, value, gmkey="G", subject="s", period="", date="2026-01-01"):
    return {"board": board, "bucket": bucket, "gmkey": gmkey, "subject": subject, "period": period, "value": value, "game_date": date,
            "game_start": "", "season_name": "", "category": "정규시즌", "subject_name": subject, "tcode": "H", "opp_tcode": "A", "is_ot": False}


def test_rank_sorted_competition_ranking_max_and_min():
    rows = [mk("pq.ast.max", "Q1", v, gmkey=f"G{i}") for i, v in enumerate([7, 9, 8, 8, 8])]
    assert [(rank, r["value"]) for rank, r in rb.rank_sorted(rows)] == [(1, 9), (2, 8), (2, 8), (2, 8), (5, 7)]
    rows = [mk("tq.pts.min", "Q1", v, gmkey=f"G{i}") for i, v in enumerate([5, 2, 3, 2])]
    assert [(rank, r["value"]) for rank, r in rb.rank_sorted(rows)] == [(1, 2), (1, 2), (3, 3), (4, 5)]


def test_retain_keeps_ties_that_straddle_the_cutoff():
    rows = [mk("pq.pts.max", "Q1", 100 - i, gmkey=f"G{i}") for i in range(14)]              # 순위 1~14
    rows += [mk("pq.pts.max", "Q1", 50, gmkey=f"T{i}") for i in range(5)]                    # 순위 15(5건 동률)
    rows += [mk("pq.pts.max", "Q1", 49, gmkey="Z")]                                           # 순위 20 -> 잘린다
    kept = rb.retain(rows, keep=15)
    assert len(kept) == 19 and all(r["value"] >= 50 for r in kept)
    assert len(rb.retain([mk("pq.pts.max", "Q2", 1)], keep=15)) == 1


def test_all_quarters_excludes_ot():
    rows = [mk("pq.ast.max", b, 5) for b in ("Q1", "Q2", "Q3", "Q4", "OT")]
    assert sorted(r["bucket"] for r in rb.all_quarters(rows)) == ["Q1", "Q2", "Q3", "Q4"]


def test_collector_matches_one_shot_retain():
    random.seed(7)
    rows = [mk("pq.ast.max", f"Q{random.randint(1, 4)}", random.randint(1, 30), gmkey=f"G{i}") for i in range(3000)]
    col = rb.Collector(keep=15, prune_at=50)
    for i in range(0, len(rows), 40):
        col.add(rows[i:i + 40])
    assert sorted(rb.pk(r) for r in col.result()) == sorted(rb.pk(r) for r in rb.retain(rows, 15))


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print("실패 없음." if not failed else f"{failed}건 실패.")
    sys.exit(1 if failed else 0)
~~~

- [ ] **Step 2: 실패 확인**

Run:

```bash
PY="D:/영상작업/축구/개발/.venv/Scripts/python.exe"
PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py
```

Expected: `ModuleNotFoundError: No module named 'record_book'` (모듈이 아직 없다).

- [ ] **Step 3: `record_book.py` 1부 작성**

<!-- create: tools/record_book.py -->
~~~python
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
~~~

- [ ] **Step 4: 테스트 통과 확인**

Run: `PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py`

Expected: 모든 줄이 `ok   test_...`이고 마지막 줄이 `실패 없음.` (콘솔 코드페이지 때문에 한글이 깨져 보일 수 있다 — `FAIL` 줄이 없고 종료 코드가 0이면 정상).

- [ ] **Step 5: 커밋**

```bash
git add tools/record_book.py tools/test_record_book.py
git commit -m "$(cat <<'EOF'
feat(records): candidate generation and ranking for the all-time record book

Parses raw/games into per-quarter / per-game / overtime candidates for 29 boards.
Official-sourced boards (player/team game, team quarter points) need no events;
event-sourced boards (player quarter, team quarter reb/ast/stl/blk) pass a two-part
validation gate against the official quarter scores and box totals, which is what
keeps 2007's duplicated assist events (Kim Seung-hyun "11 in a quarter") out.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: 저장소·멱등 반영·CLI (`record_book.py` 2부)

**Files:**
- Modify: `tools/record_book.py` (2부 추가: `MemoryStore`, `PgStore`, `apply_game`, `diff_rows`, CLI)
- Modify: `tools/test_record_book.py` (2부 테스트 추가)

**Interfaces:**
- Consumes: Task 1의 `rank_sorted`, `retain`, `build_all`, `load_game`, `game_candidates`, `pk`, `ROW_COLUMNS`, `PK_COLUMNS`, `KEEP_RANK`, `MAX_ROWS`, `LOCK_KEY`
- Produces:
  - `MemoryStore` / `PgStore(cur)` — 공통 메서드 `all_rows() / replace_all(rows) / delete_game(gmkey) -> set[(board, bucket)] / upsert(rows) / board_rows(board, bucket) / delete_rows(rows)`; `PgStore.lock()`
  - `apply_game(store, gmkey, candidates, keep=KEEP_RANK) -> {"candidates", "pruned", "boards"}` (멱등)
  - `diff_rows(expected, actual) -> (missing, extra, changed)`
  - CLI: `python record_book.py --rebuild [--dry-run] [--dump PATH] [--keep N] | --gmkeys G1,G2 | --verify`

- [ ] **Step 1: 테스트 추가 (2부)**

<!-- edit: tools/test_record_book.py -->
<!-- old -->
~~~text
if __name__ == "__main__":
    failed = 0
~~~
<!-- new -->
~~~python
def test_apply_game_is_idempotent_and_prunes():
    store = rb.MemoryStore([mk("pq.ast.max", "Q1", 20 - i, gmkey=f"OLD{i}") for i in range(15)])      # 순위 1~15가 꽉 찬 보드
    cand = [mk("pq.ast.max", "Q1", 30, gmkey="NEW"), mk("pq.ast.max", "Q1", 1, gmkey="NEW", subject="weak")]
    res = rb.apply_game(store, "NEW", cand)
    rows = by_board(store.all_rows(), "pq.ast.max", "Q1")
    assert len(rows) == 15 and max(r["value"] for r in rows) == 30 and min(r["value"] for r in rows) == 7   # 20..7 + 30, 가장 낮은 두 개(6, 5...)는 밀려남
    assert res["pruned"] == 2 and not [r for r in rows if r["subject"] == "weak"]
    before = sorted(rb.pk(r) for r in store.all_rows())
    rb.apply_game(store, "NEW", cand)
    assert sorted(rb.pk(r) for r in store.all_rows()) == before


def test_apply_game_replaces_the_games_old_rows():
    store = rb.MemoryStore([mk("pq.ast.max", "Q1", 9, gmkey="G1", subject="old")])
    rb.apply_game(store, "G1", [mk("pq.ast.max", "Q1", 8, gmkey="G1", subject="new")])
    assert [(r["subject"], r["value"]) for r in store.all_rows()] == [("new", 8)]


def test_diff_rows():
    a = [mk("x.max", "Q1", 5, gmkey="G1"), mk("x.max", "Q1", 4, gmkey="G2")]
    b = [mk("x.max", "Q1", 6, gmkey="G1"), mk("x.max", "Q1", 3, gmkey="G3")]
    missing, extra, changed = rb.diff_rows(a, b)
    assert [k[2] for k in missing] == ["G2"] and [k[2] for k in extra] == ["G3"] and [k[2] for k in changed] == ["G1"]


def test_build_all_on_a_temp_archive():
    with tempfile.TemporaryDirectory() as d:
        g = make_game()
        gd = os.path.join(d, "S99G01N1")
        os.makedirs(gd)
        meta = {"game": {"gmkey": "S99G01N1", "seasonCategoryName": "정규시즌", "isEnded": 1, "gameDate": "20261008", "gameStart": "1900",
                         "tcodeH": "H", "tcodeA": "A", "tnameH": "홈팀", "tnameA": "원정팀", "seasonName": "2026-2027"},
                "teamrecords": {"home": {"scoreq1": 20, "scoreq2": 20, "scoreq3": 20, "scoreq4": 20, "scoreeq": []},
                                "away": {"scoreq1": 18, "scoreq2": 18, "scoreq3": 18, "scoreq4": 18, "scoreeq": []}}}
        ps = [{"player": {"pcode": p["pcode"], "pname": p["pname"], "tcode": p["tcode"]}, "records": p["rec"]} for p in g["players"]]
        tr = [{"tcode": tc, "records": rec} for tc, rec in g["teams"].items()]
        for name, body in (("meta.json", meta), ("player-stat.json", ps), ("team-record.json", tr), ("text-cast.json", g["events"])):
            with open(os.path.join(gd, name), "w", encoding="utf-8") as f:
                json.dump(body, f, ensure_ascii=False)
        rows, stats = rb.build_all(d)
        assert stats["games"] == 1 and rows and any(r["board"] == "pg.pts.max" for r in rows)


class _FakeCur:
    """PgStore가 만드는 SQL 모양만 확인하는 가짜 커서(DB 없이)."""

    def __init__(self, rows=()):
        import types
        self.connection = types.SimpleNamespace(encoding="UTF8")
        self.statements, self._rows = [], list(rows)

    def execute(self, sql, params=None):
        self.statements.append((sql.decode() if isinstance(sql, bytes) else sql, params))

    def mogrify(self, template, args):
        return ("(" + ",".join(repr(a) for a in args) + ")").encode()

    def fetchall(self):
        return self._rows


def test_pgstore_sql_shape():
    try:
        import psycopg2  # noqa: F401
    except ImportError:
        print("    (건너뜀: psycopg2 없음)")
        return
    cur = _FakeCur()
    store = rb.PgStore(cur)
    store.upsert([mk("pq.ast.max", "Q1", 9, gmkey="G1"), mk("pq.ast.max", "Q1", 9, gmkey="G1")])      # 같은 키 두 번 -> 한 행
    sql = cur.statements[-1][0]
    assert sql.count("(") >= 1 and "insert into record_entries (board, bucket, gmkey, subject, period, value" in sql, sql
    assert "on conflict (board, bucket, gmkey, subject, period) do update set value = excluded.value" in sql, sql
    assert "board = excluded.board" not in sql and "gmkey = excluded.gmkey" not in sql, sql              # 키 열은 갱신하지 않는다
    assert sql.count("pq.ast.max") == 1, sql
    store.replace_all([])
    assert cur.statements[-1][0] == "delete from record_entries"
    store.lock()
    assert "pg_advisory_xact_lock" in cur.statements[-1][0] and cur.statements[-1][1] == (rb.LOCK_KEY,)
    cur2 = _FakeCur(rows=[("pq.ast.max", "Q1")])
    assert rb.PgStore(cur2).delete_game("G1") == {("pq.ast.max", "Q1")}
    assert "delete from record_entries where gmkey = %s returning board, bucket" in cur2.statements[-1][0]


# ---------------------------------------------------------------------------
# 실데이터 - RECORD_BOOK_SLOW=1
# ---------------------------------------------------------------------------

def test_known_records_on_real_data():
    if os.environ.get("RECORD_BOOK_SLOW") != "1" or not os.path.isdir(rb.RAW_GAMES):
        print("    (건너뜀: RECORD_BOOK_SLOW=1 이고 raw/games가 있을 때만)")
        return
    rows, stats = rb.build_all()
    assert stats["games"] > 5000, stats
    assert len(rows) < rb.MAX_ROWS, len(rows)

    def top(board, bucket=None, n=1):
        rs = [r for r in rows if r["board"] == board and (bucket is None or r["bucket"] == bucket)]
        if bucket is None and board.startswith(("pq.", "tq.")):
            rs = rb.all_quarters(rs)
        return [(rank, r) for rank, r in rb.rank_sorted(rs) if rank <= n]

    r1 = top("pq.ast.max")                                       # 쿼터 어시스트 전체 1위: 허훈 9개(2026-10-07)
    assert [(r["value"], r["gmkey"]) for _, r in r1] == [(9, "S49G01N9")], r1
    r2 = top("pq.ast.max", n=2)
    eights = [r for rank, r in r2 if rank == 2]
    assert len(eights) == 6 and {r["value"] for r in eights} == {8} and "S35G01N201" in {r["gmkey"] for r in eights}, eights
    assert "S11G01N263" not in {r["gmkey"] for r in rows if r["board"] == "pq.ast.max"}        # 김승현 11개(이벤트 중복)는 검증에서 걸러진다
    assert "S21G01N214" not in {r["gmkey"] for r in rows if r["board"] == "pq.ast.max" and r["value"] >= 9}
    q1 = top("tq.pts.max", "Q1")
    assert (q1[0][1]["value"], q1[0][1]["gmkey"]) == (41, "S43G01N58")
    q1min = [r for rank, r in top("tq.pts.min", "Q1")]
    assert q1min[0]["value"] == 2 and "S37G01N128" in {r["gmkey"] for r in q1min}
    tg = [(r["value"], r["gmkey"]) for _, r in top("tg.pts.max", n=3)]                       # 2009-01-21 3차 연장 135-132(원주동부-서울삼성)가 1·2위
    assert tg == [(135, "S13G01N167"), (132, "S13G01N167"), (121, "S31G01N245")], tg
    assert not [r for r in rows if r["gmkey"] == "S13G01N167" and r["board"] == "tq.pts.max"]   # 연장 점수 배열이 틀린 경기는 팀 쿼터 보드에서 빠진다
    pg = top("pg.ast.max")[0][1]
    assert (pg["value"], pg["gmkey"]) == (21, "S35G01N201")


if __name__ == "__main__":
    failed = 0
~~~

- [ ] **Step 2: 실패 확인**

Run: `PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py`

Expected: 새 테스트들이 `FAIL ... AttributeError: module 'record_book' has no attribute 'MemoryStore'`(또는 `apply_game`, `PgStore`)로 실패한다.

- [ ] **Step 3: 2부 구현**

<!-- edit: tools/record_book.py -->
<!-- old -->
~~~text
# (Task 2가 이 아래에 저장소·반영·CLI를 이어 붙인다)
~~~
<!-- new -->
~~~python
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
~~~

- [ ] **Step 4: 단위 테스트 통과 확인**

Run: `PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py`

Expected: `FAIL` 줄 없음(실데이터 테스트는 `(건너뜀: ...)`가 찍힌다).

- [ ] **Step 5: 실데이터 단언 테스트 (약 30초)**

Run:

```bash
RECORD_BOOK_SLOW=1 PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py
```

Expected: `ok   test_known_records_on_real_data`. 확인되는 사실: 쿼터 어시스트 전체 1위 허훈 9개(S49G01N9)와 공동 2위 8개 6건, 김승현 2007·이정석 2013 항목이 없음, 팀 쿼터 1Q 최다 41점(정관장), 1Q 최소 2점(전자랜드 S37G01N128), 팀 경기 최다 135·132점(원주동부·서울삼성 S13G01N167, 2009-01-21 3차 연장)·3위 121점(KT), 선수 경기 어시스트 21(허훈 2020-02-09).

> 별도 git 작업트리에서 돌릴 땐 `raw/`가 없으므로 `RECORD_BOOK_RAW="D:/영상작업/축구/개발/kbl_realdata/raw/games"`를 같이 준다.

- [ ] **Step 6: CLI 드라이런 (DB 없이 전체 계산)**

Run:

```bash
PYTHONIOENCODING=utf-8 "$PY" tools/record_book.py --rebuild --dry-run
```

Expected(숫자는 경기가 늘면 조금 커진다): `경기 5682개(이벤트 검증 통과 5231개), 후보 1513025개` 근처, `보관 행 2773개 / 보드·구간 80개`. 종료 코드 0.

- [ ] **Step 7: 커밋**

```bash
git add tools/record_book.py tools/test_record_book.py
git commit -m "$(cat <<'EOF'
feat(records): idempotent per-game merge, Postgres store and CLI for record_entries

apply_game() deletes the game's old rows, upserts its candidates and prunes every
touched (board, bucket) back to rank <= 15, so the laptop collector and the cloud
runner can both settle the same game. --rebuild replaces the table in one
transaction; --verify diffs the table against a fresh computation.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: 경기 종료 정산 훅 (비치명)

**Files:**
- Modify: `tools/live_collector.py` (`run_record_book` 추가, `reconcile_finished_game` 끝에 5번째 단계)
- Modify: `tools/daily_batch.py` (`run_supabase_sync`에 복구 단계)
- Create: `tools/test_record_book_hook.py`

**Interfaces:**
- Consumes: CLI `record_book.py --gmkeys G` (Task 2)
- Produces: `live_collector.run_record_book(gmkey, exe, env, timeout=300) -> int | str` (예외를 던지지 않는다), `reconcile_finished_game()` 결과 dict의 `"record_book"` 키(이벤트 이관까지 성공했을 때만), `daily_batch.run_supabase_sync()`의 `record_book.py` 단계(실패해도 `failures`에 안 들어간다)

수집기가 이 파일들을 새 프로세스마다 읽으므로, **복사본에서 먼저 적용·검증한 뒤** 같은 편집을 실제 파일에 적용한다.

- [ ] **Step 1: 복사본 만들기**

```bash
TMP="$(mktemp -d)"
cp tools/*.py "$TMP"/
echo "$TMP"
```

- [ ] **Step 2: 훅 테스트를 복사본과 실제 `tools/`에 작성**

<!-- create: tools/test_record_book_hook.py -->
~~~python
# -*- coding: utf-8 -*-
"""역대 기록 정산 훅 회귀 테스트 - DB·네트워크 없이 subprocess를 가짜로 바꿔 실행 순서와
"기록 반영이 실패해도 정산 결과(ok)는 그대로"인지 확인한다.

설계: docs/superpowers/specs/2026-10-08-record-book-design.md §7
실행:  python test_record_book_hook.py
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import daily_batch as db  # noqa: E402
import live_collector as lc  # noqa: E402


class _Done:
    def __init__(self, returncode):
        self.returncode = returncode


def _reconcile(codes=None, timeout_on=None):
    """reconcile_finished_game을 가짜 subprocess로 실행 -> (결과 dict, 실행한 스크립트 이름 목록)."""
    calls = []
    saved = {k: getattr(lc, k) for k in ("official_box_ready", "load_env_supabase", "resolve_python")}
    saved_run, saved_fetch = subprocess.run, lc.fkd.fetch_one_game
    lc.official_box_ready = lambda gmkey: (True, "1-0")
    lc.load_env_supabase = lambda: None
    lc.resolve_python = lambda: "python"
    lc.fkd.fetch_one_game = lambda gmkey, force=False: "ok"

    def fake_run(argv, **kwargs):
        calls.append(os.path.basename(argv[1]))
        if timeout_on and argv[1] == timeout_on:
            raise subprocess.TimeoutExpired(argv, 1)
        return _Done((codes or {}).get(argv[1], 0))

    subprocess.run = fake_run
    try:
        return lc.reconcile_finished_game("S99G01N1"), calls
    finally:
        subprocess.run = saved_run
        lc.fkd.fetch_one_game = saved_fetch
        for k, v in saved.items():
            setattr(lc, k, v)


def test_settlement_runs_record_book_last():
    result, calls = _reconcile()
    assert calls == ["migrate_to_supabase.py", "migrate_game_events_to_supabase.py", "record_book.py"], calls
    assert result["ok"] is True and result["record_book"] == 0, result


def test_record_book_failure_does_not_fail_the_settlement():
    result, calls = _reconcile(codes={"record_book.py": 1})
    assert result["ok"] is True and result["record_book"] == 1, result
    assert calls[-1] == "record_book.py"


def test_record_book_timeout_does_not_fail_the_settlement():
    result, _ = _reconcile(timeout_on="record_book.py")
    assert result["ok"] is True and result["record_book"] == "error: TimeoutExpired", result


def test_record_book_is_skipped_when_settlement_failed():
    for failing in ("migrate_to_supabase.py", "migrate_game_events_to_supabase.py"):
        result, calls = _reconcile(codes={failing: 2})
        assert result["ok"] is False and "record_book" not in result, (failing, result)
        assert "record_book.py" not in calls, (failing, calls)


def test_daily_batch_recovers_record_book_without_counting_its_failure():
    steps = []
    saved = (db.step, db.child_env, db.resolve_python)
    db.child_env = lambda: {"DATABASE_URL": "postgres://example"}
    db.resolve_python = lambda: "python"

    def fake_step(argv, label, failures, env=None):
        steps.append(label)
        if label == "record_book.py":
            failures.append("record_book.py exit 1")      # 실패를 흉내 - 넘겨받은 리스트에만 쌓인다
        return 0

    db.step = fake_step
    try:
        failures = db.run_supabase_sync(["S99G01N1", "S99G01N2"], [])
    finally:
        db.step, db.child_env, db.resolve_python = saved
    assert steps.index("record_book.py") > steps.index("migrate_game_events_to_supabase.py"), steps
    assert failures == [], failures                         # 기록 반영 실패는 배치 실패로 세지 않는다


def test_daily_batch_skips_record_book_without_new_games():
    steps = []
    saved = (db.step, db.child_env, db.resolve_python)
    db.child_env = lambda: {"DATABASE_URL": "postgres://example"}
    db.resolve_python = lambda: "python"
    db.step = lambda argv, label, failures, env=None: steps.append(label) or 0
    try:
        db.run_supabase_sync([], [])
    finally:
        db.step, db.child_env, db.resolve_python = saved
    assert "record_book.py" not in steps, steps


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  ok   {name}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  FAIL {name}: {type(exc).__name__}: {exc}")
    print("실패 없음." if not failed else f"{failed}건 실패.")
    sys.exit(1 if failed else 0)
~~~

그리고 같은 파일을 복사본에도 둔다: `cp tools/test_record_book_hook.py "$TMP"/`

- [ ] **Step 3: 복사본에서 실패 확인**

Run: `cd "$TMP" && PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py`

Expected: `test_settlement_runs_record_book_last`·`test_record_book_failure_does_not_fail_the_settlement` 등이 `FAIL`(아직 훅이 없다 - `calls == [...]`에 `record_book.py`가 없다).

- [ ] **Step 4: 복사본(`$TMP`)의 두 파일에 아래 편집을 적용**

편집은 `tools/live_collector.py`, `tools/daily_batch.py`와 동일한 문자열이다(복사본의 같은 이름 파일에 적용).

<!-- edit: tools/live_collector.py -->
<!-- old -->
~~~text
def reconcile_finished_game(gmkey, python_exe=None, timeout=1800):
~~~
<!-- new -->
~~~text
RECORD_BOOK_TIMEOUT = 300


def run_record_book(gmkey, exe, env, timeout=RECORD_BOOK_TIMEOUT):
    """역대 기록 반영(record_book.py --gmkeys) - 설계: docs/superpowers/specs/2026-10-08-record-book-design.md.
    **실패해도 정산 결과(ok)에 영향을 주지 않는다.** 기록 테이블은 부가 기능이고, 놓친 경기는 다음 날 06:00
    daily_batch.run_supabase_sync가 같은 호출로 복구한다(멱등). 예외를 밖으로 던지지 않는다 - 이 함수가
    수집 루프를 죽이면 안 된다. 반환: 종료코드(int) 또는 "error: <예외 종류>"."""
    try:
        p = subprocess.run([exe, "record_book.py", "--gmkeys", gmkey], cwd=BASE, env=env, timeout=timeout)
        log(f"    record_book.py -> exit {p.returncode}")
        return p.returncode
    except Exception as e:  # noqa: BLE001
        log(f"    record_book.py 실패(정산에는 영향 없음): {type(e).__name__}: {e}")
        return f"error: {type(e).__name__}"


def reconcile_finished_game(gmkey, python_exe=None, timeout=1800):
~~~

<!-- edit: tools/live_collector.py -->
<!-- old -->
~~~text
    result["ok"] = not failures
    if failures:
        result["why"] = "; ".join(failures)
        log(f"    정산 실패 - {result['why']}")
    return result
~~~
<!-- new -->
~~~text
    result["ok"] = not failures
    if failures:
        result["why"] = "; ".join(failures)
        log(f"    정산 실패 - {result['why']}")
    else:
        # 5) 역대 기록 - 이벤트 이관까지 성공한 경기만(공식 데이터가 확정된 뒤여야 검증 게이트가 의미 있다).
        result["record_book"] = run_record_book(gmkey, exe, env)
    return result
~~~

<!-- edit: tools/daily_batch.py -->
<!-- old -->
~~~text
        step([exe, "migrate_game_events_to_supabase.py", "--gmkeys", gmkeys_arg, "--replace"],
             "migrate_game_events_to_supabase.py", failures, env)
    else:
~~~
<!-- new -->
~~~text
        step([exe, "migrate_game_events_to_supabase.py", "--gmkeys", gmkeys_arg, "--replace"],
             "migrate_game_events_to_supabase.py", failures, env)
        # 역대 기록(record_entries) - 라이브 정산 훅(live_collector.run_record_book)이 놓친 경기를 복구한다. 멱등이고 부가 기능이라
        # 실패해도 배치 실패로 세지 않는다(별도 리스트에 담아 버린다). 설계: docs/superpowers/specs/2026-10-08-record-book-design.md
        step([exe, "record_book.py", "--gmkeys", gmkeys_arg], "record_book.py", [], env)
    else:
~~~

- [ ] **Step 5: 복사본에서 통과 확인**

Run: `cd "$TMP" && PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py`

Expected: 6개 테스트 모두 `ok`, `FAIL` 없음.

- [ ] **Step 6: 같은 편집을 실제 `tools/live_collector.py`, `tools/daily_batch.py`에 적용하고 즉시 확인**

Run:

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" -c "import live_collector, daily_batch; print('import ok')"
PYTHONIOENCODING=utf-8 "$PY" test_record_book_hook.py
cd ..
```

Expected: `import ok`, 6개 테스트 `ok`. (import가 실패하면 즉시 되돌린다: `git checkout -- tools/live_collector.py tools/daily_batch.py` — 수집기가 다음 실행에서 이 파일을 읽는다.)

- [ ] **Step 7: 커밋**

```bash
git add tools/live_collector.py tools/daily_batch.py tools/test_record_book_hook.py
git commit -m "$(cat <<'EOF'
feat(records): hook record_book into game settlement and the daily recovery batch

reconcile_finished_game() runs record_book.py --gmkeys as a fifth step only after the
events migration succeeded; its failure or timeout never changes the settlement's ok.
daily_batch re-runs it for the recovered games (idempotent) and does not count it as a
batch failure.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: 테이블 정의(DDL)와 롤백, 스키마 일치 테스트

**Files:**
- Create: `tools/schema_record_book.sql`, `tools/rollback_record_book.sql`
- Modify: `tools/test_record_book.py` (스키마가 `ROW_COLUMNS`와 일치하는지 고정)

**Interfaces:**
- Produces: 테이블 `record_entries` (열·순서 = `record_book.ROW_COLUMNS`, 키 = `PK_COLUMNS`), RLS 켬 + 정책 없음 + `anon`/`authenticated` 권한 회수. **DDL 적용은 Task 11에서 사용자 확인 후.**

- [ ] **Step 1: 스키마 테스트 추가**

<!-- edit: tools/test_record_book.py -->
<!-- old -->
~~~text
# ---------------------------------------------------------------------------
# 실데이터 - RECORD_BOOK_SLOW=1
~~~
<!-- new -->
~~~python
def test_schema_sql_matches_row_columns():
    """schema_record_book.sql과 record_book.ROW_COLUMNS가 어긋나면(열 추가/이름 변경 한쪽만) 여기서 잡는다."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema_record_book.sql")
    with open(path, encoding="utf-8") as f:
        body = f.read()
    cols = re.findall(r"^\s{2}(\w+)\s+(?:text|integer|date|boolean)", body, flags=re.M)
    assert tuple(cols) == rb.ROW_COLUMNS, cols
    assert "primary key (" + ", ".join(rb.PK_COLUMNS) + ")" in body
    assert "enable row level security" in body and "revoke all on record_entries from anon, authenticated" in body
    assert "create policy" not in body, "정책을 만들면 익명 접근이 열릴 수 있다"


# ---------------------------------------------------------------------------
# 실데이터 - RECORD_BOOK_SLOW=1
~~~

- [ ] **Step 2: 실패 확인**

Run: `PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py`

Expected: `FAIL test_schema_sql_matches_row_columns: FileNotFoundError` (SQL 파일이 아직 없다).

- [ ] **Step 3: SQL 파일 작성**

<!-- create: tools/schema_record_book.sql -->
~~~sql
-- 역대 기록(Record Book) 1단계 - docs/superpowers/specs/2026-10-08-record-book-design.md §6
-- 적용: README "역대 기록" 런북 참고. 롤백: rollback_record_book.sql.
-- 서버(서비스 키)와 DATABASE_URL 쓰기 스크립트(tools/record_book.py)만 접근한다 - 정책을 만들지 않고 anon/authenticated 권한도 회수해 익명 접근을 막는다.
create table if not exists record_entries (
  board        text    not null,                 -- 'pq.ast.max' = 대상(p/t) + 단위(q/g) . 종목 . 방향(max/min)
  bucket       text    not null,                 -- 'Q1'..'Q4' | 'OT' | 'G' ('ALL'은 저장하지 않는다 - Q1~Q4 항목의 합집합)
  gmkey        text    not null,
  subject      text    not null,                 -- pcode(선수 보드) / tcode(팀 보드)
  period       text    not null,                 -- 쿼터 보드: 'Q1'..'Q4','X1'..'X4' / 경기 보드: ''
  value        integer not null,
  game_date    date    not null,
  game_start   text    not null default '',      -- 'HH:MM' (같은 날 경기 순서)
  season_name  text    not null,
  category     text    not null,                 -- 정규시즌 / 플레이오프 / 챔피언결정전
  subject_name text    not null,
  tcode        text    not null,                 -- 소속 팀(팀 보드면 subject와 같다)
  opp_tcode    text    not null,
  is_ot        boolean not null default false,   -- 연장이 있었던 경기(표시용)
  primary key (board, bucket, gmkey, subject, period)
);
create index if not exists record_entries_board_idx on record_entries (board, bucket, value);
alter table record_entries enable row level security;
revoke all on record_entries from anon, authenticated;
~~~

<!-- create: tools/rollback_record_book.sql -->
~~~sql
-- 역대 기록(Record Book) 롤백 - schema_record_book.sql로 만든 것을 되돌린다. 다른 테이블·앱에는 영향이 없다.
-- 함께 할 일: 정산 훅 제거(live_collector.run_record_book 호출, daily_batch의 record_book.py 단계), 웹의 records 연결은 테이블이 없으면 알아서 사라진다.
drop table if exists record_entries;
~~~

- [ ] **Step 4: 통과 확인**

Run: `PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py`

Expected: `FAIL` 없음, 목록에 `ok   test_schema_sql_matches_row_columns`.

- [ ] **Step 5: 커밋**

```bash
git add tools/schema_record_book.sql tools/rollback_record_book.sql tools/test_record_book.py
git commit -m "$(cat <<'EOF'
feat(records): record_entries DDL (RLS on, no policy, anon revoked) and rollback

A test keeps the SQL columns and the Python ROW_COLUMNS in lockstep.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: 웹 라이브 엔진 `lib/records.ts`

**Files:**
- Create: `courtside-web/lib/records.ts`
- Create: `courtside-web/lib/records.test.ts`

**Interfaces:**
- Consumes: `lib/boxEvents.ts`의 `applyBoxEvent`, `emptyBoxLine`, `BoxLine`
- Produces (이후 Task가 쓴다):
  - 타입 `RecordMetric`, `RecordDir`, `BoardSummary {tops: number[]; holders: {v, who, d}[]}`, `RecordContext {asOf; boards: Record<"board|bucket", BoardSummary>; validated?: string[]}`, `RecordEvent {pcode, tcode, action_code, quarter, clock_min?, clock_sec?}`, `RecordNames {player(pcode), team(tcode)}`, `RecordMoment`
  - `TOP_RANKS = 10`, `NEAR_GAP`, `rankInfo(tops, value, dir) -> RankInfo | null`, `nextTarget(tops, value) -> number | null`
  - `class RecordAccumulator { apply(e): Change[]; teamPeriodPoints(period); teamGamePoints(); finalValues(): Map<"board|bucket|subject|period", number> }`
  - `buildRecordTimeline(ctx, events, {names, final}) -> RecordMoment[]` (idx 오름차순), `doneUpTo(moments, idx)`, `nearAt(moments, idx)`, `recordToast(m) -> {icon, title, msg}`, `validatedKey(m)`

- [ ] **Step 1: 테스트 작성**

<!-- create: courtside-web/lib/records.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import {
  buildRecordTimeline,
  doneUpTo,
  nearAt,
  nextTarget,
  rankInfo,
  RecordAccumulator,
  recordToast,
  type BoardSummary,
  type RecordContext,
  type RecordEvent,
} from "./records";

const names = { player: (p: string) => (p === "h" ? "허훈" : `선수${p}`), team: (t: string) => `팀${t}` };
const WHO = ["문태종", "박지현", "허훈", "이정현", "마레이", "박지훈", "김승현", "이정석"];

/** tops(좋은 순)에서 순위 <= 3 항목만 보유자로 붙인 요약. */
function board(tops: number[]): BoardSummary {
  const holders: BoardSummary["holders"] = [];
  let rank = 0;
  let last: number | null = null;
  tops.forEach((v, i) => {
    if (v !== last) {
      rank = i + 1;
      last = v;
    }
    if (rank <= 3 && holders.length < 6) holders.push({ v, who: WHO[i % WHO.length], d: "2020-02-09" });
  });
  return { tops, holders };
}
const ctxOf = (boards: Record<string, number[]>, validated?: string[]): RecordContext => ({
  asOf: "2026-10-07",
  boards: Object.fromEntries(Object.entries(boards).map(([k, t]) => [k, board(t)])),
  ...(validated ? { validated } : {}),
});

let seq = 0;
const ev = (pcode: string | null, tcode: string | null, code: string, quarter = "Q1", min = 8, sec = 0): RecordEvent => ({ pcode, tcode, action_code: code, quarter, clock_min: min, clock_sec: sec + (seq++ % 50) });
const repeat = (n: number, f: (i: number) => RecordEvent) => Array.from({ length: n }, (_, i) => f(i));

const EIGHTS = [8, 8, 8, 8, 8, 8, 7, 7, 7, 7]; // 이 경기 이전의 한 쿼터 최다 어시스트: 8개 6건 공동 1위, 7개 공동 7위

describe("rankInfo / nextTarget", () => {
  it("공동 순위, 신기록, 타이", () => {
    expect(rankInfo(EIGHTS, 9, "max")).toEqual({ rank: 1, tie: false, breaks: true, best: 8, n1: 6 });
    expect(rankInfo(EIGHTS, 8, "max")).toMatchObject({ rank: 1, tie: true, breaks: false });
    expect(rankInfo(EIGHTS, 7, "max")).toMatchObject({ rank: 7, tie: true });
    expect(rankInfo(EIGHTS, 6, "max")).toMatchObject({ rank: 11, tie: false }); // 10위 밖
    expect(rankInfo([], 5, "max")).toBeNull();
    expect(rankInfo([2, 2, 3, 3], 2, "min")).toMatchObject({ rank: 1, tie: true, breaks: false });
    expect(rankInfo([3, 3, 4], 2, "min")).toMatchObject({ rank: 1, breaks: true });
  });

  it("다음 기록 선 = 상위 3위 값과 신기록(1위 + 1) 중 현재 값 바로 위", () => {
    expect(nextTarget(EIGHTS, 5)).toBe(8);
    expect(nextTarget(EIGHTS, 8)).toBe(9);
    expect(nextTarget(EIGHTS, 9)).toBeNull();
    expect(nextTarget([20, 18, 18, 15, 14], 16)).toBe(18); // 15는 4위라 선이 아니다
  });
});

describe("RecordAccumulator", () => {
  it("선수·팀의 쿼터/경기 누적과 테이블 키, 팀 득점은 최소 보드 키도", () => {
    const acc = new RecordAccumulator();
    for (const e of [ev("p", "T", "201"), ev("p", "T", "205"), ev("p", "T", "202", "Q2"), ev("q", "T", "211"), ev("p", "T", "209", "X1")]) acc.apply(e);
    const v = acc.finalValues();
    expect(v.get("pq.pts.max|Q1|p|Q1")).toBe(5);
    expect(v.get("pg.pts.max|G|p|")).toBe(5);
    expect(v.get("pq.tpm.max|Q1|p|Q1")).toBe(1);
    expect(v.get("tq.pts.max|Q1|T|Q1")).toBe(5);
    expect(v.get("tq.pts.min|Q1|T|Q1")).toBe(5);
    expect(v.get("tq.ast.max|Q1|T|Q1")).toBe(1);
    expect(v.get("tg.fgm.max|G|T|")).toBe(2);
    expect(v.get("tg.fgmiss.max|G|T|")).toBe(1);
    expect(v.get("pq.reb.max|OT|p|X1")).toBe(1);                 // 연장은 OT 구간
    expect(v.has("tq.pts.min|OT|T|X1")).toBe(false);             // 연장 최소 보드는 없다
  });

  it("선수 귀속이 아닌 이벤트·경기 시작 전(PRE)은 세지 않는다", () => {
    const acc = new RecordAccumulator();
    expect(acc.apply(ev(null, "T", "201"))).toEqual([]);
    expect(acc.apply(ev("p", null, "201"))).toEqual([]);
    expect(acc.apply(ev("p", "T", "201", "PRE"))).toEqual([]);
    expect(acc.apply({ pcode: "p", tcode: "T", action_code: null, quarter: "Q1" })).toEqual([]);
    expect(acc.finalValues().size).toBe(0);
  });
});

describe("buildRecordTimeline - 허훈 1쿼터 9어시스트(경기 이전 기록 8개)", () => {
  const boards = { "pq.ast.max|Q1": EIGHTS, "pq.ast.max|ALL": EIGHTS };
  const events = repeat(9, (i) => ev("h", "K", "211", "Q1", 9 - i, 0));

  it("7개는 공동 7위, 8개는 타이 기록(공동 1위), 9개는 신기록 - 순위가 좋아질 때만 알린다", () => {
    const m = buildRecordTimeline(ctxOf(boards), events, { names, final: false });
    const done = m.filter((x) => x.phase === "done");
    expect(done.map((x) => [x.idx, x.rank, x.tie, x.breaks])).toEqual([
      [6, 7, true, false],
      [7, 1, true, false],
      [8, 1, false, true],
    ]);
    expect(done[2]).toMatchObject({ name: "허훈", bucket: "Q1", period: "Q1", board: "pq.ast.max", value: 9, provisional: true, sig: 0 });
    expect(done[2].text).toBe("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(done[2].detail).toBe("1쿼터 기준 신기록 · 종전 최고 8개: 문태종·박지현·허훈 외 3건");
    expect(done[1].text).toBe("1쿼터 어시스트 8개 KBL 타이 기록(공동 1위)");
    expect(done[0].text).toBe("1쿼터 어시스트 7개 KBL 역대 공동 7위");
    expect(done[0].clock).toMatch(/^Q1 3:\d{2}$/);                  // 7번째 이벤트 = 남은 시간 3분대
  });

  it("임박은 기록 선까지 2개 이내일 때 열리고 값이 바뀔 때마다 새로 열리며, 달성 때 닫힌다", () => {
    const m = buildRecordTimeline(ctxOf(boards), events, { names, final: false });
    const near = m.filter((x) => x.phase === "near");
    expect(near.map((x) => [x.idx, x.value, x.remaining, x.until])).toEqual([
      [5, 6, 2, 6],
      [6, 7, 1, 7],
      [7, 8, 1, 8],
    ]);
    expect(near[0].text).toBe("1쿼터 어시스트 6개 · 2개 더하면 KBL 타이 기록(공동 1위)");
    expect(near[2].text).toBe("1쿼터 어시스트 8개 · 1개 더하면 KBL 신기록(종전 8개)");
    expect(nearAt(m, 6).map((x) => x.value)).toEqual([7]);    // 스크럽 위치 6에서 유효한 임박은 하나뿐
    expect(nearAt(m, 8)).toEqual([]);                          // 9개를 채운 뒤엔 임박이 없다
    expect(doneUpTo(m, 7).map((x) => x.idx)).toEqual([7, 6]);  // 최근 것이 위
  });

  it("종료 경기는 테이블(validated)에 있는 항목만 남기고 잠정 표시가 없다", () => {
    const ok = buildRecordTimeline(ctxOf(boards, ["pq.ast.max|Q1|h|Q1"]), events, { names, final: true });
    expect(ok.filter((x) => x.phase === "done")).toHaveLength(3);
    expect(ok.every((x) => x.provisional === false)).toBe(true);
    expect(buildRecordTimeline(ctxOf(boards, []), events, { names, final: true })).toEqual([]);
    expect(buildRecordTimeline(ctxOf(boards, ["pq.ast.max|Q2|h|Q2"]), events, { names, final: true })).toEqual([]);
  });

  it("보드가 없으면(요약에 없는 종목) 아무것도 안 만든다", () => {
    expect(buildRecordTimeline(ctxOf({}), events, { names, final: false })).toEqual([]);
  });
});

describe("buildRecordTimeline - 순위 변화가 없으면 다시 알리지 않는다", () => {
  it("2위 구간에서 값이 올라도 순위가 같으면 한 번만, 1위를 넘으면 신기록", () => {
    const tops = [30, 5, 5, 5, 4, 4, 3, 3, 2, 2];
    const events = repeat(16, () => ev("p", "T", "201", "Q3")); // 쿼터 득점 2, 4, ... 32
    const m = buildRecordTimeline(ctxOf({ "pq.pts.max|Q3": tops }), events, { names, final: false }).filter((x) => x.phase === "done");
    // 2 = 공동 9위, 4 = 공동 5위, 6~28 = 2위(1위 30 하나뿐이라 값이 올라도 순위 그대로 -> 다시 안 알림), 30 = 타이, 32 = 신기록
    expect(m.map((x) => [x.value, x.rank, x.breaks])).toEqual([
      [2, 9, false],
      [4, 5, false],
      [6, 2, false],
      [30, 1, false],
      [32, 1, true],
    ]);
  });

  it("신기록을 깬 뒤 기록을 계속 늘리면 값이 오를 때마다 다시 알린다(11개 -> 12개 -> 13개)", () => {
    const events = repeat(13, () => ev("p", "T", "205", "Q2"));          // 3점슛 13개(득점 39)
    const m = buildRecordTimeline(ctxOf({ "pg.tpm.max|G": [10, 10, 9, 9, 9, 8, 8, 8, 8, 8] }), events, { names, final: false }).filter((x) => x.phase === "done" && x.board === "pg.tpm.max");
    expect(m.map((x) => [x.value, x.rank, x.breaks])).toEqual([
      [8, 6, false], // 8개 = 공동 6위
      [9, 3, false],
      [10, 1, false],
      [11, 1, true],
      [12, 1, true],
      [13, 1, true],
    ]);
    expect(new Set(m.map((x) => x.id)).size).toBe(m.length);              // 알림 id는 값마다 달라 토스트가 서로 덮이지 않는다
    expect(m[m.length - 1].text).toBe("한 경기 3점슛 13개 KBL 신기록(종전 10개)");
  });

  it("첫 값부터 TOP10 밖이면 아무것도 안 만든다", () => {
    const events = repeat(1, () => ev("p", "T", "201", "Q3"));
    expect(buildRecordTimeline(ctxOf({ "pq.pts.max|Q3": [30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20] }), events, { names, final: false })).toEqual([]);
  });
});

describe("buildRecordTimeline - 팀·경기·연장·최소 보드", () => {
  it("팀 쿼터 득점 최다: 한 이벤트로 40점 타이(공동 2위) -> 42점 신기록", () => {
    const tops = [41, 40, 40, 40, 39, 39, 39, 38, 38, 38, 38];
    const events = repeat(21, () => ev("p", "T", "201", "Q1"));
    const m = buildRecordTimeline(ctxOf({ "tq.pts.max|Q1": tops, "tq.pts.max|ALL": tops }), events, { names, final: false }).filter((x) => x.phase === "done");
    expect(m.filter((x) => x.scope === "t").map((x) => [x.idx, x.value, x.rank, x.breaks])).toEqual([
      [18, 38, 8, false], [19, 40, 2, false], [20, 42, 1, true],
    ]);
    expect(m[m.length - 1]).toMatchObject({ name: "팀T", tcode: "T", bucket: "Q1", period: "Q1" });
    expect(m[m.length - 1].text).toBe("1쿼터 득점 42점 KBL 신기록(종전 41점)");
  });

  it("연장은 OT 구간만(ALL에 섞이지 않는다), 저장 구간은 OT, 기간은 X1", () => {
    const events = repeat(11, () => ev("p", "T", "201", "X1", 4));
    const m = buildRecordTimeline(ctxOf({ "pq.pts.max|OT": [20, 18, 18, 16], "pq.pts.max|ALL": [1] }), events, { names, final: false });
    const done = m.filter((x) => x.phase === "done");
    expect(done[done.length - 1]).toMatchObject({ bucket: "OT", period: "X1", breaks: true, value: 22 });
    expect(done[done.length - 1].text).toBe("연장 득점 22점 KBL 신기록(종전 20점)");
  });

  it("경기 보드: 선수 경기 어시스트 21개 타이 - 구간 G, 기간 빈 문자열", () => {
    const events = [...repeat(10, () => ev("p", "T", "211", "Q1")), ...repeat(11, () => ev("p", "T", "211", "Q3"))];
    const m = buildRecordTimeline(ctxOf({ "pg.ast.max|G": [21, 17, 16, 16, 15] }), events, { names, final: false }).filter((x) => x.phase === "done");
    expect(m[m.length - 1]).toMatchObject({ idx: 20, bucket: "G", period: "", rank: 1, tie: true, board: "pg.ast.max" });
    expect(m[m.length - 1].text).toBe("한 경기 어시스트 21개 KBL 타이 기록(공동 1위)");
  });

  it("팀 쿼터 최소 득점은 쿼터가 끝난 뒤에만 판정한다(다음 쿼터 첫 이벤트에서, 종료 경기는 마지막 쿼터도)", () => {
    const tens = (v: number) => Array<number>(10).fill(v);
    const boards = { "tq.pts.min|Q2": tens(3), "tq.pts.min|ALL": [2, 2, ...Array<number>(8).fill(3)] };
    const events = [ev("p", "T", "201", "Q2"), ev("q", "U", "201", "Q2"), ev("q", "U", "201", "Q2"), ev("p", "T", "201", "Q3")];
    const live = buildRecordTimeline(ctxOf(boards), events, { names, final: false }).filter((x) => x.phase === "done");
    // T는 2쿼터에 2점 - 2쿼터 보드 신기록(종전 3점), 전체 보드로는 공동 1위. U는 4점이라 두 보드 모두 TOP10(최소) 밖.
    // 3쿼터(진행 중)는 아직 안 끝났으므로 판정하지 않는다. 판정 시점은 2쿼터의 마지막 이벤트(idx 2).
    expect(live.map((x) => [x.idx, x.name, x.value, x.breaks, x.tie])).toEqual([[2, "팀T", 2, true, false]]);
    expect(live[0].text).toBe("2쿼터 최소 득점 2점 KBL 신기록(종전 3점)");
    expect(live[0].detail.startsWith("한 쿼터 기준 공동 1위")).toBe(true);
    // 종료 경기는 마지막 쿼터와 경기 끝도 판정 - 3쿼터 T 2점은 신기록, 경기 최소 보드(전부 1점)는 총점 4점이라 TOP10 밖.
    const fin = buildRecordTimeline(ctxOf({ "tq.pts.min|Q3": [5, 5], "tg.pts.min|G": tens(1) }), events, { names, final: true }).filter((x) => x.phase === "done");
    expect(fin.map((x) => [x.board, x.name, x.value])).toEqual([["tq.pts.min", "팀T", 2]]);
    // 경기 최소 득점: 총점이 보드 최소(41)보다 낮으면 경기 끝에서 신기록.
    const game = buildRecordTimeline(ctxOf({ "tg.pts.min|G": [41, 41, 43] }), events, { names, final: true }).filter((x) => x.phase === "done");
    expect(game.map((x) => [x.board, x.name, x.value, x.idx, x.breaks])).toEqual([["tg.pts.min", "팀T", 4, 3, true], ["tg.pts.min", "팀U", 4, 3, true]]);
    expect(game[0].text).toBe("한 경기 최소 득점 4점 KBL 신기록(종전 41점)");
  });

  it("턴오버는 '불명예' 문구", () => {
    const events = repeat(6, () => ev("p", "T", "214", "Q1"));
    const m = buildRecordTimeline(ctxOf({ "pq.to.max|Q1": [5, 5, 4] }), events, { names, final: false }).filter((x) => x.phase === "done");
    expect(m[m.length - 1].text).toBe("1쿼터 턴오버 6개 불명예 신기록(종전 5개)");
    expect(recordToast(m[m.length - 1])).toEqual({ icon: "🏆", title: "불명예 신기록!", msg: "(잠정) 선수p 1쿼터 턴오버 6개 불명예 신기록(종전 5개)" });
  });
});

describe("recordToast", () => {
  it("신기록 / 타이 / 상위 / 그 밖의 TOP10 아이콘과 제목", () => {
    const base = { board: "pq.ast.max", provisional: false, name: "허훈", text: "본문" } as never;
    const t = (o: object) => recordToast({ ...(base as object), ...o } as never);
    expect(t({ breaks: true, rank: 1 })).toMatchObject({ icon: "🏆", title: "KBL 신기록!" });
    expect(t({ breaks: false, rank: 1 })).toMatchObject({ icon: "🏆", title: "KBL 타이 기록" });
    expect(t({ breaks: false, rank: 3 })).toMatchObject({ icon: "🥈", title: "역대 기록" });
    expect(t({ breaks: false, rank: 8 })).toMatchObject({ icon: "🏅", title: "역대 기록", msg: "허훈 본문" });
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/records.test.ts`

Expected: FAIL — `Failed to resolve import "./records"`.

- [ ] **Step 3: 엔진 구현**

<!-- create: courtside-web/lib/records.ts -->
~~~typescript
import { applyBoxEvent, emptyBoxLine, type BoxLine } from "./boxEvents";

// 역대 기록(Record Book) 라이브 엔진 - 설계: docs/superpowers/specs/2026-10-08-record-book-design.md §8.2
//
// 서버가 "이 경기 이전" 기준으로 보드별 TOP10 값을 요약해 내려주면(lib/recordBook.ts RecordContext), 여기서는 경기 이벤트를 한 번 훑으며
// 선수·팀의 쿼터/경기 누적을 쌓고 그 값이 TOP10에 닿는 순간을 기록 이벤트(RecordMoment)로 뽑는다. 순수 함수라 클라이언트 번들에 들어가도 가볍다.
// 누적 규칙은 lib/boxEvents.ts applyBoxEvent 하나(화면 박스와 같은 규칙)이고, 파이썬 쪽 정의(tools/record_book.py)와 어긋나지 않는지는
// 대조 테스트(records.parity.test.ts)가 실제 경기로 고정한다.

export type RecordMetric = "pts" | "reb" | "ast" | "stl" | "blk" | "tpm" | "to" | "fgm" | "fgmiss";
export type RecordDir = "max" | "min";
export const TOP_RANKS = 10;

/** 보드 하나의 요약 - key는 RecordContext.boards의 `${board}|${bucket}`. */
export type BoardSummary = {
  /** 순위 <= 10 항목의 값, 좋은 순(동률은 항목 수만큼 중복). */
  tops: number[];
  /** 순위 <= 3 항목의 보유자(문구용, 최대 6개). */
  holders: { v: number; who: string; d: string }[];
};

export type RecordContext = {
  /** 요약 기준(경기 시각 이전) - 표기·디버깅용. */
  asOf: string;
  boards: Record<string, BoardSummary>;
  /** 종료 경기만: 테이블에 이 경기의 행이 있는 `${board}|${bucket}|${subject}|${period}`. 없으면(라이브·예정) 전부 "잠정"이다. */
  validated?: string[];
};

export type RecordEvent = {
  pcode: string | null;
  tcode: string | null;
  action_code: string | null;
  quarter: string;
  clock_min?: number | null;
  clock_sec?: number | null;
};
export type RecordNames = { player: (pcode: string) => string; team: (tcode: string) => string };

const P_METRICS: RecordMetric[] = ["pts", "reb", "ast", "stl", "blk", "tpm", "to"];
const TQ_METRICS: RecordMetric[] = ["pts", "reb", "ast", "stl", "blk"];
const TG_METRICS: RecordMetric[] = ["pts", "fgm", "fgmiss", "tpm", "reb", "ast", "stl", "blk"];

const METRIC_TEXT: Record<RecordMetric, { name: string; unit: string }> = {
  pts: { name: "득점", unit: "점" },
  reb: { name: "리바운드", unit: "개" },
  ast: { name: "어시스트", unit: "개" },
  stl: { name: "스틸", unit: "개" },
  blk: { name: "블락", unit: "개" },
  tpm: { name: "3점슛", unit: "개" },
  to: { name: "턴오버", unit: "개" },
  fgm: { name: "야투 성공", unit: "개" },
  fgmiss: { name: "야투 실패", unit: "개" },
};
const BUCKET_WORD: Record<string, string> = { Q1: "1쿼터", Q2: "2쿼터", Q3: "3쿼터", Q4: "4쿼터", OT: "연장", ALL: "한 쿼터", G: "한 경기" };

/** 임박 기준 - 현재 값과 다음 기록 선의 차가 이 값 이하일 때만 패널에 올린다. */
export const NEAR_GAP: Record<"p" | "t", Record<RecordMetric, number>> = {
  p: { pts: 5, reb: 2, ast: 2, stl: 1, blk: 1, tpm: 1, to: 1, fgm: 3, fgmiss: 3 },
  t: { pts: 6, reb: 3, ast: 2, stl: 2, blk: 1, tpm: 2, to: 1, fgm: 4, fgmiss: 4 },
};

function metricValue(line: BoxLine, m: RecordMetric): number {
  switch (m) {
    case "pts":
      return line.pts;
    case "reb":
      return line.reb;
    case "ast":
      return line.ast;
    case "stl":
      return line.stl;
    case "blk":
      return line.blk;
    case "tpm":
      return line.threePM;
    case "to":
      return line.to;
    case "fgm":
      return line.fgm;
    case "fgmiss":
      return line.fga - line.fgm;
  }
}

const isRegular = (period: string) => /^Q[1-4]$/.test(period);
const isOvertime = (period: string) => /^X[1-4]$/.test(period);
const bucketOfPeriod = (period: string) => (isRegular(period) ? period : isOvertime(period) ? "OT" : null);

// ── 누적 ────────────────────────────────────────────────────────────────────────────────────────

export type Change = { scope: "p" | "t"; unit: "q" | "g"; metric: RecordMetric; subject: string; period: string; value: number };

/**
 * 이벤트를 하나씩 먹으며 (선수·쿼터) (선수·경기) (팀·쿼터) (팀·경기) 누적 줄을 갱신한다. **선수 귀속 이벤트만**(pcode·tcode 둘 다 있는 것) 센다 -
 * 팀 리바운드 같은 팀 단위 이벤트는 공식 팀 합계와 어긋난다(tools/record_book.py가 같은 규칙).
 */
export class RecordAccumulator {
  private lines = new Map<string, BoxLine>();

  /** 이 이벤트로 값이 바뀐 (대상, 단위, 종목) 목록. */
  apply(e: RecordEvent): Change[] {
    if (!e.pcode || !e.tcode || !e.action_code || !e.quarter || e.quarter === "PRE") return [];
    const out: Change[] = [];
    const code = e.action_code;
    const touch = (scope: "p" | "t", unit: "q" | "g", subject: string, period: string, metrics: RecordMetric[]) => {
      const key = `${scope}${unit}|${subject}|${period}`;
      const line = this.lines.get(key) ?? emptyBoxLine();
      this.lines.set(key, line);
      const before = metrics.map((m) => metricValue(line, m));
      applyBoxEvent(line, code);
      metrics.forEach((m, i) => {
        const value = metricValue(line, m);
        if (value !== before[i]) out.push({ scope, unit, metric: m, subject, period, value });
      });
    };
    touch("p", "q", e.pcode, e.quarter, P_METRICS);
    touch("p", "g", e.pcode, "", P_METRICS);
    touch("t", "q", e.tcode, e.quarter, TQ_METRICS);
    touch("t", "g", e.tcode, "", TG_METRICS);
    return out;
  }

  /** 한 쿼터에 득점한 팀들의 그 쿼터 득점(최소 보드 판정용). */
  teamPeriodPoints(period: string): { tcode: string; pts: number }[] {
    const out: { tcode: string; pts: number }[] = [];
    for (const [key, line] of this.lines) {
      const [kind, subject, p] = key.split("|");
      if (kind === "tq" && p === period) out.push({ tcode: subject, pts: line.pts });
    }
    return out;
  }

  teamGamePoints(): { tcode: string; pts: number }[] {
    const out: { tcode: string; pts: number }[] = [];
    for (const [key, line] of this.lines) {
      const [kind, subject] = key.split("|");
      if (kind === "tg") out.push({ tcode: subject, pts: line.pts });
    }
    return out;
  }

  /** 지금까지의 값을 테이블 행 키(`${board}|${bucket}|${subject}|${period}`)로 - 파이썬 후보 행과 대조하는 데 쓴다. 최소 보드 키도 같이 넣는다. */
  finalValues(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [key, line] of this.lines) {
      const [kind, subject, period] = key.split("|");
      const scope = kind[0] as "p" | "t";
      const unit = kind[1] as "q" | "g";
      const metrics = scope === "p" ? P_METRICS : unit === "q" ? TQ_METRICS : TG_METRICS;
      const bucket = unit === "g" ? "G" : bucketOfPeriod(period);
      if (!bucket) continue;
      for (const m of metrics) {
        const v = metricValue(line, m);
        out.set(`${scope}${unit}.${m}.max|${bucket}|${subject}|${period}`, v);
        if (scope === "t" && m === "pts" && bucket !== "OT") out.set(`${scope}${unit}.${m}.min|${bucket}|${subject}|${period}`, v);
      }
    }
    return out;
  }
}

// ── 순위 ────────────────────────────────────────────────────────────────────────────────────────

export type RankInfo = { rank: number; tie: boolean; breaks: boolean; best: number; n1: number };

/** value가 보드(tops, 좋은 순)에 들어가면 몇 위인지(공동 순위). 보드가 비었으면 null. */
export function rankInfo(tops: number[], value: number, dir: RecordDir): RankInfo | null {
  if (tops.length === 0) return null;
  const rank = tops.filter((t) => (dir === "max" ? t > value : t < value)).length + 1;
  const best = tops[0];
  return { rank, tie: tops.includes(value), breaks: dir === "max" ? value > best : value < best, best, n1: tops.filter((t) => t === best).length };
}

const levelOf = (info: RankInfo) => (info.breaks ? 0 : info.rank);

/** 다음에 노릴 기록 선 - 상위 3위 값들과 "신기록(1위 + 1)" 중 현재 값 바로 위. 없으면 null. (최다 보드 전용) */
export function nextTarget(tops: number[], value: number): number | null {
  const lines = new Set<number>([tops[0] + 1]);
  let rank = 0;
  let last: number | null = null;
  tops.forEach((t, i) => {
    if (t !== last) {
      rank = i + 1;
      last = t;
    }
    if (rank <= 3) lines.add(t);
  });
  const above = [...lines].filter((t) => t > value).sort((a, b) => a - b);
  return above.length ? above[0] : null;
}

// ── 기록 이벤트 ────────────────────────────────────────────────────────────────────────────────

export type RecordMoment = {
  /** 같은 사건을 가리키는 안정 키(토스트·패널 중복 방지). */
  id: string;
  /** 이벤트 인덱스(GameReplay idx와 같은 축). */
  idx: number;
  /** near: 이 인덱스 직전까지만 임박 상태(미포함). done: Infinity. */
  until: number;
  clock: string;
  phase: "done" | "near";
  /** 'pq.ast.max' 같은 보드 키와, 테이블에 저장되는 구간('Q1'~'Q4'|'OT'|'G') - validated 키 조립용. */
  board: string;
  bucket: string;
  subject: string;
  period: string;
  scope: "p" | "t";
  name: string;
  tcode: string | null;
  value: number;
  rank: number;
  tie: boolean;
  breaks: boolean;
  /** near: 다음 기록 선까지 남은 수 / done: 0. */
  remaining: number;
  /** 이름을 뺀 본문(토스트는 이름을 앞에 붙인다). */
  text: string;
  detail: string;
  provisional: boolean;
  /** 정렬용 - 낮을수록 중요(신기록 0, 아니면 순위). */
  sig: number;
};

export const validatedKey = (m: Pick<RecordMoment, "board" | "bucket" | "subject" | "period">) => `${m.board}|${m.bucket}|${m.subject}|${m.period}`;

function clockOf(e: RecordEvent): string {
  if (!e.quarter || e.quarter === "PRE") return "경기 시작 전";
  return `${e.quarter} ${e.clock_min ?? 0}:${String(e.clock_sec ?? 0).padStart(2, "0")}`;
}

const whenWord = (unit: "q" | "g", period: string) => (unit === "g" ? "한 경기" : isRegular(period) ? `${period[1]}쿼터` : "연장");
const metricWord = (m: RecordMetric, dir: RecordDir) => (dir === "min" ? `최소 ${METRIC_TEXT[m].name}` : METRIC_TEXT[m].name);
const who = (m: RecordMetric) => (m === "to" ? "불명예" : "KBL");

function verdict(info: RankInfo, m: RecordMetric): string {
  const unit = METRIC_TEXT[m].unit;
  if (info.breaks) return `${who(m)} 신기록(종전 ${info.best}${unit})`;
  if (info.rank === 1) return `${who(m)} 타이 기록(공동 1위)`;
  return `${who(m)} 역대 ${info.tie ? "공동 " : ""}${info.rank}위`;
}
const shortVerdict = (info: RankInfo) => (info.breaks ? "신기록" : `${info.tie ? "공동 " : ""}${info.rank}위`);

function holdersText(s: BoardSummary, info: RankInfo, m: RecordMetric): string {
  const unit = METRIC_TEXT[m].unit;
  const names = [...new Set(s.holders.filter((h) => h.v === info.best).map((h) => h.who))];
  if (names.length === 0) return "";
  const shown = names.slice(0, 3).join("·");
  const more = info.n1 > 3 ? ` 외 ${info.n1 - 3}건` : "";
  return `${info.breaks ? "종전 최고" : "역대 1위"} ${info.best}${unit}: ${shown}${more}`;
}

export type RecordTimelineOptions = { names: RecordNames; /** 종료된 경기면 true - 마지막 쿼터·경기 끝 판정(최소 보드)까지 한다. */ final: boolean };

/**
 * 이벤트를 처음부터 한 번 훑어 "언제 TOP10에 닿았는지(done)"와 "언제 기록 선 가까이 갔는지(near)"를 뽑는다.
 * 최다 보드는 값이 바뀔 때마다, 최소 보드(팀 쿼터·경기 득점)는 쿼터·경기가 끝나는 시점에 판정한다.
 * 종료 경기(ctx.validated 있음)는 테이블에 있는 항목만 남긴다 - 검증을 통과하지 못한 기록은 주장하지 않는다.
 */
export function buildRecordTimeline(ctx: RecordContext, events: RecordEvent[], opts: RecordTimelineOptions): RecordMoment[] {
  const acc = new RecordAccumulator();
  const out: RecordMoment[] = [];
  const lastEmit = new Map<string, { level: number; value: number }>();
  const openNear = new Map<string, RecordMoment>();
  const provisional = ctx.validated === undefined;
  let curPeriod = "";
  let lastIdx = -1;

  const nameOf = (scope: "p" | "t", subject: string) => (scope === "p" ? opts.names.player(subject) : opts.names.team(subject));
  const closeNear = (key: string, at: number) => {
    const open = openNear.get(key);
    if (open) {
      open.until = at;
      openNear.delete(key);
    }
  };

  const push = (m: RecordMoment) => out.push(m);

  const emitDone = (args: {
    board: string; scope: "p" | "t"; unit: "q" | "g"; metric: RecordMetric; dir: RecordDir; subject: string; period: string; value: number; idx: number; clock: string; tcode: string | null;
  }) => {
    const buckets = args.unit === "g" ? ["G"] : isRegular(args.period) ? [args.period, "ALL"] : isOvertime(args.period) ? ["OT"] : [];
    const hits = buckets
      .map((b) => {
        const s = ctx.boards[`${args.board}|${b}`];
        const info = s ? rankInfo(s.tops, args.value, args.dir) : null;
        return s && info && info.rank <= TOP_RANKS ? { b, s, info, level: levelOf(info) } : null;
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
    if (hits.length === 0) return;
    // 같은 값이 구간 보드와 전체(ALL) 보드에 모두 걸리면 한 사건으로 - 더 높은 쪽(동률이면 ALL)이 본문, 나머지는 설명에 붙인다.
    hits.sort((a, c) => a.level - c.level || (a.b === "ALL" ? -1 : c.b === "ALL" ? 1 : 0));
    const primary = hits[0];
    const key = `${args.board}|${args.subject}|${args.period}`;
    // 순위가 좋아질 때만 알린다. 신기록(level 0)을 깬 뒤에는 값이 오를 때마다 다시 알린다(11개 -> 12개 -> 13개처럼 기록을 계속 늘리는 경기).
    const prev = lastEmit.get(key);
    if (prev && !(primary.level < prev.level || (primary.level === 0 && args.value > prev.value))) return;
    lastEmit.set(key, { level: primary.level, value: args.value });
    closeNear(key, args.idx);
    const unit = METRIC_TEXT[args.metric].unit;
    const stored = args.unit === "g" ? "G" : bucketOfPeriod(args.period)!;
    const extra = hits.slice(1).map((h) => `${BUCKET_WORD[h.b]} 기준 ${shortVerdict(h.info)}`);
    const holders = holdersText(primary.s, primary.info, args.metric);
    push({
      id: `${key}|${primary.level}|${args.value}|done`,
      idx: args.idx, until: Infinity, clock: args.clock, phase: "done",
      board: args.board, bucket: stored, subject: args.subject, period: args.period, scope: args.scope,
      name: nameOf(args.scope, args.subject), tcode: args.tcode, value: args.value,
      rank: primary.info.rank, tie: primary.info.tie, breaks: primary.info.breaks, remaining: 0,
      text: `${whenWord(args.unit, args.period)} ${metricWord(args.metric, args.dir)} ${args.value}${unit} ${verdict(primary.info, args.metric)}`,
      detail: [...extra, holders].filter(Boolean).join(" · "),
      provisional, sig: primary.level,
    });
  };

  const trackNear = (args: {
    board: string; scope: "p" | "t"; unit: "q" | "g"; metric: RecordMetric; subject: string; period: string; value: number; idx: number; clock: string; tcode: string | null;
  }) => {
    const key = `${args.board}|${args.subject}|${args.period}`;
    const buckets = args.unit === "g" ? ["G"] : isRegular(args.period) ? [args.period, "ALL"] : isOvertime(args.period) ? ["OT"] : [];
    let best: { b: string; s: BoardSummary; target: number; gap: number } | null = null;
    for (const b of buckets) {
      const s = ctx.boards[`${args.board}|${b}`];
      if (!s || s.tops.length === 0) continue;
      const target = nextTarget(s.tops, args.value);
      if (target == null) continue;
      const gap = target - args.value;
      if (gap > NEAR_GAP[args.scope][args.metric]) continue;
      if (!best || gap < best.gap || (gap === best.gap && b === "ALL")) best = { b, s, target, gap };
    }
    closeNear(key, args.idx); // 값이 바뀔 때마다 새로 연다 - 패널은 키당 지금 유효한 하나만 보여준다
    if (!best) return;
    const id = `${key}|${best.target}|near|${args.value}`;
    const unit = METRIC_TEXT[args.metric].unit;
    const tInfo = rankInfo(best.s.tops, best.target, "max")!;
    const stored = args.unit === "g" ? "G" : bucketOfPeriod(args.period)!;
    const m: RecordMoment = {
      id, idx: args.idx, until: Infinity, clock: args.clock, phase: "near",
      board: args.board, bucket: stored, subject: args.subject, period: args.period, scope: args.scope,
      name: nameOf(args.scope, args.subject), tcode: args.tcode, value: args.value,
      rank: tInfo.rank, tie: tInfo.tie, breaks: tInfo.breaks, remaining: best.gap,
      text: `${whenWord(args.unit, args.period)} ${metricWord(args.metric, "max")} ${args.value}${unit} · ${best.gap}${unit} 더하면 ${verdict(tInfo, args.metric)}`,
      detail: holdersText(best.s, tInfo, args.metric),
      provisional, sig: levelOf(tInfo),
    };
    openNear.set(key, m);
    push(m);
  };

  // 쿼터가 끝났을 때(다음 쿼터 첫 이벤트가 오거나 종료 경기의 마지막): 그 쿼터의 임박 상태를 닫고 팀 쿼터 최소 득점을 판정한다.
  const finishPeriod = (period: string, atIdx: number, clock: string) => {
    for (const [key, m] of [...openNear]) if (m.period === period) closeNear(key, atIdx + 1);
    if (!isRegular(period)) return;
    for (const t of acc.teamPeriodPoints(period)) {
      emitDone({ board: "tq.pts.min", scope: "t", unit: "q", metric: "pts", dir: "min", subject: t.tcode, period, value: t.pts, idx: atIdx, clock, tcode: t.tcode });
    }
  };

  events.forEach((e, idx) => {
    const q = e.quarter;
    if (!q || q === "PRE" || !e.pcode || !e.tcode || !e.action_code) return;
    if (curPeriod && q !== curPeriod) finishPeriod(curPeriod, lastIdx, clockOf(events[lastIdx]));
    curPeriod = q;
    lastIdx = idx;
    const clock = clockOf(e);
    for (const c of acc.apply(e)) {
      const tcode = c.scope === "p" ? e.tcode : c.subject;
      const board = `${c.scope}${c.unit}.${c.metric}.max`;
      const base = { board, scope: c.scope, unit: c.unit, metric: c.metric, subject: c.subject, period: c.period, value: c.value, idx, clock, tcode } as const;
      emitDone({ ...base, dir: "max" });
      trackNear(base);
    }
  });

  if (opts.final && curPeriod) {
    const clock = clockOf(events[lastIdx]);
    finishPeriod(curPeriod, lastIdx, clock);
    for (const t of acc.teamGamePoints()) {
      emitDone({ board: "tg.pts.min", scope: "t", unit: "g", metric: "pts", dir: "min", subject: t.tcode, period: "", value: t.pts, idx: lastIdx, clock, tcode: t.tcode });
    }
  }
  for (const key of [...openNear.keys()]) closeNear(key, events.length);

  const validated = ctx.validated ? new Set(ctx.validated) : null;
  return (validated ? out.filter((m) => validated.has(validatedKey(m))) : out).sort((a, b) => a.idx - b.idx);
}

/** 스크럽 위치 idx까지의 달성(최근 것이 위). */
export const doneUpTo = (moments: RecordMoment[], idx: number) => moments.filter((m) => m.phase === "done" && m.idx <= idx).reverse();
/** 스크럽 위치 idx에서 임박 상태인 것(가까운 순). */
export const nearAt = (moments: RecordMoment[], idx: number) =>
  moments.filter((m) => m.phase === "near" && m.idx <= idx && idx < m.until).sort((a, b) => a.remaining - b.remaining || a.sig - b.sig);

/** 토스트 문구 - 달성(done)만 알린다(임박은 패널 전용). */
export function recordToast(m: RecordMoment): { icon: string; title: string; msg: string } {
  const icon = m.rank === 1 || m.breaks ? "🏆" : m.rank <= 3 ? "🥈" : "🏅";
  const title = m.breaks ? (m.board.includes(".to.") ? "불명예 신기록!" : "KBL 신기록!") : m.rank === 1 ? (m.board.includes(".to.") ? "불명예 타이 기록" : "KBL 타이 기록") : "역대 기록";
  return { icon, title, msg: `${m.provisional ? "(잠정) " : ""}${m.name} ${m.text}` };
}
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/records.test.ts && npx tsc --noEmit`

Expected: 테스트 17개 통과, `tsc` 출력 없음.

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/records.ts courtside-web/lib/records.test.ts
git commit -m "$(cat <<'EOF'
feat(web): all-time record engine - TOP10 moments and near-miss windows from game events

Pure functions on top of the shared box rules: per player/team, per quarter/game/overtime
accumulation, rank against an as-of board summary, emit a moment only when the rank
improves (and again for every further new record), team minimum boards at period/game end.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: 서버 모듈 `lib/recordBook.ts` (테이블 읽기 + "그 경기 이전" 요약)

**Files:**
- Create: `courtside-web/lib/recordBook.ts`
- Create: `courtside-web/lib/recordBook.test.ts`
- Modify: `courtside-web/lib/cachePolicy.ts` (`TAG.records`)

**Interfaces:**
- Consumes: Task 5의 `BoardSummary`, `RecordContext`, `TOP_RANKS`
- Produces: `RecordEntry {board, bucket, gmkey, subject, period, value, date, start, name}`, `summarizeRecordBook(entries, {date, start, gmkey}, final) -> RecordContext | null`, `isRecordEligible(game, nowMs) -> boolean`, `RECORD_MAX_AGE_DAYS = 60`, `getRecordContext(game, final) -> Promise<RecordContext | null>` (서버 전용: `supabaseServer`, 10분 캐시, `TAG.records`로 즉시 무효화)

- [ ] **Step 1: 테스트 작성**

<!-- create: courtside-web/lib/recordBook.test.ts -->
~~~typescript
import { describe, expect, it } from "vitest";
import { isRecordEligible, summarizeRecordBook, type RecordEntry } from "./recordBook";

const e = (o: Partial<RecordEntry> & Pick<RecordEntry, "value">): RecordEntry => ({
  board: "pq.ast.max", bucket: "Q1", gmkey: "G0", subject: "p", period: "Q1", date: "2020-02-09", start: "14:00", name: "허훈", ...o,
});
const AT = { date: "2026-10-07", start: "19:00", gmkey: "S49G01N9" };

describe("summarizeRecordBook - 그 경기 이전 기준", () => {
  it("이전 날짜·같은 날 이른 경기만 포함하고, 같은 시각·늦은 시각·자기 자신은 뺀다", () => {
    const rows = [
      e({ value: 8, gmkey: "A", date: "2026-10-06" }),
      e({ value: 7, gmkey: "B", date: "2026-10-07", start: "16:00" }),   // 같은 날 이른 경기 - 포함
      e({ value: 9, gmkey: "C", date: "2026-10-07", start: "19:00" }),   // 같은 시각 - 제외
      e({ value: 9, gmkey: "D", date: "2026-10-07", start: "20:00" }),   // 늦은 경기 - 제외
      e({ value: 9, gmkey: "S49G01N9", date: "2026-10-07", start: "19:00" }), // 자기 자신 - 제외
      e({ value: 9, gmkey: "E", date: "2026-10-08" }),                    // 미래 - 제외
    ];
    const ctx = summarizeRecordBook(rows, AT, false)!;
    expect(ctx.boards["pq.ast.max|Q1"].tops).toEqual([8, 7]);
    expect(ctx.asOf).toBe("2026-10-07 19:00");
    expect(ctx.validated).toBeUndefined();
  });

  it("공동 순위로 TOP10까지(동률은 모두), 보유자는 순위 3위까지 최대 6개", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => e({ value: 8, gmkey: `E${i}`, name: `선수${i}` })),
      ...Array.from({ length: 5 }, (_, i) => e({ value: 7, gmkey: `S${i}` })),     // 순위 7 (6건 뒤)
      ...Array.from({ length: 3 }, (_, i) => e({ value: 6, gmkey: `X${i}` })),     // 순위 12 -> TOP10 밖
    ];
    const s = summarizeRecordBook(rows, AT, false)!.boards["pq.ast.max|Q1"];
    expect(s.tops).toEqual([8, 8, 8, 8, 8, 8, 7, 7, 7, 7, 7]);   // 순위 1 x6, 순위 7 x5 (순위 12의 6은 제외)
    expect(s.holders).toHaveLength(6);                            // 순위 <= 3은 8의 6건뿐(7은 순위 7)
    expect(s.holders.every((h) => h.v === 8)).toBe(true);
  });

  it("쿼터 보드는 구간별 + ALL(Q1~Q4 합집합), 연장(OT)은 따로, 경기 보드는 G", () => {
    const rows = [
      e({ value: 9, bucket: "Q1", gmkey: "A" }),
      e({ value: 8, bucket: "Q3", period: "Q3", gmkey: "B" }),
      e({ value: 20, bucket: "OT", period: "X1", gmkey: "C", board: "pq.pts.max" }),
      e({ value: 21, bucket: "G", period: "", gmkey: "D", board: "pg.ast.max" }),
    ];
    const b = summarizeRecordBook(rows, AT, false)!.boards;
    expect(b["pq.ast.max|Q1"].tops).toEqual([9]);
    expect(b["pq.ast.max|Q3"].tops).toEqual([8]);
    expect(b["pq.ast.max|ALL"].tops).toEqual([9, 8]);
    expect(b["pq.pts.max|OT"].tops).toEqual([20]);
    expect(b["pq.pts.max|ALL"]).toBeUndefined();                  // 연장은 ALL에 섞이지 않는다
    expect(b["pg.ast.max|G"].tops).toEqual([21]);
  });

  it("최소 보드는 작은 값이 좋은 순", () => {
    const rows = [5, 2, 3, 2].map((v, i) => e({ value: v, board: "tq.pts.min", bucket: "Q2", period: "Q2", gmkey: `M${i}` }));
    expect(summarizeRecordBook(rows, AT, false)!.boards["tq.pts.min|Q2"].tops).toEqual([2, 2, 3, 5]);
  });

  it("종료 경기는 이 경기의 행 키를 validated로(자기 행은 기록 요약에서는 빠진다)", () => {
    const rows = [e({ value: 8, gmkey: "A", date: "2026-10-06" }), e({ value: 9, gmkey: "S49G01N9", date: "2026-10-07", start: "19:00", subject: "h" })];
    const ctx = summarizeRecordBook(rows, AT, true)!;
    expect(ctx.validated).toEqual(["pq.ast.max|Q1|h|Q1"]);
    expect(ctx.boards["pq.ast.max|Q1"].tops).toEqual([8]);
  });

  it("이전 기록이 하나도 없으면 null", () => {
    expect(summarizeRecordBook([], AT, false)).toBeNull();
    expect(summarizeRecordBook([e({ value: 9, gmkey: "S49G01N9", date: "2026-10-07" })], AT, true)).toBeNull();
  });
});

describe("isRecordEligible", () => {
  const now = Date.parse("2026-10-08T12:00:00+09:00");
  it("정규/플레이오프/챔프전, 60일 이내만", () => {
    expect(isRecordEligible({ game_date: "2026-10-07", season_category: "정규시즌" }, now)).toBe(true);
    expect(isRecordEligible({ game_date: "2026-10-09", season_category: "정규시즌" }, now)).toBe(true);     // 예정 경기
    expect(isRecordEligible({ game_date: "2026-10-07", season_category: "OPEN MATCH DAY" }, now)).toBe(false);
    expect(isRecordEligible({ game_date: "2026-07-01", season_category: "정규시즌" }, now)).toBe(false);     // 60일 초과
    expect(isRecordEligible({ game_date: "2026-05-01", season_category: "챔피언결정전" }, now)).toBe(false);
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/recordBook.test.ts`

Expected: FAIL — `Failed to resolve import "./recordBook"`.

- [ ] **Step 3: 태그 추가와 모듈 구현**

<!-- edit: courtside-web/lib/cachePolicy.ts -->
<!-- old -->
~~~text
  /** build_*.py 산출물. */
  build: "manual:build",
} as const;
~~~
<!-- new -->
~~~text
  /** build_*.py 산출물. */
  build: "manual:build",
  /** 역대 기록(record_entries) - tools/record_book.py가 경기 종료 정산 직후 무효화한다. */
  records: "records",
} as const;
~~~

<!-- create: courtside-web/lib/recordBook.ts -->
~~~typescript
import { cachedFn, TAG, TTL } from "./cachePolicy";
import { TOP_RANKS, type BoardSummary, type RecordContext } from "./records";
import { supabaseServer as supabase } from "./supabaseServer";

// 역대 기록(Record Book) 서버 쪽 - record_entries(보드·구간별 순위 <= 15 보관)를 읽어 "이 경기 이전" 기준 TOP10 요약(RecordContext)을 만든다.
// 설계: docs/superpowers/specs/2026-10-08-record-book-design.md §8.1. 테이블 갱신은 tools/record_book.py(경기 종료 정산이 호출).

export type RecordEntry = { board: string; bucket: string; gmkey: string; subject: string; period: string; value: number; date: string; start: string; name: string };

const PAGE = 1000; // PostgREST 한 번에 최대 1,000행
const ELIGIBLE_CATEGORIES = new Set(["정규시즌", "플레이오프", "챔피언결정전"]);
/** 보관 범위(순위 <= 15)는 "지금" 기준이라 오래된 경기를 그 시점 기준으로 다시 계산하면 순위가 틀린다 - 이보다 오래된 경기는 기능을 끈다. */
export const RECORD_MAX_AGE_DAYS = 60;

export function isRecordEligible(game: { game_date: string; season_category: string }, nowMs: number): boolean {
  return ELIGIBLE_CATEGORIES.has(game.season_category) && (nowMs - Date.parse(game.game_date)) / 86_400_000 <= RECORD_MAX_AGE_DAYS;
}

const isMin = (board: string) => board.endsWith(".min");

/** 순수 함수 - 항목들에서 경기 `at` 이전 기준 보드 요약과(종료 경기면) 이 경기 행 키 목록을 만든다. 보드가 하나도 없으면 null. */
export function summarizeRecordBook(entries: RecordEntry[], at: { date: string; start: string; gmkey: string }, final: boolean): RecordContext | null {
  // 같은 날은 경기 시작 시각이 더 이른 경기만(같은 시각에 시작한 경기끼리는 서로 모른다). 자기 자신은 항상 뺀다.
  const before = entries.filter((e) => e.gmkey !== at.gmkey && (e.date < at.date || (e.date === at.date && e.start < at.start)));
  const groups = new Map<string, RecordEntry[]>();
  const add = (key: string, e: RecordEntry) => {
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  };
  for (const e of before) {
    add(`${e.board}|${e.bucket}`, e);
    if (/^Q[1-4]$/.test(e.bucket)) add(`${e.board}|ALL`, e); // '전체(1~4Q 묶음)' - 연장은 섞지 않는다
  }
  const boards: Record<string, BoardSummary> = {};
  for (const [key, list] of groups) {
    const sign = isMin(key.split("|")[0]) ? 1 : -1;
    const sorted = [...list].sort((a, b) => sign * (a.value - b.value) || a.date.localeCompare(b.date) || a.gmkey.localeCompare(b.gmkey));
    const tops: number[] = [];
    const holders: BoardSummary["holders"] = [];
    let rank = 0;
    let last: number | null = null;
    sorted.forEach((e, i) => {
      if (e.value !== last) {
        rank = i + 1;
        last = e.value;
      }
      if (rank <= TOP_RANKS) tops.push(e.value);
      if (rank <= 3 && holders.length < 6) holders.push({ v: e.value, who: e.name, d: e.date });
    });
    if (tops.length) boards[key] = { tops, holders };
  }
  if (Object.keys(boards).length === 0) return null;
  const ctx: RecordContext = { asOf: `${at.date} ${at.start}`.trim(), boards };
  if (final) ctx.validated = entries.filter((e) => e.gmkey === at.gmkey).map((e) => `${e.board}|${e.bucket}|${e.subject}|${e.period}`);
  return ctx;
}

/** record_entries 전체(수천 행)를 10분 캐시로 - 조회 에러는 던진다(빈 배열을 캐시에 굳히지 않는다). 경기 종료 정산이 'records' 태그로 즉시 비운다. */
const fetchRecordEntries = cachedFn(
  async (): Promise<RecordEntry[]> => {
    const out: RecordEntry[] = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("record_entries")
        .select("board, bucket, gmkey, subject, period, value, game_date, game_start, subject_name")
        .order("board")
        .order("bucket")
        .order("gmkey")
        .order("subject")
        .order("period")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`recordEntries: ${error.message}`);
      for (const r of data ?? []) {
        out.push({
          board: r.board as string, bucket: r.bucket as string, gmkey: r.gmkey as string, subject: r.subject as string, period: r.period as string,
          value: r.value as number, date: r.game_date as string, start: ((r.game_start as string | null) ?? "").slice(0, 5), name: r.subject_name as string,
        });
      }
      if (!data || data.length < PAGE) break;
    }
    return out;
  },
  { name: "recordEntries", ttl: TTL.scheduled, tags: () => [TAG.records] }
);

/** 경기 페이지용 - 이 경기 이전 기준 역대 기록 요약. 대상이 아니거나(전시경기·60일 초과) 기록이 없으면 null. final = 종료된 경기. */
export async function getRecordContext(
  game: { gmkey: string; game_date: string; game_start: string | null; season_category: string },
  final: boolean
): Promise<RecordContext | null> {
  if (!isRecordEligible(game, Date.now())) return null;
  const entries = await fetchRecordEntries();
  if (entries.length === 0) return null;
  return summarizeRecordBook(entries, { date: game.game_date, start: (game.game_start ?? "").slice(0, 5), gmkey: game.gmkey }, final);
}
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/recordBook.test.ts lib/records.test.ts && npx tsc --noEmit`

Expected: 테스트 통과, `tsc` 출력 없음.

- [ ] **Step 5: 커밋**

```bash
git add courtside-web/lib/recordBook.ts courtside-web/lib/recordBook.test.ts courtside-web/lib/cachePolicy.ts
git commit -m "$(cat <<'EOF'
feat(web): record book reader - as-of TOP10 summary from record_entries

Reads the table in 1000-row pages behind a 10-minute cache tagged 'records' (a read error
throws, so an empty result is never cached), and summarises per (board, bucket) the TOP10
values and rank<=3 holders as of the game's start. Quarter boards also get an ALL bucket
(Q1-Q4 union, overtime excluded). Games older than 60 days and non-league games are off.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: 대조 픽스처 도구와 파이썬↔웹 정의 대조, 허훈 경기 실전 재현

**Files:**
- Create: `tools/dump_record_fixtures.py`
- Create: `courtside-web/lib/__fixtures__/recordParity/*.json` (도구가 생성, 10경기)
- Create: `courtside-web/lib/records.parity.test.ts`, `courtside-web/lib/records.replay.test.ts`

**Interfaces:**
- Consumes: `record_book.official_candidates / event_candidates / player_index / load_game`(Task 1), `RecordAccumulator`(Task 5), `summarizeRecordBook`(Task 6)
- Produces: 픽스처 형식 `{"gmkey", "events": [[pcode, tcode, code, quarter, min, sec]...], "rows": [[board, bucket, subject, period, value]...]}`, 도구 `--parity OUTDIR [--gmkeys ... | --sample N]` / `--freq OUTDIR --prefix S47 [--entries PATH]`

- [ ] **Step 1: 픽스처 도구 작성**

<!-- create: tools/dump_record_fixtures.py -->
~~~python
# -*- coding: utf-8 -*-
"""record_book 검증용 픽스처 덤프 (개발 도구 - 운영 경로에서 쓰지 않는다).

  python dump_record_fixtures.py --parity OUTDIR [--sample 12] [--gmkeys S49G01N9,...]
      웹 엔진(lib/records.ts)과 파이썬(record_book.py)의 정의가 같은지 대조하는 픽스처.
      OUTDIR/<gmkey>.json = {"gmkey", "events": [[pcode, tcode, code, quarter, min, sec], ...], "rows": [[board, bucket, subject, period, value], ...]}
      공식 합계와 이벤트 합계가 선수·팀 전부에서 같은 경기만 고른다(공식 기반 보드도 이벤트로 재현되는 경기).

  python dump_record_fixtures.py --freq OUTDIR --prefix S47 [--entries PATH]
      알림 빈도 실측용: 그 접두사(예: S47 = 2025-26)로 시작하는 정규시즌 경기의 이벤트 파일들과,
      (--entries) 보드·구간별 순위 <= 50 항목 전체를 PATH에 저장한다(웹 요약기가 경기별 "그 경기 이전" 기록을 만드는 입력).
"""
import argparse
import collections
import json
import os
import sys

import record_book as rb

RELEVANT = {str(c) for c in range(201, 215)}      # applyBoxEvent가 보는 코드(득점·리바·어시·스틸·블락·턴오버)


def to_events(g):
    """text-cast -> Supabase game_events 모양(웹 엔진 입력). 이름 -> pcode는 같은 경기 선수 목록으로."""
    pidx = rb.player_index(g)
    out = []
    for e in g["events"]:
        if e.get("a") not in RELEVANT or not e.get("q"):
            continue
        pcode = pidx.get((e.get("p"), e.get("t"))) if e.get("p") else None
        out.append([pcode, e.get("t"), e["a"], e["q"], e.get("m"), e.get("s")])
    return out


def parity_ok(g, official_rows, event_rows):
    """공식 합계와 이벤트 합계가 선수·팀 전부에서 같은 경기만 True."""
    if not event_rows or any(v is None for v in rb.player_index(g).values()):
        return False
    for tc in (g["home"], g["away"]):
        rec = g["teams"].get(tc) or {}
        mk = sum(1 for e in g["events"] if e.get("t") == tc and e.get("p") and e.get("a") in ("201", "205", "207"))
        ms = sum(1 for e in g["events"] if e.get("t") == tc and e.get("p") and e.get("a") in ("202", "206", "208"))
        if (mk, mk + ms) != (rec.get("fgt"), rec.get("fgtA")):
            return False
    p_sum, t_sum, t_tpm = collections.defaultdict(int), collections.defaultdict(int), collections.defaultdict(int)
    for r in event_rows:
        _, m, _ = r["board"].split(".")
        if r["board"].startswith("pq."):
            p_sum[(m, r["subject"])] += r["value"]
            if m == "tpm":
                t_tpm[r["tcode"]] += r["value"]
        elif r["board"].startswith("tq."):
            t_sum[(m, r["subject"])] += r["value"]
    for r in official_rows:
        _, m, _ = r["board"].split(".")
        if r["board"].startswith("pg.") and p_sum[(m, r["subject"])] != r["value"]:
            return False
        if r["board"].startswith("tg.") and m in ("reb", "ast", "stl", "blk") and t_sum[(m, r["subject"])] != r["value"]:
            return False
        if r["board"].startswith("tg.") and m == "tpm" and t_tpm[r["subject"]] != r["value"]:
            return False
    return True


def dump_parity(outdir, gmkeys, sample):
    os.makedirs(outdir, exist_ok=True)
    pool = gmkeys or sorted(os.listdir(rb.RAW_GAMES))
    if not gmkeys:
        step = max(1, len(pool) // (sample * 4))
        pool = pool[::step]
    written = 0
    for gmkey in pool:
        g = rb.load_game(gmkey)
        if g is None:
            continue
        official, events = rb.official_candidates(g), rb.event_candidates(g)
        if not parity_ok(g, official, events):
            continue
        rows = [[r["board"], r["bucket"], r["subject"], r["period"], r["value"]] for r in official + events]
        with open(os.path.join(outdir, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump({"gmkey": gmkey, "events": to_events(g), "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
        written += 1
        if not gmkeys and written >= sample:
            break
    print(f"parity fixtures: {written}개 -> {outdir}")


def dump_freq(outdir, prefix, entries_path):
    os.makedirs(outdir, exist_ok=True)
    n = 0
    for gmkey in sorted(os.listdir(rb.RAW_GAMES)):
        if not gmkey.startswith(prefix + "G01"):
            continue
        g = rb.load_game(gmkey)
        if g is None:
            continue
        with open(os.path.join(outdir, f"{gmkey}.json"), "w", encoding="utf-8") as f:
            json.dump({"gmkey": gmkey, "date": g["date"], "start": g["start"], "names": {p["pcode"]: p["pname"] for p in g["players"]}, "teams": g["names"], "events": to_events(g)},
                      f, ensure_ascii=False, separators=(",", ":"))
        n += 1
    print(f"freq events: {n}경기 -> {outdir}")
    if entries_path:
        rows, stats = rb.build_all(keep=50)
        with open(entries_path, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, separators=(",", ":"))
        print(f"entries(keep=50): {len(rows)}행 -> {entries_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parity", help="대조 픽스처를 쓸 폴더")
    ap.add_argument("--sample", type=int, default=12)
    ap.add_argument("--gmkeys", help="콤마 구분 - 지정하면 이 경기들만(조건을 통과해야 쓴다)")
    ap.add_argument("--freq", help="빈도 실측용 이벤트를 쓸 폴더")
    ap.add_argument("--prefix", default="S47", help="--freq: 시즌 접두사(S47 = 2025-26)")
    ap.add_argument("--entries", help="--freq: 순위 <= 50 항목 JSON 경로")
    args = ap.parse_args()
    if not (args.parity or args.freq):
        ap.error("--parity 또는 --freq가 필요하다")
    if args.parity:
        dump_parity(args.parity, [x.strip() for x in (args.gmkeys or "").split(",") if x.strip()], args.sample)
    if args.freq:
        dump_freq(args.freq, args.prefix, args.entries)


if __name__ == "__main__":
    sys.exit(main())
~~~

- [ ] **Step 2: 기록 경기 10개로 대조 픽스처 생성**

Run (저장소 루트에서):

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --parity ../courtside-web/lib/__fixtures__/recordParity --gmkeys S49G01N9,S35G01N201,S41G01N171,S33G01N9,S43G01N58,S39G01N185,S47G01N184,S31G01N245,S45G01N62,S47G01N224
cd ..
```

Expected: `parity fixtures: 10개 -> ...` (공식 합계와 이벤트 합계가 선수·팀 전부 같은 경기만 쓰는데 이 10경기는 모두 통과한다 - 허훈 21어시스트·9어시스트 경기, 3차 연장 S41G01N171, 연장 S33G01N9, 정관장 1Q 41점, LG 2점 쿼터, 허웅 51점·3점슛 11개+, KT 121점, 라렌 4Q 블락 7개, 박지훈 8어시스트). 파일 10개, 합계 약 210KB.

- [ ] **Step 3: 대조 테스트와 재현 테스트 작성**

<!-- create: courtside-web/lib/records.parity.test.ts -->
~~~typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RecordAccumulator } from "./records";

// 파이썬(tools/record_book.py)이 실제 경기에서 만든 후보 행과 웹 엔진(RecordAccumulator)의 누적이 같은지 대조한다 - 두 언어로 따로 구현한
// 기록 정의(득점·리바·어시·스틸·블락·3점·턴오버·야투, 쿼터·연장·경기 구분)가 어긋나면 여기서 잡힌다.
// 픽스처는 tools/dump_record_fixtures.py --parity 로 만든다(공식 합계와 이벤트 합계가 전부 같은 경기만 들어간다).

const DIRS = (process.env.RECORD_PARITY_DIR ?? join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "recordParity")).split(",");

type Fixture = { gmkey: string; events: [string | null, string | null, string, string, number | null, number | null][]; rows: [string, string, string, string, number][] };

const files = DIRS.filter((d) => existsSync(d)).flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".json")).map((f) => join(d, f)));

describe("파이썬 후보 행 vs 웹 엔진 누적", () => {
  it("픽스처가 있다", () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    it(file.split(/[\\/]/).slice(-1)[0], () => {
      const fx = JSON.parse(readFileSync(file, "utf8")) as Fixture;
      const acc = new RecordAccumulator();
      for (const [pcode, tcode, action_code, quarter, clock_min, clock_sec] of fx.events) acc.apply({ pcode, tcode, action_code, quarter, clock_min, clock_sec });
      const got = acc.finalValues();
      const bad = fx.rows.filter(([board, bucket, subject, period, value]) => got.get(`${board}|${bucket}|${subject}|${period}`) !== value);
      expect(bad.slice(0, 5).map((r) => ({ row: r, got: got.get(`${r[0]}|${r[1]}|${r[2]}|${r[3]}`) }))).toEqual([]);
      expect(fx.rows.length).toBeGreaterThan(100);
    });
  }
});
~~~

<!-- create: courtside-web/lib/records.replay.test.ts -->
~~~typescript
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRecordTimeline } from "./records";
import { summarizeRecordBook, type RecordEntry } from "./recordBook";

// 실전 재현(설계 §10-4): 2026-10-07 S49G01N9(KCC-가스공사)의 실제 이벤트를 "그 경기 이전" 기록으로 재생하면
// 허훈의 8번째 어시스트는 타이 기록(공동 1위), 9번째는 신기록(종전 8개)으로 알려야 한다.
// 이전 기록 = 검증을 통과한 쿼터 어시스트 8개 6건(문태종 2010, 박지현 2011, 이정현 2019, 허훈 2020, 마레이 2025, 박지훈 2026) + 7개 몇 건.

const FIXTURE = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__", "recordParity", "S49G01N9.json");
type Fixture = { events: [string | null, string | null, string, string, number | null, number | null][] };

const fx = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
const events = fx.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec }));

// 이 경기 1쿼터에서 어시스트가 가장 많은 KCC(tcode 60) 선수 = 허훈
const q1Assists = new Map<string, number>();
for (const ev of events) if (ev.action_code === "211" && ev.quarter === "Q1" && ev.tcode === "60" && ev.pcode) q1Assists.set(ev.pcode, (q1Assists.get(ev.pcode) ?? 0) + 1);
const HOON = [...q1Assists.entries()].sort((a, b) => b[1] - a[1])[0][0];

const entry = (subject: string, name: string, gmkey: string, date: string, bucket: string, value: number): RecordEntry => ({
  board: "pq.ast.max", bucket, gmkey, subject, period: bucket, value, date, start: "", name,
});
const ENTRIES: RecordEntry[] = [
  entry("p1", "문태종", "S17G01N93", "2010-12-15", "Q1", 8),
  entry("p2", "박지현", "S19G01N30", "2011-10-27", "Q3", 8),
  entry("p3", "이정현", "S35G01N46", "2019-11-01", "Q2", 8),
  entry("p4", "허훈", "S35G01N201", "2020-02-09", "Q1", 8),
  entry("p5", "아셈 마레이", "S45G01N231", "2025-03-20", "Q1", 8),
  entry("p6", "박지훈", "S47G01N224", "2026-03-09", "Q3", 8),
  ...["이상민", "김학섭", "주희정", "김승현"].map((n, i) => entry(`s${i}`, n, `S1${i}G01N1`, `2008-01-0${i + 1}`, "Q1", 7)),
  // 이 경기 자신의 행(종료 후 테이블에 들어간 것) - "그 경기 이전" 요약에서는 빠져야 한다
  entry(HOON, "허훈", "S49G01N9", "2026-10-07", "Q1", 9),
];
const AT = { date: "2026-10-07", start: "19:00", gmkey: "S49G01N9" };
const names = { player: (p: string) => p, team: (t: string) => t };
const hoonMoments = (ms: ReturnType<typeof buildRecordTimeline>) => ms.filter((x) => x.phase === "done" && x.board === "pq.ast.max" && x.period === "Q1" && x.subject === HOON && x.value >= 8);

describe("실전 재현 - S49G01N9 허훈 1쿼터 9어시스트", () => {
  it("라이브(잠정): 8번째 어시스트 타이 기록(공동 1위), 9번째 신기록(종전 8개)", () => {
    const ctx = summarizeRecordBook(ENTRIES, AT, false)!;
    expect(ctx.boards["pq.ast.max|ALL"].tops.slice(0, 6)).toEqual([8, 8, 8, 8, 8, 8]); // 자기 자신의 9는 요약에 없다
    const m = hoonMoments(buildRecordTimeline(ctx, events, { names, final: false }));
    expect(m.map((x) => [x.value, x.rank, x.tie, x.breaks])).toEqual([
      [8, 1, true, false],
      [9, 1, false, true],
    ]);
    expect(m[0].text).toBe("1쿼터 어시스트 8개 KBL 타이 기록(공동 1위)");
    expect(m[1].text).toBe("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(m[1].detail).toContain("종전 최고 8개: 문태종");
    expect(m[1].provisional).toBe(true);
    expect(m[1].idx).toBeGreaterThan(m[0].idx);
  });

  it("종료 경기: 정산된 행(이 경기의 허훈)이 validated에 있으면 같은 알림이 '잠정' 없이 남는다", () => {
    const ctx = summarizeRecordBook(ENTRIES, AT, true)!;
    expect(ctx.validated).toEqual([`pq.ast.max|Q1|${HOON}|Q1`]);
    const m = hoonMoments(buildRecordTimeline(ctx, events, { names, final: true }));
    expect(m.map((x) => x.value)).toEqual([8, 9]);
    expect(m.every((x) => x.provisional === false)).toBe(true);
  });

  it("종료 경기라도 테이블에 이 경기 행이 없으면(검증 탈락·정산 전) 기록을 주장하지 않는다", () => {
    const ctx = summarizeRecordBook(ENTRIES.filter((x) => x.gmkey !== "S49G01N9"), AT, true)!;
    expect(ctx.validated).toEqual([]);
    expect(buildRecordTimeline(ctx, events, { names, final: true })).toEqual([]);
  });
});
~~~

- [ ] **Step 4: 통과 확인**

Run: `cd courtside-web && npx vitest run lib/records.parity.test.ts lib/records.replay.test.ts`

Expected: 대조 11개(픽스처 존재 확인 1 + 경기 10), 재현 3개 모두 통과. 대조 실패 시 출력의 `row`/`got`이 어긋난 보드·값을 보여준다 — 파이썬과 `lib/records.ts`의 기록 정의가 어긋난 것이므로 한쪽을 고쳐 다시 맞춘다.

- [ ] **Step 5: 커밋**

```bash
git add tools/dump_record_fixtures.py courtside-web/lib/__fixtures__ courtside-web/lib/records.parity.test.ts courtside-web/lib/records.replay.test.ts
git commit -m "$(cat <<'EOF'
test(records): pin Python and web record definitions against 10 real games, replay Heo Hoon's 9-assist quarter

The fixtures are real games where official totals and event totals agree for every player and
team (including a triple-overtime game); the replay runs S49G01N9's actual events against the
as-of book and expects a tie at 8 assists and a new record (previous 8) at the 9th.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: 패널 "🏆 역대 기록" 그룹과 GameReplay 연결

**Files:**
- Modify: `courtside-web/components/MilestoneWatch.tsx` (전체 교체)
- Create: `courtside-web/components/MilestoneWatch.test.tsx`
- Modify: `courtside-web/components/GameReplay.tsx` (12곳)

**Interfaces:**
- Consumes: Task 5의 `RecordContext`, `RecordMoment`, `buildRecordTimeline`, `doneUpTo`, `nearAt`, `recordToast`
- Produces: `GameReplay`의 새 prop `records?: RecordContext | null`; `MilestoneWatch`의 새 props `records?: RecordMoment[]`, `recordTeamOf?: (tcode: string | null) => TeamDot` (`ctx`는 `MilestoneContext | null`)

- [ ] **Step 1: 패널 테스트 작성**

<!-- create: courtside-web/components/MilestoneWatch.test.tsx -->
~~~tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RecordMoment } from "@/lib/records";
import { MilestoneWatch } from "./MilestoneWatch";

const moment = (o: Partial<RecordMoment>): RecordMoment => ({
  id: "m", idx: 5, until: Infinity, clock: "Q1 2:10", phase: "done", board: "pq.ast.max", bucket: "Q1", subject: "290001", period: "Q1", scope: "p",
  name: "허훈", tcode: "H", value: 9, rank: 1, tie: false, breaks: true, remaining: 0, text: "1쿼터 어시스트 9개 KBL 신기록(종전 8개)",
  detail: "종전 최고 8개: 문태종", provisional: true, sig: 0, ...o,
});

const render = (records: RecordMoment[], idx: number, hideNear = false) =>
  renderToStaticMarkup(
    <MilestoneWatch ctx={null} moments={[]} idx={idx} box={new Map()} teamOf={() => null} hideNear={hideNear} records={records} recordTeamOf={() => ({ abbr: "KCC", color: "#123456" })} />
  );

describe("MilestoneWatch - 역대 기록 그룹", () => {
  it("통산 기록 재료(ctx)가 없어도 역대 기록만으로 패널이 나온다 - 선수는 프로필 링크, 라이브는 '잠정'", () => {
    const out = render([moment({})], 5);
    expect(out).toContain("🏆 역대 기록");
    expect(out).toContain('href="/players/290001"');
    expect(out).toContain("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(out).toContain("잠정 · 종전 최고 8개: 문태종");
    expect(out).toContain("Q1 2:10");
    expect(out).not.toContain("🏅 달성"); // 통산 그룹은 ctx가 있을 때만
  });

  it("스크럽 위치가 달성 이전이면 아무것도 그리지 않는다, 종료 경기(잠정 아님)는 '잠정'이 없다", () => {
    expect(render([moment({})], 4)).toBe("");
    expect(render([moment({ provisional: false })], 9)).not.toContain("잠정 · "); // 패널 안내 문구의 '잠정'과 달리 줄 앞 접두사는 없다
  });

  it("팀 기록은 링크 없이 이름만", () => {
    const out = render([moment({ scope: "t", subject: "H", name: "부산 KCC", board: "tq.pts.max", text: "1쿼터 득점 42점 KBL 신기록(종전 41점)" })], 9);
    expect(out).toContain("부산 KCC");
    expect(out).not.toContain('href="/players/H"');
  });

  it("임박은 유효한 구간에서만 남은 수 배지와 함께, 끝난 경기를 끝까지 본 상태(hideNear)에선 숨긴다", () => {
    const near = moment({ id: "n", phase: "near", idx: 3, until: 6, remaining: 1, text: "1쿼터 어시스트 7개 · 1개 더하면 KBL 타이 기록(공동 1위)", detail: "역대 1위 8개: 문태종" });
    const mid = render([near], 4);
    expect(mid).toContain("1개 더하면 KBL 타이 기록");
    expect(mid).toContain(">1개<");                    // 배지: 남은 1개
    expect(render([near], 6)).toBe("");                // 구간이 끝났다(until=6)
    expect(render([near], 4, true)).toBe("");          // hideNear
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run components/MilestoneWatch.test.tsx`

Expected: FAIL — `Failed to resolve import "@/lib/records"` 또는 `records` prop이 없어 "🏆 역대 기록"이 나오지 않는다.

- [ ] **Step 3: 패널 컴포넌트 교체**

<!-- replace-file: courtside-web/components/MilestoneWatch.tsx -->
~~~tsx
"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { BoxLine } from "@/lib/boxEvents";
import { basisNote, CAT_TEXT, evaluateApproaching, gameStatsFromBox, type MilestoneContext, type MilestoneItem, type MilestoneMoment } from "@/lib/milestones";
import { isLinkablePcode } from "@/lib/onCourtCards";
import { doneUpTo, nearAt, type RecordMoment } from "@/lib/records";
import styles from "./MilestoneWatch.module.css";

// 라이브 "기록 워치"(요청 2026-10-07) - 이 경기에서 올타임/현역 순위 돌파, 100개 단위 통산 이정표, 커리어 하이를
// 달성했거나 곧 달성할 선수. 달성은 이벤트 타임라인(lib/milestones.ts buildMilestoneTimeline)에서 스크럽 위치까지의
// 것만, 임박은 스크럽 시점 박스로 매번 다시 계산한다(재생·되감기·라이브 모두 같은 화면 규칙).
//
// 같은 패널 맨 위에 "🏆 역대 기록"(요청 2026-10-08) - KBL 역대 TOP10(쿼터·경기·연장별 최다/최소 기록)에 닿았거나 닿을 선수·팀.
// lib/records.ts buildRecordTimeline이 만든 타임라인에서 스크럽 위치까지의 달성과 그 위치에서 유효한 임박을 그대로 보여준다.

type TeamDot = { abbr: string; color: string } | null;

function Row({ item, clock, team, badge }: { item: MilestoneItem; clock?: string; team: TeamDot; badge?: boolean }) {
  const linkable = isLinkablePcode(item.pcode);
  return (
    <li className={styles.row}>
      <span className={styles.dot} style={team ? { background: team.color } : undefined} aria-hidden="true" />
      <div>
        <div className={styles.headline}>
          {linkable ? (
            <Link href={`/players/${item.pcode}`} className={styles.name}>
              {item.name}
            </Link>
          ) : (
            <span className={styles.name}>{item.name}</span>
          )}{" "}
          {item.text}
        </div>
        <div className={styles.detail}>
          {clock ? <span className={styles.clock}>{clock}</span> : null}
          {item.detail}
        </div>
      </div>
      {badge ? (
        <span className={`${styles.badge} ${item.remaining <= 2 ? styles.hot : ""}`}>
          {item.remaining}
          {CAT_TEXT[item.cat].unit}
        </span>
      ) : null}
    </li>
  );
}

/** 역대 기록 한 줄 - 선수는 프로필 링크, 팀은 이름만. 라이브(잠정)면 상세 앞에 "잠정"을 붙인다. */
function RecordRow({ m, team, badge }: { m: RecordMoment; team: TeamDot; badge?: boolean }) {
  const linkable = m.scope === "p" && isLinkablePcode(m.subject);
  const unit = m.board.split(".")[1] === "pts" ? "점" : "개";
  return (
    <li className={styles.row}>
      <span className={styles.dot} style={team ? { background: team.color } : undefined} aria-hidden="true" />
      <div>
        <div className={styles.headline}>
          {linkable ? (
            <Link href={`/players/${m.subject}`} className={styles.name}>
              {m.name}
            </Link>
          ) : (
            <span className={styles.name}>{m.name}</span>
          )}{" "}
          {m.text}
        </div>
        <div className={styles.detail}>
          <span className={styles.clock}>{m.clock}</span>
          {m.provisional && m.phase === "done" ? "잠정 · " : ""}
          {m.detail}
        </div>
      </div>
      {badge ? (
        <span className={`${styles.badge} ${m.remaining <= 2 ? styles.hot : ""}`}>
          {m.remaining}
          {unit}
        </span>
      ) : null}
    </li>
  );
}

export function MilestoneWatch({
  ctx,
  moments,
  idx,
  box,
  teamOf,
  hideNear = false,
  appeared,
  records = [],
  recordTeamOf,
}: {
  /** 통산 기록 재료 - 없으면(전시경기·스냅샷 공백 등) 통산 그룹만 빠지고 역대 기록 그룹은 그대로 나온다. */
  ctx: MilestoneContext | null;
  /** buildMilestoneTimeline 결과(경기 전체). */
  moments: MilestoneMoment[];
  /** 지금 보고 있는 이벤트 인덱스. */
  idx: number;
  /** GameReplay가 이미 계산한 스크럽 시점 박스스코어. */
  box: ReadonlyMap<string, BoxLine>;
  teamOf: (pcode: string, tcode?: string) => TeamDot;
  /** 끝난 경기를 맨 끝까지 본 상태 - 더 이룰 수 없는 "임박"은 숨기고 달성만 보여준다. */
  hideNear?: boolean;
  /** 지금까지 코트에 나온 선수인지 - 경기가 시작된 뒤(idx > 0)엔 안 나온 벤치 선수의 "임박"은 뺀다(끝난 경기를 되감을 때 결장자 잡음 방지). 경기 전(idx 0)엔 전원. */
  appeared?: (pcode: string) => boolean;
  /** buildRecordTimeline 결과(경기 전체) - 역대 기록 그룹. */
  records?: RecordMoment[];
  recordTeamOf?: (tcode: string | null) => TeamDot;
}) {
  const done = useMemo(() => moments.filter((m) => m.phase === "done" && m.idx <= idx).reverse(), [moments, idx]);
  const near = useMemo(
    () => (hideNear || !ctx ? [] : evaluateApproaching(ctx, (pcode) => gameStatsFromBox(box.get(pcode)), { include: idx > 0 && appeared ? appeared : undefined })),
    [ctx, box, hideNear, idx, appeared]
  );
  const recordDone = useMemo(() => doneUpTo(records, idx), [records, idx]);
  const recordNear = useMemo(() => (hideNear ? [] : nearAt(records, idx)), [records, idx, hideNear]);
  if (done.length === 0 && near.length === 0 && recordDone.length === 0 && recordNear.length === 0) return null;

  return (
    <div className={styles.wrap}>
      <div className="panel-title">기록 워치</div>
      {ctx && <p className={styles.sub}>{basisNote(ctx.split)}</p>}
      {(recordDone.length > 0 || recordNear.length > 0) && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>🏆 역대 기록</div>
          <p className={styles.sub}>KBL 역대 TOP10 기준 · 정규시즌·플레이오프 합산 · 공식 기록과 대조를 통과한 경기만 집계 · 라이브 중에는 잠정</p>
          <ul className={styles.list}>
            {recordDone.map((m) => (
              <RecordRow key={m.id} m={m} team={recordTeamOf ? recordTeamOf(m.tcode) : null} />
            ))}
            {recordNear.map((m) => (
              <RecordRow key={m.id} m={m} team={recordTeamOf ? recordTeamOf(m.tcode) : null} badge />
            ))}
          </ul>
        </div>
      )}
      {done.length > 0 && ctx && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>🏅 달성</div>
          <ul className={styles.list}>
            {done.map((m) => (
              <Row key={`${m.id}:${m.phase}`} item={m} clock={m.clock} team={teamOf(m.pcode, ctx.players[m.pcode]?.tcode)} />
            ))}
          </ul>
        </div>
      )}
      {near.length > 0 && ctx && (
        <div className={styles.group}>
          <div className={styles.groupTitle}>⏳ 임박</div>
          <ul className={styles.list}>
            {near.map((m) => (
              <Row key={`${m.id}:near`} item={m} team={teamOf(m.pcode, ctx.players[m.pcode]?.tcode)} badge />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
~~~

- [ ] **Step 4: GameReplay 연결 (12곳)**

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
import { buildMilestoneTimeline, type MilestoneContext, type MilestoneMoment } from "@/lib/milestones";
~~~
<!-- new -->
~~~text
import { buildMilestoneTimeline, type MilestoneContext, type MilestoneMoment } from "@/lib/milestones";
import { buildRecordTimeline, recordToast, type RecordContext, type RecordMoment } from "@/lib/records";
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
  milestones?: ReadonlyMap<number, MilestoneMoment[]>
): PushToastSpec[] {
~~~
<!-- new -->
~~~text
  milestones?: ReadonlyMap<number, MilestoneMoment[]>,
  /** 역대 기록(lib/records.ts) 타임라인을 이벤트 인덱스로 묶은 것 - 이 이벤트에서 TOP10에 닿은 기록이 있으면 토스트로 알린다(임박은 패널 전용). */
  records?: ReadonlyMap<number, RecordMoment[]>
): PushToastSpec[] {
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
        : { icon: "👀", title: "기록 임박", msg: `${m.name} ${m.text}` }
    );
  }

  return out;
}
~~~
<!-- new -->
~~~text
        : { icon: "👀", title: "기록 임박", msg: `${m.name} ${m.text}` }
    );
  }

  // 역대 기록 - 맨 뒤(가장 드문 사건이라 라이브 버스트의 마지막 3개 제한에서 밀려나지 않게).
  for (const m of records?.get(newIdx) ?? []) {
    if (m.phase === "done") out.push(recordToast(m));
  }

  return out;
}
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
  milestones,
  boxOnly = false,
}: {
~~~
<!-- new -->
~~~text
  milestones,
  records,
  boxOnly = false,
}: {
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
  milestones?: MilestoneContext | null;
  // true면 "코트 위" 박스스코어 패널만 그린다
~~~
<!-- new -->
~~~text
  milestones?: MilestoneContext | null;
  // 역대 기록(KBL 역대 TOP10 - 쿼터·경기·연장별 최다/최소) - page.tsx가 서버에서 lib/recordBook.ts로 "이 경기 이전" 기준 보드 요약을 만들어 내려준다.
  // 없으면(전시경기·오래된 경기·기록 테이블 없음) 패널·알림 모두 없다.
  records?: RecordContext | null;
  // true면 "코트 위" 박스스코어 패널만 그린다
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
    return byIdx;
  }, [milestoneMoments]);
~~~
<!-- new -->
~~~text
    return byIdx;
  }, [milestoneMoments]);

  // 역대 기록 타임라인 - 기록 워치와 같은 방식(이벤트를 한 번 훑어 TOP10에 닿은 순간·임박 구간을 뽑는다). 종료 경기는 정산된(validated) 항목만 남는다.
  const recordMoments = useMemo(
    () =>
      records
        ? buildRecordTimeline(records, events, {
            names: {
              player: (pcode) => nameByPcode.get(pcode) ?? liveNames?.[pcode] ?? liveCtx.lateNames[pcode] ?? pcode,
              team: (tcode) => (tcode === homeTeam.tcode ? homeTeam.name : tcode === awayTeam.tcode ? awayTeam.name : tcode),
            },
            final: !live,
          })
        : [],
    [records, events, nameByPcode, liveNames, liveCtx.lateNames, homeTeam, awayTeam, live]
  );
  const recordsByIdx = useMemo(() => {
    const byIdx = new Map<number, RecordMoment[]>();
    for (const m of recordMoments) if (m.phase === "done") byIdx.set(m.idx, [...(byIdx.get(m.idx) ?? []), m]);
    return byIdx;
  }, [recordMoments]);
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
    for (const spec of computePushNotifications(events, cur, next, homeTeam, awayTeam, momentsByIdx)) pushToast(spec);
~~~
<!-- new -->
~~~text
    for (const spec of computePushNotifications(events, cur, next, homeTeam, awayTeam, momentsByIdx, recordsByIdx)) pushToast(spec);
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
  }, [events, homeTeam, awayTeam, momentsByIdx, pushToast, setIdx]);

  useEffect(() => {
    if (!playing || idx >= events.length - 1) return;
~~~
<!-- new -->
~~~text
  }, [events, homeTeam, awayTeam, momentsByIdx, recordsByIdx, pushToast, setIdx]);

  useEffect(() => {
    if (!playing || idx >= events.length - 1) return;
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
  const latestRef = useRef({ events, homeTeam, awayTeam, momentsByIdx });
  useEffect(() => {
    latestRef.current = { events, homeTeam, awayTeam, momentsByIdx };
  }, [events, homeTeam, awayTeam, momentsByIdx]);
~~~
<!-- new -->
~~~text
  const latestRef = useRef({ events, homeTeam, awayTeam, momentsByIdx, recordsByIdx });
  useEffect(() => {
    latestRef.current = { events, homeTeam, awayTeam, momentsByIdx, recordsByIdx };
  }, [events, homeTeam, awayTeam, momentsByIdx, recordsByIdx]);
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
specs.push(...computePushNotifications(cur.events, i, i + 1, cur.homeTeam, cur.awayTeam, cur.momentsByIdx));
~~~
<!-- new -->
~~~text
specs.push(...computePushNotifications(cur.events, i, i + 1, cur.homeTeam, cur.awayTeam, cur.momentsByIdx, cur.recordsByIdx));
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
    [playerByPcode, homeTeam, awayTeam]
  );
~~~
<!-- new -->
~~~text
    [playerByPcode, homeTeam, awayTeam]
  );
  // 역대 기록 줄의 팀 점 색 - 기록 이벤트가 소속 팀 코드를 직접 들고 있다.
  const recordTeamOf = useCallback(
    (tcode: string | null) => (tcode === homeTeam.tcode ? homeTeam : tcode === awayTeam.tcode ? awayTeam : null),
    [homeTeam, awayTeam]
  );
~~~

<!-- edit: courtside-web/components/GameReplay.tsx -->
<!-- old -->
~~~text
      {milestones && <MilestoneWatch ctx={milestones} moments={milestoneMoments} idx={idx} box={box} teamOf={milestoneTeamOf} hideNear={!live && idx >= events.length - 1} appeared={milestoneAppeared} />}
~~~
<!-- new -->
~~~text
      {(milestones || recordMoments.length > 0) && (
        <MilestoneWatch
          ctx={milestones ?? null}
          moments={milestoneMoments}
          idx={idx}
          box={box}
          teamOf={milestoneTeamOf}
          hideNear={!live && idx >= events.length - 1}
          appeared={milestoneAppeared}
          records={recordMoments}
          recordTeamOf={recordTeamOf}
        />
      )}
~~~

- [ ] **Step 5: 통과 확인**

Run:

```bash
cd courtside-web
npx vitest run components/MilestoneWatch.test.tsx
npx tsc --noEmit
npx eslint components/MilestoneWatch.tsx components/GameReplay.tsx
```

Expected: 패널 테스트 4개 통과, `tsc`·`eslint` 출력 없음.

- [ ] **Step 6: 커밋**

```bash
git add courtside-web/components/MilestoneWatch.tsx courtside-web/components/MilestoneWatch.test.tsx courtside-web/components/GameReplay.tsx
git commit -m "$(cat <<'EOF'
feat(web): "역대 기록" group in the record watch panel and toasts for new TOP10 entries

The panel renders the all-time group first (works even when the career-milestone context is
absent), live rows say 잠정, and GameReplay feeds record moments into the same push-toast
pipeline (last in the burst, so a rare record is not pushed out by common toasts).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: 경기 후 리포트 "역대 기록" 섹션과 페이지 연결

**Files:**
- Modify: `courtside-web/lib/postgameReport.ts` (섹션 함수·입력 필드·호출)
- Modify: `courtside-web/lib/postgameReport.test.ts` (import + 테스트 추가)
- Modify: `courtside-web/app/games/[gmkey]/page.tsx` (5곳)

**Interfaces:**
- Consumes: Task 5의 `buildRecordTimeline`, `RecordContext`, `RecordMoment`, `RecordNames`; Task 6의 `getRecordContext`
- Produces: `recordBookSection(ctx, events, tags, names) -> ReportSection | null` (export), `BuildReportInput.records?: RecordContext | null`, 보고서 섹션 제목 `"역대 기록"`(= "경기 결과" 바로 다음, "기록 달성" 앞)

- [ ] **Step 1: 리포트 테스트 추가**

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~text
  recordChanceList,
  recordsSection,
} from "./postgameReport";
~~~
<!-- new -->
~~~text
  recordBookSection,
  recordChanceList,
  recordsSection,
} from "./postgameReport";
import type { RecordContext } from "./records";
~~~

<!-- edit: courtside-web/lib/postgameReport.test.ts -->
<!-- old -->
~~~text
    expect(html).not.toContain("마레이<b>");
  });
});
~~~
<!-- new -->
~~~text
    expect(html).not.toContain("마레이<b>");
  });
});

describe("역대 기록 섹션 (요청 2026-10-08)", () => {
  const home = { tcode: "H", name: "홈팀", abbr: "홈", color: "#111111" };
  const away = { tcode: "A", name: "원정팀", abbr: "원정", color: "#222222" };
  const tags = createReportTags(home, away);
  const names = { player: (p: string) => (p === "p1" ? "허훈" : p), team: (t: string) => (t === "H" ? "홈팀" : "원정팀") };
  const board = (tops: number[]) => ({ tops, holders: [{ v: tops[0], who: "문태종", d: "2010-12-15" }] });
  const EIGHTS = [8, 8, 8, 8, 8, 8, 7, 7, 7, 7];
  const ctx = (validated?: string[]): RecordContext => ({
    asOf: "2026-10-07 19:00",
    boards: { "pq.ast.max|Q1": board(EIGHTS), "pq.ast.max|ALL": board(EIGHTS) },
    ...(validated ? { validated } : {}),
  });
  // PRE 행 + 1쿼터 어시스트 9개(허훈 = p1). 어시스트 k번째 이벤트의 인덱스 = k, 9번째의 남은 시간 = 1:00.
  const events = attachDerivedFields([
    ev({ event_order: 0, quarter: "PRE", home_score: 0, away_score: 0, home_win_prob: 0.5 }),
    ...Array.from({ length: 9 }, (_, i) =>
      ev({ event_order: i + 1, quarter: "Q1", clock_min: 9 - i, clock_sec: 0, home_score: 0, away_score: 0, action_code: "211", pcode: "p1", player_name: "허훈", tcode: "H", home_win_prob: 0.5 })
    ),
  ]);

  it("같은 선수·보드의 7개 -> 8개 -> 9개는 마지막(신기록) 한 줄만, 점프 링크와 팀 칩과 조사를 붙인다", () => {
    const sec = recordBookSection(ctx(["pq.ast.max|Q1|p1|Q1"]), events, tags, names)!;
    expect(sec.title).toBe("역대 기록");
    const html = htmlOf(sec);
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).toContain('<a href="#" class="report-jump-link" data-jump-idx="9">Q1 1:00</a>');
    expect(html).toContain("허훈</b></span>이 "); // 받침 있는 이름 + 이
    expect(html).toContain("1쿼터 어시스트 9개 KBL 신기록(종전 8개)");
    expect(html).toContain("1쿼터 기준 신기록 · 종전 최고 8개: 문태종");
    expect(html).toContain("KBL 역대 TOP10 기준");
  });

  it("종료 경기에서 테이블에 없는 항목(validated 밖)은 쓰지 않고, 아무것도 없으면 null", () => {
    expect(recordBookSection(ctx([]), events, tags, names)).toBeNull();
    expect(recordBookSection(ctx(["pq.ast.max|Q2|p1|Q2"]), events, tags, names)).toBeNull();
    expect(recordBookSection({ asOf: "x", boards: {}, validated: [] }, events, tags, names)).toBeNull();
  });

  it("buildPostgameReport - records를 주면 '경기 결과'와 '기록 달성' 사이에 들어가고, 안 주면 섹션이 없다", () => {
    const box = [{ pcode: "p1", tcode: "H", name: "허훈", is_starter: true, pts: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, reb: 0, ast: 9, stl: 0, blk: 0, fouls: 0, turnovers: 0 }];
    const base = { events, box, homeTeam: home, awayTeam: away, homeScore: 2, awayScore: 0, rarity: null };
    const milestones = {
      split: "regular" as const,
      asOf: "2026-10-06",
      players: { p1: { name: "허훈", tcode: "H", before: { pts: 0, reb: 0, ast: 98, stl: 0, blk: 0, threep: 0 }, targets: [{ kind: "step" as const, cat: "ast" as const, at: 100 }] } },
    };
    const titles = buildPostgameReport({ ...base, milestones, records: ctx(["pq.ast.max|Q1|p1|Q1"]) }).map((s) => s.title);
    expect(titles.indexOf("역대 기록")).toBe(titles.indexOf("경기 결과") + 1);
    expect(titles.indexOf("기록 달성")).toBe(titles.indexOf("역대 기록") + 1);
    expect(buildPostgameReport(base).map((s) => s.title)).not.toContain("역대 기록");
    expect(buildPostgameReport({ ...base, records: null }).map((s) => s.title)).not.toContain("역대 기록");
  });
});
~~~

- [ ] **Step 2: 실패 확인**

Run: `cd courtside-web && npx vitest run lib/postgameReport.test.ts`

Expected: FAIL — `recordBookSection`이 export되지 않았다(`recordBookSection is not a function` / 타입 오류).

- [ ] **Step 3: 리포트 모듈 편집 (4곳)**

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~text
import { basisNote, buildMilestoneTimeline, type MilestoneContext, type RecordChance } from "./milestones";
~~~
<!-- new -->
~~~text
import { basisNote, buildMilestoneTimeline, type MilestoneContext, type RecordChance } from "./milestones";
import { buildRecordTimeline, type RecordContext, type RecordMoment, type RecordNames } from "./records";
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~text
export type BuildReportInput = {
~~~
<!-- new -->
~~~text
/**
 * 역대 기록 - 이 경기에서 KBL 역대 TOP10(쿼터·경기·연장별 최다/최소)에 닿은 기록(요청 2026-10-08). 계산은 라이브 "기록 워치"의 역대 기록과 같은
 * buildRecordTimeline을 **종료 경기의 최종 이벤트**로 돌려 시각(점프 링크)을 얻고, 테이블에 있는(= 공식 기록과 대조를 통과한) 항목만 쓴다.
 * 같은 (보드·대상·구간)에서 여러 번 알린 것(7개 -> 8개 -> 9개)은 마지막(가장 좋은) 한 줄만. 없으면 null.
 */
export function recordBookSection(ctx: RecordContext, events: GameEvent[], tags: ReportTags, names: RecordNames): ReportSection | null {
  const last = new Map<string, RecordMoment>();
  for (const m of buildRecordTimeline(ctx, events, { names, final: true })) if (m.phase === "done") last.set(`${m.board}|${m.subject}|${m.period}`, m);
  const done = [...last.values()];
  if (done.length === 0) return null;
  const shown = done
    .sort((a, b) => a.sig - b.sig || a.idx - b.idx)
    .slice(0, RECORDS_MAX)
    .sort((a, b) => a.idx - b.idx);
  const items = shown
    .map((m) => {
      const who = m.scope === "p" ? tags.playerTag(m.name, m.tcode) : tags.teamTag(m.tcode, m.name);
      return `${tags.liOpen(m.tcode)}${who}${iGa(m.name)} ${jumpLink(m.idx, escHtml(m.clock))} ${escHtml(m.text)}${m.detail ? `(${escHtml(m.detail)})` : ""}.</li>`;
    })
    .join("");
  const rest = done.length - shown.length;
  const more = rest > 0 ? `<p class="report-caveat">그 밖에 ${rest}건의 기록이 더 있었음 - 실시간 중계 탭의 "기록 워치"에서 전부 볼 수 있습니다.</p>` : "";
  return { title: "역대 기록", html: `<ul class="report-list">${items}</ul>${more}<p class="report-caveat">KBL 역대 TOP10 기준 · 정규시즌·플레이오프 합산 · 공식 기록과 대조를 통과한 경기만 집계</p>` };
}

export type BuildReportInput = {
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~text
  milestones?: MilestoneContext | null;
};
~~~
<!-- new -->
~~~text
  milestones?: MilestoneContext | null;
  /** 이 경기 이전 기준 KBL 역대 TOP10 요약(lib/recordBook.ts getRecordContext, 종료 경기라 validated 포함) - '역대 기록'. 없으면 그 섹션만 빠진다. */
  records?: RecordContext | null;
};
~~~

<!-- edit: courtside-web/lib/postgameReport.ts -->
<!-- old -->
~~~text
  // 1.1 기록 달성 - "경기 결과" 바로 아래
~~~
<!-- new -->
~~~text
  // 1.05 역대 기록 - "경기 결과" 바로 아래, 선수 통산 기록('기록 달성')보다 위: KBL 역대 TOP10에 닿은 쿼터·경기 기록(새 조회 0회).
  if (input.records) {
    const book = recordBookSection(input.records, events, tags, {
      player: (pcode) => boxByPcode.get(pcode)?.name ?? pcode,
      team: (tcode) => (tcode === homeTcode ? homeTname : tcode === awayTcode ? awayTname : tcode),
    });
    if (book) sections.push(book);
  }

  // 1.1 기록 달성 - "경기 결과" 바로 아래
~~~

- [ ] **Step 4: 리포트 테스트 통과 확인**

Run: `cd courtside-web && npx vitest run lib/postgameReport.test.ts && npx tsc --noEmit`

Expected: 테스트 28개 통과(기존 25 + 새 3), `tsc` 출력 없음.

- [ ] **Step 5: 페이지 연결 (5곳)**

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~text
import { basisNote, buildRecordChances } from "@/lib/milestones";
~~~
<!-- new -->
~~~text
import { basisNote, buildRecordChances } from "@/lib/milestones";
import { getRecordContext } from "@/lib/recordBook";
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~text
        : [...liveTcodeByPcode].map(([pcode, tcode]) => ({ pcode, name: livePlayerFallback.get(pcode)?.name ?? pcode, tcode }))
    ),
    null
  );
~~~
<!-- new -->
~~~text
        : [...liveTcodeByPcode].map(([pcode, tcode]) => ({ pcode, name: livePlayerFallback.get(pcode)?.name ?? pcode, tcode }))
    ),
    null
  );
  // KBL 역대 기록(쿼터·경기·연장별 TOP10) 요약 - 이 경기 이전 기준(lib/recordBook.ts). 예정 경기는 실시간 탭·경기 후 리포트가 없어 건너뛰고,
  // 실패하면 이 기능만 사라진다(soft). 읽기는 10분 캐시이고 경기 종료 정산이 'records' 태그로 즉시 비운다.
  const recordsPromise = status === "scheduled" ? Promise.resolve(null) : soft("records", getRecordContext(game, status === "final"), null);
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~text
  const milestones = await milestonesPromise;
~~~
<!-- new -->
~~~text
  const milestones = await milestonesPromise;
  const records = await recordsPromise;
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~text
      milestones,
    });
~~~
<!-- new -->
~~~text
      milestones,
      records,
    });
~~~

<!-- edit: courtside-web/app/games/[gmkey]/page.tsx -->
<!-- old -->
~~~text
            milestones={milestones}
~~~
<!-- new -->
~~~text
            milestones={milestones}
            records={records}
~~~

- [ ] **Step 6: 전체 확인**

Run:

```bash
cd courtside-web
npx tsc --noEmit
npx eslint lib components app
npx vitest run
```

Expected: `tsc` 출력 없음, `eslint` 에러 0(기존 경고만), vitest 전체 통과(건너뜀 포함).

- [ ] **Step 7: 커밋**

```bash
git add courtside-web/lib/postgameReport.ts courtside-web/lib/postgameReport.test.ts "courtside-web/app/games/[gmkey]/page.tsx"
git commit -m "$(cat <<'EOF'
feat(web): "역대 기록" section in the post-game report and page wiring

The report replays the final events against the as-of book to get click-through times,
keeps only rows present in the table (validated against official numbers), one line per
board/subject/period (the best), and sits right after "경기 결과". The page starts the
record-book read next to the milestone context; scheduled games skip it, failures drop only
this feature.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: 알림 빈도 실측(게이트 테스트)과 문서 정정

**Files:**
- Create: `courtside-web/lib/records.frequency.test.ts`
- Modify: `docs/superpowers/specs/2026-10-08-record-book-design.md` (4곳 정정·보강)
- Modify: `README.md` (운영 런북에 "역대 기록" 항목)

**Interfaces:** (없음 - 측정과 문서)

- [ ] **Step 1: 빈도 실측 테스트 작성**

<!-- create: courtside-web/lib/records.frequency.test.ts -->
~~~typescript
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRecordTimeline, type RecordMoment } from "./records";
import { summarizeRecordBook, type RecordEntry } from "./recordBook";

// 알림 빈도 실측 - 한 시즌 전 경기를 "그 경기 이전" 기록으로 재생해 경기당 기록 알림(done) 수의 분포를 본다(설계 §10-5).
// 입력은 tools/dump_record_fixtures.py --freq OUTDIR --prefix S47 --entries PATH 가 만든다. 환경변수가 없으면 건너뛴다.
//   RECORD_FREQ_EVENTS=<OUTDIR> RECORD_FREQ_ENTRIES=<PATH> npx vitest run lib/records.frequency.test.ts --disableConsoleIntercept
// 2025-26 정규시즌 270경기 실측(2026-10-08): 경기당 평균 0.55개, 상위 5% 2개, 최대 23개(허웅 51점·3점슛 11개+ 경기) -> TOP10 전부 토스트로 알려도 된다.

const EV_DIR = process.env.RECORD_FREQ_EVENTS;
const ENTRIES = process.env.RECORD_FREQ_ENTRIES;
const suite = EV_DIR && ENTRIES && existsSync(EV_DIR) && existsSync(ENTRIES) ? describe : describe.skip;

type Game = { gmkey: string; date: string; start: string; names: Record<string, string>; teams: Record<string, string>; events: [string | null, string | null, string, string, number | null, number | null][] };

suite("알림 빈도 실측", () => {
  it("경기당 달성 알림 수", { timeout: 300_000 }, () => {
    const entries: RecordEntry[] = (JSON.parse(readFileSync(ENTRIES!, "utf8")) as Record<string, string | number>[]).map((r) => ({
      board: r.board as string, bucket: r.bucket as string, gmkey: r.gmkey as string, subject: r.subject as string, period: r.period as string,
      value: r.value as number, date: r.game_date as string, start: r.game_start as string, name: r.subject_name as string,
    }));
    const perGame: { gmkey: string; done: RecordMoment[] }[] = [];
    for (const f of readdirSync(EV_DIR!).filter((x) => x.endsWith(".json")).sort()) {
      const g = JSON.parse(readFileSync(join(EV_DIR!, f), "utf8")) as Game;
      const ctx = summarizeRecordBook(entries, { date: g.date, start: g.start, gmkey: g.gmkey }, false);
      const events = g.events.map(([pcode, tcode, action_code, quarter, clock_min, clock_sec]) => ({ pcode, tcode, action_code, quarter, clock_min, clock_sec }));
      const done = ctx ? buildRecordTimeline(ctx, events, { names: { player: (p) => g.names[p] ?? p, team: (t) => g.teams[t] ?? t }, final: true }).filter((m) => m.phase === "done") : [];
      perGame.push({ gmkey: g.gmkey, done });
    }
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return { n: s.length, mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2), p50: q(0.5), p90: q(0.9), p95: q(0.95), max: s[s.length - 1], atLeast1: xs.filter((x) => x >= 1).length, atLeast3: xs.filter((x) => x >= 3).length };
    };
    const byRank = { first: 0, top3: 0, top5: 0, top10: 0 };
    const byBoard = new Map<string, number>();
    for (const { done } of perGame) {
      for (const m of done) {
        if (m.breaks || m.rank === 1) byRank.first++;
        else if (m.rank <= 3) byRank.top3++;
        else if (m.rank <= 5) byRank.top5++;
        else byRank.top10++;
        byBoard.set(m.board, (byBoard.get(m.board) ?? 0) + 1);
      }
    }
    console.log("전체(TOP10) 달성 알림/경기:", JSON.stringify(stat(perGame.map((p) => p.done.length))));
    console.log("순위 5위 이내만(신기록·타이·2~5위):", JSON.stringify(stat(perGame.map((p) => p.done.filter((m) => m.breaks || m.rank <= 5).length))));
    console.log("순위별 합계:", JSON.stringify(byRank));
    console.log("보드별 상위:", JSON.stringify([...byBoard].sort((a, b) => b[1] - a[1]).slice(0, 12)));
    for (const { gmkey, done } of [...perGame].sort((a, b) => b.done.length - a.done.length).slice(0, 3)) {
      console.log("알림이 가장 많은 경기", gmkey, done.length);
      for (const m of done.slice(0, 25)) console.log("   ", m.idx, m.clock, m.board, m.bucket, m.name, "-", m.text);
    }
    expect(perGame.length).toBeGreaterThan(100);
  });
});
~~~

- [ ] **Step 2: 한 시즌(2025-26) 이벤트와 순위 ≤ 50 항목 덤프 (약 1분)**

```bash
FREQ="$(mktemp -d)"
cd tools
PYTHONIOENCODING=utf-8 "$PY" dump_record_fixtures.py --freq "$FREQ/events" --prefix S47 --entries "$FREQ/entries.json"
cd ../courtside-web
RECORD_FREQ_EVENTS="$(cygpath -m "$FREQ/events")" RECORD_FREQ_ENTRIES="$(cygpath -m "$FREQ/entries.json")" npx vitest run lib/records.frequency.test.ts --disableConsoleIntercept --reporter=dot
cd ..
```

Expected(2026-10-08 실측): `freq events: 270경기`, 그리고 `전체(TOP10) 달성 알림/경기: {"n":270,"mean":0.55,...,"p95":2,"max":23,...}`, `순위 5위 이내만 ... "mean":0.25`. **판정 기준**: 평균 ≤ 1이고 상위 5% ≤ 3이면 TOP10 전부 토스트(현재 구현). 넘으면 `computePushNotifications`의 기록 토스트를 `m.rank <= 5 || m.breaks`로 제한하고 나머지는 패널 전용으로 바꾼다. 알림이 가장 많은 경기(S47G01N184, 허웅 51점·3점슛 11개+ 경기)의 줄들이 모두 실제 사건인지 훑어본다.

- [ ] **Step 3: 스펙 정정·보강 (5곳)**

<!-- edit: docs/superpowers/specs/2026-10-08-record-book-design.md -->
<!-- old -->
~~~text
- 개발·테스트는 별도 git 워크트리에서 한다(수집기가 메인 작업트리에서 돌고 있어 직접 편집하면 즉시 운영에 반영된다).
~~~
<!-- new -->
~~~text
- 수집기가 메인 작업트리에서 돌고 있어 직접 편집하면 즉시 운영에 반영된다. 그래서 수집기가 읽는 두 파일(`live_collector.py`, `daily_batch.py`)은
  복사본에서 편집·테스트해 통과한 뒤 같은 편집을 적용하고 곧바로 import를 확인한다(그 밖의 새 파일은 수집기가 읽지 않으므로 메인 트리에서 바로 작업한다).
~~~

<!-- edit: docs/superpowers/specs/2026-10-08-record-book-design.md -->
<!-- old -->
~~~text
- 팀 쿼터 득점 보드 = `meta.json` `teamrecords` (`scoreq1..4`, 연장은 `scoreeq[k]`)
~~~
<!-- new -->
~~~text
- 팀 쿼터 득점 보드 = `meta.json` `teamrecords` (`scoreq1..4`, 연장은 `scoreeq[k]`)
  - 단, 그 팀의 쿼터 점수 합(+ 연장)이 팀 최종 점수와 같을 때만 쓴다. 2009-01-21 S13G01N167은 연장 점수 배열이 양 팀 똑같이 `[6,9,13]`으로
    잘못 들어 있어(공식 팀 기록은 135-132, 경기 메타로는 113-113) 합이 안 맞는다. 5,682경기 중 이 한 경기뿐이다.
~~~

<!-- edit: docs/superpowers/specs/2026-10-08-record-book-design.md -->
<!-- old -->
~~~text
- 종료 경기는 `validated`에 없는 기록 이벤트(moment)를 버린다. 라이브(진행 중) 경기는 전부 "잠정"으로 표시한다.
~~~
<!-- new -->
~~~text
- 종료 경기는 `validated`에 없는 기록 이벤트(moment)를 버린다. 라이브(진행 중) 경기는 전부 "잠정"으로 표시한다.
- 신기록(1위 초과)을 깬 뒤에는 순위 단계가 더 오르지 않아도 값이 오를 때마다 다시 알린다(예: 허웅 2026-02-02 3점슛 11개 -> 12개 -> 13개 -> 14개).
~~~

<!-- edit: docs/superpowers/specs/2026-10-08-record-book-design.md -->
<!-- old -->
~~~text
팀 경기 최다 121점(KT 2018-03-02)
~~~
<!-- new -->
~~~text
팀 경기 최다 135점·2위 132점(원주동부·서울삼성, 2009-01-21 S13G01N167 3차 연장 135-132)·3위 121점(KT 2018-03-02)
~~~

<!-- edit: docs/superpowers/specs/2026-10-08-record-book-design.md -->
<!-- old -->
~~~text
토스트를 순위 5위까지로 줄이고 나머지는 패널 전용으로 한다(이 수치는 추정치이며 여기서 확정한다).
~~~
<!-- new -->
~~~text
토스트를 순위 5위까지로 줄이고 나머지는 패널 전용으로 한다.
   **실측(2026-10-08, 2025-26 정규시즌 270경기를 "그 경기 이전" 기록으로 재생)**: 경기당 평균 0.55개, 중앙값 0, 상위 10%·5% 2개, 1개 이상 76경기(28%), 3개 이상 13경기(5%),
   최대 23개(허웅 51점·3점슛 11개 이상 경기 - 모두 실제 사건). 5위 이내만 세면 평균 0.25개. 기준(평균 ≤ 1, 상위 5% ≤ 3)을 만족하므로 **TOP10 전부 토스트**로 확정한다.
~~~

- [ ] **Step 4: README 운영 런북에 항목 추가**

<!-- edit: README.md -->
<!-- old -->
~~~text
**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~
<!-- new -->
~~~text
**역대 기록(Record Book)** (2026-10-08, 설계 `docs/superpowers/specs/2026-10-08-record-book-design.md`) - KBL 역대 TOP10(팀·선수의
쿼터/경기/연장별 최다·최소)를 Supabase `record_entries`에 보관해 라이브 "🏆 역대 기록"과 경기 후 리포트 "역대 기록"이 읽는다.

- 경기가 끝나면 `live_collector.reconcile_finished_game`이 이벤트 이관 뒤 `record_book.py --gmkeys <gmkey>`를 부른다(실패해도 정산 결과는 그대로,
  로그 `raw/live_collector.log`에 `record_book.py -> exit N`). 놓친 경기는 매일 06:00 `daily_batch.py`가 같은 호출로 복구한다(멱등).
- 수동: `python record_book.py --gmkeys S49G01N9` (한 경기 반영) / `--rebuild --dry-run` (DB 없이 전체 계산·요약) / `--rebuild` (테이블 교체 - 기록 정의나
  검증 게이트를 고친 뒤) / `--verify` (raw에서 다시 계산한 것과 테이블 비교, 다르면 종료코드 1 - 월 1회 점검).
- 기록 정의를 고치면 `tools/test_record_book.py`(`RECORD_BOOK_SLOW=1`이면 실데이터 단언)와 웹 `lib/records.parity.test.ts`가 둘 다 통과해야 한다
  (파이썬과 웹이 같은 정의를 쓰는지 실제 경기 10개로 고정). 픽스처 재생성: `python dump_record_fixtures.py --parity <폴더> --gmkeys ...`.
- 테이블 적용/롤백: `schema_record_book.sql` / `rollback_record_book.sql`. RLS 켬 + 정책 없음 + anon 권한 회수라 익명은 못 읽는다(서버만).
- 이벤트는 옛 경기(2006~09)에서 공식 기록과 어긋난다(김승현 2007-03-23 공식 11어시스트, 이벤트 15개) - 이벤트 기반 보드는 공식 쿼터 점수·박스 합계와 대조를
  통과한 경기만 쓴다. 이 검증 때문에 "기록을 놓칠 수는 있어도 틀린 기록은 안 만든다".

**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
~~~

- [ ] **Step 5: 확인과 커밋**

Run: `cd courtside-web && npx vitest run lib/records.frequency.test.ts` — Expected: 환경변수가 없으면 `skipped`(실패 아님).

```bash
git add courtside-web/lib/records.frequency.test.ts docs/superpowers/specs/2026-10-08-record-book-design.md docs/superpowers/plans README.md
git commit -m "$(cat <<'EOF'
docs/test(records): alert-frequency measurement, spec corrections, README runbook

Replaying the 270 games of 2025-26 against as-of books gives 0.55 record alerts per game
(p95 2), so every TOP10 entry stays a toast. The spec's team-points example is corrected
(135, not 121 - the 2009 triple-overtime game) and the official quarter-sum gate is written
down.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: 테이블 적용 · 전체 빌드 · 검증 (**사용자 확인 필요 - 운영 DB 변경**)

**Files:** (코드 변경 없음 - 운영 작업)

**먼저 사용자에게 확인한다**: "Supabase에 새 테이블 `record_entries` 1개를 만듭니다(RLS 켬·정책 없음·anon 권한 회수, 다른 앱·테이블 영향 없음, 롤백 `rollback_record_book.sql`). 진행할까요?"

- [ ] **Step 1: DDL 적용**

Run (저장소 루트, 메인 작업트리 - `tools/.env.supabase`가 있는 곳):

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(open('schema_record_book.sql', encoding='utf-8').read()); c.commit(); print('schema applied')"
cd ..
```

Expected: `schema applied`.

- [ ] **Step 2: 익명 접근이 막혀 있는지 확인**

```bash
cd courtside-web
KEY="$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' .env.local | cut -d= -f2-)"
URL="$(grep '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2-)"
curl -s -o /dev/null -w "%{http_code}\n" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$URL/rest/v1/record_entries?select=board&limit=1"
cd ..
```

Expected: `401`(또는 `403`) — 데이터가 아니라 권한 오류여야 한다. `200`이면 즉시 `rollback_record_book.sql`을 적용하고 원인을 조사한다.

- [ ] **Step 3: 전체 빌드 (약 30초)**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" record_book.py --rebuild
```

Expected: `경기 5682개(이벤트 검증 통과 5231개)...`, `보관 행 2773개 / 보드·구간 80개`, `교체 완료: 2773행` (경기가 늘었으면 약간 더 크다).

- [ ] **Step 4: 검증과 멱등성**

```bash
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
PYTHONIOENCODING=utf-8 "$PY" record_book.py --gmkeys S49G01N9
PYTHONIOENCODING=utf-8 "$PY" record_book.py --gmkeys S49G01N9
PYTHONIOENCODING=utf-8 "$PY" record_book.py --verify
cd ..
```

Expected: 첫 `--verify` → `검증: 없는 행 0 / 남는 행 0 / 값이 다른 행 0`(종료코드 0). `--gmkeys S49G01N9`를 두 번 돌려도 `{'candidates': ..., 'pruned': ..., 'boards': ...}`가 같고, 마지막 `--verify`도 0/0/0.

- [ ] **Step 5: 알려진 기록이 테이블에 있는지 확인**

```bash
cd tools
PYTHONIOENCODING=utf-8 "$PY" -c "import sys; sys.path.insert(0, '.'); from sync_upcoming_games import get_conn; c = get_conn(); cur = c.cursor(); cur.execute(\"select value, subject_name, gmkey, game_date from record_entries where board = 'pq.ast.max' and bucket = 'Q1' order by value desc, game_date limit 6\"); [print(r) for r in cur.fetchall()]"
cd ..
```

Expected: 첫 줄이 `(9, '허훈', 'S49G01N9', ...)`, 이어서 8개 항목들(허훈 2020 S35G01N201 포함).

---

### Task 12: 배포와 프로덕션 검증 (**푸시 전 사용자 확인 필요**)

**Files:** (코드 변경 없음)

**먼저 사용자에게 확인한다**: "로컬 커밋 N개(Task 1~10)를 `main`에 푸시합니다. Vercel이 courtside-web을 배포합니다. 진행할까요?"

- [ ] **Step 1: 푸시 전 최종 확인**

```bash
git fetch origin && git status -sb | head -3
cd courtside-web && npx tsc --noEmit && npx eslint lib components app && npx vitest run && cd ..
PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book.py && PYTHONIOENCODING=utf-8 "$PY" tools/test_record_book_hook.py
```

Expected: 로컬이 `origin/main`보다 앞서 있기만 하고(뒤처졌으면 `git pull --rebase`), 모든 검사 통과.

- [ ] **Step 2: 푸시와 배포 대기**

```bash
git push origin main
gh api repos/onnebang/kbl_realdata/commits/$(git rev-parse --short HEAD)/status --jq '[.statuses[] | {context, state}]'
```

`Vercel – courtside-web`이 `success`가 될 때까지 확인한다(`Vercel – kbl-realdata`의 "Deployment was blocked" 실패는 기존 증상이라 무관).

- [ ] **Step 3: 프로덕션 확인 — 허훈 경기(S49G01N9) 리포트**

```bash
curl -s --compressed "https://courtside-web-ten.vercel.app/games/S49G01N9" -o /tmp/s49g01n9.html
grep -c "역대 기록" /tmp/s49g01n9.html
grep -o "1쿼터 어시스트 9개 KBL 신기록(종전 8개)" /tmp/s49g01n9.html | head -1
grep -c "Application error" /tmp/s49g01n9.html
```

Expected: `역대 기록` 1회 이상, 신기록 문장 1줄, `Application error` 0. 같은 페이지의 라이브 탭 데이터에 보드 요약이 실렸는지(`pq.ast.max|Q1`)도 `grep -c 'pq.ast.max|Q1' /tmp/s49g01n9.html`로 본다(1 이상).

- [ ] **Step 4: 다른 경기 회귀 확인**

```bash
for g in S49G01N8 S49G01N10 S47G01N148; do curl -s -o /dev/null -w "$g %{http_code} %{time_total}s\n" --compressed "https://courtside-web-ten.vercel.app/games/$g"; done
```

Expected: 모두 `200`, 응답시간이 이전(예정 경기 약 0.6초, 종료 경기 1.2~1.7초)과 비슷하다. 지난 시즌 경기(S47G01N148)는 60일 초과라 `역대 기록` 섹션이 없다.

- [ ] **Step 5: 다음 실제 경기 정산 후 확인**

오늘(2026-10-08)의 S49G01N10이 끝난 뒤:

```bash
grep -n "record_book" raw/live_collector.log | tail -5
PYTHONIOENCODING=utf-8 "$PY" tools/record_book.py --verify
```

Expected: `record_book.py -> exit 0`가 그 경기 정산 로그에 찍히고, `--verify`가 0/0/0. 경기에서 TOP10 기록이 나왔다면 프로덕션 리포트 "역대 기록"에도 보인다.

- [ ] **Step 6: 실패 시 롤백 순서**

웹 문제: 해당 커밋을 `git revert`(테이블이 없어도 기록 UI만 사라지는 구조라 DB는 그대로 둬도 된다). 정산 훅 문제: `tools/live_collector.py`·`tools/daily_batch.py`의 훅 호출 두 곳을 제거. DB 정리: `rollback_record_book.sql`.
