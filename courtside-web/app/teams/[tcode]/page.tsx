import Link from "next/link";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeamSeasonSchedule, getStandingsAsOf } from "@/lib/matchups";
import { displayTeamName } from "@/lib/teamNames";
import { buildConstellationSvg } from "@/lib/playerDataScience";
import {
  getTeamSeasonShots,
  getTeamFourFactors,
  getPregameProbs,
  buildSeasonJourney,
  getRosterContribution,
  getBestUnits,
  getTeamZoneProfile,
  UNIT_MIN_MINUTES_2MAN,
  UNIT_MIN_MINUTES_5MAN,
  ZONE_LABELS,
  type TeamFourFactors,
  type SeasonJourney,
  type RosterRow,
  type BestUnit,
  type TeamZoneProfile,
} from "@/lib/teamDataScience";
import styles from "./team-profile.module.css";

// 팀 프로필 "데이터 사이언스 + 데이터로 아름다움" 대개편(요청) - 선수 프로필과 같은 디자인
// 언어: 히어로 배경 아트 = 이 팀의 이 시즌 슛 전체를 팀 컬러 별자리로(선수판은 커리어,
// 팀판은 시즌 - 시즌 셀렉터가 있는 페이지라 시즌 단위가 서사에 맞음). 기존의 얇은 시즌
// 스케줄 페이지가 갖고 있던 기능(시즌 셀렉터/전체 일정 표/경기 링크)은 전부 하단에 유지.

type TeamInfo = { tcode: string; name: string; abbr: string; color: string; logo_url: string | null };

async function getTeam(tcode: string): Promise<TeamInfo | null> {
  const { data } = await supabase.from("teams").select("tcode, name, abbr, color, logo_url").eq("tcode", tcode).maybeSingle();
  return data as TeamInfo | null;
}

async function getSeasons(): Promise<string[]> {
  const { data } = await supabase.from("seasons").select("season_name").order("season_name", { ascending: false });
  return (data ?? []).map((s) => s.season_name);
}

function fmtDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${y.slice(2)}.${m}.${day}`;
}

function signed(v: number, decimals = 1) {
  return `${v > 0 ? "+" : ""}${v.toFixed(decimals)}`;
}

// 선수 퍼센타일 프로필과 같은 색 규칙(상위 --positive / 하위 --negative / 중간 --gold).
function percentileColor(p: number) {
  return p >= 70 ? "var(--positive)" : p <= 30 ? "var(--negative)" : "var(--gold)";
}

// ── 4팩터 vs 리그 - 선수 퍼센타일 바와 같은 시각 언어의 가로 바 8줄(공격 4 + 수비 4) ──
function FourFactorsPanel({ ff, seasonName }: { ff: TeamFourFactors | null; seasonName: string }) {
  if (!ff) return <div className="empty-note">이 시즌 정규시즌 팀 집계 없음</div>;
  const sides = [
    { side: "OFF" as const, title: "OFFENSE - 우리 공격" },
    { side: "DEF" as const, title: "DEFENSE - 상대가 우리를 상대로" },
  ];
  return (
    <>
      {sides.map(({ side, title }) => (
        <div key={side}>
          <div className={styles.ffSideTitle}>{title}</div>
          <div className={styles.pctGrid}>
            {ff.axes
              .filter((a) => a.side === side)
              .map((a) => (
                <div className={styles.pctRow} key={a.key}>
                  <div className={styles.pctLabel}>{a.label}</div>
                  <div className={styles.pctTrack}>
                    <div
                      className={styles.pctFill}
                      style={{ width: `${Math.max(a.pctFill, 3)}%`, background: percentileColor(a.pctFill) }}
                    />
                    <div className={styles.pctMid} />
                  </div>
                  <div className={styles.pctValue}>
                    {a.display} <span className={styles.pctValueAvg}>({a.leagueAvgDisplay})</span>
                  </div>
                  <div className={styles.pctNum} style={{ color: percentileColor(a.pctFill) }}>
                    {a.rank}위
                  </div>
                </div>
              ))}
          </div>
        </div>
      ))}
      <div className={styles.pctNote}>
        Dean Oliver 4팩터 · {seasonName} 정규시즌 {ff.gp}경기, 리그 {ff.teamsN}팀 대비 순위(괄호는 리그 평균) · 수비 =
        같은 경기 상대 팀의 팩터(상대 eFG%·FTr·OREB%는 낮을수록, 상대 TOV% 유발은 높을수록 좋음 - 순위·바 길이는 방향
        보정) · eFG%·FTr은 시즌 원시 합계, TOV%는 턴오버/포제션 합계, OREB%만 원시 리바운드 개수 결측으로 경기당 평균
      </div>
    </>
  );
}

// ── 시즌 여정 - 게임별 마진 바(위=승, 아래=패) + 누적 승률 선 + 최다 연승 + 모델 업셋 ──
// 승리 막대는 사이트 공용 주황(--home)이 아니라 실제 팀 색(teamColor) - 이 페이지의 다른
// 팀 색 요소(히어로/배지)와 시각 언어 통일(검증 지적 반영). 어두운 팀 색(예: KCC 남색)이
// 다크모드 표면에 묻히지 않게 옅은 외곽선을 같이 얹음.
function JourneyChart({ journey, teamColor }: { journey: SeasonJourney; teamColor: string }) {
  const games = journey.games;
  const n = games.length;
  if (!n) return <div className="empty-note">이 시즌 경기 데이터 없음</div>;

  const W = 640,
    H = 240,
    PAD_L = 30,
    PAD_R = 8,
    PAD_T = 26,
    PAD_B = 26;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const zeroY = PAD_T + plotH / 2;
  const maxAbs = Math.max(10, ...games.map((g) => Math.abs(g.margin)));
  const bw = plotW / n;
  const yMargin = (m: number) => zeroY - (m / maxAbs) * (plotH / 2);
  const yWinPct = (p: number) => PAD_T + plotH - p * plotH;
  const winLine = games.map((g, i) => `${(PAD_L + i * bw + bw / 2).toFixed(1)},${yWinPct(g.runningWinPct).toFixed(1)}`).join(" ");
  const streak = journey.longestStreak;

  return (
    <div>
      <svg className={styles.journeySvg} viewBox={`0 0 ${W} ${H}`}>
        <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="var(--ink-faint)" strokeWidth={1} />
        {/* 승률 50% 기준선(승률 축) */}
        <line x1={PAD_L} y1={yWinPct(0.5)} x2={W - PAD_R} y2={yWinPct(0.5)} stroke="var(--gold)" strokeWidth={0.5} opacity={0.3} strokeDasharray="3 4" />
        {streak && (
          <>
            <line
              x1={PAD_L + streak.startIdx * bw + bw * 0.14}
              y1={PAD_T - 5}
              x2={PAD_L + streak.endIdx * bw + bw * 0.86}
              y2={PAD_T - 5}
              stroke={teamColor}
              strokeWidth={1.6}
            />
            <text
              x={PAD_L + ((streak.startIdx + streak.endIdx + 1) / 2) * bw}
              y={PAD_T - 11}
              fontSize={10.5}
              fontWeight={700}
              textAnchor="middle"
              fill={teamColor}
              fontFamily="IBM Plex Mono, monospace"
            >
              최다 {streak.len}연승
            </text>
          </>
        )}
        {games.map((g, i) => {
          const x = PAD_L + i * bw;
          const barTop = Math.min(zeroY, yMargin(g.margin));
          const barH = Math.max(1.5, Math.abs(yMargin(g.margin) - zeroY));
          return (
            <a href={`/games/${g.gmkey}`} key={g.gmkey}>
              <rect
                x={x + bw * 0.14}
                y={barTop}
                width={Math.max(1, bw * 0.72)}
                height={barH}
                fill={g.won ? teamColor : "var(--ink-faint)"}
                stroke={g.won ? "rgba(var(--line-rgb), 0.35)" : "none"}
                strokeWidth={g.won ? 0.75 : 0}
                opacity={g.won ? 0.92 : 0.65}
                rx={1.5}
              />
              {g.upsetWin && (
                <path
                  d={`M ${x + bw / 2} ${H - PAD_B + 7} l 3.6 6.2 h -7.2 Z`}
                  fill="var(--gold)"
                />
              )}
              <title>
                {`${fmtDate(g.gameDate)} ${g.isHome ? "vs" : "@"} ${g.oppName} ${g.teamScore}-${g.oppScore} (${g.won ? "W" : "L"}${
                  g.margin > 0 ? " +" : " "
                }${g.margin})${g.seasonCategory !== "정규시즌" ? ` · ${g.seasonCategory}` : ""}${
                  g.preWinProb != null ? ` · 경기 전 모델 승률 ${(g.preWinProb * 100).toFixed(0)}%` : ""
                }`}
              </title>
            </a>
          );
        })}
        <polyline points={winLine} fill="none" stroke="var(--gold)" strokeWidth={1.8} opacity={0.9} />
        <text x={2} y={yMargin(maxAbs) + 8} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
          +{maxAbs}
        </text>
        <text x={2} y={yMargin(-maxAbs)} fontSize={9} fill="var(--ink-faint)" fontFamily="IBM Plex Mono, monospace">
          -{maxAbs}
        </text>
      </svg>
      <div className={styles.journeyLegend}>
        <span>
          <span className={styles.sw} style={{ background: teamColor }} />
          승리(점수차만큼 위로)
        </span>
        <span>
          <span className={styles.sw} style={{ background: "var(--ink-faint)" }} />
          패배(아래로)
        </span>
        <span>
          <span className={styles.sw} style={{ background: "var(--gold)" }} />
          누적 승률
        </span>
        {journey.probCoverage > 0 && (
          <span>
            <span className={styles.sw} style={{ background: "var(--gold)", clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />
            업셋 승리 {journey.upsetWins}회(경기 시작 시점 모델이 상대 우세로 본 경기)
          </span>
        )}
      </div>
    </div>
  );
}

// ── 로스터 기여도 - 출전시간 순 로스터(이 페이지의 로스터 목록을 겸함) ────────────────
function RosterPanel({ roster }: { roster: RosterRow[] }) {
  if (!roster.length) return <div className="empty-note">이 시즌 로스터 기록 없음</div>;
  const maxMinPg = Math.max(...roster.map((r) => r.minPg), 1);
  const hasWpa = roster.some((r) => r.totalWpa != null);
  return (
    <>
      <div className={styles.rosterGrid}>
        <div className={`${styles.rosterRow} ${styles.rosterHead}`}>
          <div>선수</div>
          <div>MIN/경기</div>
          <div className={`${styles.rosterCell} ${styles.rosterRpgHide}`}>GP</div>
          <div className={styles.rosterCell}>PPG</div>
          <div className={styles.rosterCell}>{hasWpa ? "WPA" : ""}</div>
        </div>
        {roster.map((r) => (
          <Link href={`/players/${r.pcode}`} className={styles.rosterRow} key={r.pcode}>
            <div className={styles.rosterName}>
              <span className={styles.rosterNameMain}>{r.name}</span>
              <span className={styles.rosterPos}>
                {r.backNum ? `#${r.backNum}` : ""} {r.pos ?? ""}
              </span>
            </div>
            <div className={styles.rosterBarTrack} title={`경기당 ${r.minPg.toFixed(1)}분`}>
              <div className={styles.rosterBarFill} style={{ width: `${(r.minPg / maxMinPg) * 100}%` }} />
            </div>
            <div className={`${styles.rosterCell} ${styles.rosterRpgHide}`}>{r.gp}</div>
            <div className={styles.rosterCell}>{r.ppg.toFixed(1)}</div>
            <div
              className={styles.rosterWpa}
              style={r.totalWpa != null ? { color: r.totalWpa >= 0 ? "var(--positive)" : "var(--negative)" } : undefined}
            >
              {r.totalWpa != null ? signed(r.totalWpa) : "-"}
            </div>
          </Link>
        ))}
      </div>
      <div className={styles.pctNote}>
        이 시즌 이 팀 소속으로 뛴 전 선수, 총 출전시간 순 · WPA = 시즌 승리 기여(플레이별 팀 승률 변화 누적, 집계 없는
        선수는 -) · 행 클릭 → 선수 프로필
      </div>
    </>
  );
}

// ── 베스트 유닛(15시즌 통산 lineup_combo를 이 시즌 로스터로 제한 - 캡션에 정직하게) ────
function BestUnitsPanel({ units }: { units: BestUnit[] }) {
  const pairs = units.filter((u) => u.n === 2);
  const fives = units.filter((u) => u.n === 5);
  if (!pairs.length && !fives.length) {
    return (
      <div className="empty-note">
        최소 출전시간(2인 {UNIT_MIN_MINUTES_2MAN}분 / 5인 {UNIT_MIN_MINUTES_5MAN}분)을 넘는 조합 없음
      </div>
    );
  }
  return (
    <>
      <div className={styles.unitGrid}>
        {pairs.map((u, i) => (
          <div className={styles.unitCard} key={u.pcodes.join(",")}>
            <div className={styles.unitLabel}>2인 조합 #{i + 1}</div>
            <div className={styles.unitNames}>{u.names.join(" · ")}</div>
            <div className={styles.unitSub}>
              <span style={{ color: u.netRatingPer40 >= 0 ? "var(--positive)" : "var(--negative)" }}>
                NET {signed(u.netRatingPer40)}
              </span>{" "}
              /40분 · 함께 {Math.round(u.minutes)}분
            </div>
          </div>
        ))}
        {fives.map((u, i) => (
          <div className={styles.unitCard} key={u.pcodes.join(",")}>
            <div className={styles.unitLabel}>5인 라인업 #{i + 1}</div>
            <div className={styles.unitNames}>{u.names.join(" · ")}</div>
            <div className={styles.unitSub}>
              <span style={{ color: u.netRatingPer40 >= 0 ? "var(--positive)" : "var(--negative)" }}>
                NET {signed(u.netRatingPer40)}
              </span>{" "}
              /40분 · 함께 {Math.round(u.minutes)}분
            </div>
          </div>
        ))}
      </div>
      <div className={styles.pctNote}>
        이 시즌 로스터 선수들만으로 구성된 조합 중 넷레이팅(/40분) 상위 · 넷레이팅·시간은 15시즌 통산 표본(라인업
        데이터에 시즌 구분이 없음 - 이번 시즌 한정 수치가 아님) · 최소 함께 뛴 시간: 2인 {UNIT_MIN_MINUTES_2MAN}분, 5인{" "}
        {UNIT_MIN_MINUTES_5MAN}분
      </div>
    </>
  );
}

// ── 슛 프로필 - 존 구성비(팀 vs 리그 평균) 페어드 바 ─────────────────────────────────
function ZoneProfilePanel({ zp, seasonName }: { zp: TeamZoneProfile | null; seasonName: string }) {
  if (!zp) return <div className="empty-note">이 시즌 슛 로그 없음</div>;
  const maxShare = Math.max(...zp.rows.map((r) => Math.max(r.teamShare, r.leagueShare)), 0.01);
  return (
    <>
      <div className={styles.zoneGrid}>
        {zp.rows.map((r) => {
          const deltaPp = (r.teamShare - r.leagueShare) * 100;
          return (
            <div className={styles.zoneRow} key={r.zone}>
              <div className={styles.zoneLabel}>{ZONE_LABELS[r.zone]}</div>
              <div className={styles.zoneBars}>
                <div className={styles.zoneBarTrack} title={`팀 ${(r.teamShare * 100).toFixed(1)}%`}>
                  <div className={styles.zoneBarTeam} style={{ width: `${(r.teamShare / maxShare) * 100}%` }} />
                </div>
                <div className={styles.zoneBarTrack} title={`리그 ${(r.leagueShare * 100).toFixed(1)}%`}>
                  <div className={styles.zoneBarLeague} style={{ width: `${(r.leagueShare / maxShare) * 100}%` }} />
                </div>
              </div>
              <div className={styles.zoneValue}>
                {(r.teamShare * 100).toFixed(1)}%{" "}
                <span
                  className={styles.zoneDelta}
                  style={{ color: Math.abs(deltaPp) < 0.05 ? "var(--ink-faint)" : deltaPp > 0 ? "var(--positive)" : "var(--negative)" }}
                >
                  {signed(deltaPp)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.journeyLegend}>
        <span>
          <span className={styles.sw} style={{ background: "var(--home)" }} />팀 슛 비중
        </span>
        <span>
          <span className={styles.sw} style={{ background: "var(--ink-faint)", opacity: 0.55 }} />
          리그 평균
        </span>
      </div>
      <div className={styles.pctNote}>
        {seasonName} 시즌 팀 슛 {zp.teamTotal.toLocaleString()}개 / 리그 전체 {zp.leagueTotal.toLocaleString()}개 기준 존별
        시도 비중 · 숫자 = 팀 비중, 색 = 리그 평균 대비 %p 차이(초록=더 많이, 빨강=더 적게 던짐 - 좋고 나쁨이 아니라
        스타일)
      </div>
    </>
  );
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ tcode: string }>;
  searchParams: Promise<{ season?: string }>;
}) {
  const { tcode } = await params;
  const { season } = await searchParams;
  const [team, seasons] = await Promise.all([getTeam(tcode), getSeasons()]);
  if (!team) notFound();

  const activeSeason = season ?? seasons[0];

  // 1차 병렬: 시즌만 정해지면 되는 조회 전부. 슛/프리게임 승률만 gmkey 목록(스케줄)이
  // 필요해 2차로(워터폴 1단).
  const [schedule, opponents, fourFactors, roster, units, zoneProfile, standings] = await Promise.all([
    getTeamSeasonSchedule(tcode, activeSeason),
    supabase.from("teams").select("tcode, name, abbr, color, logo_url").then((r) => r.data ?? []),
    getTeamFourFactors(tcode, activeSeason),
    getRosterContribution(tcode, activeSeason),
    getBestUnits(tcode, activeSeason),
    getTeamZoneProfile(tcode, activeSeason),
    getStandingsAsOf(activeSeason, "9999-12-31"),
  ]);
  const gmkeys = schedule.map((g) => g.gmkey);
  const [shots, homeProbs] = await Promise.all([getTeamSeasonShots(tcode, gmkeys), getPregameProbs(gmkeys)]);

  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 보고 있는 activeSeason 기준으로
  // 표시 이름만 덮어씀(기존 페이지 로직 유지).
  const oppByTcode = new Map(
    opponents.map((t) => [t.tcode, { ...t, name: displayTeamName(t.tcode, t.name, activeSeason) }])
  );
  const teamName = displayTeamName(team.tcode, team.name, activeSeason);

  const journey = buildSeasonJourney(schedule, homeProbs);
  const constellationSvg = shots.length ? buildConstellationSvg(shots) : null;

  // 히어로 헤드라인: 정규시즌 기준 순위/전적(스탠딩과 단위 일치), 없으면 전체 일정 전적 폴백.
  const standingIdx = standings.findIndex((s) => s.tcode === tcode);
  const standingRow = standingIdx >= 0 ? standings[standingIdx] : null;
  const allWins = schedule.filter((g) => g.teamScore > g.oppScore).length;
  const record = standingRow ? `${standingRow.wins}-${standingRow.losses}` : schedule.length ? `${allWins}-${schedule.length - allWins}` : "-";

  return (
    <div className={`wrap ${styles.pageRoot}`}>
      <Link href="/" className="back-link">
        ← 경기 목록
      </Link>

      {/* ── 히어로: 이 시즌 팀 슛 전체의 별자리 포스터(위임적 다크) ── */}
      <section className={styles.hero} style={{ "--hero-team": team.color } as CSSProperties}>
        {constellationSvg && (
          <svg
            className={styles.heroArt}
            viewBox="345 27 375 357"
            preserveAspectRatio="xMidYMid slice"
            aria-hidden
            dangerouslySetInnerHTML={{ __html: constellationSvg }}
          />
        )}
        <div className={styles.heroScrim} />
        <div className={styles.heroAbbr}>{team.abbr}</div>
        <div className={styles.heroContent}>
          <div className={styles.heroKicker}>COURTSIDE TEAM PROFILE</div>
          <h1 className={styles.heroName}>{teamName}</h1>
          <div className={styles.heroMeta}>
            <TeamBadge team={{ name: teamName, abbr: team.abbr, color: team.color, logoUrl: team.logo_url }} size={22} />
            <span>{activeSeason} 시즌</span>
            <span className={styles.heroMetaDot}>·</span>
            <span>{schedule.length}경기</span>
            {shots.length > 0 && (
              <>
                <span className={styles.heroMetaDot}>·</span>
                <span>슛 {shots.length.toLocaleString()}개의 별자리</span>
              </>
            )}
          </div>
          <div className={styles.heroStatRow}>
            {(
              [
                ["W-L", record, standingRow ? "정규시즌" : "전체"],
                ["RANK", standingRow ? `${standingIdx + 1}` : "-", standingRow ? `/ ${standings.length}팀` : "정규시즌"],
                ["PPG", fourFactors ? fourFactors.ptsPg.toFixed(1) : "-", "득점"],
                ["OPP", fourFactors ? fourFactors.oppPtsPg.toFixed(1) : "-", "실점"],
                ["NET", fourFactors ? signed(fourFactors.netRtg) : "-", "100포제션당"],
              ] as const
            ).map(([label, val, sub]) => (
              <div key={label}>
                <div className={styles.heroStatVal}>{val}</div>
                <div className={styles.heroStatLabel}>
                  {label} · {sub}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 시즌 셀렉터(기존 기능 유지 - ?season= 쿼리 파라미터 관례) */}
      <form className={styles.seasonForm}>
        <select name="season" defaultValue={activeSeason} className={styles.seasonSelect}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <button type="submit" className="btn-primary">
          시즌 보기
        </button>
      </form>

      {/* ── 1. 4팩터 vs 리그 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>4팩터 vs 리그 · {activeSeason}</div>
        <FourFactorsPanel ff={fourFactors} seasonName={activeSeason} />
      </div>

      {/* ── 2. 시즌 여정 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>시즌 여정 · 경기별 점수차와 누적 승률</div>
        <JourneyChart journey={journey} teamColor={team.color} />
        <div className={styles.pctNote}>
          막대 하나 = 한 경기(정규시즌+플레이오프, 날짜순), 높이 = 점수차 · 막대 클릭 → 경기 상세 · 업셋 = 경기 시작
          시점 승률 모델이 이 팀을 열세로 본 경기의 승리
          {journey.probCoverage < journey.games.length
            ? ` (모델 승률 있는 경기 ${journey.probCoverage}/${journey.games.length})`
            : ""}
        </div>
      </div>

      {/* ── 3. 로스터 기여도 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>로스터 기여도 · {activeSeason}</div>
        <RosterPanel roster={roster} />
      </div>

      {/* ── 4. 베스트 유닛 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>베스트 유닛 · 이 시즌 로스터 조합</div>
        <BestUnitsPanel units={units} />
      </div>

      {/* ── 5. 슛 프로필 ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>슛 프로필 · 존 구성비 vs 리그</div>
        <ZoneProfilePanel zp={zoneProfile} seasonName={activeSeason} />
      </div>

      {/* ── 6. 전체 일정(기존 페이지의 핵심 기능 - 그대로 유지) ── */}
      <div className={styles.panel}>
        <div className={styles.panelTitle}>
          {activeSeason} 시즌 전체 일정 ({schedule.length}경기)
        </div>
        {schedule.length === 0 ? (
          <div className="empty-note">이 시즌 경기 데이터 없음</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>구분</th>
                  <th>상대</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {schedule.map((g) => {
                  const opp = oppByTcode.get(g.oppTcode);
                  const won = g.teamScore > g.oppScore;
                  return (
                    <tr key={g.gmkey}>
                      <td>
                        <Link href={`/games/${g.gmkey}`}>{fmtDate(g.gameDate)}</Link>
                      </td>
                      <td>{g.seasonCategory}</td>
                      <td className={styles.schedOppCell}>
                        {g.isHome ? "vs" : "@"}
                        <TeamBadge team={opp ? { ...opp, logoUrl: opp.logo_url } : null} size={16} />
                        {opp?.name ?? g.oppTcode}
                      </td>
                      <td>
                        <span className={`sched-result ${won ? "win" : "loss"}`}>{won ? "W" : "L"}</span> {g.teamScore}-
                        {g.oppScore}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <footer className="foot">
        {teamName} · {activeSeason} 시즌 · Supabase에서 실시간 조회
      </footer>
    </div>
  );
}
