import Link from "next/link";

// 사용자 요청("선수프로필/득점분포탐색기/승리기여도 리더보드/폼지수 리더보드/코트사이드까지
// 모든것을 연동") - 여러 페이지가 생기면서 전역 내비게이션이 필요해짐. 각 항목은 완성되는
// 대로 여기 추가(순서: 승리기여도 → 득점분포 → 선수프로필 → 폼지수 → 인터랙티브 리플레이).
//
// 실측: 12개를 한 줄 overflow-x에 늘어놓으니 375px에서 3.5개만 화면에 닿았고, 잘렸다는
// 단서조차 없었다. 순서와 이름은 그대로 두고 두 무리로만 나눈다 - 주요(경기/리포트/팀/선수/
// 감독)는 어느 폭에서도 탭으로 보이고, 나머지는 좁은 화면에서 접힌다.
//
// 2026-10-06(사용자 요청, nba.com/stats 네비바 참고) - "분석 더보기" 하나에 9개를 뭉쳐두니
// 서로 무관한 항목들(라운드 어워드 옆에 커스텀 지표)이 한 묶음으로 보였다. nba.com도 Stats
// 드롭다운 안을 Players/Teams/Leaders 등 성격별로 다시 쪼갠다 - 같은 패턴으로 "리더보드·시상"
// (순위·수상 성격) / "플레이 분석"(경기 장면 리포트) / "조합·커스텀"(선수 조합·커스텀 지표)
// 세 그룹으로 나눈다. MAIN_LINKS는 이미 자리 잡은 구성이라 손대지 않는다(폭이 좁을 때도 항상
// 보여야 하는 항목들이라 더 추가하면 전에 겪은 overflow 문제가 재발함).
const MAIN_LINKS = [
  { href: "/", label: "경기 목록" },
  { href: "/rankings/teams", label: "팀 순위" },
  { href: "/preseason", label: "개막 리포트" },
  { href: "/teams", label: "팀 자세히 보기" },
  { href: "/players", label: "선수 자세히 보기" },
  { href: "/coaches", label: "감독" },
];

const DROPDOWN_GROUPS = [
  {
    key: "season",
    label: "시즌 개관",
    links: [
      { href: "/season", label: "시즌 허브" },
      { href: "/season-browser", label: "시즌 브라우저" },
    ],
  },
  {
    key: "leaders",
    label: "리더보드·시상",
    links: [
      { href: "/leaderboards/season", label: "시즌 리더보드" },
      { href: "/awards/round", label: "라운드 어워드" },
      { href: "/rankings/legends", label: "올타임 리더스" },
    ],
  },
  {
    key: "plays",
    label: "플레이 분석",
    links: [
      { href: "/leaderboards/win-contribution", label: "승부를 가른 순간" },
      { href: "/leaderboards/scoring-explorer", label: "슈팅 리포트" },
      { href: "/leaderboards/form-index", label: "슛 결정력" },
    ],
  },
  {
    key: "tools",
    label: "조합·커스텀",
    links: [
      { href: "/lineups", label: "선수별 조합" },
      { href: "/leaderboards/custom-metric", label: "커스텀 지표" },
    ],
  },
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
        {/* 순수 <details>/<summary> 접이식 - 클라이언트 JS 0. 모든 너비에서 진짜 토글이다
            (2026-10-06, 사용자 요청 - 전엔 ≥900px에서 4그룹을 강제로 펼쳐놔서 네비바가
            커지고 본문을 눌렀다). name="nav-group"은 같은 이름끼리 한 번에 하나만 열리게
            하는 네이티브 아코디언 묶음(미지원 브라우저는 그냥 평범한 각자 토글로 동작 -
            깨지지 않음). */}
        <div className="nav-secondary">
          {DROPDOWN_GROUPS.map((g) => (
            <details key={g.key} name="nav-group" className="nav-more">
              <summary className="nav-more-summary">{g.label}</summary>
              <div className="nav-analysis">
                {g.links.map((l) => (
                  <Link key={l.href} href={l.href} className="nav-link">
                    {l.label}
                  </Link>
                ))}
              </div>
            </details>
          ))}
        </div>
      </div>
    </nav>
  );
}
