#!/usr/bin/env python3
"""Collect dated MiLB affiliate rosters and MLB Pipeline's published rankings."""

import argparse
import gzip
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from html.parser import HTMLParser
from pathlib import Path
from tempfile import TemporaryDirectory
from time import sleep
from urllib.error import URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DATA = Path(__file__).resolve().parents[1] / "docs" / "data"
API = "https://statsapi.mlb.com/api/v1"
PIPELINE = "https://www.mlb.com/prospects"
MINOR_LEVELS = (11, 12, 13, 14, 16)
ROSTER_FIELDS = "teamId,rosterType,roster,person,id,fullName,position,abbreviation,status,description"


def download(url):
    request = Request(url, headers={
        "User-Agent": "MLB Player Directory (public MiLB rosters and rankings)",
        "Accept-Encoding": "gzip",
    })
    for attempt in range(3):
        try:
            with urlopen(request, timeout=30) as response:
                body = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body
        except (URLError, TimeoutError) as error:
            status = getattr(error, "code", None)
            if attempt == 2 or (status is not None and status < 500):
                raise
            sleep(attempt + 1)


def stats(path, **params):
    return json.loads(download(f"{API}{path}?{urlencode(params)}"))


def affiliates(organization_ids, season):
    teams = stats("/teams", season=season, sportIds=",".join(map(str, MINOR_LEVELS)))["teams"]
    filtered = sorted((team for team in teams if team.get("active")
                       and team.get("allStarStatus") == "N" and team.get("parentOrgId") in organization_ids),
                      key=lambda team: (team["parentOrgId"], team["sport"]["id"], team["name"]))
    if len({team["id"] for team in filtered}) != len(filtered):
        raise ValueError("Duplicate MiLB affiliate IDs")
    for org_id in organization_ids:
        levels = {team["sport"]["id"] for team in filtered if team["parentOrgId"] == org_id}
        if not set(MINOR_LEVELS).issubset(levels):
            raise ValueError(f"Incomplete MiLB affiliate list for MLB team {org_id}")
    return filtered


def affiliate_roster(affiliate, roster_date):
    team_id = affiliate["id"]
    payload = stats(f"/teams/{team_id}/roster", rosterType="fullRoster", date=roster_date, fields=ROSTER_FIELDS)
    if payload["teamId"] != team_id or payload["rosterType"] != "fullRoster":
        raise ValueError(f"Unexpected roster response for MiLB team {team_id}")
    players = {}
    for row in payload["roster"]:
        person = row["person"]
        if not isinstance(person["id"], int) or person["id"] <= 0 or not person["fullName"]:
            raise ValueError(f"Invalid player on MiLB team {team_id}")
        players.setdefault(person["id"], {
            "id": person["id"], "name": person["fullName"],
            "position": row.get("position", {}).get("abbreviation"),
            "status": row.get("status", {}).get("description"),
        })
    return {
        "id": team_id, "orgId": affiliate["parentOrgId"], "name": affiliate["name"],
        "level": affiliate["sport"]["id"], "league": affiliate["league"]["name"],
        "players": list(players.values()),
    }


class PipelinePage(HTMLParser):
    def __init__(self):
        super().__init__()
        self.payload = None

    def handle_starttag(self, _tag, attrs):
        value = dict(attrs).get("data-init-state")
        if value and "getPlayerRankingsFromSelection" in value:
            self.payload = json.loads(value)["payload"]


def resolve(payload, value):
    return payload[value["__ref"]] if value and "__ref" in value else value or {}


def pipeline_rankings(organization, organization_ids, season):
    slug = urlparse(organization["rosterUrl"]).path.split("/")[1] if organization else "top100"
    limit = 30 if organization else 100
    url = f"{PIPELINE}/{season}/{slug}"
    page = PipelinePage()
    page.feed(download(url).decode("utf-8"))
    payload = page.payload
    selection = json.dumps({"limit": limit, "slug": f"sel-pr-{season}-{slug}"}, separators=(",", ":"))
    rankings = payload and payload["ROOT_QUERY"].get(f"getPlayerRankingsFromSelection({selection})")
    if not rankings or sorted(row["rank"] for row in rankings) != list(range(1, limit + 1)):
        raise ValueError(f"Expected {limit} official MLB Pipeline ranks at {url}")
    board = []
    for row in sorted(rankings, key=lambda row: row["rank"]):
        entity = resolve(payload, row["playerEntity"])
        person = resolve(payload, entity["player"])
        affiliate = resolve(payload, person.get("activeRoster"))
        parent = resolve(payload, person.get("activeRosterMLB"))
        org_id = organization["id"] if organization else (affiliate.get("parentOrgId") or parent.get("id") or affiliate.get("id"))
        name = " ".join(filter(None, (person.get("useName"), person.get("useLastName"))))
        if not name or not isinstance(person.get("id"), int) or person["id"] <= 0:
            raise ValueError(f"Invalid Pipeline player at {url} rank {row['rank']}")
        board.append({
            "rank": row["rank"], "id": person["id"], "name": name,
            "orgId": org_id if org_id in organization_ids else None,
            "position": entity.get("position") or person.get("primaryPosition", {}).get("abbreviation"),
            "level": resolve(payload, affiliate.get("sport")).get("id"),
            "eta": entity.get("eta"),
        })
    if len({row["id"] for row in board}) != limit:
        raise ValueError(f"Duplicate players on the Pipeline board at {url}")
    return {"source": url, "players": board}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, default=datetime.now(ZoneInfo("America/New_York")).date(),
                        help="Official roster date in YYYY-MM-DD format")
    parser.add_argument("--season", type=int, help="Affiliate and Pipeline year, defaulting to the roster date’s year")
    args = parser.parse_args()
    season = args.season or args.date.year
    organizations = json.loads((DATA / "rosters.json").read_text(encoding="utf-8"))["teams"]
    organization_ids = {team["id"] for team in organizations}
    teams = affiliates(organization_ids, season)
    rosters, boards = {}, {}
    with ThreadPoolExecutor(max_workers=10) as pool:
        board_requests = {pool.submit(pipeline_rankings, org, organization_ids, season): org["id"] if org else "top100"
                          for org in [None, *organizations]}
        roster_requests = {pool.submit(affiliate_roster, team, args.date.isoformat()): team["id"] for team in teams}
        for future in as_completed([*board_requests, *roster_requests]):
            result = future.result()
            if future in board_requests:
                key = board_requests[future]
                boards[key] = result
                print(f"Pipeline {key}: {len(result['players'])} ranks", flush=True)
            else:
                rosters[roster_requests[future]] = result
                if len(rosters) % 40 == 0:
                    print(f"MiLB rosters: {len(rosters)}/{len(teams)}", flush=True)

    timestamp = datetime.now(ZoneInfo("Asia/Taipei")).isoformat(timespec="seconds")
    top100 = boards.pop("top100")
    roster_payload = {
        "season": season, "rosterDate": args.date.isoformat(), "capturedAt": timestamp,
        "affiliates": [rosters[team["id"]] for team in teams],
    }
    rankings_payload = {
        "season": season, "capturedAt": timestamp, "top100": top100,
        "byTeam": dict(sorted(boards.items())),
    }
    with TemporaryDirectory(dir=DATA) as directory:
        for filename, payload in [("minor-league-rosters.json", roster_payload), ("pipeline-rankings.json", rankings_payload)]:
            pending = Path(directory) / filename
            pending.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
            pending.replace(DATA / filename)
    unique_players = {player["id"] for team in rosters.values() for player in team["players"]}
    print(f"{len(organizations)} MLB organizations · {len(rosters)} affiliates · {len(unique_players)} MiLB players")
    print(f"MLB Pipeline: {len(top100['players'])} overall ranks and {len(boards)} team boards")


if __name__ == "__main__":
    main()
