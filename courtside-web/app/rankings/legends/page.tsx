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
