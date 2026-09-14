-- shot_log 인덱스 정리 (2026-09-14, 프로덕션 적용됨 - concurrently라 트랜잭션 밖에서 한 줄씩)
--
-- 1) 중복 제거: idx_shotlog_game_player (gmkey, pcode, shot_order)는 유니크 제약
--    shot_log_gmkey_pcode_shot_order_key와 구성이 똑같았다(22MB씩). 제약 쪽은 migrate_to_supabase.py의
--    `on conflict (gmkey, pcode, shot_order)`가 쓰므로 남기고 일반 인덱스를 지운다. 플래너는 같은 조건에
--    유니크 인덱스를 그대로 쓴다(EXPLAIN 확인).
drop index concurrently if exists public.idx_shotlog_game_player;

-- 2) 선수 커리어 슛(playerDataScience/matchupInsights: pcode 조건 + games 조인). pcode로 시작하는 인덱스가
--    없어 games 4,477행을 돌며 (gmkey, pcode) 인덱스를 4,477번 찔렀다.
--    EXPLAIN ANALYZE, pcode 290790(3,477슛): 148.5ms -> 6.5ms (Index Scan idx_shot_log_pcode + Hash Join).
--    시즌 조건이 붙은 조회(shotImpactChart)는 games.season_name 인덱스로 먼저 좁혀 원래도 3ms라 그대로.
create index concurrently if not exists idx_shot_log_pcode on public.shot_log (pcode);

-- 3) 넣지 않은 것(측정 결론):
--    - shot_log(tcode): 팀 쪽 조회(teamDataScience)는 tcode + gmkey IN(...)이라 (gmkey, ...) 인덱스로 충분.
--    - games(home_coach_id/away_coach_id): games 4,477행 순차 스캔 0.97ms. 인덱스 이득이 없다.
--      (Supabase 어드바이저의 'unindexed foreign key' 경고는 남지만 무시해도 된다.)
