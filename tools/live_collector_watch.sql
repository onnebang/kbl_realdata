-- 라이브 수집기 감시 -> Discord 알림 (2026-09-14)
--
-- 왜: 수집기(live_collector.py)는 노트북 한 대에서 작업 스케줄러로 돈다(KBL_LiveCollector). 노트북이
-- 꺼지거나 잠들거나 로그아웃되면, 또는 KBL API가 진행 중 경기에서 예상과 다르게 응답하면 사이트 라이브가
-- 조용히 멈춘다. 감시를 노트북 밖(Supabase pg_cron, 1분마다)에 두면 노트북이 꺼져 있어도 알림이 온다.
--
-- 구조:
--   live_collector_status  수집기가 경기마다 매 폴링 뒤 남기는 심박(성공 시각, 이벤트 수, 마지막 오류).
--                          게임 테이블엔 갱신 시각 컬럼이 없어서 따로 둔다.
--   live_collector_problems(p)   지금 문제가 있는 경기(경기당 하나).
--     down    예정 시각 20분 전부터, 10분 넘게 성공한 폴링이 없음 = 수집기가 안 돌거나 계속 실패.
--             (수집기는 예정 30분 전부터 1분마다 폴링하므로 20분 전이면 이미 심박이 있어야 한다)
--     stalled 폴링은 되는데 25분 넘게 새 문자중계가 없음(시작 전이면 예정 시각부터 셈) = 지연·중단,
--             진행 중 API가 비어 옴, 또는 끝났는데 종료 판정이 안 됨. 하프타임 15분보다 넉넉하게.
--     감시 창은 예정 시각 + 6시간까지. 종료(is_ended)된 경기와 DRYRUN- 합성 경기는 보지 않는다.
--   live_alert_log         경기당 지금 걸린 알림 하나. 새 문제면 알림, 종류가 바뀌면 다시 알림,
--                          문제가 사라지면 해제 알림 후 삭제 - 같은 문제로 1분마다 울리지 않는다.
--   send_live_alert(msg)   Vault의 discord_live_alert_webhook으로 pg_net POST. 웹훅이 없으면 보내지 않음.
--
-- 웹훅 등록(사용자가 SQL 편집기에서 직접 - 토큰이라 저장소·로그에 남기지 않는다):
--   select vault.create_secret('<Discord 웹훅 URL>', 'discord_live_alert_webhook');
--   select public.send_live_alert('코트사이드 감시 알림 테스트');
--
-- 되돌리기: 파일 하단 롤백 블록.
begin;

create extension if not exists pg_net;

create table if not exists public.live_collector_status (
  gmkey         text primary key references public.games(gmkey) on delete cascade,
  last_ok_at    timestamptz,
  events        integer not null default 0,
  last_event_at timestamptz,
  last_error    text,
  last_error_at timestamptz
);
alter table public.live_collector_status enable row level security;
revoke all on public.live_collector_status from anon, authenticated;

create table if not exists public.live_alert_log (
  gmkey   text primary key references public.games(gmkey) on delete cascade,
  kind    text not null,
  sent_at timestamptz not null default now()
);
alter table public.live_alert_log enable row level security;
revoke all on public.live_alert_log from anon, authenticated;

create or replace function public.live_collector_problems(p_include_synthetic boolean default false)
returns table (gmkey text, kind text, home text, away text, tipoff timestamptz,
               last_ok_at timestamptz, last_event_at timestamptz, events integer, last_error text)
language sql stable as $$
  with live as (
    select g.gmkey, g.home_score,
           (g.game_date + g.game_start) at time zone 'Asia/Seoul' as tipoff,
           ht.name as home, awt.name as away,
           s.last_ok_at, s.last_event_at, coalesce(s.events, 0) as events, s.last_error
      from public.games g
      join public.teams ht  on ht.tcode  = g.home_tcode
      join public.teams awt on awt.tcode = g.away_tcode
      left join public.live_collector_status s on s.gmkey = g.gmkey
     where g.game_date between (now() at time zone 'Asia/Seoul')::date - 1
                           and (now() at time zone 'Asia/Seoul')::date
       and g.game_start is not null
       and not coalesce(g.is_ended, false)
       and (p_include_synthetic or g.gmkey not like 'DRYRUN-%')
  )
  select l.gmkey,
         case when coalesce(l.last_ok_at, '-infinity') < now() - interval '10 minutes' then 'down'
              else 'stalled' end,
         l.home, l.away, l.tipoff, l.last_ok_at, l.last_event_at, l.events, l.last_error
    from live l
   where now() >= l.tipoff - interval '20 minutes'
     and now() <  l.tipoff + interval '6 hours'
     and (coalesce(l.last_ok_at, '-infinity') < now() - interval '10 minutes'
          or coalesce(l.last_event_at, l.tipoff) < now() - interval '25 minutes')
$$;

create or replace function public.send_live_alert(p_msg text) returns boolean
language plpgsql as $$
declare v_url text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'discord_live_alert_webhook' limit 1;
  if v_url is null then
    raise notice 'discord_live_alert_webhook 없음 - 알림 생략: %', p_msg;
    return false;
  end if;
  perform net.http_post(url := v_url,
                        body := jsonb_build_object('content', left(p_msg, 1900)),
                        headers := '{"Content-Type": "application/json"}'::jsonb);
  return true;
end $$;

create or replace function public.check_live_collector(p_include_synthetic boolean default false)
returns table (gmkey text, kind text, action text)
language plpgsql as $$
declare
  r record;
  v_ago text;
  v_msg text;
begin
  for r in
    select p.*, a.kind as alerted_kind
      from public.live_collector_problems(p_include_synthetic) p
      left join public.live_alert_log a on a.gmkey = p.gmkey
     where a.kind is distinct from p.kind
  loop
    v_ago := case when r.last_ok_at is null then '없음'
                  else floor(extract(epoch from now() - r.last_ok_at) / 60)::int || '분 전' end;
    if r.kind = 'down' then
      v_msg := format(E'🔴 **수집기 응답 없음** - %s @ %s (%s 시작)\n마지막 정상 폴링: %s%s%s\n노트북 전원·로그인·네트워크와 raw\\live_collector.log 확인',
        r.away, r.home, to_char(r.tipoff at time zone 'Asia/Seoul', 'HH24:MI'), v_ago,
        case when r.last_error is not null then E'\n최근 오류: ' || left(r.last_error, 300) else '' end,
        case when r.events = 0 and now() >= r.tipoff + interval '2 hours'
             then E'\n(2시간 동안 문자중계가 없어 수집기가 연기·취소로 보고 폴링을 멈췄을 수 있음)' else '' end);
    else
      v_msg := format(E'🟠 **문자중계 멈춤** - %s @ %s (%s 시작)\n수집기는 돌고 있지만 %s분째 새 이벤트가 없음(지금까지 %s건). 경기 지연·중단, 진행 중 API 응답 이상, 또는 끝났는데 종료 판정이 안 된 경우',
        r.away, r.home, to_char(r.tipoff at time zone 'Asia/Seoul', 'HH24:MI'),
        floor(extract(epoch from now() - coalesce(r.last_event_at, r.tipoff)) / 60)::int, r.events);
    end if;
    perform public.send_live_alert(v_msg || E'\nhttps://courtside-web-ten.vercel.app/games/' || r.gmkey);
    insert into public.live_alert_log as a (gmkey, kind) values (r.gmkey, r.kind)
      on conflict on constraint live_alert_log_pkey do update set kind = excluded.kind, sent_at = now();
    gmkey := r.gmkey; kind := r.kind; action := 'alert'; return next;
  end loop;

  for r in
    select a.gmkey, a.kind, g.is_ended,
           (g.game_date + g.game_start) at time zone 'Asia/Seoul' as tipoff,
           ht.name as home, awt.name as away
      from public.live_alert_log a
      join public.games g   on g.gmkey = a.gmkey
      join public.teams ht  on ht.tcode  = g.home_tcode
      join public.teams awt on awt.tcode = g.away_tcode
     where not exists (select 1 from public.live_collector_problems(true) p where p.gmkey = a.gmkey)
  loop
    perform public.send_live_alert(format(E'🟢 **해제** - %s @ %s: %s', r.away, r.home,
      case when coalesce(r.is_ended, false) then '경기 종료 처리됨'
           when now() >= r.tipoff + interval '6 hours'
             then '감시 시간(예정 시각+6시간)이 지나 감시를 끝냄. 다음날 06:00 배치가 공식 기록을 채운다'
           else '정상 폴링 재개' end));
    delete from public.live_alert_log a where a.gmkey = r.gmkey;
    gmkey := r.gmkey; kind := r.kind; action := 'resolved'; return next;
  end loop;
end $$;

revoke execute on function public.live_collector_problems(boolean) from public, anon, authenticated;
revoke execute on function public.send_live_alert(text) from public, anon, authenticated;
revoke execute on function public.check_live_collector(boolean) from public, anon, authenticated;

select cron.schedule('watch_live_collector', '* * * * *', 'select public.check_live_collector()');

commit;

-- 롤백:
--   select cron.unschedule('watch_live_collector');
--   drop function if exists public.check_live_collector(boolean);
--   drop function if exists public.send_live_alert(text);
--   drop function if exists public.live_collector_problems(boolean);
--   drop table if exists public.live_alert_log;
--   drop table if exists public.live_collector_status;
--   (웹훅) delete from vault.secrets where name = 'discord_live_alert_webhook';
