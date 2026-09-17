# KBL 실시간 승률 예측 시스템 — kbl_realdata

**이 폴더(`kbl_realdata`)는 상위 폴더(`D:\영상작업\축구\개발`)의 CLAUDE.md("Who Are Ya" 선수
맞추기 게임 시리즈 — kbl540, kbo144 등)와는 무관한 별개 프로젝트다.** 상위 CLAUDE.md의 내용은
이 저장소 작업에 적용되지 않는다.

## 무엇을 하는 프로젝트인가

KBL(한국프로농구) 정규리그 문자중계/박스스코어를 수집해 라인업 시너지·매치업 효과를 학습시키고,
경기 전(pre-game)·라이브 승률을 예측하는 시스템. 진행 현황·데이터 규모·모델 성능 등 자세한 내용은
`README.md`, 과거 세션별 작업 기록은 `HISTORY.md` 참고.

## 폴더 지도

| 경로 | 설명 |
|---|---|
| `courtside-web/` | **실제 배포되는 Next.js 웹앱**(Vercel, 활발히 개발 중). 자체 `CLAUDE.md`/`DEPLOY.md` 참고. |
| `tools/` | 데이터 수집·적재·학습 파이썬 파이프라인(스크립트 90여 개, 평면 구조). Windows 작업 스케줄러 태스크 2개가 무인 운용: `KBL_LiveCollector`(경기일 13:00~, 10분마다, 라이브 수집)와 `KBL_DailyBatch`(매일 06:00, 전날 복구 경로). 상세 명령어·감시·복구 절차는 `README.md`의 "운영 런북" 참고. |
| `raw/` | 로컬 SQLite(`kbl_realdata.db`) + 수집 원본/로그. `.gitignore` 대상, 800MB+. |
| `web/` | 구버전 정적 HTML 템플릿. `courtside-web`와는 별개로 `tools/build_courtside_page.py` 등 일부 스크립트가 여전히 참조 중(정적 리포트 `reports/daily_report.html` 생성 경로). `courtside-web`와 혼동 주의. |
| `.agents/skills/`, `.claude/skills/` | 후자는 전자로의 심볼릭 링크(`npx skills add`로 설치된 supabase 스킬 2종). 정상 상태, 손댈 필요 없음. |

> `app/`(React Native)·`backend/`(Cloudflare Workers)는 2026-08-25 최초 커밋 이후 손댄 이력 없는
> 죽은 스캐폴딩이어서 2026-09-16 삭제함(git 히스토리에는 남아있음).

## ⚠️ 파이썬 인터프리터 함정 (반드시 읽을 것)

이 머신엔 서로 호환되지 않는 파이썬이 여러 개 있다:

- Anaconda `C:\Users\mwon0\anaconda3\python.exe` — 3.8.8 / sklearn 1.3.2 / numpy 1.24
- 실제 운용 venv `D:\영상작업\축구\개발\.venv\Scripts\python.exe` — 3.11.1 / sklearn 1.9.0 /
  numpy 2.4 (**저장소 밖, 상위 폴더에 위치** — 다른 프로젝트와 공유)

`raw/analysis/live_winprob_model.joblib`은 sklearn1.9/numpy2.x로 피클된 모델이라 Anaconda
쪽에서 로드하면 임포트는 통과하고 언피클 시점에 조용히 죽는다
(`ModuleNotFoundError: No module named 'numpy._core'`). `daily_batch.py`/`live_collector.py`가
서브프로세스를 띄울 때는 `tools/python_runtime.py`가 후보 인터프리터를 실제로 프로브해서
자동 해석하지만, **사람이 직접 스크립트를 돌릴 땐 반드시 저 venv를 쓰거나 `KBL_PYTHON`
환경변수로 경로를 지정할 것.** 잘못된 인터프리터로 돌리면 에러 없이 "완료"로 끝나면서 이벤트
이관이 조용히 실패하고 데이터가 잠정 상태로 고착될 수 있다.

의존 패키지 목록은 `tools/requirements.txt` 참고(참고/재현용 — venv는 저장소 밖에 있어 강제되지
않음, 새 환경 세팅 시 기준으로 사용).

## Supabase

- URL: `https://igbdbjhdpameorcgaame.supabase.co`
- **`tools/.env.supabase`의 `DATABASE_URL`은 RLS를 우회하는 서버 쓰기용 크리덴셜 — 절대
  웹앱(Vercel)에 넣지 말 것.** 웹은 `courtside-web/.env.local`의 anon key(읽기 전용 RLS)만
  사용한다.
- **이 프로젝트는 courtside-web뿐 아니라 "Who Are Ya" 게임 시리즈와 공유된다**(같은
  `igbdbjhdpameorcgaame` 프로젝트). 스키마/정책/권한 변경은 다른 앱에 영향 없는지 확인할 것.
- RLS/RPC 권한을 바꾼 직후나 보안 점검이 필요할 땐 `.claude/agents/supabase-auditor.md`(읽기
  전용 감사 에이전트) 사용.

## 배포

`courtside-web` 배포 절차는 `courtside-web/DEPLOY.md` 참고. 핵심만: 이 저장소는 모노레포라
Vercel Root Directory를 반드시 `courtside-web`으로 지정해야 한다(git 루트가 아님).
