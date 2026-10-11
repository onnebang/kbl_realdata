import type { CSSProperties } from "react";
import type { FourFactors } from "@/lib/report/fourFactors";
import { buildScoreChart, scoreSourceNotes, SCORE_GRID_STEP_PTS, type ChartRow, type Lead } from "@/lib/report/scoreSourceChart";
import { teamBarStyle, teamInkStyle } from "@/lib/teamAccent";
import { isColorSimilar } from "./TeamSplitBar";

// 리포트 '득점 출처' 차트 - 계산·근거는 lib/report/scoreSourceChart.ts(그 파일 머리주석에 왜
// 다시 그렸는지와 세 디자인 안의 비교 결과가 있다). 이 파일은 모델을 그리기만 한다.
//
// 핵심: 가운데 기준 좌우 막대(홈 왼쪽 / 원정 오른쪽)이고 **모든 줄이 같은 눈금**이다. 예전 TeamSplitBar는
// 줄마다 두 팀 합 대비 비율로 막대를 나눠서 자유투 7:15가 2점 30:44보다 길어 보였다.
//
// 색: 팀 색을 그대로 칠하면 다크에서 남색 막대(#0C2340)가 배경에 묻힌다(디자인 비교 퀴즈에서 다크 배경
// 대비 부족을 A안은 응시자 3명 모두, C안은 1명이 적었다). 그래서 기존 teamBarStyle(WCAG 비텍스트 3:1로 라이트/다크 쌍을 내려주는 헬퍼)을 쓴다 - 서버는 테마를
// 모르므로 두 색을 같이 내리고 CSS 미디어쿼리가 고른다(globals.css의 .ss-fill).
//
// 색만으로 구분하지 않는다: 숫자는 전부 글자이고, 우세한 쪽은 "+N" 칩이 붙는다. 색이 비슷한 두 팀이면
// 원정 막대에 대각선 줄무늬를 얹는다(TeamSplitBar와 같은 규칙·같은 임계값).

function Side({ row, side, color }: { row: ChartRow; side: "home" | "away"; color: string }) {
  const isHome = side === "home";
  const pts = isHome ? row.home : row.away;
  const made = isHome ? row.homeMade : row.awayMade;
  const att = isHome ? row.homeAtt : row.awayAtt;
  const leads = row.lead === side && !row.unplaced;
  // 홈은 [점수][성공/시도][칩]이 바깥→안쪽, 원정은 그 거울상이라 점수가 항상 바깥 끝에 놓인다.
  const pieces = [
    <b key="pts" className="ss-pts">{pts}<small>점</small></b>,
    att > 0 ? <span key="raw" className="ss-raw">{made}/{att}</span> : null,
    leads ? <span key="chip" className="ss-chip">+{row.margin}</span> : null,
  ];
  return (
    <span className={`ss-side ss-${side} team-ink${leads ? " ss-lead" : ""}`} style={teamInkStyle(color)}>
      {isHome ? pieces : [...pieces].reverse()}
    </span>
  );
}

function Fill({ pct, side, color, striped }: { pct: number; side: "home" | "away"; color: string; striped: boolean }) {
  if (pct <= 0) return null;
  return <i className={`ss-fill ss-fill-${side}${striped ? " ss-fill-striped" : ""}`} style={{ width: `${pct}%`, ...teamBarStyle(color) }} />;
}

function Row({ row, hColor, aColor, striped }: { row: ChartRow; hColor: string; aColor: string; striped: boolean }) {
  const cls = `ss-row${row.key === "ft" ? " ss-row-ft" : ""}${row.unplaced ? " ss-row-unplaced" : ""}`;
  return (
    <div className={cls}>
      <div className="ss-head">
        <Side row={row} side="home" color={hColor} />
        <span className="ss-label">
          {row.label}
          {row.tag ? <small className="ss-tag">{row.tag === "tie" ? "동점" : "득점 없음"}</small> : null}
        </span>
        <Side row={row} side="away" color={aColor} />
      </div>
      {/* 막대는 장식이다 - 같은 정보가 위 글자에 전부 있으므로 보조기기에는 읽히지 않게 한다. */}
      <div className="ss-track" aria-hidden="true">
        <div className="ss-half ss-half-home">
          <Fill pct={row.homePct} side="home" color={hColor} striped={false} />
        </div>
        <div className="ss-half ss-half-away">
          <Fill pct={row.awayPct} side="away" color={aColor} striped={striped} />
        </div>
      </div>
    </div>
  );
}

function leadSide(lead: Lead): "home" | "away" | null {
  return lead === "tie" ? null : lead;
}

export function ScoreSourceChart({ ff }: { ff: FourFactors }) {
  const { home, away } = ff;
  const hColor = home.color ?? "#888888";
  const aColor = away.color ?? "#888888";
  const model = buildScoreChart(ff);
  const notes = scoreSourceNotes(ff);
  const striped = isColorSimilar(hColor, aColor);
  const zoneMode = ff.zoneStatus === "zones";
  const totalLead = leadSide(model.total.lead);

  return (
    <div className="ss-chart" style={{ "--ss-step": `${model.stepPct}%` } as CSSProperties}>
      {model.rows.map((row) => (
        <Row key={row.key} row={row} hColor={hColor} aColor={aColor} striped={striped} />
      ))}

      {/* 최종 점수 - 공식 기록이라 항상 정확하다. 위 줄들을 다 더하면 이 값이 된다. */}
      <div className="ss-row ss-total">
        <div className="ss-head">
          <span className={`ss-side ss-home team-ink${totalLead === "home" ? " ss-lead" : ""}`} style={teamInkStyle(hColor)}>
            <b className="ss-pts">{model.total.home}<small>점</small></b>
            {totalLead === "home" ? <span className="ss-chip">+{model.total.margin}</span> : null}
          </span>
          <span className="ss-label">최종 점수</span>
          <span className={`ss-side ss-away team-ink${totalLead === "away" ? " ss-lead" : ""}`} style={teamInkStyle(aColor)}>
            {totalLead === "away" ? <span className="ss-chip">+{model.total.margin}</span> : null}
            <b className="ss-pts">{model.total.away}<small>점</small></b>
          </span>
        </div>
      </div>

      <p className="report-caveat">
        막대 길이는 득점 그대로이고 모든 줄이 같은 눈금입니다(점선 한 칸 = {SCORE_GRID_STEP_PTS}점). 작은 숫자는 성공/시도, <b>+N</b>은 그 줄에서 앞선 점수입니다.
        {zoneMode ? " 림·근거리·중거리·롱2는 2점 득점을 슛 좌표의 골대 거리(림 1.2m · 근거리 3m · 중거리 5m · 롱2 6.75m 이내)로 나눈 것이고, 3점·자유투는 공식 기록입니다." : null}
      </p>
      {notes.map((n) => (
        <p key={n} className="report-caveat">{n}</p>
      ))}
    </div>
  );
}
