-- 라운드별 OVR 궤적 테이블(launch -> R1..R6 -> PO -> F). build_ovr_rounds.py --write-db 가 upsert 한다.
-- 이 파일은 사람이 검토한 뒤 Supabase SQL 에디터/마이그레이션으로 직접 실행한다(에이전트는 실행하지 않는다).
--
-- 공유 프로젝트(igbdbjhdpameorcgaame) 주의: "Who Are Ya" 게임 시리즈와 같은 Supabase 프로젝트다. 이 스크립트는
-- public.ovr_round 하나만 새로 만들고 다른 테이블/정책은 건드리지 않는다.
--
-- RLS: lockdown_anon.sql 의 코트사이드 자산과 같은 방침 - RLS를 켜고 **anon/authenticated 정책은 만들지 않는다**.
-- 사이트(courtside-web)는 SUPABASE_SERVICE_ROLE_KEY(RLS 우회)로 읽으므로 정책이 없어도 서버는 읽힌다. 공개 키로는
-- 한 행도 안 보인다. (schema_supabase.sql 의 초기 테이블들이 쓰던 "public read ... using (true)" 정책은 일부러 안 만든다.)

create table if not exists public.ovr_round (
  pcode        text        not null,
  season       text        not null,          -- '2026-2027' (courtside_ovr_history.json 의 season 과 같은 표기)
  stage        text        not null,          -- 'launch' | 'R1'..'R6' | 'PO' | 'F'
  ovr          real        not null,          -- 소수 1자리(궤적 값 V_t)
  off          real        null,              -- launch 공격력 + (V_t - launch OVR), 40~99로 클립
  def          real        null,              -- launch 수비력 + (V_t - launch OVR), 40~99로 클립
  delta        real        not null default 0,-- 이 단계에서 실제로 움직인 양(제자리/미출전이면 0). 재보정 단계는 점프 폭
  minutes      real        not null default 0,-- 그 단계 종료 시점 시즌 누적 출전분(분)
  recalibrated boolean     not null default false, -- 무데이터 선수의 1회성 재보정이 이 단계에서 일어났는지
  computed_at  timestamptz not null default now(),
  primary key (pcode, season, stage),
  constraint ovr_round_stage_chk check (stage in ('launch','R1','R2','R3','R4','R5','R6','PO','F'))
);

-- 시즌+단계로 한 번에 읽는 화면(라운드별 랭킹/변동 목록)용.
create index if not exists ovr_round_season_stage_idx on public.ovr_round (season, stage);

alter table public.ovr_round enable row level security;

-- 새 테이블은 Supabase 기본 권한(anon/authenticated SELECT)이 붙어 오지만 RLS 정책이 없으면 행이 안 나온다.
-- 그래도 권한 자체를 회수해 둔다(정책을 실수로 추가해도 공개되지 않게 이중 잠금).
revoke all on public.ovr_round from anon, authenticated;
