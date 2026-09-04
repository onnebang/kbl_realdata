import Link from "next/link";
import type { CSSProperties } from "react";
import { TeamBadge } from "@/components/TeamBadge";
import { supabase } from "@/lib/supabase";
import { PRESEASON_SEASON, getSeasonOpener, shortSeason } from "@/lib/preseason";
import { getLeaderboardSeasons } from "@/lib/seasonLeaders";
import {
  WOWY_CAREER,
  WOWY_MIN_MINUTES,
  WOWY_SUBJECT_MIN_MINUTES,
  getWowy,
  getWowyPlayers,
  type WowyMate,
  type WowyPickPlayer,
  type WowyTeamGroup,
} from "@/lib/wowy";
import styles from "./lineups.module.css";

// 선수별 조합(WOWY) - 요청: "선수별 조합", 참고는 databallr.com의 WOWY Lineups 뷰.
// 한 선수를 고르면 "이 동료와 같이 뛸 때"와 "이 동료 없이(주인공은 계속 코트에) 뛸 때"의
// 팀 마진을 나란히 놓는다. 계산은 전부 lib/wowy.ts에 있고 이 파일은 표시만 한다.
//
// 저장소 규칙대로 클라이언트 컴포넌트가 없다. 상태는 전부 URL이다:
//   /lineups?season={시즌}&team={tcode}&player={pcode}&scope=career
// 시즌·팀 선택은 링크와 GET 폼, 선수 목록 접기는 <details>, 발산 막대는 CSS 폭이다.
//
// 캡션이 이 페이지의 본체다. WOWY 숫자는 표본과 정의를 떼면 정확히 반대 결론을 부르기 때문에
// (특히 '따로'를 "선수가 벤치일 때"로 읽는 오해) 정의·무보정·최소 표본·행별 표본을 항상 같이 낸다.
export const dynamic = "force-dynamic";

const fmtMin = (m: number) => Math.round(m).toLocaleString();
// 소수 둘째 자리에서 0으로 떨어지는 값에는 부호를 붙이지 않는다("+0.00"은 좋은 쪽으로 읽힌다).
// 색(signClass)도 같은 경계를 쓰므로 인쇄된 부호와 색이 항상 일치한다.
const fmtNet = (v: number) => {
  const s = v.toFixed(2);
  if (s === "0.00" || s === "-0.00") return "0.00";
  return v > 0 ? `+${s}` : s;
};
const signClass = (v: number) => (v >= 0.005 ? styles.pos : v <= -0.005 ? styles.neg : undefined);

type Query = { season: string; team?: string | null; player?: string | null; scope?: string | null };

function hrefFor(q: Query): string {
  const p = new URLSearchParams({ season: q.season });
  if (q.team) p.set("team", q.team);
  if (q.player) p.set("player", q.player);
  if (q.scope) p.set("scope", q.scope);
  return `/lineups?${p.toString()}`;
}

/**
 * 선수 사진. players.photo_url은 773명 중 31명만 있어서(실측) 대부분 null이고,
 * 없으면 등번호 타일로 폴백한다 - /players 디렉터리와 같은 규칙.
 * 고른 팀의 로스터(9~13명)만 조회하므로 한 번의 가벼운 쿼리다.
 */
async function fetchPhotos(pcodes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!pcodes.length) return map;
  const { data } = await supabase.from("players").select("pcode, photo_url").in("pcode", pcodes);
  for (const r of data ?? []) {
    const url = r.photo_url as string | null;
    if (url) map.set(r.pcode as string, url);
  }
  return map;
}

function PlayerTile({
  p,
  photoUrl,
  href,
  active,
}: {
  p: WowyPickPlayer;
  photoUrl: string | null;
  href: string;
  active: boolean;
}) {
  return (
    <Link href={href} className={`${styles.playerTile} ${active ? styles.playerTileActive : ""}`}>
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={photoUrl} alt="" className={styles.photo} loading="lazy" />
      ) : (
        <div className={styles.photoFallback}>{p.backNum ?? "·"}</div>
      )}
      <div className={styles.tileNum}>{p.backNum ?? ""}</div>
      <div className={styles.tileNameCell}>
        <div className={styles.tileName}>{p.name}</div>
        <div className={styles.tileSub}>
          {[p.posLabel, `${p.gp}G`, `${fmtMin(p.minutes)}분`].filter(Boolean).join(" · ")}
        </div>
      </div>
    </Link>
  );
}

/** 동료 한 명 = 한 행. 분·스틴트를 값 옆에 붙여 두는 게 이 표의 규칙이다. */
function MateRow({ m, maxAbs }: { m: WowyMate; maxAbs: number }) {
  // 막대 폭은 이 표 안의 |차이| 최댓값 기준 비율. 0에 가까운 값도 보이도록 하한 3%.
  const pct = Math.max(3, Math.min(100, (Math.abs(m.diff) / maxAbs) * 100));
  return (
    <tr>
      <td>
        <Link href={m.href} className={styles.mateName}>
          {m.name}
        </Link>
      </td>
      <td>
        <div className={styles.minCell}>
          <div className={styles.minVal}>{fmtMin(m.with.minutes)}분</div>
          <div className={styles.minSub}>{m.with.stints.toLocaleString()}스틴트</div>
        </div>
      </td>
      <td className={`${styles.netVal} ${signClass(m.with.netPer40) ?? ""}`}>{fmtNet(m.with.netPer40)}</td>
      <td>
        <div className={styles.minCell}>
          <div className={styles.minVal}>{fmtMin(m.without.minutes)}분</div>
          <div className={styles.minSub}>{m.without.stints.toLocaleString()}스틴트</div>
        </div>
      </td>
      <td className={`${styles.netVal} ${signClass(m.without.netPer40) ?? ""}`}>{fmtNet(m.without.netPer40)}</td>
      <td className={`${styles.diffVal} ${signClass(m.diff) ?? ""}`}>{fmtNet(m.diff)}</td>
      <td className={styles.diffCell}>
        {/* 숫자를 바로 왼쪽 칸에 두었으므로 막대는 장식이다(스크린리더에서 숨김). */}
        <div className={styles.diffBar} aria-hidden="true">
          <div className={`${styles.diffHalf} ${styles.diffLeft}`}>
            {m.diff < 0 && <div className={`${styles.diffFill} ${styles.diffFillNeg}`} style={{ width: `${pct}%` }} />}
          </div>
          <div className={`${styles.diffHalf} ${styles.diffRight}`}>
            {m.diff > 0 && <div className={`${styles.diffFill} ${styles.diffFillPos}`} style={{ width: `${pct}%` }} />}
          </div>
        </div>
      </td>
    </tr>
  );
}

function MateTable({ mates, maxAbs }: { mates: WowyMate[]; maxAbs: number }) {
  return (
    <div className="table-scroll">
      <table className={`data-table ${styles.table}`}>
        <thead>
          <tr>
            <th>동료</th>
            <th>같이 뛴 시간</th>
            <th>같이 NET/40</th>
            <th>따로 뛴 시간</th>
            <th>따로 NET/40</th>
            <th>차이</th>
            <th>
              <div className={styles.diffAxis}>
                <span className={styles.diffAxisLeft}>따로일 때 ←</span>
                <span className={styles.diffAxisRight}>→ 같이일 때</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {mates.map((m) => (
            <MateRow key={m.pcode} m={m} maxAbs={maxAbs} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function LineupsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string; team?: string; player?: string; scope?: string }>;
}) {
  const sp = await searchParams;
  const seasons = await getLeaderboardSeasons();

  // 라인업 로그가 있는 시즌 = 실제로 치러진 시즌. 2026-2027은 개막 전이라 이 목록에 없다.
  if (!seasons.length) {
    return (
      <div className="wrap">
        <div className="title">선수별 조합</div>
        <div className="empty-note">라인업 기록이 있는 시즌이 아직 없습니다.</div>
      </div>
    );
  }

  const latest = seasons[0];
  const requested = sp.season?.trim() || null;
  const seasonOk = requested != null && seasons.includes(requested);
  const season = seasonOk ? (requested as string) : latest;
  // 요청한 시즌을 조용히 최신 시즌으로 바꿔치기하지 않는다 - 왜 다른 시즌을 보고 있는지 말한다.
  // 되돌려 쓰는 값은 시즌명 꼴("2026-2027")일 때만 그대로 인용한다(React가 이스케이프하긴 하지만
  // 아무 문자열이나 화면 문구로 승격시킬 이유가 없다).
  const rejected = requested && !seasonOk ? (/^\d{4}-\d{4}$/.test(requested) ? requested : "요청하신 시즌") : null;
  const opener = rejected === PRESEASON_SEASON ? await getSeasonOpener(PRESEASON_SEASON) : null;

  const careerScope = sp.scope === WOWY_CAREER;
  const playerCode = sp.player?.trim() || null;

  // 두 조회 모두 6,000행 안팎을 읽는다(각 2.5초 내외). 반드시 병렬로 한 번씩만 부른다.
  const [picker, wowy] = await Promise.all([
    getWowyPlayers(season),
    playerCode ? getWowy(playerCode, careerScope ? WOWY_CAREER : season) : Promise.resolve(null),
  ]);

  const groups: WowyTeamGroup[] = picker?.groups ?? [];
  const teamCode = sp.team?.trim() || null;
  const group = teamCode ? groups.find((g) => g.tcode === teamCode) ?? null : null;
  const photos = group ? await fetchPhotos(group.players.map((p) => p.pcode)) : new Map<string, string>();

  // 커리어 범위에서는 lib/wowy.ts가 소속 팀을 비운다(여러 팀을 거쳤을 수 있으므로).
  // 그럴 때 배지는 "이 시즌 로스터에서 골랐다"는 사실만 표시한다.
  const pickedEntry = playerCode
    ? groups.flatMap((g) => g.players.map((p) => ({ p, g }))).find((x) => x.p.pcode === playerCode) ?? null
    : null;
  const badgeTeam = wowy?.subject.tcode
    ? { name: wowy.subject.teamName ?? "", abbr: wowy.subject.teamAbbr ?? "", color: wowy.subject.teamColor ?? "#888888", logoUrl: wowy.subject.logoUrl }
    : pickedEntry
      ? { name: pickedEntry.g.name, abbr: pickedEntry.g.abbr, color: pickedEntry.g.color, logoUrl: pickedEntry.g.logoUrl }
      : null;
  const accent = badgeTeam?.color ?? null;

  const mates = wowy?.mates ?? [];
  const maxAbs = Math.max(0.5, ...mates.map((m) => Math.abs(m.diff)));
  const below = wowy?.belowThreshold ?? [];
  const belowMax = Math.max(0.5, ...below.map((m) => Math.abs(m.diff)));
  const thin = wowy != null && wowy.subject.onCourt.minutes < WOWY_SUBJECT_MIN_MINUTES;

  return (
    <div className="wrap">
      <div className={styles.head}>
        <div className="title">선수별 조합</div>
        <span className={styles.kicker}>
          WOWY · {careerScope && wowy ? "커리어" : shortSeason(season)}
        </span>
      </div>
      <p className={styles.lede}>
        한 선수가 <b>어떤 동료와 같이 뛸 때</b> 팀 득실 마진이 어떻게 달라지는지 봅니다. 표본은 그 선수가 코트에 있던
        시간뿐이고, 그 시간을 동료가 같이 있었는지로만 둘로 가릅니다. 그래서 &quot;따로&quot;는 <b>선수는 뛰고 동료만 벤치인 시간</b>
        이지, 선수가 쉬는 시간이 아닙니다.
      </p>

      {rejected && (
        <div className={styles.warn}>
          <b>{rejected} 시즌은 아직 라인업 기록이 없습니다.</b>{" "}
          {rejected === PRESEASON_SEASON
            ? opener
              ? `${opener.firstGameDate} 개막 예정(${opener.nGames}경기)이라 아직 한 경기도 치르지 않았습니다. `
              : "아직 한 경기도 치르지 않았습니다. "
            : ""}
          대신 {season} 시즌을 보여드립니다.
        </div>
      )}

      <div className={styles.controls}>
        {/* 시즌 변경은 GET 폼. 팀·선수는 hidden으로 유지해서 "같은 선수, 다른 시즌"을 바로 볼 수 있게
            한다(그 시즌에 안 뛰었으면 아래에서 그렇다고 말한다). 범위(scope)는 시즌과 무관한
            커리어 뷰라 시즌을 바꾸면 자동으로 해제한다. */}
        <form className={styles.seasonForm} action="/lineups">
          <select name="season" defaultValue={season} aria-label="시즌 선택">
            {seasons.map((s) => (
              <option key={s} value={s}>
                {s} 시즌
              </option>
            ))}
          </select>
          {teamCode && <input type="hidden" name="team" value={teamCode} />}
          {playerCode && <input type="hidden" name="player" value={playerCode} />}
          <button type="submit" className="btn-primary">
            시즌 보기
          </button>
        </form>
      </div>

      <div className={styles.chipRow}>
        <span className={styles.chipLabel}>구단</span>
        {groups.map((g) => (
          <Link
            key={g.tcode}
            href={hrefFor({ season, team: g.tcode })}
            className={`${styles.chip} ${teamCode === g.tcode ? styles.chipActive : ""}`}
          >
            {g.abbr}
          </Link>
        ))}
      </div>

      {!picker && <div className="empty-note">{season} 시즌은 라인업 스틴트 기록이 없어 조합을 계산할 수 없습니다.</div>}

      {picker && (
        <details className={styles.picker} open={!wowy}>
          <summary className={styles.pickerSummary}>
            {group ? (
              <>
                <TeamBadge team={{ name: group.name, abbr: group.abbr, color: group.color, logoUrl: group.logoUrl }} size={20} />
                {group.name} 선수 고르기
              </>
            ) : teamCode ? (
              "선수 고르기"
            ) : (
              "구단을 먼저 고르세요"
            )}
            <span className={styles.pickerCount}>{picker.caption}</span>
          </summary>
          {group ? (
            <div className={styles.playerGrid}>
              {group.players.map((p) => (
                <PlayerTile
                  key={p.pcode}
                  p={p}
                  photoUrl={photos.get(p.pcode) ?? null}
                  href={hrefFor({ season, team: group.tcode, player: p.pcode, scope: careerScope ? WOWY_CAREER : null })}
                  active={playerCode === p.pcode}
                />
              ))}
            </div>
          ) : teamCode ? (
            <div className="empty-note">
              {season} 시즌에는 이 구단의 {WOWY_SUBJECT_MIN_MINUTES}분 이상 출전 선수가 없습니다.
            </div>
          ) : (
            <div className={styles.note}>
              위 구단 칩을 누르면 그 시즌 {WOWY_SUBJECT_MIN_MINUTES}분 이상 뛴 선수가 나옵니다. 선수를 고르면 그 선수 기준의
              조합 표가 열립니다.
            </div>
          )}
        </details>
      )}

      {playerCode && !wowy && (
        <div className="empty-note">
          {pickedEntry ? pickedEntry.p.name : /^\d{1,12}$/.test(playerCode) ? `선수 ${playerCode}` : "이 선수"}의{" "}
          {careerScope ? "커리어" : season} 라인업 기록이 없습니다.
          {careerScope ? "" : " 그 시즌에 출전하지 않았거나 라인업 로그가 남지 않은 경기들입니다."}
        </div>
      )}

      {wowy && (
        <>
          <section className={styles.subject} style={accent ? ({ "--team": accent } as CSSProperties) : undefined}>
            <div className={styles.subjectHead}>
              {badgeTeam && <TeamBadge team={badgeTeam} size={30} />}
              <Link href={wowy.subject.href} className={styles.subjectName}>
                {wowy.subject.name}
              </Link>
              <span className={styles.subjectTeam}>
                {wowy.subject.teamName
                  ? `${wowy.subject.teamName} · ${wowy.subject.scopeLabel}`
                  : pickedEntry
                    ? `커리어 전체 · ${shortSeason(season)} ${pickedEntry.g.name} 로스터에서 선택`
                    : "커리어 전체"}
              </span>
              <div className={styles.scopeSwitch}>
                <Link
                  href={hrefFor({ season, team: teamCode, player: playerCode })}
                  className={`${styles.chip} ${!careerScope ? styles.chipActive : ""}`}
                >
                  {shortSeason(season)}
                </Link>
                <Link
                  href={hrefFor({ season, team: teamCode, player: playerCode, scope: WOWY_CAREER })}
                  className={`${styles.chip} ${careerScope ? styles.chipActive : ""}`}
                >
                  커리어
                </Link>
              </div>
            </div>

            {/* 주인공의 온코트 총합 - 표의 모든 행에서 같이+따로가 이 값이 되므로 독자가 검산할 수 있다. */}
            <div className={styles.tiles}>
              <div>
                <div className={styles.tileVal}>{wowy.subject.gamesN.toLocaleString()}</div>
                <div className={styles.tileLabel}>경기</div>
              </div>
              <div>
                <div className={styles.tileVal}>{fmtMin(wowy.subject.onCourt.minutes)}</div>
                <div className={styles.tileLabel}>온코트 분</div>
              </div>
              <div>
                <div className={styles.tileVal}>{wowy.subject.onCourt.stints.toLocaleString()}</div>
                <div className={styles.tileLabel}>스틴트</div>
              </div>
              <div>
                <div className={`${styles.tileVal} ${signClass(wowy.subject.onCourt.margin) ?? ""}`}>
                  {fmtNet(wowy.subject.onCourt.margin).replace(/\.00$/, "")}
                </div>
                <div className={styles.tileLabel}>마진</div>
              </div>
              <div>
                <div className={`${styles.tileVal} ${signClass(wowy.subject.onCourt.netPer40) ?? ""}`}>
                  {fmtNet(wowy.subject.onCourt.netPer40)}
                </div>
                <div className={styles.tileLabel}>NET/40</div>
              </div>
            </div>
          </section>

          {thin && (
            <div className={styles.warn}>
              <b>표본이 기준 미만입니다.</b> 이 범위에서 {wowy.subject.name}의 온코트 시간은{" "}
              {fmtMin(wowy.subject.onCourt.minutes)}분으로 주인공 기준선({WOWY_SUBJECT_MIN_MINUTES}분)에 못 미칩니다. 아래
              숫자는 계산은 같지만 몇 경기의 흐름에 통째로 흔들릴 수 있습니다.
            </div>
          )}

          <div className="panel">
            <div className="panel-title">
              동료별 조합 · 차이 내림차순 {mates.length > 0 && `· ${mates.length}명`}
            </div>
            {mates.length > 0 ? (
              <MateTable mates={mates} maxAbs={maxAbs} />
            ) : (
              <div className="empty-note">
                함께·따로 양쪽 {WOWY_MIN_MINUTES}분을 모두 넘긴 동료가 없습니다.
                {below.length > 0 && ` 표본이 모자란 동료 ${below.length}명은 아래에서 볼 수 있습니다.`}
              </div>
            )}

            <div className={styles.caption}>
              <b>이 표를 읽는 법</b>
              <ul className={styles.captionList}>
                <li>{wowy.definition}</li>
                <li>
                  <b>보정이 전혀 없습니다.</b> 상대 팀 전력도, 코트 위 나머지 선수가 누구였는지도 보정하지 않은 원시
                  온코트 플러스마이너스입니다. <b>RAPM(조정 플러스마이너스)이 아닙니다.</b> 그래서 차이가 큰 조합은
                  &quot;이 둘이 잘 맞는다&quot;의 증거가 아니라 &quot;그 시간대에 팀 마진이 이랬다&quot;는 기록으로 읽어야 합니다.
                </li>
                <li>
                  <b>최소 표본 {WOWY_MIN_MINUTES}분.</b> 함께와 따로 양쪽 모두 {WOWY_MIN_MINUTES}분을 넘긴 동료만 표에
                  올립니다. 행마다 분과 스틴트 수를 값 옆에 적어 두었습니다 - 표본을 빼고 차이만 읽으면 정확히 반대
                  결론이 납니다.
                </li>
                <li>
                  <b>검산.</b> 모든 행에서 같이 뛴 시간 + 따로 뛴 시간 = 주인공 온코트 {wowy.subject.onCourt.sample}
                  입니다. 따로 쪽 분이 클수록 그 동료와 겹친 시간이 적었다는 뜻입니다.
                </li>
                <li>
                  <b>범위.</b> {wowy.caption}
                </li>
              </ul>
            </div>

            {below.length > 0 && (
              <details>
                <summary className={styles.belowSummary}>표본 미달 동료 {below.length}명 보기</summary>
                <div className={styles.note}>
                  함께 또는 따로 중 한쪽이 {WOWY_MIN_MINUTES}분에 못 미칩니다. 몇 분짜리 표본에서는 NET/40이 수십까지
                  튀므로 순위로 읽지 마시고 참고로만 보세요. 막대 축척도 위 표와 다릅니다(각 표 안의 최댓값 기준).
                </div>
                <MateTable mates={below} maxAbs={belowMax} />
              </details>
            )}
          </div>
        </>
      )}

      <div className={styles.note}>
        표본은 lineup_stints(15시즌 라인업 로그)에서 실시간으로 집계합니다. 주인공 목록은 그 시즌
        {WOWY_SUBJECT_MIN_MINUTES}분 이상 출전한 선수이며, 시즌 중 이적한 선수는 더 오래 뛴 팀에 한 번만 나옵니다.
      </div>
    </div>
  );
}
