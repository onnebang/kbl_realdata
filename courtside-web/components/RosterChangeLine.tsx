import Link from "next/link";
import { shortSeason, type RosterChange } from "@/lib/preseason";
import styles from "@/app/preseason/preseason.module.css";

// 로스터 변화 한 줄(칩 + 이름 + 마지막 시즌 성적 + 출처/행선지) - /preseason의 팀 카드와
// /teams/[tcode]의 "이번 시즌 로스터 변화" 패널이 같은 컴포넌트를 쓴다(문구·판정 표기가
// 두 곳에서 달라지지 않도록). 스타일은 preseason.module.css를 그대로 공유.

export const CHANGE_CHIP: Record<RosterChange["change"], { label: string; cls: string }> = {
  in: { label: "영입", cls: styles.chipIn },
  new: { label: "신입", cls: styles.chipNew },
  stay: { label: "잔류", cls: styles.chipStay },
  out: { label: "이탈", cls: styles.chipOut },
};

/** "25-26 51G · 20.8P 8.9R 2.6A" - 성적이 없으면 null(신입). */
export function statLine(r: RosterChange): string | null {
  if (r.gp == null || r.prevSeason == null) return null;
  return `${shortSeason(r.prevSeason)} ${r.gp}G · ${r.ppg?.toFixed(1)}P ${r.rpg?.toFixed(1)}R ${r.apg?.toFixed(1)}A`;
}

export function ChangeLine({ r, abbrOf }: { r: RosterChange; abbrOf: (tcode: string | null) => string | null }) {
  const chip = CHANGE_CHIP[r.change];
  const stat = statLine(r);
  let from: string | null = null;
  if (r.change === "in" && r.prevTcode) {
    const same = r.prevTcode === r.tcode;
    const seasonNote = r.prevSeason ? `${shortSeason(r.prevSeason)} 이후 ` : "";
    from = same ? `${seasonNote}복귀` : r.note?.includes("복귀") ? `${seasonNote}복귀 (前 ${abbrOf(r.prevTcode)})` : `← ${abbrOf(r.prevTcode)}`;
  } else if (r.change === "out") {
    from = r.nextTcode ? `→ ${abbrOf(r.nextTcode)}` : "리그 이탈";
  } else if (r.change === "new") {
    from = "KBL 첫 시즌";
  }
  return (
    <div className={styles.changeRow}>
      <span className={`${styles.chip} ${chip.cls}`}>{chip.label}</span>
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
