-- 역대 기록(Record Book) 롤백 - schema_record_book.sql로 만든 것을 되돌린다. 다른 테이블·앱에는 영향이 없다.
-- 함께 할 일: 정산 훅 제거(live_collector.run_record_book 호출, daily_batch의 record_book.py 단계), 웹의 records 연결은 테이블이 없으면 알아서 사라진다.
drop table if exists record_entries;
