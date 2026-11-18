#!/usr/bin/env python3
"""Build annual league totals from Lahman Teams.csv and Retrosheet regular-season game logs.

Usage: python3 scripts/update-league-trends.py Teams.csv RETROSHEET_SEASONS
The Retrosheet directory can contain GLYYYY.TXT files in year subdirectories.
Use --mlb-season YEAR to add or refresh a season directly from MLB Stats.
"""
import argparse
import csv
import json
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

# Keep the same leagues and seasons as the site's historical rosters.
LEAGUES = {
    "NA": (1871, 1875), "NL": (1876, 9999), "AL": (1901, 9999),
    "AA": (1882, 1891), "UA": (1884, 1884), "PL": (1890, 1890), "FL": (1914, 1915),
    "NNL": (1920, 1931), "ECL": (1923, 1928), "ANL": (1929, 1929),
    "EWL": (1932, 1932), "NSL": (1932, 1932), "NN2": (1933, 1948), "NAL": (1937, 1948),
}
COLUMNS = "T G R AB H 2B 3B HR BB SO SB CS HBP SF PA ER IPouts HA HRA BBA SOA RA TBF".split()
OUTPUT = Path(__file__).resolve().parents[1] / "docs/data/league-trends.json"


def add(rows, key):
    values = [row.get(key) for row in rows]
    return sum(values) if values and all(isinstance(v, int) for v in values) else None


def team_counts(path):
    teams = defaultdict(list)
    with path.open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            year, league = int(row["yearID"]), row["lgID"]
            if league not in LEAGUES or not LEAGUES[league][0] <= year <= LEAGUES[league][1]:
                continue
            counts = {"T": 1}
            for key in COLUMNS:
                if key == "T":
                    continue
                field = row.get(key, row.get("X" + key, ""))
                counts[key] = int(field) if field and field.isdecimal() else None
            teams[year, league].append(counts)
    return teams


def summarize_log(path):
    # Offensive columns 22–38 and 50–66, with interference included in PA.
    def initial():
        return {"G": 0, "noPlay": 0, "AB": 0, "PA": 0, "TBF": 0, "HBP": 0, "SF": 0}
    leagues = defaultdict(initial)
    with path.open(encoding="latin-1", newline="") as source:
        for record in csv.reader(source):
            # A forfeit before any play contributes no plate appearances.
            # Some official season records include that game in games played.
            unplayed = (record[14] in {"H", "V", "T"} and record[9:12] == ["0", "0", "0"]
                        and not any(record[19:77]))
            for batting, opposing, start in ((record[4], record[7], 21), (record[7], record[4], 49)):
                bat, pit = leagues[batting], leagues[opposing]
                bat["G"] += 1
                if unplayed:
                    bat["noPlay"] += 1
                    continue
                columns = [record[start+i] for i in (0, 6, 7, 8, 9, 15)]
                for key, index in (("AB", 0), ("HBP", 3), ("SF", 2)):
                    value = columns[index]
                    bat[key] = bat[key] + int(value) if bat[key] is not None and value.isdecimal() else None
                if not all(value.isdecimal() for value in columns):
                    bat["PA"] = pit["TBF"] = None
                    continue
                total = sum(map(int, columns))
                if bat["PA"] is not None:
                    bat["PA"] += total
                if pit["TBF"] is not None:
                    pit["TBF"] += total
    return leagues


def archive(teams, logs):
    seasons = {}
    for (year, league), rows in sorted(teams.items()):
        sums = {key: add(rows, key) for key in COLUMNS}
        supplemental = logs.get(str(year), {}).get(league, {})
        # Complete Retrosheet game coverage is required. Historical scoring
        # corrections can shift an individual at-bat between source editions.
        games = supplemental.get("G")
        if games is not None and sums["G"] in (games, games - supplemental.get("noPlay", 0)):
            for key in ("PA", "TBF"):
                sums[key] = supplemental.get(key)
            for key in ("HBP", "SF"):
                if year >= 1954 and sums[key] is None:
                    sums[key] = supplemental.get(key)
        seasons.setdefault(year, {})[league] = sums
    return seasons


def mlb_json(path, params):
    url = "https://statsapi.mlb.com/api/v1/" + path + "?" + urlencode(params)
    req = Request(url, headers={"User-Agent": "MLB Roster Directory, annual league totals"})
    with urlopen(req, timeout=30) as response:
        return json.load(response)


def mlb_season(year):
    clubs = mlb_json("teams", {"season": year, "sportId": 1})["teams"]
    leagues = {c["id"]: {103: "AL", 104: "NL"}[c["league"]["id"]] for c in clubs
               if c.get("league", {}).get("id") in (103, 104)}
    teams = {tid: {"T": 1} for tid in leagues}
    fields = {
        "hitting": dict(zip("G R AB H 2B 3B HR BB SO SB CS HBP SF PA".split(),
                            "gamesPlayed runs atBats hits doubles triples homeRuns baseOnBalls strikeOuts stolenBases caughtStealing hitByPitch sacFlies plateAppearances".split())),
        "pitching": dict(zip("ER IPouts HA HRA BBA SOA RA TBF".split(),
                             "earnedRuns outs hits homeRuns baseOnBalls strikeOuts runs battersFaced".split())),
    }
    for group, definitions in fields.items():
        blocks = mlb_json("teams/stats", {"stats": "season", "group": group, "sportIds": 1, "season": year,
                                          "gameType": "R", "limit": 100})["stats"]
        splits = next(b["splits"] for b in blocks if b["group"]["displayName"] == group)
        seen = set()
        for row in splits:
            tid, stat = row["team"]["id"], row["stat"]
            if tid not in teams or tid in seen or int(row["season"]) != year:
                raise ValueError("Unexpected MLB team or season")
            seen.add(tid)
            for key, field in definitions.items():
                value = stat.get(field)
                if key == "IPouts" and value is None:
                    innings, outs = stat["inningsPitched"].split(".")
                    if outs not in ("0", "1", "2"):
                        raise ValueError("Invalid innings pitched")
                    value = int(innings) * 3 + int(outs)
                if type(value) is not int or value < 0:
                    raise ValueError(f"Missing {group} {field} for {tid}")
                teams[tid][key] = value
        if not teams or seen != teams.keys():
            raise ValueError("Incomplete MLB team coverage")
    return {lg: {key: add([r for tid, r in teams.items() if leagues[tid] == lg], key)
                 for key in COLUMNS} for lg in set(leagues.values())}


def write(path, seasons):
    series = {}
    for year, leagues in sorted(seasons.items()):
        all_teams = list(leagues.values())
        combined = {"MLB": {c: add(all_teams, c) for c in COLUMNS}, **leagues}
        series[str(year)] = {lg: [record[c] for c in COLUMNS] for lg, record in combined.items()}
    payload = {"columns": COLUMNS, "seasons": series}
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("teams", type=Path)
    parser.add_argument("retrosheet", type=Path)
    parser.add_argument("--mlb-season", action="append", type=int, default=[])
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    files = [p for p in args.retrosheet.rglob("*") if p.is_file() and p.stem.upper().startswith("GL")
             and p.stem[2:].isdigit() and p.suffix.lower() == ".txt"]
    if not files:
        parser.error("No annual Retrosheet game logs found")
    logs = {p.stem[2:]: summarize_log(p) for p in files}
    seasons = archive(team_counts(args.teams), logs)
    seasons.update((year, mlb_season(year)) for year in args.mlb_season)
    write(args.output, seasons)


if __name__ == "__main__":
    main()
