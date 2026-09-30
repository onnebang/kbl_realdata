import Link from "next/link";

// 사용자 요청("선수프로필/득점분포탐색기/승리기여도 리더보드/폼지수 리더보드/코트사이드까지
// 모든것을 연동") - 여러 페이지가 생기면서 전역 내비게이션이 필요해짐. 각 항목은 완성되는
// 대로 여기 추가(순서: 승리기여도 → 득점분포 → 선수프로필 → 폼지수 → 인터랙티브 리플레이).
//
// 실측: 12개를 한 줄 overflow-x에 늘어놓으니 375px에서 3.5개만 화면에 닿았고, 잘렸다는
// 단서조차 없었다. 순서와 이름은 그대로 두고 두 무리로만 나눈다 - 주요(경기/리포트/팀/선수/
// 감독)는 어느 폭에서도 탭으로 보이고, 분석(리더보드류)은 좁은 화면에서 접힌다.
const MAIN_LINKS = [
  { href: "/", label: "경기 목록" },
  { href: "/preseason", label: "개막 리포트" },
  { href: "/teams", label: "팀 자세히 보기" },
  { href: "/players", label: "선수 자세히 보기" },
  { href: "/coaches", label: "감독" },
];

// 선수별 조합(WOWY)은 선수 도구라 선수 항목 옆에, 시즌 리더보드는 나머지 리더보드 묶음
// 맨 앞에 둔다(요청: "시즌별 리더보드 추가 / 선수별 조합").
const ANALYSIS_LINKS = [
  // { href: "/rankings/ovr", label: "OVR 랭킹 (2K)" },
  // { href: "/rankings/legends", label: "명예의 전당 (리빙 레전드)" },
  { href: "/predictions", label: "예측 성적표" },
  { href: "/lineups", label: "선수별 조합" },
  { href: "/season-browser", label: "시즌 브라우저" },
  { href: "/leaderboards/season", label: "시즌 리더보드" },
  { href: "/leaderboards/win-contribution", label: "승부를 가른 순간" },
  { href: "/leaderboards/scoring-explorer", label: "슈팅 리포트" },
  { href: "/leaderboards/form-index", label: "슛 결정력" },
  { href: "/leaderboards/custom-metric", label: "커스텀 지표" },
];

export function NavBar() {
  return (
    <nav className="nav-bar">
      <div className="nav-bar-inner">
        <div className="nav-main">
          {MAIN_LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="nav-link">
              {l.label}
            </Link>
          ))}
        </div>
        {/* 순수 <details>/<summary> 접이식 - 클라이언트 JS 0(이 프로젝트의 프리뷰
            인사이트 접이식과 같은 컨벤션). ≥900px에서는 globals.css가 summary를 숨기고
            내용을 강제로 펼쳐서 그냥 오른쪽에 흘려 놓는다. */}
        <details className="nav-more">
          <summary className="nav-more-summary">분석 더보기</summary>
          <div className="nav-analysis">
            {ANALYSIS_LINKS.map((l) => (
              <Link key={l.href} href={l.href} className="nav-link">
                {l.label}
              </Link>
            ))}
          </div>
        </details>
      </div>
    </nav>
  );
}
