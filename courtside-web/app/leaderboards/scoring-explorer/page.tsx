import { getAllEntityOptions, type Dimension, type EntityOption } from "@/lib/scoringExplorer";
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
const DIMS: Dimension[] = ["team", "player", "coach", "league"];

// searchParams가 없어져(엔티티 전환은 이제 클라이언트 Server Action) Next.js가 이 페이지를
// 정적으로 프리렌더할 수 있다고 오판함 - 그러면 기본 진입 화면이 빌드 시점 스냅샷으로
// 고정돼버려서(CLAUDE.md 핵심 원칙: "반드시 라이브 Supabase 쿼리") force-dynamic으로 매
// 요청마다 다시 조회하게 함.
export const dynamic = "force-dynamic";
// 실측(브라우저 검증) - 리그 평균 비교(최근 3시즌) 로딩이 약 30~35초 걸림(팀 하나 전체
// 이력도 최대 ~10초). Vercel 기본 서버리스 함수 제한(Hobby 플랜도 설정하면 최대 60초까지
// 가능)을 넘기지 않도록 이 라우트(및 여기서 호출되는 Server Action)의 maxDuration을
// 명시적으로 늘려둠 - 안 하면 프로덕션에서 이 상호작용만 조용히 타임아웃날 위험이 있음.
export const maxDuration = 60;

export default async function ScoringExplorerPage() {
  const entries = await Promise.all(DIMS.map(async (d) => [d, await getAllEntityOptions(d)] as const));
  const entityOptionsByDim = Object.fromEntries(entries) as Record<Dimension, EntityOption[]>;

  // 기본 진입 엔티티 - 원본 아티팩트는 "시도 최다 팀부터"였지만 그 정렬 기준(shot_log 전체
  // 스캔)이 무거워서 팀 목록 첫 번째(이름순)로 단순화(정확한 사유는 lib/scoringExplorer.ts의
  // getAllEntityOptions 주석). 격자 데이터는 여기서 안 불러옴 - 위 주석 참고.
  const defaultEntity = entityOptionsByDim.team[0] ?? null;

  return (
    <div className={styles.pageRoot}>
      <div className={styles.wrap}>
        <div className={styles.title}>득점 분포 탐색기</div>
        <div className={styles.subtitle}>
          감독·선수·팀별로 슛을 어느 구역에서 얼마나 시도했는지, 시즌이 지나며 그 패턴이 어떻게
          바뀌었는지 - 코트를 15x15 칸으로 나눠 시도 밀도를 열지도(짙을수록 시도 많음)로 보여줌.
          ▶ 재생을 누르면 시즌 순서대로 자동 전환됨.
        </div>

        <ScoringExplorerClient entityOptionsByDim={entityOptionsByDim} initialDim="team" initialEntity={defaultEntity} />
      </div>
    </div>
  );
}
