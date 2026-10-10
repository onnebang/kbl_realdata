-- 역대 기록(Record Book) 3단계 - 선수별 연속 상태 로그(최근 120일). 설계: docs/superpowers/specs/2026-10-10-record-book-streaks-design.md §4
-- 적용: README "역대 기록" 런북 참고. 롤백: rollback_record_streak_log.sql.
-- 서버(서비스 키)와 DATABASE_URL 쓰기 스크립트(tools/record_book.py -> record_streaks.py)만 접근한다 - 정책을 만들지 않고 anon/authenticated 권한도 회수한다.
create table if not exists record_streak_log (
  gmkey       text    not null,
  pcode       text    not null,
  kind        text    not null,                 -- gp | xfg_made | xfg_miss | xtp_made | xtp_miss | xft_made | xft_miss
  before_len  integer not null,                 -- 그 경기 전 연속 길이
  after_len   integer not null,                 -- 그 경기 후 연속 길이(끝났으면 0)
  start_gmkey text    not null,                 -- 그 연속이 시작된 경기(끝난 경우엔 끝난 연속의 시작)
  game_date   date    not null,
  game_start  text    not null default '',      -- 'HH:MM'
  alive       boolean not null default false,   -- 이 행이 그 선수·종목의 최신 행이고 연속이 지금도 이어지는 중
  primary key (gmkey, pcode, kind)
);
create index if not exists record_streak_log_alive_idx on record_streak_log (pcode, kind) where alive;
alter table record_streak_log enable row level security;
revoke all on record_streak_log from anon, authenticated;
