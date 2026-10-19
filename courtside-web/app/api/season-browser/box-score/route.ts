import { NextRequest, NextResponse } from "next/server";
import { cached, TTL, TAG } from "@/lib/cachePolicy";
import { supabaseServer as supabase } from "@/lib/supabaseServer";
import { rateLimit } from "@/lib/rateLimit";

// 시즌 브라우저 박스스코어 모달(components/SeasonBrowserModal.tsx)이 여는 시점에만 부르는
// 엔드포인트 - web/season_browser_template.html의 openBoxScore()가 미리 구운
// SEASON.games[gmkey]에서 읽던 걸, 여기서는 그 경기 하나만 라이브로 조회해서 만들어준다.
// gmkey 하나의 game_events는 항상 1000행 미만(실측 최대 880행)이라 페이지네이션 불필요.

type EventRow = { quarter: string; event_order: number; home_score: number; away_score: number };
type TeamStatRow = {
  tcode: string;
  score: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnovers: number | null;
  fouls: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
};
type PlayerStatRow = {
  pcode: string;
  tcode: string;
  back_num: string | null;
  is_starter: boolean | null;
  min_played: number | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  turnovers: number | null;
  fgm: number | null;
  fga: number | null;
  tpm: number | null;
  tpa: number | null;
  ftm: number | null;
  fta: number | null;
  per: number | null;
  player: { name: string } | null;
};

export async function GET(req: NextRequest) {
  // 전역 Proxy에서 하던 제한을 실제로 비싼 Handler 안으로 옮긴다. Proxy + Function 두 실행
  // 구간을 만들지 않으면서도 단일 IP가 모든 경기 박스스코어를 순회하는 단순 수집은 막는다.
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (ip) {
    const { allowed, retryAfterSec } = rateLimit(`box-score:${ip}`, 60);
    if (!allowed) {
      return NextResponse.json(
        { error: `Too Many Requests - ${retryAfterSec}초 뒤에 다시 시도해 주세요.` },
        { status: 429, headers: { "Retry-After": String(retryAfterSec), "Cache-Control": "no-store" } }
      );
    }
  }
  const gmkey = req.nextUrl.searchParams.get("gmkey");
  const homeTcode = req.nextUrl.searchParams.get("home");
  const awayTcode = req.nextUrl.searchParams.get("away");
  if (!gmkey || !homeTcode || !awayTcode) {
    return NextResponse.json({ error: "gmkey, home, away 파라미터가 필요합니다" }, { status: 400 });
  }
  // 감사 지적: 무검증·무캐시·무인증 JSON이라 gmkey 4,477개를 돌리면 박스스코어(per 포함)가 전량
  // 수집됐다. 형식 검증으로 쓰레기 입력을 막고, **종료 경기는 불변**이므로 24시간 캐시 + CDN 헤더를
  // 붙여 반복 호출이 DB에 닿지 않게 한다. 진행 중 경기는 매번 새로(no-store).
  if (!/^[A-Z0-9]{6,16}$/.test(gmkey) || !/^\d{2}$/.test(homeTcode) || !/^\d{2}$/.test(awayTcode)) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const { data: game } = await supabase.from("games").select("is_ended").eq("gmkey", gmkey).maybeSingle();
  if (!game) return NextResponse.json({ error: "not found" }, { status: 404 });
  const ended = !!game.is_ended;

  const load = async () => {
    const [{ data: events, error: evErr }, { data: teamStats }, { data: playerStats }] = await Promise.all([
    supabase
      .from("game_events")
      .select("quarter, event_order, home_score, away_score")
      .eq("gmkey", gmkey)
      .order("event_order", { ascending: true })
      .returns<EventRow[]>(),
    supabase
      .from("game_team_stats")
      .select("tcode, score, reb, ast, stl, blk, turnovers, fouls, fgm, fga, tpm, tpa, ftm, fta")
      .eq("gmkey", gmkey)
      .returns<TeamStatRow[]>(),
    supabase
      .from("game_player_stats")
      .select(
        "pcode, tcode, back_num, is_starter, min_played, pts, reb, ast, stl, blk, turnovers, fgm, fga, tpm, tpa, ftm, fta, per, player:players(name)"
      )
      .eq("gmkey", gmkey)
      .returns<PlayerStatRow[]>(),
    ]);
    if (evErr) throw new Error(evErr.message);
    return { events: events ?? [], teamStats: teamStats ?? [], playerStats: playerStats ?? [] };
  };
  // 종료 경기만 캐시 - 키는 gmkey, 태그는 경기 단위(재수집 시 무효화 가능).
  const { events, teamStats, playerStats } = ended
    ? await cached(load, ["boxscore", gmkey], TTL.final, [TAG.game(gmkey)])
    : await load();

  // 쿼터별 득점: 각 쿼터 "끝" 시점 누적 스코어 - 그 전 쿼터 누적 스코어. Q로 시작하면
  // 정규쿼터, X로 시작하면 연장(개수는 실제 데이터만큼 동적으로).
  const order: string[] = [];
  const lastByQuarter = new Map<string, EventRow>();
  for (const e of events ?? []) {
    if (e.quarter === "PRE") continue;
    if (!order.includes(e.quarter)) order.push(e.quarter);
    lastByQuarter.set(e.quarter, e);
  }
  let prevH = 0;
  let prevA = 0;
  const homeQ: number[] = [];
  const awayQ: number[] = [];
  const homeOt: number[] = [];
  const awayOt: number[] = [];
  for (const label of order) {
    const row = lastByQuarter.get(label)!;
    const dh = row.home_score - prevH;
    const da = row.away_score - prevA;
    if (label.startsWith("X")) {
      homeOt.push(dh);
      awayOt.push(da);
    } else {
      homeQ.push(dh);
      awayQ.push(da);
    }
    prevH = row.home_score;
    prevA = row.away_score;
  }

  const teamStatsByTcode = new Map((teamStats ?? []).map((t) => [t.tcode, t]));

  function playerRow(p: PlayerStatRow) {
    // min_played는 소수 분(예: 29.87 = 29분 52초) - 템플릿의 playMin:playSec(mm:ss)
    // 표기와 시각적으로 똑같이 맞추기 위해 여기서 변환.
    const min = p.min_played ?? 0;
    let mm = Math.floor(min);
    let ss = Math.round((min - mm) * 60);
    if (ss === 60) {
      ss = 0;
      mm += 1;
    }
    return {
      pcode: p.pcode,
      name: p.player?.name ?? p.pcode,
      backNum: p.back_num,
      starter: p.is_starter ?? false,
      playMin: mm,
      playSec: ss,
      score: p.pts ?? 0,
      rb: p.reb ?? 0,
      ast: p.ast ?? 0,
      stl: p.stl ?? 0,
      bs: p.blk ?? 0,
      to: p.turnovers ?? 0,
      // game_player_stats·game_team_stats의 fgm/fga는 2점 전용이다 - 전체 야투(FG)는 3점을 더한다(실측 2026-10-19: 이번 시즌 590선수-경기 전부).
      fg: (p.fgm ?? 0) + (p.tpm ?? 0),
      fgA: (p.fga ?? 0) + (p.tpa ?? 0),
      threep: p.tpm ?? 0,
      threepA: p.tpa ?? 0,
      ft: p.ftm ?? 0,
      ftA: p.fta ?? 0,
      per: p.per ?? null,
    };
  }

  const sortPlayers = (rows: PlayerStatRow[]) =>
    rows
      .slice()
      .sort((a, b) => (b.is_starter ? 1 : 0) - (a.is_starter ? 1 : 0) || (b.pts ?? 0) - (a.pts ?? 0))
      .map(playerRow);

  const homePlayers = sortPlayers((playerStats ?? []).filter((p) => p.tcode === homeTcode));
  const awayPlayers = sortPlayers((playerStats ?? []).filter((p) => p.tcode === awayTcode));

  function teamStatsOut(tcode: string) {
    const t = teamStatsByTcode.get(tcode);
    return {
      fg: (t?.fgm ?? 0) + (t?.tpm ?? 0), // 2점 전용 fgm + 3점(위 playerRow 주석)
      fgA: (t?.fga ?? 0) + (t?.tpa ?? 0),
      threep: t?.tpm ?? 0,
      threepA: t?.tpa ?? 0,
      ft: t?.ftm ?? 0,
      ftA: t?.fta ?? 0,
      rb: t?.reb ?? 0,
      ast: t?.ast ?? 0,
      stl: t?.stl ?? 0,
      bs: t?.blk ?? 0,
      to: t?.turnovers ?? 0,
      foul: t?.fouls ?? 0,
    };
  }

  return NextResponse.json(
    {
    quarters: {
      home: { q: homeQ, ot: homeOt },
      away: { q: awayQ, ot: awayOt },
    },
    teamStats: {
      home: teamStatsOut(homeTcode),
      away: teamStatsOut(awayTcode),
    },
    players: {
      home: homePlayers,
      away: awayPlayers,
    },
    },
    { headers: { "Cache-Control": ended ? "public, s-maxage=86400, stale-while-revalidate=3600" : "no-store" } }
  );
}
