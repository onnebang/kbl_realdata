import React from 'react';
import CourtsidePlayerCard from '../../components/CourtsidePlayerCard';
import ovrData from '../../../data/courtside_ovr.json';

export default function OvrDemoPage() {
  // 상위 8명만 샘플로 보여주기
  const displayPlayers = ovrData.slice(0, 8).map(p => ({
    ...p,
    ename: 'KBL PLAYER', // 임시 영문명
    photoUrl: `https://kbl.or.kr/images/players/${p.pcode}.jpg`,
    team: 'KBL', // JSON에 팀이 없어서 임시값
    number: 0
  }));

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white py-20 px-10">
      <div className="max-w-7xl mx-auto">
        <div className="mb-16 text-center">
          <h1 className="text-5xl font-black italic tracking-tighter mb-4 text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-yellow-200">
            COURTSIDE OVR DEMO
          </h1>
          <p className="text-white/50 text-xl font-light">
            데이터 기반의 프리미엄 2K 스타일 프로필 카드 프리뷰
          </p>
        </div>

        <div className="flex flex-wrap justify-center gap-10">
          {displayPlayers.map((player, idx) => (
            <CourtsidePlayerCard 
              key={idx}
              name={player.name}
              ename={player.ename}
              team={player.team}
              number={player.number}
              ovr={player.OVR}
              offOvr={player.OFF}
              defOvr={player.DEF}
              photoUrl={player.photoUrl}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
