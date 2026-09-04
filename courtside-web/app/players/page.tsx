import Link from "next/link";
import { PlayerPhoto } from "@/components/PlayerPhoto";
import type { CSSProperties } from "react";
import { TeamBadge } from "@/components/TeamBadge";
import { PRESEASON_SEASON, getSeasonDirectory, shortSeason, prevSeasonName, type DirectoryPlayer } from "@/lib/preseason";
import styles from "@/components/Directory.module.css";

// 선수 디렉터리(요청: "상단 메뉴에 선수 자세히 보기") - 이 시즌 확정 로스터 전원을 팀별로 늘어놓고
// 프로필(/players/[pcode])로 보낸다. 아직 KBL 출전 기록이 없는 신입은 pcode가 없어 링크가
// 없고, 첫 경기 출전 시 자동으로 연결된다. 검색/팀 필터는 이 사이트 관례대로 query string
// (클라이언트 JS 없음).
export const dynamic = "force-dynamic";

function normalize(s: string) {
  return s.replace(/[\s·.'\-]+/g, "").toLowerCase();
}

function PlayerRow({ p, prev }: { p: DirectoryPlayer; prev: string }) {
  const sub = [p.pos, p.role, p.gp != null && p.ppg != null ? `${p.prevSeason ? shortSeason(p.prevSeason) : prev} ${p.gp}G ${p.ppg.toFixed(1)}P` : null, p.registryStatus]
    .filter(Boolean)
    .join(" · ");
  const inner = (
    <>
      {p.photoUrl ? (
        <PlayerPhoto src={p.photoUrl} size={34} className={styles.photo} />
      ) : (
        <div className={styles.photoFallback}>{p.backNum ?? "·"}</div>
      )}
      <div className={styles.num}>{p.backNum ?? ""}</div>
      <div className={styles.nameCell}>
        <div className={styles.name}>{p.name}</div>
        <div className={styles.sub}>{sub || (p.pcode ? "" : "KBL 첫 시즌")}</div>
      </div>
      <div>
        {p.role ? (
          <span className={`${styles.tag} ${styles.tagForeign}`}>{p.role.replace("외국인 ", "")}</span>
        ) : p.departure ? (
          // 명부에는 있지만 이 시즌엔 안 뛴다 - 다른 태그보다 이게 먼저 읽혀야 한다.
          <span className={`${styles.tag} ${styles.tagOut}`}>{p.departure.label}</span>
        ) : p.change === "in" ? (
          <span className={`${styles.tag} ${styles.tagIn}`}>영입</span>
        ) : p.change === "back" ? (
          <span className={`${styles.tag} ${styles.tagBack}`}>복귀</span>
        ) : p.change === "new" || !p.pcode ? (
          <span className={`${styles.tag} ${styles.tagNew}`}>신입</span>
        ) : null}
      </div>
    </>
  );
  return p.pcode ? (
    <Link href={`/players/${p.pcode}`} className={styles.playerRow}>
      {inner}
    </Link>
  ) : (
    <div className={`${styles.playerRow} ${styles.playerRowMuted}`}>{inner}</div>
  );
}

export default async function PlayersPage({ searchParams }: { searchParams: Promise<{ q?: string; team?: string }> }) {
  const { q, team } = await searchParams;
  const directory = await getSeasonDirectory(PRESEASON_SEASON);
  const prev = shortSeason(prevSeasonName(PRESEASON_SEASON));
  const query = (q ?? "").trim();
  const nq = normalize(query);

  const shown = directory
    .filter((t) => !team || t.team.tcode === team)
    .map((t) => ({ ...t, players: nq ? t.players.filter((p) => normalize(p.name).includes(nq)) : t.players }))
    .filter((t) => t.players.length > 0);
  const total = directory.reduce((s, t) => s + t.players.length, 0);
  const shownN = shown.reduce((s, t) => s + t.players.length, 0);

  return (
    <div className="wrap">
      <div className={styles.head}>
        <div className="title">선수 자세히 보기</div>
        <span className={styles.kicker}>
          {PRESEASON_SEASON} 확정 로스터 · {total}명
        </span>
      </div>
      <p className={styles.lede}>
        이름을 누르면 선수 프로필(퍼센타일·슛 임팩트·슈팅 DNA·클러치·시너지·커리어 아크)로 들어갑니다. 국내 선수는 KBL 등록 명부, 외국인·아시아쿼터는 구단
        확정 발표 기준이고, 성적은 그 선수의 마지막 KBL 시즌(정규+플레이오프 합산) 평균입니다.
      </p>

      <div className={styles.filters}>
        <form className={styles.search} action="/players">
          {team && <input type="hidden" name="team" value={team} />}
          <input type="search" name="q" defaultValue={query} placeholder="선수 이름 검색" aria-label="선수 이름 검색" />
          <button type="submit" className="btn-primary">
            검색
          </button>
        </form>
        <Link href={query ? `/players?q=${encodeURIComponent(query)}` : "/players"} className={`${styles.chip} ${!team ? styles.chipActive : ""}`}>
          전체
        </Link>
        {directory.map((t) => (
          <Link
            key={t.team.tcode}
            href={`/players?team=${t.team.tcode}${query ? `&q=${encodeURIComponent(query)}` : ""}`}
            className={`${styles.chip} ${team === t.team.tcode ? styles.chipActive : ""}`}
          >
            {t.team.abbr}
          </Link>
        ))}
      </div>

      {shown.length === 0 && <div className="empty-note">{query ? `"${query}"에 해당하는 선수가 확정 로스터에 없습니다.` : "확정 로스터가 아직 없습니다."}</div>}

      {shown.map((t) => (
        <section key={t.team.tcode} className={styles.teamSection} style={{ "--team": t.team.color } as CSSProperties}>
          <Link href={`/teams/${t.team.tcode}?season=${PRESEASON_SEASON}`} className={styles.teamSectionHead}>
            <TeamBadge team={{ name: t.team.name, abbr: t.team.abbr, color: t.team.color, logoUrl: t.team.logoUrl }} size={22} />
            {t.team.name}
            <span className={styles.teamSectionCount}>{t.players.length}명</span>
          </Link>
          <div className={styles.playerGrid}>
            {t.players.map((p) => (
              <PlayerRow key={`${p.pcode ?? "new"}-${p.name}`} p={p} prev={prev} />
            ))}
          </div>
        </section>
      ))}

      <div className={styles.note}>
        {query || team ? `${shownN}명 표시 / 전체 ${total}명. ` : ""}
        &quot;등록상태 별도&quot;는 KBL 명부에서 현역(A)이 아닌 코드(C/D)로 등록된 선수로, 군복무·육성 등으로 추정되나 확인되지 않았습니다. 감독·코치는 제외.
      </div>
    </div>
  );
}
