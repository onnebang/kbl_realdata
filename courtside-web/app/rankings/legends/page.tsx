import type { Metadata } from "next";
import fs from "fs";
import path from "path";
import LegendsClient from "./LegendsClient";

export default async function LegendsPage() {
  const jsonPath = path.join(process.cwd(), "lib", "alltime_leaders.json");
  let leaders = {};

  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    leaders = JSON.parse(raw);
  }

  return <LegendsClient leaders={leaders} />;
}

export const metadata: Metadata = {
  title: "올타임 리더스",
  description: "KBL 통산 기록 순위(nba.com All-Time Leaders 참고) - 현역 선두와 역대 1위의 격차까지",
};
