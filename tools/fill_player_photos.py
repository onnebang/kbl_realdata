# -*- coding: utf-8 -*-
"""players.photo_url 결측치를 raw_photos(kbl.or.kr에서 이미 내려받아 매직바이트로 검증된
사진 766장)로 채운다.

## 배경

SynergyCombos.tsx 주석(2026-09-04 실측)에 이미 "players.photo_url은 773명 중 31명(4.0%)뿐"
이라고 적혀 있었다 - 2026-09-17 재확인 결과 130/773(16.8%)로 그 사이 조금 늘었지만 여전히
643명이 비어있다. 제보("사진이 옛날 선수라 없는 것 같다")를 확인해보니 원인이 아니었다 -
비어있는 643명 중 515명은 raw_photos에 이미 사진이 있다(디드릭 로슨 291316, 이준희 291386
둘 다 확인됨). kbl.or.kr의 사진 URL은 pcode 하나당 고정 1개(players-photo/{pcode}.png)라
"예전 유니폼 사진"이 따로 있는 게 아니라, 이 URL 자체를 DB에 채우기만 하면 되는 문제였다.

## 원천

D:\\영상작업\\축구\\개발\\raw_photos\\{pcode}.png - crawl_player_photos.py가 kbl540 카드 풀의
photo_url을 pcode 기준 중복 제거해서 내려받고, 매직바이트로 진짜 이미지인지 검증까지 마친
파일들이다. 여기 존재한다는 것 자체가 "이 URL이 실제로 유효한 이미지를 서빙한다"는 증거라
직접 재검증할 필요가 없다.

## 규칙

- 이미 photo_url이 있는 130명은 절대 안 건드린다(NULL/빈 문자열인 행만 대상).
- raw_photos에 파일이 없는 pcode는 건드리지 않는다(URL을 지어내지 않는다).
- kbl540/kleague38 등 "Who Are Ya" 게임군이 이미 쓰는 것과 같은 고정 URL 패턴을 그대로
  재사용한다(파일을 courtside 쪽에 재호스팅하지 않고 kbl.or.kr을 직접 링크).

## 실행

    python tools/fill_player_photos.py            # 적용
    python tools/fill_player_photos.py --dry-run  # 몇 건이 채워질지만 확인
"""
import argparse
import os
import sys

import psycopg2
from import_roster import load_database_url
from cache_invalidate import revalidate

RAW_PHOTOS_DIR = r"D:\영상작업\축구\개발\raw_photos"
PHOTO_URL_TEMPLATE = "https://kbl.or.kr/files/kbl/players-photo/{pcode}.png"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    have_files = {f[:-4] for f in os.listdir(RAW_PHOTOS_DIR) if f.endswith(".png")}
    print(f"raw_photos 보유 pcode: {len(have_files)}개")

    conn = psycopg2.connect(load_database_url())
    cur = conn.cursor()

    cur.execute("select pcode, photo_url from players")
    rows = cur.fetchall()
    total = len(rows)
    already = sum(1 for _, url in rows if url)
    missing = [pcode for pcode, url in rows if not url]

    fillable = [pcode for pcode in missing if pcode in have_files]
    still_missing = len(missing) - len(fillable)

    print(f"전체 {total}명 / 이미 사진 있음 {already}명 / 비어있음 {len(missing)}명")
    print(f"raw_photos로 채울 수 있는 수: {len(fillable)}명 (채운 뒤에도 없는 수: {still_missing}명)")

    if args.dry_run:
        conn.close()
        return

    for pcode in fillable:
        cur.execute(
            "update players set photo_url = %s where pcode = %s and (photo_url is null or photo_url = '')",
            (PHOTO_URL_TEMPLATE.format(pcode=pcode), pcode),
        )
    conn.commit()
    revalidate(["batch:daily"] + [f"player:{p}" for p in fillable])

    cur.execute("select count(photo_url) from players")
    after = cur.fetchone()[0]
    conn.close()
    print(f"완료: photo_url 있는 선수 {already}명 -> {after}명")


if __name__ == "__main__":
    main()
