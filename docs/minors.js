import { escape, fetchMinorRoster, fetchSnapshot, mlbCalendarDate, readLastRoster, taipeiTime, teamLogo } from "./mlb.js?v=5";
import { loadFinderLabels, loadMinorMetadata, loadTeamDetails, rule5Draft, rule5Mark, rule5State, updateRosterRights } from "./team-details.js";

const LEVELS = new Map([[11, "3A"], [12, "2A"], [13, "高階 1A"], [14, "1A"], [16, "新人聯盟"]]);
const VIEWS = new Set(["rosters", "team-prospects", "top100"]);
const STATUS = {
  "Development List": "發展名單", "Restricted List": "限制名單", "Rehab Assignment": "復健指派",
  "Suspended": "禁賽", "Reserve List": "保留名單", "Temporarily Inactive": "暫停出賽",
};
const AFFILIATE_SOURCE = "https://www.mlb.com/milb/about/teams/by-affiliate";
const REFRESH_INTERVAL = 120_000;
const LEAGUE_BATCH = 12;
const collator = new Intl.Collator("en", { sensitivity: "base" });
const formatNumber = new Intl.NumberFormat("zh-TW");
const byId = id => document.getElementById(id);
const viewSwitch = byId("minor-view");
const orgSelect = byId("minor-org");
const levelSelect = byId("minor-level");
const rule5Select = byId("minor-rule5");
const searchInput = byId("minor-search");
const content = byId("minor-content");
const status = byId("minor-status");
const query = new URLSearchParams(location.search);
const state = { view: "rosters", level: "all", rule5: "all", search: "", team: null };

let rosterSnapshot;
let pipeline;
let organizations;
let affiliatesByOrg;
let details;
let detailsLoading = true;
let aliases = {};
let leagueCount = LEAGUE_BATCH;
const rosterChecks = new Map();
const pendingChecks = new Set();
const selectedOrg = () => state.team?.id ?? null;

function displaysName(player) {
  const names = aliases[player.id];
  return names?.length ? `${names[0]} · ${player.name}` : player.name;
}

function matchesFilters(player, orgId, query) {
  const nameMatches = !query || [player.name, ...(aliases[player.id] ?? [])].some(name => normalized(name).includes(query));
  return nameMatches && (state.rule5 === "all" || detailsLoading || rule5State(details, player.id, orgId).key === state.rule5);
}

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
  if (state.rule5 !== "all") url.set("rule5", state.rule5);
  if (state.search) url.set("q", state.search);
  return `player.html?${escape(url.toString())}`;
}

function shownPlayers(affiliate) {
  const search = normalized(state.search);
  return affiliate.players.filter(player => matchesFilters(player, affiliate.orgId, search))
    .sort((a, b) => collator.compare(a.name, b.name) || a.id - b.id);
}

function affiliateMarkup(affiliate, players) {
  const entries = players.map(player => {
    const label = statusLabel(player.status);
    return `<li><a data-minor-player="${affiliate.id}-${player.id}" href="${playerLink(player, organizations.get(affiliate.orgId))}">
      <span>${escape(displaysName(player))}</span><span class="minor-position">${escape(player.position ?? "—")}</span>
      ${label ? `<span class="minor-player-status">${escape(label)}</span>` : ""}
      ${!detailsLoading ? `<span class="minor-rule5-cell">${rule5Mark(details, player.id, affiliate.orgId, true)}</span>` : ""}
    </a></li>`;
  }).join("");
  return `<section class="affiliate-card">
    <div class="affiliate-heading"><h4>${escape(affiliate.name)}</h4><p>${state.team ? "" : `${escape(organizations.get(affiliate.orgId).nameZh)} · `}${escape(affiliate.league)} · ${players.length} 人</p></div>
    ${entries ? `<ul class="minor-roster">${entries}</ul>` : '<p class="affiliate-empty">MLB 當日名單目前沒有列出球員。</p>'}
  </section>`;
}

function renderRosters() {
  const orgId = selectedOrg();
  const affiliates = orgId ? affiliatesByOrg.get(orgId) ?? [] : rosterSnapshot.affiliates;
  const matching = affiliates.filter(affiliate => state.level === "all" || String(affiliate.level) === state.level)
    .map(affiliate => ({ affiliate, players: shownPlayers(affiliate) }))
    .filter(row => !(state.search || state.rule5 !== "all") || row.players.length);
  const visible = orgId ? matching : matching.slice(0, leagueCount);
  const groups = Map.groupBy(visible, row => row.affiliate.level);
  const players = new Set(matching.flatMap(row => row.players.map(player => player.id)));
  const checked = rosterChecks.get(orgId);
  let time = `${rosterSnapshot.rosterDate} 名單快照`;
  if (pendingChecks.has(orgId)) time += " · 正在查詢 MLB";
  else if (checked) time = checked.failed
    ? `${checked.failed} 支附屬隊顯示上次可用名單`
    : `${checked.date} · ${taipeiTime(checked.checkedAt).clock} 已查詢 MLB`;
  const shown = visible.length < matching.length ? ` · 已顯示 ${visible.length} 支` : "";
  status.textContent = `${matching.length} 支附屬隊 · ${formatNumber.format(players.size)} 位球員 · ${time}${shown}`;
  if (!groups.size) {
    content.innerHTML = '<div class="empty-state"><strong>找不到符合條件的球員</strong><p>可調整層級、規則五資格或姓名。</p></div>';
    return;
  }
  content.innerHTML = [...LEVELS].filter(([level]) => groups.has(level)).map(([level, label]) => {
    const rows = groups.get(level);
    return `<section class="minor-level"><h3>${label}<small>${rows.length} 支附屬隊</small></h3>
      ${rows.map(row => affiliateMarkup(row.affiliate, row.players)).join("")}</section>`;
  }).join("") + (visible.length < matching.length
    ? '<button type="button" class="show-more" data-minor-more>顯示更多附屬隊</button>' : "");
}

function renderRanking(board) {
  if (!board) {
    status.textContent = "";
    content.innerHTML = '<div class="empty-state"><strong>暫時無法載入新秀榜</strong><p>可從上方開啟 MLB Pipeline。</p></div>';
    return;
  }
  const search = normalized(state.search);
  const rows = board.players.filter(player => matchesFilters(player, player.orgId, search));
  const league = state.view === "top100";
  status.textContent = `${pipeline.season} 年榜單 · ${rows.length} 位球員 · ${taipeiTime(pipeline.capturedAt).date} 查詢`;
  if (!rows.length) {
    content.innerHTML = '<div class="empty-state"><strong>榜單中沒有符合條件的球員</strong><p>可調整規則五資格或姓名。</p></div>';
    return;
  }
  content.innerHTML = `<div class="minor-table-scroll" role="region" aria-label="新秀排行榜" tabindex="0">
    <table class="minor-rankings"><thead><tr>
      <th scope="col">排名</th><th scope="col">球員</th>${league ? '<th scope="col">球團</th>' : ""}
      <th scope="col">守位</th><th scope="col">層級</th><th scope="col">預計登上 MLB</th><th scope="col">規則五資格</th>
    </tr></thead><tbody>${rows.map(player => {
      const team = organizations.get(player.orgId);
      const org = team ? `<img src="${teamLogo(team)}" alt="" width="20" height="20" loading="lazy">${escape(team.shortNameZh)}` : "—";
      const levelId = Number(player.level);
      const level = levelId === 1 ? "大聯盟" : LEVELS.get(levelId) ?? "—";
      return `<tr><th scope="row">${player.rank}</th>
        <td><a data-minor-player="rank-${player.id}" href="${playerLink(player, team ?? state.team)}">${escape(displaysName(player))}</a></td>
        ${league ? `<td class="minor-rank-org">${org}</td>` : ""}
        <td>${escape(player.position ?? "—")}</td><td>${level}</td><td>${escape(player.eta || "—")}</td>
        <td>${detailsLoading ? "載入中" : rule5Mark(details, player.id, player.orgId, true)}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}

function render() {
  const roster = state.view === "rosters";
  const league = state.view === "top100";
  const board = league ? pipeline?.top100 : pipeline?.byTeam[selectedOrg()];
  const focused = document.activeElement?.dataset.minorPlayer;
  for (const button of viewSwitch.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === state.view));
  }
  byId("minor-org-control").hidden = league;
  byId("minor-level-control").hidden = !roster;
  const crest = byId("minor-crest");
  crest.hidden = league || !state.team;
  if (!crest.hidden) crest.src = teamLogo(state.team);
  byId("minor-title").textContent = league ? "全聯盟 Top 100" : !state.team ? "全聯盟小聯盟名單"
    : `${state.team.nameZh} ${roster ? "附屬球隊" : "Top 30"}`;
  const source = byId("minor-source");
  source.href = roster ? AFFILIATE_SOURCE : board?.source ?? "https://www.mlb.com/prospects";
  source.textContent = roster ? "官方附屬球隊" : "MLB Pipeline";
  byId("major-link").href = state.team ? `./?team=${encodeURIComponent(state.team.abbr)}#roster` : "./#roster";
  const dateLine = byId("minor-rule5-date");
  const draft = rule5Draft(details);
  dateLine.hidden = false;
  dateLine.textContent = details ? [
    `規則五資料 ${details.asOf}（美國時間）`,
    details.rule5Date && draft.year === details.season ? `選秀預定 ${details.rule5Date}（美國時間）` : "",
  ].filter(Boolean).join(" · ") : detailsLoading ? "正在讀取規則五資格…" : "規則五資料暫時無法載入";
  if (roster) renderRosters();
  else renderRanking(board);
  if (focused) content.querySelector(`[data-minor-player="${focused}"]`)?.focus({ preventScroll: true });
}

function updateURL() {
  const url = new URL(location.href);
  url.searchParams.set("team", state.team?.abbr ?? "all");
  if (state.view === "rosters") url.searchParams.delete("view");
  else url.searchParams.set("view", state.view);
  if (state.level === "all") url.searchParams.delete("level");
  else url.searchParams.set("level", state.level);
  if (state.rule5 === "all") url.searchParams.delete("rule5");
  else url.searchParams.set("rule5", state.rule5);
  if (state.search) url.searchParams.set("q", state.search);
  else url.searchParams.delete("q");
  history.replaceState(null, "", url);
}

async function refreshRosters() {
  if (state.view !== "rosters" || !state.team || document.visibilityState === "hidden") return;
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
  if (selectedOrg() === orgId && state.view === "rosters") render();
}

function selectCurrentView() {
  const allOption = orgSelect.querySelector('option[value="all"]');
  allOption.disabled = state.view === "team-prospects";
  if (!state.team && state.view === "team-prospects") state.team = organizations.get(119);
  orgSelect.value = state.team ? String(state.team.id) : "all";
  leagueCount = LEAGUE_BATCH;
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
    state.team = organizations.get(Number(orgSelect.value)) ?? null;
    selectCurrentView();
  });
  levelSelect.addEventListener("change", () => {
    state.level = levelSelect.value;
    selectCurrentView();
  });
  rule5Select.addEventListener("change", () => {
    state.rule5 = rule5Select.value;
    leagueCount = LEAGUE_BATCH;
    updateURL();
    render();
  });
  searchInput.addEventListener("input", () => {
    state.search = searchInput.value.trim();
    leagueCount = LEAGUE_BATCH;
    updateURL();
    render();
  });
  byId("minor-tools").addEventListener("submit", event => event.preventDefault());
  content.addEventListener("click", event => {
    if (!event.target.closest("[data-minor-more]")) return;
    const prior = new Set([...content.querySelectorAll("[data-minor-player]")].map(link => link.dataset.minorPlayer));
    leagueCount += LEAGUE_BATCH;
    renderRosters();
    [...content.querySelectorAll("[data-minor-player]")].find(link => !prior.has(link.dataset.minorPlayer))?.focus();
  });
}

async function start() {
  try {
    const detailRequest = loadTeamDetails().catch(error => {
      console.warn("Could not load Rule 5 information", error);
      return null;
    });
    const [major, [minors, rankings], names] = await Promise.all([fetchSnapshot().then(readLastRoster), loadMinorMetadata(), loadFinderLabels()]);
    rosterSnapshot = minors;
    pipeline = rankings;
    aliases = names;
    organizations = new Map(major.teams.map(team => [team.id, team]));
    affiliatesByOrg = Map.groupBy(minors.affiliates, affiliate => affiliate.orgId);
    if (VIEWS.has(query.get("view"))) state.view = query.get("view");
    state.team = query.get("team") === "all" && state.view !== "team-prospects"
      ? null : major.teams.find(team => team.abbr === query.get("team")?.toUpperCase()) ?? organizations.get(119);
    if (LEVELS.has(Number(query.get("level")))) state.level = query.get("level");
    if ([...rule5Select.options].some(option => option.value === query.get("rule5"))) state.rule5 = query.get("rule5");
    levelSelect.value = state.level;
    rule5Select.value = state.rule5;
    state.search = query.get("q")?.trim() ?? "";
    searchInput.value = state.search;
    orgSelect.innerHTML = '<option value="all">全部 30 隊</option>' + [...Map.groupBy(major.teams, team => `${team.leagueZh}${team.divisionZh}`)].map(([division, teams]) =>
      `<optgroup label="${escape(division)}">${teams.map(team => `<option value="${team.id}">${escape(team.nameZh)}</option>`).join("")}</optgroup>`,
    ).join("");
    orgSelect.value = state.team ? String(state.team.id) : "all";
    orgSelect.querySelector('option[value="all"]').disabled = state.view === "team-prospects";
    byId("minor-summary").textContent = `${minors.season} 年 · ${organizations.size} 個球團 · ${minors.affiliates.length} 支附屬隊`;
    for (const control of [orgSelect, levelSelect, searchInput, ...viewSwitch.querySelectorAll("button")]) control.disabled = false;
    connectEvents();
    render();
    void detailRequest.then(data => {
      details = data;
      detailsLoading = false;
      for (const team of major.teams) updateRosterRights(details, team, major.rosterDate);
      rule5Select.disabled = !data;
      if (!data) {
        state.rule5 = "all";
        rule5Select.value = "all";
      }
      render();
    });
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
