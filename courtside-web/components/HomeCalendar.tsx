import Link from "next/link";
import type { GameRow } from "@/lib/homeGames";
import { deriveGameStatus } from "@/lib/gameStatus";

// 홈 "달력" 보기 - 한 달 격자. 칸마다 그날 경기를 한 줄(홈 약칭 점수 원정 약칭)로 요약하고 경기 페이지로 링크한다.
// 서버 컴포넌트(상태 없음) - 달 이동은 page.tsx의 ?month= 링크가 한다.
const WD = ["일", "월", "화", "수", "목", "금", "토"];

export function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function HomeCalendar({ ym, games, today }: { ym: string; games: GameRow[]; today: string }) {
  const [y, m] = ym.split("-").map(Number);
  const lead = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const byDay = new Map<string, GameRow[]>();
  for (const g of games) byDay.set(g.game_date, [...(byDay.get(g.game_date) ?? []), g]);
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);

  return (
    <div className="cal">
      <div className="cal-head">
        {WD.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>
      <div className="cal-grid">
        {cells.map((d, i) => {
          if (d == null) return <div key={i} className="cal-cell empty" />;
          const date = `${ym}-${String(d).padStart(2, "0")}`;
          const list = byDay.get(date) ?? [];
          return (
            <div key={i} className={`cal-cell${date === today ? " today" : ""}`}>
              <div className="cal-day">{d}</div>
              {list.map((g) => {
                const st = deriveGameStatus(g);
                const h = g.home_team?.abbr ?? "?";
                const a = g.away_team?.abbr ?? "?";
                const homeWon = st === "final" && (g.home_score ?? 0) > (g.away_score ?? 0);
                const awayWon = st === "final" && (g.away_score ?? 0) > (g.home_score ?? 0);
                return (
                  <Link key={g.gmkey} href={`/games/${g.gmkey}`} className={`cal-game ${st}`} prefetch={false}>
                    <span className={homeWon ? "w" : ""}>{h}</span>
                    {st === "scheduled" ? (
                      <span className="cal-sc">{g.game_start ? g.game_start.slice(0, 5) : "예정"}</span>
                    ) : (
                      <span className="cal-sc">
                        {st === "live" && <i className="live-dot" />}
                        {g.home_score}-{g.away_score}
                      </span>
                    )}
                    <span className={awayWon ? "w" : ""}>{a}</span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
