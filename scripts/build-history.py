#!/usr/bin/env python3
"""Build the appearance archive and optionally the historical standings archive.

Usage: python3 scripts/build-history.py LAHMAN_CSV_DIR REGISTER_DATA_DIR
Lahman Baseball Database © 1996–2025 SABR: https://sabr.org/lahman-database/
The derived appearance archive is shared under CC BY-SA 3.0:
https://creativecommons.org/licenses/by-sa/3.0/
Chadwick Bureau Register (ODC-By): https://github.com/chadwickbureau/register
"""
import argparse
from collections import defaultdict
import csv
import gzip
import json
from pathlib import Path

LEAGUES = {
    "NA": (1871, 1875), "NL": (1876, 9999), "AL": (1901, 9999),
    "AA": (1882, 1891), "UA": (1884, 1884), "PL": (1890, 1890), "FL": (1914, 1915),
    "NNL": (1920, 1931), "ECL": (1923, 1928), "ANL": (1929, 1929),
    "EWL": (1932, 1932), "NSL": (1932, 1932), "NN2": (1933, 1948), "NAL": (1937, 1948),
}
POSITIONS = ["—", "P", "C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "DH", "PH", "PR"]
# These series aren't in Lahman's SeriesPost. Results are documented by
# Baseball-Reference and the 1900 cup is also in Retrosheet's postseason data.
# https://www.baseball-reference.com/bullpen/Temple_Cup
# https://www.baseball-reference.com/bullpen/Chronicle-Telegraph_Cup
HISTORICAL_CUPS = [
    (1894, "TEMPLE", "NY1", "BLN", 4, 0),
    (1895, "TEMPLE", "CL4", "BLN", 4, 1),
    (1896, "TEMPLE", "BLN", "CL4", 4, 0),
    (1897, "TEMPLE", "BLN", "BSN", 4, 1),
    (1900, "CUP", "BRO", "PIT", 3, 1),
]


def rows(path):
    with path.open(encoding="utf-8-sig", newline="") as source:
        yield from csv.DictReader(source)


def count(value):
    return int(value) if value and value.isdecimal() else 0


def team_key(row):
    return int(row["yearID"]), row["lgID"], row["teamID"]


def collect_teams(source):
    found = {}
    for row in rows(source / "Teams.csv"):
        year, league, code = team_key(row)
        limits = LEAGUES.get(league)
        if not limits or not limits[0] <= year <= limits[1]:
            continue
        name = "Los Angeles Angels" if row["franchID"] == "ANA" and year >= 2016 else row["name"]
        found[(year, league, code)] = [league + "-" + code, name, league, row["franchID"], []]
    return found


def register_map(directory, lookup):
    ids = defaultdict(set)
    for path in sorted(directory.glob("people-*.csv")):
        for row in rows(path):
            if not row["key_mlbam"].isdecimal():
                continue
            for column, known_values in lookup.items():
                key = row[column]
                if key in known_values:
                    ids[column, key].add(int(row["key_mlbam"]))
    return ids


def build(source, register):
    teams = collect_teams(source)
    people = {row["playerID"]: row for row in rows(source / "People.csv")}
    appearances = defaultdict(dict)
    for row in rows(source / "Appearances.csv"):
        team = team_key(row)
        if team not in teams:
            continue
        values = [count(row.get("G_" + position.lower())) for position in POSITIONS[1:]]
        # The individual outfield positions take precedence over the combined OF count.
        if any(values[6:9]):
            values[9] = 0
        position = 1 + max(range(len(values)), key=values.__getitem__) if any(values) else 0
        appearances[team][row["playerID"]] = [position, 1]

    for table, fallback, mask in (
        ("Batting", 0, 1), ("Pitching", 1, 1),
        ("BattingPost", 0, 2), ("PitchingPost", 1, 2), ("FieldingPost", 0, 2),
    ):
        for row in rows(source / f"{table}.csv"):
            team = team_key(row)
            if team not in teams or not count(row.get("G")):
                continue
            position = POSITIONS.index(row["POS"]) if row.get("POS") in POSITIONS else fallback
            entry = appearances[team].setdefault(row["playerID"], [0, 0])
            if not entry[0]:
                entry[0] = position
            entry[1] |= mask

    roster = sorted({pid for group in appearances.values() for pid in group})
    assert set(roster) <= people.keys(), "Roster player missing from People.csv"
    lookup = {
        "key_bbref": {people[pid]["bbrefID"] for pid in roster} - {""},
        "key_retro": {people[pid]["retroID"] for pid in roster} - {""},
    }
    ids = register_map(register, lookup)
    keys = {pid: index for index, pid in enumerate(roster)}
    archive_people = []
    for pid in roster:
        p = people[pid]
        by_retro = ids["key_retro", p["retroID"]]
        by_bbref = ids["key_bbref", p["bbrefID"]]
        matches = by_retro & by_bbref if by_retro and by_bbref else by_retro or by_bbref
        mlbam = next(iter(matches)) if len(matches) == 1 else None
        name = " ".join(filter(None, (p["nameFirst"], p["nameLast"]))) or pid
        archive_people.append([pid, name, mlbam, p["bbrefID"]])

    years = defaultdict(list)
    for key, team in sorted(teams.items()):
        year = key[0]
        team[-1] = [[keys[pid], position, mask] for pid, (position, mask) in sorted(appearances[key].items())]
        years[year].append(team)
    assert list(years) == list(range(1871, 2026))
    assert all(any(team[-1] for team in season) for season in years.values())
    return {"through": 2025, "positions": POSITIONS, "players": archive_people, "seasons": years}


def build_standings(source):
    teams = collect_teams(source)
    standings = defaultdict(list)
    series = defaultdict(list)
    for row in rows(source / "Teams.csv"):
        key = team_key(row)
        if key not in teams:
            continue
        code, name, league, _, _ = teams[key]
        rank = count(row["Rank"]) or None
        standings[key[0]].append([code, name, league, row["divID"], rank,
                                  int(row["W"]), int(row["L"]), row["LgWin"] == "Y"])

    for row in rows(source / "SeriesPost.csv"):
        kind = row["round"]
        if kind not in ("WS", "NWS", "CS"):
            continue
        year = int(row["yearID"])
        winner = teams[year, row["lgIDwinner"], row["teamIDwinner"]][0]
        loser = teams[year, row["lgIDloser"], row["teamIDloser"]][0]
        series[year].append([kind, winner, loser, int(row["wins"]), int(row["losses"]), int(row["ties"])])

    for year, kind, winner, loser, wins, losses in HISTORICAL_CUPS:
        series[year].append([kind, teams[year, "NL", winner][0], teams[year, "NL", loser][0], wins, losses, 0])

    assert sum(map(len, standings.values())) == len(teams)
    assert set(standings) == set(range(1871, 2026))
    assert {year for year, rounds in series.items() if year >= 1903 and any(r[0] == "WS" for r in rounds)} == (
        set(range(1903, 2026)) - {1904, 1994}
    )
    finals = {year: sorted(rounds, key=lambda row: row[0] != "WS") for year, rounds in sorted(series.items())}
    return {"through": 2025, "standings": dict(sorted(standings.items())), "series": finals}


def write_archive(output, data):
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode()
    output.write_bytes(gzip.compress(payload, mtime=0))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("lahman", type=Path)
    parser.add_argument("register", type=Path)
    parser.add_argument("--output", type=Path, default=Path("docs/history-archive.json.gz"))
    parser.add_argument("--standings", type=Path, help="also build standings from Teams.csv and SeriesPost.csv")
    args = parser.parse_args()
    archive = build(args.lahman, args.register)
    write_archive(args.output, archive)
    people = archive["players"]
    clubs = [team for year in archive["seasons"].values() for team in year]
    print(f"{len(people):,} players · {sum(p[2] is not None for p in people):,} MLB IDs · "
          f"{len(clubs):,} team-seasons · {sum(len(t[-1]) for t in clubs):,} club-player-season rows · "
          f"{args.output.stat().st_size:,} bytes")
    if args.standings:
        standings = build_standings(args.lahman)
        write_archive(args.standings, standings)
        print(f"{len(standings['standings'])} standings seasons · "
              f"{sum(map(len, standings['series'].values()))} postseason finals · {args.standings.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
