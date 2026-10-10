# KBL 실시간 승률 예측 시스템 - 원본 데이터 수집

카드게임(kbl540 등)과는 별개 프로젝트. **실제 KBL 정규리그 경기**의 문자중계/박스스코어를 모아서
라인업 시너지·매치업 효과를 학습하는 AI 승률 예측 시스템을 만드는 게 목표. (2026-08-19 시작)

> 이 파일은 현재 상태·핵심 레퍼런스·운영 방법만 담은 요약본이다. 기능이 왜 지금 이런 구조인지,
> 날짜별/세션별("N차") 상세 작업 기록은 **`HISTORY.md`** 참고. 저장소 전체 구조·파이썬 인터프리터
> 함정 등은 **`CLAUDE.md`** 참고.

## 현재 상태 (2026-08-19 기준, 15시즌 수집 완료)

- **4,207경기** 수집 완료 (2011-12~2025-26, 15시즌, 정규시즌+플레이오프, 실패 0건). 원래 5시즌
  (2021-22~)만 있었는데 사용자 요청으로 10시즌 더 확장(2011-12~2020-21) - 처음엔 `--from-date`
  기본값을 안 바꿔서 최근 시즌 하나만 들어가는 실수가 있었고, 바로잡아 재수집함
- 라인업 스틴트 재구성 **4,155/4,207(98.8%) 득점 검증 통과**. 불일치 52건 중 상당수가 한 경기
  (`S27G01N106`)에 몰려있음 - 그 경기 문자중계에 선수 한 명(임재현)이 박스스코어 로스터와
  안 맞는 케이스, KBL 원본 데이터 자체의 이례적인 사례로 추정
- SQLite 적재 완료: `player_game_stats` 100,921건, `shot_log` 553,248건, `lineup_stints` 110,147건
- **경기 전 예측 - 여러 모델 하이퍼파라미터 튜닝 결과** (15시즌 전체, 2025-26 시즌 홀드아웃 기준):

  | 모델 | 정확도 | 로그손실 |
  |---|---|---|
  | **RandomForest** | **62.9%** | 0.670 |
  | LogisticRegression | 61.8% | **0.666** (최고 확률보정) |
  | XGBoost | 61.5% | 0.672 |
  | HistGradientBoosting | 60.8% | 0.675 |

  베이스레이트(55.4%) 대비 전부 유의미하게 개선. 5시즌(1,400행)일 때보다 데이터가 3배(4,182행)로
  늘고 시즌경계 기준 CV 폴드도 2개→12개로 늘면서 모델 간 격차가 좁혀짐(60.8~62.9%, 이전엔
  54.8~62.5%) - 특히 로지스틱회귀가 튜닝+데이터 확장으로 59.7%→61.8%까지 크게 개선됨.

  > 이후 휴식일수/구장/감독/심판/폼/용병집중도 피처를 더 추가해서 **RandomForest 64.3%**까지
  > 올라간 기록이 `HISTORY.md`에 있음(위 표보다 최신) - 위 표는 이 문서가 마지막으로 갱신된
  > 2026-08-19 시점 스냅샷이라 최신 숫자로 덮어쓰지 않고 남겨둠. 정확한 현재 최고 성능은
  > `HISTORY.md`에서 "하이퍼파라미터"로 검색하거나 `tools/compare_models.py`를 다시 돌려서 확인.

## kbl.or.kr 비공식 API

사이트가 SPA라 HTML엔 데이터 없음. 내부적으로 `api.kbl.or.kr`을 호출하는데 **인증/쿠키/토큰 전혀
불필요** - 아래 3개 정적 헤더만 있으면 curl로도 그대로 받아짐. robots.txt도 명시적 차단 없음
(koreabaseball.com과 다름 - 거긴 크롤링 금지, 여긴 아님).

```
Channel: WEB
TeamCode: XX
lang: ko
```

### 엔드포인트

| 엔드포인트 | 내용 |
|---|---|
| `GET /match/list?fromDate=YYYYMMDD&toDate=YYYYMMDD&tcodeList=all` | 기간별 경기 목록 (gmkey, 날짜, 홈/원정, 스코어, 시즌코드, 시즌카테고리) |
| `GET /match/year` | 시즌 연도 목록 (1997~2027 나열됨, 실제 데이터는 최소 2015시즌까지 확인됨) |
| `GET /match/{gmkey}` | 경기 메타 (팀, 감독/코치, 쿼터별 스코어, 심판, 구장, 관중수) |
| `GET /match/{gmkey}/player-stat` | 선수별 **경기단위** 박스스코어 - 1,2차 스탯 + 출전시간(분초) + 선발여부(startFlag) + PER/ORTG/DRTG 등 |
| `GET /match/{gmkey}/team-record` | 팀 단위 경기 기록 |
| `GET /match/{gmkey}/match-chart` | 슛차트 - 선수별 슛 시도 x/y좌표, 쿼터, 성공여부, 2점/3점 구분 |
| `GET /match/{gmkey}/text-cast` | **문자중계 이벤트 로그** - 시간(분:초), 선수명, 팀코드, 쿼터, 액션코드(`a`) - 라인업 재구성의 핵심 |

`gmkey` 형식: `S{시즌코드}G{게임코드}N{당일경기번호}` (예: `S47G14N1` = 47번째 시즌 14회차 첫 경기).
`seasonCategory`: R=정규시즌, PO=플레이오프, CU=컵대회, AS=올스타, OM=오픈매치데이(프리시즌),
D1/D2=D리그(2군), EA=동아시아 슈퍼리그. **현재 수집 대상은 R+PO만** (2군/이벤트성 경기 제외).

15연속 요청 테스트에서 차단/제한 없었음. 그래도 예의상 요청 사이 0.35초 딜레이 넣음
(`fetch_kbl_data.py`의 `DELAY_SEC`).

### 문자중계 액션 코드 매핑

`tools/kbl_action_codes.json` - 사이트 프론트엔드 JS 번들(`index-DRtx4Fny.js`)에서 원본 그대로
추출한 공식 매핑표 (`gameActionCodeList`/`gameFoulCodeList`/`gameChangeCodeList`/`quaterList`).
역추적 안 하고 소스에서 직접 가져온 거라 정확함 - 실제 경기(S47G14N1) 이벤트로 검증 완료
(교체 순서가 UI에 표시된 문자중계와 완전히 일치).

주요 코드: `101`=교체(IN), `102`=교체(OUT), `201`=2점슛성공, `205`=3점슛성공, `203`=자유투성공,
`209`/`210`=공격/수비리바운드, `211`=어시스트, `212`=스틸, `213`=블록, `214`=턴오버, `216`=파울.
전체 34개 코드는 JSON 파일 참고.

## 수집 스크립트

`tools/fetch_kbl_data.py` - stdlib만 사용(추가 설치 불필요, `.venv`에 `requests` 없음).

```bash
python fetch_kbl_data.py --seasons 43,45,47 --categories R,PO --limit 10   # 테스트
python fetch_kbl_data.py --seasons 39,41,43,45,47 --categories R,PO       # 정식 수집
```

시즌코드: 39=2021-22, 41=2022-23, 43=2023-24, 45=2024-25, 47=2025-26 (2026-08-19 기준 최근 5시즌).
경기당 5개 엔드포인트 저장, 이미 받은 파일은 건너뜀(재실행 안전). 실패 목록은
`raw/fetch_failures.json`에 기록.

## 저장 위치

```
raw/schedule/  - match/list 캐시 (날짜범위별)
raw/games/{gmkey}/meta.json, player-stat.json, team-record.json, match-chart.json, text-cast.json
```

## ⚠️ text-cast는 반드시 quarterList 파라미터 필요

`GET /match/{gmkey}/text-cast` 를 파라미터 없이 부르면 **서버가 마지막 쿼터 이벤트만** 돌려준다
(문자중계 탭의 기본/라이브 동작 - 진행중 경기에서 "현재" 보여주기 위한 서버 기본값으로 추정).
전체 경기를 받으려면 프론트 JS 번들에서 확인한 실제 파라미터로 명시 요청해야 함:

```
GET /match/{gmkey}/text-cast?quarterList=Q1,Q2,Q3,Q4,X1,X2,X3,X4
```

(X1~X4 = 연장 1~4쿼터. 연장 없는 경기엔 그냥 무시됨.) `fetch_kbl_data.py`는 이미 이렇게 고쳐놨음.
**2026-08-19 처음 수집했을 때 이 파라미터를 안 넣어서 문자중계가 전부 마지막 쿼터만 잘려 들어간
적 있음 - 스틴트 재구성 후 득점 합계가 실제 스코어와 안 맞아서 발견함.** 문자중계 관련해서 뭔가
이상하면 이 파라미터부터 의심할 것.

## 라인업 stint 재구성

`tools/build_lineup_stints.py` - 문자중계 이벤트를 순서대로 재생하면서 교체(101=IN/102=OUT)마다
스틴트를 끊고, 그 구간 각 팀 득점을 기록. 득점 코드는 `201`(2점) `205`(3점) `203`(자유투)
`207`(덩크 - 201과 별도 코드라 빠뜨리기 쉬움, 실제로 한 번 빠뜨렸다가 스코어 검증에서 걸림)
4개 다 합산해야 함. 같은 (쿼터,시각)에 동시에 여러 명 교체되는 경우(쿼터 시작/막판 대량교체)는
한 배치로 묶어서 처리 - 안 그러면 0점짜리 찰나의 스틴트가 우수수 생김.

검증: 스틴트별 득점 합계 == 실제 최종 스코어를 경기마다 자동 체크(`build_game_stints`의
`validation` 필드).

```bash
python build_lineup_stints.py --gmkey S39G01N1   # 경기 하나만
python build_lineup_stints.py                    # raw/games 전체 처리
```

출력: `raw/stints/{gmkey}.json` - 스틴트 배열(홈/원정 5인 pcode, 쿼터, 시작/끝 시각, 득점).

## 시너지 · 매치업 분석 엔진

`tools/build_synergy_matchup.py` - `raw/stints/*.json`을 스틴트 단위로 묶어서 계산:

- **온/오프코트 net rating**: 선수가 코트에 있을 때 팀 득실차를 40분 기준으로 환산
- **2~5인 조합 시너지**: N명이 동시에 코트에 있었던 스틴트만 모아 같은 방식으로 계산
  (`itertools.combinations` 기반이라 N 확장은 코드 변경 없이 루프만 늘리면 됨)
- **매치업**: 우리 선수 A가 상대 선수 B와 동시 출전했던 스틴트를 모아 그 구간 net rating 계산
  (실제 1대1 수비 배정이 아니라 co-occurrence 근사치 - 문자중계에 개별 수비 매칭 정보가 없음)

표본이 적은 조합(몇십 초)은 노이즈가 커서 `--min-onoff-sec`/`--min-combo-sec`로 최소 표본을
거른다(기본 300초/180초).

```bash
python build_synergy_matchup.py   # combo_2man~5man.json, player_onoff.json, matchups.json
```

## SQLite 적재

`tools/schema_kbl_realdata.sql` + `tools/load_sqlite.py` - `games`/`player_game_stats`/`shot_log`/
`lineup_stints` 4개 테이블로 정규화. 매번 전체 재생성(증분 upsert 없음 - 데이터 크기가 작아서
이게 더 간단하고 안전).

```bash
python load_sqlite.py   # raw/kbl_realdata.db 생성 (기존 파일 있으면 삭제 후 재생성)
```

프로덕션 서빙은 SQLite가 아니라 Supabase(Postgres)로 옮겨짐(`courtside-web` 참고) - 이 SQLite는
로컬 분석·모델 학습용.

## 경기 전(pre-game) 예측 피처 테이블

`tools/export_training_table.py` - 팀별 **직전 최대 10경기 이동평균**(offrtg/defrtg/netrtg/pace 등)으로
경기 전 시점 피처를 만든다. **데이터 누수 방지가 핵심**: 그 경기 당일/이후 스탯은 절대 포함 안 하고
무조건 그 경기 이전 날짜의 경기들만 사용. 직전 경기 3경기 미만(시즌 극초반)인 행은 제외.

```bash
python export_training_table.py   # raw/analysis/pregame_training_table.json
python test_pregame_features.py   # 폼/외국선수 판정 회귀 검사 (모델·DB 없이)
```

**외국선수 판정은 `player.playerFlag`(0=국내/1=외국/2=아시아쿼터)로 한다.** 예전엔
`player_bio.json`의 nationality를 봤는데 그건 kbl540 카드게임 프로젝트 스냅샷이라 새 시즌 영입을
모른다 - 2026-27 신규 외국선수·아시아쿼터 7명이 전원 bio에 없어서 조용히 '국내'로 세어졌고
`foreignPlayerCount`/`foreignConcentration`이 틀린 값으로 배포 모델에 들어갔다(2026-09-29 발견,
오픈매치 10경기 출전 127명 중 13명 누락). playerFlag는 공식 API가 경기별로 주는 값이라 신규
영입도 자동 포함된다 - 정답셋 대조 610경기 14,360행에서 모순 0건.

**폼 피처는 고정 윈도우(last1/3/5/10) + EWMA 동적 윈도우 두 종류.** EWMA는
`span = clamp(경기수, 3, 10)`, `alpha = 2/(span+1)`로 표본이 적은 시즌 초반엔 최근 경기에 민감하게,
표본이 쌓이면 10경기 평균 해상도로 수렴한다(`ewma_form()`). 테이블에는 항상 만들어두지만
`FEATURE_KEYS` 채택 여부는 `ablate_form_features.py`의 홀드아웃 숫자로만 판단한다 - 이 저장소엔
feature_importance는 높은데 홀드아웃 성능은 떨어져 탈락한 피처(나이곡선·로스터연속성) 전례가 있다.

> 프리시즌(OM) 경기도 이 테이블/롤링 윈도우에 들어온다(2026-09-24 카테고리 추가 이후). 개막 직후
> 예측이 지난 시즌 로스터만 보고 판단하는 걸 줄여주지만, 전시경기 결과가 netrtg 롤링에 섞이는
> 것이기도 하다. 모델 **재학습**에는 안 들어간다(`save_pregame_model.py`의 `CURRENT_SEASON_EXCLUDE=49`).

## 다음 단계 (요약)

전체 15시즌 수집, 시너지/매치업 피처 결합, 모델 비교·튜닝, 나이곡선/생존편향 검증은 모두 완료.
남은 항목:

1. 2~5인 조합 시너지/매치업은 아직 **사전(pre-game) 예측 피처로는** 결합 안 함 - "미래에 누가
   함께 뛸지" 미리 알아야 해서 사전 예측엔 못 쓰고, 라이브(경기 중) 모델에서나 의미 있음.
   **단 외국선수 2인 조합은 예외다**(2026-09-29 정리): 2026-27부터 2·3쿼터에 외국선수 2명 동시
   출전이 허용되고 팀마다 외국선수가 사실상 2명이라, "누가 함께 뛸지"를 경기 전에 알 수 있다 -
   즉 `foreign_duo_net_rtg`는 누수 없이 사전 피처로 만들 수 있는 유일한 조합 시너지다.
   아직 안 만든 이유는 표본뿐이다. 실측(2026-09-29): 프리시즌 10경기에서 2인 동시 출전은
   팀당 32~70분(≈65~140포제션)으로 100포제션당 값의 표준오차가 ±20 이상이고, 게다가 프리시즌은
   그 규정을 따르지 않아 3인 동시 출전이 144분 잡힌다(`om_stats_report.md` 참고). **정규시즌
   10~15경기가 쌓인 뒤** 착수할 것 - 그때도 최소 포제션 제약 + 베이지안 스무딩이 같이 필요하다.
2. 기존 kbl540 시즌평균 데이터(3,137 rows)를 신규 이벤트 기반 데이터의 사전확률(prior)로 결합
   검토 (베이지안 shrinkage - 표본 적은 선수/조합의 노이즈를 시즌평균으로 완화) - 미착수
3. 신규 용병 OVR의 콜드스타트(`build_courtside_ovr.py`의 `SCOUTED_ROOKIE_PROFILES`)를 프리시즌
   실측으로 대체 - **미착수, 착수 전에 알아둘 것 두 가지**(2026-09-29 조사):
   - 그 하드코딩 OVR은 **승률 예측 모델에 도달하지 않는다.** `team_pwr_feature()`는 누수 방지로
     `prev_season_name`의 OVR만 읽으므로 2026-27 경기엔 2025-2026 행만 쓰인다. 신규 용병은
     `None`으로 빠진다. 즉 이 표를 고치는 건 **웹 선수카드 표시** 개선이고 승률 예측과는 별개다.
   - 프리시즌 표본은 **선수당 최대 2경기**다(오픈매치 10경기 전부, 컵대회는 이 시스템에 0경기 -
     수집기 카테고리엔 `CU`가 있지만 실제로 들어온 게 없다). 2경기로 만든 prior는 해외 리그
     스카우팅보다 노이즈가 크다. 정규시즌 5~10경기 뒤에 착수할 것.

라이브(경기 중) 승률 예측, WPA, courtside-web UI 확장은 전부 완료 상태. 각 기능이 어떻게
만들어졌는지 상세 과정은 `HISTORY.md`의 해당 "N차" 세션 기록 참고.

## 운영 런북

### 경기 당일 운용 (CLI)

> **실행 환경 주의** - 라이브 관련 스크립트는 **Python 3.11**로 돌려야 한다(sklearn 1.9/numpy
> 2.x 모델 파일 때문). 자세한 배경은 `CLAUDE.md`의 "파이썬 인터프리터 함정" 참고.

```bash
cd tools

# 켜두면 끝 - 오늘(KST) 열리는 예정/진행중 경기를 전부 60초 간격으로 따라가고,
# 경기가 끝나면 정산 배치까지 자동으로 돌린 뒤 스스로 종료한다.
python live_collector.py

python live_collector.py --interval 30       # 폴링 간격
python live_collector.py --gmkey S49G01N1    # 특정 경기만 강제(이미 끝난 경기는 거부)
python live_collector.py --once              # 1주기만 실행하고 종료
python live_collector.py --max-runtime 21600 --stall-timeout 5400
                                             # 무인 운용 안전장치(기본 12시간 / 2시간)
```

**무인 실행 - 작업 스케줄러 태스크 등록돼 있음:**

| 태스크 | 실행 주기 | 하는 일 |
|---|---|---|
| `KBL_LiveCollector` | 매일 13:00부터 12시간, 10분마다 | 그날 예정/진행중 경기를 실시간 추적·정산까지 자동 처리 |
| `KBL_DailyBatch` | 매일 06:00 | 전날 놓친/실패한 경기를 정본으로 재수집·재계산(라이브가 못 돌았을 때의 복구 경로) |
| `KBL_LineupRecalc` | 매일 13:00부터 8분마다 | 라인업 승률 재계산(`recalc_lineup_winprob.py --today`) |
| `KBL_WeeklyTrain` | 매주 월요일 06:20 (2026-10-06 등록) | `weekly_retrain.py` - SQLite 재적재 → 신선도 확인 → OVR 재계산 → OVR 가드 → 학습테이블 재생성 → 경기전 승률모델 재학습(승격 게이트) → 올타임 리더스·통산 스냅샷(`career_marks.json`) 재계산 → 깨끗한 임시 worktree에서 git commit+push. 로그: `raw/weekly_retrain.log` |

**`live_collector.py`를 고치면 재시작해야 반영된다** - 경기일 13:00 무렵 뜬 프로세스 하나가 마지막 경기 정산까지 계속 도는 상주형이고(10분 트리거는
`IgnoreNew`라 무시됨, 결과코드 `0x800710E0`) 파이썬은 코드를 다시 읽지 않으므로, 그 사이에 커밋한 수정은 다음 기동까지 옛 코드로 돈다(2026-10-08 정산 훅 사례).
킥오프 30분 전(폴링 시작) 이전의 대기 중에 재시작하고(감시 함수 `live_collector_problems()`는 킥오프 20분 전부터만 본다), `Stop-ScheduledTask`만으로는
`cmd → python` 프로세스가 남으므로 `taskkill /PID <cmd.exe PID> /T /F`로 트리째 끈 뒤 `Start-ScheduledTask -TaskName KBL_LiveCollector`(또는 다음 :x0 트리거).
로그에 `승률 모델 로딩... / 대상 N경기`가 찍히면 정상. `daily_batch.py`는 매일 새 프로세스라 다음 실행부터 자동 반영.

```powershell
Get-ScheduledTaskInfo -TaskName "KBL_LiveCollector"   # 다음/마지막 실행, 결과코드
Get-ScheduledTaskInfo -TaskName "KBL_DailyBatch"
Get-ScheduledTaskInfo -TaskName "KBL_WeeklyTrain"
Disable-ScheduledTask  -TaskName "KBL_LiveCollector"  # 끄기
```

**`KBL_WeeklyTrain` 참고** - 절전 해제(WakeToRun)는 2026-10-10에 켰다(나머지 KBL_* 태스크와 같게). 전원 구성표의 "절전 모드 해제 타이머 허용"은 AC만 켜져 있어
충전기를 꽂아 둔 상태에서만 깨운다. 아직 `StartWhenAvailable`(놓친 실행 만회)은 꺼져 있어 PC가 꺼져 있던 월요일은 그 주를 건너뛴다.
OVR·경기전 모델은 전부 로컬 SQLite(`raw/kbl_realdata.db`, git에 안 올라감)만
읽는다. 이 태스크가 매주 `raw/games`의 최신 경기를 SQLite에 다시 적재해야 OVR/모델이 갱신된다 - PC가
꺼져 있으면 그 주는 건너뛰고 다음 주에 누적 반영됨. `tools/save_pregame_model.py`는 2026-27 시즌(새
Q2/Q3 용병 2인 규정 첫 시즌) 학습테이블 표본이 `SAMPLE_THRESHOLD`(150행, 사용자 지정 2026-10-06)
미달이면 그 시즌 경기를 재학습에서 빼고, 넘으면 자동으로 포함한다 - 기준을 넘는 주부터 사람 개입
없이 전환됨(로그에 포함/제외 여부가 매주 찍힘).

**`KBL_WeeklyTrain` 안전장치** (2026-10-07, 개막 직후 전원 OVR 폭락 사고 대응 - 에러 없이 끝난 틀린 결과가 검증 없이
나간 것) - 걸리면 커밋·푸시 없이 중단하고 로그에 `[GUARD-FAIL]`/`[FAIL]`/`[ABORT]`가 남으며 작업 결과코드가 1이다
(`Get-ScheduledTaskInfo -TaskName KBL_WeeklyTrain`의 LastTaskResult):

- 시작 시 산출물 4개에 미커밋 변경이 있으면 중단(사람 작업 위에 덮어쓰지 않음).
- 로컬 SQLite 종료 경기 수가 Supabase보다 적으면 중단(수집 누락 - 낡은 데이터로 발행 안 함).
- `ovr_guard.py`가 HEAD 대비 이상을 잡으면 OVR 산출물을 되돌리고 중단: 확정 시즌 행 값 변경, 행 소실, 올 시즌 행의
  과도한 이동/한쪽 쏠림. 시즌 확정 전환(정규시즌 종료 후 예상치 행이 실측으로 바뀜, 1년에 한 번)은 값을 직접 확인하고
  `OVR_GUARD_ALLOW_SETTLE=1`로 다시 돌려야 통과한다. 단독 실행: `python ovr_guard.py` (HEAD vs 작업트리), `--selftest`.
- `save_pregame_model.py`가 새 모델의 최근 경기 예측이 배포 모델과 크게 다르면(평균 0.05 / 상위5% 0.15) 덮어쓰지
  않고 중단. 피처/하이퍼파라미터를 일부러 바꾼 재학습은 `--force`.
- 첫 실행 전/설정 변경 후 점검: `python weekly_retrain.py --dry-run` (전 단계+가드까지 돌리고 커밋·푸시 없이 산출물을
  HEAD로 되돌림. 산출물에 미커밋 변경이 없어야 시작됨).
- `career_marks.json`(선수별 통산 합계·한 경기 최고기록 스냅샷, `build_alltime_leaders.py`가 같이 굽는다)은 웹의 라이브 경기 "기록 워치"
  (경기 후 리포트 "기록 달성"·경기 전 "기록 도전"도 같은 재료, `courtside-web/lib/careerMarks.ts`)가 읽는다. 웹이 스냅샷 이후에 끝난 경기를 Supabase에서 더해 쓰므로 주 1회 갱신으로 충분하고,
  이 주간 잡이 못 도는 주엔 스냅샷이 낡을 뿐 틀리진 않는다(보정할 경기가 늘어난다 - 기준일과 60일 넘게 벌어진 경기는 기능이 꺼진다).
- 시즌 초반 상태 재현 검증: `python replay_ovr_season_start.py --season 2025-2026` - 과거 시즌을 N경기까지만 잘라
  OVR 생성기를 돌려 진행 중 시즌 처리(백분위 풀 격리 + 진행률별 변동 상한)를 확인한다. OVR 생성 로직을 고친 뒤 돌릴 것.

**역대 기록(Record Book)** (2026-10-08, 설계 `docs/superpowers/specs/2026-10-08-record-book-design.md`) - KBL 역대 TOP10(팀·선수의
쿼터/경기/연장별 최다·최소)를 Supabase `record_entries`에 보관해 라이브 "🏆 역대 기록"과 경기 후 리포트 "역대 기록"이 읽는다.

- 경기가 끝나면 `live_collector.reconcile_finished_game`이 이벤트 이관 뒤 `record_book.py --gmkeys <gmkey>`를 부른다(실패해도 정산 결과는 그대로,
  로그 `raw/live_collector.log`에 `record_book.py -> exit N`). 놓친 경기는 매일 06:00 `daily_batch.py`가 같은 호출로 복구한다(멱등).
- 수동: `python record_book.py --gmkeys S49G01N9` (한 경기 반영) / `--rebuild --dry-run` (DB 없이 전체 계산·요약) / `--rebuild` (테이블 교체 - 기록 정의나
  검증 게이트를 고친 뒤) / `--verify` (raw에서 다시 계산한 것과 테이블 비교, 다르면 종료코드 1 - 월 1회 점검).
- 기록 정의를 고치면 `tools/test_record_book.py`(`RECORD_BOOK_SLOW=1`이면 실데이터 단언)와 웹 `lib/records.parity.test.ts`가 둘 다 통과해야 한다
  (파이썬과 웹이 같은 정의를 쓰는지 실제 경기 10개로 고정). 픽스처 재생성: `python dump_record_fixtures.py --parity <폴더> --gmkeys ...`.
- 테이블 적용/롤백: `schema_record_book.sql` / `rollback_record_book.sql`. RLS 켬 + 정책 없음 + anon 권한 회수라 익명은 못 읽는다(서버만).
- 이벤트는 옛 경기(2006~09)에서 공식 기록과 어긋난다(김승현 2007-03-23 공식 11어시스트, 이벤트 15개) - 이벤트 기반 보드는 공식 쿼터 점수·박스 합계와 대조를
  통과한 경기만 쓴다. 이 검증 때문에 "기록을 놓칠 수는 있어도 틀린 기록은 안 만든다".

**감시**: Supabase pg_cron(`watch_live_collector`, 1분마다)이 수집기 심박(`live_collector_status`)을
보고 있다가 멈추면 Discord로 알림(🔴 응답 없음 / 🟠 문자중계 멈춤 / 🟢 해제). 지금 걸린 문제 보기:
`select * from live_collector_problems();` (Supabase SQL 편집기).

**이 노트북이 지켜야 하는 조건** - 수집기는 이 PC 한 대에서만 돈다. 경기 시간에 PC가 꺼져있거나,
잠들어 있거나, 로그아웃돼 있으면 라이브가 멈추고 다음날 06:00 배치가 정본만 채운다(전원 연결 시
절전 "안 함", 덮개 닫기 동작 "아무 것도 안 함"으로 설정돼 있어야 함).

### 종료 오판 복구 (운용자용 탈출구)

경기 중간에 사이트가 진행 중인데 우리 쪽에서 `종료`로 굳어서 수집기가 그 경기를 더는 안 보면:

```bash
# 1) DB에서 종료 표시를 되돌린다(is_ended는 코드에선 절대 false로 못 감 - 수동 SQL만 가능)
#    Supabase SQL Editor:  update games set is_ended=false where gmkey='S49G01N7';
# 2) 확정 카운터 초기화 - 안 지우면 다음 폴링에서 곧바로 다시 종료로 확정된다
rm raw/live_state/S49G01N7.json
# 3) 수집 재개(그 경기만)
python live_collector.py --gmkey S49G01N7
# 4) 경기가 진짜로 끝난 뒤 정본으로 덮어쓰기
python daily_batch.py --only-supabase-sync --gmkeys S49G01N7
```

반대로 **이미 정산까지 끝난 경기를 라이브로 다시 적재하는 것은 기본적으로 거부**한다
(`--gmkey`가 `is_ended=true` 경기를 가리키면 exit 2). 공식 `game_events`를 라이브 잠정치로
덮어쓰기 때문 - 정말 필요하면 `--force-ended`를 명시해야 한다.
