import type { Metadata } from "next";
import styles from "./pricing.module.css";

export const metadata: Metadata = {
  title: "코트사이드 요금제",
};

export default function PricingPage() {
  return (
    <div className={styles.pageRoot}>
      <div className={styles.wrap}>
        <div className={styles.hero}>
          <div className={styles.kicker}>Courtside · 요금제</div>
          <div className={styles.heroTitle}>
            경기를 보는 방식을 바꾸는 분석,
            <br />
            얼마나 깊이 볼지는 직접 고르세요
          </div>
          <div className={styles.heroSub}>
            코트사이드는 KBL 실제 경기 데이터로 매 슛마다 승률이 어떻게 움직였는지 실시간으로
            보여주는 분석 플랫폼입니다. 아래 세 단계는 지금까지 만든 기능을 어떻게 나눌지 미리
            그려본 디자인입니다 - 결제는 아직 연결되어 있지 않습니다.
          </div>
        </div>

        <div className={styles.toggleRow}>
          <button className={`${styles.toggleBtn} ${styles.active}`} type="button">
            월간 결제
          </button>
          <button className={styles.toggleBtn} type="button">
            연간 결제
          </button>
        </div>
        <div className={styles.toggleNote}>연간 결제 시 2개월 무료 (17% 할인) - 예시 가격, 확정 아님</div>

        <div className={styles.tiers}>
          <div className={styles.tierCard}>
            <div className={styles.tierName}>Pro</div>
            <div className={styles.tierDesc}>경기를 실시간으로 따라가고 싶은 팬을 위한 기본 구성</div>
            <div className={styles.tierPriceRow}>
              <span className={styles.tierPrice}>₩9,900</span>
              <span className={styles.tierPriceUnit}>/ 월</span>
            </div>
            <div className={styles.tierPriceNote}>부가세 별도 · 예시 가격</div>
            <ul className={styles.tierFeatures}>
              <li>
                <span className={styles.chk}>✓</span>코트사이드 라이브 뷰어 (실시간 승률 그래프 · 슛차트)
              </li>
              <li>
                <span className={styles.chk}>✓</span>경기 프리뷰 (양팀 승률 · 최근 폼 비교)
              </li>
              <li>
                <span className={styles.chk}>✓</span>리그 순위표
              </li>
              <li>
                <span className={styles.chk}>✓</span>득점 시 하이라이트 알림
              </li>
            </ul>
            <button className={styles.tierCta} disabled>
              <span className={styles.dot}></span>출시 전 · 준비 중
            </button>
          </div>

          <div className={`${styles.tierCard} ${styles.featured}`}>
            <div className={styles.tierRibbon}>가장 많이 찾는 구성</div>
            <div className={styles.tierName}>Elite</div>
            <div className={styles.tierDesc}>경기 흐름을 만든 이유까지 파고드는 분석가용 구성</div>
            <div className={styles.tierPriceRow}>
              <span className={styles.tierPrice}>₩19,900</span>
              <span className={styles.tierPriceUnit}>/ 월</span>
            </div>
            <div className={styles.tierPriceNote}>부가세 별도 · 예시 가격</div>
            <ul className={styles.tierFeatures}>
              <li>
                <span className={styles.inheritNote}>Pro의 모든 기능, 그리고</span>
              </li>
              <li>
                <span className={styles.chk}>✓</span>AI 경기 프리뷰 &amp; 경기 후 분석(예측 적중/실패 이유
                설명)
              </li>
              <li>
                <span className={styles.chk}>✓</span>매치업 상세 (팀 시즌 스탯 비교 · 리그 순위 · 최근결과·다음일정)
              </li>
              <li>
                <span className={styles.chk}>✓</span>득점 분포 탐색기 (감독 · 선수 · 팀별 슛 히트맵, 시즌별 변화)
              </li>
              <li>
                <span className={styles.chk}>✓</span>폼 지수 리더보드
              </li>
            </ul>
            <button className={styles.tierCta} disabled>
              <span className={styles.dot}></span>출시 전 · 준비 중
            </button>
          </div>

          <div className={styles.tierCard}>
            <div className={styles.tierName}>Enterprise</div>
            <div className={styles.tierDesc}>구단·미디어 등 데이터 자체가 필요한 팀을 위한 구성</div>
            <div className={styles.tierPriceRow}>
              <span className={styles.tierPrice} style={{ fontSize: 22 }}>
                문의
              </span>
            </div>
            <div className={styles.tierPriceNote}>규모에 따라 협의</div>
            <ul className={styles.tierFeatures}>
              <li>
                <span className={styles.inheritNote}>Elite의 모든 기능, 그리고</span>
              </li>
              <li>
                <span className={styles.chk}>✓</span>승리 기여도(WPA) 리더보드 전체 데이터
              </li>
              <li>
                <span className={styles.chk}>✓</span>시너지 분석 (선수 조합별 넷레이팅)
              </li>
              <li>
                <span className={styles.chk}>✓</span>시즌 브라우저 원본 데이터 다운로드
              </li>
              <li>
                <span className={styles.chk}>✓</span>전담 지원
              </li>
            </ul>
            <button className={styles.tierCta} disabled>
              <span className={styles.dot}></span>출시 전 · 준비 중
            </button>
          </div>
        </div>

        <div className={styles.pricingFootnote}>
          가격은 기능 구성을 보여주기 위한 예시이며, 실제 결제·구독 기능은 아직 연결되지 않았습니다.
        </div>

        <div className={styles.proof}>
          <div className={styles.proofTitle}>지금까지 실제로 만든 기능들</div>
          <div className={styles.proofGrid}>
            <div className={styles.proofCard}>
              <div className={styles.pname}>코트사이드 라이브 뷰어</div>
              <div className={styles.pdesc}>
                실제 KBL 경기를 슛 하나하나 재생하며 승률이 움직이는 걸 실시간처럼 보여줌
              </div>
            </div>
            <div className={styles.proofCard}>
              <div className={styles.pname}>득점 분포 탐색기</div>
              <div className={styles.pdesc}>감독·선수·팀별 슛 위치를 15시즌 전체 시즌별 히트맵으로 비교</div>
            </div>
            <div className={styles.proofCard}>
              <div className={styles.pname}>폼 지수 리더보드</div>
              <div className={styles.pdesc}>최근 경기력만 따로 뽑아 지금 가장 뜨거운 선수를 순위로 정리</div>
            </div>
            <div className={styles.proofCard}>
              <div className={styles.pname}>시즌 브라우저</div>
              <div className={styles.pdesc}>2025-26 시즌 전 경기 결과와 팀별 기록을 한 페이지에서 탐색</div>
            </div>
          </div>
        </div>

        <footer className={styles.foot}>
          이 페이지는 요금제 구성 초안(디자인 단계)입니다. 실제 결제·로그인·구독 관리 기능은 아직 없습니다.
          <br />
          코트사이드는 KBL과 관련 없는 개인 프로젝트이며, 표시되는 팀명·로고는 정보 제공 목적으로만 사용됩니다.
        </footer>
      </div>
    </div>
  );
}
