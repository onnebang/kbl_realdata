#Requires -Version 7
# 자동 구간: APPROVED 된 PLAN.md -> Claude 구현 -> Codex 리뷰.
# (Gemini 계획은 Antigravity 에서 수동 - 설치된 헤드리스 Gemini CLI 가 없음.)
#   .\docs\handoff\run.ps1 <slug>              # 구현 1회 + 리뷰 1회
#   .\docs\handoff\run.ps1 <slug> -Rounds 2    # 리뷰가 FIX 면 (구현->리뷰) 한 번 더
#   .\docs\handoff\run.ps1 <slug> -DryRun      # 게이트·경로만 확인하고 AI 는 호출하지 않음
# 먼저 task.ps1 <slug> 로 worktree/폴더를 만들고, PLAN.md 첫 줄을 '상태: APPROVED' 로 고쳐 둘 것.
# 바이너리 경로를 바꾸려면 환경변수 CLAUDE_BIN / CODEX_BIN.
param(
    [Parameter(Mandatory)][string]$Slug,
    [int]$Rounds = 1,
    [double]$MaxBudgetUsd = 3,    # 구현 1회당 Claude 상한
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

$root   = (Resolve-Path "$PSScriptRoot\..\..").Path
$wt     = Join-Path $root ".claude\worktrees\$Slug"
$readme = Join-Path $root 'docs\handoff\README.md'
$dir    = Get-ChildItem "$root\docs\handoff" -Directory |
    Where-Object { $_.Name -match ('^\d{4}-\d\d-\d\d-' + [regex]::Escape($Slug) + '$') } |
    Sort-Object Name | Select-Object -Last 1 -ExpandProperty FullName
if (-not $dir)              { throw "핸드오프 폴더 없음 - 먼저 .\docs\handoff\task.ps1 $Slug" }
if (-not (Test-Path $wt))   { throw "worktree 없음: $wt" }
$plan = Join-Path $dir 'PLAN.md'
if (-not (Test-Path $plan)) { throw "PLAN.md 없음 - Antigravity 의 Gemini 로 먼저 작성 (README ① 프롬프트)" }
if ((Get-Content $plan -TotalCount 1) -notmatch ':\s*APPROVED\s*$') { throw "PLAN.md 첫 줄이 '상태: APPROVED' 가 아님 - 읽어 보고 승인한 뒤 고칠 것" }

$ext = Join-Path $env:USERPROFILE '.antigravity-ide\extensions'
function Find-Bin($var, $glob, $cmd) {
    $v = [Environment]::GetEnvironmentVariable($var)
    if ($v) { return $v }
    $f = Get-ChildItem $glob -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
    if ($f) { return $f.FullName }
    if (Get-Command $cmd -ErrorAction SilentlyContinue) { return $cmd }
    throw "$cmd 를 찾을 수 없음 - 환경변수 $var 에 경로 지정"
}
# PATH 의 claude 는 NVM 이 막는 중일 수 있어 확장에 든 네이티브 바이너리를 우선한다.
$claude = Find-Bin CLAUDE_BIN "$ext\anthropic.claude-code-*\resources\native-binary\claude.exe" claude
$codex  = Find-Bin CODEX_BIN  "$ext\openai.chatgpt-*\bin\windows-x86_64\codex.exe" codex

# ponytail: 이건 샌드박스가 아니라 도구 허용 목록임. python/node 는 임의 코드를 돌릴 수 있으니 push 거부·예산 상한·사람 게이트에 기대는 구조.
$allow = 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git add *)', 'Bash(git commit *)',
         'Bash(*python.exe*)', 'Bash(npx *)', 'Bash(node *)'
$deny  = 'Bash(git push*)', 'Bash(git checkout*)', 'Bash(git switch*)', 'Bash(git reset --hard*)', 'Bash(git clean*)'

"slug     : $Slug"
"worktree : $wt"
"handoff  : $dir"
"claude   : $claude"
"codex    : $codex"
if ($DryRun) { "(DryRun: AI 호출 없이 종료)"; return }

function Get-WtState { (git -C $wt rev-parse HEAD) + "`n" + ((git -C $wt status --porcelain) -join "`n") }

$verdict = $null
$stamp = Get-Date -Format 'HHmmss'   # 재실행해도 이전 로그를 덮어쓰지 않도록
for ($i = 1; $i -le $Rounds; $i++) {
    "`n=== 라운드 $i/$Rounds : 구현 (Claude)"
    $implPrompt = @"
$readme 를 읽고 그 규칙을 따라라. 역할은 '구현자'다.
$plan 을 읽어라 (APPROVED 확인됨).
$wt 안에서만 계획대로 구현하라 (범위 밖 변경 금지, 메인 폴더 수정 금지).
PLAN 의 검증 방법을 직접 실행하고, 브랜치 feat/$Slug 에 커밋한 뒤 $dir\IMPL.md 를 README 양식으로 작성하라. push 는 하지 마라.
$dir\REVIEW.md 가 있고 판정이 FIX 면 그 지적만 고치고, IMPL.md 끝에 '## 수정 라운드' 를 이어 써라 (기존 내용은 지우지 말 것).
"@
    $implLog = Join-Path $dir "log-impl-$stamp-$i.txt"
    Push-Location $wt
    try {
        # --add-dir: README(docs\handoff) 와 작업 폴더를 읽고 쓰려면 cwd(worktree) 밖이라 명시해야 함 (스모크 테스트에서 README 읽기가 거부됨)
        $implPrompt | & $claude -p --add-dir (Split-Path $readme) --permission-mode acceptEdits --permission-prompts none `
            --allowedTools ($allow -join ',') --disallowedTools ($deny -join ',') --max-budget-usd $MaxBudgetUsd 2>&1 |
            Tee-Object $implLog
        if ($LASTEXITCODE) { throw "claude 실패 (exit $LASTEXITCODE) - $implLog 확인" }
    } finally { Pop-Location }
    if (-not (Test-Path (Join-Path $dir 'IMPL.md'))) { throw "IMPL.md 가 생성되지 않음 - log-impl-$i.txt 확인. 리뷰 단계로 넘어가지 않음" }

    "`n=== 라운드 $i/$Rounds : 리뷰 (Codex)"
    $review = Join-Path $dir 'REVIEW.md'
    $revPrompt = @"
$readme 를 읽고 그 규칙을 따라라. 역할은 '리뷰어'다. 코드는 수정하지 마라.
$dir 의 PLAN.md 와 IMPL.md 를 읽고, 현재 작업 디렉터리($wt)에서 ``git diff main...HEAD`` 를 검토하라.
계획 이탈, 버그, 누락된 엣지 케이스를 찾고 PLAN 의 검증 방법을 직접 다시 실행하라.
당신의 최종 답변 전체가 REVIEW.md 의 내용이다 (파일을 따로 쓰지 말 것). README 의 REVIEW 양식을 그대로 따르고,
첫 줄은 정확히 '판정: PASS' 또는 '판정: FIX' 로 시작하라.
"@
    $before = Get-WtState
    $revLog = Join-Path $dir "log-review-$stamp-$i.txt"
    $revPrompt | & $codex exec -C $wt -s workspace-write -o $review - 2>&1 | Tee-Object $revLog
    if ($LASTEXITCODE) { throw "codex 실패 (exit $LASTEXITCODE) - $revLog 확인" }
    if ((Get-WtState) -ne $before) { Write-Warning "리뷰어가 worktree 를 변경했음 (HEAD 또는 작업 트리 상태가 달라짐) - 직접 확인할 것" }

    $verdict = if ((Test-Path $review) -and ((Get-Content $review -TotalCount 1) -match 'PASS|FIX')) { $Matches[0] } else { 'UNKNOWN' }
    "판정: $verdict"
    if ($verdict -eq 'PASS') { break }
}

"`n=== 끝 (판정 $verdict)"
"읽을 것  : $dir\IMPL.md , REVIEW.md"
"변경 요약: git -C `"$wt`" log main..HEAD --oneline"
"다음     : 사람이 확인 후 병합·push. 정리는 .\docs\handoff\task.ps1 $Slug -Remove"
