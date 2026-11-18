#!/usr/bin/env python3
"""Build the search index from the site's rosters, history, and recent MLB seasons."""

import argparse
import gzip
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlencode
from urllib.request import Request, urlopen

DOCS = Path(__file__).resolve().parents[1] / "docs"
DATA = DOCS / "data"
API = "https://statsapi.mlb.com/api/v1/stats"
STATS_FIELDS = "stats,group,displayName,totalSplits,splits,player,id,fullName,position,abbreviation,stat,gamesPlayed"
CHINESE_NAMES = {425426: ["王建民"]}


def read_json(path):
    raw = path.read_bytes()
    return json.loads(gzip.decompress(raw) if path.suffix == ".gz" else raw)


def player_entry(players, player_id, name, legacy=None):
    entry = players.setdefault(player_id or legacy, {"id": player_id, "name": name})
    if entry["name"] != name:
        entry.setdefault("aliases", set()).add(name)
    return entry


def record_season(player, year, club, position, mask, score=0, history_link=None):
    career = player.setdefault("career", {"first": year, "last": year, "regular": False})
    career["first"] = min(career["first"], year)
    career["last"] = max(career["last"], year)
    has_regular = bool(mask & 1)
    career["regular"] |= has_regular
    # Use the latest club, preferring regular-season appearances for the same year.
    priority = (year, has_regular, bool(position and position != "—"), score)
    if priority > player.get("clubPriority", ()):
        player["clubPriority"] = priority
        career.update(club=club, position=position)
        if history_link:
            player["history"] = history_link


def add_history(players, archive):
    for season, teams in archive["seasons"].items():
        year = int(season)
        for team_key, name, league, _, roster in teams:
            for index, pos, mask in roster:
                legacy, player_name, player_id, _ = archive["players"][index]
                entry = player_entry(players, player_id, player_name, legacy)
                history_link = None
                if not player_id or year < 1876:
                    history_link = {"player": legacy, "season": year, "team": team_key, "league": league}
                record_season(entry, year, name, archive["positions"][pos], mask, history_link=history_link)


def team_stats(year, team_id, game_type):
    params = {
        "season": year, "teamId": team_id, "sportIds": 1, "group": "hitting,pitching,fielding",
        "stats": "season", "gameType": game_type, "playerPool": "ALL", "limit": 1000,
        "fields": STATS_FIELDS,
    }
    request = Request(f"{API}?{urlencode(params)}", headers={"User-Agent": "MLB Player Directory (public season stats)"})
    with urlopen(request, timeout=25) as response:
        blocks = json.load(response)["stats"]
    for block in blocks:
        group = block["group"]["displayName"]
        splits = block.get("splits", [])
        if block["totalSplits"] != len(splits):
            raise ValueError(f"Incomplete {year} {game_type} stats for team {team_id}")
        for row in splits:
            games = row.get("stat", {}).get("gamesPlayed", 0)
            if games <= 0:
                continue
            player = row["player"]
            position = "P" if group == "pitching" else row.get("position", {}).get("abbreviation")
            if position == "X":
                position = None
            priority = {"fielding": 300, "pitching": 150}.get(group, 0) + games
            yield player["id"], player["fullName"], position, priority


def recent_stats(job):
    year, club, game_type = job
    return list(team_stats(year, club["id"], game_type))


def add_recent_seasons(players, clubs, first_year, last_year):
    jobs = [(year, club, game_type) for year in range(first_year, last_year + 1)
            for club in clubs for game_type in ("R", "P")]
    if not jobs:
        return
    with ThreadPoolExecutor(max_workers=6) as pool:
        for (year, club, game_type), rows in zip(jobs, pool.map(recent_stats, jobs)):
            for player_id, name, position, priority in rows:
                player = player_entry(players, player_id, name)
                record_season(player, year, club["nameZh"], position, 1 if game_type == "R" else 2, priority)


def add_minors(players, clubs):
    minors = read_json(DATA / "minor-league-rosters.json")
    rankings = read_json(DATA / "pipeline-rankings.json")
    for affiliate in sorted(minors["affiliates"], key=lambda team: team["level"]):
        organization = clubs[affiliate["orgId"]]
        for row in affiliate["players"]:
            player = player_entry(players, row["id"], row["name"])
            player.setdefault("minor", {
                "season": minors["season"], "club": affiliate["name"], "team": organization["abbr"],
                "position": row["position"], "level": affiliate["level"],
            })
    for board in [rankings["top100"], *rankings["byTeam"].values()]:
        for row in board["players"]:
            organization = clubs.get(row["orgId"], {})
            player = player_entry(players, row["id"], row["name"])
            player.setdefault("minor", {
                "season": rankings["season"], "club": organization.get("nameZh"),
                "team": organization.get("abbr"), "position": row["position"], "level": row["level"],
                "prospect": True,
            })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--through", type=int, help="Most recent MLB season to include (default: roster snapshot year)")
    args = parser.parse_args()
    archive = read_json(DOCS / "history-archive.json.gz")
    rosters = read_json(DATA / "rosters.json")
    through = args.through if args.through is not None else rosters["season"]
    if through < archive["through"]:
        parser.error(f"--through must be at least {archive['through']}, the last archived season")
    clubs = {club["id"]: club for club in rosters["teams"]}
    players = {}
    add_history(players, archive)
    add_recent_seasons(players, clubs.values(), archive["through"] + 1, through)
    add_minors(players, clubs)
    for club in clubs.values():
        for row in club["players"]:
            player = players.get(row["id"])
            if player is not None and row["searchAliases"]:
                player.setdefault("aliases", set()).update(row["searchAliases"])
    for player_id, aliases in CHINESE_NAMES.items():
        players[player_id].setdefault("aliases", set()).update(aliases)

    for player in players.values():
        player.pop("clubPriority", None)
        if "aliases" in player:
            player["aliases"] = sorted(player["aliases"])
    payload = json.dumps({"version": 1, "players": list(players.values())}, ensure_ascii=False, separators=(",", ":"))
    compressed = gzip.compress(payload.encode("utf-8"), mtime=0)
    target = DATA / "player-search.json.gz"
    with NamedTemporaryFile(dir=DATA, suffix=".tmp", delete=False) as temp:
        pending = Path(temp.name)
    try:
        pending.write_bytes(compressed)
        pending.replace(target)
    finally:
        pending.unlink(missing_ok=True)
    print(f"{len(players):,} historical and MiLB players · {len(compressed):,} compressed bytes")


if __name__ == "__main__":
    main()
