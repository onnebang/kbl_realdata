import type { Metadata } from "next";
import Link from "next/link";
import { PlayerPhoto } from "@/components/PlayerPhoto";
import type { CSSProperties } from "react";
import { TeamBadge } from "@/components/TeamBadge";
import { PRESEASON_SEASON, getSeasonDirectory, shortSeason, prevSeasonName, type DirectoryPlayer } from "@/lib/preseason";
import { getOvrHistoryCache } from "@/lib/ovr";
import styles from "@/components/Directory.module.css";

// 선수 디렉터리(요청: "상단 메뉴에 선수 자세히 보기") - 이 시즌 확정 로스터 전원을 팀별로 늘어놓고
// 프로필(/players/[pcode])로 보낸다. 아직 KBL 출전 기록이 없는 신입은 pcode가 없어 링크가
// 없고, 첫 경기 출전 시 자동으로 연결된다. 검색/팀 필터는 이 사이트 관례대로 query string
// (클라이언트 JS 없음).
export const dynamic = "force-dynamic";

function normalize(s: string) {
  return s.replace(/[\s·.'\-]+/g, "").toLowerCase();
}

function getTierClass(ovr: number | null) {
  if (ovr === null) return "";
  if (ovr >= 92) return styles.tierElite;
  if (ovr >= 89) return styles.tierGold;
  if (ovr >= 85) return styles.tierSilver;
  if (ovr >= 75) return styles.tierBronze;
  return styles.tierBase;
}

function PlayerRow({ p, prev, ovr, ovrDiff }: { p: DirectoryPlayer; prev: string; ovr: number | null; ovrDiff: number | null }) {
  const subTokens = [
    p.pos, 
    p.role, 
    p.gp != null && p.ppg != null ? `${p.prevSeason ? shortSeason(p.prevSeason) : prev} ${p.gp}G ${p.ppg.toFixed(1)}P` : null, 
    p.registryStatus
  ].filter(Boolean);

  const inner = (
    <>
      {p.photoUrl ? (
        <PlayerPhoto src={p.photoUrl} size={34} className={styles.photo} />
      ) : (
        <div className={styles.photoFallback}>{p.backNum ?? "·"}</div>
      )}
      <div className={`${styles.num} ${getTierClass(ovr)}`}>{ovr ?? "-"}</div>
      <div className={styles.nameCell}>
        <div className={styles.name}>{p.name}</div>
        <div className={styles.sub}>
          {ovrDiff !== null && ovrDiff !== 0 && (
            <>
              <span className={ovrDiff > 0 ? styles.ovrUpSub : styles.ovrDownSub}>
                {ovrDiff > 0 ? `▲ ${ovrDiff}` : `▼ ${Math.abs(ovrDiff)}`}
              </span>
              {subTokens.length > 0 && <span className={styles.subSep}> · </span>}
            </>
          )}
          {subTokens.join(" · ") || (p.pcode ? "" : "KBL 첫 시즌")}
        </div>
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

export default async function PlayersPage({ searchParams }: { searchParams: Promise<{ q?: string; team?: string; sort?: string }> }) {
  const { q, team, sort } = await searchParams;
  const directory = await getSeasonDirectory(PRESEASON_SEASON);
  const prev = shortSeason(prevSeasonName(PRESEASON_SEASON));
  const query = (q ?? "").trim();
  const nq = normalize(query);

  const ovrCache = getOvrHistoryCache();
  const ovrMap = new Map<string, { ovr: number; diff: number | null }>();
  const ovrMapByName = new Map<string, { ovr: number; diff: number | null }>();
  const byPcode = new Map<string, typeof ovrCache>();
  for (const r of ovrCache) {
    // If there's no pcode but they have an OVR record, we group by name
    const key = r.pcode || r.name;
    if (!byPcode.has(key)) byPcode.set(key, []);
    byPcode.get(key)!.push(r);
  }
  for (const [key, hist] of byPcode) {
    if (hist.length > 0) {
      const current = hist[hist.length - 1].OVR;
      const diff = hist.length > 1 ? current - hist[hist.length - 2].OVR : null;
      if (hist[0].pcode) {
        ovrMap.set(hist[0].pcode, { ovr: current, diff });
      } else {
        ovrMapByName.set(hist[0].name, { ovr: current, diff });
      }
    }
  }

  let shown = directory
    .filter((t) => !team || t.team.tcode === team)
    .map((t) => {
      const filteredPlayers = nq ? t.players.filter((p) => normalize(p.name).includes(nq)) : [...t.players];
      filteredPlayers.sort((a, b) => {
        const aData = a.pcode ? ovrMap.get(a.pcode) : ovrMapByName.get(a.name);
        const bData = b.pcode ? ovrMap.get(b.pcode) : ovrMapByName.get(b.name);
        const aOvr = aData?.ovr ?? -1;
        const bOvr = bData?.ovr ?? -1;
        return bOvr - aOvr || a.name.localeCompare(b.name);
      });
      return { ...t, players: filteredPlayers };
    })
    .filter((t) => t.players.length > 0);

  const total = directory.reduce((s, t) => s + t.players.length, 0);
  const shownN = shown.reduce((s, t) => s + t.players.length, 0);

  const isOvrSort = sort === "ovr";
  let flatPlayers: DirectoryPlayer[] = [];
  if (isOvrSort) {
    flatPlayers = shown.flatMap(t => t.players);
    flatPlayers.sort((a, b) => {
      const aData = a.pcode ? ovrMap.get(a.pcode) : ovrMapByName.get(a.name);
      const bData = b.pcode ? ovrMap.get(b.pcode) : ovrMapByName.get(b.name);
      const aOvr = aData?.ovr ?? -1;
      const bOvr = bData?.ovr ?? -1;
      return bOvr - aOvr || a.name.localeCompare(b.name);
    });
  }

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
          {isOvrSort && <input type="hidden" name="sort" value="ovr" />}
          <input type="search" name="q" defaultValue={query} placeholder="선수 이름 검색" aria-label="선수 이름 검색" />
          <button type="submit" className="btn-primary">
            검색
          </button>
        </form>
        <Link href={query ? `/players?q=${encodeURIComponent(query)}` : "/players"} className={`${styles.chip} ${!team && !isOvrSort ? styles.chipActive : ""}`}>
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
        <Link
          href={`/players?sort=ovr${query ? `&q=${encodeURIComponent(query)}` : ""}`}
          className={`${styles.chip} ${isOvrSort ? styles.chipActive : ""}`}
        >
          오버롤 순
        </Link>
      </div>

      {shownN === 0 && <div className="empty-note">{query ? `"${query}"에 해당하는 선수가 확정 로스터에 없습니다.` : "확정 로스터가 아직 없습니다."}</div>}

      {isOvrSort ? (
        <section className={styles.teamSection} style={{ "--team": "var(--ink)" } as CSSProperties}>
          <div className={styles.teamSectionHead}>
            전체 오버롤 랭킹
            <span className={styles.teamSectionCount}>{shownN}명</span>
          </div>
          <div className={styles.playerGrid}>
            {flatPlayers.map((p) => {
               const ovrData = p.pcode ? ovrMap.get(p.pcode) : ovrMapByName.get(p.name);
               return <PlayerRow key={`${p.pcode ?? "new"}-${p.name}`} p={p} prev={prev} ovr={ovrData?.ovr ?? null} ovrDiff={ovrData?.diff ?? null} />;
            })}
          </div>
        </section>
      ) : (
        shown.map((t) => (
          <section key={t.team.tcode} className={styles.teamSection} style={{ "--team": t.team.color } as CSSProperties}>
            <Link href={`/teams/${t.team.tcode}?season=${PRESEASON_SEASON}`} className={styles.teamSectionHead}>
              <TeamBadge team={{ name: t.team.name, abbr: t.team.abbr, color: t.team.color, logoUrl: t.team.logoUrl }} size={22} />
              {t.team.name}
              <span className={styles.teamSectionCount}>{t.players.length}명</span>
            </Link>
            <div className={styles.playerGrid}>
              {t.players.map((p) => {
                 const ovrData = p.pcode ? ovrMap.get(p.pcode) : ovrMapByName.get(p.name);
                 return <PlayerRow key={`${p.pcode ?? "new"}-${p.name}`} p={p} prev={prev} ovr={ovrData?.ovr ?? null} ovrDiff={ovrData?.diff ?? null} />;
              })}
            </div>
          </section>
        ))
      )}

      <div className={styles.note}>
        {query || team || isOvrSort ? `${shownN}명 표시 / 전체 ${total}명. ` : ""}
        &quot;등록상태 별도&quot;는 KBL 명부에서 현역(A)이 아닌 코드(C/D)로 등록된 선수로, 군복무·육성 등으로 추정되나 확인되지 않았습니다. 감독·코치는 제외.
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "선수 자세히 보기",
  description: "KBL 선수 명단 · 확정 로스터와 지난 시즌 기록에서 선수 프로필로",
};
