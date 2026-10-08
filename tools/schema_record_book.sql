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
