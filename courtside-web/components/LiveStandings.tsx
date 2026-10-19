import { projectStandings, type BaseStanding, type ProjectedStanding } from "@/lib/liveStandings";
import { teamInkStyle } from "@/lib/teamAccent";
import { TeamBadge, type TeamBadgeInfo } from "./TeamBadge";

type TeamInfo = NonNullable<TeamBadgeInfo>;

/** 순위 변동 표시 - 오르면 ▲, 내리면 ▼, 그대로거나 이전 순위가 없으면 아무것도 안 그린다. */
function Move({ r }: { r: ProjectedStanding }) {
  if (r.prevRank == null || r.prevRank === r.rank) return null;
  const up = r.rank < r.prevRank;
  return <span className={`lstand-move ${up ? "up" : "down"}`}>{up ? `▲${r.prevRank - r.rank}` : `▼${r.rank - r.prevRank}`}</span>;
}

const rankOf = (rows: ProjectedStanding[], tcode: string) => rows.find((r) => r.tcode === tcode)?.rank;
/** 표 안에서는 연고지를 뗀 팀명("울산 현대모비스" -> "현대모비스") - 360px 폰에서 마지막 게임차 칸이 잘렸다. 약어(MOB·GAS)는 영문 코드라 안 쓴다. */
const shortName = (name: string) => (name.indexOf(" ") > 0 ? name.slice(name.indexOf(" ") + 1) : name);
const gbText = (gb: number) => (gb === 0 ? "-" : Number.isInteger(gb) ? String(gb) : gb.toFixed(1));

/**
 * 실시간 리그 순위표 - 이 경기 전 순위(page.tsx가 이 경기를 뺀 getStandingsAsOf로 만든다)에 스크럽 시점 스코어를 결과로 더한 표와,
 * 두 팀의 "지금 순위 -> 이대로면 / 이기면 · 지면". mode: live = 진행 중, final = 종료 경기의 마지막 장면(실제 결과), replay = 종료 경기의 지난 장면.
 */
export function LiveStandings({
  base,
  teams,
  home,
  away,
  margin,
  mode,
}: {
  base: BaseStanding[];
  teams: Record<string, TeamInfo>;
  home: string;
  away: string;
  /** 홈 득점 - 원정 득점(스크럽 시점). 0이면 결과를 더하지 않는다. */
  margin: number;
  mode: "live" | "final" | "replay";
}) {
  const now = projectStandings(base, home, away, margin);
  // "이기면 · 지면"은 지금 점수 차 그대로 승패만 뒤집은 결과(최소 1점) - 이기고 있는 팀의 "이기면"이 위 표와 같은 값이 된다.
  const m = Math.max(1, Math.abs(margin));
  const homeWins = projectStandings(base, home, away, m);
  const awayWins = projectStandings(base, home, away, -m);
  const title = mode === "final" ? "이 경기 결과 반영" : mode === "live" ? "지금 스코어로 끝나면" : "이 장면 스코어로 끝났다면";
  const summary = (tcode: string, win: ProjectedStanding[], lose: ProjectedStanding[]) => {
    const r = now.find((x) => x.tcode === tcode)!;
    const t = teams[tcode];
    return (
      <div className="lstand-team" key={tcode}>
        <b className="team-ink" style={teamInkStyle(t?.color)}>
          {t?.name ?? tcode}
        </b>{" "}
        {r.prevRank != null ? `${r.prevRank}위` : "첫 경기"}
        {margin !== 0 &&
          (r.prevRank === r.rank ? (
            " 유지"
          ) : (
            <>
              {" → "}
              <b>{r.rank}위</b> <Move r={r} />
            </>
          ))}
        {mode !== "final" && (
          <span className="lstand-if">
            {" "}
            · 이기면 {rankOf(win, tcode)}위 · 지면 {rankOf(lose, tcode)}위
          </span>
        )}
      </div>
    );
  };
  return (
    <div className="lstand">
      <div className="panel-title">리그 순위 ({title})</div>
      <div className="lstand-teams">
        {summary(home, homeWins, awayWins)}
        {summary(away, awayWins, homeWins)}
      </div>
      <div className="table-scroll">
        <table className="data-table lstand-table">
          <thead>
            <tr>
              <th>#</th>
              <th>팀</th>
              <th>승-패</th>
              <th>승률</th>
              <th>게임차</th>
            </tr>
          </thead>
          <tbody>
            {now.map((r) => {
              const t = teams[r.tcode];
              const playing = r.tcode === home || r.tcode === away;
              return (
                <tr key={r.tcode} className={playing ? "lstand-playing team-ink" : undefined} style={playing ? teamInkStyle(t?.color) : undefined}>
                  <td>{r.rank}</td>
                  {/* 변동(▲▼)은 칸을 따로 두지 않고 팀 이름 옆에 - 폰 폭에서 6번째 칸이 가로 스크롤 밖으로 밀려 안 보였다. */}
                  <td className="lstand-name">
                    <TeamBadge team={t ?? null} size={18} />
                    {t ? shortName(t.name) : r.tcode} <Move r={r} />
                  </td>
                  <td>
                    {r.wins}-{r.losses}
                  </td>
                  <td>{r.wins + r.losses > 0 ? `${(r.pct * 100).toFixed(1)}%` : "-"}</td>
                  <td>{gbText(r.gb)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="lstand-note">
        이 경기 전 순위에 {mode === "final" ? "이 경기 결과를" : "이 시점 스코어를 결과로"} 더한 표입니다. 같은 시간 다른 경기는 반영하지 않으며, 순위는
        승률 순(같으면 경기당 득실마진)으로 사이트 순위표와 같은 기준입니다.
      </div>
    </div>
  );
}
