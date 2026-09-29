"""
game_player_stats.oreb/dreb 백필 - 문자중계 이벤트(209 공격리바운드 / 210 수비리바운드)로
선수별 공/수 리바운드를 분해해서 채운다.

## 왜 필요했나
KBL 원본 박스스코어는 선수 단위로 `reb`(합계)만 주고 공/수 분리를 안 준다. 그래서 이 두 컬럼은
컬럼만 있고 15시즌 101,281행 전부 NULL이었고("리바운드 종류 분리는 추후 이벤트 기반 작업으로
보류"), 웹앱은 lib/playerGlance.ts에서 "이 DB는 공/수 리바운드를 분해할 수 없다"고 안내해 왔다.
그런데 game_events에는 209/210이 pcode까지 달려서 들어있다 - 팀 단위로 대조해 보면 공식
박스스코어의 offr/defr와 **최근 4시즌 1,136 팀-경기 전수 100% 일치**한다(2026-09-29 확인).

## 어디까지 채우나 - "검증되는 행만"
선수-경기별로 (209 개수 + 210 개수)가 기존 `reb`와 **정확히 같을 때만** 쓴다. 실측 대조 결과:

  전체 101,281행 중 100,587행(99.315%) 일치 -> 채움
  나머지 694행은 NULL로 남김. 두 가지 원인이 섞여 있다:
    · 리바운드 이벤트가 아예 없는 경기(~462행, S19/S39/S41/S43/S47에 몰려 있음) - 중계 데이터 결측
    · 구시즌(S21~S29) 중계 노이즈(~230행, 경기당 1~2건 흩어짐, 합계 편차는 ±0 근처)

합계가 안 맞는 행에 억지로 값을 넣으면 `reb`와 `oreb+dreb`가 어긋난 행이 생겨서, 나중에 둘 중
어느 쪽을 믿어야 하는지 알 수 없게 된다. 못 채운 행은 NULL로 두고 읽는 쪽에서 제외하는 게 맞다
(lib/playerGlance.ts의 seasonRebSplit()이 null인 경기를 분자·분모 양쪽에서 빼는 식으로 처리한다).

`reb = 0`인 행은 이벤트가 없어도 0/0이 자명하게 맞으므로 같은 조건식에 자연히 포함된다
(0 + 0 = 0 = reb).

## 실행
    # 기본은 dry-run - 몇 행이 바뀌는지만 세고 아무것도 안 쓴다
    D:\\영상작업\\축구\\개발\\.venv\\Scripts\\python.exe tools/backfill_player_rebound_split.py
    # 실제 기록
    ... backfill_player_rebound_split.py --apply

일회성 백필이지만 지우지 않고 남긴다 - 중계 결측이 나중에 메워지거나 새 시즌이 쌓이면 다시
돌리면 된다(이미 채워진 행은 같은 값으로 덮어쓰므로 여러 번 돌려도 안전하다 - 멱등).
"""
import argparse
import io
import os
import sys

import psycopg2

HERE = os.path.dirname(os.path.abspath(__file__))


def load_database_url():
    """tools/.env.supabase의 DATABASE_URL(직결, RLS 우회) - import_roster.py와 동일한 규약."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    path = os.path.join(HERE, ".env.supabase")
    if os.path.exists(path):
        for line in io.open(path, encoding="utf-8"):
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL을 찾을 수 없다(tools/.env.supabase 확인).")


# 선수별 209/210 집계. pcode가 없는 팀 리바운드(218)는 애초에 선수 기록이 아니라 빠진다.
EVENT_SPLIT = """
  select gmkey, pcode,
         count(*) filter (where action_code = '209')::int as o,
         count(*) filter (where action_code = '210')::int as d
  from game_events
  where action_code in ('209', '210') and pcode is not null
  group by 1, 2
"""

# 이벤트 합계가 reb와 일치하는 행만. left join이라 이벤트가 하나도 없는 선수는 0/0으로 내려오고,
# 그 경우 reb = 0인 행만 조건을 통과한다.
VERIFIED_ROWS = f"""
  with ev as ({EVENT_SPLIT})
  select s.gmkey, s.pcode, coalesce(ev.o, 0) as o, coalesce(ev.d, 0) as d
  from game_player_stats s
  left join ev on ev.gmkey = s.gmkey and ev.pcode = s.pcode
  where coalesce(ev.o, 0) + coalesce(ev.d, 0) = s.reb
"""

COUNT_SQL = f"""
select (select count(*) from game_player_stats)                      as total,
       (select count(*) from ({VERIFIED_ROWS}) v)                    as verified,
       (select count(*) from game_player_stats where oreb is not null) as already_filled
"""

UPDATE_SQL = f"""
update game_player_stats s
set oreb = v.o, dreb = v.d
from ({VERIFIED_ROWS}) v
where v.gmkey = s.gmkey and v.pcode = s.pcode
  and (s.oreb is distinct from v.o or s.dreb is distinct from v.d)
"""

# 백필 후 정합성 확인 - 채운 행에서 oreb+dreb != reb가 하나라도 있으면 위 조건식이 깨진 것이다.
VERIFY_SQL = """
select count(*) filter (where oreb is not null)                          as filled,
       count(*) filter (where oreb is null)                              as left_null,
       count(*) filter (where oreb is not null and oreb + dreb <> reb)   as inconsistent,
       sum(oreb) filter (where oreb is not null)                         as total_oreb,
       sum(dreb) filter (where oreb is not null)                         as total_dreb
from game_player_stats
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true", help="실제로 UPDATE를 커밋한다(기본은 dry-run)")
    args = ap.parse_args()

    conn = psycopg2.connect(load_database_url())
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute(COUNT_SQL)
            total, verified, already = cur.fetchone()
            print(f"[대상] game_player_stats {total:,}행")
            print(f"[검증 통과] {verified:,}행 ({verified / total * 100:.3f}%) - oreb+dreb == reb")
            print(f"[검증 실패] {total - verified:,}행 - NULL로 남긴다")
            print(f"[이미 채워짐] {already:,}행")

            if not args.apply:
                print("\ndry-run이라 아무것도 쓰지 않았다. 실제로 기록하려면 --apply를 붙일 것.")
                conn.rollback()
                return

            cur.execute(UPDATE_SQL)
            changed = cur.rowcount
            cur.execute(VERIFY_SQL)
            filled, left_null, inconsistent, t_oreb, t_dreb = cur.fetchone()
            print(f"\n[UPDATE] {changed:,}행 기록")
            print(f"[결과] 채워짐 {filled:,} / NULL {left_null:,} / 불일치 {inconsistent:,}")
            print(f"[합계] OREB {t_oreb:,} · DREB {t_dreb:,}")

            if inconsistent:
                conn.rollback()
                sys.exit(f"중단: oreb+dreb != reb인 행이 {inconsistent:,}개 생겼다 - 롤백했다.")
        conn.commit()
        print("[커밋 완료]")

        # 선수 페이지는 태그 캐시라, DB만 고치고 끝내면 최대 24시간 동안 옛 화면이 그대로 나간다
        # (revalidateTag 도입 배경과 같은 함정). 선수가 수천 명이라 player:<pcode> 태그를 일일이
        # 부르는 대신 일괄 태그 하나로 턴다 - 어차피 전 시즌 전 선수가 바뀌는 작업이다.
        from cache_invalidate import revalidate

        revalidate(["batch:daily"])
    finally:
        conn.close()


if __name__ == "__main__":
    main()
