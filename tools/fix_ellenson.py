import json

def fix_awards():
    path = "D:/영상작업/축구/개발/kbl_realdata/courtside-web/lib/courtside_awards.json"
    with open(path, "r", encoding="utf-8") as f:
        db = json.load(f)

    # 1. Remove 2025-26 from Yoo Ki-sang (291640)
    yoo = db.get("291640", [])
    for a in yoo:
        if a["id"] == "round_mvp":
            if "2025-26" in a["years"]:
                a["years"].remove("2025-26")
                a["count"] = len(a["years"])
    
    # Clean up empty awards
    db["291640"] = [a for a in yoo if a["count"] > 0]
    
    # 2. Add 2025-26 to Henry Ellenson (291785)
    henry = db.get("291785", [])
    found = False
    for a in henry:
        if a["id"] == "round_mvp":
            if "2025-26" not in a["years"]:
                a["years"].insert(0, "2025-26")
                a["years"].sort(reverse=True)
                a["count"] = len(a["years"])
            found = True
    
    if not found:
        henry.append({
            "id": "round_mvp",
            "name": "라운드 MVP",
            "count": 1,
            "years": ["2025-26"]
        })
    db["291785"] = henry
    
    with open(path, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    fix_awards()
    print("Fixed Ellenson MVP.")
