import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { TeamBadge } from "@/components/TeamBadge";
import { PRESEASON_SEASON, getSeasonOutlook, getRosterChangeReport, shortSeason } from "@/lib/preseason";
import styles from "@/components/Directory.module.css";

// 팀 디렉터리(요청: "상단 메뉴에 팀 자세히 보기") - 지금까지 팀 프로필은 경기 카드의 팀 이름을
// 눌러야만 갈 수 있었다. 여기서 10개 구단을 한눈에 보고 프로필로 들어간다. 숫자는 /preseason이
// 이미 계산하는 것(기대승수, 지난 시즌 전적, 로스터 변화 수)을 그대로 재사용 - 새 집계 없음.
export const dynamic = "force-dynamic";

export default async function TeamsPage() {
  const [outlook, roster] = await Promise.all([getSeasonOutlook(PRESEASON_SEASON), getRosterChangeReport(PRESEASON_SEASON)]);
  const changesByTcode = new Map(roster.teams.map((t) => [t.team.tcode, t]));
  const prev = shortSeason(outlook.prevSeason);
  const cur = shortSeason(outlook.season);

  return (
    <div className="wrap">
      <div className={styles.head}>
        <div className="title">팀 자세히 보기</div>
        <span className={styles.kicker}>{outlook.season} · 10개 구단</span>
      </div>
      <p className={styles.lede}>
        구단을 고르면 팀 프로필(4팩터·시즌 여정·로스터 기여도·베스트 유닛·슛 프로필)로 들어갑니다. 아래 숫자는 {prev} 정규시즌 전적, 경기 전 모델이
        {cur} 예정 경기에 매긴 기대승수, 그리고 확정 로스터 기준 변화 수입니다.
      </p>

      <div className={styles.teamGrid}>
        {outlook.teams.map((t) => {
          const ch = changesByTcode.get(t.tcode);
          const rosterN = ch ? ch.in.length + ch.back.length + ch.new.length + ch.stay.length : 0;
          return (
            <Link key={t.tcode} href={`/teams/${t.tcode}?season=${PRESEASON_SEASON}`} className={styles.teamCard} style={{ "--team": t.color } as CSSProperties}>
              <div className={styles.teamName}>
                <TeamBadge team={{ name: t.name, abbr: t.abbr, color: t.color, logoUrl: t.logoUrl }} size={30} />
                {t.name}
                <span className={styles.teamAbbr}>{t.abbr}</span>
              </div>
              <div className={styles.teamStats}>
                <div>
                  <div className={styles.statVal}>
                    {t.prevW}-{t.prevL}
                  </div>
                  <div className={styles.statLabel}>{prev} 정규</div>
                </div>
                <div>
                  <div className={styles.statVal}>{t.expWins.toFixed(1)}</div>
                  <div className={styles.statLabel}>
                    {cur} 기대승 / {t.gp}G
                  </div>
                </div>
                <div>
                  <div className={styles.statVal}>{rosterN || "-"}</div>
                  <div className={styles.statLabel}>
                    확정 로스터{ch ? ` · 영입 ${ch.in.length + ch.new.length}${ch.back.length ? ` · 복귀 ${ch.back.length}` : ""}` : ""}
                  </div>
                </div>
              </div>
              <div className={styles.teamLinks}>
                <span>{cur} 프로필</span>
                <span>{prev} 시즌 보기</span>
                <span>로스터 변화</span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className={styles.note}>
        기대승수는 {prev} 전력(넷레이팅·시너지·홈코트) 기준 모델이라 로스터 변화는 아직 반영되지 않았습니다. 확정 로스터는 KBL 등록 명부(국내)와 구단
        발표(외국인) 기준이며, 첫 경기가 열리면 팀 프로필의 시즌 지표가 채워지기 시작합니다.
      </div>
    </div>
  );
}

export const metadata: Metadata = {
  title: "팀 자세히 보기",
  description: "KBL 팀 목록 · 시즌 전망과 로스터 변화에서 팀 프로필로",
};
