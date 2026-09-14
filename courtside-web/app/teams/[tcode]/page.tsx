import Link from "next/link";
import type { Metadata } from "next";
import { PlayerPhoto } from "@/components/PlayerPhoto";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import { supabaseServer as supabase } from "@/lib/supabaseServer";
import { TeamBadge } from "@/components/TeamBadge";
import { getTeamPlayedRegCount, type TeamFixture, type StandingsRow } from "@/lib/matchups";
import { getAllTeams } from "@/lib/playerProfile";
import { displayTeamName } from "@/lib/teamNames";
import { buildConstellationSvg } from "@/lib/playerDataScience";
import {
  getTeamSeasonShots,
  getTeamFourFactors,
  getPregameProbs,
  getRosterContribution,
  getBestUnits,
  getTeamZoneProfile,
  UNIT_MIN_MINUTES_2MAN,
  UNIT_MIN_MINUTES_5MAN,
  ZONE_LABELS,
  type TeamFourFactors,
  type RosterRow,
  type BestUnit,
  type TeamZoneProfile,
} from "@/lib/teamDataScience";
import {
  getTeamSeasonStats,
  getTeamLeaders,
  type TeamStatKey,
  type TeamSeasonStats,
  type TeamSeasonStatRow,
  type TeamStatCell,
  type TeamLeaders,
} from "@/lib/teamSeasonStats";
import styles from "./team-profile.module.css";
import { ChangeLine } from "@/components/RosterChangeLine";
import pre from "@/app/preseason/preseason.module.css";
import { getTeamRosterChanges, daysUntilKst, PREGAME_MODEL_CAPTION, type TeamRosterChanges } from "@/lib/preseason";
import {
  PRESEASON_SEASON,
  resolveTeamSeasons,
  statSeasonChip,
  progressChip,
  basisChip,
  isPastSeason,
  seasonShort,
  type SeasonFocus,
} from "@/lib/seasonFocus";
import { buildSeasonRibbonSvg, RIBBON_VIEWBOX, type RibbonSlot } from "@/lib/seasonRibbon";
import {
  getGameTags,
  getPregameFeatures,
  getTeamLastPlayedSeason,
  getTeamSeasonFixturesCached,
  getStandingsAsOfCached,
  splitFixtures,
  teamSideProb,
  fmtStart,
  GAME_TAG_LABELS,
  type GameTag,
} from "@/lib/teamPageData";
import { accentFor, teamInkPair } from "@/lib/teamAccent";
import { normalizePos } from "@/lib/playerStatus";

// 팀 프로필 "데이터 사이언스 + 데이터로 아름다움" 대개편(요청) - 선수 프로필과 같은 디자인
// 언어: 히어로 배경 아트 = 이 팀의 이 시즌 슛 전체를 팀 컬러 별자리로(선수판은 커리어,
// 팀판은 시즌 - 시즌 셀렉터가 있는 페이지라 시즌 단위가 서사에 맞음). 기존의 얇은 시즌
// 스케줄 페이지가 갖고 있던 기능(시즌 셀렉터/전체 일정 표/경기 링크)은 전부 하단에 유지.
//
// 시즌 판정(1단계 개편): seasons[0]을 직접 읽던 기존 코드는 개막 전(2026-09) 기준으로
// "경기 0개인 2026-2027"을 모든 패널에 먹여 페이지 전체를 빈 안내문으로 만들었다. 이제
// lib/seasonFocus.ts resolveTeamSeasons 하나가 두 시즌을 정한다.
//   factSeason(사실: 일정·리본·전적·별자리) = focusSeason(현역 팀이면 2026-2027)
//   estSeason(추정: 4팩터·존 구성비·로스터 기여도) = statSeason(정규 5경기 임계 전이면 25-26)
// ?season=로 과거 시즌을 직접 고르면 두 시즌 모두 그 시즌이 된다(결과 중심 보기).

// 캐시 미스가 겹치면(RPC 4종 + 시즌 기록표 1.1초 + 슛 수천 행) 기본 함수 시간 한도를 넘길 수
// 있다. /preseason과 같은 값 - 캐시 히트에서는 훨씬 빨리 끝나고, 이 값은 상한일 뿐이다.
export const maxDuration = 60;

export async function generateMetadata({ params }: { params: Promise<{ tcode: string }> }): Promise<Metadata> {
  const team = (await getAllTeams()).get((await params).tcode); // 캐시된 팀 표 - 페이지 조회를 늘리지 않는다
  if (!team) return {};
  return {
    title: team.name,
    description: `${team.name} 팀 프로필 · 시즌 전망, 로스터 변화, 팀 DNA, 경기 일정`,
  };
}

type TeamInfo ={ tcode: string; name: string; abbr: string; color: string; logo_url: string | null };

/**
 * 2·3차 파도의 추정 패널(4팩터·존 구성비·로스터 기여도·베스트 유닛·기록표·리더·순위표·리본
 * 재료)은 하나가 실패해도 페이지 본체(팀 존재·시즌 목록·일정)를 끌고 죽지 않는다 - 그 패널만
 * 빈 상태("이 시즌 ... 없음")로 그린다. 단, 조용히 삼키지 않는다: 반드시 console.error로
 * 남긴다(감사 2026-09-06: "soft 폴백은 선택적 패널에만, 본체는 그대로 throw").
 */
function soft<T>(tcode: string, what: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e: unknown) => {
    console.error(`[teams/${tcode}] ${what} 조회 실패 - 해당 패널만 비움:`, e);
    return fallback;
  });
}

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
  // 반올림한 뒤 부호를 정한다 - 그러지 않으면 -0.04가 "-0.0"으로 찍혀서, 사실상 리그 평균인
  // 값이 음수인 것처럼 읽힌다(존 구성비 패널에서 실제로 나왔던 표시).
  const r = Number(v.toFixed(decimals));
  const safe = Object.is(r, -0) ? 0 : r;
  return `${safe > 0 ? "+" : ""}${safe.toFixed(decimals)}`;
}

// 패널 제목 + 기준 시즌 칩. 칩 문구는 전부 lib/seasonFocus.ts에서 만들어 페이지마다 다른
// 표현이 생기지 않게 한다(shared_design_language (2)).
function PanelTitle({ title, chips = [] }: { title: string; chips?: (string | null)[] }) {
  const shown = chips.filter((c): c is string => !!c);
  return (
    <div className={styles.panelTitle}>
      <span>{title}</span>
      {shown.map((c) => (
        <span className={styles.basisChip} key={c}>
          {c}
        </span>
      ))}
    </div>
  );
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
            <div className={`${styles.pctRow} ${styles.barHeadRow}`} aria-hidden="true">
              <div />
              <div className={styles.barScale}>
                <span>리그 중간</span>
              </div>
              <div className={styles.barHeadRight}>값 (리그 평균)</div>
              <div className={styles.barHeadRight}>순위</div>
            </div>
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
                  {/* 한글 "위"는 본문 서체 span으로 분리 - Big Shoulders Display에 한글
                      글리프가 없어 같은 요소에 넣으면 폴백 이음매가 생긴다(css .rankSuffix). */}
                  <div className={styles.pctNum} style={{ color: percentileColor(a.pctFill) }}>
                    {a.rank}
                    <span className={styles.rankSuffix}>위</span>
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

// ── 팀 리더 5장(득점/리바운드/어시스트/스틸/블록) ──────────────────────────────────
//    요청("팀 리더 추가")의 참고 화면(NBA 팀 페이지 Team Leaders 줄)과 같은 구성이지만
//    사진이 있는 선수가 773명 중 31명뿐이라 등번호 타일 폴백이 사실상 기본 상태다 -
//    /players 디렉터리(components/Directory.module.css)와 같은 원형·같은 폰트로 맞춰서
//    "이미지 로딩 실패"로 읽히지 않게 한다.
function TeamLeadersPanel({ tl }: { tl: TeamLeaders | null }) {
  if (!tl) return <div className="empty-note">이 시즌 정규시즌 선수 기록 없음</div>;
  return (
    <>
      <div className={styles.leaderGrid}>
        {tl.leaders.map((l) => (
          <Link
            href={l.href}
            key={l.key}
            className={styles.leaderCard}
            title={`${l.name} · ${tl.seasonName} 정규시즌 ${l.label} ${l.display} ${l.unit} · ${l.gp}경기 합계 ${Math.round(l.total).toLocaleString()}`}
          >
            <div className={styles.leaderCat}>{l.label}</div>
            <div className={styles.leaderWho}>
              {l.photoUrl ? (
                <PlayerPhoto src={l.photoUrl} size={38} className={styles.leaderPhoto} />
              ) : (
                <div className={styles.leaderFallback}>{l.backNum ?? "·"}</div>
              )}
              <div className={styles.leaderNameCell}>
                <div className={styles.leaderName}>{l.name}</div>
                {/* pos는 DB 원문(FD/GD)이 아니라 lib가 정규화해 준 posLabel(가드/포워드/센터)만 */}
                <div className={styles.leaderPos}>
                  {[l.backNum ? `#${l.backNum}` : null, l.posLabel || null].filter(Boolean).join(" · ")}
                </div>
              </div>
            </div>
            {/* 카드에서 가장 큰 요소 = 경기당 수치(요청: "big per-game number"). 팀 1위라는
                사실만 담은 값이라 좋고나쁨 색은 쓰지 않는다. */}
            <div className={styles.leaderValRow}>
              <span className={styles.leaderVal}>{l.display}</span>
              <span className={styles.leaderUnit}>{l.unit}</span>
            </div>
            <div className={styles.leaderSub}>
              {l.gp}경기 · 합계 {Math.round(l.total).toLocaleString()}
              {l.runnerUp ? (
                <>
                  <br />2위 {l.runnerUp.name} {l.runnerUp.display}
                </>
              ) : null}
            </div>
          </Link>
        ))}
      </div>
      <div className={styles.pctNote}>
        {tl.caption} · 카드 클릭 → 선수 프로필
      </div>
    </>
  );
}

// ── 팀 전체 기록 · 리그 순위 ────────────────────────────────────────────────────────
// 요청은 "공격 / 수비 / 템포·기타" 3분할이고, lib/teamSeasonStats.ts의 TeamStatGroup
// (종합/슈팅/리바운드/소유/수비)은 산식 계보에 따른 분류라 목적이 다르다. 그래서 화면
// 분할만 여기서 따로 정의한다 - 값·순위·리그평균·포맷은 전부 lib 셀을 그대로 쓰고
// 이 페이지에서 다시 계산하는 숫자는 하나도 없다.
const RANK_SECTIONS: { title: string; keys: TeamStatKey[] }[] = [
  {
    title: "OFFENSE - 우리 공격",
    keys: ["pts", "ortg", "efg", "ts", "twoPct", "tpPct", "ftPct", "ftr", "ast", "astPct", "orebPct", "tov", "tovPct"],
  },
  { title: "DEFENSE - 우리 수비", keys: ["oppPts", "drtg", "drebPct", "stl", "blk", "fouls"] },
  { title: "TEMPO & OVERALL - 템포·기타", keys: ["net", "diff", "pace", "tpaPg", "reb"] },
];

function RankRow({ c }: { c: TeamStatCell }) {
  // 방향 보정은 lib이 끝냈다(rank·pctFill 모두 lowerIsBetter 반영). 여기서 "높을수록 좋다"를
  // 가정하는 코드는 한 줄도 없어야 한다. neutral(페이스·3점 시도)은 좋고나쁨 색을 쓰지 않는다.
  const color = c.neutral ? "var(--ink-soft)" : percentileColor(c.pctFill);
  const title =
    `${c.label} ${c.display} · 리그 평균 ${c.leagueAvgDisplay} (${c.vsLeagueDisplay}) · ${c.rankLabel}` +
    (c.neutral ? " · 방향 없는 스타일 지표" : c.lowerIsBetter ? " · 낮을수록 좋음" : "") +
    (c.note ? ` · ${c.note}` : "");
  return (
    <div className={styles.rankRow} title={title}>
      <div className={styles.rankLabel}>{c.label}</div>
      <div className={styles.rankTrack}>
        <div
          className={styles.rankFill}
          style={{ width: `${Math.max(c.pctFill, 3)}%`, background: c.neutral ? "var(--ink-faint)" : percentileColor(c.pctFill) }}
        />
        <div className={styles.rankMid} />
      </div>
      <div className={styles.rankValue}>{c.display}</div>
      <div className={styles.rankAvg}>{c.leagueAvgDisplay}</div>
      {/* 4팩터 패널과 같은 처리 - 숫자만 Big Shoulders, 한글 "위"는 Pretendard span. */}
      <div className={styles.rankNum} style={{ color }}>
        {c.rank}
        <span className={styles.rankSuffix}>위</span>
      </div>
    </div>
  );
}

function TeamRankPanel({ stats, row }: { stats: TeamSeasonStats | null; row: TeamSeasonStatRow | null }) {
  if (!stats || !row) return <div className="empty-note">이 시즌 정규시즌 팀 집계 없음</div>;
  // lib에 지표가 추가돼도 화면에서 조용히 사라지지 않게, 3분할에 배정되지 않은 지표는
  // 마지막 섹션에 그대로 붙인다.
  const used = new Set<TeamStatKey>(RANK_SECTIONS.flatMap((s) => s.keys));
  const leftovers = row.cells.filter((c) => !used.has(c.key));
  const sections = RANK_SECTIONS.map((s, i) => ({
    title: s.title,
    cells: [
      ...s.keys.map((k) => row.cellByKey[k]).filter((c): c is TeamStatCell => !!c),
      ...(i === RANK_SECTIONS.length - 1 ? leftovers : []),
    ],
  })).filter((s) => s.cells.length > 0);

  return (
    <>
      {sections.map((s) => (
        <div key={s.title}>
          <div className={styles.rankGroupTitle}>{s.title}</div>
          <div className={styles.rankGrid}>
            <div className={`${styles.rankRow} ${styles.rankHead}`}>
              <div>지표</div>
              {/* 바 칸은 머리글을 비운다 - 요청한 컬럼은 지표/값/리그 평균/순위 네 개이고,
                  바는 그 순위를 눈으로 읽게 하는 보조 장치라 캡션에서 한 번만 설명한다
                  (좁은 화면에서 머리글이 두 줄로 접혀 행 높이가 흔들리는 문제도 함께 해결). */}
              {/* 바 칸 머리 = 가운데 눈금의 뜻 하나만(선수 퍼센타일 막대와 같은 언어). */}
              <div className={styles.barScale}>
                <span>리그 중간</span>
              </div>
              <div className={styles.rankHeadRight}>값</div>
              <div className={styles.rankHeadRight}>리그 평균</div>
              <div className={styles.rankHeadRight}>순위</div>
            </div>
            {s.cells.map((c) => (
              <RankRow c={c} key={c.key} />
            ))}
          </div>
        </div>
      ))}
      <div className={styles.pctNote}>
        {stats.caption} · 이 팀 {row.gp}경기 {row.wins}승 {row.losses}패 · 바 길이 = 방향 보정 후 리그 내 위치(1위가 가장 김,
        가운데 눈금 = 리그 중간) · 마우스를 올리면 지표별 산식과 리그 평균 대비 차이 · 2P%는 이 DB의 fga/fgm이 2점
        전용이라 총 야투율이 아님(3점은 3P%로 따로) · OREB%/DREB%는 원시 리바운드 개수가 결측이라 경기별 비율의 평균
        · TOV%는 턴오버/포제션으로 위 4팩터 패널과 같은 분모(테이블의 tov_pct 컬럼값과는 다름)
      </div>
    </>
  );
}

// ── 로스터 기여도 - 출전시간 순 로스터(이 페이지의 로스터 목록을 겸함) ────────────────
function RosterPanel({ roster, accent }: { roster: RosterRow[]; accent: string }) {
  if (!roster.length) return <div className="empty-note">이 시즌 로스터 기록 없음</div>;
  const maxMinPg = Math.max(...roster.map((r) => r.minPg), 1);
  const hasWpa = roster.some((r) => r.totalWpa != null);
  // 요청: "높은 사람에게 색상 표시". 상위 3명만 - 전원에 색을 주면 색이 정보를 잃는다.
  // 동점이면 같이 들어간다(3명을 넘을 수 있다).
  const wpaValues = roster.map((r) => r.totalWpa).filter((v): v is number => v != null);
  const wpaCut = wpaValues.length > 3 ? [...wpaValues].sort((a, b) => b - a)[2] : null;
  const ink = teamInkPair(accent);
  return (
    <>
      <div className={styles.rosterGrid}>
        <div className={`${styles.rosterRow} ${styles.rosterHead}`}>
          <div>선수</div>
          <div>MIN/경기</div>
          <div className={`${styles.rosterCell} ${styles.rosterRpgHide}`}>GP</div>
          <div className={styles.rosterCell}>PPG</div>
          {/* 요청: "WPA를 사람들이 잘 모를 것 같다". 머리글은 우리말로, 정의는 아래 캡션에서. */}
          <div className={styles.rosterCell}>{hasWpa ? "승리기여" : ""}</div>
        </div>
        {roster.map((r) => (
          <Link href={`/players/${r.pcode}`} className={styles.rosterRow} key={r.pcode}>
            <div className={styles.rosterName}>
              <span className={styles.rosterNameMain}>{r.name}</span>
              {/* game_player_stats.pos는 원문 코드(FD/GD)라 그대로 찍으면 사용자에게 노출된다 -
                  선수 프로필과 같은 normalizePos로 G/F/C만 보여준다(검증 지적). */}
              <span className={styles.rosterPos}>
                {r.backNum ? `#${r.backNum}` : ""} {normalizePos(r.pos) ?? ""}
              </span>
            </div>
            {/* 막대는 팀 색으로(요청: "그래프 색상 팀에 맞게"). 원색을 그대로 쓰면 어두운 팀 색이
                다크 모드 트랙에 묻히므로 lib/teamAccent.ts의 대비 보정 쌍을 쓴다. */}
            <div className={styles.rosterBarTrack} title={`경기당 ${r.minPg.toFixed(1)}분`}>
              <div
                className={styles.rosterBarFill}
                style={{ width: `${(r.minPg / maxMinPg) * 100}%`, ["--ti-l"]: ink.light, ["--ti-d"]: ink.dark } as React.CSSProperties}
              />
            </div>
            <div className={`${styles.rosterCell} ${styles.rosterRpgHide}`}>{r.gp}</div>
            <div className={styles.rosterCell}>{r.ppg.toFixed(1)}</div>
            {/* 부호 색(양수 초록 / 음수 빨강)은 여전히 쓰지 않는다 - player_season_wpa 2,591행 중
                음수가 32행뿐이고 최솟값이 -0.057이라 빨간 분기가 사실상 발화하지 않는다. 늘 초록인
                색은 정보를 안 담으면서 인코딩처럼 보이는 가짜 신호다(실측 지적).
                대신 **팀 안에서 상위 3명**만 팀 색으로 —— 이건 실제로 구분이 되는 신호다. */}
            <div
              className={`${styles.rosterWpa} ${wpaCut != null && r.totalWpa != null && r.totalWpa >= wpaCut ? styles.rosterWpaTop : ""}`}
              style={{ ["--ti-l"]: ink.light, ["--ti-d"]: ink.dark } as React.CSSProperties}
            >
              {r.totalWpa != null ? signed(r.totalWpa) : "-"}
            </div>
          </Link>
        ))}
      </div>
      <div className={styles.pctNote}>
        이 시즌 이 팀 소속으로 뛴 전 선수, 총 출전시간 순 · <b>승리기여</b>(WPA) = 그 선수의 플레이가 팀 승률을
        올린 양을 시즌 내내 더한 값 —— 예를 들어 +2.5는 &quot;혼자서 2.5승어치를 만들었다&quot;로 읽으면 된다(집계 없는
        선수는 -) · 팀 색으로 표시된 상위 3명이 이 팀을 이기게 만든 선수다 · 행 클릭 → 선수 프로필
      </div>
    </>
  );
}

/**
 * 승률과 실제 결과를 **같은 색 언어**로 묶는다(요청: "승률별 색상, 그리고 실제 결과도 색상이 동일하도록").
 * 예전에는 예정 경기의 모델 승률에 색이 아예 없었고, 실제 W/L은 --home(주황)/--away(파랑)이라
 * "홈/원정" 팔레트를 결과에 잘못 빌려 쓰고 있었다 - 주황이 승리를 뜻하는지 홈을 뜻하는지 알 수 없었다.
 * 이제 둘 다 승리 가능성 축(초록 ↔ 빨강) 하나만 쓴다. 실제 결과는 그 축의 양 끝(승=1, 패=0)이다.
 */
function outcomeTone(p: number): { color: string; weight: number } {
  if (p >= 0.65) return { color: "var(--positive)", weight: 800 };
  if (p >= 0.55) return { color: "var(--positive)", weight: 700 };
  if (p > 0.45) return { color: "var(--ink-soft)", weight: 700 };
  if (p > 0.35) return { color: "var(--negative)", weight: 700 };
  return { color: "var(--negative)", weight: 800 };
}

// ── 베스트 유닛(15시즌 통산 lineup_combo를 이 시즌 로스터로 제한 - 캡션에 정직하게) ────
function BestUnitsPanel({ units, tcode, season }: { units: BestUnit[]; tcode: string; season: string }) {
  const pairs = units.filter((u) => u.n === 2);
  const fives = units.filter((u) => u.n === 5);
  // 조합이 하나도 없어도 "선수별 조합" 링크는 남긴다 - 이 패널은 통산 라인업 표본이고,
  // /lineups는 시즌 표본(주인공 ON + 동료 ON/OFF)이라 여기서 빈 팀도 저쪽엔 있을 수 있다.
  const wowyLink = (
    <Link className={styles.panelLink} href={`/lineups?team=${tcode}&season=${season}`}>
      이 팀의 선수별 조합 자세히 보기 →
    </Link>
  );
  if (!pairs.length && !fives.length) {
    return (
      <>
        <div className="empty-note">
          최소 출전시간(2인 {UNIT_MIN_MINUTES_2MAN}분 / 5인 {UNIT_MIN_MINUTES_5MAN}분)을 넘는 조합 없음
        </div>
        {wowyLink}
      </>
    );
  }
  return (
    <>
      <div className={styles.unitGrid}>
        {pairs.map((u, i) => (
          <div className={styles.unitCard} key={u.pcodes.join(",")}>
            <div className={styles.unitTop}>
              <span className={styles.unitLabel}>2인 조합 #{i + 1}</span>
              {/* 이 카드의 주장은 넷레이팅이다. 예전에는 이름이 13.5px/700이고 NET이 11px 모노 안의
                  인라인 span이라 위계가 뒤집혀 있었다(제보: "표는 정갈한데 눈에 안 들어옴"). */}
              <span
                className={styles.unitNet}
                style={{ color: u.netRatingPer40 >= 0 ? "var(--positive)" : "var(--negative)" }}
              >
                {signed(u.netRatingPer40)}
              </span>
            </div>
            <div className={styles.unitNames}>{u.names.join(" · ")}</div>
            <div className={styles.unitSub}>
              40분당 득실 · 함께 {Math.round(u.minutes)}분
            </div>
          </div>
        ))}
        {fives.map((u, i) => (
          <div className={styles.unitCard} key={u.pcodes.join(",")}>
            <div className={styles.unitTop}>
              <span className={styles.unitLabel}>5인 라인업 #{i + 1}</span>
              {/* 이 카드의 주장은 넷레이팅이다. 예전에는 이름이 13.5px/700이고 NET이 11px 모노 안의
                  인라인 span이라 위계가 뒤집혀 있었다(제보: "표는 정갈한데 눈에 안 들어옴"). */}
              <span
                className={styles.unitNet}
                style={{ color: u.netRatingPer40 >= 0 ? "var(--positive)" : "var(--negative)" }}
              >
                {signed(u.netRatingPer40)}
              </span>
            </div>
            <div className={styles.unitNames}>{u.names.join(" · ")}</div>
            <div className={styles.unitSub}>
              40분당 득실 · 함께 {Math.round(u.minutes)}분
            </div>
          </div>
        ))}
      </div>
      <div className={styles.pctNote}>
        이 시즌 로스터 선수들만으로 구성된 조합 중 넷레이팅(/40분) 상위 · 넷레이팅·시간은 15시즌 통산 표본(라인업
        데이터에 시즌 구분이 없음 - 이번 시즌 한정 수치가 아님) · 최소 함께 뛴 시간: 2인 {UNIT_MIN_MINUTES_2MAN}분, 5인{" "}
        {UNIT_MIN_MINUTES_5MAN}분
      </div>
      {wowyLink}
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

// ── 0. 로스터 변화(개막 전) - roster_changes(tools/build_roster_changes.py)에 이 시즌·이 팀 행이
//    있을 때만 렌더(과거 시즌·로스터 미수신 시즌은 null이라 아무것도 안 나옴). 한 줄 렌더는
//    /preseason과 같은 컴포넌트(components/RosterChangeLine.tsx)를 써서 표기가 갈라지지 않게.
function RosterChangesPanel({ rc, abbrOf }: { rc: TeamRosterChanges; abbrOf: (tcode: string | null) => string | null }) {
  const changed = [...rc.in, ...rc.back, ...rc.new, ...rc.out];
  if (!changed.length && !rc.stay.length) return null;
  return (
    <div className={styles.panel}>
      <div className={styles.panelTitle}>
        이번 시즌 로스터 변화 · 영입 {rc.in.length} · 복귀 {rc.back.length} · 신입 {rc.new.length} · 잔류 {rc.stay.length} · 이탈{" "}
        {rc.out.length}
      </div>
      {changed.map((r) => (
        <ChangeLine key={`${r.change}-${r.name}`} r={r} abbrOf={abbrOf} />
      ))}
      {changed.length === 0 && <div className={styles.pctNote}>영입·이탈 없음</div>}
      {rc.stay.length > 0 && (
        <details className={pre.stayDetails}>
          <summary className={pre.staySummary}>잔류 {rc.stay.length}명 보기</summary>
          {rc.stay.map((r) => (
            <ChangeLine key={`stay-${r.name}`} r={r} abbrOf={abbrOf} />
          ))}
        </details>
      )}
      <div className={styles.pctNote}>
        확정 로스터를 지난 시즌 출전 기록과 대조한 결과 · 성적은 그 선수의 마지막 KBL 시즌 정규+플레이오프 합산 평균(위 시즌 여정·4팩터는 이 시즌 기준이라
        분모가 다름) · 국내 선수 로스터가 들어오면 자동 반영 ·{" "}
        <Link href="/preseason">리그 전체 이동 지도와 시즌 전망 →</Link>
      </div>
    </div>
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

  // 1차: 시즌 판정에 필요한 것만(팀 존재 여부, 시즌 목록, 확정 명단 시즌의 치른 정규 경기 수,
  // 확정 명단 보유 여부 = 현역 팀 게이트, 해체 팀의 마지막 시즌).
  const [team, seasons, playedRegInPreseason, preseasonChanges, lastPlayedSeason] = await Promise.all([
    getTeam(tcode),
    getSeasons(),
    getTeamPlayedRegCount(tcode, PRESEASON_SEASON),
    getTeamRosterChanges(PRESEASON_SEASON, tcode),
    getTeamLastPlayedSeason(tcode),
  ]);
  if (!team) notFound();

  // 현역 팀 = 확정 명단(roster_changes) 행이 있는 팀. 해체된 옛 팀코드는 마지막 시즌이 곧 focus.
  const isActiveTeam = preseasonChanges != null;
  const focus: SeasonFocus = resolveTeamSeasons(tcode, playedRegInPreseason, isActiveTeam, lastPlayedSeason);

  // ?season=은 존재하는 시즌만 받는다(오타·조작 쿼리로 전 패널이 비지 않도록).
  const requested = season && seasons.includes(season) ? season : null;
  const pastPick = requested != null && isPastSeason(requested);
  // 사실 패널(일정·리본·별자리·전적) 시즌 / 추정 패널(4팩터·존·로스터 기여도) 시즌.
  const factSeason = requested ?? focus.focusSeason;
  const estSeason = pastPick ? requested : (focus.statSeason ?? focus.focusSeason);
  // 과거 시즌을 직접 고른 경우엔 그 시즌이 곧 기준이므로 focus 기반 칩 대신 '18-19 최종'.
  const basis = pastPick ? basisChip("final", { season: requested }) : statSeasonChip(focus);
  const progress = pastPick ? null : progressChip(focus);

  // 2차 병렬: 사실은 factSeason, 추정은 estSeason. 두 시즌이 다르면 지난 시즌 일정도 함께
  // 가져온다(개막 전 히어로 전적·별자리의 폴백 표본).
  // 팀 기록표(getTeamSeasonStats)는 리그 10팀 전체를 집계해야 순위가 나오므로 팀 하나가 아니라
  // 시즌 하나를 받는다(1.1초). 팀 행은 byTcode에서 꺼내 쓴다.
  // 일정(fixtures/prevFixtures)은 페이지 본체라 그대로 throw. 나머지는 soft(패널만 비움 + console.error).
  // 일정·순위표·RPC·슛은 캐시 판(lib/teamPageData.ts, lib/teamDataScience.ts - TTL.batchDaily).
  const [
    fixtures,
    prevFixtures,
    opponents,
    fourFactors,
    roster,
    units,
    zoneProfile,
    standingsFact,
    standingsEst,
    rosterChanges,
    seasonStats,
    teamLeaders,
  ] = await Promise.all([
      getTeamSeasonFixturesCached(tcode, factSeason),
      estSeason !== factSeason ? getTeamSeasonFixturesCached(tcode, estSeason) : Promise.resolve<TeamFixture[]>([]),
      // teams 13행은 준-상수 - 모든 페이지가 쓰는 getAllTeams(TTL.reference) 하나로 공유. 실패해도
      // 일정 행이 oppName/oppTcode를 갖고 있어 이름·배지만 폴백된다.
      soft(tcode, "teams", getAllTeams(), new Map()),
      soft(tcode, "fourFactors", getTeamFourFactors(tcode, estSeason), null),
      soft(tcode, "rosterContribution", getRosterContribution(tcode, estSeason), []),
      soft(tcode, "bestUnits", getBestUnits(tcode, estSeason), []),
      soft(tcode, "zoneProfile", getTeamZoneProfile(tcode, estSeason), null),
      // 순위표가 비면 히어로 W-L/RANK는 일정에서 센 전적으로 폴백한다(아래 record 계산).
      soft(tcode, "standings", getStandingsAsOfCached(factSeason, "9999-12-31"), []),
      estSeason !== factSeason
        ? soft(tcode, "standings(est)", getStandingsAsOfCached(estSeason, "9999-12-31"), [])
        : Promise.resolve<StandingsRow[]>([]),
      factSeason === PRESEASON_SEASON
        ? Promise.resolve(preseasonChanges)
        : soft(tcode, "rosterChanges", getTeamRosterChanges(factSeason, tcode), null),
      soft(tcode, "seasonStats", getTeamSeasonStats(estSeason), null),
      soft(tcode, "teamLeaders", getTeamLeaders(tcode, estSeason), null),
    ]);
  const statRow = seasonStats?.byTcode[tcode] ?? null;

  const { played, next, lastDate } = splitFixtures(fixtures);
  const playedGmkeys = played.map((f) => f.gmkey);
  const pendingGmkeys = fixtures.filter((f) => f.status !== "final").map((f) => f.gmkey);

  // 3차: gmkey가 정해져야 하는 조회. 별자리 표본은 "사실"이므로 26-27 첫 경기부터 26-27로
  // 바뀌고, 아직 한 경기도 없으면 지난 시즌 슛으로 채운다(빈 히어로 방지).
  // 전부 히어로 아트·리본·일정표의 장식 재료라 soft - 없으면 별자리 없음 / 승률 칸 "-".
  const shotFixtures = played.length ? played : prevFixtures.filter((f) => f.status === "final");
  const shotSeason = played.length ? factSeason : estSeason;
  const [shots, playedProbs, pregame, tags] = await Promise.all([
    soft(tcode, "shots", getTeamSeasonShots(tcode, shotFixtures.map((f) => f.gmkey), shotSeason), []),
    soft(tcode, "pregameProbs", getPregameProbs(playedGmkeys), new Map()),
    soft(tcode, "pregameFeatures", getPregameFeatures(pendingGmkeys), new Map()),
    soft(tcode, "gameTags", getGameTags(playedGmkeys), new Map()),
  ]);

  // 요청: "23~24년부터 전주KCC에서 부산KCC로 변경되었어" - 보고 있는 factSeason 기준으로
  // 표시 이름만 덮어씀(기존 페이지 로직 유지).
  const oppByTcode = new Map(
    [...opponents.values()].map((t) => [t.tcode, { ...t, name: displayTeamName(t.tcode, t.name, factSeason) }])
  );
  const teamName = displayTeamName(team.tcode, team.name, factSeason);
  // 저명도 팀 색(KT #1A1A1A 등)은 차트에서만 보조 액센트로 - 데이터 주장이 아닌 디자인 상수.
  const accent = accentFor(team.tcode, team.color);

  const constellationSvg = shots.length ? buildConstellationSvg(shots) : null;

  // 히어로 전적/순위: 사실이므로 factSeason에서 한 경기라도 치렀으면 factSeason, 아니면 estSeason.
  const recordSeason = played.length ? factSeason : estSeason;
  const recordStandings = played.length > 0 || estSeason === factSeason ? standingsFact : standingsEst;
  const recordFixtures = played.length ? played : prevFixtures.filter((f) => f.status === "final");
  const standingIdx = recordStandings.findIndex((s) => s.tcode === tcode);
  const standingRow = standingIdx >= 0 ? recordStandings[standingIdx] : null;
  const allWins = recordFixtures.filter((g) => (g.teamScore ?? 0) > (g.oppScore ?? 0)).length;
  const record = standingRow
    ? `${standingRow.wins}-${standingRow.losses}`
    : recordFixtures.length
      ? `${allWins}-${recordFixtures.length - allWins}`
      : "-";

  // ── 시즌 리본(시그니처): 치른 칸 + 남은 칸을 같은 폭으로. raw SVG 문자열 빌더를 쓰는 이유는
  //    React 19가 JSX <svg> 안의 JSX <title>을 문서 <head>로 끌어올려 툴팁이 통째로 사라지기
  //    때문(기존 JourneyChart의 실제 버그) - lib/seasonRibbon.ts 주석 참고.
  const ribbonSlots: RibbonSlot[] = fixtures.map((f) => ({
    gmkey: f.gmkey,
    gameDate: f.gameDate,
    gameStart: f.gameStart,
    stadium: f.stadium,
    oppAbbr: oppByTcode.get(f.oppTcode)?.abbr ?? f.oppTcode,
    oppName: oppByTcode.get(f.oppTcode)?.name ?? f.oppName,
    isHome: f.isHome,
    seasonCategory: f.seasonCategory,
    status: f.status,
    teamScore: f.teamScore,
    oppScore: f.oppScore,
    // 치른 경기 = 경기 시작 시점(game_events event_order=0), 예정 = pregame_features. 둘 다 홈 기준이라 팀 기준으로 뒤집는다.
    prob:
      f.status === "final"
        ? teamSideProb(playedProbs.get(f.gmkey), f.isHome)
        : teamSideProb(pregame.get(f.gmkey)?.homeWinProb, f.isHome),
    tag: tags.get(f.gmkey)?.key ?? null,
  }));
  // 아직 한 경기도 안 치른 팀만 첫 칸에 D-N(리그 개막 여부가 아니라 팀 단위 판정).
  const openerDday = !played.length && next ? daysUntilKst(next.gameDate) : null;
  const ribbon = buildSeasonRibbonSvg({ slots: ribbonSlots, teamColor: accent, nextGmkey: next?.gmkey ?? null, openerDday });

  return (
    <div className={`wrap ${styles.pageRoot}`} style={{ "--team": team.color } as CSSProperties}>
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
            <span>{factSeason} 시즌</span>
            <span className={styles.heroMetaDot}>·</span>
            <span>
              수록 {fixtures.length}경기 · 치른 {played.length}경기
            </span>
            {shots.length > 0 && (
              <>
                <span className={styles.heroMetaDot}>·</span>
                {/* 히어로 배경은 밀도 장(lib/shotDensityField.ts) - 밝기는 시도 밀도이지 성공률이 아니다. */}
                <span>
                  {seasonShort(shotSeason)} 슛 {shots.length.toLocaleString()}개의 밀도 지도 · 밝을수록 시도가 많은 자리
                  {shotSeason === factSeason && played.length > 0 && fixtures.length > played.length ? " · 채워지는 중" : ""}
                </span>
              </>
            )}
          </div>
          <div className={styles.heroStatRow}>
            {(
              [
                ["W-L", record, `${seasonShort(recordSeason)} ${standingRow ? "정규시즌" : "전체"}`],
                [
                  "RANK",
                  standingRow ? `${standingIdx + 1}` : "-",
                  standingRow ? `${seasonShort(recordSeason)} · ${recordStandings.length}팀` : `${seasonShort(recordSeason)} 정규시즌`,
                ],
                ["PPG", fourFactors ? fourFactors.ptsPg.toFixed(1) : "-", `${seasonShort(estSeason)} 득점`],
                ["OPP", fourFactors ? fourFactors.oppPtsPg.toFixed(1) : "-", `${seasonShort(estSeason)} 실점`],
                ["NET", fourFactors ? signed(fourFactors.netRtg) : "-", `${seasonShort(estSeason)} 100포제션당`],
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
        <select name="season" defaultValue={factSeason} className={styles.seasonSelect}>
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

      {/* ── 0. 팀 리더(추정 - estSeason). 히어로 바로 다음: 이 페이지에서 가장 빨리 읽히는 정보 ── */}
      <div className={styles.panel}>
        <PanelTitle title="팀 리더 · 경기당" chips={[basis, progress]} />
        <TeamLeadersPanel tl={teamLeaders} />
      </div>

      {/* ── 0-1. 로스터 변화(개막 전에만 - 아래 조회가 null이면 렌더 안 함) ── */}
      {rosterChanges && <RosterChangesPanel rc={rosterChanges} abbrOf={(t) => (t ? (oppByTcode.get(t)?.abbr ?? t) : null)} />}

      {/* ── 1. 4팩터 vs 리그(추정 - estSeason) ── */}
      <div className={styles.panel}>
        <PanelTitle title="4팩터 vs 리그" chips={[basis, progress]} />
        <FourFactorsPanel ff={fourFactors} seasonName={estSeason} />
      </div>

      {/* ── 1-1. 팀 전체 기록 · 리그 순위(추정 - estSeason). 4팩터가 못 담는 24개 지표 전부 ── */}
      <div className={styles.panel}>
        <PanelTitle title="팀 전체 기록 · 리그 순위" chips={[basis, progress]} />
        <TeamRankPanel stats={seasonStats} row={statRow} />
      </div>

      {/* ── 2. 시즌 리본(사실 - factSeason. 치른 칸 + 남은 고스트 칸) ── */}
      <div className={styles.panel}>
        <PanelTitle title={`시즌 리본 · ${seasonShort(factSeason)}`} />
        {ribbon ? (
          <>
            <svg
              className={styles.ribbonSvg}
              viewBox={`0 0 ${RIBBON_VIEWBOX.w} ${RIBBON_VIEWBOX.h}`}
              dangerouslySetInnerHTML={{ __html: ribbon.svg }}
            />
            <div className={styles.journeyLegend}>
              <span>
                <span className={styles.sw} style={{ background: accent }} />
                승리(점수차만큼 위로)
              </span>
              <span>
                <span className={styles.sw} style={{ background: "var(--ink-faint)" }} />
                패배(아래로)
              </span>
              <span>
                <span className={styles.swGhost} style={{ background: accent, opacity: 0.3 }} />
                예정 홈(채움)
              </span>
              <span>
                <span className={styles.swGhost} style={{ border: `1px solid ${accent}` }} />
                예정 원정(외곽선) · 높이 = 모델 승률
              </span>
              <span>
                <span className={styles.sw} style={{ background: "var(--gold)", clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />
                업셋 승리 {ribbon.stats.upsets}회
              </span>
              <span>
                <span className={styles.swLine} />
                모델 누적 기대승
              </span>
              <span>
                <span className={styles.swLineSolid} />
                실제 누적 승수
              </span>
            </div>
            <div className={styles.pctNote}>
              칸 하나 = 경기 하나(수록 일정 {ribbon.stats.n}경기{lastDate ? ` · 마지막 수록 경기 ${fmtDate(lastDate)}` : ""}) · 칸 클릭 →
              경기 상세, 마우스를 올리면 상대·점수·모델 승률
              {ribbon.stats.played > 0
                ? ` · 치른 ${ribbon.stats.played}경기 ${ribbon.stats.wins}승 ${ribbon.stats.losses}패(모델 승률 있는 경기 ${ribbon.stats.probCoveragePlayed}/${ribbon.stats.played})`
                : " · 아직 치른 경기 없음(전 칸이 고스트)"}
              {ribbon.stats.remaining > 0
                ? ` · 남은 ${ribbon.stats.remaining}경기 모델 기대승 ${ribbon.stats.remainingExp.toFixed(1)}(승률 있는 경기 ${ribbon.stats.remainingPriced}/${ribbon.stats.remaining})`
                : ""}{" "}
              · 고스트 막대 높이는 모델 승률이지 예상 점수차가 아님
              {ribbon.stats.remainingPriced > 0 ? ` · ${PREGAME_MODEL_CAPTION}` : ""}
            </div>
          </>
        ) : (
          <div className="empty-note">이 시즌 일정 데이터 없음</div>
        )}
      </div>

      {/* ── 3. 로스터 기여도(추정 - estSeason) ── */}
      <div className={styles.panel}>
        <PanelTitle title="로스터 기여도" chips={[basis, progress]} />
        <RosterPanel roster={roster} accent={accent} />
      </div>

      {/* ── 4. 베스트 유닛 ── */}
      <div className={styles.panel}>
        <PanelTitle title="베스트 유닛 · 이 시즌 로스터 조합" chips={[basis]} />
        <BestUnitsPanel units={units} tcode={tcode} season={estSeason} />
      </div>

      {/* ── 5. 슛 프로필(추정 - estSeason) ── */}
      <div className={styles.panel}>
        <PanelTitle title="슛 프로필 · 존 구성비 vs 리그" chips={[basis, progress]} />
        <ZoneProfilePanel zp={zoneProfile} seasonName={estSeason} />
      </div>

      {/* ── 6. 전체 일정(사실 - factSeason. 결과 행 + 예정 행 한 표) ── */}
      <div className={styles.panel}>
        <PanelTitle title={`${seasonShort(factSeason)} 일정 (수록 ${fixtures.length}경기 · 치른 ${played.length})`} />
        {fixtures.length === 0 ? (
          <div className="empty-note">이 시즌 경기 데이터 없음</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                {/* 컬럼 순서를 바꿨다(제보: "예상 승률이 화면을 스크롤해야 나온다").
                    예상 승률을 결과 앞으로 당기고, '구분'은 정규시즌이 아닐 때만 날짜 옆 칩으로
                    붙인다 - 한 컬럼을 통째로 쓰던 값의 대부분이 "정규시즌" 반복이었다. */}
                <tr>
                  <th>날짜</th>
                  <th>상대</th>
                  <th className={styles.schedProbHead}>예상 승률</th>
                  <th>결과</th>
                </tr>
              </thead>
              <tbody>
                {fixtures.map((g) => {
                  const opp = oppByTcode.get(g.oppTcode);
                  const isFinal = g.status === "final" && g.teamScore != null && g.oppScore != null;
                  const won = isFinal && (g.teamScore as number) > (g.oppScore as number);
                  const tag: GameTag | undefined = tags.get(g.gmkey);
                  const prob = isFinal
                    ? teamSideProb(playedProbs.get(g.gmkey), g.isHome)
                    : teamSideProb(pregame.get(g.gmkey)?.homeWinProb, g.isHome);
                  const start = fmtStart(g.gameStart);
                  return (
                    <tr key={g.gmkey}>
                      <td>
                        <Link href={`/games/${g.gmkey}`}>{fmtDate(g.gameDate)}</Link>
                        {!isFinal && start ? <span className={styles.schedStart}> {start}</span> : null}
                        {g.seasonCategory !== "정규시즌" ? (
                          <span className={styles.schedCat}>{g.seasonCategory}</span>
                        ) : null}
                      </td>
                      <td className={styles.schedOppCell}>
                        {g.isHome ? "vs" : "@"}
                        <TeamBadge team={opp ?? null} size={16} />
                        {opp?.name ?? g.oppName}
                      </td>
                      <td className={styles.schedProb}>
                        {prob != null ? (
                          <span style={{ color: outcomeTone(prob).color, fontWeight: outcomeTone(prob).weight }}>
                            {(prob * 100).toFixed(0)}%
                          </span>
                        ) : (
                          <span className={styles.schedPending}>-</span>
                        )}
                      </td>
                      <td>
                        {isFinal ? (
                          <>
                            {/* 승/패도 승률과 같은 축의 양 끝 색을 쓴다(요청: "실제 결과도 색상이 동일하도록"). */}
                            <span
                              className="sched-result"
                              style={{ color: outcomeTone(won ? 1 : 0).color, fontWeight: 800 }}
                            >
                              {won ? "W" : "L"}
                            </span>{" "}
                            {g.teamScore}-{g.oppScore}
                            {tag ? <span className={styles.schedTag}>{GAME_TAG_LABELS[tag.key]}</span> : null}
                          </>
                        ) : (
                          <span className={styles.schedPending}>
                            {g.status === "live" ? "진행 중" : "예정"}
                            {g.stadium ? ` · ${g.stadium}` : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className={styles.pctNote}>
          <b>예상 승률</b>은 이 팀 기준이고 색이 곧 승리 가능성이다(초록 유리 · 회색 반반 · 빨강 불리).
          결과의 W/L도 같은 축의 양 끝 색이다. 치른 경기는 경기 전 시점의 예측값을 그대로 남겨 두므로,
          예측이 맞았는지 틀렸는지를 같은 줄에서 바로 비교할 수 있다 · {PREGAME_MODEL_CAPTION}
          {lastDate ? ` · 현재 수록된 마지막 경기 ${lastDate}(이후 일정은 적재되면 자동으로 채워짐)` : ""}
        </div>
      </div>

      <footer className="foot">
        {teamName} · {factSeason} 시즌 · 실시간 조회
      </footer>
    </div>
  );
}
