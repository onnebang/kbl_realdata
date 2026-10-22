# 핸드오프 작업 시작/정리: worktree + 핸드오프 폴더를 한 번에.
#   .\docs\handoff\task.ps1 <slug>            # 시작 (파이썬/문서 작업)
#   .\docs\handoff\task.ps1 <slug> -Web       # 시작 + courtside-web 용 node_modules/.env.local 복사 (~1분)
#   .\docs\handoff\task.ps1 <slug> -Remove    # 정리 (미커밋 변경이 있으면 거부됨)
# 메인 폴더에서 실행할 것. 브랜치 전환은 하지 않는다 (수집기가 이 폴더에서 돈다).
param(
    [Parameter(Mandatory)][string]$Slug,
    [switch]$Web,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
if ($Slug -notmatch '^[a-z0-9]+(-[a-z0-9]+)*$') { throw "slug 는 영문 소문자-하이픈만 (예: streak-board-fix)" }

$root   = (Resolve-Path "$PSScriptRoot\..\..").Path
$wt     = Join-Path $root ".claude\worktrees\$Slug"     # 이미 .git/info/exclude 로 제외된 위치
$branch = "feat/$Slug"

if ($Remove) {
    git -C $root worktree remove $wt          # --force 없음: 커밋 안 한 변경이 있으면 git 이 거부
    if ($LASTEXITCODE) { throw "worktree 제거 거부됨 - 변경을 커밋/폐기한 뒤 다시" }
    git -C $root branch -d $branch            # 병합 안 된 브랜치면 git 이 거부 (그대로 둠)
    return
}

if (Test-Path $wt) { throw "이미 있음: $wt" }
git -C $root worktree add $wt -b $branch main  # ponytail: 로컬 main 기준. 원격 최신이 필요하면 먼저 git fetch/pull
if ($LASTEXITCODE) { throw "worktree 생성 실패" }

$dir = Join-Path $root ("docs\handoff\{0}-{1}" -f (Get-Date -Format 'yyyy-MM-dd'), $Slug)
New-Item -ItemType Directory -Force $dir | Out-Null

if ($Web) {
    # 정션/심볼릭 링크는 Turbopack 이 거부함 -> 진짜 복사 (reference_vercel_build_repro)
    $src = Join-Path $root 'courtside-web'; $dst = Join-Path $wt 'courtside-web'
    Copy-Item "$src\.env.local" $dst -ErrorAction Stop
    robocopy "$src\node_modules" "$dst\node_modules" /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "node_modules 복사 실패 (robocopy $LASTEXITCODE)" }
    $global:LASTEXITCODE = 0
}

"worktree : $wt"
"branch   : $branch"
"handoff  : $dir"
"주의: tools/.env.supabase(DB 쓰기 키)와 raw/ 는 복사하지 않음. DB 가 필요한 작업이면 PLAN 에 적고 사용자가 직접 결정."
