import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { TeamBadge } from "@/components/TeamBadge";
import { accentFor } from "@/lib/teamAccent";
import { getCoachList, LIST_MIN_GAMES, fmtPct3, seasonLabel, type CoachListRow } from "@/lib/coachPage";
import dir from "@/components/Directory.module.css";
import styles from "./[coachId]/coach-profile.module.css";

// 감독 디렉터리. 위 = 2026-27 현직(팀 배지), 아래 = 통산 표. 표는 '기록 순'(승률 높은 순)일 뿐 순위가
// 아니다 - 결과 F: 팀 통제 후 감독 라벨의 설명력은 무작위와 구분되지 않는다(p=0.21). 108경기 미만은
// 별도 묶음(1시즌 감독의 승률 SE ±.068). 순위 번호는 어디에도 붙이지 않는다.
export const dynamic = "force-dynamic";

function Row({ c }: { c: CoachListRow }) {
  const k = c.career;
  return (
    <tr>
      <td>
        <Link href={`/coaches/${c.coachId}`}>{c.name}</Link>
        {c.currentTeam && <span className={styles.small}> · {seasonLabel(c.currentTeam.seasonName)} {c.currentTeam.abbr}</span>}
      </td>
      <td className={styles.left}>{k ? `${seasonLabel(k.first)}~${seasonLabel(k.last)} · ${k.seasons}시즌` : "-"}</td>
      <td className={styles.left}>{k ? k.teams.map((t) => t.abbr).join(" · ") : "-"}</td>
      <td>{k ? k.g : "-"}</td>
      <td>{k ? `${k.w}-${k.l}` : "-"}</td>
      <td>
        {k ? fmtPct3(k.wpct) : "-"}
        {k && <span className={styles.small}> ±{fmtPct3(k.wpctSe)}</span>}
      </td>
    </tr>
  );
}

function Table({ rows }: { rows: CoachListRow[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>감독</th>
            <th className={styles.left}>재임</th>
            <th className={styles.left}>팀</th>
            <th>G</th>
            <th>W-L</th>
            <th>승률 ±SE</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <Row key={c.coachId} c={c} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function CoachesPage() {
  const list = await getCoachList();
  const current = list.filter((c) => c.currentTeam).sort((a, b) => a.currentTeam!.name.localeCompare(b.currentTeam!.name, "ko"));
  const byWpct = (a: CoachListRow, b: CoachListRow) => (b.career?.wpct ?? -1) - (a.career?.wpct ?? -1) || a.name.localeCompare(b.name, "ko");
  const full = list.filter((c) => (c.career?.g ?? 0) >= LIST_MIN_GAMES).sort(byWpct);
  const thin = list.filter((c) => (c.career?.g ?? 0) < LIST_MIN_GAMES).sort((a, b) => a.name.localeCompare(b.name, "ko"));
  const seasonsAll = list.flatMap((c) => (c.career ? [c.career.first, c.career.last] : [])).sort();
  const first = seasonsAll[0], last = seasonsAll[seasonsAll.length - 1];

  return (
    <div className="wrap">
      <div className={dir.head}>
        <div className="title">감독</div>
        <span className={dir.kicker}>
          정규시즌 {first ? `${seasonLabel(first)}~${seasonLabel(last)}` : ""} · {list.length}명
        </span>
      </div>
      <p className={dir.lede}>
        감독을 고르면 프로필(재임기 승-패·득실, 재임기 팀 스타일, 챌린지 사용 성향)로 들어갑니다. 승-패는 감독이 배정된 시즌의 팀 성적이며 감독 개인의 기여도가 아닙니다 - 감독 간 승률 차이의 대부분은 팀
        전력과 로스터 연속성으로 설명됩니다.
      </p>

      <div className={dir.head}>
        <span className={styles.cardTitle}>{current[0] ? seasonLabel(current[0].currentTeam!.seasonName) : ""} 현직</span>
        <span className={dir.kicker}>{current.length}팀 · 시즌 시작 전이라 통산은 지난 시즌까지</span>
      </div>
      <div className={dir.teamGrid} style={{ marginTop: 10 }}>
        {current.map((c) => {
          const t = c.currentTeam!;
          const k = c.career;
          return (
            <Link key={c.coachId} href={`/coaches/${c.coachId}`} className={dir.teamCard} style={{ "--team": accentFor(t.tcode, t.color) } as CSSProperties}>
              <div className={dir.teamName}>
                <TeamBadge team={{ name: t.name, abbr: t.abbr, color: t.color ?? "#888888", logoUrl: t.logoUrl }} size={30} />
                {c.name}
                <span className={dir.teamAbbr}>{t.abbr}</span>
              </div>
              <div className={dir.teamStats}>
                <div>
                  <div className={dir.statVal}>{k ? `${k.w}-${k.l}` : "-"}</div>
                  <div className={styles.tileLabel}>통산 W-L{k ? ` · ${k.g}G` : ""}</div>
                </div>
                <div>
                  <div className={dir.statVal}>{k ? fmtPct3(k.wpct) : "-"}</div>
                  <div className={styles.tileLabel}>승률{k ? ` ±${fmtPct3(k.wpctSe)}` : ""}</div>
                </div>
                <div>
                  <div className={dir.statVal}>{k ? k.seasons : "-"}</div>
                  <div className={styles.tileLabel}>{k ? `시즌 · ${seasonLabel(k.first)}~${seasonLabel(k.last)}` : "첫 시즌"}</div>
                </div>
              </div>
              <div className={dir.teamLinks}>
                <span>{t.name}{t.confirmed ? "" : " (확인 필요)"} · 프로필</span>
              </div>
            </Link>
          );
        })}
      </div>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>통산 기록</span>
          <span className={styles.cardKicker}>정규시즌 {LIST_MIN_GAMES}경기 이상 · 기록 순(승률 높은 순) - 순위가 아님</span>
        </div>
        <Table rows={full} />
      </section>

      <section className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardTitle}>{LIST_MIN_GAMES}경기 미만</span>
          <span className={styles.cardKicker}>1~2시즌 · 가나다순 · 승률 SE가 ±.05~.07이라 기록 순으로 늘어놓지 않음</span>
        </div>
        <Table rows={thin} />
      </section>

      <div className={dir.note}>
        정규시즌 종료 경기만 집계. 시즌 도중 감독 교체는 반영되지 않음(팀-시즌당 감독 1명으로 기록). 승률 옆 ±는 이항 표준오차. 감독 간 승률 차이의 대부분은 팀 전력·로스터 연속성으로 설명됨(팀 통제 후 감독 라벨 추가
        설명력 p=0.21).
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "감독",
  description: "KBL 감독 목록 · 통산 승패와 재임 팀",
};
