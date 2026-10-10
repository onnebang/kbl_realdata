-- 역대 기록 3단계 롤백 - record_streak_log를 지운다. 연속 보드 행은 따로: delete from record_entries where board in
-- ('pg.streak_gp.max','pg.xfg_made.max','pg.xfg_miss.max','pg.xtp_made.max','pg.xtp_miss.max','pg.xft_made.max','pg.xft_miss.max');
drop table if exists record_streak_log;
