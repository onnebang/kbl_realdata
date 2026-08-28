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
