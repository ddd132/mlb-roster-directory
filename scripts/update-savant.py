#!/usr/bin/env python3
"""Download public Baseball Savant MLB season leaderboards for the player pages."""

import argparse
import csv
import io
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from time import sleep
from zoneinfo import ZoneInfo

SITE = Path(__file__).resolve().parents[1]
DATA = SITE / "docs" / "data"
SAVANT = "https://baseballsavant.mlb.com/leaderboard/custom"
FIRST_STATCAST_SEASON = 2015
# Values from the CSV are percentages on the 0–100 scale, except BABIP and OPS.
FIELDS = {
    "babip": "babip",
    "kRate": "k_percent",
    "bbRate": "bb_percent",
    "hardHitRate": "hard_hit_percent",
    "barrelRate": "barrel_batted_rate",
    "whiffRate": "whiff_percent",
    "ops": "on_base_plus_slg",
}
KINDS = {"batter": "hitting", "pitcher": "pitching"}


def get_csv(player_type, season):
    params = {
        "year": season,
        "type": player_type,
        "min": 0,
        "selections": ",".join(FIELDS.values()),
        "chart": "false",
        "csv": "true",
    }
    request = Request(f"{SAVANT}?{urlencode(params)}", headers={"User-Agent": "MLB Player Directory (public CSV)"})
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as reply:
                return reply.read().decode("utf-8-sig")
        except (URLError, TimeoutError) as error:
            if attempt == 2 or getattr(error, "code", None) in {401, 403, 429}:
                raise
            sleep(attempt + 1)


def read_number(text, field):
    if text in ("", "-", "—", "--", "N/A"):
        return None
    value = float(text)
    if not math.isfinite(value) or value < 0 or (field.endswith("Rate") and value > 100):
        raise ValueError(f"Unexpected value for {field}: {text}")
    return int(value) if value.is_integer() else value


def season_rows(job):
    player_type, season = job
    records = csv.DictReader(io.StringIO(get_csv(player_type, season)))
    required = {"player_id", "year", *FIELDS.values()}
    if not required.issubset(records.fieldnames or []):
        raise ValueError(f"Invalid Savant CSV for {player_type} {season}: {records.fieldnames}")
    players = {}
    for row in records:
        player_id = int(row["player_id"])
        if player_id <= 0 or int(row["year"]) != season:
            raise ValueError(f"Unexpected player-year in {player_type} {season}: {player_id}")
        values = [read_number(row[key].strip(), name) for name, key in FIELDS.items()]
        if player_id in players and players[player_id] != values:
            raise ValueError(f"Conflicting Savant rows for {player_type} {season}: {player_id}")
        players[player_id] = values
    if not players:
        raise ValueError(f"Savant returned no {player_type} records for {season}")
    print(f"{season} {player_type}: {len(players)} players", flush=True)
    return player_type, season, players


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--through", type=int, required=True, help="Most recent MLB season with a published leaderboard.")
    args = parser.parse_args()
    if args.through < FIRST_STATCAST_SEASON:
        parser.error(f"The first Statcast season is {FIRST_STATCAST_SEASON}.")

    jobs = [(kind, year) for year in range(FIRST_STATCAST_SEASON, args.through + 1) for kind in KINDS]
    by_player = {}
    totals = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        for kind, season, players in pool.map(season_rows, jobs):
            group = KINDS[kind]
            totals.setdefault(season, {})[group] = len(players)
            for player_id, values in players.items():
                by_player.setdefault(player_id, {}).setdefault(group, {})[season] = values

    payload = {
        "source": SAVANT,
        "firstSeason": FIRST_STATCAST_SEASON,
        "lastSeason": args.through,
        "capturedAt": datetime.now(ZoneInfo("Asia/Taipei")).isoformat(timespec="seconds"),
        "columns": list(FIELDS),
        "seasonCounts": totals,
        "players": dict(sorted(by_player.items())),
    }
    output = DATA / "savant-seasons.json"
    temp = output.with_suffix(".tmp")
    temp.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    temp.replace(output)
    print(f"{len(by_player)} players · {sum(sum(groups.values()) for groups in totals.values())} player-seasons · {output.stat().st_size} bytes")


if __name__ == "__main__":
    main()
