import { describe, expect, it } from "vitest";
import { seasonRebSplit } from "./playerGlance";
import { SEASON_CATEGORY_REGULAR } from "./teamSeasonStats";

// tools/backfill_player_rebound_split.py가 game_player_stats.oreb/dreb를 채웠지만 0.7%는
// null로 남는다(리바운드 이벤트가 없는 경기 + 구시즌 중계 노이즈). 그 경기를 0으로 접으면
// 선수 리바운드가 조용히 낮아지므로 표본에서 빼야 한다 - 이 파일이 그걸 붙들어 둔다.
const g = (oreb: number | null, dreb: number | null, category = SEASON_CATEGORY_REGULAR) => ({
  seasonName: "2025-2026",
  seasonCategory: category,
  oreb,
  dreb,
});

describe("seasonRebSplit", () => {
  it("분해된 경기만으로 경기당 평균을 낸다", () => {
    const r = seasonRebSplit([g(3, 7), g(1, 5), g(2, 6)], "2025-2026");
    expect(r).toEqual({ gp: 3, total: 3, oreb: 2, dreb: 6 });
  });

  it("null인 경기는 분자·분모 양쪽에서 빠진다(0으로 접지 않는다)", () => {
    const r = seasonRebSplit([g(3, 7), g(null, null), g(1, 5)], "2025-2026");
    expect(r!.gp).toBe(2);
    expect(r!.total).toBe(3); // 화면이 "3경기 중 2경기 기준"이라고 밝힐 수 있어야 한다
    expect(r!.oreb).toBe(2); // (3+1)/2 - 0으로 접었다면 (3+0+1)/3 = 1.33이 됐을 것
    expect(r!.dreb).toBe(6);
  });

  it("한쪽만 null이어도 그 경기는 버린다", () => {
    expect(seasonRebSplit([g(3, null), g(1, 5)], "2025-2026")!.gp).toBe(1);
  });

  it("정규시즌만 센다(플레이오프·오픈매치 제외)", () => {
    const r = seasonRebSplit([g(3, 7), g(9, 9, "플레이오프"), g(9, 9, "OPEN MATCH DAY")], "2025-2026");
    expect(r).toEqual({ gp: 1, total: 1, oreb: 3, dreb: 7 });
  });

  it("쓸 수 있는 경기가 없거나 기준 시즌이 없으면 null", () => {
    expect(seasonRebSplit([g(null, null)], "2025-2026")).toBeNull();
    expect(seasonRebSplit([g(3, 7)], null)).toBeNull();
    expect(seasonRebSplit([g(3, 7)], "2024-2025")).toBeNull();
  });
});
