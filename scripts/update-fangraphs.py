#!/usr/bin/env python3
"""Collect regular-season wRC+ and ERA- from the public FanGraphs leaderboards."""

import argparse
import gzip
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from time import sleep
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DATA = Path(__file__).resolve().parents[1] / "docs" / "data"
LEADERBOARD = "https://www.fangraphs.com/leaders/major-league"
API = "https://www.fangraphs.com/api/leaders/major-league/data"
PAGE_SIZE = 2000
METRICS = {"bat": ("hitting", "wRC+"), "pit": ("pitching", "ERA-")}


def fetch_page(kind, season, page):
    params = {
        "pos": "all", "stats": kind, "lg": "all", "qual": 0,
        "season": season, "season1": season, "ind": 0, "type": 1,
        "month": 0, "team": 0, "rost": 0, "pageitems": PAGE_SIZE, "pagenum": page,
    }
    request = Request(f"{API}?{urlencode(params)}", headers={
        "User-Agent": "MLB Player Directory (public leaderboard)",
        "Accept": "application/json", "Accept-Encoding": "gzip",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                body = response.read()
                return json.loads(gzip.decompress(body) if response.headers.get("Content-Encoding") == "gzip" else body)
        except (URLError, TimeoutError) as error:
            status = getattr(error, "code", None)
            if attempt == 2 or (status is not None and status < 500):
                raise
            sleep(attempt + 1)


def season_values(job):
    kind, season = job
    group, field = METRICS[kind]
    payload = fetch_page(kind, season, 1)
    total = payload["totalCount"]
    rows = payload["data"]
    for page in range(2, math.ceil(total / PAGE_SIZE) + 1):
        more = fetch_page(kind, season, page)
        if more["totalCount"] != total:
            raise ValueError(f"FanGraphs pagination changed for {group} {season}")
        rows.extend(more["data"])
    if not rows or len(rows) != total:
        raise ValueError(f"Incomplete FanGraphs leaderboard for {group} {season}: {len(rows)}/{total}")

    players = {}
    for row in rows:
        if row["Season"] != season:
            raise ValueError(f"Unexpected season on FanGraphs {group} {season}: {row['Season']}")
        player_id = row["xMLBAMID"]
        value = row[field]
        if value is None or not player_id or player_id <= 0:
            continue
        if not math.isfinite(value) or player_id in players:
            raise ValueError(f"Invalid or duplicate FanGraphs value for {group} {season}, MLB ID {player_id}")
        players[player_id] = round(value)
    if not players:
        raise ValueError(f"No FanGraphs {field} values for {season}")
    print(f"{season} {field}: {len(players)} players", flush=True)
    return group, season, players


def first_roster_season():
    snapshot = json.loads((DATA / "rosters.json").read_text(encoding="utf-8"))
    return min(int(player["debutDate"][:4]) for team in snapshot["teams"]
               for player in team["players"] if player.get("debutDate"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", type=int, help="First season. Defaults to the earliest MLB debut in the roster snapshot.")
    parser.add_argument("--through", type=int, required=True, help="Most recent season with published MLB results.")
    args = parser.parse_args()
    first_season = args.since if args.since is not None else first_roster_season()
    if not 1871 <= first_season <= args.through:
        parser.error("Choose an MLB season range in chronological order starting in 1871 or later.")

    jobs = [(kind, year) for year in range(first_season, args.through + 1) for kind in METRICS]
    players = {}
    counts = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        for group, season, values in pool.map(season_values, jobs):
            counts.setdefault(season, {})[group] = len(values)
            for player_id, value in values.items():
                players.setdefault(player_id, {}).setdefault(group, {})[season] = value

    payload = {
        "source": LEADERBOARD, "firstSeason": first_season, "lastSeason": args.through,
        "capturedAt": datetime.now(ZoneInfo("Asia/Taipei")).isoformat(timespec="seconds"),
        "seasonCounts": counts, "players": dict(sorted(players.items())),
    }
    output = DATA / "fangraphs-seasons.json"
    with TemporaryDirectory(dir=DATA) as directory:
        pending = Path(directory) / output.name
        pending.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
        pending.replace(output)
    print(f"{len(players)} players · {sum(sum(groups.values()) for groups in counts.values())} player-seasons")


if __name__ == "__main__":
    main()
