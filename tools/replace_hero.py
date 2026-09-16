import sys
import re

file_path = r'D:\영상작업\축구\개발\kbl_realdata\courtside-web\app\players\[pcode]\page.tsx'
with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace Hero Section
start_marker = "      {/* ── 히어로: 커리어 슛 별자리 포스터(위임적 다크 - 모든 색을 직접 칠함) ── */}"
end_marker = "      </section>"

start_idx = content.find(start_marker)
end_idx = content.find(end_marker, start_idx) + len(end_marker)

if start_idx != -1 and end_idx != -1:
    new_hero = """      {/* ── 인포그래픽 포스터 스타일 Hero (Courtside Player Card + 헥스빈 아트) ── */}
      <section className={styles.hero} style={{ "--hero-team": teamColor, display: "flex", flexDirection: "column", gap: "2rem", overflow: "visible" } as CSSProperties}>
        {/* 오른쪽 배경 비주얼 (헥스빈/별자리 아트) - 크기 및 위치 조정 */}
        <svg className={styles.heroArt} viewBox="345 27 375 357" preserveAspectRatio="xMidYMid slice" aria-hidden dangerouslySetInnerHTML={{ __html: constellationSvg }} style={{ right: 0, left: "auto", width: "50%", opacity: 0.8 }} />
        <div className={styles.heroScrim} style={{ background: "linear-gradient(to right, #0a0a0a 40%, transparent 100%)" }} />
        
        {/* 분할 레이아웃 적용 */}
        <div className={styles.heroContent} style={{ position: "relative", zIndex: 10, display: 'flex', flexDirection: 'column', gap: '3rem', width: '100%' }}>
          
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3rem', alignItems: 'flex-start', justifyContent: 'space-between', width: '100%' }}>
            
            {/* 왼쪽: 기존 선수 메타 정보 (타이포그래피 위주) */}
            <div style={{ flex: '1 1 400px' }}>
              <div className={styles.heroKicker} style={{ letterSpacing: '0.2em', color: 'var(--hero-team)', fontWeight: 800, marginBottom: '1rem' }}>COURTSIDE PLAYER PROFILE</div>
              <h1 className={styles.heroName} style={{ fontSize: '5rem', lineHeight: 0.9, textShadow: '2px 2px 0 var(--hero-team), 4px 4px 0 rgba(0,0,0,0.5)', textTransform: 'uppercase', fontStyle: 'italic' }}>{info.ename || info.name}</h1>
              <h2 style={{ fontSize: '2rem', color: '#fff', marginTop: '0.5rem', opacity: 0.9 }}>{info.name}</h2>
              <div className={styles.heroMeta} style={{ marginTop: '1.5rem', fontSize: '1.2rem' }}>
                <TeamBadge team={headerTeam} size={28} />
                <span>{status.teamName ?? "-"}</span>
                <span className={styles.heroMetaDot}>·</span>
                <span>{status.pos ?? "-"}</span>
                {status.backNum && (
                  <>
                    <span className={styles.heroMetaDot}>·</span>
                    <span style={{ color: 'var(--hero-team)', fontWeight: 'bold' }}>
                      {status.backNumAsLastSeason && status.backNumSeason ? `${shortSeason(status.backNumSeason)} ` : ""}#{status.backNum}
                    </span>
                  </>
                )}
                <span className={styles.heroMetaDot}>·</span>
                <span>커리어 {careerGp}경기</span>
              </div>
              
              {heroSeason && (
                <div className={styles.heroStatRow} style={{ marginTop: '2.5rem', background: 'rgba(0,0,0,0.4)', padding: '1.5rem', borderRadius: '12px', border: '1px solid rgba(255,255,255,0.1)' }}>
                  {(
                    [
                      ["PPG", heroSeason.ppg.toFixed(1)],
                      ["RPG", heroSeason.rpg.toFixed(1)],
                      ["APG", heroSeason.apg.toFixed(1)],
                      ["TS%", heroSeason.tsPct != null ? `${(heroSeason.tsPct * 100).toFixed(1)}` : "-"],
                    ] as const
                  ).map(([label, val]) => (
                    <div className={styles.heroStat} key={label}>
                      <div className={styles.heroStatVal} style={{ fontSize: '2.2rem', color: '#fff' }}>{val}</div>
                      <div className={styles.heroStatLabel}>
                        {label} · {shortSeason(heroSeason.seasonName)}
                      </div>
                    </div>
                  ))}
                  {heroWpa && (
                    <div className={styles.heroStat}>
                      <div className={styles.heroStatVal} style={{ fontSize: '2.2rem', color: '#fff' }}>{signed(heroWpa.totalWpa)}</div>
                      <div className={styles.heroStatLabel}>WPA · {shortSeason(heroWpa.seasonName)}</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 오른쪽: 2K 스타일 선수 카드 */}
            {latestOvr && (
              <div style={{ flexShrink: 0, transform: 'scale(1.1)', transformOrigin: 'top right', zIndex: 20 }}>
                <CourtsidePlayerCard
                  name={info.name}
                  ename={info.ename || "KBL PLAYER"}
                  team={status.teamName || "KBL"}
                  number={status.backNum ? parseInt(status.backNum, 10) : 0}
                  ovr={latestOvr.OVR}
                  offOvr={latestOvr.OFF}
                  defOvr={latestOvr.DEF}
                  photoUrl={info.photoUrl}
                />
              </div>
            )}
          </div>
          
          {/* 하단: OVR 트렌드 차트 (보라색/팀컬러 영역 차트) */}
          {ovrHistory.length > 0 && (
            <div style={{ width: '100%', marginTop: '2rem' }}>
              <OvrTrendChart history={ovrHistory} teamColor={teamColor} />
            </div>
          )}

        </div>
      </section>"""
    
    content = content[:start_idx] + new_hero + content[end_idx:]
    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print("SUCCESS: Hero section replaced.")
else:
    print("ERROR: Could not find start or end marker.")
