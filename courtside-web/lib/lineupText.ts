// 결장자를 팀별로 갈라서 적는다(예: "KCC: 허훈·송교창 / LG: 유기상"). 양 팀 여섯 명을 한 줄에
// 섞어 나열하면 누가 어느 팀인지 독자가 짐작해야 한다(2026-09-25 홈 카드 실측).
export function absenceText(
  homeLabel: string,
  awayLabel: string,
  a: { absentHome: string[]; absentAway: string[] }
): string {
  return [
    a.absentHome.length ? `${homeLabel}: ${a.absentHome.join("·")}` : "",
    a.absentAway.length ? `${awayLabel}: ${a.absentAway.join("·")}` : "",
  ]
    .filter(Boolean)
    .join(" / ");
}
