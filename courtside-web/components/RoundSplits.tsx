import { roundDelta, type RoundDelta, type RoundSplit, type RoundSplits } from "@/lib/roundSplits";
import styles from "./RoundSplits.module.css";

const num = (v: number) => v.toFixed(1);
const pct = (v: number | null) => (v == null ? "-" : (v * 100).toFixed(1));

function Delta({ d, role }: { d: RoundDelta | null; role?: boolean }) {
  if (!d) return null;
  const shown = Math.abs(d.value) < 0.05 ? "0.0" : `${d.value > 0 ? "+" : "-"}${Math.abs(d.value).toFixed(1)}`;
  return <span className={`${styles.d} ${styles[role ? "role" : d.tone]}`}>{shown}</span>;
}

type Stat = "pts" | "reb" | "ast";

/** 이 라운드 값 + 직전에 뛴 라운드 대비 변화(출전 시간은 좋고나쁨이 없어 중립 색). */
function StatCell({ rs, prev, value, stat }: { rs: RoundSplit; prev: RoundSplit | null; value: number; stat: Stat | "min" }) {
  let delta: RoundDelta | null = null;
  if (prev?.agg) {
    if (stat === "min") delta = { value: value - prev.agg.minPg, tone: "flat" };
    else {
      const prevValue = stat === "pts" ? prev.agg.ppg : stat === "reb" ? prev.agg.rpg : prev.agg.apg;
      delta = roundDelta(value, prevValue, rs.se?.[stat] ?? null, prev.se?.[stat] ?? null);
    }
  }
  return (
    <td>
      <span className={styles.v}>{num(value)}</span>
      <Delta d={delta} role={stat === "min"} />
    </td>
  );
}

export function RoundSplitsTable({ splits }: { splits: RoundSplits }) {
  // 변화는 직전에 "뛴" 라운드 대비 - 안 뛴 라운드는 건너뛴다.
  const rows = splits.rounds.map((rs, i) => ({ rs, before: splits.rounds.slice(0, i).reverse().find((r) => r.agg) ?? null }));
  return (
    <>
      <div className="table-scroll">
        <table className={styles.table}>
          <thead>
            <tr>
              <th>라운드</th>
              <th>경기</th>
              <th>MIN</th>
              <th>PTS</th>
              <th>REB</th>
              <th>AST</th>
              <th>STL</th>
              <th>BLK</th>
              <th>TOV</th>
              <th>FG%</th>
              <th>3P%</th>
              <th>FT%</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ rs, before }) =>
              rs.agg ? (
                <tr key={rs.round}>
                  <td className={styles.round}>{rs.round}라운드</td>
                  <td>{rs.agg.gp}</td>
                  <StatCell rs={rs} prev={before} value={rs.agg.minPg} stat="min" />
                  <StatCell rs={rs} prev={before} value={rs.agg.ppg} stat="pts" />
                  <StatCell rs={rs} prev={before} value={rs.agg.rpg} stat="reb" />
                  <StatCell rs={rs} prev={before} value={rs.agg.apg} stat="ast" />
                  <td>{num(rs.agg.spg)}</td>
                  <td>{num(rs.agg.bpg)}</td>
                  <td>{num(rs.agg.tovPg)}</td>
                  <td>{pct(rs.agg.fgPct)}</td>
                  <td>{pct(rs.agg.tpPct)}</td>
                  <td>{pct(rs.agg.ftPct)}</td>
                </tr>
              ) : (
                <tr key={rs.round}>
                  <td className={styles.round}>{rs.round}라운드</td>
                  <td className={styles.empty} colSpan={11}>
                    {rs.round > splits.currentRound ? "예정" : "기록 없음"}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <p className={styles.note}>
        경기당 평균 · 아래 작은 숫자는 직전에 뛴 라운드 대비 변화(표본 오차 안이면 회색). 라운드는 경기 순번으로 끊은 계산값
        ({splits.perRound}경기 = 1라운드)이라 공식 표기와 하루쯤 어긋날 수 있습니다.
      </p>
    </>
  );
}
