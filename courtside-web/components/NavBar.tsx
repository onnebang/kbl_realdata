import Link from "next/link";

// 사용자 요청("선수프로필/득점분포탐색기/승리기여도 리더보드/폼지수 리더보드/코트사이드까지
// 모든것을 연동") - 여러 페이지가 생기면서 전역 내비게이션이 필요해짐. 각 항목은 완성되는
// 대로 여기 추가(순서: 승리기여도 → 득점분포 → 선수프로필 → 폼지수 → 인터랙티브 리플레이).
const LINKS = [
  { href: "/", label: "경기 목록" },
  { href: "/preseason", label: "개막 리포트" },
  { href: "/teams", label: "팀 자세히 보기" },
  { href: "/players", label: "선수 자세히 보기" },
  // 선수별 조합(WOWY)은 선수 도구라 선수 항목 옆에, 시즌 리더보드는 나머지 리더보드 묶음
  // 맨 앞에 둔다(요청: "시즌별 리더보드 추가 / 선수별 조합").
  { href: "/lineups", label: "선수별 조합" },
  { href: "/season-browser", label: "시즌 브라우저" },
  { href: "/leaderboards/season", label: "시즌 리더보드" },
  { href: "/leaderboards/win-contribution", label: "승리 기여도" },
  { href: "/leaderboards/scoring-explorer", label: "슈팅 리포트" },
  { href: "/leaderboards/form-index", label: "폼 지수" },
  { href: "/leaderboards/custom-metric", label: "커스텀 지표" },
];

export function NavBar() {
  return (
    <nav className="nav-bar">
      <div className="nav-bar-inner">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="nav-link">
            {l.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
