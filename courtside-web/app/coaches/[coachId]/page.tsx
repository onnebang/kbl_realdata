import Link from "next/link";
import { notFound } from "next/navigation";
import { TeamBadge } from "@/components/TeamBadge";
import {
  getCoachProfile,
  buildCoachRadarSvg,
  RADAR_AXES,
  RADAR_VIEWBOX,
  RADAR_MIN_N,
  RECORD_CAPTIONS,
  STYLE_CAPTION,
  CHALLENGE_CAPTION,
  CHALLENGE_ALL3_NOTE,
  MEASURING_NOTE,
  SHORT_SEASON,
  PARTIAL_SEASON_NOTE,
  CAREER_MIN_SEASONS,
  fmtPct3,
  isPartialSeason,
  seasonLabel,
  type CoachSeasonRow,
} from "@/lib/coachPage";
import { signed, signTone } from "@/lib/format";
import { PRESEASON_SEASON } from "@/lib/preseason";
import styles from "./coach-profile.module.css";
import dir from "@/components/Directory.module.css";

// 감독 프로필. 데이터·판정은 lib/coachPage.ts 머리 주석 참고 - 이 페이지는 사실(승-패·득실·팀 스타일·
// 챌린지 사용 성향)만 그리고 '감독 효과'·'랭킹'·'성공률'은 그리지 않는다. 클라이언트 JS 0.
export const dynamic = "force-dynamic";

// 색은 표시값(반올림 후)의 부호로 판정한다 - signed()와 같은 기준이라 "표시는 0.0인데 빨강"이 없다.
const pctCls = (v: number) => {
  const t = signTone(v, 1);
  return t === "pos" ? styles.pos : t === "neg" ? styles.neg : undefined;
};

export default async function CoachPage({ params, searchParams }: { params: Promise<{ coachId: string }>; searchParams: Promise<{ season?: string }> }) {
  const { coachId: idRaw } = await params;
  const { season: seasonQ } = await searchParams;
  // Number()는 "0x1c"(=28)·"2.8e1"(=28)도 받는다 - 십진 숫자만 통과시킨다(자릿수는 bigint 범위 가드).
  if (!/^\d{1,9}$/.test(idRaw)) notFound();
  const coachId = Number(idRaw);
  const p = await getCoachProfile(coachId);
  if (!p) notFound();

  const { coach, seasons, career, careerStyle, currentTeam, challengeLeague } = p;
  const lastSeason = seasons[seasons.length - 1];
  // 진행 중인 시즌 = 데이터셋의 마지막 시즌이면서 아직 54경기에 못 미치는 경우(경기 수만으로 보면
  // 2019-20 42경기 팀이 6년 뒤에도 '진행 중'이 된다 - lib/coachPage.ts isPartialSeason 주석 참고).
  const partialSeason = lastSeason && isPartialSeason(lastSeason.seasonName, lastSeason.record.g, p.dataRange.last) ? lastSeason : null;
  const styled = seasons.filter((s): s is CoachSeasonRow & { style: NonNullable<CoachSeasonRow["style"]> } => s.style != null);
  const lastStyled = styled[styled.length - 1];
  // 기본 시즌은 표본이 충분한 마지막 시즌(진행 중이면 직전 완주 시즌). ?season=이면 그 시즌 그대로.
  const defaultStyled = lastStyled && lastStyled.style.n < RADAR_MIN_N ? (styled[styled.length - 2] ?? lastStyled) : lastStyled;
  const radarSeason = styled.find((s) => s.seasonName === seasonQ) ?? defaultStyled ?? null;
  const radarSvg = radarSeason ? buildCoachRadarSvg({ season: radarSeason.style, seasonLabel: seasonLabel(radarSeason.seasonName), career: careerStyle }) : null;
  const hasShortSeason = seasons.some((s) => s.seasonName === SHORT_SEASON);
  // 카드 머리글은 challengeLeague(최신 1행)의 시즌이라 타일 라벨에 그 타일의 시즌을 함께 적는다.
  const challenges = seasons.filter((s) => s.challenge).map((s) => s.challenge!);

  return (
    <div className="wrap">
      <div className={styles.head}>
        <div className="title">{coach.name}</div>
        <span className={styles.kicker}>감독 · 정규시즌 기준</span>
      </div>
      <div className={styles.sub}>
        {currentTeam && (
          <span className={styles.badgeLine}>
            <TeamBadge team={{ name: currentTeam.name, abbr: currentTeam.abbr, color: currentTeam.color ?? "#888888", logoUrl: currentTeam.logoUrl }} size={22} />
            {seasonLabel(currentTeam.seasonName)} {currentTeam.name} 감독
            {!currentTeam.confirmed && <span className={styles.unconfirmed}>(확인 필요)</span>}
          </span>
        )}
        {career ? (
          <span>
            재임 {career.seasons}시즌 · {seasonLabel(career.first)}~{seasonLabel(career.last)} · {career.teams.map((t) => t.abbr).join(" · ")}
          </span>
        ) : (
          <span>정규시즌 기록 없음 - {seasonLabel(currentTeam ? currentTeam.seasonName : PRESEASON_SEASON)} 시즌이 시작되면 채워진다</span>
        )}
        <Link href="/coaches" className={dir.chip}>
          감독 목록
        </Link>
      </div>

      {/* (a) 상단 타일 */}
      {career && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>통산 기록</span>
            <span className={styles.cardKicker}>정규시즌 · 팀 성적을 재임 시즌으로 자른 것</span>
          </div>
          <div className={styles.tiles}>
            <div className={styles.tile}>
              <div className={styles.tileVal}>{career.g}</div>
              <div className={styles.tileLabel}>경기</div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileVal}>
                {career.w}-{career.l}
              </div>
              <div className={styles.tileLabel}>승-패</div>
            </div>
            {/* 이 카드의 주인공 숫자 하나 - 나머지 타일은 조용한 크기를 유지한다 */}
            <div className={styles.tile}>
              <div className={`${styles.tileVal} ${styles.tileValLead}`}>
                {fmtPct3(career.wpct)}
                <span className={styles.tileSe}>±{fmtPct3(career.wpctSe)}</span>
              </div>
              <div className={styles.tileLabel}>승률 · 이항 SE</div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileVal}>{career.pf.toFixed(1)}</div>
              <div className={styles.tileLabel}>평균 득점</div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileVal}>{career.pa.toFixed(1)}</div>
              <div className={styles.tileLabel}>평균 실점</div>
            </div>
            <div className={styles.tile}>
              <div className={`${styles.tileVal} ${pctCls(career.net) ?? ""}`}>
                {signed(career.net)}
                <span className={styles.tileSe}>±{career.netSe.toFixed(1)}</span>
              </div>
              <div className={styles.tileLabel}>넷마진 · SE</div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileText}>
                {career.seasons}시즌
                <br />
                {seasonLabel(career.first)}~{seasonLabel(career.last)}
              </div>
              <div className={styles.tileLabel}>재임</div>
            </div>
            <div className={styles.tile}>
              <div className={styles.tileText}>{career.teams.map((t) => t.abbr).join(" · ")}</div>
              <div className={styles.tileLabel}>맡은 팀</div>
            </div>
          </div>
          <ul className={styles.captions}>
            {RECORD_CAPTIONS(p.dataRange.first, p.dataRange.last).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      )}

      {/* (b) 시즌별 표 */}
      {seasons.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>시즌별</span>
            <span className={styles.cardKicker}>정규시즌 · 홈/원정은 원자료 승-패만(격차는 감독 간 차이가 노이즈와 같아 싣지 않음)</span>
          </div>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>시즌</th>
                  <th className={styles.left}>팀</th>
                  <th>승-패</th>
                  <th>승률</th>
                  <th>득 / 실</th>
                  <th>넷마진</th>
                  <th>홈 · 원정</th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s) => (
                  <tr key={s.seasonName}>
                    <td>
                      {seasonLabel(s.seasonName)}
                      {s.seasonName === SHORT_SEASON ? "*" : ""}
                      {s === partialSeason && <span className={styles.partial}>진행 중 · {s.record.g}경기</span>}
                    </td>
                    <td className={styles.left}>
                      <Link href={`/teams/${s.tcode}?season=${s.seasonName}`}>{s.teamName}</Link>
                    </td>
                    <td>
                      {s.record.w}-{s.record.l}
                    </td>
                    <td>{fmtPct3(s.record.wpct)}</td>
                    <td>
                      {s.record.pf.toFixed(1)} / {s.record.pa.toFixed(1)}
                    </td>
                    <td className={pctCls(s.record.net)}>{signed(s.record.net)}</td>
                    <td className={styles.small}>
                      {s.record.homeW}-{s.record.homeG - s.record.homeW} · {s.record.awayW}-{s.record.awayG - s.record.awayW}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {hasShortSeason && <div className={styles.note}>* 2019-20은 코로나 중단으로 팀당 42~43경기(다른 시즌 54경기) - 승수 대신 승률·넷마진으로 비교</div>}
          {partialSeason && (
            <div className={styles.note}>
              {seasonLabel(partialSeason.seasonName)}은 {partialSeason.record.g}경기까지 - {PARTIAL_SEASON_NOTE}
            </div>
          )}
        </section>
      )}

      {/* (c) 재임기 팀 스타일 레이더 */}
      {radarSeason && radarSvg && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>재임기 팀 스타일</span>
            <span className={styles.cardKicker}>
              {seasonLabel(radarSeason.seasonName)} {radarSeason.teamName} · 시즌 내 10팀 z · {radarSeason.style.n}경기
            </span>
          </div>
          <div className={styles.chips}>
            {styled.map((s) => (
              <Link key={s.seasonName} href={`/coaches/${coach.coachId}?season=${s.seasonName}`} className={`${dir.chip} ${s.seasonName === radarSeason.seasonName ? dir.chipActive : ""}`}>
                {seasonLabel(s.seasonName)} {s.team.abbr}
                {s === partialSeason && <span className={styles.partial}>진행 중 · {s.record.g}경기</span>}
              </Link>
            ))}
          </div>
          <div className={styles.radarGrid}>
            {/* 라벨이 12px 아래로 내려가지 않도록 뷰박스 폭(320)을 min-width로 지키고, 좁으면 래퍼가 가로 스크롤 */}
            <div className={styles.tableWrap}>
              <svg className={styles.radarSvg} viewBox={`0 0 ${RADAR_VIEWBOX.w} ${RADAR_VIEWBOX.h}`} role="img" aria-label="재임기 팀 스타일 레이더" dangerouslySetInnerHTML={{ __html: radarSvg }} />
            </div>
            <div>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>축</th>
                      <th>z</th>
                      <th>원값</th>
                      <th>리그 평균</th>
                      <th>{careerStyle ? `통산 z (${careerStyle.n}시즌)` : "통산 z"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {RADAR_AXES.map((a) => {
                      const z = radarSeason.style.z[a.key];
                      const sig = Math.abs(z) >= a.se;
                      const cz = careerStyle ? careerStyle.z[a.key] : null;
                      const csig = cz != null && careerStyle != null && Math.abs(cz) >= careerStyle.se;
                      return (
                        <tr key={a.key}>
                          <td title={a.note ?? undefined}>{a.label}</td>
                          <td className={sig ? undefined : styles.dim}>
                            {signed(z, 2)}
                            {sig ? "" : " ≈"}
                          </td>
                          <td>
                            {radarSeason.style.raw[a.raw].toFixed(1)}
                            {a.unit}
                          </td>
                          <td className={styles.dim}>
                            {radarSeason.style.lg[a.raw].toFixed(1)}
                            {a.unit}
                          </td>
                          <td className={csig ? undefined : styles.dim}>{cz == null ? "-" : `${signed(cz, 2)}${csig ? "" : " ≈"}`}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className={styles.legend}>
                <span>
                  <i className={styles.swSeason} />
                  {seasonLabel(radarSeason.seasonName)} 시즌
                </span>
                {careerStyle && (
                  <span>
                    <i className={styles.swCareer} />
                    통산 {careerStyle.n}시즌 평균(SE ±{careerStyle.se.toFixed(2)})
                  </span>
                )}
                <span>
                  <i className={styles.swLeague} />
                  리그 평균(z 0) · 바깥 테두리 +2
                </span>
                <span>
                  <i className={styles.swGray} />
                  회색 · ≈ = |z| &lt; SE, 리그 평균 수준
                </span>
              </div>
              {!careerStyle && <div className={styles.note}>통산 z는 {CAREER_MIN_SEASONS}시즌 이상일 때만 만든다(현재 {styled.length}시즌).</div>}
            </div>
          </div>
          <div className={styles.aux}>
            <span>
              보조 수치(신뢰도 낮음 · z 오차 ±0.6) — eFG% <b>{radarSeason.style.raw.efg.toFixed(1)}%</b> <span className={styles.dim}>(리그 {radarSeason.style.lg.efg.toFixed(1)}% · z {signed(radarSeason.style.z.efg, 2)})</span>
            </span>
            <span>
              FTr <b>{radarSeason.style.raw.ftr.toFixed(1)}%</b> <span className={styles.dim}>(리그 {radarSeason.style.lg.ftr.toFixed(1)}% · z {signed(radarSeason.style.z.ftr, 2)})</span>
            </span>
          </div>
          <ul className={styles.captions}>
            <li>{STYLE_CAPTION}</li>
            {radarSeason.seasonName === partialSeason?.seasonName && <li>표본 주의: {PARTIAL_SEASON_NOTE}.</li>}
            {radarSeason.seasonName === SHORT_SEASON && <li>표본 주의: 2019-20은 팀당 42~43경기라 z 표준오차가 약 13% 커진다.</li>}
            {radarSeason.seasonName <= "2013-2014" && <li>기록 주의: 2011-12~2013-14 속공(217)은 0건으로 기록된 경기가 많아 속공 축은 시즌 내 상대값으로만 읽을 것.</li>}
          </ul>
        </section>
      )}

      {/* (d) 챌린지 사용 성향 - 리그 요약은 항상 최신 1행이라, 이 감독의 기록이 없으면 카드째 뺀다 */}
      {challengeLeague && challenges.length > 0 && (
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <span className={styles.cardTitle}>코치 챌린지 사용 성향</span>
            <span className={styles.cardKicker}>
              {seasonLabel(challengeLeague.seasonName)} 정규시즌 {challengeLeague.windowFrom.slice(5).replace("-", "/")}~{challengeLeague.windowTo.slice(5).replace("-", "/")} · {challengeLeague.games}경기
            </span>
          </div>
          <p className={styles.leagueLine}>
            리그: 경기당 {challengeLeague.perGame.toFixed(2)}회, 팀당 허용 3회 중 평균 {challengeLeague.perTeamGame.toFixed(2)}회 사용, 3회 이상 기록 {Math.round(challengeLeague.all3Pct * 100)}%, Q4·연장{" "}
            {(challengeLeague.q4Pct * 100).toFixed(1)}%(5분 미만 {challengeLeague.q4Under5}건 · 2분 미만 {challengeLeague.q4Under2}건), 챌린지 시점 열세 {challengeLeague.trailingN} · 동점 {challengeLeague.tiedN} · 우세{" "}
            {challengeLeague.leadingN}
          </p>
          {challenges.map((c) => (
            <div key={c.seasonName + c.tcode} className={styles.chGrid}>
              {/* 이 카드의 주인공 숫자 하나 = 경기당 사용 */}
              <div className={styles.tile}>
                <div className={`${styles.tileVal} ${styles.tileValLead}`}>
                  {c.perGame.toFixed(2)}
                  <span className={styles.tileSe}>±{c.sePoisson.toFixed(2)}</span>
                </div>
                <div className={styles.tileLabel}>
                  {seasonLabel(c.seasonName)} 경기당 사용 · {c.games}경기 {c.challenges}회
                </div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileVal}>{Math.round(c.all3Pct * 100)}%</div>
                <div className={styles.tileLabel}>{seasonLabel(c.seasonName)} 3회 이상 기록된 경기</div>
              </div>
              <div className={styles.tile}>
                <div className={styles.tileVal}>
                  {c.q4Pct == null ? "-" : `${Math.round(c.q4Pct * 100)}%`}
                  {c.q4Se != null && <span className={styles.tileSe}>±{Math.round(c.q4Se * 100)}%p</span>}
                </div>
                <div className={styles.tileLabel}>{seasonLabel(c.seasonName)} Q4·연장 비율(경향)</div>
              </div>
            </div>
          ))}
          <ul className={styles.captions}>
            <li>{CHALLENGE_CAPTION}</li>
            <li>{CHALLENGE_ALL3_NOTE}</li>
            <li>Q4·연장 비율의 분모는 그 감독의 챌린지 건수(경기 수가 아님) · 약한 신호(셔플 P=0.045, 반분 r=0.38)라 경향으로만 읽을 것 · 성공률·WPA·순위 없음</li>
          </ul>
        </section>
      )}

      {/* (e) 측정 중 */}
      <div className={styles.measuring}>{MEASURING_NOTE}</div>
    </div>
  );
}
