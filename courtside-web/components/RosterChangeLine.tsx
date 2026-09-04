import Link from "next/link";
import { shortSeason, type RosterChange } from "@/lib/preseason";
import styles from "@/app/preseason/preseason.module.css";

// 로스터 변화 한 줄(칩 + 이름 + 마지막 시즌 성적 + 출처/행선지) - /preseason의 팀 카드와
// /teams/[tcode]의 "이번 시즌 로스터 변화" 패널이 같은 컴포넌트를 쓴다(문구·판정 표기가
// 두 곳에서 달라지지 않도록). 스타일은 preseason.module.css를 그대로 공유.

/** 사유가 확인된 이탈은 칩 글자도 바꾼다("이탈"보다 "군 입대"가 먼저 읽혀야 한다). */
export function changeChipLabel(r: RosterChange): string {
  if (r.change === "out" && r.reason) return REASON_TEXT[r.reason] ?? "이탈";
  return CHANGE_CHIP[r.change].label;
}

export const CHANGE_CHIP: Record<RosterChange["change"], { label: string; cls: string }> = {
  in: { label: "영입", cls: styles.chipIn },
  back: { label: "복귀", cls: styles.chipBack },
  new: { label: "신입", cls: styles.chipNew },
  stay: { label: "잔류", cls: styles.chipStay },
  out: { label: "이탈", cls: styles.chipOut },
};

/** "25-26 51G · 20.8P 8.9R 2.6A" - 성적이 없으면 null(신입).
 *
 * 이 수치는 정규시즌+플레이오프 합산 평균이다(tools/build_roster_changes.py가 season_name만으로
 * 집계). 팀 전망표의 전적은 정규시즌 기준이라 분모가 다르므로, 이 값을 쓰는 화면은 캡션에
 * 그 사실을 밝힌다(예: 카이린 갤러웨이는 정규 6경기 8.0점, 합산 9경기 5.3점). */
/** prev_season_name과 직전 시즌 사이에 통째로 빠진 시즌 수. build_roster_changes.season_gap과 같은 식. */
function gapSeasons(season: string, prevSeason: string): number {
  return Number(season.split("-")[0]) - 1 - Number(prevSeason.split("-")[0]);
}

export function statLine(r: RosterChange): string | null {
  if (r.gp == null || r.prevSeason == null) return null;
  return `${shortSeason(r.prevSeason)} ${r.gp}G · ${r.ppg?.toFixed(1)}P ${r.rpg?.toFixed(1)}R ${r.apg?.toFixed(1)}A`;
}

/** 확인된 이탈 사유 -> 화면 문구. 여기 없는 값(=null)은 예전처럼 이적/리그 이탈로 적는다. */
const REASON_TEXT: Record<string, string> = {
  military: "군 입대",
  overseas: "해외 진출",
  unsigned: "FA 미계약",
  retired: "은퇴",
  other: "이탈",
};

export function ChangeLine({ r, abbrOf }: { r: RosterChange; abbrOf: (tcode: string | null) => string | null }) {
  const chip = CHANGE_CHIP[r.change];
  const stat = statLine(r);
  let from: string | null = null;
  if (r.change === "back") {
    // 복귀는 "몇 시즌을 비웠는가"가 핵심이다. 사유(군 전역/부상/해외)는 DB에 없으므로 적지 않는다.
    // 마지막 소속이 지금 팀과 다르면 그것까지(최승욱 삼성 → 가스공사, 케베 알루마 현대모비스 → 가스공사).
    const gap = r.prevSeason ? gapSeasons(r.season, r.prevSeason) : null;
    const gapText = gap && gap > 0 ? `${gap}시즌 공백 후 복귀` : "복귀";
    const sameTeam = !r.prevTcode || r.prevTcode === r.tcode;
    from = sameTeam ? gapText : `${gapText} (前 ${abbrOf(r.prevTcode)})`;
  } else if (r.change === "in" && r.prevTcode) {
    from = `← ${abbrOf(r.prevTcode)}`;
  } else if (r.change === "out") {
    // 사유가 확인된 이탈은 "리그 이탈"로 뭉뚱그리지 않는다 - 군 입대는 전역일이 정해진 한시적
    // 공백이고(2027-11 전역이면 다음 시즌 복귀), 해외 진출·미계약은 성격이 또 다르다.
    // note에 이미 "군 입대 · 2026-05-18 입대 · 2027-11-17 전역 예정"이 들어 있어 그대로 쓴다.
    if (r.reason) {
      // note는 "군 입대 · 2026-05-18 입대 · 2027-11-17 전역 예정" 꼴이다. 앞의 사유는 이미 칩이
      // 말하고 있으니 뒤의 상세만 남긴다(같은 말이 한 줄에 두 번 나오지 않게).
      const label = REASON_TEXT[r.reason] ?? "이탈";
      const detail = r.note && r.note.startsWith(label) ? r.note.slice(label.length).replace(/^\s*·\s*/, "") : r.note;
      from = detail || label;
    } else {
      from = r.nextTcode ? `→ ${abbrOf(r.nextTcode)}` : "리그 이탈";
    }
  } else if (r.change === "new") {
    from = "KBL 첫 시즌";
  }
  return (
    <div className={styles.changeRow}>
      <span className={`${styles.chip} ${chip.cls}`}>{changeChipLabel(r)}</span>
      <div>
        {r.pcode ? (
          <Link href={`/players/${r.pcode}`} className={styles.changeName}>
            {r.name}
          </Link>
        ) : (
          <span className={styles.changeName}>{r.name}</span>
        )}
        {r.role && <span className={styles.changeRole}>{r.role}</span>}
        <div className={styles.changeStat}>
          {stat ?? "KBL 출전 기록 없음"}
          {from && <span className={styles.changeFrom}> · {from}</span>}
        </div>
      </div>
    </div>
  );
}
