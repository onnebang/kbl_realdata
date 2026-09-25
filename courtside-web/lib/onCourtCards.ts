import type { CourtCardInfo } from "./courtCardInfo"; // 타입만 - 값을 가져오면 OVR JSON이 브라우저 번들로 들어간다

// components/OnCourtCards.tsx의 재료를 만드는 순수 함수들(클라이언트 안전: lib/ovr.ts·JSON을 import하지 않는다).

export type OnCourtCardPlayer = {
  pcode: string;
  name: string;
  backNum: string | null;
  photoUrl: string | null;
  info: CourtCardInfo | null;
  pts: number;
  reb: number;
  ast: number;
  fouls: number;
  /** 지금 스크럽 시점까지 코트 위에 있던 시간(초). GameReplay의 liveSec. */
  sec: number;
  isTop: boolean;
};

export type OnCourtCardTeam = {
  tcode: string;
  name: string;
  abbr: string;
  color: string;
  logoUrl: string | null;
  players: OnCourtCardPlayer[];
};

/**
 * OVR 등급 - 문턱은 components/CourtsidePlayerCard.tsx tierClass의 복사본(92/89/85/75).
 * 그 파일에서 import하지 않은 이유: 그쪽은 CSS 모듈 클래스를 돌려주는 컴포넌트 내부 함수라 값만 뽑아 쓸 수 없다.
 * 문턱을 바꾸면 두 곳을 같이 고칠 것.
 */
export type OvrTier = "elite" | "gold" | "silver" | "bronze" | "base";
export function ovrTier(ovr: number): OvrTier {
  if (ovr >= 92) return "elite";
  if (ovr >= 89) return "gold";
  if (ovr >= 85) return "silver";
  if (ovr >= 75) return "bronze";
  return "base";
}

/** lib/ovr.ts isRealPcode의 복사본(같은 이유로 import 불가). tbd_<이름>은 KBL이 발급한 pcode가 아니라 /players/... 링크가 404다. */
export const isLinkablePcode = (pcode: string): boolean => pcode !== "" && !pcode.startsWith("tbd_");

const POS_RANK = { G: 0, F: 1, C: 2 } as const;

/**
 * 카드 순서: 포지션(G→F→C, 모르면 맨 뒤) -> OVR 높은 순 -> 이름. 득점 순(아래 표의 정렬)으로 하지 않은 이유 -
 * 슛이 들어갈 때마다 카드가 자리를 바꾸면 눈으로 따라갈 수 없다. 이 키들은 스크럽 위치와 무관해 교체가 없으면 순서가 그대로다.
 */
export function orderOnCourt(list: OnCourtCardPlayer[]): OnCourtCardPlayer[] {
  const rank = (p: OnCourtCardPlayer) => (p.info?.position ? POS_RANK[p.info.position] : 3);
  return [...list].sort((a, b) => rank(a) - rank(b) || (b.info?.ovr ?? -1) - (a.info?.ovr ?? -1) || a.name.localeCompare(b.name, "ko"));
}

/** GameReplay 박스스코어 한 줄 중 카드가 쓰는 부분(BoxLine의 부분집합이라 그대로 넘겨도 된다). */
type MiniBox = { pts: number; reb: number; ast: number; foul: number };

/** 한 팀의 "지금 코트 위" 카드 재료. homeOnCourt/awayOnCourt·box·liveSec는 GameReplay가 이미 계산해 둔 값을 그대로 받는다. */
export function buildOnCourtTeam(
  team: { tcode: string; name: string; abbr: string; color: string; logoUrl: string | null },
  players: { pcode: string; name: string; tcode: string; photoUrl?: string | null; backNum?: string | null }[],
  onCourt: ReadonlySet<string>,
  box: ReadonlyMap<string, MiniBox>,
  liveSec: ReadonlyMap<string, number>,
  cardInfo: Record<string, CourtCardInfo> | undefined,
  topPcode: string | null
): OnCourtCardTeam {
  const list = players
    .filter((p) => p.tcode === team.tcode && onCourt.has(p.pcode))
    .map((p): OnCourtCardPlayer => {
      const b = box.get(p.pcode);
      return {
        pcode: p.pcode,
        name: p.name,
        backNum: p.backNum ?? null,
        photoUrl: p.photoUrl ?? null,
        info: cardInfo?.[p.pcode] ?? null,
        pts: b?.pts ?? 0,
        reb: b?.reb ?? 0,
        ast: b?.ast ?? 0,
        fouls: b?.foul ?? 0,
        sec: liveSec.get(p.pcode) ?? 0,
        isTop: p.pcode === topPcode,
      };
    });
  return { tcode: team.tcode, name: team.name, abbr: team.abbr, color: team.color, logoUrl: team.logoUrl, players: orderOnCourt(list) };
}
