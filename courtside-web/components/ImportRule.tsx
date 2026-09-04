import Link from "next/link";
import { TeamBadge } from "@/components/TeamBadge";
import { PRESEASON_SEASON, shortSeason } from "@/lib/preseason";
import {
  NEW_WINDOW_MINUTES,
  SLOT_LABEL,
  type ImportRuleReport,
  type SlotSeat,
  type TeamImportRule,
} from "@/lib/importRule";
import panel from "@/app/preseason/preseason.module.css";
import styles from "./PreseasonShift.module.css";

// 요청: "26-27시즌에는 용병제도가 조금 변경 ... 1쿼, 4쿼는 용병 2인 출전 불가, 아쿼는 가능,
// 2~3쿼는 아쿼+용병 2인 중에 2인 출전 가능(용병 2명 조합도 가능)".
//
// 이 섹션의 축은 "2·3쿼터가 승부처다"가 아니라 "외국인 슬롯이 늘어난다"이다 - 실측이 그렇게
// 말한다. 자세한 근거는 lib/importRule.ts 머리말과 tools/build_import_slots.py에.

const QUARTERS = ["Q1", "Q2", "Q3", "Q4"] as const;

function fmt1(v: number | null | undefined, unit = "") {
  return v == null ? "-" : `${v.toFixed(1)}${unit}`;
}
function signed1(v: number | null | undefined) {
  return v == null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

function Seat({ seat }: { seat: SlotSeat }) {
  const p = seat.prev;
  return (
    <div className={styles.seat}>
      <div className={styles.seatRole}>{SLOT_LABEL[seat.slot]}</div>
      <div className={styles.seatName}>
        {seat.pcode ? <Link href={`/players/${seat.pcode}`}>{seat.name}</Link> : seat.name}
        {seat.prevTeam && <span className={styles.seatFrom}>← {seat.prevTeam.abbr}</span>}
      </div>
      {p ? (
        <div className={styles.seatStat}>
          {fmt1(p.mpg, "분")} · PER {fmt1(p.per)}
        </div>
      ) : (
        // 기록이 없는 것과 기록이 나쁜 것은 다르다. 빈칸을 0으로 그리면 안 된다.
        <div className={styles.seatNone}>KBL 기록 없음</div>
      )}
    </div>
  );
}

function SlotCard({ t, prev, cur }: { t: TeamImportRule; prev: string; cur: string }) {
  return (
    <div className={styles.slotCard} style={{ borderTopColor: t.team.color }}>
      <Link href={`/teams/${t.team.tcode}?season=${PRESEASON_SEASON}`} className={styles.slotHead}>
        <TeamBadge team={t.team} size={20} />
        <span className={styles.slotHeadName}>{t.team.name}</span>
        {t.prevIndex != null && (
          <span className={styles.slotIndex}>
            {prev} 지수 {Math.round(t.prevIndex)}
          </span>
        )}
      </Link>
      {t.seats.map((s) => (
        <Seat key={`${s.slot}-${s.name}`} seat={s} />
      ))}
      {t.noAq && <div className={styles.seatNone} style={{ padding: "5px 0 0" }}>아시아쿼터 미등록</div>}
      <div className={styles.slotFoot}>
        <span>
          여지 <span className={styles.slotFootVal}>{fmt1(t.room)}분</span>
          <span className={styles.slotFootMuted}> ({prev} 아시아쿼터의 2·3쿼터 출전)</span>
        </span>
        {/* 두 격차는 기준이 다르다 - 라벨 없이 붙여 두면 서로 모순처럼 읽힌다.
            SK: 작년 두 자리는 -0.3이었는데 올해 등록 조합은 +4.8이다. */}
        <span>
          {prev} 두 자리{" "}
          {t.prevGap != null ? (
            <span className={styles.slotFootVal}>{signed1(t.prevGap)} PER</span>
          ) : (
            <span className={styles.slotFootMuted}>-</span>
          )}
        </span>
        <span>
          {cur} 조합{" "}
          {t.gap != null ? (
            <span className={styles.slotFootVal}>{signed1(t.gap)} PER</span>
          ) : (
            <span className={styles.slotFootMuted}>산출 불가 (신규 선수)</span>
          )}
        </span>
      </div>
    </div>
  );
}

export function ImportRule({ report, num }: { report: ImportRuleReport; num: number }) {
  const prev = shortSeason(report.prevSeason);
  const cur = shortSeason(report.season);
  const qc = report.quarterCorr;
  const kcc = report.teams.find((t) => t.noAq) ?? null;
  // "가장 적게 쓰인 축"이라고 단언했다가 틀렸다(현대모비스가 더 적다). 세어서 말한다.
  const kccRoomRank = kcc ? report.teams.filter((t) => t.room > kcc.room).length + 1 : 0;
  const computable = report.teams.filter((t) => t.gap != null).sort((a, b) => (b.index ?? 0) - (a.index ?? 0));

  return (
    <div className={panel.panel}>
      <div className={panel.panelTitle}>
        <span className={panel.sectionNum}>{num}</span>
        {cur} 외국인 출전 규정 변경 - 40분에서 최대 {40 + NEW_WINDOW_MINUTES}분으로
      </div>
      <p className={panel.panelLede}>
        1쿼터·4쿼터는 종전대로 외국인 2명이 함께 설 수 없고(아시아쿼터는 가능), 2·3쿼터에는 등록된 세 명 중 두 명이 동시에 뜁니다 - 외국인
        2명 조합도 됩니다. 이 변화의 크기는 &quot;2·3쿼터가 승부처가 된다&quot;가 아니라 &quot;외국인이 코트에 서 있을 수 있는 시간이
        늘어난다&quot;에 있습니다.
      </p>

      <div className={styles.figureRow}>
        <div className={styles.figure}>
          <div className={styles.figureLabel}>{prev} 외국인 2명 동시 출전</div>
          <div className={styles.figureVal}>
            {report.twoSec}
            <span className={styles.figureUnit}>초</span>
          </div>
          <div className={styles.figureSub}>
            리그 전체 코트시간의 {(report.share.two * 100).toFixed(3)}%. 한 경기 4쿼터의 연속 두 구간뿐이라 교체 순서 복원 오차로 보는 것이
            맞습니다 - 사실상 0입니다.
          </div>
        </div>
        <div className={styles.figure}>
          <div className={styles.figureLabel}>외국인 1명이 서 있던 시간</div>
          <div className={styles.figureVal}>
            {(report.share.one * 100).toFixed(2)}
            <span className={styles.figureUnit}>%</span>
          </div>
          <div className={styles.figureSub}>
            팀-경기당 {report.importMpg.toFixed(1)}분. 외국인 슬롯은 이미 포화였습니다. 그래서 이 규정은 비어 있던 시간을 채우는 게 아니라
            새 시간을 만듭니다.
          </div>
        </div>
        <div className={styles.figure}>
          <div className={styles.figureLabel}>새로 열리는 외국인 시간</div>
          <div className={styles.figureVal}>
            +{NEW_WINDOW_MINUTES}
            <span className={styles.figureUnit}>분</span>
          </div>
          <div className={styles.figureSub}>
            팀당 상한 기준(2·3쿼터 20분 × 1명). 2·3쿼터는 팀당 득점의 {(report.midShare * 100).toFixed(1)}%로 정확히 절반입니다.
          </div>
        </div>
      </div>

      <div className={styles.ruleBox}>
        <div className={styles.ruleCol}>
          <div className={styles.ruleColHead}>{prev}까지 (종전)</div>
          <div className={styles.quarterStrip}>
            {QUARTERS.map((q) => (
              <div key={q} className={styles.qCell}>
                <div className={styles.qCellName}>{q}</div>
                외국인 1
              </div>
            ))}
          </div>
          <div className={styles.ruleText}>
            아시아쿼터는 전 쿼터 출전 가능, 외국인 2명 동시 출전 불가. 실제로 지켜졌습니다 - 위 170초가 {prev} 정규시즌 {report.courtSec.toLocaleString()}초
            중 유일한 예외입니다.
          </div>
        </div>
        <div className={styles.ruleCol}>
          <div className={styles.ruleColHead}>{cur}부터 (변경)</div>
          <div className={styles.quarterStrip}>
            {QUARTERS.map((q) => {
              const open = q === "Q2" || q === "Q3";
              return (
                <div key={q} className={`${styles.qCell} ${open ? styles.qCellOpen : ""}`}>
                  <div className={styles.qCellName}>{q}</div>
                  {open ? "세 명 중 2" : "외국인 1"}
                </div>
              );
            })}
          </div>
          <div className={styles.ruleText}>
            2·3쿼터에만 아시아쿼터 1 + 외국인 2 중 두 명이 함께 뜁니다. 1·4쿼터는 종전과 같습니다. 바뀌는 구간이 승부처라서 중요한 게
            아닙니다 - 쿼터 득실차와 최종 득실차의 상관은 Q2+Q3 {qc["Q2+Q3"] ?? "-"}, Q1+Q4 {qc["Q1+Q4"] ?? "-"}로 사실상 같습니다.
            정확히 절반이라서 중요합니다.
          </div>
        </div>
      </div>

      <div className={panel.panelTitle} style={{ marginTop: 4 }}>
        팀별 세 자리 - {cur} 등록 × {prev} 실적
      </div>
      <p className={panel.panelLede}>
        {report.gapTotal > 0 && (
          <>
            {prev} 재료로 보면 {report.teams.length}팀 중 {report.gapPositive}팀에서 &quot;외국인 2옵션 &gt; 아시아쿼터&quot;였습니다(PER 격차 중앙값{" "}
            {signed1(report.gapMedian)}). 격차가 클수록, 그리고 아시아쿼터가 2·3쿼터를 많이 뛰었을수록 이 규정으로 바꿀 유인이 큽니다.{" "}
          </>
        )}
        다만 {cur} 등록 선수 중 KBL 기록이 없는 신규 선수가 많아, 실제 조합으로 격차가 산출되는 팀은 {computable.length}팀뿐입니다.
      </p>

      <div className={styles.slotGrid}>
        {report.teams.map((t) => (
          <SlotCard key={t.team.tcode} t={t} prev={prev} cur={cur} />
        ))}
      </div>

      {computable.length > 0 && (
        <div className={panel.note}>
          <b>{cur} 실제 조합으로 격차가 나오는 팀</b> ({computable.length}팀):{" "}
          {computable
            .map(
              (t) =>
                `${t.team.abbr} ${signed1(t.gap)} PER × 여지 ${t.room.toFixed(1)}분` +
                (t.index != null ? ` = 지수 ${Math.round(t.index)}` : "")
            )
            .join(" · ")}
          . 나머지 {report.teams.length - computable.length}팀은 아시아쿼터나 외국인 2옵션이 KBL 무기록이라 <b>산출 불가</b>입니다 - &quot;수혜
          없음&quot;이 아닙니다.
        </div>
      )}

      {kcc && (
        <div className={panel.note}>
          <b>
            {kcc.team.name} - {cur}에 아시아쿼터를 등록하지 않은 유일한 팀
          </b>
          . {prev} 이 팀의 아시아쿼터가 2·3쿼터에 뛴 시간은 경기당 {kcc.room.toFixed(1)}분으로 {report.teams.length}팀 중 {kccRoomRank}
          위였습니다. 종전 규정이었다면 비국내 선수를 항상 1명만 세워야 했을 구성입니다.
        </div>
      )}

      <div className={panel.note}>
        지수는 (외국인 2옵션 PER − 아시아쿼터 PER) × ({prev} 아시아쿼터의 2·3쿼터 출전분)입니다. <b>무단위이고 순서만 말합니다</b> - 승수나
        득점으로 환산되지 않습니다({cur}은 아직 0경기입니다). 카드의 지수는 10팀 전부에서 나오는 {prev} 재료 기준이고, 위 각주의 지수는 {cur}{" "}
        실제 등록 조합 기준입니다.
      </div>
      <div className={panel.note}>
        2옵션 외국인의 분당 지표는 팀-경기당 9~17분짜리 벤치 출전에서 나온 값이라, 출전이 2·3쿼터로 늘어나도 그대로 유지된다는 보장은
        없습니다 - 격차는 상한에 가깝게 읽어야 합니다. &quot;여지&quot;도 상한선입니다: 팀이 아시아쿼터 대신 국내 선수의 시간을 줄일 수도
        있습니다. {prev}의 1옵션/2옵션 구분은 등록 구분이 아니라 출전분이 많은 쪽을 1옵션으로 본 운영 정의이며, 아시아쿼터/외국인 구분은 코트
        위 동시 출전 구조로 복원한 뒤 {cur} 등록 명부 18명과 대조해 100% 일치를 확인했습니다.
      </div>
    </div>
  );
}
