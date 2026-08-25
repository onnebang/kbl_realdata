-- KBL 실시간 승률 예측 시스템 - 저장 스키마 (로드맵 04단계)
-- 로컬 SQLite 기준으로 설계 (분석/리서치 단계라 Supabase 같은 공유 백엔드가 아직 불필요 -
-- kbl540 카드게임과 달리 이건 아직 여러 사용자가 접속하는 서비스가 아니라 데이터 파이프라인임.
-- 나중에 실시간 서빙 단계(로드맵 06)에서 필요해지면 이 스키마 그대로 Postgres/Supabase로 옮기면 됨.

CREATE TABLE games (
    gmkey           TEXT PRIMARY KEY,        -- 예: S47G14N1
    season_code     INTEGER NOT NULL,
    season_name     TEXT NOT NULL,           -- 예: 2025-2026
    season_category TEXT NOT NULL,           -- R/PO/CU/AS/OM/D1/D2/EA
    game_date       TEXT NOT NULL,           -- YYYYMMDD
    home_tcode      TEXT NOT NULL,
    away_tcode      TEXT NOT NULL,
    home_name       TEXT NOT NULL,
    away_name       TEXT NOT NULL,
    home_score      INTEGER,
    away_score      INTEGER,
    stadium         TEXT,
    attendance      INTEGER,
    -- 백투백/휴식일수 계산용 - 팀별 직전 경기 날짜와의 차이를 로드 시점에 채워 넣는다
    home_rest_days  INTEGER,
    away_rest_days  INTEGER,
    score_validated INTEGER NOT NULL DEFAULT 0  -- build_lineup_stints.py의 validation 통과 여부
);

CREATE TABLE player_game_stats (
    gmkey       TEXT NOT NULL REFERENCES games(gmkey),
    pcode       TEXT NOT NULL,
    pname       TEXT NOT NULL,
    tcode       TEXT NOT NULL,
    home_away   TEXT NOT NULL,       -- '1'=away, '2'=home (kbl API 값 그대로)
    start_flag  INTEGER NOT NULL,    -- 선발 여부
    play_min    INTEGER,
    play_sec    INTEGER,
    -- 1차 스탯
    score INTEGER, rb INTEGER, ast INTEGER, stl INTEGER, bs INTEGER, to_ INTEGER,
    fg INTEGER, fg_a INTEGER, threep INTEGER, threep_a INTEGER, ft INTEGER, ft_a INTEGER,
    foul INTEGER,
    -- 2차(어드밴스드) 스탯 - 전부 경기 단위(시즌 평균 아님)
    per REAL, offrtg REAL, defrtg REAL, netrtg REAL,
    efg_rt REAL, ts_rt REAL, usg_rt REAL, pace REAL, pie REAL,
    PRIMARY KEY (gmkey, pcode)
);

CREATE TABLE shot_log (
    gmkey     TEXT NOT NULL REFERENCES games(gmkey),
    pcode     TEXT NOT NULL,
    tcode     TEXT NOT NULL,
    quarter   TEXT NOT NULL,
    x         INTEGER NOT NULL,
    y         INTEGER NOT NULL,
    made      INTEGER NOT NULL,   -- o필드 'O'->1
    zone      TEXT                -- d필드 (2점/3점 구역 등)
);

-- 라인업 스틴트: 코트 위 10인 구성이 유지된 구간 하나 = 한 행.
-- 홈/원정 각 5명을 정렬된 pcode 콤마 문자열로 저장(SQLite엔 배열 타입이 없어서) -
-- 조합 단위(2인/3인) 집계는 애플리케이션 코드에서 조합을 풀어서 계산.
CREATE TABLE lineup_stints (
    stint_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    gmkey        TEXT NOT NULL REFERENCES games(gmkey),
    home_lineup  TEXT NOT NULL,   -- "pcode1,pcode2,pcode3,pcode4,pcode5" (정렬됨)
    away_lineup  TEXT NOT NULL,
    quarters     TEXT NOT NULL,   -- "Q1,Q2" 등 이 스틴트가 걸친 쿼터
    start_sec    INTEGER NOT NULL, -- 경기 시작부터 누적 경과초
    end_sec      INTEGER NOT NULL,
    duration_sec INTEGER NOT NULL,
    home_pts     INTEGER NOT NULL,
    away_pts     INTEGER NOT NULL
);

CREATE INDEX idx_pgs_pcode ON player_game_stats(pcode);
CREATE INDEX idx_stints_gmkey ON lineup_stints(gmkey);
CREATE INDEX idx_shotlog_pcode ON shot_log(pcode);

-- 분석 산출물(로드맵 03단계)은 이 원장 테이블들에서 매번 다시 계산하는 게 아니라
-- 별도 요약 테이블로 materialize 예정 - 아직 지표 정의가 확정되지 않아 스키마 보류.
-- 후보: player_on_off_rating / lineup_combo_rating / matchup_rating
