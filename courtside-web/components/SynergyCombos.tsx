import Link from "next/link";
import { PlayerPhoto } from "./PlayerPhoto";
import { iGa } from "@/lib/josa";
import {
  COMBO_MIN_MINUTES_BY_SIZE,
  COMBO_SE_CHECK,
  COMBO_SHRINK_K,
  COMBO_SIZES,
  COMBO_TOP_N,
  NET40_SE_CONST,
  SEASON_COMBO_MIN_MINUTES_SENTENCE,
  SEASON_COMBO_SE_SENTENCE,
  type ComboMember,
  type ComboRow,
  type ComboSizeBlock,
  type PlayerCombos,
} from "@/lib/lineupCombos";
import styles from "./SynergyCombos.module.css";

// 선수 프로필 §5 "시너지 & 임팩트"의 조합 표. 요청은 "3인/4인/5인 조합도"였다.
//
// 크기 전환을 URL 쿼리(?combo=3)로 두지 않고 네 크기를 한 화면에 세로로 쌓았다. 이유:
//  1) 이 데이터의 핵심 사실이 "크기가 커질수록 표본이 얇아진다"인데, 탭으로 갈라 놓으면
//     독자가 2인 ±10과 5인 ±29를 나란히 볼 일이 없어져서 그 사실이 사라진다.
//  2) 프로필 페이지의 다른 쿼리(?w=/?season=/?rate=)와 얽히지 않는다 - 조합 칩을 누를 때마다
//     세 파라미터를 되돌려 붙여야 하고 하나라도 빠지면 창 선택이 조용히 초기화된다.
//  3) 크기당 3행이라 전부 합쳐도 12행이다(요청의 "시간은 적당히"에도 맞는 분량).
// 그래서 클라이언트 상태도, 쿼리스트링도, 링크 왕복도 없다. 서버 컴포넌트 하나로 끝난다.
//
// SVG를 쓰지 않는다 - 막대는 전부 CSS div다(JSX <svg> 안의 <title>이 React 19에서 호이스팅돼
// 하이드레이션을 깨뜨리는 저장소의 알려진 함정을 아예 피한다). 막대의 수치는 감싸는 div의
// title 속성으로 준다.

// lineups 페이지와 같은 표기 규칙. 0.00으로 떨어지는 값에는 부호를 붙이지 않는다
// ("+0.00"은 좋은 쪽으로 읽힌다). 색 경계도 같은 값을 쓰므로 부호와 색이 늘 일치한다.
const fmtNet = (v: number) => {
  const s = v.toFixed(1);
  if (s === "0.0" || s === "-0.0") return "0.0";
  return v > 0 ? `+${s}` : s;
};
const fmtSe = (se: number) => (Number.isFinite(se) ? `±${se.toFixed(se >= 10 ? 0 : 1)}` : "±?");
const fmtMin = (m: number) => Math.round(m).toLocaleString();
// 임계값을 캡션 문장 안에 손으로 적어 두면 lib에서 값을 고쳤을 때 화면만 옛말을 하게 된다.
// 표본 기준을 말하는 문장은 전부 이 한 줄에서 만든다.
const MIN_MINUTES_SENTENCE = COMBO_SIZES.map((s) => `${s}인 ${COMBO_MIN_MINUTES_BY_SIZE[s]}분`).join(" · ");
// 그 임계값에서 실제로 찍히는 오차 폭. 임계값을 올리면 이 문장도 같이 움직인다.
const SE_AT_THRESHOLD_SENTENCE = COMBO_SIZES.map(
  (s) => `±${Math.round(NET40_SE_CONST / Math.sqrt(COMBO_MIN_MINUTES_BY_SIZE[s]))}`
).join(" · ");

/**
 * 원형 선수 타일. /lineups의 Avatar와 같은 문법(같은 지름·같은 링·같은 중립 디스크)이다.
 *
 * 실측(2026-09-04)이 이 설계를 정한다: players.photo_url은 773명 중 31명(4.0%)뿐이고
 * 25-26 출전시간 1~20위는 전원 사진이 없다. 즉 "사진 없음"이 예외가 아니라 기본값이다.
 * 그래서 사진 있는 선수를 특별한 카드로 취급하지 않는다 - 모두에게 같은 원을 먼저 그리고
 * 소수만 '채움'이 사진으로 바뀐다. 그래야 한 줄에 넷이 섞여도 리듬이 안 깨진다.
 *
 * /lineups와 다른 점 하나: 폴백 글자가 등번호가 아니라 이름 첫 글자다. lineup_combo는 15시즌
 * 통산이라 시즌 등번호를 붙일 근거가 없다(등번호는 시즌마다 바뀐다).
 */
function Avatar({ m, size = 26 }: { m: ComboMember; size?: number }) {
  return (
    <span className={styles.avatar} style={{ width: size, height: size }} title={m.name}>
      {m.photoUrl ? (
        <>
          <PlayerPhoto src={m.photoUrl} size={size} className={styles.avatarImg} />
          <span className={styles.avatarTint} aria-hidden="true" />
        </>
      ) : (
        <span className={styles.avatarInitial}>{m.initial}</span>
      )}
    </span>
  );
}

function Row({ r, maxAbs }: { r: ComboRow; maxAbs: number }) {
  // 막대 길이는 순위를 정한 값(축소값) 그 자체다 - 인쇄된 숫자는 원시 net/40이므로, 정렬 근거가
  // 화면 어디에도 없으면 "왜 +14.2가 +46.7보다 위인가"에 답할 방법이 없다. 축척은 네 크기가
  // 공유한다(그래야 5인 막대가 2인보다 짧다는 사실이 그대로 보인다). 0 근처도 보이도록 하한 2%.
  const pct = Math.max(2, Math.min(100, (Math.abs(r.rankValue) / maxAbs) * 100));
  return (
    <div className={styles.row}>
      <span className={styles.avatarStack}>
        {r.members.map((m) => (
          <Avatar key={m.pcode} m={m} />
        ))}
      </span>
      <span className={styles.names}>
        {r.members.map((m, i) => (
          <span key={m.pcode}>
            {i > 0 && <span className={styles.sep}> · </span>}
            <Link href={m.href} className={styles.name}>
              {m.name}
            </Link>
          </span>
        ))}
      </span>
      {/* 숫자만 모노 서체로 굵게(한글 단위는 기본 서체) - 줄바꿈을 넣으면 JSX가 공백을 하나
          집어넣어 "1,234 스틴트"가 되므로 한 줄로 붙여 쓴다. */}
      <span className={styles.sample}>
        <b className={styles.sampleNum}>{fmtMin(r.minutes)}</b>분 · <b className={styles.sampleNum}>{r.stints.toLocaleString()}</b>스틴트
      </span>
      <span className={styles.netCell}>
        {/* |net/40| < ± 이면 부호조차 의미가 없다 - 색을 빼서 그 사실이 숫자보다 먼저 보이게. */}
        <span className={`${styles.net} ${r.noisy ? styles.netMuted : r.netPer40 >= 0 ? styles.pos : styles.neg}`}>
          {fmtNet(r.netPer40)}
        </span>
        <span className={styles.se}>{fmtSe(r.se)}</span>
      </span>
      <span
        className={styles.barCell}
        title={
          r.rankKind === "shrunk"
            ? `표본 두께로 누른 값 ${fmtNet(r.rankValue)} = ${fmtNet(r.netPer40)} × ${fmtMin(r.minutes)}분 ÷ (${fmtMin(r.minutes)}분 + ${COMBO_SHRINK_K})`
            : `함께 뛴 시간 ${fmtMin(r.rankValue)}분 순 - 한 시즌 표본은 net/40이 아니라 시간으로 줄을 세운다(아래 캡션 참고)`
        }
      >
        {/* 막대 길이는 rankValue(정렬 기준), 좌우/색은 항상 netPer40 부호 - 축소값은 부호가
            netPer40과 같지만, 시즌의 rankValue(분)는 항상 양수라 부호를 분에서 뽑으면 net/40이
            마이너스인 조합도 초록 막대가 된다. 그래서 색은 별도로 netPer40에서 가져온다. */}
        <span className={styles.bar} aria-hidden="true">
          <span className={`${styles.barHalf} ${styles.barLeft}`}>
            {r.netPer40 < 0 && <span className={`${styles.barFill} ${styles.barFillNeg}`} style={{ width: `${pct}%` }} />}
          </span>
          <span className={`${styles.barHalf} ${styles.barRight}`}>
            {r.netPer40 >= 0 && <span className={`${styles.barFill} ${styles.barFillPos}`} style={{ width: `${pct}%` }} />}
          </span>
        </span>
      </span>
    </div>
  );
}

function SizeBlock({ b, maxAbs }: { b: ComboSizeBlock; maxAbs: number }) {
  return (
    <div className={styles.block}>
      <div className={styles.sizeTag}>
        {/* Big Shoulders Display에는 한글 글리프가 없다(저장소에서 세 번 터진 버그) - 숫자 span에만 건다. */}
        <span className={styles.sizeNum}>{b.size}</span>
        <span className={styles.sizeUnit}>인</span>
        <span className={styles.sizeMeta}>
          {b.minMinutes}분↑ {b.passed > 0 ? `${b.passed.toLocaleString()}개 중 ${b.rows.length}` : "0개"}
        </span>
      </div>
      {b.rows.length > 0 ? (
        <div className={styles.rows}>
          {b.rows.map((r) => (
            <Row key={r.key} r={r} maxAbs={maxAbs} />
          ))}
        </div>
      ) : (
        <div className={styles.blockEmpty}>함께 {b.minMinutes}분을 넘긴 {b.size}인 조합 없음</div>
      )}
    </div>
  );
}

/**
 * 크기별 최고 조합(2·3·4·5인). 주인공을 뺀 조합원만 그린다 - 어차피 모든 행에 주인공이 있으므로
 * 같은 얼굴을 열두 번 반복하면 정보가 아니라 소음이다.
 *
 * 요청("최고의 조합에서, 커리어 통산과 함께 시즌별 최고의 조합도 제공")대로 두 범위를 위아래로
 * 같이 보여준다 - 토글로 하나를 골라 보는 게 아니라, 시즌 값이 커리어 값과 얼마나 다른지(또는
 * 같은지)가 바로 비교돼야 의미가 있어서다("이 조합이 이번 시즌 반짝했나, 원래 좋았나").
 * seasonData가 null이면 그 시즌에 라인업 로그가 없다는 뜻(개막 전 등)이고, undefined면 호출부가
 * 애초에 시즌을 못 정한 것이다(둘 다 커리어 섹션만 보여주고 시즌 섹션은 생략).
 */
export function SynergyCombos({
  data,
  seasonData,
  seasonLabel,
  playerName,
}: {
  data: PlayerCombos;
  seasonData?: PlayerCombos | null;
  /** "25-26 최종"처럼 페이지의 다른 시즌 패널과 같은 형식의 기준 칩. */
  seasonLabel?: string;
  playerName?: string;
}) {
  if (data.failed) {
    // 빈 결과와 조회 실패를 절대 같은 문장으로 말하지 않는다("조합 없음"은 사실 주장이다).
    return <div className={styles.wrap}>조합 표를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>;
  }

  const rows = data.blocks.flatMap((b) => b.rows);
  const maxAbs = Math.max(0.5, ...rows.map((r) => Math.abs(r.rankValue)));
  const who = playerName ?? "이 선수";

  const seasonRows = seasonData ? seasonData.blocks.flatMap((b) => b.rows) : [];
  const seasonMaxAbs = Math.max(0.5, ...seasonRows.map((r) => Math.abs(r.rankValue)));

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.headTitle}>최고의 조합</span>
        <span className={styles.headNote}>크기별 상위 {COMBO_TOP_N}개</span>
      </div>

      {seasonLabel !== undefined && (
        <div className={styles.scopeSection}>
          <div className={styles.scopeHead}>
            <span className={styles.scopeChip}>{seasonLabel}</span>
            <span className={styles.scopeNote}>함께 뛴 시간 순</span>
          </div>

          {seasonData === null ? (
            <div className={styles.blockEmpty}>{seasonLabel} 시즌은 라인업 로그가 없어 조합을 계산할 수 없습니다.</div>
          ) : seasonData?.failed ? (
            <div className={styles.blockEmpty}>{seasonLabel} 조합을 불러오지 못했습니다.</div>
          ) : seasonRows.length > 0 && seasonData ? (
            seasonData.blocks.map((b) => <SizeBlock key={`s-${b.size}`} b={b} maxAbs={seasonMaxAbs} />)
          ) : (
            <div className={styles.blockEmpty}>
              {who}
              {iGa(who)} {seasonLabel} 시즌 최소 표본({SEASON_COMBO_MIN_MINUTES_SENTENCE})을 넘긴 조합이 없습니다.
            </div>
          )}

          {seasonData && !seasonData.failed && (
            <div className={styles.caption}>
              <ul className={styles.captionList}>
                <li>
                  <b>정렬은 net/40이 아니라 함께 뛴 시간입니다.</b> 같은 시즌을 무작위로 반씩 갈라 net/40을 비교한
                  상관이 2인 100분에서 r=+0.06, 3~5인은 0 근처거나 음수였습니다(/lineups의 3~5인 조합표와 같은
                  실측). 한 시즌 표본으로는 조합의 우열이 재현되지 않는다는 뜻이라, 커리어처럼 표본 두께로
                  net/40을 누르는 대신 시간 순으로만 줄을 세웁니다. 여러 시즌에 걸쳐 같은 조합이 반복해서 위에
                  있으면 그때가 신호입니다 - 아래 <b>커리어 통산</b>이 그 비교 상대입니다.
                </li>
                <li>
                  <b>최소 표본은 크기마다 다릅니다({SEASON_COMBO_MIN_MINUTES_SENTENCE}).</b> /lineups의 WOWY
                  조합표와 같은 값을 재사용합니다 - 같은 표본(그 시즌 온코트 스틴트)에서 나온 문턱이라 새로
                  잴 이유가 없습니다. 그 문턱에서 ±는 {SEASON_COMBO_SE_SENTENCE}입니다.
                </li>
                <li>
                  <b>범위.</b> {seasonLabel} 정규시즌+플레이오프 전체(WOWY와 같은 범위 - 표본이 원래 귀해서
                  플레이오프를 버리지 않습니다).
                </li>
              </ul>
            </div>
          )}
        </div>
      )}

      <div className={styles.scopeSection}>
        <div className={styles.scopeHead}>
          <span className={styles.scopeChip}>커리어 통산</span>
          <span className={styles.scopeNote}>표본 두께로 누른 값 순</span>
        </div>

        {rows.length > 0 ? (
          data.blocks.map((b) => <SizeBlock key={`c-${b.size}`} b={b} maxAbs={maxAbs} />)
        ) : (
          <div className={styles.blockEmpty}>
            {/* 받침에 따라 이/가가 갈린다("김선형이" vs "자밀 워니가") - lib/josa.ts를 쓴다. */}
            {who}
            {iGa(who)} 최소 표본({MIN_MINUTES_SENTENCE})을 넘긴 조합이 어느 크기에도 없습니다.
          </div>
        )}

        <div className={styles.caption}>
        <b>이 표를 읽는 법</b>
        <ul className={styles.captionList}>
          <li>
            <b>범위는 15시즌 통산입니다.</b> lineup_combo에는 시즌 구분이 없어 &quot;이번 시즌의 조합&quot;을 따로 볼 수
            없습니다. 그래서 조합원에 등번호를 붙이지 않았습니다 - 등번호는 시즌마다 바뀝니다.
          </li>
          <li>
            <b>보정이 전혀 없습니다.</b> 상대 팀 전력도, 코트 위 나머지가 누구였는지도 보정하지 않은 원시 온코트
            마진(득실 ÷ 분 × 40)입니다. <b>RAPM이 아닙니다.</b> 강팀의 주전 둘은 궁합과 무관하게 이 값이 높습니다.
          </li>
          <li>
            <b>±가 무엇인가.</b> net/40의 표준오차이고 <b>약 {NET40_SE_CONST} ÷ √(함께 뛴 분)</b>입니다. 이 테이블에서
            크기별로 다시 재도 {COMBO_SE_CHECK}가 나와 {NET40_SE_CONST}를 그대로 씁니다. 값이 자기 ± 안에 들어가는 행은
            부호조차 의미가 없어 <b>색을 뺐습니다.</b>
          </li>
          <li>
            <b>최소 표본이 크기마다 다른 이유.</b> 한 스틴트가 2인 조합 4개, 3인 6개, 4인 4개, 5인 1개를 동시에 만들기
            때문에 인원이 늘수록 조합 하나에 쌓이는 시간이 급격히 줍니다(분 중앙값 86 → 22 → 10 → 7). 하한 하나를 네
            크기에 그대로 쓰면 5인 표가 비거나 2인 표가 노이즈로 덮입니다. 그래서 &quot;그 크기에서 {COMBO_TOP_N}개 이상
            남는 선수 비율&quot;이 86~89%로 같아지는 지점을 크기마다 따로 골랐습니다({MIN_MINUTES_SENTENCE}). 대가는 오차
            폭입니다 - 같은 순서로 {SE_AT_THRESHOLD_SENTENCE}입니다.
          </li>
          <li>
            <b>줄 세우는 값은 인쇄된 값이 아닙니다.</b> 통과한 것 중 net/40 순으로 뽑으면 상위권이 통째로
            노이즈가 됩니다(실측: 자밀 워니 4인 조합의 원시 1위는 33분짜리 +46.7 ±17이고, 아래 순서의 1위는 635분짜리
            +14.2 ±4입니다). 그래서 순위는 표본 두께로 눌러 준 값{" "}
            <b>net/40 × 분/(분+{COMBO_SHRINK_K.toLocaleString()})</b>으로 정하고, 그 값을 오른쪽 막대 길이로 같이
            보여줍니다(막대 축척은 네 크기가 공유). {COMBO_SHRINK_K.toLocaleString()}은 이 테이블에서 관측 분산 − 노이즈 분산으로 추정한
            참분산에서 나온 값입니다(2인 K≈1,030 · 3인 ≈1,295 · 4인 ≈2,630 · 5인은 참분산이 검출되지 않음).
          </li>
          <li>
            <b>5인은 특히 조심하세요.</b> 분 160 이상인 5인 조합 104개에서 관측 분산이 노이즈 분산보다도 작았습니다. 즉
            이 데이터로는 5인 조합끼리 &quot;진짜로 다르다&quot;는 신호를 잡아내지 못합니다. 5인 줄은 우열이 아니라{" "}
            <b>실제로 같이 오래 뛴 다섯</b>의 기록으로 읽어 주세요.
          </li>
        </ul>
        </div>
      </div>
    </div>
  );
}
