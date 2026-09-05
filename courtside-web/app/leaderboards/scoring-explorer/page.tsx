import Link from "next/link";
import { getAllEntityOptions, type Dimension, type EntityOption } from "@/lib/scoringExplorer";
import {
  getSeasonsForScatter,
  getShotValueScatterData,
  buildShotValueScatterSvg,
  scatterBubbleRadius,
  SCATTER_VIEWBOX,
  SCATTER_TIER_COLOR,
  MIN_SAMPLE,
} from "@/lib/shotValueScatter";
import ScoringExplorerClient from "@/components/ScoringExplorerClient";
import styles from "./scoring-explorer.module.css";

// web/scoring_distribution_template.html 리디자인(리디자인 대상: 이 leaderboards 그룹에서
// 가장 상호작용이 많은 페이지 - 검색 가능한 엔티티 드롭다운 + 리그 평균 비교 + 시즌 재생
// 애니메이션). 최초 진입 시 팀/선수/코치/리그 각각의 "전체 이력 상 모든 엔티티" 목록(검색
// 드롭다운용, teams/players/coaches 테이블 직독이라 가벼움)만 서버에서 로드 - 기본 엔티티의
// 전체 15시즌 격자 자체는 SSR에서 미리 굽지 않고 ScoringExplorerClient가 마운트되자마자
// Server Action으로 불러옴(실측: 시도 많은 팀 하나의 전체 이력이 최대 약 10초 걸림 - 이걸
// SSR에서 기다리면 페이지 첫 응답 자체가 그만큼 늦어지니, 로딩 표시를 보여주고 클라이언트가
// 비동기로 가져오는 편이 체감상 낫다고 판단). 이후 엔티티 전환도 같은 Server Action, 재생/
// 스크럽은 클라이언트 메모리로 처리(자세한 이유는 lib/scoringExplorer.ts 상단 주석).
// team/player는 뺐다 - 팀·선수 페이지의 히어로 밀도 지도와 같은 데이터이고 그쪽이 더 낫다
// (가우시안 블러·등고선·팀 컬러, 선수 쪽은 기대값 대비 잔차 색까지). 여기 남길 이유는
// "리그 전체가 15시즌 동안 어디서 던지게 됐는가" 하나뿐이고, 그건 다른 어디에도 없다.
const DIMS: Dimension[] = ["league", "coach"];

// 새 탭("고효율 슛 선택과 슈팅 효율" 산점도) - 기존 히트맵 탐색기는 엔티티 검색/재생 애니메이션이
// 필요해 클라이언트 상태(ScoringExplorerClient)가 필수였지만, 이 탭은 "시즌 하나 고르면 리그
// 전체 로스터가 한 번에 뜨는" 단순 조회라 이 사이트 기본 컨벤션(query-param + <form> GET, JS
// 없음)으로 충분 - 탭 자체도 ?tab=으로 전환.
type TabKey = "heatmap" | "scatter";
// 순서를 뒤집었다 - 사용자가 실제로 쓰는 화면(산점도)이 기본이어야 한다.
const TABS: { key: TabKey; label: string }[] = [
  { key: "scatter", label: "슛 선택 지도" },
  { key: "heatmap", label: "리그 슛 선택의 변화" },
];

// searchParams가 없어져(엔티티 전환은 이제 클라이언트 Server Action) Next.js가 이 페이지를
// 정적으로 프리렌더할 수 있다고 오판함 - 그러면 기본 진입 화면이 빌드 시점 스냅샷으로
// 고정돼버려서(CLAUDE.md 핵심 원칙: "반드시 라이브 Supabase 쿼리") force-dynamic으로 매
// 요청마다 다시 조회하게 함. (산점도 탭도 searchParams를 쓰긴 하지만, force-dynamic은 이미
// 걸려있으므로 별도 처리 불필요.)
export const dynamic = "force-dynamic";
// 실측(브라우저 검증) - 리그 평균 비교(최근 3시즌) 로딩이 약 30~35초 걸림(팀 하나 전체
// 이력도 최대 ~10초). Vercel 기본 서버리스 함수 제한(Hobby 플랜도 설정하면 최대 60초까지
// 가능)을 넘기지 않도록 이 라우트(및 여기서 호출되는 Server Action)의 maxDuration을
// 명시적으로 늘려둠 - 안 하면 프로덕션에서 이 상호작용만 조용히 타임아웃날 위험이 있음.
// 산점도 탭(시즌 전체 game_player_stats + shot_log 병렬 페이지네이션)도 같은 라우트라 이
// 한도를 그대로 공유.
export const maxDuration = 60;

function ScatterLegend({ tsaMin, tsaMax }: { tsaMin: number; tsaMax: number }) {
  const steps = 4;
  const vals = Array.from({ length: steps }, (_, i) => {
    const raw = tsaMin + (i / (steps - 1)) * (tsaMax - tsaMin);
    return Math.max(1, Math.round(raw / 25) * 25);
  }).filter((v, i, arr) => arr.indexOf(v) === i);

  return (
    <div className={styles.scatterLegendRow}>
      <span className={styles.scatterLegendGroup}>
        {vals.map((v) => (
          <span key={v} className={styles.scatterLegendItem}>
            <span
              className={styles.scatterLegendDot}
              style={{ width: scatterBubbleRadius(v, tsaMin, tsaMax) * 2, height: scatterBubbleRadius(v, tsaMin, tsaMax) * 2 }}
            />
            {v}회
          </span>
        ))}
      </span>
      <span className={styles.scatterLegendGroup}>
        <span className={styles.scatterLegendItem}>
          <span className={styles.scatterLegendSwatch} style={{ background: SCATTER_TIER_COLOR.both }} />
          둘 다 평균 이상
        </span>
        <span className={styles.scatterLegendItem}>
          <span className={styles.scatterLegendSwatch} style={{ background: SCATTER_TIER_COLOR.psaOnly }} />
          효율만 높음
        </span>
        <span className={styles.scatterLegendItem}>
          <span className={styles.scatterLegendSwatch} style={{ background: SCATTER_TIER_COLOR.moreyOnly }} />
          슛선택만 좋음
        </span>
        <span className={styles.scatterLegendItem}>
          <span className={styles.scatterLegendSwatch} style={{ background: SCATTER_TIER_COLOR.neither }} />
          둘 다 평균 이하
        </span>
      </span>
    </div>
  );
}

export default async function ScoringExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; season?: string }>;
}) {
  const { tab, season } = await searchParams;
  const activeTab: TabKey = tab === "heatmap" ? "heatmap" : "scatter";

  return (
    <div className={styles.pageRoot}>
      <div className={styles.wrap}>
        <div className={styles.title}>슈팅 리포트</div>
        <div className={styles.subtitle}>
          &quot;어디서 던지느냐&quot;와 &quot;그 자리를 득점으로 바꾸느냐&quot;는 다른 문제입니다. 앞 화면은 선수 한 명씩
          그 둘을 좌표로 찍어 리그 안에서의 자리를 보여주고, 뒤 화면은 KBL 전체의 슛 선택이 15시즌 동안
          어떻게 옮겨 갔는지를 보여줍니다. 팀·선수 개인의 슛 지도는 각자의 상세 페이지에 더 자세히 있습니다.
        </div>

        <div className={styles.tabRow}>
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={t.key === "heatmap" ? "?tab=heatmap" : `?tab=scatter${season ? `&season=${encodeURIComponent(season)}` : ""}`}
              className={`${styles.tabLink} ${activeTab === t.key ? styles.tabLinkActive : ""}`}
            >
              {t.label}
            </Link>
          ))}
        </div>

        {activeTab === "heatmap" ? (
          <HeatmapTab />
        ) : (
          <ScatterTab activeSeason={season} />
        )}
      </div>
    </div>
  );
}

async function HeatmapTab() {
  const entries = await Promise.all(DIMS.map(async (d) => [d, await getAllEntityOptions(d)] as const));
  const entityOptionsByDim = Object.fromEntries(entries) as Record<Dimension, EntityOption[]>;

  // 기본 진입 엔티티 - 원본 아티팩트는 "시도 최다 팀부터"였지만 그 정렬 기준(shot_log 전체
  // 스캔)이 무거워서 팀 목록 첫 번째(이름순)로 단순화(정확한 사유는 lib/scoringExplorer.ts의
  // getAllEntityOptions 주석). 격자 데이터는 여기서 안 불러옴 - 위 주석 참고.
  // 기본은 리그 - 이 화면이 남은 이유 자체가 "리그 전체의 변화"다.
  const defaultEntity = entityOptionsByDim.league[0] ?? null;

  return <ScoringExplorerClient entityOptionsByDim={entityOptionsByDim} initialDim="league" initialEntity={defaultEntity} />;
}

async function ScatterTab({ activeSeason }: { activeSeason?: string }) {
  const seasons = await getSeasonsForScatter();
  const season = activeSeason && seasons.includes(activeSeason) ? activeSeason : seasons[0];
  const data = season ? await getShotValueScatterData(season) : null;
  const svg = data ? buildShotValueScatterSvg(data) : "";

  return (
    <div className={styles.panel}>
      <div className={styles.scatterTitle}>슛 선택 지도 - 좋은 자리에서 던지는가, 그 자리를 살리는가</div>
      <div className={styles.scatterSubtitle}>
        선수 한 명이 점 하나 - 가로축은 Morey Rate(림/3점/자유투처럼 &ldquo;기대값 좋은&rdquo; 슛이
        전체 TSA에서 차지하는 비중), 세로축은 PSA(시도 하나당 실제 득점). 버블 크기는 TSA(true shot
        attempts, 이 시즌 이 선수의 슛 시도 표본량). TSA {MIN_SAMPLE}회 미만은 표본 부족으로 제외.
      </div>

      <form className={styles.seasonForm}>
        <input type="hidden" name="tab" value="scatter" />
        <select name="season" defaultValue={season} className={styles.seasonSelect}>
          {seasons.map((s) => (
            <option key={s} value={s}>
              {s} 시즌
            </option>
          ))}
        </select>
        <button type="submit" className={styles.seasonSubmit}>
          시즌 보기
        </button>
      </form>

      {data && data.players.length > 0 ? (
        <>
          <svg className={styles.scatterSvg} viewBox={SCATTER_VIEWBOX} dangerouslySetInnerHTML={{ __html: svg }} />
          <ScatterLegend tsaMin={data.tsaMin} tsaMax={data.tsaMax} />
          <div className={styles.scatterHint}>
            점을 클릭하면 그 선수 프로필로 이동 · 마우스를 올리면 이름/팀/PSA/Morey Rate/TSA 표시 ·
            평균에서 크게 벗어난 선수와 TSA 상위 선수만 이름을 항상 표시(나머지는 점+호버로 확인).
          </div>
        </>
      ) : (
        <div className={styles.emptyNote}>이 시즌은 표본 기준(TSA {MIN_SAMPLE}회 이상)을 충족하는 선수가 없음</div>
      )}
    </div>
  );
}
