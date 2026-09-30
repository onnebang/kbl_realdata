// courtside_template.html의 josa()/eunNeun()/iGa() 그대로 포팅 - 받침 유무로 한글 조사
// (은/는, 이/가) 자동 선택. 한글이 아닌 마지막 글자(영문 팀명 약자 등)는 받침 없는 쪽으로
// 폴백(코드사이드 원본과 동일 동작).
function josa(word: string, withBatchim: string, withoutBatchim: string): string {
  if (!word) return withoutBatchim;
  const code = word.charCodeAt(word.length - 1);
  if (code < 0xac00 || code > 0xd7a3) return withoutBatchim;
  return (code - 0xac00) % 28 !== 0 ? withBatchim : withoutBatchim;
}

export function eunNeun(word: string): string {
  return josa(word, "은", "는");
}

export function iGa(word: string): string {
  return josa(word, "이", "가");
}

/**
 * 와/과. 받침이 있으면 '과'(벨란겔**과**), 없으면 '와'(마레이**와**).
 *
 * 왜 뒤늦게 추가했나: 이 조사만 헬퍼가 없어서 components/report/AceDuelSection.tsx가 '와'를
 * 하드코딩하고 있었고, 배포본에 "루이스 킹와 양홍석"이 그대로 나가 있었다(2026-09-30 실측).
 */
export function waGwa(word: string): string {
  return josa(word, "과", "와");
}
