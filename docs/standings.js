import { escape } from "./mlb.js";
import { availableSeasons, FIRST_SEASON, LAST_ARCHIVE, leagueName, loadArchive, MLB_LEAGUES, request } from "./history-data.js";

const DIVISIONS = { E: "東區", C: "中區", W: "西區" };
const MLB_DIVISIONS = { 200: "W", 201: "E", 202: "C", 203: "W", 204: "E", 205: "C" };
const collator = new Intl.Collator("en", { sensitivity: "base" });
const element = id => document.getElementById("standings-" + id);
const query = new URLSearchParams(location.search);
const teamUrl = (season, team) => "history.html?" + new URLSearchParams({ season, ...(team && { team: team.key }) });
const groupName = ({ league, division }) => leagueName(league) + (DIVISIONS[division] ?? "");

let year = Number(query.get("season"));
let league = query.get("league") ?? "";
let showGroups = query.get("view") === "division";
let archiveRequest, currentTeams = [], latestRequest = 0;

function getArchive() {
  archiveRequest ??= loadArchive("standings-archive.json.gz?v=1").then(archive => {
    if (archive.through !== LAST_ARCHIVE || !archive.standings?.[FIRST_SEASON] || !archive.series) {
      throw new Error("Invalid standings archive");
    }
    return archive;
  }).catch(error => { archiveRequest = null; throw error; });
  return archiveRequest;
}

async function archivedSeason(season) {
  const archive = await getArchive();
  const teams = archive.standings[season].map(([key, name, league, division, rank, wins, losses, pennant]) =>
    ({ key, name, league, division, rank, wins, losses, pennant }));
  const byKey = new Map(teams.map(team => [team.key, team]));
  const finals = (archive.series[season] ?? []).map(([kind, winner, opponent, wins, losses, ties]) =>
    ({ kind, winner: byKey.get(winner), opponent: byKey.get(opponent), wins, losses, ties }));
  return { teams, finals };
}

async function liveStandings(season) {
  const { records } = await request("/standings", {
    season, leagueId: "103,104", standingsTypes: "regularSeason", hydrate: "team",
    fields: "records,league,id,division,teamRecords,team,name,wins,losses,divisionRank,leagueRank",
  });
  if (!Array.isArray(records)) throw new Error("MLB did not return standings");
  return records.flatMap(record => record.teamRecords.map(row => ({
    key: String(row.team.id), name: row.team.name, league: MLB_LEAGUES[record.league.id],
    division: MLB_DIVISIONS[record.division?.id] ?? "",
    rank: Number(row.divisionRank ?? row.leagueRank) || null, wins: row.wins, losses: row.losses,
  })));
}

async function liveFinal(season) {
  const { dates } = await request("/schedule", { sportId: 1, season, gameType: "W", hydrate: "seriesStatus" });
  if (!Array.isArray(dates)) throw new Error("MLB did not return the World Series schedule");
  const decider = dates.flatMap(day => day.games).find(game => game.gameType === "W"
    && game.status?.abstractGameState === "Final" && game.seriesStatus?.isOver);
  if (!decider) return [];
  const { winningTeam, losingTeam, wins, losses } = decider.seriesStatus;
  if (!winningTeam?.id || !losingTeam?.id || !Number.isInteger(wins) || !Number.isInteger(losses) || wins <= losses) {
    throw new Error("Incomplete World Series result");
  }
  const winner = { key: String(winningTeam.id), name: winningTeam.name };
  const opponent = { key: String(losingTeam.id), name: losingTeam.name };
  return [{ kind: "WS", winner, opponent, wins, losses, ties: 0 }];
}

const winRate = team => team.wins + team.losses > 0 ? team.wins / (team.wins + team.losses) : null;
const rateLabel = team => winRate(team)?.toFixed(3).replace(/^0/, "") ?? "—";
const compareRates = (a, b) => (winRate(b) ?? -1) - (winRate(a) ?? -1) || collator.compare(a.name, b.name);
const nameLink = (season, team) => `<a href="${escape(teamUrl(season, team))}">${escape(team.name)}</a>`;

function combinedRank(teams) {
  let previousRate, rank;
  return [...teams].sort(compareRates).map((team, index) => {
    const rate = winRate(team);
    if (rate !== previousRate) rank = index + 1;
    previousRate = rate;
    return { ...team, rank: rate === null ? null : rank };
  });
}

function groupTables(teams) {
  const groups = new Map();
  for (const team of teams) {
    const key = `${team.league}${({ E: "1", C: "2", W: "3" })[team.division] ?? ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(team);
  }
  return [...groups.keys()].sort().map(key => {
    const members = groups.get(key).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || compareRates(a, b));
    const name = groupName(members[0]);
    return `<section><h3>${escape(name)}</h3>${table(members, name, false)}</section>`;
  }).join("");
}

function table(teams, label, showLeague) {
  return `<table class="standings-table" aria-label="${escape(label)}"><thead><tr>
    <th class="rank" scope="col">名次</th><th scope="col">球隊</th>
    <th class="number" scope="col">勝</th><th class="number" scope="col">敗</th><th class="number" scope="col">勝率</th>
  </tr></thead><tbody>${teams.map(team => `<tr>
    <td class="rank">${escape(team.rank ?? "—")}</td>
    <th scope="row">${nameLink(year, team)}${showLeague ? `<small>${escape(groupName(team))}</small>` : ""}</th>
    <td class="number">${escape(team.wins ?? "—")}</td><td class="number">${escape(team.losses ?? "—")}</td>
    <td class="number">${rateLabel(team)}</td>
  </tr>`).join("")}</tbody></table>`;
}

function showRankings() {
  const teams = currentTeams.filter(team => !league || team.league === league);
  const method = showGroups ? "依當年分區或聯盟名次" : "按所選範圍的勝率排序，同勝率並列";
  element("meta").textContent = `${year} 年 · ${teams.length} 支球隊 · ${method}`;
  element("overall").setAttribute("aria-pressed", String(!showGroups));
  element("groups").setAttribute("aria-pressed", String(showGroups));
  element("results").classList.toggle("standings-groups", showGroups && teams.length > 0);
  element("results").innerHTML = teams.length
    ? showGroups ? groupTables(teams) : table(combinedRank(teams), "例行賽勝率排名", true)
    : `<div class="empty-state"><strong>目前沒有這個球季的例行賽戰績。</strong></div>`;
  element("results").setAttribute("aria-busy", "false");
}

function seriesLabel(kind, season) {
  if (kind === "WS") return season < 1903 ? "早期跨聯盟世界大賽" : "世界大賽";
  return { NWS: "黑人聯盟世界大賽", CS: "國家聯盟冠軍賽", TEMPLE: "Temple Cup", CUP: "Chronicle-Telegraph Cup" }[kind];
}

function seriesCard({ kind, winner, opponent, wins, losses, ties }) {
  const label = seriesLabel(kind, year);
  const tied = wins === losses;
  const title = tied ? "系列賽平手，無冠軍" : nameLink(year, winner);
  const teams = tied ? `${nameLink(year, winner)} 對 ${nameLink(year, opponent)}` : `擊敗 ${nameLink(year, opponent)}`;
  return `<article class="champion-card">
    <p class="champion-label">${label}${tied ? "" : "冠軍"}</p>
    <div class="champion-main"><h2>${title}</h2><strong class="champion-score" aria-label="系列賽 ${wins} 比 ${losses}">${wins}–${losses}</strong></div>
    <p class="champion-detail">${teams}${ties ? ` · 另有 ${ties} 場和局` : ""}</p>
  </article>`;
}

function championStatus(finals, teams) {
  if (finals.length) return finals.map(seriesCard).join("");
  const pennants = teams.filter(team => team.pennant).map(team => `${escape(leagueName(team.league))} ${nameLink(year, team)}`);
  let status = "本季無季後冠軍賽紀錄";
  if (year === 1904) status = "未舉辦世界大賽";
  if (year === 1994) status = "季後賽因罷工取消";
  if (year > LAST_ARCHIVE) status = "世界大賽冠軍尚未產生";
  const detail = pennants.length ? `<p class="champion-detail">例行賽聯盟冠軍 · ${pennants.join("　／　")}</p>` : "";
  return `<article class="champion-card"><p class="champion-label">季後賽</p><h2>${status}</h2>${detail}</article>`;
}

function updateUrl() {
  const url = new URL(location.href);
  url.searchParams.set("season", year);
  if (showGroups) url.searchParams.set("view", "division");
  else url.searchParams.delete("view");
  if (league) url.searchParams.set("league", league);
  else url.searchParams.delete("league");
  history.replaceState(null, "", url);
  element("history").href = teamUrl(year);
}

function ready(teams) {
  currentTeams = teams;
  const leagues = [...new Set(teams.map(team => team.league))].sort();
  if (!leagues.includes(league)) league = "";
  element("league").replaceChildren(new Option("全部聯盟", ""), ...leagues.map(code => new Option(leagueName(code), code)));
  element("league").value = league;
  element("filters").hidden = !teams.length;
  showRankings();
  updateUrl();
}

function showLoadError(error) {
  console.warn("Could not load season standings", error);
  element("results").setAttribute("aria-busy", "false");
  element("results").innerHTML = `<div class="empty-state"><strong>目前無法載入例行賽排名</strong><button class="source-link" type="button">重新讀取</button></div>`;
  element("results").querySelector("button").addEventListener("click", loadSeason);
}

async function loadSeason() {
  const active = ++latestRequest;
  const season = year;
  updateUrl();
  element("filters").hidden = true;
  element("meta").textContent = "";
  element("champions").replaceChildren();
  element("results").classList.remove("standings-groups");
  element("results").setAttribute("aria-busy", "true");
  element("results").innerHTML = `<p class="loading-message">正在讀取 ${season} 年戰績…</p>`;
  try {
    if (season <= LAST_ARCHIVE) {
      const { teams, finals } = await archivedSeason(season);
      if (active !== latestRequest) return;
      element("champions").innerHTML = championStatus(finals, teams);
      ready(teams);
      return;
    }
    const [teams, finals] = await Promise.allSettled([liveStandings(season), liveFinal(season)]);
    if (active !== latestRequest) return;
    if (finals.status === "fulfilled") element("champions").innerHTML = championStatus(finals.value, []);
    else element("champions").innerHTML = `<article class="champion-card"><p class="champion-label">世界大賽</p><h2>結果暫時無法讀取</h2></article>`;
    if (teams.status === "rejected") showLoadError(teams.reason);
    else ready(teams.value);
  } catch (error) {
    if (active === latestRequest) showLoadError(error);
  }
}

async function start() {
  const seasons = await availableSeasons();
  if (!seasons.includes(year)) year = seasons[0];
  element("year").replaceChildren(...seasons.map(season => new Option(season, season)));
  element("year").value = year;
  element("year").disabled = false;
  element("year").addEventListener("change", () => {
    year = Number(element("year").value);
    void loadSeason();
  });
  element("league").addEventListener("change", () => {
    league = element("league").value;
    updateUrl();
    showRankings();
  });
  for (const [id, grouped] of [["overall", false], ["groups", true]]) {
    element(id).addEventListener("click", () => {
      showGroups = grouped;
      updateUrl();
      showRankings();
    });
  }
  await loadSeason();
}

void start();
