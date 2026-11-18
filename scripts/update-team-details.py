#!/usr/bin/env python3
"""Build the dated contract, Rule 5, and depth chart snapshot.

Run update-rosters.py and update-minor-leagues.py first to refresh the player
population. Publish the resulting docs/team-details.json.gz with the site.
"""

import argparse
import gzip
import json
import re
import unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from html import unescape
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

DOCS = Path(__file__).resolve().parents[1] / "docs"
API = "https://statsapi.mlb.com/api/v1"
FG = "https://www.fangraphs.com/roster-resource/payroll/"
FG_SLUGS = {109: "diamondbacks", 111: "red-sox", 141: "blue-jays", 145: "white-sox"}
RULE5_DATES = {2017: 14, 2018: 13, 2019: 12, 2020: 10, 2021: 8, 2022: 7, 2023: 6, 2024: 11, 2025: 10, 2026: 9}
OFFICIAL_RULE5 = "https://www.mlb.com/news/rule-5-draft-prospects-protected-on-40-man-roster-2026"
PEOPLE_FIELDS = "people,id,birthDate,mlbDebutDate,draftYear,transactions,date,typeCode,toTeam,fromTeam,id,description"
FIELDING_FIELDS = "stats,totalSplits,splits,team,id,player,id,position,abbreviation,stat,gamesPlayed"
ROSTER_FIELDS = "teamId,rosterType,roster,person,id,fullName,position,abbreviation,status,code,description,parentTeamId"


def api(path, **params):
    return API + path + "?" + urlencode(params)


def fetch(url, name, cache=None):
    path = cache / name if cache else None
    if path and path.is_file():
        return path.read_bytes()
    request = Request(url, headers={
        "User-Agent": "MLB Player Directory (public baseball information)",
        "Accept-Encoding": "gzip",
    })
    with urlopen(request, timeout=24) as response:
        raw = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    if path:
        path.write_bytes(raw)
    return raw


def json_file(name):
    return json.loads((DOCS / "data" / name).read_bytes())


def stamp(value):
    try:
        return date.fromisoformat(value or "")
    except ValueError:
        return None


def rule_age(birth, signed):
    june = date(signed.year - ((signed.month, signed.day) < (6, 5)), 6, 5)
    return june.year - birth.year - ((birth.month, birth.day) > (6, 5))


def first_eligible(person, affiliates):
    birth = stamp(person.get("birthDate"))
    if not birth:
        return [None, None, None, "birth"]
    transactions = sorted(
        (row for row in person.get("transactions", []) if stamp(row.get("date"))), key=lambda row: row["date"]
    )
    signings = [row for row in transactions if row.get("typeCode") in {"SGN", "SFA"}
                and " signed " in row.get("description", "").lower() and row.get("toTeam", {}).get("id")]
    if not signings:
        return [None, None, None, "sign"]
    first = signings[0]
    signed = date.fromisoformat(first["date"])
    age = rule_age(birth, signed)
    if age < 14:
        return [None, signed.isoformat(), age, "review"]
    # Compare the earliest reported signing against prior appearances or pro transactions.
    debut = stamp(person.get("mlbDebutDate"))
    previous = [row for row in transactions if row["date"] < first["date"]
                and row.get("toTeam", {}).get("id") in affiliates
                and row.get("typeCode") in {"ASG", "SC", "TR", "REL", "OUT"}]
    if (debut and debut < signed) or previous:
        return [None, signed.isoformat(), age, "prior"]
    earliest = signed.year + (4 if age <= 18 else 3)
    latest = earliest
    if signed.month >= 8:
        # If the assigned club's season ended before signing, the December meeting may not count.
        # A recorded assignment before that autumn is stronger evidence for August signings.
        joined = [stamp(row["date"]) for row in transactions
                  if row["date"] >= first["date"] and row.get("typeCode") == "ASG"
                  and row.get("toTeam", {}).get("id") in affiliates]
        draft_day = RULE5_DATES.get(signed.year)
        if signed.month == 12 and draft_day and signed.day != draft_day:
            earliest += 1
            latest += 1
        elif signed.month >= 9 or not any(d.year == signed.year and d.month == 8 and d.day <= 20 for d in joined):
            latest += 1
    for release in transactions:
        if release.get("typeCode") != "REL" and " released " not in release.get("description", "").lower():
            continue
        released = stamp(release["date"])
        team = release.get("fromTeam", {}).get("id") or release.get("toTeam", {}).get("id")
        if not team or released < signed:
            continue
        for row in signings[1:]:
            next_sign = stamp(row["date"])
            if row.get("toTeam", {}).get("id") != team or not 0 < (next_sign - released).days <= 366:
                continue
            r5 = RULE5_DATES.get(next_sign.year)
            if next_sign.month == 12 and not r5:
                latest = min(latest, next_sign.year + 1)
                earliest = min(earliest, next_sign.year)
            else:
                meeting = next_sign.year + (next_sign.month == 12 and next_sign.day >= r5)
                earliest, latest = min(earliest, meeting), min(latest, meeting)
    return [earliest, signed.isoformat(), age, "range" if earliest != latest else "", latest if earliest != latest else None]


def name_key(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if c.isalnum())


def official_checks(raw, season, team_names):
    if not raw or season != 2026:
        return {}
    markup = raw.decode()
    names = set()
    for part in re.findall(r"<p>(.*?)</p>", markup, re.S):
        if not re.search(r'/prospects/2026/[a-z-]+/?["?]', part):
            continue
        lines = [unescape(re.sub(r"<[^>]*>", "", s)).strip() for s in re.split(r"<br\s*/?>", part)]
        for text in lines[1:]:
            if not re.search(r"\(No\.\s*\d+", text):
                continue
            name = name_key(text.lstrip("+").split(",", 1)[0])
            key = (name_key(lines[0]), name)
            if key in team_names:
                names.add(team_names[key])
    return {str(pid): season for pid in sorted(names)}


def payroll_source(raw):
    blob = re.search(r'<script[^>]+id="__NEXT_DATA__"[^>]*>(.*?)</script>', raw.decode(), re.S)
    if not blob:
        raise ValueError("RosterResource page has no payroll data")
    data = json.loads(blob[1])["props"]["pageProps"]["dehydratedState"]["queries"]
    for query in data:
        if query["queryKey"][0] == "roster-resource/payroll2020/data":
            return query["state"]["data"]["dataContract"]
    raise ValueError("RosterResource payroll query not found")


def contract_kind(value):
    value = (value or "").upper()
    if "OPTION" in value or value in {"OPT OUT", "OPT-OUT"}:
        return value
    if value.startswith("PRE-ARB"):
        return "prearb"
    if value.startswith("ARB"):
        return "arb"
    if value == "GUARANTEED":
        return "signed"
    if value == "FREE AGENT":
        return "projected-fa"
    return ""


def contract_snapshot(rows, season):
    grouped = defaultdict(list)
    for entry in rows:
        summary = entry["contractSummary"]
        player_id = summary.get("MLBAMID")
        if player_id and int(player_id) > 0 and summary.get("payrollType") not in {"not40man", "released", "traded"}:
            grouped[int(player_id)].append(entry)

    result = {}
    for pid, entries in grouped.items():
        seasons = {}
        for year in (season, season + 1):
            candidates = []
            for entry in entries:
                summary = entry["contractSummary"]
                for row in entry["contractYears"]:
                    if row["Season"] != year:
                        continue
                    kind = contract_kind(row.get("Type"))
                    declared = str(row.get("Status") or "").upper()
                    if not kind or declared in {"DECLINED", "VOIDED", "OPTED OUT"}:
                        continue
                    actual = row.get("ContractId") is not None and not row.get("isEstimate") and not summary.get("isEstimate")
                    if kind == "signed" and actual and summary.get("ContractType") == "Arbitration":
                        kind = "arb-signed"
                    score = (bool(actual), kind != "projected-fa", int(summary.get("startSeason") or 0))
                    candidates.append((score, entry, row, kind))
            if not candidates:
                continue
            (_, entry, row, kind) = max(candidates, key=lambda item: item[0])
            c = entry["contractSummary"]
            actual = row.get("ContractId") is not None and not row.get("isEstimate") and not c.get("isEstimate")
            options = sorted({
                (r["Season"], k, str(r.get("Status") or "").upper())
                for r in entry["contractYears"] if r["Season"] >= year
                if (k := contract_kind(r.get("TypeAtSigning") or r.get("Type"))) not in
                   {"", "prearb", "arb", "signed", "projected-fa"}
                and r.get("Status") not in {"DECLINED", "VOIDED", "OPTED OUT"}
            })
            years = [c.get("startSeason"), c.get("endSeason"), c.get("endSeasonAll")] if actual else [None, None, None]
            amount = c.get("ContractTotal") if actual and kind in {"signed", "arb-signed"} and (c.get("YearsTotal") or 0) > 1 else None
            confirmed = actual and kind in {"signed", "arb-signed"}
            seasons[str(year)] = [kind, confirmed, *years, amount, options]
        if seasons:
            service = next((entry["contractSummary"].get("servicetime") for entry in entries
                            if re.fullmatch(r"\d{1,2}\.\d{3}", str(entry["contractSummary"].get("servicetime")))), None)
            result[str(pid)] = [seasons, service]
    return result


def fa_snapshot(raw, moves, season, teams, protected):
    if not raw:
        return [], {}
    data = json.loads(raw).get("freeAgents", [])
    free, signed = {}, {}
    for row in data:
        pid = row.get("player", {}).get("id")
        prev_team = (row.get("originalTeam") or {}).get("id")
        next_team = (row.get("newTeam") or {}).get("id")
        note = (row.get("notes") or "").lower()
        if not pid or row.get("dateDeclared", "")[:4] != str(season):
            continue
        declared = row.get("dateDeclared")
        date_signed = row.get("dateSigned")
        if date_signed and next_team in teams and pid in protected and not any(x in note for x in ("minor league", "waiver", "traded")):
            years = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5}
            term = re.search(r"\b(\d+|one|two|three|four|five)[ -]years?\b", note)
            duration = int(term[1]) if term and term[1].isdigit() else years.get(term[1]) if term else None
            if "accepted qualifying offer" in note:
                duration = 1
            if term or duration or "option exercised" in note:
                start = season + (date_signed[5:7] >= "10")
                end = start + duration - 1 if duration else start
                signed[pid] = (next_team, start, end)
        if (prev_team not in teams or pid in protected or date_signed or next_team
                or any(x in note for x in ("minor league", "waiver", "retired", "traded"))):
            continue
        transactions = moves.get(pid, [])
        if any(t["date"] >= declared and t.get("typeCode") in {"SFA", "SGN"}
               and " minor league " not in t.get("description", "").lower() for t in transactions):
            continue
        free[pid] = [pid, row["player"]["fullName"], prev_team, row.get("position", {}).get("abbreviation"), declared]
    return sorted(free.values(), key=lambda item: (item[2], item[1])), signed


def read_fielding(cache, season, sport):
    rows = []
    for offset in range(0, 15000, 1000):
        raw = fetch(api("/stats", season=season, sportIds=sport, group="fielding", stats="season", playerPool="ALL",
                        fields=FIELDING_FIELDS, limit=1000, offset=offset), f"field-{sport}-{offset}.json", cache)
        block, = json.loads(raw)["stats"]
        rows.extend(block.get("splits", []))
        if len(rows) >= block["totalSplits"]:
            break
    if len(rows) != block["totalSplits"]:
        raise ValueError(f"Incomplete fielding rows for sport {sport}")
    return rows


def read_optional(cache, name, sources):
    for url in sources:
        try:
            return fetch(url, name, cache)
        except HTTPError as err:
            if err.code == 429:
                break
        except (URLError, TimeoutError, OSError):
            continue
    print(f"Unavailable: {name}", flush=True)
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", type=date.fromisoformat, default=datetime.now(ZoneInfo("America/New_York")).date())
    parser.add_argument("--cache", type=Path, help="Optional local cache for retrying the same dated build")
    args = parser.parse_args()
    cache = args.cache
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
    dated = args.date.isoformat()
    season = args.date.year
    rosters, minor, pipeline = map(json_file, ("rosters.json", "minor-league-rosters.json", "pipeline-rankings.json"))
    orgs = {t["id"]: t for t in rosters["teams"]}
    all_affiliates = {t["id"]: t for t in minor["affiliates"]}
    depth_affiliates = {i: t for i, t in all_affiliates.items() if t["level"] in (11, 12)}
    prospects = [p for board in pipeline["byTeam"].values() for p in board["players"]] + pipeline["top100"]["players"]
    minor_ids = sorted({p["id"] for team in all_affiliates.values() for p in team["players"]} | {p["id"] for p in prospects})

    def minor_roster(team):
        raw = read_optional(cache, f"minor-{team['id']}.json", [api(f"/teams/{team['id']}/roster", rosterType="fullRoster", date=dated,
                fields="teamId,rosterType,roster,person,id,fullName,position,abbreviation,status,description")])
        if raw:
            p = json.loads(raw)
            if p.get("teamId") == team["id"] and isinstance(p.get("roster"), list):
                players = {}
                for row in p["roster"]:
                    person = row["person"]
                    players.setdefault(person["id"], [person["id"], person["fullName"],
                        row.get("position", {}).get("abbreviation"), row.get("status", {}).get("description")])
                return team["id"], [dated, list(players.values())]
        return team["id"], [minor["rosterDate"], [[p["id"], p["name"], p["position"], p["status"]] for p in team["players"]]]

    def major_roster(tid):
        raw = read_optional(cache, f"major-{tid}.json", [api(f"/teams/{tid}/roster", rosterType="40Man", fields=ROSTER_FIELDS)])
        if raw:
            p = json.loads(raw)
            if p.get("teamId") == tid and 25 <= len(p.get("roster", [])) <= 75:
                return tid, {r["person"]["id"]: r.get("status", {}).get("code") for r in p["roster"]}
        return tid, None

    def payroll(team):
        slug = FG_SLUGS.get(team["id"]) or urlparse(team["rosterUrl"]).path.split("/")[1]
        raw = read_optional(cache, f"fg-{season}-{team['id']}.html", [FG + slug + f"?season={season}"])
        rows = payroll_source(raw) if raw else []
        next_file = cache / f"fg-{season+1}-{team['id']}.html" if cache else None
        if next_file and next_file.is_file():
            rows += payroll_source(next_file.read_bytes())
        return team["id"], slug, contract_snapshot(rows, season)

    def profiles(ids, name):
        raw = read_optional(cache, name, [api("/people", personIds=",".join(map(str, ids)), hydrate="transactions", fields=PEOPLE_FIELDS)])
        return json.loads(raw).get("people", []) if raw else []

    with ThreadPoolExecutor(8) as pool:
        minor_future = [pool.submit(minor_roster, t) for t in depth_affiliates.values()]
        teams_future = [pool.submit(major_roster, t) for t in orgs]
        fielding_future = [pool.submit(read_fielding, cache, season, sport) for sport in (1, 11, 12)]
        p_futures = [pool.submit(profiles, minor_ids[i:i+100], f"people-{i}.json") for i in range(0, len(minor_ids), 100)]

        depth = dict(f.result() for f in minor_future)
        rights = dict(f.result() for f in teams_future)
        people = {p["id"]: p for f in p_futures for p in f.result()}
        seen = set(minor_ids)
        additions = sorted({p[0] for _, rows in depth.values() for p in rows} - seen)
        for i in range(0, len(additions), 100):
            people.update((p["id"], p) for p in profiles(additions[i:i+100], f"minor-extra-{i}.json"))
        fielding = [row for f in fielding_future for row in f.result()]

    with ThreadPoolExecutor(2) as limited:
        reports = list(limited.map(payroll, orgs.values()))
    contracts = {team: [slug, data] for team, slug, data in reports}
    official_teams = {tid: roster for tid, roster in rights.items() if roster is not None}
    protected = {pid for roster in official_teams.values() for pid in roster}
    if len(official_teams) < 27 or len(people) < len(minor_ids) * .9 or sum(bool(rows) for _, rows in contracts.values()) < 27:
        raise ValueError("Source data too incomplete to replace the snapshot")

    eligible = {pid: first_eligible(p, all_affiliates) for pid, p in people.items()}
    team_names = {}
    for p in prospects:
        if p.get("orgId") in orgs:
            team_names[(name_key(orgs[p["orgId"]]["name"]), name_key(p["name"]))] = p["id"]
    for t in all_affiliates.values():
        for p in t["players"]:
            team_names[(name_key(orgs[t["orgId"]]["name"]), name_key(p["name"]))] = p["id"]
    rule_source = OFFICIAL_RULE5.replace("/news/", "/amp/news/") + ".html"
    known_eligible = official_checks(read_optional(cache, "official-rule5.html", [rule_source]) if season == 2026 else None, season, team_names)

    cutoff = min(f"{season}-09-01", dated)
    raw_moves = read_optional(cache, "moves.json", [api("/transactions", sportId=1, startDate=cutoff, endDate=dated)])
    moves = defaultdict(list)
    for row in json.loads(raw_moves).get("transactions", []) if raw_moves else []:
        pid = row.get("person", {}).get("id")
        if pid and row.get("date"):
            moves[pid].append(row)
    free_agents, signed = fa_snapshot(read_optional(cache, f"fa-{season}.json", [api("/people/freeAgents", season=season)]),
                                     moves, season, orgs, protected)
    for pid, (club, start, end) in signed.items():
        record = contracts[club][1].setdefault(str(pid), [{}, None])
        for year in (season, season + 1):
            current = record[0].get(str(year))
            if start <= year <= end and not (current and current[1]):
                record[0][str(year)] = ["signed", True, start, end, end, None, [], "MLB"]

    field = defaultdict(lambda: defaultdict(dict))
    for row in fielding:
        player = row.get("player", {}).get("id")
        team = row.get("team", {}).get("id")
        position = row.get("position", {}).get("abbreviation")
        games = row.get("stat", {}).get("gamesPlayed")
        if team in (orgs.keys() | depth_affiliates.keys()) and player and position and isinstance(games, int) and games > 0:
            field[team][player][position] = games

    result = {
        "version": 1, "asOf": dated, "season": season, "rule5Date": f"{season}-12-{RULE5_DATES[season]:02d}" if season == 2026 else None,
        "officialRule5": OFFICIAL_RULE5 if known_eligible else None, "confirmed": known_eligible,
        "rule5": eligible, "reserve": official_teams, "contracts": contracts, "freeAgents": free_agents,
        "depth": depth, "fielding": field,
    }
    payload = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    raw = gzip.compress(payload, mtime=0)
    target = DOCS / "team-details.json.gz"
    with NamedTemporaryFile(dir=DOCS, delete=False) as stream:
        stream.write(raw)
        temp = Path(stream.name)
    temp.replace(target)
    target.chmod(0o644)
    print(f"{len(eligible):,} MiLB players · {len(known_eligible)} named by MLB · {len(protected):,} MLB reserve ids")
    print(f"{sum(bool(rows) for slug, rows in contracts.values())} payroll sources · {len(free_agents)} free agents · {len(depth)} 3A/2A affiliates")
    print(f"{len(raw):,} bytes")


if __name__ == "__main__":
    main()
