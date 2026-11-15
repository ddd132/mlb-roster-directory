import { countryName, escape, fetchLiveRoster, fetchSnapshot, installPhotoFallback, readLastRoster, rememberRoster, rosterCsv, taipeiTime, teamLogo as logo } from "./mlb.js";

const byId = id => document.getElementById(id);
const searchForm = byId("player-search");
const searchInput = byId("search-input");
const clearSearch = byId("clear-search");
const divisionList = byId("division-list");
const leagueSwitch = byId("league-switch");
const teamSelect = byId("team-select");
const positionFilters = byId("position-filters");
const sortSelect = byId("sort-select");
const resultList = byId("player-results");
const downloadMenu = byId("downloads");
const leagueNames = { AL: "美國聯盟", NL: "國家聯盟" };
const state = { team: null, league: "NL", position: "all", sort: "jersey", search: "", expanded: new Set() };
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
const number = new Intl.NumberFormat("en-US");
const LIVE_INTERVAL = 120_000;
const icon = name => `<span class="icon icon-${name}" aria-hidden="true"></span>`;
const normalize = value => String(value ?? "").normalize("NFKD").toLowerCase()
  .replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

let snapshot;
let searchIndex;
let teamMap;
let playerMap;
let searchDelay;
let bundledSnapshot;
let lastAttempt = 0;
let refreshing = false;

function matchesForQuery(query) {
  const words = normalize(query).split(" ").filter(Boolean);
  if (!words.length) return [];
  return searchIndex.filter(({ keywords }) => words.every(word => keywords.includes(word)));
}

function comparePlayers(a, b) {
  if (state.sort === "jersey") {
    const numberA = a.jersey === null ? Infinity : Number(a.jersey);
    const numberB = b.jersey === null ? Infinity : Number(b.jersey);
    if (numberA !== numberB) return numberA - numberB;
  }
  if (state.sort === "age") {
    const ageA = a.age ?? -1;
    const ageB = b.age ?? -1;
    if (ageA !== ageB) return ageB - ageA;
  }
  return collator.compare(a.name, b.name) || a.id - b.id;
}

function forActivePosition(players) {
  const visible = state.position === "all"
    ? [...players]
    : players.filter(player => player.positionGroup === state.position);
  return visible.sort(comparePlayers);
}

function teamDivisionGroups(league) {
  return Map.groupBy(snapshot.teams.filter(team => team.league === league), team => team.division);
}

function renderTeamNavigation() {
  const openDivisions = new Set(
    Array.from(divisionList.querySelectorAll("details[open]"), division => division.dataset.division),
  );
  const groups = teamDivisionGroups(state.league);
  const selectedDivision = state.team.league === state.league ? state.team.division : groups.keys().next().value;
  for (const button of leagueSwitch.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.league === state.league));
  }

  divisionList.innerHTML = Array.from(groups, ([division, teams]) => {
    const isOpen = (division === selectedDivision || openDivisions.has(division)) ? "open" : "";
    const rows = teams.map(team => {
      const active = team.id === state.team.id && !state.search ? 'aria-current="true"' : "";
      return `<li><button class="team-button" type="button" data-team="${team.id}" ${active}>
        <img src="${logo(team)}" width="24" height="24" alt="">
        <span>${escape(team.shortNameZh)}</span><span class="team-abbr">${escape(team.abbr)}</span>
      </button></li>`;
    }).join("");
    return `<details class="division" data-division="${escape(division)}" ${isOpen}>
      <summary><span class="division-name">${escape(teams[0].divisionZh)} <span class="division-code">${escape(division)}</span></span>
        ${icon("chevron")}
      </summary>
      <ul class="team-list">${rows}</ul>
    </details>`;
  }).join("");

  teamSelect.value = String(state.team.id);
}

function setMobileTeams() {
  teamSelect.innerHTML = ["NL", "AL"].flatMap(league =>
    Array.from(teamDivisionGroups(league), ([, teams]) => {
      const options = teams.map(team =>
        `<option value="${team.id}">${escape(team.nameZh)}（${escape(team.abbr)}）</option>`,
      ).join("");
      return `<optgroup label="${leagueNames[league]}${escape(teams[0].divisionZh)}">${options}</optgroup>`;
    }),
  ).join("");
}

function renderHeading() {
  const viewHeading = byId("view-heading");
  if (state.search) {
    viewHeading.innerHTML = `<div class="search-heading">
      <h2 id="roster-title" tabindex="-1">搜尋結果</h2>
      <p>從 ${snapshot.teamCount} 支球隊搜尋「${escape(state.search)}」</p>
    </div>`;
    return;
  }
  const team = state.team;
  viewHeading.style.setProperty("--team", team.color);
  viewHeading.innerHTML = `<div class="team-identity">
    <img class="team-crest" src="${logo(team)}" alt="" width="62" height="62">
    <div class="team-label">
      <h2 id="roster-title" tabindex="-1">${escape(team.nameZh)}</h2>
      <p class="team-subtitle"><span class="english-name" lang="en">${escape(team.name)}</span> · ${escape(team.leagueZh)}${escape(team.divisionZh)}</p>
    </div>
  </div>
  <div class="team-actions">
    <div class="roster-count" aria-label="40 人名單已使用 ${team.players.length} 個名額"><strong>${team.players.length}</strong><span>/ 40 人</span></div>
    <a class="source-link" href="${escape(team.rosterUrl)}" target="_blank" rel="noopener noreferrer">官方名單 ${icon("external")}</a>
  </div>`;
}

function renderFilterCounts(players) {
  const counts = new Map();
  for (const player of players) {
    counts.set(player.positionGroup, (counts.get(player.positionGroup) ?? 0) + 1);
  }
  for (const button of positionFilters.querySelectorAll("button")) {
    const position = button.dataset.position;
    button.setAttribute("aria-pressed", String(position === state.position));
    button.querySelector("span").textContent = position === "all" ? players.length : counts.get(position) ?? 0;
  }
}

function photoMarkup(player, eager = false) {
  return `<img class="player-photo" src="${escape(player.headshotUrl)}" alt="" width="128" height="128" loading="${eager ? "eager" : "lazy"}" decoding="async" referrerpolicy="no-referrer">`;
}

function jerseyMarkup(player) {
  return player.jersey === null ? "" : `<span class="player-number" aria-hidden="true">${escape(player.jersey)}</span>`;
}

function playerCards(players, team, eager = false) {
  return `<div class="player-grid" style="--team: ${escape(team.color)}">
    ${players.map((player, index) => `<a class="player-card" data-player="${player.id}" href="player.html?id=${player.id}&amp;team=${escape(team.abbr)}">
      <div class="player-art">
        ${jerseyMarkup(player)}
        ${photoMarkup(player, eager && index < 8)}
        <span class="position-tag">${escape(player.position)}</span>
      </div>
      <div class="player-caption">
        <div>
          <strong lang="en">${escape(player.name)}</strong>
          <small>${escape(player.positionZh)}${player.jersey === null ? "" : ` · #${escape(player.jersey)}`}</small>
        </div>
        ${icon("chevron")}
      </div>
    </a>`).join("")}
  </div>`;
}

function displayEmpty(canResetFilter) {
  const action = canResetFilter
    ? '<button class="reset-filter" type="button" data-reset="position">顯示所有位置</button>'
    : '<button class="reset-filter" type="button" data-reset="search">清除搜尋</button>';
  const hint = canResetFilter ? "試試其他守備位置。" : "試試球員的英文姓名、常用譯名或球隊名稱。";
  resultList.innerHTML = `<div class="empty-state"><strong>找不到符合條件的球員</strong><p>${hint}</p>${action}</div>`;
}

function renderRosterResults() {
  if (!state.search) {
    const players = state.team.players;
    const visible = forActivePosition(players);
    renderFilterCounts(players);
    if (visible.length) resultList.innerHTML = playerCards(visible, state.team, true);
    else displayEmpty(true);
    byId("results-status").textContent = `${state.team.nameZh}，${visible.length} 位球員。`;
    return;
  }
  const matches = matchesForQuery(state.search);
  const visible = forActivePosition(matches.map(match => match.player));
  renderFilterCounts(matches.map(match => match.player));
  byId("results-status").textContent = `搜尋結果共 ${visible.length} 位球員。`;
  if (!visible.length) {
    displayEmpty(state.position !== "all");
    return;
  }
  const groups = Map.groupBy(visible, player => playerMap.get(player.id).team.id);
  const limit = visible.length > 90 ? 8 : Infinity;
  resultList.innerHTML = snapshot.teams.filter(team => groups.has(team.id)).map(team => {
    const teamMatches = groups.get(team.id);
    const shown = state.expanded.has(team.id) ? teamMatches : teamMatches.slice(0, limit);
    const remainder = teamMatches.length - shown.length;
    return `<section class="results-group" id="group-${team.id}">
      <h3 class="result-team"><button type="button" data-open-team="${team.id}" aria-label="瀏覽${escape(team.nameZh)}完整名單">
        <img src="${logo(team)}" width="24" height="24" alt="">${escape(team.nameZh)} <small>${teamMatches.length} 位</small>${icon("chevron")}
      </button></h3>
      ${playerCards(shown, team)}
      ${remainder > 0 ? `<button type="button" class="show-more" data-expand-team="${team.id}">再顯示 ${remainder} 位</button>` : ""}
    </section>`;
  }).join("");
}

function focusResults() {
  const heading = byId("roster-title");
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: "start" });
}

function updateURL() {
  const url = new URL(window.location.href);
  url.searchParams.set("team", state.team.abbr);
  if (state.search) url.searchParams.set("q", state.search);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

function selectTeam(team, jump = false, preserveTeamFocus = false) {
  state.team = team;
  state.league = team.league;
  state.position = "all";
  state.search = "";
  state.expanded.clear();
  clearTimeout(searchDelay);
  searchInput.value = "";
  clearSearch.hidden = true;
  updateURL();
  renderTeamNavigation();
  renderHeading();
  renderRosterResults();
  if (jump || byId("roster-title").getBoundingClientRect().top < 0) {
    focusResults();
  } else if (preserveTeamFocus) {
    divisionList.querySelector(`[data-team="${team.id}"]`)?.focus();
  }
}

function applySearch() {
  clearTimeout(searchDelay);
  state.search = searchInput.value.trim();
  state.position = "all";
  state.expanded.clear();
  clearSearch.hidden = !searchInput.value;
  updateURL();
  renderTeamNavigation();
  renderHeading();
  renderRosterResults();
}

function connectEvents() {
  leagueSwitch.addEventListener("click", event => {
    const button = event.target.closest("[data-league]");
    if (!button) return;
    state.league = button.dataset.league;
    renderTeamNavigation();
  });
  divisionList.addEventListener("click", event => {
    const button = event.target.closest("[data-team]");
    if (button) selectTeam(teamMap.get(Number(button.dataset.team)), false, event.detail === 0);
  });
  teamSelect.addEventListener("change", () => selectTeam(teamMap.get(Number(teamSelect.value))));

  searchInput.addEventListener("input", () => {
    clearSearch.hidden = !searchInput.value;
    clearTimeout(searchDelay);
    searchDelay = setTimeout(applySearch, 140);
  });
  searchForm.addEventListener("submit", event => {
    event.preventDefault();
    applySearch();
    focusResults();
  });
  clearSearch.addEventListener("click", () => {
    searchInput.value = "";
    applySearch();
    searchInput.focus();
  });
  positionFilters.addEventListener("click", event => {
    const button = event.target.closest("[data-position]");
    if (!button) return;
    state.position = button.dataset.position;
    renderRosterResults();
  });
  sortSelect.addEventListener("change", () => {
    state.sort = sortSelect.value;
    renderRosterResults();
  });
  resultList.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.openTeam) {
      selectTeam(teamMap.get(Number(button.dataset.openTeam)), true);
    } else if (button.dataset.expandTeam) {
      const id = Number(button.dataset.expandTeam);
      state.expanded.add(id);
      renderRosterResults();
      byId(`group-${id}`).querySelectorAll(".player-card")[8]?.focus();
    } else if (button.dataset.reset === "position") {
      state.position = "all";
      renderRosterResults();
      positionFilters.querySelector('[data-position="all"]').focus();
    } else if (button.dataset.reset === "search") {
      searchInput.value = "";
      applySearch();
      searchInput.focus();
    }
  });
}

function installIndependentEvents() {
  document.addEventListener("click", event => {
    if (downloadMenu.open && !downloadMenu.contains(event.target)) downloadMenu.open = false;
  });
  downloadMenu.addEventListener("keydown", event => {
    if (event.key === "Escape" && downloadMenu.open) {
      downloadMenu.open = false;
      downloadMenu.querySelector("summary").focus();
    }
  });
  installPhotoFallback();
  connectDownloads();
}

function setRosterIndex() {
  teamMap = new Map(snapshot.teams.map(team => [team.id, team]));
  searchIndex = snapshot.teams.flatMap(team => team.players.map(player => ({
    player,
    team,
    keywords: normalize([
      player.name, player.name.replace(/[.'’-]/g, ""), ...player.searchAliases,
      player.jersey, team.name, team.nameZh, team.abbr,
      player.birthCountry, countryName(player.birthCountry), player.birthCountry === "Taiwan" ? "臺灣" : "",
    ].join(" ")),
  })));
  playerMap = new Map(searchIndex.map(match => [match.player.id, match]));
}

function renderRosterStatus(kind, label) {
  byId("season").textContent = snapshot.season;
  byId("team-total").textContent = snapshot.teamCount;
  byId("player-total").textContent = number.format(snapshot.playerCount);
  const time = byId("hero-date");
  const display = taipeiTime(snapshot.capturedAt);
  time.dateTime = snapshot.capturedAt;
  time.textContent = kind === "fresh" ? display.clock : display.date;
  time.title = `名單時間（台灣）${display.date} ${display.clock}`;
  time.setAttribute("aria-label", time.title);
  byId("live-status").dataset.state = kind;
  byId("live-status-text").textContent = label;
}

async function refreshRoster() {
  if (refreshing || document.visibilityState === "hidden" || Date.now() - lastAttempt < LIVE_INTERVAL) return;
  refreshing = true;
  lastAttempt = Date.now();
  try {
    const updated = await fetchLiveRoster(snapshot);
    const changed = JSON.stringify(updated.teams) !== JSON.stringify(snapshot.teams);
    snapshot = updated;
    if (changed) {
      const focusedId = document.activeElement?.dataset.player;
      const focusedTeam = document.activeElement?.dataset.team;
      setRosterIndex();
      state.team = teamMap.get(state.team.id);
      renderTeamNavigation();
      renderHeading();
      renderRosterResults();
      if (focusedId) resultList.querySelector(`[data-player="${focusedId}"]`)?.focus({ preventScroll: true });
      if (focusedTeam) divisionList.querySelector(`[data-team="${focusedTeam}"]`)?.focus({ preventScroll: true });
    }
    renderRosterStatus("fresh", "MLB 名單已查詢");
    rememberRoster(snapshot);
  } catch (error) {
    console.warn("Could not refresh MLB rosters", error);
    renderRosterStatus("cached", "使用最近一次名單");
  } finally {
    refreshing = false;
  }
}

function connectDownloads() {
  for (const link of downloadMenu.querySelectorAll("[data-export]")) {
    link.addEventListener("click", () => {
      if (!snapshot || snapshot === bundledSnapshot || link.dataset.capturedAt === snapshot.capturedAt) return;
      const csv = link.dataset.export === "csv";
      const contents = csv ? rosterCsv(snapshot) : JSON.stringify(snapshot);
      const type = csv ? "text/csv;charset=utf-8" : "application/json";
      if (link.dataset.objectUrl) URL.revokeObjectURL(link.dataset.objectUrl);
      const url = URL.createObjectURL(new Blob([contents], { type }));
      link.dataset.objectUrl = url;
      link.dataset.capturedAt = snapshot.capturedAt;
      link.href = url;
    });
  }
}

async function start() {
  installIndependentEvents();
  try {
    bundledSnapshot = await fetchSnapshot();
    snapshot = readLastRoster(bundledSnapshot);
    setRosterIndex();
    const params = new URLSearchParams(location.search);
    const selectedAbbr = params.get("team")?.toUpperCase() ?? "LAD";
    state.team = snapshot.teams.find(team => team.abbr === selectedAbbr) ?? teamMap.get(119);
    state.league = state.team.league;
    state.search = params.get("q")?.trim() ?? "";
    searchInput.value = state.search;
    clearSearch.hidden = !state.search;
    renderRosterStatus("cached", "正在查詢 MLB 名單");
    setMobileTeams();
    renderTeamNavigation();
    renderHeading();
    renderRosterResults();
    connectEvents();
    for (const element of [searchInput, searchForm.querySelector("[type=submit]"), teamSelect, ...leagueSwitch.querySelectorAll("button")]) {
      element.disabled = false;
    }
    byId("roster-toolbar").hidden = false;
    void refreshRoster();
    setInterval(refreshRoster, LIVE_INTERVAL);
    document.addEventListener("visibilitychange", refreshRoster);
    window.addEventListener("pageshow", refreshRoster);
    window.addEventListener("online", refreshRoster);
  } catch (error) {
    console.error(error);
    resultList.innerHTML = '<div class="empty-state"><strong>名單暫時無法載入</strong><p>重新整理頁面，或從上方下載完整名單。</p><button type="button" class="retry-button">重新載入</button></div>';
    resultList.querySelector("button").addEventListener("click", () => location.reload());
  } finally {
    byId("roster-main").setAttribute("aria-busy", "false");
  }
}

start();
