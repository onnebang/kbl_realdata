import rawStyles from "./play_styles.json";

/**
 * 플레이 스타일(메인/서브) 목록의 화면 쪽 창구. 목록 자체(key/라벨/설명)는 tools/build_courtside_ovr.py가
 * tools/play_styles.py에서 뽑아 play_styles.json으로 내보낸다 - 라벨·설명을 여기 다시 적지 말 것.
 * 구형 iOS Safari에서도 돌아야 해서 .at()/Object.fromEntries 같은 최신 API 없이 쓴다.
 */
export interface PlayStyle {
  key: string;
  label: string;
  description: string;
}

const STYLES = rawStyles as PlayStyle[];
const BY_KEY: { [key: string]: PlayStyle } = {};
const BY_LABEL: { [label: string]: PlayStyle } = {};
for (let i = 0; i < STYLES.length; i++) {
  BY_KEY[STYLES[i].key] = STYLES[i];
  BY_LABEL[STYLES[i].label] = STYLES[i];
}

/** 영문 key(예: "Clutch Closer") -> 한글 라벨. 모르는 key면 undefined. */
export function styleLabel(key: string | null | undefined): string | undefined {
  return key && BY_KEY[key] ? BY_KEY[key].label : undefined;
}

/** 영문 key -> 툴팁용 한 문장 설명. 모르는 key면 undefined. */
export function styleDescription(key: string | null | undefined): string | undefined {
  return key && BY_KEY[key] ? BY_KEY[key].description : undefined;
}

/** 이미 한글 라벨만 들고 있는 화면(archetype 필드)용 - 라벨 -> 설명. */
export function styleDescriptionByLabel(label: string | null | undefined): string | undefined {
  return label && BY_LABEL[label] ? BY_LABEL[label].description : undefined;
}
