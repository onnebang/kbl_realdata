import React from 'react';

// 팀 테마 컬러 (임의 데이터)
const TEAM_COLORS: Record<string, string> = {
  'KCC': '#002E6D',
  'SK': '#E00000',
  'DB': '#006B54',
  'LG': '#A50034',
  'KT': '#000000',
  'KGC': '#C8102E',
  'MOBIS': '#E3002B',
  'GAS': '#0033A0',
  'SONO': '#61C2A2',
  'SAMSUNG': '#074BB8',
};

interface CourtsidePlayerCardProps {
  name: string;
  ename?: string;
  team: string; // ex: 'KCC'
  number: number;
  ovr: number;
  offOvr: number;
  defOvr: number;
  photoUrl: string;
}

export default function CourtsidePlayerCard({
  name,
  ename = 'NIKOLA JOKIC', // 더미
  team,
  number,
  ovr,
  offOvr,
  defOvr,
  photoUrl
}: CourtsidePlayerCardProps) {
  
  const bgColor = TEAM_COLORS[team] || '#1a1a1a';
  
  // OVR 구간에 따른 색상/이펙트
  const getTierClass = (rating: number) => {
    if (rating >= 95) return 'text-[#FFD700] drop-shadow-[0_0_15px_rgba(255,215,0,0.8)]'; // 골드
    if (rating >= 85) return 'text-[#C0C0C0] drop-shadow-[0_0_10px_rgba(192,192,192,0.8)]'; // 실버
    if (rating >= 75) return 'text-[#CD7F32] drop-shadow-[0_0_8px_rgba(205,127,50,0.6)]'; // 브론즈
    return 'text-white';
  };

  return (
    <div 
      className="relative w-[400px] h-[550px] rounded-2xl overflow-hidden shadow-2xl group transition-transform duration-300 hover:scale-[1.02]"
      style={{ background: `linear-gradient(135deg, ${bgColor} 0%, #000000 100%)` }}
    >
      {/* 2K Style Background Typography (Massive OVR) */}
      <div className={`absolute top-[-20px] left-[-20px] text-[280px] font-black leading-none opacity-20 select-none ${getTierClass(ovr)} italic`}>
        {ovr}
      </div>

      {/* Top Header Information */}
      <div className="absolute top-6 left-6 right-6 flex justify-between items-start z-10">
        <div className="flex flex-col">
          <span className={`text-7xl font-black italic tracking-tighter ${getTierClass(ovr)}`}>
            {ovr}
          </span>
          <span className="text-white/60 text-sm font-bold tracking-widest ml-1 -mt-2">OVR</span>
        </div>
        
        <div className="flex flex-col items-end">
          <span className="text-white/80 text-xl font-light tracking-widest uppercase">{ename.split(' ')[0]}</span>
          <span className="text-white text-4xl font-black uppercase tracking-tight">{ename.split(' ')[1] || name}</span>
        </div>
      </div>

      {/* Player Image (Cutout) */}
      <div className="absolute bottom-0 left-1/2 transform -translate-x-1/2 w-[90%] h-[75%] z-20 pointer-events-none">
        <img 
          src={photoUrl} 
          alt={name} 
          className="w-full h-full object-cover object-bottom drop-shadow-[0_10px_20px_rgba(0,0,0,0.5)] transition-transform duration-500 group-hover:scale-105"
        />
      </div>

      {/* Sub Ratings Bar (Glassmorphism overlay) */}
      <div className="absolute bottom-0 w-full h-[100px] bg-black/40 backdrop-blur-md border-t border-white/10 z-30 p-4 flex flex-col justify-center">
        
        {/* Badges / Sub OVRs */}
        <div className="flex justify-around items-center w-full mt-2">
          <div className="flex flex-col items-center">
            <span className="text-white/50 text-[10px] font-bold tracking-widest mb-1">OFFENSE</span>
            <div className={`px-4 py-1 rounded-full bg-black/50 border border-white/10 font-bold ${getTierClass(offOvr)}`}>
              {offOvr}
            </div>
          </div>
          
          <div className="flex flex-col items-center">
            <span className="text-white/50 text-[10px] font-bold tracking-widest mb-1">DEFENSE</span>
            <div className={`px-4 py-1 rounded-full bg-black/50 border border-white/10 font-bold ${getTierClass(defOvr)}`}>
              {defOvr}
            </div>
          </div>
          
          <div className="flex flex-col items-center">
            <span className="text-white/50 text-[10px] font-bold tracking-widest mb-1">TEAM / NUM</span>
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/10 text-white font-bold">
              <span>{team}</span>
              <span className="text-white/30">|</span>
              <span>#{number}</span>
            </div>
          </div>
        </div>
        
      </div>
      
      {/* Decorative Border Frame */}
      <div className="absolute inset-2 border-2 border-white/10 rounded-xl z-40 pointer-events-none group-hover:border-[#FFD700]/30 transition-colors duration-500"></div>
    </div>
  );
}
