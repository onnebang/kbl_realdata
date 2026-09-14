-- ============================================================================
-- KBL 코트사이드 - Supabase(Postgres) 스키마
--
-- tools/schema_kbl_realdata.sql(로컬 SQLite, 분석 파이프라인 전용으로 설계했던 것)의
-- 최상단 주석이 이미 "나중에 실시간 서빙 단계에서 필요해지면 이 스키마 그대로
-- Postgres/Supabase로 옮기면 됨"이라고 예고해뒀던 그 포팅. 그 시점 이후 실제로
-- 코트사이드(라이브 승률 리플레이/매치업/득점 분포 탐색기/선수 프로필/슛 흐름 애니메이션)를
-- 만들어보면서 알게 된 걸 반영해 확장함:
--   - 팀 박스스코어(game_team_stats) 자체가 원래 스키마엔 없었음 - 매치업 페이지의
--     시즌 평균/순위 비교에 필요해서 추가.
--   - 플레이바이플레이 + 승률 타임라인(game_events)이 없었음 - "코트사이드"의 핵심 기능인데
--     원래 스키마는 결과가 확정된 경기 데이터만 모델링했었음.
--   - shot_log에 슛 시도 순번(shot_order)이 없었음 - 27차 "슛 흐름 애니메이션"이 정확한
--     시간순을 필요로 함.
--   - SQLite엔 배열 타입이 없어서 라인업을 콤마 문자열로 저장했었는데, Postgres 배열
--     타입 + GIN 인덱스로 바꾸면 "이 선수가 코트에 있던 스틴트 전부" 같은 조회가 훨씬 빠름.
--   - schedule(raw/schedule, 미래 경기 포함)과 games(완료된 경기만)가 원본 데이터에선
--     별도 폴더였는데, 여기선 games 하나로 합침(is_ended/점수 nullable로 미래 경기도
--     같은 테이블에 - 두 개로 나눌 이유가 없음).
--   - 요금제 페이지(24차)가 나중에 실제 결제와 연결될 걸 대비해 profiles/subscriptions
--     최소 골격만 추가(Stripe 등 실제 연동은 이후 별도 작업).
--
-- 실행 방법: Supabase 대시보드 > SQL Editor에 그대로 붙여넣고 실행. 순서대로 실행되게
-- 짜여있음(참조 관계 순서).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 기준 테이블
-- ---------------------------------------------------------------------------

create table teams (
  tcode     text primary key,        -- "10", "55" 등 원본 코드 그대로
  name      text not null,           -- "울산 현대모비스"
  abbr      text not null,           -- "MOB"
  color     text not null,           -- 실제 구단컬러 hex(embed_team_logos.py 확인값)
  logo_url  text                     -- Supabase Storage 공개 URL. 13개 팀 중 11개만 로고
                                      -- 있음(전자랜드/캐롯은 kbl.or.kr에서 아예 빠짐) - null이면
                                      -- 프론트에서 color로 배지 폴백.
);

create table coaches (
  coach_id  bigint generated always as identity primary key,
  name      text not null unique     -- 원본엔 이름만 있고 별도 코드가 없음(meta.json의
                                      -- staffs.manager.name) - 이름 기준으로 unique
);

create table seasons (
  season_name  text primary key,     -- "2025-2026"
  season_code  integer,              -- gmkey의 "S47" 부분(마이그레이션 스크립트가 파싱해서 채움)
  start_date   date,
  end_date     date
);

create table players (
  pcode      text primary key,
  name       text not null,
  ename      text,
  photo_url  text                    -- kbl.or.kr 원본 사진 URL을 Supabase Storage에
                                      -- 재호스팅(외부 호스트 의존 없애기 + 안정성)
);

-- 액션 코드 사전 - courtside_template.html의 ACTION_LABELS 객체를 DB로 옮김(프론트마다
-- 하드코딩 안 해도 되게).
create table action_codes (
  code   text primary key,
  label  text not null
);
insert into action_codes (code, label) values
  ('001','경기 시작'), ('002','경기 중단'), ('003','작전타임'), ('009','경기 종료'),
  ('101','교체 IN'), ('102','교체 OUT'),
  ('201','2점슛 성공'), ('202','2점슛 실패'), ('203','자유투 성공'), ('204','자유투 실패'),
  ('205','3점슛 성공'), ('206','3점슛 실패'), ('207','덩크슛 성공'), ('208','덩크슛 실패'),
  ('209','공격리바운드'), ('210','수비리바운드'), ('211','어시스트'), ('212','스틸'),
  ('213','블록'), ('214','턴오버'), ('215','파울자유투'), ('216','파울'),
  ('217','팀속공'), ('218','팀리바운드'), ('221','굿디펜스'), ('223','팀턴오버'),
  ('224','기타파울'), ('225','팀파울'), ('226','스크린 어시스트'), ('227','디플렉션'),
  ('228','비디오판독'), ('229','코치 챌린지');

-- ---------------------------------------------------------------------------
-- 경기
-- ---------------------------------------------------------------------------

-- 완료된 경기 + 예정 경기를 같은 테이블에 모음(원본은 raw/games=완료분만 상세,
-- raw/schedule=전체 일정을 별도 폴더로 나눠 관리했는데 합칠 이유가 없음). 예정 경기는
-- is_ended=false, 점수는 null.
create table games (
  gmkey            text primary key,          -- "S47G01N119"
  season_name      text not null references seasons(season_name),
  season_category  text not null,             -- 정규시즌/플레이오프/올스타 등
  game_date        date not null,
  game_start       time,
  home_tcode       text not null references teams(tcode),
  away_tcode       text not null references teams(tcode),
  home_coach_id    bigint references coaches(coach_id),
  away_coach_id    bigint references coaches(coach_id),
  home_score       integer,
  away_score       integer,
  is_ended         boolean not null default false,
  stadium          text,
  attendance       integer
);
create index idx_games_season on games(season_name);
create index idx_games_date on games(game_date);
create index idx_games_home on games(home_tcode);
create index idx_games_away on games(away_tcode);

-- 팀 박스스코어(경기당 2행) - 원래 SQLite 스키마엔 없던 테이블. 매치업 페이지(23차)의
-- 시즌 평균/리그 순위 비교에 필요해서 추가.
-- 리바운드: 원본 박스스코어 요약 필드(records.rb)엔 총 리바운드만 있고 공격/수비 분리가
-- 없음(분리 비율인 orebRt/drebRt는 있지만 원시 개수가 아님) - 그래서 reb(총량)는 이번
-- 마이그레이션에서 바로 채우고, oreb/dreb는 일단 null로 남겨둠. 실제 분리값은 플레이바이
--플레이의 209(공격리바운드)/210(수비리바운드) 이벤트를 세야 나오는데, 그건 game_events
-- 이관(승률모델 재실행이 필요한 별도 작업) 때 같이 채울 예정.
create table game_team_stats (
  gmkey      text not null references games(gmkey),
  tcode      text not null references teams(tcode),
  score integer, reb integer, oreb integer, dreb integer, ast integer, stl integer, blk integer,
  turnovers integer, fouls integer,
  fgm integer, fga integer, tpm integer, tpa integer, ftm integer, fta integer,
  off_rtg real, def_rtg real, net_rtg real, pace real, poss real,
  efg_pct real, ts_pct real, ast_pct real, oreb_pct real, dreb_pct real, tov_pct real,
  primary key (gmkey, tcode)
);

-- 선수 박스스코어 - 기존 SQLite 스키마와 거의 동일. back_num/pos는 선수 테이블이 아니라
-- 여기 남김(등번호·포지션은 시즌/팀마다 바뀔 수 있음 - players 테이블은 불변 정보만).
-- reb/oreb/dreb는 위 game_team_stats와 같은 이유로 reb만 지금 채움.
create table game_player_stats (
  gmkey       text not null references games(gmkey),
  pcode       text not null references players(pcode),
  tcode       text not null references teams(tcode),   -- "이 경기에서" 뛴 팀(트레이드 대응)
  back_num    text,
  pos         text,
  is_starter  boolean not null default false,
  min_played  numeric(5,2),        -- playMin + playSec/60
  pts integer, reb integer, oreb integer, dreb integer, ast integer, stl integer, blk integer,
  turnovers integer, fouls integer,
  fgm integer, fga integer, tpm integer, tpa integer, ftm integer, fta integer,
  per real, off_rtg real, def_rtg real, net_rtg real, usage_rtg real, pie real,
  primary key (gmkey, pcode)
);
create index idx_gps_pcode on game_player_stats(pcode);
create index idx_gps_tcode on game_player_stats(tcode);

-- 슛 시도 로그 - shot_order 추가(27차 슛 흐름 애니메이션이 정확한 시간순을 필요로 함).
-- x,y,d는 원본 좌표계 그대로 저장하고, 반코트 정규화(좌우반전)는 조회 시점에 처리
-- (courtside_template.html의 "x = d==='2' ? 750-x : x" 관례를 뷰나 쿼리에서 그대로 적용).
create table shot_log (
  shot_id     bigint generated always as identity primary key,
  gmkey       text not null references games(gmkey),
  pcode       text not null references players(pcode),
  tcode       text not null references teams(tcode),
  quarter     text not null,          -- "Q1".."Q4", 연장은 "X1"...
  shot_order  smallint not null,      -- 이 선수·이 경기 기준 시간순 순번(0부터)
  x           real not null,
  y           real not null,
  d           text not null,          -- 골대 방향 코드('1'/'2') - 원본 그대로
  made        boolean not null,
  unique (gmkey, pcode, shot_order)   -- 마이그레이션 재실행 시 ON CONFLICT로 중복 방지
);
-- (gmkey, pcode, shot_order)는 위 unique 제약이 이미 인덱스다. 선수 커리어 조회용 pcode 인덱스만 따로(shot_log_indexes.sql).
create index idx_shot_log_pcode on shot_log(pcode);

-- 플레이바이플레이 + 승률 타임라인 - "코트사이드" 라이브 리플레이의 핵심 데이터인데
-- 원래 SQLite 스키마엔 아예 없었음(그 스키마는 결과 확정 경기만 모델링).
-- home_win_prob/wpa_home은 build_live_winprob_data.py류 모델을 돌린 뒤 배치로 채워짐 -
-- 아직 모델을 안 돌린 경기는 null.
create table game_events (
  gmkey          text not null references games(gmkey),
  event_order    integer not null,     -- 경기 내 순번(0부터)
  quarter        text not null,
  clock_min      smallint,
  clock_sec      smallint,
  action_code    text references action_codes(code),
  pcode          text references players(pcode),
  tcode          text references teams(tcode),
  home_score     integer not null,     -- 이 이벤트 이후 누적 스코어
  away_score     integer not null,
  home_lineup    text[],               -- 이 시점 홈팀 코트 위 5인(pcode 배열)
  away_lineup    text[],
  home_win_prob  real,
  wpa_home       real,                 -- 직전 이벤트 대비 변화량
  objective_prob real,                 -- 중립 코트(홈어드밴티지 제거) 기준 승률 - AI 프리뷰의
                                        -- "객관적 승률"이 쓰는 값, 실제 UI에서 이미 쓰고 있어서 추가
  primary key (gmkey, event_order)
);
create index idx_events_gmkey on game_events(gmkey);
create index idx_events_pcode on game_events(pcode);

-- 라인업 스틴트 - 콤마 문자열(SQLite) -> 배열(Postgres) + GIN 인덱스로 업그레이드.
-- "이 선수가 코트에 있던 모든 스틴트"(온오프/조합 분석의 기반) 조회가 훨씬 빨라짐:
--   select * from lineup_stints where home_lineup @> array['pcode'] or away_lineup @> array['pcode'];
create table lineup_stints (
  stint_id     bigint generated always as identity primary key,
  gmkey        text not null references games(gmkey),
  home_lineup  text[] not null,   -- 정렬된 pcode 5개
  away_lineup  text[] not null,
  quarters     text[] not null,
  start_sec    integer not null,
  end_sec      integer not null,
  duration_sec integer not null,
  home_pts     integer not null,
  away_pts     integer not null,
  -- (gmkey, start_sec, end_sec)만으로는 부족함 - 실제로 한 경기(S25G01N140)에서 득점 없이
  -- 연달아 일어난 교체 3번이 전부 같은 초 단위 구간(1200~1336초)에 찍혀서 서로 다른
  -- 라인업인데도 겹침. 라인업까지 포함해야 진짜 중복(재실행)과 이런 실제 케이스를 구분함.
  unique (gmkey, start_sec, end_sec, home_lineup, away_lineup)
);
create index idx_stints_gmkey on lineup_stints(gmkey);
create index idx_stints_home_lineup on lineup_stints using gin(home_lineup);
create index idx_stints_away_lineup on lineup_stints using gin(away_lineup);

-- ---------------------------------------------------------------------------
-- 파생 데이터는 테이블이 아니라 뷰로 - 지금까지 Python 배치 스크립트가 손으로 짜던
-- "리크프리 누적 평균"(build_live_replay_demo.py의 season_box 누적기 등) 패턴을 윈도우
-- 함수 하나로 대체. 예시 하나만 - 같은 패턴으로 필요한 만큼 더 만들면 됨(선수 시즌 평균,
-- 리그 순위 등).
-- ---------------------------------------------------------------------------

-- 팀 시즌 누적 평균(그 경기 "들어가기 전까지", 정규시즌만) - 매치업 페이지의 seasonStats가
-- 하던 걸 그대로 대체.
create view team_season_running_avg
with (security_invoker = true)  -- Supabase 보안 어드바이저가 ERROR로 잡음: 이걸 안 주면
                                  -- Postgres 기본값(뷰 생성자 권한으로 실행)이라 조회자의
                                  -- RLS를 우회함 - 실제 프로젝트에 적용 후 advisor로 확인.
as
select
  gts.gmkey, g.season_name, gts.tcode, g.game_date,
  avg(gts.score) over w as ppg_before,
  avg(opp.score) over w as opp_ppg_before,
  avg(gts.tpm) over w as tpg_before,
  avg(gts.ast) over w as apg_before,
  avg(gts.reb) over w as rpg_before,
  avg(gts.stl) over w as spg_before,
  avg(gts.blk) over w as bpg_before,
  avg(gts.turnovers) over w as topg_before
from game_team_stats gts
join games g on g.gmkey = gts.gmkey
join game_team_stats opp on opp.gmkey = gts.gmkey and opp.tcode <> gts.tcode
where g.season_category = '정규시즌'
window w as (
  partition by gts.tcode, g.season_name
  order by g.game_date
  rows between unbounded preceding and 1 preceding  -- 이 경기 자신은 제외 = 리크프리
);

-- ---------------------------------------------------------------------------
-- 인증/구독 (24차 요금제 페이지가 나중에 실제 결제와 연결될 때를 위한 최소 골격 -
-- Stripe 등 실제 연동은 별도 작업)
--
-- 2026-08-27: 코트사이드를 별도 프로젝트 대신 기존 Supabase 프로젝트("who are u_kbl" -
-- Who Are Ya 선수맞추기 게임용, 이미 컴퓨트 비용을 내고 있어서 새 프로젝트 비용을 아끼려
-- 재사용하기로 함)에 얹기로 하면서, 그 프로젝트에 이미 실사용자 742명이 들어있는
-- "profiles" 테이블(다른 스키마 - nickname/favorite_team/saved_game 등 게임 전용 컬럼)이
-- 있는 걸 확인함 - 이름이 겹치면 그 테이블을 침범하게 되므로 courtside_ 접두어를 붙여
-- 완전히 분리된 테이블로 만듦(실사용자 데이터가 있는 기존 테이블은 절대 건드리지 않음).
-- ---------------------------------------------------------------------------

create table courtside_profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  display_name    text,
  favorite_tcode  text references teams(tcode),
  created_at      timestamptz not null default now()
);

create table courtside_subscriptions (
  id                      bigint generated always as identity primary key,
  user_id                 uuid not null references courtside_profiles(id) on delete cascade,
  tier                    text not null check (tier in ('pro','elite','enterprise')),
  status                  text not null check (status in ('active','canceled','past_due','trialing')),
  stripe_customer_id      text,
  stripe_subscription_id  text,
  current_period_end      timestamptz,
  created_at              timestamptz not null default now()
);
create index idx_courtside_subscriptions_user on courtside_subscriptions(user_id);

-- ---------------------------------------------------------------------------
-- RLS(Row Level Security) - Supabase auto REST API는 RLS를 켜야 안전하게 노출됨.
-- 경기 데이터류는 전부 공개 읽기(로그인 없이도 봐야 함), profiles/subscriptions는
-- 본인 것만.
-- ---------------------------------------------------------------------------

alter table teams enable row level security;
create policy "public read teams" on teams for select using (true);

alter table coaches enable row level security;
create policy "public read coaches" on coaches for select using (true);

alter table seasons enable row level security;
create policy "public read seasons" on seasons for select using (true);

alter table players enable row level security;
create policy "public read players" on players for select using (true);

alter table action_codes enable row level security;
create policy "public read action_codes" on action_codes for select using (true);

alter table games enable row level security;
create policy "public read games" on games for select using (true);

alter table game_team_stats enable row level security;
create policy "public read game_team_stats" on game_team_stats for select using (true);

alter table game_player_stats enable row level security;
create policy "public read game_player_stats" on game_player_stats for select using (true);

alter table shot_log enable row level security;
create policy "public read shot_log" on shot_log for select using (true);

alter table game_events enable row level security;
create policy "public read game_events" on game_events for select using (true);

alter table lineup_stints enable row level security;
create policy "public read lineup_stints" on lineup_stints for select using (true);

alter table courtside_profiles enable row level security;
create policy "users read own profile" on courtside_profiles for select using (auth.uid() = id);
create policy "users update own profile" on courtside_profiles for update using (auth.uid() = id);

alter table courtside_subscriptions enable row level security;
create policy "users read own subscription" on courtside_subscriptions for select using (auth.uid() = user_id);
-- courtside_subscriptions에 대한 insert/update는 클라이언트에서 직접 하지 않음(Stripe
-- 웹훅을 처리하는 Edge Function이 service_role 키로만 씀) - 그래서 write 정책은 의도적으로 없음.
