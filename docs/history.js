import { escape } from "./mlb.js";
import { availableSeasons, FIRST_SEASON, LAST_ARCHIVE, leagueName, loadArchive, MLB_LEAGUES, request } from "./history-data.js";

const FRANCHISE = { AZ: "ARI", KC: "KCR", ATH: "OAK", LAA: "ANA", MIA: "FLA", TB: "TBD", WSH: "WSN", SD: "SDP", SF: "SFG" };
const element = id => document.getElementById("history-" + id);
const query = new URLSearchParams(location.search);
const state = { year: Number(query.get("season")), league: query.get("league") ?? "", team: query.get("team") ?? "", franchise: "LAD", search: "" };
const displayName = new Intl.Collator("en", { sensitivity: "base" });
const roleNames = {
  P: "投手", C: "捕手", "1B": "一壘手", "2B": "二壘手", "3B": "三壘手", SS: "游擊手",
  LF: "左外野手", CF: "中外野手", RF: "右外野手", OF: "外野手", DH: "指定打擊", PH: "代打", PR: "代跑",
};
const teamRequests = new Map();
const rosterRequests = new Map();
const matches = text => String(text).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const historyUrl = params => "history.html?" + new URLSearchParams(params).toString();
const empty = message => `<div class="empty-state"><strong>${escape(message)}</strong></div>`;

let archiveRequest, seasonTeams = [], selectedRoster, targetRequest = 0;

function memo(cache, key, action) {
  if (!cache.has(key)) cache.set(key, action().catch(error => {
    cache.delete(key);
    throw error;
  }));
  return cache.get(key);
}

function getArchive() {
  archiveRequest ??= loadArchive("history-archive.json.gz?v=1").then(data => {
    if (data.through !== LAST_ARCHIVE || !data.seasons?.[FIRST_SEASON] || !Array.isArray(data.players)) {
      throw new Error("Invalid historical archive");
    }
    return data;
  }).catch(error => { archiveRequest = null; throw error; });
  return archiveRequest;
}

function getTeams(year) {
  return memo(teamRequests, year, async () => {
    if (year <= LAST_ARCHIVE) {
      const archived = await getArchive();
      return (archived.seasons[year] ?? []).map(([key, name, league, franchise, roster]) => ({ key, name, league, franchise, roster }));
    }
    const { teams } = await request("/teams", {
      season: year, sportId: 1, fields: "teams,id,name,abbreviation,league",
    });
    return teams.map(team => ({
      key: String(team.id), id: team.id, name: team.name,
      league: MLB_LEAGUES[team.league?.id] ?? team.league?.name ?? "",
      franchise: FRANCHISE[team.abbreviation] ?? team.abbreviation,
    }));
  });
}

async function rosterInSeason(year, team) {
  if (team.roster) {
    const archive = await getArchive();
    return team.roster.map(([index, pos, mask]) => {
      const [legacy, name, id] = archive.players[index];
      return { legacy, name, id, mask, position: archive.positions[pos] };
    });
  }
  return memo(rosterRequests, year + "/" + team.key, async () => {
    const fields = "stats,group,displayName,totalSplits,splits,player,id,fullName,position,abbreviation,stat,gamesPlayed";
    const result = await Promise.all(["R", "P"].map(gameType => request("/stats", {
      season: year, teamId: team.id, sportIds: 1, group: "hitting,pitching,fielding",
      stats: "season", gameType, playerPool: "ALL", limit: 1000, fields,
    })));
    const players = new Map();
    for (const [i, payload] of result.entries()) {
      if (!Array.isArray(payload.stats)) throw new Error("MLB did not return a roster");
      for (const block of payload.stats) {
        if (!Array.isArray(block.splits) || block.totalSplits > block.splits.length) throw new Error("Incomplete MLB stats results");
        for (const row of block.splits) {
          const { id, fullName } = row.player ?? {};
          const games = row.stat?.gamesPlayed;
          if (!Number.isSafeInteger(id) || !fullName || games === 0) continue;
          const player = players.get(id) ?? { id, name: fullName, position: "—", priority: -1, mask: 0 };
          player.mask |= i === 0 ? 1 : 2;
          const role = block.group?.displayName;
          const pos = role === "pitching" ? "P" : row.position?.abbreviation;
          const score = (i === 0 ? 1000 : 0) + (role === "fielding" ? 300 : role === "pitching" ? 150 : 0) + (games ?? 0);
          if (pos && pos !== "X" && score > player.priority) {
            player.position = pos;
            player.priority = score;
          }
          players.set(id, player);
        }
      }
    }
    return [...players.values()];
  });
}

function options(id, entries, selected) {
  const select = element(id);
  select.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
  select.value = String(selected);
}

function leagueChoices() {
  const codes = [...new Set(seasonTeams.map(team => team.league))].sort((a, b) => displayName.compare(leagueName(a), leagueName(b)));
  if (!codes.includes(state.league)) state.league = "";
  options("league", [["", "全部聯盟"], ...codes.map(code => [code, leagueName(code)])], state.league);
}

function teamChoices() {
  const choices = seasonTeams.filter(team => !state.league || team.league === state.league)
    .sort((a, b) => displayName.compare(a.name, b.name));
  const selected = choices.find(team => team.key === state.team)
    ?? choices.find(team => team.franchise === state.franchise) ?? choices[0];
  state.team = selected?.key ?? "";
  if (selected?.franchise) state.franchise = selected.franchise;
  options("team", choices.map(team => [team.key, `${team.name} · ${team.league}`]), state.team);
  return selected;
}

function updateUrl() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries({ season: state.year, league: state.league, team: state.team })) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  history.replaceState(null, "", url);
  element("standings").href = "standings.html?season=" + state.year;
}

function rosterLink(player, team) {
  if (player.id && state.year >= 1876) {
    const params = new URLSearchParams({ id: player.id });
    if (!(player.mask & 1)) params.set("scope", "postseason");
    return "player.html?" + params;
  }
  return historyUrl({ player: player.legacy, season: state.year, team: team.key, league: state.league });
}

function renderRoster() {
  if (!selectedRoster) return;
  const { team, players } = selectedRoster;
  const name = state.search.trim();
  const displayed = name ? players.filter(p => matches(p.name).includes(matches(name))) : players;
  const source = state.year <= LAST_ARCHIVE ? "SABR Lahman" : "MLB 官方資料";
  const note = [leagueName(team.league), `${players.length} 位有出賽紀錄`, source, name ? `搜尋到 ${displayed.length} 位` : ""].filter(Boolean).join(" · ");
  element("results").innerHTML = `<h2 class="history-title">${state.year} ${escape(team.name)}</h2><p class="history-note" id="history-count">${escape(note)}</p>`
    + (displayed.length ? `<table class="history-table" aria-label="歷史出賽名單"><thead><tr><th scope="col">球員</th><th scope="col">守位</th><th scope="col">出賽</th></tr></thead><tbody>${displayed.map(player =>
      `<tr><th scope="row"><a href="${escape(rosterLink(player, team))}">${escape(player.name)}</a></th><td class="role">${escape(player.position)}${roleNames[player.position] ? " · " + roleNames[player.position] : ""}</td><td>${player.mask === 3 ? "例行賽／季後賽" : player.mask === 2 ? "季後賽" : "例行賽"}</td></tr>`).join("")}</tbody></table>`
      : empty(name ? "找不到符合姓名的球員" : "現有資料沒有這支球隊的出賽紀錄"));
  element("results").setAttribute("aria-busy", "false");
}

function loading(message) {
  selectedRoster = null;
  element("results").setAttribute("aria-busy", "true");
  element("results").innerHTML = `<p class="loading-message">${escape(message)}</p>`;
}

function showError(error, retry) {
  console.warn("Could not load baseball history", error);
  element("results").setAttribute("aria-busy", "false");
  element("results").innerHTML = '<div class="empty-state"><strong>暫時無法載入球季資料</strong><button class="source-link" type="button">重新讀取</button></div>';
  element("results").querySelector("button").addEventListener("click", retry);
}

async function showTeam(team) {
  const ticket = ++targetRequest;
  updateUrl();
  loading("正在讀取球隊出賽名單…");
  if (!team) {
    element("results").innerHTML = empty("這個球季沒有球隊資料");
    element("results").setAttribute("aria-busy", "false");
    return;
  }
  try {
    const players = await rosterInSeason(state.year, team);
    if (ticket !== targetRequest) return;
    selectedRoster = { team, players: [...players].sort((a, b) => displayName.compare(a.name, b.name)) };
    renderRoster();
  } catch (error) {
    if (ticket === targetRequest) showError(error, () => void showTeam(team));
  }
}

async function showSeason() {
  const ticket = ++targetRequest;
  loading("正在載入球季球隊…");
  element("league").disabled = true;
  element("team").disabled = true;
  try {
    const teams = await getTeams(state.year);
    if (ticket !== targetRequest) return;
    seasonTeams = teams;
    leagueChoices();
    const selected = teamChoices();
    element("league").disabled = false;
    element("team").disabled = false;
    await showTeam(selected);
  } catch (error) {
    if (ticket === targetRequest) showError(error, showSeason);
  }
}

async function showLegacyPlayer(pid) {
  const archive = await getArchive();
  const index = archive.players.findIndex(player => player[0] === pid);
  if (index < 0) {
    element("results").innerHTML = empty("找不到這位歷史球員");
    element("results").setAttribute("aria-busy", "false");
    return;
  }
  const [, name, id, bbref] = archive.players[index];
  const back = historyUrl({ season: state.year || 1871, team: state.team, league: state.league });
  const profile = id ? `<a class="source-link" href="player.html?id=${id}">MLB 歷年成績</a>` : "";
  const source = /^[a-z0-9]+$/i.test(bbref) ? `<a class="source-link" href="https://www.baseball-reference.com/players/${bbref[0]}/${bbref}.shtml" target="_blank" rel="noopener noreferrer">歷史生涯統計</a>` : "";
  const career = Object.entries(archive.seasons).flatMap(([year, teams]) => teams.flatMap(([key, club, lg, , roster]) => {
    const record = roster.find(item => item[0] === index);
    return record ? [{ year, key, club, lg, position: archive.positions[record[1]] }] : [];
  })).sort((a, b) => b.year - a.year);
  element("results").innerHTML = `<h2 class="history-title">${escape(name)}</h2><p class="history-note">SABR 歷年出賽球隊</p>
  <div class="history-links"><a class="source-link" href="${escape(back)}">回原球隊名單</a>${profile}${source}</div>
  <table class="history-table" aria-label="歷年效力球隊"><thead><tr><th scope="col">球季</th><th scope="col">球隊</th><th scope="col">守位</th></tr></thead><tbody>
  ${career.map(row => `<tr><td>${row.year}</td><th scope="row"><a href="${escape(historyUrl({ season: row.year, team: row.key }))}">${escape(row.club)}</a></th><td>${escape(row.position)}</td></tr>`).join("")}</tbody></table>`;
  element("results").setAttribute("aria-busy", "false");
}

async function start() {
  if (state.year >= FIRST_SEASON) element("standings").href = "standings.html?season=" + state.year;
  const legacy = query.get("player");
  if (legacy) {
    try { await showLegacyPlayer(legacy); }
    catch (error) { showError(error, start); }
    return;
  }
  const available = await availableSeasons();
  if (!available.includes(state.year)) state.year = available[0];
  element("filters").hidden = false;
  options("year", available.map(year => [year, year]), state.year);
  element("year").addEventListener("change", () => {
    state.year = Number(element("year").value);
    state.league = "";
    state.team = "";
    void showSeason();
  });
  element("league").addEventListener("change", () => {
    state.league = element("league").value;
    void showTeam(teamChoices());
  });
  element("team").addEventListener("change", () => {
    state.team = element("team").value;
    const team = seasonTeams.find(team => team.key === state.team);
    state.franchise = team?.franchise ?? "";
    void showTeam(team);
  });
  element("search").addEventListener("input", event => {
    state.search = event.target.value;
    renderRoster();
  });
  await showSeason();
}

void start();
