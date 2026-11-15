import { escape, fetchMinorRoster, fetchSnapshot, mlbCalendarDate, taipeiTime, teamLogo } from "./mlb.js?v=4";

const LEVELS = new Map([[11, "3A"], [12, "2A"], [13, "高階 1A"], [14, "1A"], [16, "新人聯盟"]]);
const VIEWS = new Set(["rosters", "team-prospects", "top100"]);
const STATUS = {
  "Development List": "發展名單", "Restricted List": "限制名單", "Rehab Assignment": "復健指派",
  "Suspended": "禁賽", "Reserve List": "保留名單", "Temporarily Inactive": "暫停出賽",
};
const AFFILIATE_SOURCE = "https://www.mlb.com/milb/about/teams/by-affiliate";
const REFRESH_INTERVAL = 120_000;
const collator = new Intl.Collator("en", { sensitivity: "base" });
const formatNumber = new Intl.NumberFormat("zh-TW");
const byId = id => document.getElementById(id);
const viewSwitch = byId("minor-view");
const orgSelect = byId("minor-org");
const levelSelect = byId("minor-level");
const searchInput = byId("minor-search");
const content = byId("minor-content");
const status = byId("minor-status");
const query = new URLSearchParams(location.search);
const state = { view: "rosters", level: "all", search: "", team: null };

let rosterSnapshot;
let pipeline;
let organizations;
let affiliatesByOrg;
const rosterChecks = new Map();
const pendingChecks = new Set();

function normalized(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

function statusLabel(value) {
  if (!value || value.toLowerCase() === "active") return "";
  const injured = /^(\d+)[ -]day injured list$/i.exec(value);
  return injured ? `${injured[1]} 天傷兵名單` : STATUS[value] ?? value;
}

function playerLink(player, organization) {
  const url = new URLSearchParams({ id: player.id, scope: "minors", from: "minors" });
  if (organization) url.set("team", organization.abbr);
  if (state.view !== "rosters") url.set("minorView", state.view);
  if (state.view === "rosters" && state.level !== "all") url.set("level", state.level);
  if (state.search) url.set("q", state.search);
  return `player.html?${escape(url.toString())}`;
}

function shownPlayers(affiliate) {
  const search = normalized(state.search);
  return affiliate.players.filter(player => !search || normalized(player.name).includes(search))
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

function affiliateMarkup(affiliate, players) {
  const entries = players.map(player => {
    const label = statusLabel(player.status);
    return `<li><a data-minor-player="${affiliate.id}-${player.id}" href="${playerLink(player, state.team)}">
      <span>${escape(player.name)}</span><span class="minor-position">${escape(player.position ?? "—")}</span>
      ${label ? `<span class="minor-player-status">${escape(label)}</span>` : ""}
    </a></li>`;
  }).join("");
  return `<section class="affiliate-card">
    <div class="affiliate-heading"><h4>${escape(affiliate.name)}</h4><p>${escape(affiliate.league)} · ${players.length} 人</p></div>
    ${entries ? `<ul class="minor-roster">${entries}</ul>` : '<p class="affiliate-empty">MLB 當日名單目前沒有列出球員。</p>'}
  </section>`;
}

function renderRosters() {
  const affiliates = affiliatesByOrg.get(state.team.id);
  const matching = affiliates.filter(affiliate => state.level === "all" || String(affiliate.level) === state.level)
    .map(affiliate => ({ affiliate, players: shownPlayers(affiliate) }))
    .filter(row => !state.search || row.players.length);
  const groups = Map.groupBy(matching, row => row.affiliate.level);
  const players = new Set(matching.flatMap(row => row.players.map(player => player.id)));
  const checked = rosterChecks.get(state.team.id);
  let time = `${rosterSnapshot.rosterDate} 名單快照`;
  if (pendingChecks.has(state.team.id)) time += " · 正在查詢 MLB";
  else if (checked) time = checked.failed
    ? `${checked.failed} 支附屬隊顯示上次可用名單`
    : `${checked.date} · ${taipeiTime(checked.checkedAt).clock} 已查詢 MLB`;
  status.textContent = `${matching.length} 支附屬隊 · ${formatNumber.format(players.size)} 位球員 · ${time}`;
  if (!groups.size) {
    content.innerHTML = '<div class="empty-state"><strong>找不到符合條件的球員</strong><p>可調整層級或搜尋姓名。</p></div>';
    return;
  }
  content.innerHTML = [...LEVELS].filter(([level]) => groups.has(level)).map(([level, label]) => {
    const rows = groups.get(level);
    return `<section class="minor-level"><h3>${label}<small>${rows.length} 支附屬隊</small></h3>
      ${rows.map(row => affiliateMarkup(row.affiliate, row.players)).join("")}</section>`;
  }).join("");
}

function renderRanking(board) {
  if (!board) {
    status.textContent = "";
    content.innerHTML = '<div class="empty-state"><strong>暫時無法載入新秀榜</strong><p>可從上方開啟 MLB Pipeline。</p></div>';
    return;
  }
  const search = normalized(state.search);
  const rows = board.players.filter(player => !search || normalized(player.name).includes(search));
  const league = state.view === "top100";
  status.textContent = `${pipeline.season} 年榜單 · ${rows.length} 位球員 · ${taipeiTime(pipeline.capturedAt).date} 查詢`;
  if (!rows.length) {
    content.innerHTML = '<div class="empty-state"><strong>榜單中沒有符合條件的球員</strong><p>可調整搜尋姓名。</p></div>';
    return;
  }
  content.innerHTML = `<div class="minor-table-scroll" role="region" aria-label="新秀排行榜" tabindex="0">
    <table class="minor-rankings"><thead><tr>
      <th scope="col">排名</th><th scope="col">球員</th>${league ? '<th scope="col">球團</th>' : ""}
      <th scope="col">守位</th><th scope="col">層級</th><th scope="col">預計登上 MLB</th>
    </tr></thead><tbody>${rows.map(player => {
      const team = organizations.get(player.orgId);
      const org = team ? `<img src="${teamLogo(team)}" alt="" width="20" height="20" loading="lazy">${escape(team.shortNameZh)}` : "—";
      const levelId = Number(player.level);
      const level = levelId === 1 ? "大聯盟" : LEVELS.get(levelId) ?? "—";
      return `<tr><th scope="row">${player.rank}</th>
        <td><a data-minor-player="rank-${player.id}" href="${playerLink(player, team ?? state.team)}">${escape(player.name)}</a></td>
        ${league ? `<td class="minor-rank-org">${org}</td>` : ""}
        <td>${escape(player.position ?? "—")}</td><td>${level}</td><td>${escape(player.eta || "—")}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function render() {
  const roster = state.view === "rosters";
  const league = state.view === "top100";
  const board = league ? pipeline?.top100 : pipeline?.byTeam[state.team.id];
  const focused = document.activeElement?.dataset.minorPlayer;
  for (const button of viewSwitch.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
  byId("minor-org-control").hidden = league;
  byId("minor-level-control").hidden = !roster;
  const crest = byId("minor-crest");
  crest.hidden = league;
  if (!league) crest.src = teamLogo(state.team);
  byId("minor-title").textContent = league ? "全聯盟 Top 100" : `${state.team.nameZh} ${roster ? "附屬球隊" : "Top 30"}`;
  const source = byId("minor-source");
  source.href = roster ? AFFILIATE_SOURCE : board?.source ?? "https://www.mlb.com/prospects";
  source.textContent = roster ? "官方附屬球隊" : "MLB Pipeline";
  byId("major-link").href = `./?team=${encodeURIComponent(state.team.abbr)}#roster`;
  if (roster) renderRosters();
  else renderRanking(board);
  if (focused) content.querySelector(`[data-minor-player="${focused}"]`)?.focus({ preventScroll: true });
}

function updateURL() {
  const url = new URL(location.href);
  url.searchParams.set("team", state.team.abbr);
  if (state.view === "rosters") url.searchParams.delete("view");
  else url.searchParams.set("view", state.view);
  if (state.level === "all") url.searchParams.delete("level");
  else url.searchParams.set("level", state.level);
  if (state.search) url.searchParams.set("q", state.search);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

async function refreshRosters() {
  if (state.view !== "rosters" || document.visibilityState === "hidden") return;
  const orgId = state.team.id;
  const now = Date.now();
  if (pendingChecks.has(orgId) || now - (rosterChecks.get(orgId)?.startedAt ?? 0) < REFRESH_INTERVAL) return;
  const date = mlbCalendarDate(new Date(now));
  pendingChecks.add(orgId);
  if (!rosterChecks.has(orgId)) renderRosters();
  const affiliates = affiliatesByOrg.get(orgId);
  const results = await Promise.allSettled(affiliates.map(affiliate => fetchMinorRoster(affiliate.id, date)));
  let failed = 0;
  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") affiliates[index].players = result.value;
    else failed += 1;
  }
  rosterChecks.set(orgId, { startedAt: now, checkedAt: Date.now(), date, failed });
  pendingChecks.delete(orgId);
  if (state.team.id === orgId && state.view === "rosters") render();
}

function selectCurrentView() {
  updateURL();
  render();
  void refreshRosters();
}

function connectEvents() {
  viewSwitch.addEventListener("click", event => {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    state.view = button.dataset.view;
    selectCurrentView();
  });
  orgSelect.addEventListener("change", () => {
    state.team = organizations.get(Number(orgSelect.value));
    selectCurrentView();
  });
  levelSelect.addEventListener("change", () => {
    state.level = levelSelect.value;
    selectCurrentView();
  });
  searchInput.addEventListener("input", () => {
    state.search = searchInput.value.trim();
    updateURL();
    render();
  });
  byId("minor-tools").addEventListener("submit", event => event.preventDefault());
}

async function readData(file) {
  const response = await fetch(`data/${file}.json`, { signal: AbortSignal.timeout(16_000) });
  if (!response.ok) throw new Error(`Could not load ${file}`);
  return response.json();
}

async function start() {
  try {
    const [major, minors, rankings] = await Promise.all([
      fetchSnapshot(), readData("minor-league-rosters"), readData("pipeline-rankings").catch(() => null),
    ]);
    rosterSnapshot = minors;
    pipeline = rankings;
    organizations = new Map(major.teams.map(team => [team.id, team]));
    affiliatesByOrg = Map.groupBy(minors.affiliates, affiliate => affiliate.orgId);
    state.team = major.teams.find(team => team.abbr === query.get("team")?.toUpperCase()) ?? organizations.get(119);
    if (VIEWS.has(query.get("view"))) state.view = query.get("view");
    if (LEVELS.has(Number(query.get("level")))) state.level = query.get("level");
    levelSelect.value = state.level;
    state.search = query.get("q")?.trim() ?? "";
    searchInput.value = state.search;
    orgSelect.innerHTML = [...Map.groupBy(major.teams, team => `${team.leagueZh}${team.divisionZh}`)].map(([division, teams]) =>
      `<optgroup label="${escape(division)}">${teams.map(team => `<option value="${team.id}">${escape(team.nameZh)}</option>`).join("")}</optgroup>`,
    ).join("");
    orgSelect.value = String(state.team.id);
    byId("minor-summary").textContent = `${minors.season} 年 · ${organizations.size} 個球團 · ${minors.affiliates.length} 支附屬隊`;
    for (const control of [orgSelect, levelSelect, searchInput, ...viewSwitch.querySelectorAll("button")]) control.disabled = false;
    connectEvents();
    render();
    void refreshRosters();
    setInterval(refreshRosters, REFRESH_INTERVAL);
    document.addEventListener("visibilitychange", refreshRosters);
    window.addEventListener("online", refreshRosters);
  } catch (error) {
    console.warn("Could not load the MiLB directory", error);
    byId("minor-summary").textContent = "小聯盟資料暫時無法載入";
    content.innerHTML = '<div class="empty-state"><strong>小聯盟名單暫時無法載入</strong><button class="retry-button" type="button">重新載入</button></div>';
    content.querySelector("button").addEventListener("click", () => location.reload());
  } finally {
    byId("minor-results").setAttribute("aria-busy", "false");
  }
}

void start();
