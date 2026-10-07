import { MAKE_CODES, MISS_CODES } from "./possessionFeed";

// 이벤트 로그(game_events action_code) -> 선수 박스스코어 한 줄. components/GameReplay.tsx의 박스스코어 계산과
// 라이브 "기록 워치"(lib/milestones.ts의 타임라인)가 **같은 규칙**을 쓰도록 한 곳에 뒀다 - 두 곳에서 따로 세면
// 화면의 박스는 17리바인데 알림은 16리바로 계산하는 식으로 어긋난다.

// 215(파울자유투)가 빠져 있으면 개인 파울이 실제보다 적게 세어진다 - PF 칸을 추가하면서
// 실측(25-26 최근 40경기 845 선수-경기)으로 확인: 215+216+224면 845/845 전부 game_player_stats.fouls와
// 일치, 216+224만이면 463/845만 일치했다. lib/possessionFeed.ts·lib/postgameReport.ts는 처음부터
// 세 코드를 다 세고 있었다.
const FOUL_CODES = new Set(["215", "216", "224"]);

export function emptyBoxLine() {
  // oreb/dreb - Game Leaders 카드(REBOUNDS 항목의 "N DREB, M OREB" 서브라인)용으로 209/210을
  // 나눠 셈. reb는 그대로 둘의 합(기존 박스스코어 테이블 REB 컬럼이 이미 이 값을 씀).
  return { pts: 0, fgm: 0, fga: 0, threePM: 0, threePA: 0, ftm: 0, fta: 0, reb: 0, oreb: 0, dreb: 0, ast: 0, stl: 0, blk: 0, to: 0, foul: 0 };
}
export type BoxLine = ReturnType<typeof emptyBoxLine>;

/** action_code 하나가 그 선수 박스(b)에 더하는 값을 반영한다(b를 직접 고친다). */
export function applyBoxEvent(b: BoxLine, code: string): void {
  if (MAKE_CODES.has(code)) {
    b.pts += code === "205" ? 3 : 2;
    b.fgm++;
    b.fga++;
    if (code === "205") {
      b.threePM++;
      b.threePA++;
    }
  } else if (MISS_CODES.has(code)) {
    if (code === "206") b.threePA++;
    b.fga++;
  } else if (code === "203") {
    b.pts += 1;
    b.ftm++;
    b.fta++;
  } else if (code === "204") {
    b.fta++;
  } else if (code === "209" || code === "210") {
    b.reb++;
    if (code === "209") b.oreb++;
    else b.dreb++;
  } else if (code === "211") {
    b.ast++;
  } else if (code === "212") {
    b.stl++;
  } else if (code === "213") {
    b.blk++;
  } else if (code === "214") {
    b.to++;
  } else if (FOUL_CODES.has(code)) {
    b.foul++;
  }
}
