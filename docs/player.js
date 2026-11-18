import { finderReturnUrl } from "./finder-links.js";
import { countryName, escape, fetchPerson, fetchSeasonStats, fetchSnapshot, handedness, installPhotoFallback, normalizePerson, readLastRoster, teamLogo } from "./mlb.js?v=5";

import { advancedDefinitions, loadAdvanced, seasonMetrics } from "./advanced.js";
import { renderPercentiles } from "./percentiles.js?v=3";
import { renderAbility } from "./ability.js?v=1";

const byId = id => document.getElementById(id);
const scopeButtons = byId("scope-switch");
const statSections = byId("stat-sections");
const statsMode = byId("stats-mode");
const splitCheck = byId("split-check");
const params = new URLSearchParams(location.search);
const fromMinors = params.get("from") === "minors";
const finderBack = finderReturnUrl(params);
const playerId = Number(params.get("id"));
const validId = /^\d{1,10}$/.test(params.get("id") ?? "") && playerId > 0;
const labels = { regular: "MLB 例行賽", postseason: "MLB 季後賽", minors: "小聯盟" };
const levelNames = { 11: "3A", 12: "2A", 13: "高階 1A", 14: "1A", 15: "短季 1A", 16: "新人聯盟" };
const historicalAbbreviations = { "Oakland Athletics": "OAK", "Cleveland Indians": "CLE" };
const statRequests = new Map();
let teams = new Map();
let activeScope = "";
let activeRows = [];
let activePlayer;
let identityReady;
let statsView = ["advanced", "percentiles", "ability"].includes(params.get("view")) ? params.get("view") : "standard";
let advancedRequest;
let advancedData;

const definitions = {
  hitting: {
    label: "打擊",
    columns: [
      ["G", "gamesPlayed", "出賽"], ["PA", "plateAppearances", "打席"], ["AB", "atBats", "打數"],
      ["H", "hits", "安打"], ["HR", "homeRuns", "全壘打"], ["RBI", "rbi", "打點"],
      ["SB", "stolenBases", "盜壘"], ["AVG", "avg", "打擊率"], ["OBP", "obp", "上壘率"],
      ["SLG", "slg", "長打率"], ["OPS", "ops", "上壘率加長打率", true],
      ["R", "runs", "得分"], ["2B", "doubles", "二壘安打"], ["3B", "triples", "三壘安打"],
      ["BB", "baseOnBalls", "四壞球"], ["SO", "strikeOuts", "三振"],
      ["CS", "caughtStealing", "盜壘失敗"], ["HBP", "hitByPitch", "觸身球"], ["TB", "totalBases", "壘打數"],
    ],
  },
  pitching: {
    label: "投球",
    columns: [
      ["W", "wins", "勝投"], ["L", "losses", "敗投"], ["ERA", "era", "防禦率", true],
      ["G", "gamesPitched", "登板"], ["GS", "gamesStarted", "先發"], ["IP", "inningsPitched", "投球局數"],
      ["SO", "strikeOuts", "三振"], ["BB", "baseOnBalls", "四壞球"], ["WHIP", "whip", "每局被上壘率", true],
      ["SV", "saves", "救援成功"], ["HLD", "holds", "中繼成功"], ["H", "hits", "被安打"],
      ["R", "runs", "失分"], ["ER", "earnedRuns", "自責分"], ["HR", "homeRuns", "被全壘打"],
      ["K/9", "strikeoutsPer9Inn", "每九局三振"], ["BB/9", "walksPer9Inn", "每九局四壞球"],
      ["CG", "completeGames", "完投"], ["SHO", "shutouts", "完封"],
    ],
  },
  fielding: {
    label: "守備",
    columns: [
      ["G", "gamesPlayed", "守備出賽"], ["GS", "gamesStarted", "先發"], ["INN", "innings", "守備局數"],
      ["TC", "chances", "守備機會"], ["PO", "putOuts", "刺殺"], ["A", "assists", "助殺"],
      ["E", "errors", "失誤"], ["DP", "doublePlays", "雙殺"], ["FPCT", "fielding", "守備率", true],
    ],
  },
};

function shown(value) {
  return value === null || value === undefined || /^[-.]+$/.test(String(value)) && !/\d/.test(String(value))
    ? "—" : value;
}

function displayTeam(team) {
  if (!team?.id) return "";
  return historicalAbbreviations[team.name] ?? teams.get(team.id)?.abbr ?? team.name ?? "";
}

function showIdentity(player, team, bioClub) {
  activePlayer = player;
  const club = team?.nameZh ?? bioClub?.name ?? "MLB 球員";
  const crest = team ? `<img src="${teamLogo(team)}" width="28" height="28" alt="">` : "";
  const uniform = player.jersey === null ? "" : ` · #${escape(player.jersey)}`;
  const jersey = player.jersey === null ? "" : `<span class="profile-jersey">${escape(player.jersey)}</span>`;
  const facts = [
    player.age === null ? null : `${player.age} 歲`,
    player.heightCm === null ? null : `${player.heightCm} cm`,
    player.weightKg === null ? null : `${player.weightKg} kg`,
    [player.bats, player.throws].some(Boolean) ? handedness(player) : null,
  ].filter(Boolean);

  document.title = `${player.name} 歷年成績｜大聯盟球員圖鑑`;
  byId("profile-hero").style.setProperty("--team", team?.color ?? "#005a9c");
  byId("profile-identity").innerHTML = `<div class="profile-title-block">
    <div class="profile-club">${crest}${escape(club)}</div>
    <h1 id="player-name" lang="en">${escape(player.name)}</h1>
    <p class="profile-position">${escape(player.positionZh)}${uniform}</p>
    ${facts.length ? `<ul class="profile-facts">${facts.map(fact => `<li>${escape(fact)}</li>`).join("")}</ul>` : ""}
  </div>
  <div class="profile-visual" aria-hidden="true">
    ${jersey}<img class="player-photo" src="${escape(player.headshotUrl)}" alt="" width="272" height="272"
      decoding="async" referrerpolicy="no-referrer">
  </div>`;
  const official = byId("official-profile");
  official.href = player.profileUrl;
  official.hidden = false;

  const backLink = byId("back-to-roster");
  const backTeam = team?.abbr ?? params.get("team");
  if (!fromMinors && !finderBack) backLink.href = backTeam ? `./?team=${encodeURIComponent(backTeam)}#roster` : "./#roster";

  const place = [player.birthCity, player.birthRegion, countryName(player.birthCountry)].filter(Boolean).join(" · ");
  const bio = [
    ["年齡", player.age === null ? null : `${player.age} 歲`],
    ["投打慣用手", handedness(player)],
    ["身高", player.heightCm === null ? player.height : `${player.heightCm} 公分`],
    ["體重", player.weightKg === null ? null : `${player.weightKg} 公斤`],
    ["出生日期", player.birthDate],
    ["出生地", place],
    ["MLB 初登場", player.debutDate],
    ["選秀年份", player.draftYear],
  ];
  byId("bio-grid").innerHTML = bio.map(([label, value]) =>
    `<div><dt>${label}</dt><dd>${escape(shown(value || null))}</dd></div>`).join("");
  byId("bio-details").hidden = false;
}

function positionOf(row) {
  return row.position?.abbreviation ?? row.stat.position?.abbreviation ?? "";
}

function keepRow(row) {
  if (activePlayer.positionGroup === "pitcher") return row.group === "pitching";

  const twoWay = activePlayer.position === "TWP";
  if (row.group === "pitching") return twoWay;
  if (row.group !== "fielding") return true;

  const position = positionOf(row);
  return position !== "DH" && (twoWay || position !== "P");
}

function totalRow(rows) {
  return rows.find(row => !row.team?.id && row.numTeams > 1 && row.stat);
}

function hasTeamSplits(rows) {
  return [...Map.groupBy(rows, row => `${row.group}-${row.season}-${row.sport.id}-${positionOf(row)}`).values()]
    .some(season => totalRow(season) && season.some(row => row.team?.id));
}

function groupedSeasons(rows) {
  return Array.from(Map.groupBy(rows, row => row.season)).sort(([a], [b]) => Number(b) - Number(a));
}

function displayRows(rows) {
  const levels = [...Map.groupBy(rows, row => `${row.sport.id}/${positionOf(row)}`).values()];
  return levels.flatMap(items => {
    const aggregate = totalRow(items);
    if (!aggregate) return items.map(row => ({ row, details: [], split: false }));
    const teamRows = items.filter(row => row.team?.id);
    const combined = { row: aggregate, details: teamRows, split: false };
    return splitCheck.checked ? [combined, ...teamRows.map(row => ({ row, details: [], split: true }))] : [combined];
  });
}

function advancedSeasonRow(season) {
  const total = totalRow(season);
  if (season.length === 1) return [{ row: season[0], details: [], split: false }];
  return [{
    row: total ?? { ...season[0], stat: {} },
    details: season.filter(row => row.team?.id),
    split: false,
  }];
}

function renderTable(rows, group, isMinor, advanced) {
  const definition = advanced ? advancedDefinitions[group] : definitions[group];
  const fielding = group === "fielding";
  const seasons = groupedSeasons(rows);
  const header = definition.columns.map(([key, , description, emphasis]) =>
    `<th scope="col" title="${description}"${emphasis ? ' class="stat-key"' : ""}>${key}</th>`).join("");
  const dataRows = seasons.map(([year, season]) => {
    const lines = advanced ? advancedSeasonRow(season) : displayRows(season);
    return `<tbody>${lines.map(({ row, details, split }, index) => {
      const clubs = details.length ? details.map(item => item.team) : row.team ? [row.team] : [];
      const names = clubs.map(item => item.name).filter(Boolean).join("、");
      const label = clubs.map(displayTeam).filter(Boolean).join("／") || "—";
      const combined = details.length > 1 || (row.numTeams > 1 && !row.team?.id);
      const stat = advanced ? seasonMetrics(advancedData, group, year, row.stat) : row.stat;
      const cells = definition.columns.map(([, key, , emphasis]) =>
        `<td${emphasis ? ' class="key-value"' : ""}>${escape(shown(stat[key]))}</td>`).join("");
      const yearCell = index === 0 ? `<th class="year-cell" scope="rowgroup" rowspan="${lines.length}">${year}</th>` : "";
      return `<tr${split ? ' class="team-split"' : ""}>${yearCell}
        ${isMinor ? `<td class="text-stat">${escape(levelNames[row.sport.id] ?? row.sport.abbreviation)}</td>` : ""}
        <td class="text-stat club-value" title="${escape(names)}">
          <span${isMinor ? ' class="long-club"' : ""}>${escape(label)}</span>${combined ? '<span class="club-note">合計</span>' : ""}
        </td>
        ${fielding ? `<td class="text-stat">${escape(positionOf(row) || "—")}</td>` : ""}${cells}
      </tr>`;
    }).join("")}</tbody>`;
  }).join("");

  return `<section class="stat-section" id="stats-${group}" aria-labelledby="title-${group}">
    <h3 id="title-${group}">${definition.label}<small>${seasons.length} 個球季</small></h3>
    <div class="stats-scroll" tabindex="0" role="region" aria-labelledby="title-${group}">
      <table class="stats-table">
        <thead><tr>
          <th scope="col" class="year-cell">球季</th>
          ${isMinor ? '<th scope="col" class="text-stat">層級</th>' : ""}
          <th scope="col" class="text-stat">球隊</th>
          ${fielding ? '<th scope="col" class="text-stat">守位</th>' : ""}${header}
        </tr></thead>
        ${dataRows}
      </table>
    </div>
  </section>`;
}

function emptyStats() {
  const next = activeScope === "regular"
    ? '<button type="button" class="reset-filter" data-select-scope="minors">查看小聯盟成績</button>'
    : '<button type="button" class="reset-filter" data-select-scope="regular">查看 MLB 例行賽</button>';
  return `<div class="empty-state stats-empty"><strong>${labels[activeScope]}尚無逐年紀錄</strong>
    <p>有出賽成績時，會按球季顯示在此。</p>${next}</div>`;
}

function currentViewIsAdvanced() {
  return activeScope === "regular" && statsView === "advanced";
}

function setStatsView(view) {
  statsView = view;
  const url = new URL(location.href);
  if (view === "standard") url.searchParams.delete("view");
  else url.searchParams.set("view", view);
  history.replaceState(null, "", url);
  if ((view === "percentiles" && activeScope !== "regular") || (view === "ability" && activeScope === "minors")) {
    void selectScope("regular");
    return;
  }
  if (statSections.getAttribute("aria-busy") === "false") renderStats();
}

function renderStats() {
  const visible = activeRows.filter(keepRow);
  const regularAdvanced = visible.filter(row => Object.hasOwn(advancedDefinitions, row.group));
  const regular = activeScope === "regular";
  const ability = statsView === "ability" && activeScope !== "minors";
  const view = regular || ability ? statsView : "standard";
  statsMode.hidden = false;
  statsMode.querySelector('[data-view="advanced"]').hidden = !regular || !regularAdvanced.length;
  for (const button of statsMode.querySelectorAll("[data-view]")) {
    button.setAttribute("aria-pressed", String(!button.hidden && button.dataset.view === view));
  }
  if (ability) {
    byId("split-toggle").hidden = true;
    renderAbility(statSections, playerId, regularAdvanced, activeScope);
    return;
  }
  if (view === "percentiles") {
    byId("split-toggle").hidden = true;
    renderPercentiles(statSections, playerId, regularAdvanced);
    return;
  }
  const advanced = view === "advanced" && regularAdvanced.length > 0;
  const rows = advanced ? regularAdvanced : visible;
  byId("split-toggle").hidden = advanced || !hasTeamSplits(visible);
  if (!rows.length) {
    statSections.innerHTML = emptyStats();
    return;
  }
  if (advanced && !advancedData) {
    statSections.innerHTML = '<p class="loading-message" role="status">正在讀取逐年進階數據…</p>';
    advancedRequest ??= loadAdvanced(playerId, regularAdvanced).then(data => {
      advancedData = data;
      if (currentViewIsAdvanced() && statSections.getAttribute("aria-busy") === "false") renderStats();
    });
    return;
  }
  const groups = Map.groupBy(rows, row => row.group);
  const isMinor = activeScope === "minors";
  const tables = advanced ? advancedDefinitions : definitions;
  const keys = Object.keys(tables).filter(group => groups.has(group));
  const intro = isMinor ? "小聯盟成績按球季及層級列出，可橫向捲動表格。" : "橫向捲動表格可查看其餘欄位。";
  const links = keys.length > 1 ? `<nav class="stat-jumps" aria-label="跳到成績類別">${keys.map(group =>
    `<a href="#stats-${group}">${tables[group].label}</a>`,
  ).join("")}</nav>` : "";
  let sourceNote = "";
  if (advanced) {
    const coverage = advancedData.firstSeason
      ? `<a href="https://baseballsavant.mlb.com/leaderboard/custom" target="_blank" rel="noopener noreferrer">Baseball Savant</a> ${advancedData.firstSeason}–${advancedData.lastSeason} 年整季數據，部分年份由 MLB 官方補充。`
      : "目前顯示 MLB 官方可讀取的進階數據。";
    const fangraphs = `<a href="https://www.fangraphs.com/leaders/major-league" target="_blank" rel="noopener noreferrer">FanGraphs</a>`;
    const indexSource = advancedData.fangraphsAvailable
      ? `wRC+ 與 ERA- 取自 ${fangraphs}。`
      : `${fangraphs} 的 wRC+ 與 ERA- 暫時無法載入。`;
    sourceNote = `<p class="stats-notice">${indexSource} ${coverage} — 代表資料缺值。</p>`;
  }
  statSections.innerHTML = `<div class="stats-caption">${links}<p class="stats-notice">${intro}</p></div>`
    + keys.map(group => renderTable(groups.get(group), group, isMinor, advanced)).join("") + sourceNote;
}

async function selectScope(scope, changeURL = true) {
  if (!validId || !Object.hasOwn(labels, scope)) return;
  activeScope = scope;
  if (changeURL) {
    const url = new URL(location.href);
    if (scope === "regular") url.searchParams.delete("scope");
    else url.searchParams.set("scope", scope);
    history.replaceState(null, "", url);
  }
  for (const button of scopeButtons.querySelectorAll("[data-scope]")) {
    button.setAttribute("aria-pressed", String(button.dataset.scope === scope));
  }
  statsMode.hidden = true;
  byId("split-toggle").hidden = true;
  statSections.setAttribute("aria-busy", "true");
  statSections.innerHTML = `<p class="loading-message">正在讀取${labels[scope]}逐年成績…</p>`;
  try {
    if (!statRequests.has(scope)) statRequests.set(scope, fetchSeasonStats(playerId, scope));
    const [rows] = await Promise.all([statRequests.get(scope), identityReady]);
    if (scope !== activeScope || !activePlayer) return;
    activeRows = rows;
    renderStats();
  } catch (error) {
    statRequests.delete(scope);
    if (scope !== activeScope) return;
    console.warn("Could not retrieve MLB season statistics", error);
    statSections.innerHTML = '<div class="empty-state"><strong>成績暫時無法載入</strong><p>可以重新查詢 MLB 官方資料。</p><button class="retry-button" type="button" data-retry>重新載入</button></div>';
  } finally {
    if (scope === activeScope) statSections.setAttribute("aria-busy", "false");
  }
}

function connectEvents() {
  scopeButtons.addEventListener("click", event => {
    const button = event.target.closest("[data-scope]");
    if (button) void selectScope(button.dataset.scope);
  });
  statSections.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (button?.dataset.selectScope) {
      const scope = button.dataset.selectScope;
      scopeButtons.querySelector(`[data-scope="${scope}"]`)?.focus();
      void selectScope(scope);
    } else if (button?.hasAttribute("data-retry")) {
      void selectScope(activeScope);
    }
  });
  statsMode.addEventListener("click", event => {
    const button = event.target.closest("[data-view]");
    if (button) setStatsView(button.dataset.view);
  });
  splitCheck.addEventListener("change", renderStats);
}

function noPlayer() {
  byId("player-name").textContent = "找不到這位球員";
  scopeButtons.hidden = true;
  const back = byId("back-to-roster");
  statSections.innerHTML = `<div class="empty-state"><strong>球員連結無法讀取</strong><p>可以回到名單重新選擇球員。</p><a class="source-link" href="${escape(back.getAttribute("href"))}">${escape(back.textContent)}</a></div>`;
  statSections.setAttribute("aria-busy", "false");
}

async function start() {
  installPhotoFallback();
  if (finderBack) {
    const back = byId("back-to-roster");
    back.href = finderBack;
    const origin = new URLSearchParams(params.get("finder"));
    back.textContent = origin.get("mode") === "name" ? "回姓名搜尋" : "回該季球隊名單";
  } else if (fromMinors) {
    const backParams = new URLSearchParams();
    if (params.has("team")) backParams.set("team", params.get("team"));
    if (params.has("minorView")) backParams.set("view", params.get("minorView"));
    for (const key of ["level", "q"]) {
      if (params.has(key)) backParams.set(key, params.get(key));
    }
    const back = byId("back-to-roster");
    back.href = `minors.html${backParams.size ? `?${backParams}` : ""}#minors`;
    back.textContent = "回小聯盟";
  }
  if (!validId) {
    noPlayer();
    return;
  }
  const personRequest = fetchPerson(playerId).catch(error => {
    console.warn("Could not retrieve current MLB player details", error);
    return null;
  });

  const snapshot = await fetchSnapshot().then(readLastRoster).catch(() => null);
  if (snapshot) teams = new Map(snapshot.teams.map(team => [team.id, team]));
  const knownTeam = snapshot?.teams.find(team => team.players.some(player => player.id === playerId));
  const knownPlayer = knownTeam?.players.find(player => player.id === playerId);
  if (knownPlayer) showIdentity(knownPlayer, knownTeam);
  const requestedScope = params.get("scope");
  const initialScope = Object.hasOwn(labels, requestedScope) ? requestedScope
    : knownPlayer && !knownPlayer.debutDate ? "minors" : "regular";
  identityReady = personRequest.then(person => {
    if (!person) return;
    const currentTeam = teams.get(person.currentTeam?.id);
    const sameTeam = currentTeam && currentTeam.id === knownTeam?.id;
    const position = sameTeam
      ? { abbreviation: knownPlayer.position, name: knownPlayer.positionName }
      : person.primaryPosition;
    const jersey = sameTeam ? knownPlayer.jersey ?? person.primaryNumber : person.primaryNumber;
    showIdentity(normalizePerson(person, position, jersey, knownPlayer), currentTeam, person.currentTeam);
  });
  connectEvents();
  await Promise.all([identityReady, selectScope(initialScope, false)]);
  if (!activePlayer) noPlayer();
}

void start();
