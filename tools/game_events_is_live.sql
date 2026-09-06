-- game_events 공개 읽기 정책을 **인덱스로 끝나게** 만든다. (2026-09-06)
--
-- 문제(감사 실측): narrow_game_events_policy.sql이 만든 정책이
--     using (exists (select 1 from games g where g.gmkey = game_events.gmkey and coalesce(g.is_ended,false)=false))
-- 인데, anon이 필터 없이 `GET /rest/v1/game_events?select=event_order&limit=1`을 부르면 이 EXISTS를
-- **242만 행 전부에 대해** 평가해야 해서 710MB 순차 스캔이 돈다. 실측 3회 3.28/3.27/3.35초 →
-- anon statement_timeout(3초)에 걸려 500이 난다. 즉 **아무 데이터도 안 주면서 3초를 태운다.**
-- 인증이 필요 없으므로 그대로 두면 연결 60개짜리 인스턴스를 누구나 고갈시킬 수 있다
-- (가입하면 authenticated 타임아웃 8초라 2.7배 세진다).
--
-- 해법: "이 행이 진행 중 경기인가"를 game_events 자신의 컬럼으로 비정규화하고 부분 인덱스를 건다.
-- 그러면 정책이 `using (is_live)`가 되어 무필터 조회도 부분 인덱스만 훑고 끝난다(현재 0행).
--
-- 비용: PG11+에서 non-volatile default의 컬럼 추가는 메타데이터만 바꾸므로 테이블 재작성이 없다.
-- 백필도 0행이다(예정 경기는 이벤트가 아직 없고, 나머지는 전부 종료).
--
-- 유지: 트리거 둘. 삽입 시 그 경기가 안 끝났으면 true, games.is_ended가 true로 바뀌면 그 경기
-- 이벤트를 false로(경기당 600행 안팎이라 싸다). 수집기(live_collector.py)는 손대지 않아도 된다.
--
-- 되돌리기: 파일 하단 롤백 블록.
begin;

alter table public.game_events add column if not exists is_live boolean not null default false;

-- 백필: 아직 안 끝난 경기의 이벤트만 true.
update public.game_events e set is_live = true
  from public.games g
 where g.gmkey = e.gmkey and coalesce(g.is_ended, false) = false and e.is_live = false;

create index if not exists idx_events_is_live on public.game_events (gmkey) where is_live;

-- 삽입 시 자동 판정. 수집기는 is_live를 몰라도 된다.
create or replace function public.game_events_set_is_live() returns trigger
language plpgsql as $$
begin
  new.is_live := exists (
    select 1 from public.games g
     where g.gmkey = new.gmkey and coalesce(g.is_ended, false) = false
  );
  return new;
end $$;

drop trigger if exists trg_game_events_set_is_live on public.game_events;
create trigger trg_game_events_set_is_live
  before insert on public.game_events
  for each row execute function public.game_events_set_is_live();

-- 경기가 끝나면 그 경기 이벤트를 한 번에 내린다.
create or replace function public.games_clear_is_live() returns trigger
language plpgsql as $$
begin
  if coalesce(new.is_ended, false) and not coalesce(old.is_ended, false) then
    update public.game_events set is_live = false where gmkey = new.gmkey and is_live;
  elsif not coalesce(new.is_ended, false) and coalesce(old.is_ended, false) then
    update public.game_events set is_live = true where gmkey = new.gmkey and not is_live;
  end if;
  return null;
end $$;

drop trigger if exists trg_games_clear_is_live on public.games;
create trigger trg_games_clear_is_live
  after update of is_ended on public.games
  for each row execute function public.games_clear_is_live();

-- 정책 교체: EXISTS -> 인덱스 한 방
drop policy if exists "public read live game_events" on public.game_events;
create policy "public read live game_events" on public.game_events
  for select to anon, authenticated
  using (is_live);

commit;

-- 검증
--   explain analyze select event_order from game_events limit 1;   -- anon 롤로: Index Scan, 1ms 미만
--   트랜잭션 안에서 games.is_ended=false로 바꾸면 그 경기 이벤트가 anon에 보여야 한다(롤백).
--
-- 롤백:
--   drop trigger if exists trg_games_clear_is_live on public.games;
--   drop trigger if exists trg_game_events_set_is_live on public.game_events;
--   drop policy "public read live game_events" on public.game_events;
--   create policy "public read live game_events" on public.game_events for select to anon, authenticated
--     using (exists (select 1 from public.games g where g.gmkey = game_events.gmkey and coalesce(g.is_ended,false)=false));
