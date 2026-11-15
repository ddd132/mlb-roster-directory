#!/usr/bin/env python3
"""Build MLB regular-season percentile data for the player card."""

import argparse
import csv
import gzip
import io
import json
import math
from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from statistics import median
from tempfile import TemporaryDirectory
from time import sleep
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DATA = Path(__file__).resolve().parents[1] / "docs" / "data"
MLB = "https://statsapi.mlb.com/api/v1"
SAVANT = "https://baseballsavant.mlb.com/leaderboard"
ROLES = {"hitting": "batter", "pitching": "pitcher"}
OPPORTUNITIES = {"hitting": "plateAppearances", "pitching": "battersFaced"}
TOTALS = {
    "hitting": {"H": "hits", "HR": "homeRuns", "RBI": "rbi", "R": "runs", "SB": "stolenBases"},
    "pitching": {"IP": "outs", "SO": "strikeOuts", "W": "wins", "SV": "saves", "HLD": "holds"},
}
RATES = {
    "hitting": {"AVG": "avg", "OBP": "obp", "SLG": "slg", "OPS": "ops"},
    "pitching": {"ERA": "era", "WHIP": "whip", "K/9": "strikeoutsPer9Inn", "BB/9": "walksPer9Inn", "OPS": "ops"},
}
EXTRA_RATES = {"hitting": ("wRC+", "BABIP", "SweetSpot%"), "pitching": ("ERA-", "BABIP")}
LOWER_RATES = {"hitting": set(), "pitching": {"ERA", "WHIP", "BB/9", "OPS", "ERA-", "BABIP"}}
# Savant publishes the direction of each percentile, including K%, BB% and Whiff%.
STATCAST = {
    "xwOBA": ("xwoba", "xwoba"),
    "xBA": ("xba", "xba"),
    "xSLG": ("xslg", "xslg"),
    "EV": ("exit_velocity_avg", "exit_velocity"),
    "Barrel%": ("barrel_batted_rate", "brl_percent"),
    "Hard-Hit%": ("hard_hit_percent", "hard_hit_percent"),
    "Chase%": ("oz_swing_percent", "chase_percent"),
    "Whiff%": ("whiff_percent", "whiff_percent"),
    "K%": ("k_percent", "k_percent"),
    "BB%": ("bb_percent", "bb_percent"),
}
ROLE_STATCAST = {
    "hitting": {"Sprint": ("sprint_speed", "sprint_speed")},
    "pitching": {"xERA": ("xera", "xera")},
}
TRACKING = {"Bat Speed": ("avg_bat_speed", "bat_speed"), "Squared-Up%": ("squared_up_per_swing", "squared_up_rate")}
MLB_FIELDS = {"stats", "group", "displayName", "totalSplits", "splits", "season", "player", "id", "stat",
              "hits", "homeRuns", "strikeOuts", "baseOnBalls", "atBats", "sacFlies", "babip", *OPPORTUNITIES.values()}
for fields in [*TOTALS.values(), *RATES.values()]:
    MLB_FIELDS.update(fields.values())


def download(url, params):
    request = Request(f"{url}?{urlencode(params)}", headers={
        "User-Agent": "MLB Player Directory (public season leaderboards)",
        "Accept-Encoding": "gzip",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=25) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body.decode("utf-8-sig")
        except (URLError, TimeoutError) as error:
            status = getattr(error, "code", None)
            if attempt == 2 or (status is not None and status < 500 and status != 429):
                raise
            sleep(attempt + 1)


def number(value):
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(result):
        return None
    return int(result) if result.is_integer() else result


def csv_rows(leaderboard, params, fields, id_field="player_id"):
    records = csv.DictReader(io.StringIO(download(f"{SAVANT}/{leaderboard}", {**params, "csv": "true"})))
    if not {id_field, *fields}.issubset(records.fieldnames or []):
        raise ValueError(f"Unexpected {leaderboard} columns for {params}: {records.fieldnames}")
    players = {}
    for row in records:
        player_id = int(row[id_field])
        if "year" in row and int(row["year"]) != params["year"]:
            raise ValueError(f"Unexpected season for MLB ID {player_id} in {leaderboard}")
        values = {field: number(row[field]) for field in fields}
        if player_id in players and players[player_id] != values:
            raise ValueError(f"Conflicting {leaderboard} rows for MLB ID {player_id}")
        players[player_id] = values
    if not players:
        raise ValueError(f"Empty {leaderboard} for {params}")
    return players


def mlb_rows(year, group):
    payload = json.loads(download(f"{MLB}/stats", {
        "stats": "season", "group": group, "sportIds": 1, "season": year, "gameType": "R",
        "playerPool": "ALL", "limit": 2000, "fields": ",".join(sorted(MLB_FIELDS)),
    }))["stats"][0]
    splits = payload["splits"]
    rows = {split["player"]["id"]: split["stat"] for split in splits}
    if (payload["group"]["displayName"] != group or not rows or len(rows) != len(splits)
            or len(rows) != payload["totalSplits"] or any(int(split["season"]) != year for split in splits)):
        raise ValueError(f"Incomplete MLB leaderboard for {year} {group}")
    return {player: stat for player, stat in rows.items() if stat.get(OPPORTUNITIES[group], 0) > 0}


def games_per_team(year):
    standings = json.loads(download(f"{MLB}/standings", {
        "leagueId": "103,104", "season": year, "standingsTypes": "regularSeason", "fields": "records,teamRecords,gamesPlayed",
    }))["records"]
    games = [team["gamesPlayed"] for division in standings for team in division["teamRecords"]]
    if len(games) != 30 or min(games) < 1:
        raise ValueError(f"Incomplete MLB standings for {year}")
    return median(games)


def statcast_rows(year, group, stats):
    if year < 2015:
        return {}, {}, {}
    params = {"year": year, "type": ROLES[group]}
    columns = {**STATCAST, **ROLE_STATCAST[group]}
    fields = {raw for raw, _ in columns.values()}
    if group == "hitting":
        fields.add("sweet_spot_percent")
    raw = csv_rows("custom", {**params, "min": 0, "selections": ",".join(sorted(fields)), "chart": "false"}, fields)
    ranks = csv_rows("percentile-rankings", params, {pr for _, pr in columns.values()} | (
        {pr for _, pr in TRACKING.values()} if group == "hitting" and year >= 2023 else set()
    ))
    official_players = set(ranks) & set(stats)
    if sum(ranks[player]["xwoba"] is not None for player in official_players) < 40:
        raise ValueError(f"Incomplete Savant percentile leaderboard for {year} {group}")
    tracking = {}
    if group == "hitting" and year >= 2023:
        tracking = csv_rows("bat-tracking", {"type": "batter", "seasonStart": year, "seasonEnd": year, "minSwings": 1},
                            {raw for raw, _ in TRACKING.values()}, "id")
    return raw, ranks, tracking


def as_rate(stat, numerator, denominator):
    return round(100 * stat[numerator] / stat[denominator], 1) if stat.get(denominator) and numerator in stat else None


def babip(stat):
    if (raw := number(stat.get("babip"))) is not None:
        return raw
    if not all(k in stat for k in ("atBats", "strikeOuts", "homeRuns", "sacFlies", "hits")):
        return None
    in_play = stat["atBats"] - stat["strikeOuts"] - stat["homeRuns"] + stat["sacFlies"]
    return round((stat["hits"] - stat["homeRuns"]) / in_play, 3) if in_play > 0 else None


def percentile(pool, value, lower_is_better):
    lower = bisect_left(pool, value)
    higher = bisect_right(pool, value)
    worse = len(pool) - higher if lower_is_better else lower
    return math.floor(100 * (worse + (higher - lower) / 2) / len(pool) + 0.5)


def compile_group(year, group, minimum, stats, fangraphs):
    raw_by_id, ranked_by_id, tracking_by_id = statcast_rows(year, group, stats)
    rate_fields = [*RATES[group], *EXTRA_RATES[group]]
    actual, ranking = {}, {}
    index = "wRC+" if group == "hitting" else "ERA-"
    columns = [*TOTALS[group], *rate_fields, *STATCAST, *ROLE_STATCAST[group]]
    if group == "hitting":
        columns += TRACKING.keys()
    for player_id, stat in stats.items():
        values = {key: number(stat.get(field)) for key, field in {**TOTALS[group], **RATES[group]}.items()}
        values[index] = fangraphs.get(str(player_id), {}).get(group, {}).get(str(year))
        values["BABIP"] = babip(stat)
        raw = raw_by_id.get(player_id, {})
        official = ranked_by_id.get(player_id, {})
        ranks = {}
        for key, (field, rank_field) in {**STATCAST, **ROLE_STATCAST[group]}.items():
            values[key] = raw.get(field)
            ranks[key] = official.get(rank_field)
        if values["K%"] is None:
            values["K%"] = as_rate(stat, "strikeOuts", OPPORTUNITIES[group])
        if values["BB%"] is None:
            values["BB%"] = as_rate(stat, "baseOnBalls", OPPORTUNITIES[group])
        if group == "hitting":
            values["SweetSpot%"] = raw.get("sweet_spot_percent")
            tracking = tracking_by_id.get(player_id, {})
            for key, (field, rank_field) in TRACKING.items():
                value = tracking.get(field)
                values[key] = round(value * (100 if key.endswith("%") else 1), 1) if value is not None else None
                ranks[key] = official.get(rank_field)
        for key, rank in ranks.items():
            if rank is not None and (not isinstance(rank, int) or not 0 <= rank <= 100):
                raise ValueError(f"Invalid Savant percentile for {key}, MLB ID {player_id}, season {year}")
        actual[player_id] = values
        ranking[player_id] = ranks

    qualified = {player for player, stat in stats.items() if stat[OPPORTUNITIES[group]] >= minimum}
    # Before Statcast, MLB K% and BB% can still be compared from recorded PA/BF counts.
    if year < 2015:
        rate_fields += ["K%", "BB%"]
    lower_rates = LOWER_RATES[group] | ({"K%"} if group == "hitting" else {"BB%"})
    for key in [*TOTALS[group], *rate_fields]:
        candidates = actual.keys() if key in TOTALS[group] else qualified
        pool = sorted(actual[player][key] for player in candidates if actual[player][key] is not None)
        for player in candidates:
            if (value := actual[player][key]) is not None:
                ranking[player][key] = percentile(pool, value, key in lower_rates)

    return {
        "columns": columns, "minimum": minimum, "qualified": len(qualified),
        "players": {player: [stats[player][OPPORTUNITIES[group]], *[
            entry for key in columns for entry in (values.get(key), ranking[player].get(key))
        ]] for player, values in sorted(actual.items())},
    }


def compile_season(year, fangraphs):
    games = games_per_team(year)
    minimums = {"hitting": math.ceil(2.1 * games), "pitching": math.ceil(1.25 * games)}
    groups = {group: compile_group(year, group, minimums[group], mlb_rows(year, group), fangraphs) for group in ROLES}
    print(f"{year}: " + " · ".join(f"{group} {len(data['players'])} ({data['qualified']} rate qualifiers)"
                                   for group, data in groups.items()), flush=True)
    return year, groups


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--through", type=int, required=True)
    parser.add_argument("--since", type=int)
    args = parser.parse_args()
    fg = json.loads((DATA / "fangraphs-seasons.json").read_text(encoding="utf-8"))
    first = args.since or fg["firstSeason"]
    if not 1998 <= first <= args.through:
        parser.error("Choose a chronological season range starting in 1998 or later.")
    with ThreadPoolExecutor(max_workers=7) as pool:
        seasons = dict(pool.map(lambda year: compile_season(year, fg["players"]), range(first, args.through + 1)))
    current = {args.through: seasons.pop(args.through)}
    captured_at = datetime.now(ZoneInfo("Asia/Taipei")).isoformat(timespec="seconds")
    with TemporaryDirectory(dir=DATA) as folder:
        for name, years in [("percentile-current.json", current), ("percentile-history.json.gz", seasons)]:
            target = DATA / name
            pending = Path(folder) / name
            data = (json.dumps({"capturedAt": captured_at, "seasons": years}, separators=(",", ":")) + "\n").encode("utf-8")
            pending.write_bytes(gzip.compress(data, mtime=0) if name.endswith(".gz") else data)
            pending.replace(target)
            print(f"{target.name}: {target.stat().st_size:,} bytes", flush=True)


if __name__ == "__main__":
    main()
