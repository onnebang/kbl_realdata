// 커스텀 지표의 "모양"만 - **Supabase를 import하지 않는다.**
//
// 이 파일이 따로 있는 이유: components/CustomMetricBuilder.tsx("use client")가 여기 상수와
// 타입을 가져다 쓴다. 예전에는 lib/customMetric.ts에서 가져왔는데, 그 파일 1행이
// import { supabase } 라 모듈 전체가 클라이언트 번들로 끌려갔다. 그 결과 브라우저에
// @supabase/supabase-js 63.2KB(br)와 **공개 키가 실려 나갔다** - 정작 그 화면은 Supabase를
// 한 줄도 호출하지 않는데(슬라이더 계산은 서버가 미리 넘긴 z-score로만 한다).
//
// 규칙: 이 파일에는 데이터 조회를 넣지 마라. 조회는 lib/customMetric.ts에.

export const METRIC_COMPONENTS = [
  { key: "ppg", label: "PPG", invert: false },
  { key: "rpg", label: "RPG", invert: false },
  { key: "apg", label: "APG", invert: false },
  { key: "spg", label: "SPG", invert: false },
  { key: "bpg", label: "BPG", invert: false },
  { key: "tovpg", label: "TOV", invert: true },
  { key: "fgPct", label: "FG%", invert: false },
  { key: "tpPct", label: "3P%", invert: false },
  { key: "ftPct", label: "FT%", invert: false },
] as const;
export type ComponentKey = (typeof METRIC_COMPONENTS)[number]["key"];

export type MetricPlayerRow = {
  pcode: string;
  name: string;
  tcode: string;
  teamName: string;
  teamAbbr: string;
  teamColor: string;
  teamLogoUrl: string | null;
  gp: number;
  raw: Record<ComponentKey, number>;
  z: Record<ComponentKey, number>;
};

