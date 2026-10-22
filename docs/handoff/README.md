# 멀티 에이전트 핸드오프 (Gemini → Claude → Codex)

작업 하나 = 폴더 하나 = 파일 3개. 에이전트끼리 프롬프트를 복붙하지 않고 **파일로** 넘긴다.

```
docs/handoff/2026-10-13-<slug>/
  PLAN.md     ① Gemini 가 작성 → 사용자가 APPROVED 로 승인
  IMPL.md     ② Claude 가 구현 후 작성
  REVIEW.md   ③ Codex 가 리뷰·검증 후 작성
```

`<slug>` 는 영문 소문자-하이픈 (예: `streak-board-fix`).

## 시작 (사용자가 메인 폴더에서 1회)

```powershell
.\docs\handoff\task.ps1 <slug>          # 파이썬/문서 작업
.\docs\handoff\task.ps1 <slug> -Web     # courtside-web 작업 (node_modules·.env.local 복사, 약 3분)
```

핸드오프 폴더와 worktree(`.claude\worktrees\<slug>`, 브랜치 `feat/<slug>`, 로컬 `main` 기준)를 한 번에 만든다.
메인 폴더에 커밋 안 한 다른 세션의 작업은 worktree 에 **들어가지 않는다** (HEAD 기준이라서).
복사하지 않는 것: `tools/.env.supabase`(DB 쓰기 키), `raw/`(로컬 DB). DB·raw 가 필요한 작업이면 PLAN 에 적고 사용자가 결정한다.

## 흐름

| # | 누가 | 읽는 것 | 쓰는 것 | 다음 조건 |
|---|---|---|---|---|
| 1 | Gemini (Antigravity) | 코드, 자료 | `PLAN.md` | **사용자가 읽고 첫 줄 상태를 `APPROVED` 로 수정** |
| 2 | Claude (Claude Code) | `PLAN.md` | 코드 + `IMPL.md` | IMPL.md 의 "실행한 검증" 이 채워짐 |
| 3 | Codex | `PLAN.md`, `IMPL.md`, diff | `REVIEW.md` | 판정 PASS → 사용자가 push. FIX → 2번으로 (같은 폴더에 `IMPL.md` 덮어쓰지 말고 끝에 `## 수정 라운드` 로 이어쓰기) |

## 자동 실행 (②③ 구간)

```powershell
.\docs\handoff\run.ps1 <slug>              # Claude 구현 1회 -> Codex 리뷰 1회
.\docs\handoff\run.ps1 <slug> -Rounds 2    # 리뷰가 FIX 면 (구현->리뷰) 한 번 더, PASS 면 거기서 멈춤
.\docs\handoff\run.ps1 <slug> -DryRun      # 게이트·경로만 확인 (AI 호출 없음)
```

- ① 계획은 자동화하지 않는다: 설치된 헤드리스 Gemini CLI 가 없어서 Antigravity 에서 수동으로 (위 프롬프트 ①).
- 스크립트가 직접 막는 것: PLAN.md 첫 줄이 `APPROVED` 가 아니면 시작하지 않는다. Claude 에게는 `git push`·브랜치 전환·`reset --hard`·`clean` 을 거부하고, 구현 1회당 예산 상한(`-MaxBudgetUsd`, 기본 3달러)을 둔다.
- 이것은 **샌드박스가 아니다.** 허용 목록(git 읽기·add·commit, python, node, npx)일 뿐이고 python/node 는 임의 코드를 돌릴 수 있다. 그래서 PLAN 승인과 병합 전 확인은 사람이 한다.
- Codex 의 최종 답변이 곧 `REVIEW.md` 가 된다 (스크립트가 `-o` 로 저장). 리뷰 후 worktree 가 바뀌었으면 경고를 띄운다.
- 로그: 같은 폴더의 `log-impl-*.txt`, `log-review-*.txt`. 끝나면 `IMPL.md`·`REVIEW.md` 를 읽고 병합 여부를 결정한다.
- 바이너리는 Antigravity 확장에 든 것을 자동으로 찾는다. 다른 것을 쓰려면 환경변수 `CLAUDE_BIN`, `CODEX_BIN`.
- PowerShell 7 필요 (`pwsh`).

## 공통 규칙 (세 에이전트 모두)

1. **PLAN.md 첫 줄이 `상태: APPROVED` 가 아니면 코드를 건드리지 않는다.**
2. 메인 폴더(`D:\영상작업\축구\개발\kbl_realdata`)에서는 **브랜치를 바꾸지 않는다** (수집기가 돌고 있음). 코드 수정은 전부 `D:\영상작업\축구\개발\kbl_realdata\.claude\worktrees\<slug>` 안에서 한다. worktree 는 사용자가 `task.ps1` 로 미리 만들어 둔다 — 에이전트가 직접 만들지 않는다.
3. 핸드오프 폴더는 **항상 메인 폴더의 절대경로**로 읽고 쓴다 (worktree 에는 untracked 파일이 안 보임). 코드는 worktree 에서 읽고 고친다.
   커밋은 `git add <명시한 경로>` 만 쓴다 (`-A`/`.` 금지).
4. 파이썬은 `D:\영상작업\축구\개발\.venv\Scripts\python.exe` 만 쓴다 (Anaconda 금지, `.agents/rules/python-env.md` 참고).
5. `git push` 와 배포는 하지 않는다. 사용자가 한다.
6. **직접 실행해서 본 출력만 "확인됨"으로 쓴다.** 안 돌려본 것은 "미확인" 이라고 적는다.
7. Supabase / 키 / `.env` 규칙은 루트 `CLAUDE.md` 를 따른다 (`DATABASE_URL` 은 웹앱에 넣지 않음).

## 파일 양식

**PLAN.md**
```
상태: DRAFT        <- 사용자가 APPROVED 로 바꿈
# PLAN: <제목>
## 목표 (한 문장)
## 범위 / 비범위
## 변경할 파일 (경로 + 한 줄 이유)
## 검증 방법 (구현 후 통과해야 할 명령어와 기대 결과)
## 위험 / 모르는 것
```

**IMPL.md**
```
# IMPL: <제목>
- worktree: <절대경로>
- branch: feat/<slug>
## 한 일
## 계획과 달라진 점 (없으면 "없음")
## 실행한 검증 (명령어 + 실제 출력 요약)
## 리뷰어가 볼 곳 (파일:줄, 자신 없는 부분)
```

**REVIEW.md**
```
판정: PASS | FIX
# REVIEW: <제목>
## 발견 (심각도순: 파일:줄 / 근거 / 고칠 방향)
## 직접 돌린 검증 (명령어 + 출력 요약)
## 못 본 것
```

## 프롬프트 (복사해서 각 도구에 붙여넣기, `<slug>` 만 바꿈)

**① Gemini (Antigravity) — 계획**
```
docs/handoff/README.md 를 읽고 그 규칙을 따라라. 역할은 '계획자'다.
작업: <무엇을 하고 싶은지 한두 문장>
D:\영상작업\축구\개발\kbl_realdata\docs\handoff\2026-10-13-<slug>\PLAN.md 를 README 의 PLAN 양식으로 작성하라.
상태는 DRAFT 로 둔다. 코드는 수정하지 마라. 모르는 것은 추측하지 말고 "위험 / 모르는 것" 에 적어라.
```

**② Claude (Claude Code) — 구현**
```
docs/handoff/README.md 를 읽고 그 규칙을 따라라. 역할은 '구현자'다.
D:\영상작업\축구\개발\kbl_realdata\docs\handoff\2026-10-13-<slug>\PLAN.md 를 읽어라.
상태가 APPROVED 가 아니면 멈추고 알려라. APPROVED 면 D:\영상작업\축구\개발\kbl_realdata\.claude\worktrees\<slug> 안에서만
계획대로 구현하고(범위 밖 변경 금지, 메인 폴더 수정 금지), PLAN 의 검증 방법을 직접 실행한 뒤
브랜치 feat/<slug> 에 커밋하고 IMPL.md 를 README 양식으로 작성하라. push 는 하지 마라.
```

**③ Codex — 리뷰**
```
docs/handoff/README.md 를 읽고 그 규칙을 따라라. 역할은 '리뷰어'다. 코드는 수정하지 마라.
D:\영상작업\축구\개발\kbl_realdata\docs\handoff\2026-10-13-<slug>\ 의 PLAN.md 와 IMPL.md 를 읽고,
IMPL.md 의 worktree 에서 `git diff main...HEAD` 를 검토하라.
계획 이탈, 버그, 누락된 엣지 케이스를 찾고 PLAN 의 검증 방법을 직접 다시 실행해 REVIEW.md 를 README 양식으로 작성하라.
```

## 끝난 뒤 정리

- PASS 후 사용자가 `feat/<slug>` 를 main 에 병합·push → 라이브 페이지를 curl 로 확인.
- `.\docs\handoff\task.ps1 <slug> -Remove` — worktree 와 브랜치 삭제. 커밋 안 한 변경이 있거나 병합 안 된 브랜치면 git 이 거부하므로 그대로 두면 된다.
