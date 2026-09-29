import { Fragment } from "react";
import { fmtDuration } from "@/lib/report/renderKit";
import type { UnsungChore, UnsungHeroes } from "@/lib/report/unsungHero";
import { PlayerTag, ReportLi, TeamInk } from "./tags";

// AI 코트사이드 리포트 2.5 "스탯에 보이지 않은 선수" - 기존 문자열 조립을 선언적 컴포넌트로
// 옮긴 두 번째 섹션(AceDuelSection.tsx가 첫 번째). 렌더 결과는 기존과 **바이트 단위로 같다**
// (UnsungHeroSection.test.tsx가 고정 - 리팩터링과 문구 변경을 섞지 않기 위해 한 글자도
// 바꾸지 않았다). 문장 한 줄이 통째로 한 행인 이유: JSX가 줄바꿈 들여쓰기를 공백으로
// 합쳐버려서, 여러 줄로 쪼개면 기존 HTML과 공백이 달라진다.

/** renderKit의 sign()과 같은 규칙(+만 붙이고 -는 그대로). 한 줄짜리라 옮기지 않고 여기 둔다. */
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

/** 궂은일 스탯 나열. 하나도 없으면 문장이 통째로 달라진다(원본과 같은 두 갈래). */
function Chores({ chores }: { chores: UnsungChore[] }) {
  if (!chores.length) return <> 비록 스탯 라인은 단출했으나,</>;
  return (
    <> 비록 득점은 적었으나 {chores.map((c, i) => (<Fragment key={c.label}>{i > 0 ? " " : ""}<b>{c.value}{c.label}</b></Fragment>))} 등 궂은일을 도맡았으며,</>
  );
}

export function UnsungHeroSection({ heroes }: { heroes: UnsungHeroes }) {
  return (
    <ul className="report-list">
      {heroes.heroes.map((h) => (
        <ReportLi team={h.team} key={`${h.team.tcode}:${h.name}`}>
          <b><PlayerTag team={h.team} name={h.name} /></b> - 오늘 <b>{h.pts}득점</b>에 그쳤지만,<Chores chores={h.chores} /> 그가 코트를 밟은 {fmtDuration(h.onSec)} 동안 팀은 마진 <b>{signed(h.onMargin)}</b>를 기록했습니다. 반면 벤치에서 쉰 {fmtDuration(h.offSec)} 동안에는 팀 마진이 <b>{signed(h.offMargin)}</b>로 무너졌습니다. 코트 위에서 <TeamInk team={h.team} />의 공수 밸런스를 든든하게 지탱했습니다.
        </ReportLi>
      ))}
    </ul>
  );
}
