#!/usr/bin/env python3
"""Build a dated 40-man roster snapshot from MLB Stats API."""

import argparse
import csv
import json
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

API = "https://statsapi.mlb.com/api/v1"
MLB = "https://www.mlb.com"
ASSETS = "https://img.mlbstatic.com/mlb-photos/image/upload"
OUTPUT = Path(__file__).resolve().parents[1] / "docs" / "data"
TAIPEI = ZoneInfo("Asia/Taipei")

LEAGUES = {103: ("AL", "美國聯盟"), 104: ("NL", "國家聯盟")}
DIVISIONS = {
    201: ("AL East", "東區", 0), 202: ("AL Central", "中區", 1),
    200: ("AL West", "西區", 2), 204: ("NL East", "東區", 0),
    205: ("NL Central", "中區", 1), 203: ("NL West", "西區", 2),
}

# Taiwanese team names and canonical MLB.com paths, keyed by MLB team ID.
TEAMS = {
    108: ("洛杉磯天使", "天使", "angels", "#BA0021"),
    109: ("亞利桑那響尾蛇", "響尾蛇", "dbacks", "#A71930"),
    110: ("巴爾的摩金鶯", "金鶯", "orioles", "#DF4601"),
    111: ("波士頓紅襪", "紅襪", "redsox", "#BD3039"),
    112: ("芝加哥小熊", "小熊", "cubs", "#0E3386"),
    113: ("辛辛那提紅人", "紅人", "reds", "#C6011F"),
    114: ("克里夫蘭守護者", "守護者", "guardians", "#0C2340"),
    115: ("科羅拉多洛磯", "洛磯", "rockies", "#56368A"),
    116: ("底特律老虎", "老虎", "tigers", "#0C2340"),
    117: ("休士頓太空人", "太空人", "astros", "#B94700"),
    118: ("堪薩斯市皇家", "皇家", "royals", "#004687"),
    119: ("洛杉磯道奇", "道奇", "dodgers", "#005A9C"),
    120: ("華盛頓國民", "國民", "nationals", "#AB0003"),
    121: ("紐約大都會", "大都會", "mets", "#002D72"),
    133: ("運動家", "運動家", "athletics", "#003831"),
    134: ("匹茲堡海盜", "海盜", "pirates", "#80530A"),
    135: ("聖地牙哥教士", "教士", "padres", "#583325"),
    136: ("西雅圖水手", "水手", "mariners", "#005C5C"),
    137: ("舊金山巨人", "巨人", "giants", "#B73A0C"),
    138: ("聖路易紅雀", "紅雀", "cardinals", "#C41E3A"),
    139: ("坦帕灣光芒", "光芒", "rays", "#092C5C"),
    140: ("德州遊騎兵", "遊騎兵", "rangers", "#003278"),
    141: ("多倫多藍鳥", "藍鳥", "bluejays", "#134A8E"),
    142: ("明尼蘇達雙城", "雙城", "twins", "#002B5C"),
    143: ("費城費城人", "費城人", "phillies", "#C42A38"),
    144: ("亞特蘭大勇士", "勇士", "braves", "#B4213E"),
    145: ("芝加哥白襪", "白襪", "whitesox", "#272A2C"),
    146: ("邁阿密馬林魚", "馬林魚", "marlins", "#007DA5"),
    147: ("紐約洋基", "洋基", "yankees", "#003087"),
    158: ("密爾瓦基釀酒人", "釀酒人", "brewers", "#12284B"),
}

# Common Chinese names are keyed by the official English spelling in the roster.
NAME_ALIASES = {
    "Shohei Ohtani": ["大谷翔平", "大谷"],
    "Yoshinobu Yamamoto": ["山本由伸", "山本"],
    "Roki Sasaki": ["佐佐木朗希", "佐々木朗希", "朗希"],
    "Shota Imanaga": ["今永昇太", "今永升太"],
    "Kodai Senga": ["千賀滉大"],
    "Yu Darvish": ["達比修有", "達比修"],
    "Jung Hoo Lee": ["李政厚"],
    "Ha-Seong Kim": ["金河成"],
    "Hyeseong Kim": ["金慧成", "金惠成"],
    "Freddie Freeman": ["弗里曼"],
    "Mookie Betts": ["貝茲", "貝特斯"],
    "Aaron Judge": ["賈吉", "法官"],
    "Hao-Yu Lee": ["李灝宇", "李灏宇"],
    "Yu-Min Lin": ["林昱珉"],
    "Kai-Wei Teng": ["鄧愷威", "邓恺威"],
    "Tsung-Che Cheng": ["鄭宗哲", "郑宗哲"],
    "Po-Yu Chen": ["陳柏毓"],
    "Shinnosuke Ogasawara": ["小笠原慎之介"],
    "Tomoyuki Sugano": ["菅野智之"],
    "Yuki Matsui": ["松井裕樹"],
    "Masataka Yoshida": ["吉田正尚"],
    "Yusei Kikuchi": ["菊池雄星"],
    "Seiya Suzuki": ["鈴木誠也"],
    "Munetaka Murakami": ["村上宗隆"],
    "Kazuma Okamoto": ["岡本和真"],
    "Tatsuya Imai": ["今井達也"],
    "Ketel Marte": ["馬提"],
}

POSITIONS = {
    "P": ("pitcher", "投手"), "SP": ("pitcher", "先發投手"),
    "RP": ("pitcher", "後援投手"), "C": ("catcher", "捕手"),
    "1B": ("infield", "一壘手"), "2B": ("infield", "二壘手"),
    "3B": ("infield", "三壘手"), "SS": ("infield", "游擊手"),
    "IF": ("infield", "內野手"), "LF": ("outfield", "左外野手"),
    "CF": ("outfield", "中外野手"), "RF": ("outfield", "右外野手"),
    "OF": ("outfield", "外野手"), "DH": ("other", "指定打擊"),
    "TWP": ("other", "二刀流"), "UT": ("other", "工具人"),
}

TEAM_IDS_IN_HTML = re.compile(rb'href="/player/(\d+)(?:[?#][^"]*)?"')


def fetch(url):
    request = Request(url, headers={"User-Agent": "MLB-40-Man-Roster-Directory/1.0"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                return response.read()
        except (URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def api_url(path, **parameters):
    return f"{API}{path}?{urlencode(parameters)}"


def age_at(birthday, snapshot):
    if not birthday:
        return None
    born = date.fromisoformat(birthday)
    return snapshot.year - born.year - ((snapshot.month, snapshot.day) < (born.month, born.day))


def metric_height(height):
    match = re.fullmatch(r"""(\d+)'\s*(\d+)["]""", height or "")
    if match:
        feet, inches = (int(value) for value in match.groups())
        return round((feet * 12 + inches) * 2.54)


def excludes_slot(status):
    code = status.get("code", "").upper()
    description = status.get("description", "").lower()
    return code in {"D60", "IL60", "IL-60", "SUSP", "RST"} or bool(
        re.search(r"60[- ]day|restricted list", description)
    )


def player_record(row, snapshot):
    bio = row["person"]
    player_id = bio["id"]
    name = bio["fullName"]
    position = row["position"]
    code = position["abbreviation"]
    group, position_zh = POSITIONS.get(code, ("other", position["name"]))
    return {
        "id": player_id,
        "name": name,
        "searchAliases": NAME_ALIASES.get(name, []),
        "firstName": bio.get("firstName"),
        "lastName": bio.get("lastName"),
        "jersey": row.get("jerseyNumber") or None,
        "position": code,
        "positionName": position["name"],
        "positionZh": position_zh,
        "positionGroup": group,
        "status": row["status"],
        "birthDate": bio.get("birthDate"),
        "age": age_at(bio.get("birthDate"), snapshot),
        "birthCity": bio.get("birthCity"),
        "birthRegion": bio.get("birthStateProvince"),
        "birthCountry": bio.get("birthCountry"),
        "height": bio.get("height"),
        "heightCm": metric_height(bio.get("height")),
        "weightLb": bio.get("weight"),
        "weightKg": round(bio["weight"] * 0.45359237) if bio.get("weight") else None,
        "bats": bio.get("batSide", {}).get("code"),
        "throws": bio.get("pitchHand", {}).get("code"),
        "debutDate": bio.get("mlbDebutDate"),
        "draftYear": bio.get("draftYear"),
        "profileUrl": f"{MLB}/player/{bio.get('nameSlug') or player_id}",
        "headshotUrl": f"{ASSETS}/d_people:generic:headshot:silo:current.png/w_320,f_webp,q_auto:good/v1/people/{player_id}/headshot/silo/current",
    }


def load_team(raw_team, snapshot, verify_web):
    team_id = raw_team["id"]
    name_zh, short_zh, path, color = TEAMS[team_id]
    league_id = raw_team["league"]["id"]
    division_id = raw_team["division"]["id"]
    league, league_zh = LEAGUES[league_id]
    division, division_zh, division_order = DIVISIONS[division_id]
    source = api_url(f"/teams/{team_id}/roster", rosterType="40Man",
                     season=snapshot.year, date=snapshot.isoformat(), hydrate="person")
    roster_page = f"{MLB}/{path}/roster/40-man"
    payload = json.loads(fetch(source))
    if payload.get("teamId") != team_id or payload.get("rosterType") != "40Man":
        raise ValueError(f"Unexpected roster response for {name_zh}")
    all_rows = payload["roster"]
    if any(row.get("parentTeamId") != team_id for row in all_rows):
        raise ValueError(f"Unexpected parent team in {name_zh}")
    official_ids = {row["person"]["id"] for row in all_rows}
    if len(official_ids) != len(all_rows):
        raise ValueError(f"Duplicate roster records in {name_zh}")

    if verify_web:
        web_ids = set(map(int, TEAM_IDS_IN_HTML.findall(fetch(roster_page))))
        if official_ids != web_ids:
            raise ValueError(f"{name_zh}: MLB.com IDs differ from API. API only {official_ids - web_ids}, page only {web_ids - official_ids}")

    included = [row for row in all_rows if not excludes_slot(row["status"])]
    if not 0 < len(included) <= 40:
        raise ValueError(f"Unexpected roster size in {name_zh}: {len(included)}")
    omitted_statuses = Counter(row["status"]["code"] for row in all_rows if excludes_slot(row["status"]))
    print(f"{raw_team['abbreviation']}: {len(included)} on roster, {dict(omitted_statuses)} exempt", flush=True)
    return {
        "id": team_id,
        "name": raw_team["name"],
        "nameZh": name_zh,
        "shortNameZh": short_zh,
        "abbr": raw_team["abbreviation"],
        "league": league,
        "leagueZh": league_zh,
        "division": division,
        "divisionZh": division_zh,
        "divisionOrder": division_order,
        "ballpark": raw_team["venue"]["name"],
        "color": color,
        "logoUrl": f"https://www.mlbstatic.com/team-logos/{team_id}.svg",
        "rosterUrl": roster_page,
        "sourceUrl": source,
        "exemptStatusCounts": dict(omitted_statuses),
        "players": [player_record(row, snapshot) for row in included],
    }


def write_snapshot(teams, snapshot, teams_url, verified):
    count = sum(len(team["players"]) for team in teams)
    player_ids = {player["id"] for team in teams for player in team["players"]}
    if len(player_ids) != count:
        raise ValueError("Identical player IDs appear on two teams")
    data = {
        "season": snapshot.year,
        "rosterDate": snapshot.isoformat(),
        "capturedAt": datetime.now(TAIPEI).isoformat(timespec="seconds"),
        "timezone": "Asia/Taipei",
        "rosterType": "40Man",
        "teamCount": len(teams),
        "playerCount": count,
        "teamPagesVerified": verified,
        "sources": {
            "teams": teams_url,
            "rule": f"{MLB}/glossary/transactions/40-man-roster",
            "scope": "MLB 40-man roster slots; excludes 60-day IL and other exempt entries.",
        },
        "teams": teams,
    }
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / "rosters.json").open("w", encoding="utf-8") as stream:
        json.dump(data, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")

    keys = [
        "id", "name", "jersey", "position", "positionName", "positionZh", "bats", "throws",
        "age", "birthDate", "birthCity", "birthRegion", "birthCountry", "height", "heightCm",
        "weightLb", "weightKg", "debutDate", "draftYear", "profileUrl", "headshotUrl",
    ]
    with (OUTPUT / "mlb-40-man.csv").open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow([
            "rosterDate", "league", "division", "teamId", "team", "teamZh", "teamAbbr",
            "statusCode", "statusDescription", *keys,
        ])
        for team in teams:
            for player in team["players"]:
                writer.writerow([
                    snapshot.isoformat(), team["league"], team["division"], team["id"],
                    team["name"], team["nameZh"], team["abbr"], player["status"]["code"],
                    player["status"]["description"], *(player[key] for key in keys),
                ])
    print(f"Wrote {len(teams)} teams and {count} unique players. Statuses: {Counter(p['status']['code'] for t in teams for p in t['players'])}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, default=datetime.now(TAIPEI).date())
    parser.add_argument("--verify-current-pages", action="store_true", help="Verify team API results against the current roster pages.")
    options = parser.parse_args()
    teams_url = api_url("/teams", sportId=1, season=options.date.year)
    raw_teams = json.loads(fetch(teams_url))["teams"]
    if {team["id"] for team in raw_teams} != set(TEAMS) or len(raw_teams) != len(TEAMS):
        raise ValueError("MLB's team endpoint did not return the expected 30 clubs")
    with ThreadPoolExecutor(max_workers=10) as pool:
        teams = list(pool.map(lambda team: load_team(team, options.date, options.verify_current_pages), raw_teams))
    teams.sort(key=lambda team: (team["league"], team["divisionOrder"], team["name"]))
    write_snapshot(teams, options.date, teams_url, options.verify_current_pages)


if __name__ == "__main__":
    main()
