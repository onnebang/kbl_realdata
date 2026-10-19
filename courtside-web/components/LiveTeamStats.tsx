import type { BoxLine } from "@/lib/boxEvents";
import { iGa } from "@/lib/josa";
import { scoringSplit, whereBehind } from "@/lib/liveTeamStats";
import { teamInkStyle } from "@/lib/teamAccent";
import { TeamPctBar, TeamSplitBar } from "./report/TeamSplitBar";

type Team = { name: string; color: string };

const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n)}`;

/**
 * 실시간 중계 '팀 스탯' - GameReplay가 스크럽 시점 박스를 팀별로 더해(lib/liveTeamStats.ts teamLine) 넘긴다. 막대는 경기 후 탭의
 * '팀 스탯'과 같은 컴포넌트(TeamPctBar/TeamSplitBar)다. 지고 있으면 맨 위에 "어디서 밀리는지" 한 줄과 점수 차 분해를 붙인다.
 */
export function LiveTeamStats({ home, away, h, a }: { home: Team; away: Team; h: BoxLine; a: BoxLine }) {
  if (h.fga + h.fta + a.fga + a.fta === 0) return null; // 아직 슛이 하나도 없다(경기 시작 전)
  const hc = home.color;
  const ac = away.color;
  const tied = h.pts === a.pts;
  const homeTrails = h.pts < a.pts;
  const [trail, lead, trailTeam] = homeTrails ? [h, a, home] : [a, h, away];
  const gaps = tied ? [] : whereBehind(trail, lead);
  const split = scoringSplit(trail, lead);
  const pct = (label: string, hm: number, ha: number, am: number, aa: number) => (
    <TeamPctBar key={label} label={label} hMade={hm} hAtt={ha} aMade={am} aAtt={aa} hColor={hc} aColor={ac} />
  );
  const count = (label: string, hv: number, av: number) => <TeamSplitBar key={label} label={label} hVal={hv} aVal={av} hDisp={hv} aDisp={av} hColor={hc} aColor={ac} />;
  return (
    <div className="replay-teamstats">
      <div className="panel-title">팀 스탯 (이 순간까지)</div>
      {!tied && (
        <div className="replay-behind">
          <div className="replay-behind-main">
            <b className="team-ink" style={teamInkStyle(trailTeam.color)}>
              {trailTeam.name}
            </b>
            {iGa(trailTeam.name)} 밀리는 곳:{" "}
            {gaps.length > 0 ? (
              gaps.map((g, i) => (
                <span key={g.key} className="replay-behind-item">
                  {i > 0 && " · "}
                  {g.label} <b>{g.value}</b> <span className="replay-behind-detail">({g.detail})</span>
                </span>
              ))
            ) : (
              <span className="replay-behind-item">한 부문에서 크게 밀리지는 않음</span>
            )}
          </div>
          <div className="replay-behind-split">
            점수 차 {signed(trail.pts - lead.pts)} = 2점 {signed(split.two)} · 3점 {signed(split.three)} · 자유투 {signed(split.ft)}
          </div>
        </div>
      )}
      {pct("FG%", h.fgm, h.fga, a.fgm, a.fga)}
      {pct("2PT%", h.fgm - h.threePM, h.fga - h.threePA, a.fgm - a.threePM, a.fga - a.threePA)}
      {pct("3PT%", h.threePM, h.threePA, a.threePM, a.threePA)}
      {pct("FT%", h.ftm, h.fta, a.ftm, a.fta)}
      {count("리바운드", h.reb, a.reb)}
      {count("공격 리바운드", h.oreb, a.oreb)}
      {count("어시스트", h.ast, a.ast)}
      {count("턴오버", h.to, a.to)}
      {count("스틸", h.stl, a.stl)}
      {count("블록", h.blk, a.blk)}
      {count("파울", h.foul, a.foul)}
    </div>
  );
}
